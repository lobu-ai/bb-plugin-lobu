import { describe, expect, test } from "bun:test";
import { LobuSetupError, type LobuApi } from "../lib/lobu-api";
import { buildSnapshot, deviceItems, parseList, workspaceUrl, type SnapshotConfig } from "../lib/snapshot";
import type { RawWorkspaceSummary } from "../lib/workspace-summary";

const BASE = "https://lobu.example";

const raw = (overrides: Partial<RawWorkspaceSummary> = {}): RawWorkspaceSummary => ({
  needsYou: [{ title: "Review", detail: "approval", at: null, count: 1, path: "/acme/events?run_ids=1" }],
  unreadCount: 0,
  failedRuns: [{ title: "Digest", detail: "timeout", at: null, count: 2, path: "/automations/7" }],
  connections: [],
  activity: { syncedTotal: 0, syncRuns: 0, truncated: false, feeds: [], automations: [], briefings: [] },
  metrics: { available: [], pinned: [] },
  errors: [],
  ...overrides,
});

function fakeApi(handlers: {
  workspaces: (context: string | null) => Promise<{ slug: string; name: string }[]>;
  querySdk?: (context: string | null, workspace: string, title: string, script: string) => Promise<unknown>;
}) {
  const queries: { context: string | null; workspace: string; title: string; script: string }[] = [];
  const api = {
    workspaces: handlers.workspaces,
    querySdk: async (context: string | null, workspace: string, title: string, script: string) => {
      queries.push({ context, workspace, title, script });
      if (handlers.querySdk) return handlers.querySdk(context, workspace, title, script);
      return title === "bb dashboard devices" ? [] : raw();
    },
  } as unknown as LobuApi;
  return { api, queries };
}

const config = (overrides: Partial<SnapshotConfig> = {}): SnapshotConfig => ({
  contexts: [null],
  hiddenWorkspaces: new Set(),
  baseUrl: BASE,
  pins: [],
  now: Date.parse("2026-01-15T12:00:00.000Z"),
  ...overrides,
});

describe("parseList", () => {
  test("splits on commas and whitespace", () => {
    expect(parseList(" acme, beta  gamma,,")).toEqual(["acme", "beta", "gamma"]);
    expect(parseList("")).toEqual([]);
  });
});

describe("workspaceUrl", () => {
  test("prefixes the workspace unless the path already carries it", () => {
    expect(workspaceUrl(BASE, "acme", "/automations/7")).toBe(`${BASE}/acme/automations/7`);
    expect(workspaceUrl(BASE, "acme", "/acme/events?run_ids=1")).toBe(`${BASE}/acme/events?run_ids=1`);
    expect(workspaceUrl(BASE, "acme", "/acme-two/x")).toBe(`${BASE}/acme/acme-two/x`);
    expect(workspaceUrl(BASE, "acme", "https://other.example/x")).toBe("https://other.example/x");
    expect(workspaceUrl(BASE, "acme", null)).toBeNull();
  });
});

describe("deviceItems", () => {
  test("keeps only devices that need attention", () => {
    const items = deviceItems(BASE, [
      { label: "Laptop", platform: "chrome-extension", online: false, lastSeenAt: null, connectorErrors: 0, updateRequired: false, workspace: "acme" },
      { label: "Server", platform: "headless", online: true, lastSeenAt: null, connectorErrors: 0, updateRequired: false, workspace: "acme" },
      { label: "Mini", platform: "headless", online: true, lastSeenAt: null, connectorErrors: 2, updateRequired: true, workspace: null },
    ]);
    expect(items).toEqual([
      { title: "Laptop", detail: "offline · chrome-extension", at: null, url: `${BASE}/acme/devices` },
      { title: "Mini", detail: "2 connector errors · update required · headless", at: null, url: null },
    ]);
  });
});

