// Functions that run inside Lobu's `query_sdk` isolate, one call per workspace.
//
// `bun run generate` strips the types from this file into
// lobu-scripts.generated.ts, and that text is what Lobu runs. Keep every
// function self-contained: no imports and no references outside its own body.
// Tests call these functions directly and also run the generated text.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type LobuClient = any;

export interface SummaryOptions {
  now: number;
  maxSyncPages: number;
  pins: {
    entity_type: string;
    measure: string;
    by?: string[];
    segment?: string;
    label?: string;
  }[];
}

/** A row the page renders; `path` is relative to the workspace URL. */
export interface RawItem {
  title: string;
  detail: string | null;
  at: string | null;
  path: string | null;
}

export interface RawWorkspaceSummary {
  needsYou: (RawItem & { count: number })[];
  unreadCount: number;
  failedRuns: (RawItem & { count: number })[];
  connections: RawItem[];
  activity: {
    syncedTotal: number;
    syncRuns: number;
    truncated: boolean;
    feeds: (RawItem & { count: number })[];
    automations: (RawItem & { count: number })[];
    briefings: RawItem[];
  };
  metrics: {
    available: string[];
    pinned: {
      label: string;
      columns: string[];
      rows: (string | number | null)[][];
      error: string | null;
    }[];
  };
  errors: string[];
}

