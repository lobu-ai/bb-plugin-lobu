import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatedModule } from "../scripts/generate-lobu-scripts";
import { readFileSync } from "node:fs";
import { lobuScript } from "../lib/snapshot";
import { summarizeDevices, summarizeWorkspace, type SummaryOptions } from "../lib/workspace-summary";

const NOW = Date.parse("2026-01-15T12:00:00.000Z");
const HOUR = 3600 * 1000;
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

function fakeClient(overrides: Record<string, unknown> = {}, { pendingApprovals = 2 } = {}) {
  const calls: { method: string; input: any }[] = [];
  const syncRuns = [
    { id: 1, feed_id: 10, connector_key: "gmail", connection_display_name: "Gmail", feed_display_name: "Inbox", items_collected: 40, created_at: at(1) },
    { id: 2, feed_id: 10, connector_key: "gmail", connection_display_name: "Gmail", feed_display_name: "Inbox", items_collected: 60, created_at: at(2) },
    { id: 3, feed_id: 11, connector_key: "slack", connection_display_name: "Slack", feed_display_name: "Channels", items_collected: 0, created_at: at(3) },
  ];
  const client: any = {
    operations: {
      listActivity: async (input: any) => {
        calls.push({ method: "listActivity", input });
        return {
          items: [
            { kind: "notification", status: "action_approval_needed", interaction_status: "pending", interaction_type: "approval", title: "Review merge", run_id: 101, href: "/acme/events?run_ids=101", at: at(5), unread: true },
            { kind: "notification", status: "action_approval_needed", interaction_status: "pending", interaction_type: "approval", title: "Review merge", run_id: 102, href: "/acme/events?run_ids=102", at: at(4), unread: true },
            { kind: "automation_due", title: "Weekly digest", href: "/acme/automations/7", at: at(1) },
            { kind: "notification", status: "agent_message", title: "Morning briefing", body: "**Two** new leads", href: "/acme/events?id=9", at: at(3) },
            { kind: "notification", status: "agent_message", title: "Old briefing", body: "stale", at: at(30) },
            { kind: "notification", status: "generic", title: "FYI", at: at(2) },
          ],
        };
      },
      listRuns: async (input: any) => {
        calls.push({ method: "listRuns", input });
        if (input.approval_status === "pending") return { runs: [], total: pendingApprovals, has_more: pendingApprovals > 1 };
        if (input.status === "failed") {
          return {
            runs: [
              { id: 201, automation_id: 7, error_message: "timeout", created_at: at(2) },
              { id: 202, automation_id: 7, error_message: "timeout", created_at: at(3) },
              { id: 203, feed_id: 11, connector_key: "slack", connection_display_name: "Slack", feed_display_name: "Channels", error_message: "401", created_at: at(4) },
              { id: 204, connector_key: "chrome", operation_key: "click", error_message: "no element", created_at: at(1) },
            ],
          };
        }
        if (input.run_types?.[0] === "sync") {
          // Two runs per page so the scan has to follow has_more.
          const start = (input.offset / input.limit) * 2;
          return { runs: syncRuns.slice(start, start + 2), has_more: start + 2 < syncRuns.length };
        }
        return {
          runs: [
            { automation_id: 7, status: "completed", items_collected: 3, created_at: at(1) },
            { automation_id: 7, status: "failed", items_collected: 0, created_at: at(2) },
            { automation_id: 8, status: "completed", items_collected: 0, created_at: at(5) },
          ],
          has_more: false,
        };
      },
    },
    connections: {
      list: async () => ({
        connections: [
          { display_name: "Gmail", attention: "healthy" },
          { display_name: "Calendar", attention: "needs_auth", error_message: "token expired", updated_at: at(10) },
          { display_name: "Webhook", attention: "no_trigger" },
          { display_name: "Archive", attention: "paused" },
        ],
      }),
    },
    feeds: {
      list: async () => ({ feeds: [{ connection_name: "Slack", display_name: "Channels", attention: "last_attempt_failed", last_error: "401", last_sync_at: at(4) }] }),
    },
    automations: { list: async () => ({ automations: [{ automation_id: "7", name: "Weekly digest" }, { automation_id: "8", name: "Lead triage" }] }) },
    metrics: {
      list: async () => ({ entity_types: [{ entity_type: "company", measures: [{ name: "spend" }, { name: "seats" }] }] }),
      query: async (input: any) => {
        calls.push({ method: "metrics.query", input });
        if (input.measure === "broken") throw new Error('measure "broken" is not declared');
        return { rows: [{ month: "2026-01", spend: 1200 }, { month: "2025-12", spend: null }] };
      },
    },
    devices: {
      list: async () => [
        { label: "Laptop", platform: "chrome-extension", online: false, last_seen_at: at(6), organization_slug: "acme" },
        { worker_id: "w-2", platform: "headless", online: true, connector_error_count: 0, update_required: [] },
      ],
    },
    ...overrides,
  };
  return { client, calls };
}

/** Loads a script the way Lobu does: as a standalone ES module. */
async function loadScript(script: string) {
  const file = join(mkdtempSync(join(tmpdir(), "bb-plugin-lobu-")), "script.mjs");
  writeFileSync(file, script);
  return (await import(file)).default as (ctx: unknown, client: unknown) => Promise<any>;
}

const options = (pins: SummaryOptions["pins"] = []): SummaryOptions => ({ now: NOW, maxSyncPages: 6, pins });

