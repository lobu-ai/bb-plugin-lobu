// Builds one dashboard snapshot across every workspace the configured logins cover.
import type { DashboardItem, MetricPin, Snapshot, WorkspaceSummary } from "./contract";
import { LobuSetupError, type LobuApi } from "./lobu-api";
import { LOBU_SCRIPTS_SOURCE } from "./lobu-scripts.generated";
import type { RawDevice, RawItem, RawWorkspaceSummary, SummaryOptions } from "./workspace-summary";

/** Caps the 24h scan: feeds sync every few minutes, so busy workspaces log thousands of runs a day. */
const MAX_SYNC_PAGES = 6;

export interface SnapshotConfig {
  /** CLI contexts to read; `null` is the CLI's active context. */
  contexts: (string | null)[];
  hiddenWorkspaces: Set<string>;
  baseUrl: string;
  pins: MetricPin[];
  now: number;
}

/** A query_sdk module that runs one function from lib/workspace-summary.ts. */
export function lobuScript(entry: "summarizeWorkspace", options: SummaryOptions): string;
export function lobuScript(entry: "summarizeDevices"): string;
export function lobuScript(entry: string, options?: SummaryOptions): string {
  const args = options === undefined ? "client" : `client, ${JSON.stringify(options)}`;
  return `${LOBU_SCRIPTS_SOURCE}\nexport default async (ctx, client) => ${entry}(${args});\n`;
}

export function parseList(value: string): string[] {
  return value
    .replaceAll(",", " ")
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function emptyWorkspace(slug: string, name: string, error: string): WorkspaceSummary {
  return {
    slug,
    name,
    needsYou: [],
    unreadCount: 0,
    failedRuns: [],
    connections: [],
    activity: { syncedTotal: 0, syncRuns: 0, truncated: false, feeds: [], automations: [], briefings: [] },
    metrics: { available: [], pinned: [] },
    error,
  };
}

export function workspaceUrl(baseUrl: string, slug: string, path: string | null): string | null {
  if (path === null) return null;
  if (path.startsWith("https://") || path.startsWith("http://")) return path;
  // Activity hrefs already start with the workspace slug.
  if (path === `/${slug}` || path.startsWith(`/${slug}/`) || path.startsWith(`/${slug}?`)) return baseUrl + path;
  return `${baseUrl}/${slug}${path.startsWith("/") ? path : `/${path}`}`;
}

export function toWorkspaceSummary(
  baseUrl: string,
  slug: string,
  name: string,
  raw: RawWorkspaceSummary,
): WorkspaceSummary {
  const item = <T extends RawItem>({ path, ...rest }: T) => ({ ...rest, url: workspaceUrl(baseUrl, slug, path) });
  return {
    slug,
    name,
    needsYou: raw.needsYou.map(item),
    unreadCount: raw.unreadCount,
    failedRuns: raw.failedRuns.map(item),
    connections: raw.connections.map(item),
    activity: {
      syncedTotal: raw.activity.syncedTotal,
      syncRuns: raw.activity.syncRuns,
      truncated: raw.activity.truncated,
      feeds: raw.activity.feeds.map(item),
      automations: raw.activity.automations.map(item),
      briefings: raw.activity.briefings.map(item),
    },
    metrics: raw.metrics,
    error: raw.errors.length > 0 ? raw.errors.join("; ") : null,
  };
}

/** Only devices that need attention: offline, connector errors, or an update. */
export function deviceItems(baseUrl: string, devices: RawDevice[]): DashboardItem[] {
  return devices
    .filter((device) => !device.online || device.connectorErrors > 0 || device.updateRequired)
    .map((device) => ({
      title: device.label,
      detail: [
        device.online ? null : "offline",
        device.connectorErrors > 0 ? `${device.connectorErrors} connector errors` : null,
        device.updateRequired ? "update required" : null,
        device.platform,
      ]
        .filter((part) => part !== null)
        .join(" · "),
      at: device.lastSeenAt,
      url: device.workspace === null ? null : `${baseUrl}/${device.workspace}/devices`,
    }));
}

export interface WorkspaceOwner {
  context: string | null;
  name: string;
  personal: boolean;
}

/**
 * Which workspaces each login covers, keyed by slug. The first context in
 * `contexts` that lists a workspace reads it.
 */
export async function discoverWorkspaces(api: LobuApi, contexts: (string | null)[]) {
  const errors: string[] = [];
  let setup: Snapshot["setup"] = null;
  const listed = await Promise.all(
    contexts.map(async (context) => {
      try {
        return await api.workspaces(context);
      } catch (cause) {
        if (cause instanceof LobuSetupError) {
          setup ??= { code: cause.code, context: cause.context, message: cause.message };
        } else {
          errors.push(`${context ?? "active context"}: ${errorMessage(cause)}`);
        }
        return [];
      }
    }),
  );
  const owners = new Map<string, WorkspaceOwner>();
  listed.forEach((workspaces, index) => {
    const context = contexts[index] ?? null;
    for (const { slug, name, personal } of workspaces) {
      if (!owners.has(slug)) owners.set(slug, { context, name, personal });
    }
  });
  return { owners, setup: setup as Snapshot["setup"], errors };
}

export async function buildSnapshot(api: LobuApi, config: SnapshotConfig): Promise<Snapshot> {
  const { baseUrl } = config;
  const discovered = await discoverWorkspaces(api, config.contexts);
  const { owners, errors } = discovered;
  let setup = discovered.setup;

  const visible = [...owners.entries()].filter(([slug]) => !config.hiddenWorkspaces.has(slug));
  if (visible.length === 0 && setup === null && errors.length === 0) {
    setup = {
      code: "no_workspaces",
      context: null,
      message: "The configured Lobu logins cover no visible workspaces.",
    };
  }

  const workspaces = await Promise.all(
    visible.map(async ([slug, { context, name }]) => {
      const pins = config.pins
        .filter((pin) => pin.workspace === slug)
        .map(({ workspace: _workspace, ...pin }) => pin);
      const script = lobuScript("summarizeWorkspace", { now: config.now, maxSyncPages: MAX_SYNC_PAGES, pins });
      try {
        const raw = (await api.querySdk(context, slug, "bb dashboard summary", script)) as RawWorkspaceSummary;
        return toWorkspaceSummary(baseUrl, slug, name, raw);
      } catch (cause) {
        return emptyWorkspace(slug, name, errorMessage(cause));
      }
    }),
  );

  let devices: DashboardItem[] = [];
  const first = visible[0];
  if (first !== undefined) {
    try {
      const raw = (await api.querySdk(first[1].context, first[0], "bb dashboard devices", lobuScript("summarizeDevices"))) as RawDevice[];
      devices = deviceItems(baseUrl, raw);
    } catch (cause) {
      errors.push(`devices: ${errorMessage(cause)}`);
    }
  }

  workspaces.sort((a, b) => a.slug.localeCompare(b.slug));
  return { fetchedAt: new Date(config.now).toISOString(), baseUrl, workspaces, devices, setup, errors };
}