export async function summarizeWorkspace(
  client: LobuClient,
  options: SummaryOptions,
): Promise<RawWorkspaceSummary> {
  const DAY_MS = 24 * 3600 * 1000;
  const since = new Date(options.now - DAY_MS).toISOString();
  const errors: string[] = [];
  const safe = async (fn: () => Promise<any>): Promise<any> => {
    try {
      return await fn();
    } catch (error: any) {
      errors.push(String((error && error.message) || error));
      return null;
    }
  };
  const iso = (value: unknown): string | null => {
    if (!value) return null;
    const date = new Date(value as string);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };
  const pageRuns = async (input: Record<string, unknown>, maxPages: number) => {
    const runs: any[] = [];
    for (let page = 0; page < maxPages; page += 1) {
      const result = await client.operations.listRuns({
        ...input,
        created_after: since,
        limit: 500,
        offset: page * 500,
      });
      runs.push(...(result.runs || []));
      if (!result.has_more) return { runs, truncated: false };
    }
    return { runs, truncated: true };
  };

  const [activity, approvals, failed, connections, failingFeeds, automations, syncs, automationRuns, catalog] =
    await Promise.all([
      // 50 is the largest page listActivity accepts.
      safe(() => client.operations.listActivity({ limit: 50 })),
      // The activity page can miss approvals; listRuns counts all of them.
      safe(() => client.operations.listRuns({ approval_status: "pending", limit: 1 })),
      safe(() => client.operations.listRuns({ status: "failed", created_after: since, limit: 200 })),
      safe(() => client.connections.list({ limit: 200 })),
      safe(() => client.feeds.list({ health: "failing", limit: 50 })),
      safe(() => client.automations.list({ limit: 500 })),
      safe(() => pageRuns({ run_types: ["sync"], status: "completed" }, options.maxSyncPages)),
      safe(() => pageRuns({ run_types: ["automation"] }, 2)),
      safe(() => client.metrics.list({})),
    ]);

  const automationNames = new Map<string, string>(
    ((automations && automations.automations) || []).map((a: any) => [String(a.automation_id), a.name]),
  );
  const automationLabel = (id: unknown) => automationNames.get(String(id)) || `Automation ${id}`;
  const feedLabel = (run: any) =>
    [run.connection_display_name || run.connector_key, run.feed_display_name || run.feed_key]
      .filter(Boolean)
      .join(" · ");
  const runsPath = (ids: unknown[]) => `/events?run_ids=${ids.slice(0, 50).join(",")}`;

  // Needs you: pending interactions and due Automations. Identical requests
  // (one per record) collapse into one row that links to all their runs.
  const items: any[] = (activity && activity.items) || [];
  const pending = new Map<string, any>();
  for (const item of items) {
    if (item.interaction_status !== "pending" && item.kind !== "automation_due") continue;
    const title = item.title || item.kind;
    const at = iso(item.at);
    const group = pending.get(title);
    if (group) {
      group.count += 1;
      if (item.run_id) group.runIds.push(item.run_id);
      if (at && (!group.at || at > group.at)) group.at = at;
      continue;
    }
    pending.set(title, {
      title,
      at,
      count: 1,
      runIds: item.run_id ? [item.run_id] : [],
      href: item.href || null,
      due: item.kind === "automation_due",
      noun: item.kind === "automation_due" ? "Automation" : item.interaction_type || "request",
    });
  }
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const needsYou = [...pending.values()].map((group) => ({
    title: group.title,
    detail: `${plural(group.count, group.noun)} ${group.due ? "due" : "waiting"}`,
    at: group.at,
    count: group.count,
    path: group.runIds.length > 1 ? runsPath(group.runIds) : group.href,
  }));
  const listedApprovals = [...pending.values()]
    .filter((group) => group.noun === "approval")
    .reduce((sum, group) => sum + group.count, 0);
  const unlisted = ((approvals && approvals.total) || 0) - listedApprovals;
  if (unlisted > 0) {
    needsYou.push({
      title: "Older approvals",
      detail: `${plural(unlisted, "approval")} waiting beyond the newest activity`,
      at: null,
      count: unlisted,
      path: null,
    });
  }

  // Failed runs: Automation and feed runs only. Ad-hoc tool calls fail
  // routinely while an agent works and would drown the real failures.
  const failedGroups = new Map<string, any>();
  for (const run of (failed && failed.runs) || []) {
    if (!run.automation_id && !run.feed_id) continue;
    const key = run.automation_id ? `a:${run.automation_id}` : `f:${run.feed_id}`;
    const group = failedGroups.get(key);
    if (group) {
      group.count += 1;
      group.runIds.push(run.id);
      continue;
    }
    failedGroups.set(key, {
      title: run.automation_id ? automationLabel(run.automation_id) : feedLabel(run),
      detail: run.error_message || null,
      at: iso(run.created_at),
      count: 1,
      runIds: [run.id],
      automationId: run.automation_id || null,
    });
  }
  const failedRuns = [...failedGroups.values()]
    .sort((a, b) => b.count - a.count)
    .map((group) => ({
      title: group.title,
      detail: group.detail,
      at: group.at,
      count: group.count,
      path: group.automationId ? `/automations/${group.automationId}` : runsPath(group.runIds),
    }));

  // Connections and feeds that need attention. no_trigger and never_run mark
  // on-demand connections, not broken ones.
  const quiet = new Set(["healthy", "paused", "no_trigger", "never_run"]);
  const humanize = (value: unknown) => String(value).replaceAll("_", " ");
  const unhealthy: RawItem[] = ((connections && connections.connections) || [])
    .filter((c: any) => c.attention && !quiet.has(c.attention))
    .map((c: any) => ({
      title: c.display_name || c.connector_key,
      detail: humanize(c.attention) + (c.error_message ? ` — ${c.error_message}` : ""),
      at: iso(c.updated_at),
      path: "/connections",
    }));
  for (const feed of (failingFeeds && failingFeeds.feeds) || []) {
    unhealthy.push({
      title: `${feed.connection_name || feed.connector_key} · ${feed.display_name || feed.feed_key}`,
      detail: `feed ${humanize(feed.attention || "failing")}${feed.last_error ? ` — ${feed.last_error}` : ""}`,
      at: iso(feed.last_sync_at),
      path: "/connections",
    });
  }

  // Activity over the last 24h. items_collected counts every item a sync
  // fetched, including ones it had already seen, so this is "synced", not "new".
  const feedTotals = new Map<string, any>();
  let syncedTotal = 0;
  for (const run of (syncs && syncs.runs) || []) {
    const n = run.items_collected || 0;
    syncedTotal += n;
    if (n === 0) continue;
    const key = String(run.feed_id);
    const group = feedTotals.get(key);
    if (group) {
      group.count += n;
      continue;
    }
    feedTotals.set(key, { title: feedLabel(run), detail: null, at: iso(run.created_at), count: n, path: "/connections" });
  }
  const automationTotals = new Map<string, any>();
  for (const run of (automationRuns && automationRuns.runs) || []) {
    const key = String(run.automation_id);
    const group = automationTotals.get(key) || {
      title: automationLabel(run.automation_id),
      at: iso(run.created_at),
      count: 0,
      failed: 0,
      items: 0,
      path: `/automations/${run.automation_id}`,
    };
    group.count += 1;
    if (run.status === "failed") group.failed += 1;
    group.items += run.items_collected || 0;
    automationTotals.set(key, group);
  }
  const briefings: RawItem[] = items
    .filter((item) => item.status === "agent_message" && item.at && new Date(item.at).getTime() >= options.now - DAY_MS)
    .map((item) => ({
      title: item.title || "Agent message",
      // Markdown; the page renders it with bb's Markdown component.
      detail: String(item.body || "").slice(0, 600) || null,
      at: iso(item.at),
      path: item.href || null,
    }));

  // Metrics: the declared catalog plus pinned queries for this workspace.
  const available: string[] = [];
  for (const type of (catalog && catalog.entity_types) || []) {
    for (const measure of type.measures || []) available.push(`${type.entity_type}.${measure.name}`);
  }
  const pinned: RawWorkspaceSummary["metrics"]["pinned"] = [];
  for (const pin of options.pins) {
    const by = pin.by || [];
    const label = pin.label || `${pin.entity_type}.${pin.measure}${by.length ? ` by ${by.join(", ")}` : ""}`;
    try {
      const result = await client.metrics.query({
        entity_type: pin.entity_type,
        measure: pin.measure,
        by,
        ...(pin.segment ? { segment: pin.segment } : {}),
      });
      const rows: any[] = (result.rows || []).slice(0, 12);
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      pinned.push({
        label,
        columns,
        rows: rows.map((row) =>
          columns.map((column) => {
            const value = row[column];
            if (value === null || value === undefined) return null;
            return typeof value === "number" ? value : String(value);
          }),
        ),
        error: null,
      });
    } catch (error: any) {
      pinned.push({ label, columns: [], rows: [], error: String((error && error.message) || error) });
    }
  }

  return {
    needsYou,
    unreadCount: items.filter((item) => item.unread).length,
    failedRuns,
    connections: unhealthy,
    activity: {
      syncedTotal,
      syncRuns: ((syncs && syncs.runs) || []).length,
      truncated: Boolean(syncs && syncs.truncated),
      feeds: [...feedTotals.values()].sort((a, b) => b.count - a.count).slice(0, 8),
      automations: [...automationTotals.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 8)
        .map((group) => ({
          title: group.title,
          at: group.at,
          count: group.count,
          path: group.path,
          detail:
            [group.failed ? `${group.failed} failed` : null, group.items ? `${group.items} items` : null]
              .filter(Boolean)
              .join(" · ") || null,
        })),
      briefings,
    },
    metrics: { available, pinned },
    errors,
  };
}

export interface RawDevice {
  label: string;
  platform: string | null;
  online: boolean;
  lastSeenAt: string | null;
  connectorErrors: number;
  updateRequired: boolean;
  workspace: string | null;
}

/** Devices belong to the user, not a workspace, so one call covers them. */
export async function summarizeDevices(client: LobuClient): Promise<RawDevice[]> {
  const devices: any[] = (await client.devices.list()) || [];
  return devices.map((device) => ({
    label: device.label || device.worker_id,
    platform: device.platform || null,
    online: Boolean(device.online),
    lastSeenAt: device.last_seen_at || null,
    connectorErrors: device.connector_error_count || 0,
    updateRequired: (device.update_required || []).length > 0,
    workspace: device.organization_slug || null,
  }));
}