describe("summarizeWorkspace", () => {
  test("collapses identical pending requests and links to every run", async () => {
    const { client } = fakeClient();
    const summary = await summarizeWorkspace(client, options());
    expect(summary.needsYou).toEqual([
      { title: "Review merge", detail: "2 approvals waiting", at: at(4), count: 2, path: "/events?run_ids=101,102" },
      { title: "Weekly digest", detail: "1 Automation due", at: at(1), count: 1, path: "/acme/automations/7" },
    ]);
    expect(summary.unreadCount).toBe(2);
  });

  test("counts approvals the activity page did not reach", async () => {
    const { client } = fakeClient({}, { pendingApprovals: 75 });
    const summary = await summarizeWorkspace(client, options());
    expect(summary.needsYou.at(-1)).toEqual({
      title: "Older approvals",
      detail: "73 approvals waiting beyond the newest activity",
      at: null,
      count: 73,
      path: null,
    });
  });

  test("keeps Automation and feed failures and drops ad-hoc tool calls", async () => {
    const { client } = fakeClient();
    const summary = await summarizeWorkspace(client, options());
    expect(summary.failedRuns).toEqual([
      { title: "Weekly digest", detail: "timeout", at: at(2), count: 2, path: "/automations/7" },
      { title: "Slack · Channels", detail: "401", at: at(4), count: 1, path: "/events?run_ids=203" },
    ]);
  });

  test("lists connections that need attention but not on-demand or paused ones", async () => {
    const { client } = fakeClient();
    const summary = await summarizeWorkspace(client, options());
    expect(summary.connections.map((c) => [c.title, c.detail])).toEqual([
      ["Calendar", "needs auth — token expired"],
      ["Slack · Channels", "feed last attempt failed — 401"],
    ]);
  });

  test("totals synced items per feed across pages and keeps only recent briefings", async () => {
    const { client, calls } = fakeClient();
    const summary = await summarizeWorkspace(client, options());
    expect(summary.activity.syncedTotal).toBe(100);
    expect(summary.activity.syncRuns).toBe(3);
    expect(summary.activity.truncated).toBe(false);
    expect(summary.activity.feeds).toEqual([{ title: "Gmail · Inbox", detail: null, at: at(1), count: 100, path: "/connections" }]);
    expect(summary.activity.automations.map((a) => [a.title, a.count, a.detail])).toEqual([
      ["Weekly digest", 2, "1 failed · 3 items"],
      ["Lead triage", 1, null],
    ]);
    expect(summary.activity.briefings).toEqual([
      { title: "Morning briefing", detail: "**Two** new leads", at: at(3), path: "/acme/events?id=9" },
    ]);
    const since = new Date(NOW - 24 * HOUR).toISOString();
    // Pending approvals count regardless of age; every other run read is the last 24 hours.
    const windowed = calls.filter((c) => c.method === "listRuns" && c.input.approval_status === undefined);
    expect(windowed.length).toBeGreaterThan(0);
    expect(windowed.every((c) => c.input.created_after === since)).toBe(true);
  });

  test("marks the sync scan truncated when it hits the page cap", async () => {
    const { client } = fakeClient();
    const summary = await summarizeWorkspace(client, { ...options(), maxSyncPages: 1 });
    expect(summary.activity.syncRuns).toBe(2);
    expect(summary.activity.truncated).toBe(true);
  });

  test("lists declared measures and runs pinned metric queries", async () => {
    const { client, calls } = fakeClient();
    const summary = await summarizeWorkspace(
      client,
      options([
        { entity_type: "company", measure: "spend", by: ["month"], label: "Spend" },
        { entity_type: "company", measure: "broken" },
      ]),
    );
    expect(summary.metrics.available).toEqual(["company.spend", "company.seats"]);
    expect(summary.metrics.pinned).toEqual([
      { label: "Spend", columns: ["month", "spend"], rows: [["2026-01", 1200], ["2025-12", null]], error: null },
      { label: "company.broken", columns: [], rows: [], error: 'measure "broken" is not declared' },
    ]);
    expect(calls.find((c) => c.method === "metrics.query")?.input).toEqual({ entity_type: "company", measure: "spend", by: ["month"] });
  });

  test("reports a failing read without losing the other sections", async () => {
    const { client } = fakeClient({ feeds: { list: async () => Promise.reject(new Error("feeds down")) } });
    const summary = await summarizeWorkspace(client, options());
    expect(summary.errors).toEqual(["feeds down"]);
    expect(summary.connections).toHaveLength(1);
    expect(summary.needsYou).toHaveLength(2);
  });
});

describe("summarizeDevices", () => {
  test("normalizes device fields", async () => {
    const { client } = fakeClient();
    expect(await summarizeDevices(client)).toEqual([
      { label: "Laptop", platform: "chrome-extension", online: false, lastSeenAt: at(6), connectorErrors: 0, updateRequired: false, workspace: "acme" },
      { label: "w-2", platform: "headless", online: true, lastSeenAt: null, connectorErrors: 0, updateRequired: false, workspace: null },
    ]);
  });
});

describe("generated Lobu script", () => {
  test("matches lib/workspace-summary.ts (run `bun run generate` after editing it)", () => {
    expect(readFileSync(join(import.meta.dir, "../lib/lobu-scripts.generated.ts"), "utf8")).toBe(generatedModule());
  });

  // Lobu runs the script as a standalone module, so it must not reference
  // anything outside its own text.
  test("runs the workspace summary as a standalone module", async () => {
    const { client } = fakeClient();
    const run = await loadScript(lobuScript("summarizeWorkspace", options([{ entity_type: "company", measure: "spend" }])));
    expect(await run({}, client)).toEqual(
      await summarizeWorkspace(client, options([{ entity_type: "company", measure: "spend" }])),
    );
  });

  test("runs the device summary as a standalone module", async () => {
    const { client } = fakeClient();
    const run = await loadScript(lobuScript("summarizeDevices"));
    expect(await run({}, client)).toEqual(await summarizeDevices(client));
  });
});