describe("buildSnapshot", () => {
  test("reads each workspace once, with the first context that covers it", async () => {
    const { api, queries } = fakeApi({
      workspaces: async (context) =>
        context === "work" ? [{ slug: "acme", name: "Acme" }, { slug: "beta", name: "Beta" }] : [{ slug: "acme", name: "Acme" }],
    });
    const snapshot = await buildSnapshot(api, config({ contexts: ["work", "personal"] }));
    expect(snapshot.workspaces.map((w) => w.slug)).toEqual(["acme", "beta"]);
    const summaries = queries.filter((q) => q.title === "bb dashboard summary");
    expect(summaries.map((q) => [q.workspace, q.context]).sort()).toEqual([
      ["acme", "work"],
      ["beta", "work"],
    ]);
    expect(snapshot.workspaces[0]?.needsYou[0]?.url).toBe(`${BASE}/acme/events?run_ids=1`);
    expect(snapshot.workspaces[0]?.failedRuns[0]?.url).toBe(`${BASE}/acme/automations/7`);
    expect(snapshot.setup).toBeNull();
  });

  test("sends each workspace only its own metric pins", async () => {
    const { api, queries } = fakeApi({ workspaces: async () => [{ slug: "acme", name: "Acme" }, { slug: "beta", name: "Beta" }] });
    await buildSnapshot(
      api,
      config({ pins: [{ workspace: "beta", entity_type: "company", measure: "spend" }] }),
    );
    const scriptFor = (slug: string) => queries.find((q) => q.workspace === slug && q.title === "bb dashboard summary")?.script ?? "";
    expect(scriptFor("beta")).toContain('"measure":"spend"');
    expect(scriptFor("acme")).toContain('"pins":[]');
  });

  test("hides configured workspaces", async () => {
    const { api } = fakeApi({ workspaces: async () => [{ slug: "acme", name: "Acme" }, { slug: "beta", name: "Beta" }] });
    const snapshot = await buildSnapshot(api, config({ hiddenWorkspaces: new Set(["beta"]) }));
    expect(snapshot.workspaces.map((w) => w.slug)).toEqual(["acme"]);
  });

  test("turns a missing login into setup steps", async () => {
    const { api } = fakeApi({
      workspaces: async (context) => {
        throw new LobuSetupError("not_logged_in", context, "The lobu CLI has no login for work.");
      },
    });
    const snapshot = await buildSnapshot(api, config({ contexts: ["work"] }));
    expect(snapshot.setup).toEqual({ code: "not_logged_in", context: "work", message: "The lobu CLI has no login for work." });
    expect(snapshot.workspaces).toEqual([]);
  });

  test("lists an expired login as a problem when other logins work", async () => {
    const { api } = fakeApi({
      workspaces: async (context) => {
        if (context === "stale") throw new LobuSetupError("not_logged_in", context, "Lobu rejected the login for stale.");
        return [{ slug: "acme", name: "Acme" }];
      },
    });
    const snapshot = await buildSnapshot(api, config({ contexts: ["work", "stale"] }));
    expect(snapshot.setup).toBeNull();
    expect(snapshot.errors).toEqual(["stale: Lobu rejected the login for stale."]);
    expect(snapshot.workspaces.map((w) => w.slug)).toEqual(["acme"]);
  });

  test("reports no visible workspaces as a setup problem", async () => {
    const { api } = fakeApi({ workspaces: async () => [{ slug: "acme", name: "Acme" }] });
    const snapshot = await buildSnapshot(api, config({ hiddenWorkspaces: new Set(["acme"]) }));
    expect(snapshot.setup?.code).toBe("no_workspaces");
  });

  test("keeps other workspaces when one read fails", async () => {
    const { api } = fakeApi({
      workspaces: async () => [{ slug: "acme", name: "Acme" }, { slug: "beta", name: "Beta" }],
      querySdk: async (_context, workspace, title) => {
        if (title === "bb dashboard devices") return [];
        if (workspace === "beta") throw new Error("Lobu returned 503");
        return raw({ errors: ["feeds down"] });
      },
    });
    const snapshot = await buildSnapshot(api, config());
    expect(snapshot.workspaces.map((w) => [w.slug, w.error])).toEqual([
      ["acme", "feeds down"],
      ["beta", "Lobu returned 503"],
    ]);
  });
});
