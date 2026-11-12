// Talks to Lobu with the user's existing `lobu` CLI login. Tokens stay in the
// plugin server process and are never sent to the page.
import { z } from "zod";
import { cliFailure, createCliRunner, LobuSetupError } from "./cli";
import type { EntityRef, UnlinkedName } from "./entity-links";

/** How long a `lobu whoami` session is reused before asking the CLI again. */
const SESSION_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** A new Lobu on this machine loads its search model on the first search, which takes longer. */
const LOCAL_REQUEST_TIMEOUT_MS = 120_000;

export interface Workspace {
  slug: string;
  name: string;
  /** The user's personal workspace. */
  personal: boolean;
}

/** The subset of save_memory's input the plugin sends. */
export interface SaveMemoryInput {
  title: string;
  content: string;
  semantic_type: string;
  idempotency_key: string;
  supersedes_event_id?: number;
  entity_ids?: EntityRef[];
}

export interface SavedMemory {
  id: number;
  viewUrl: string | null;
  /** Every record the memory is linked to, as Lobu stored it. */
  entityIds: number[];
  /** Names Lobu did not link, and why. */
  unlinked: UnlinkedName[];
}

/** A CLI login as `lobu whoami --json` reports it, the same source the Lobu Mac app reads. */
export interface Session {
  account: string | null;
  /** The bearer token for Lobu's API; null when the login is signed out. */
  token: string | null;
  workspaces: Workspace[];
}

const whoamiSchema = z.object({
  loggedIn: z.boolean(),
  local: z.boolean(),
  email: z.string().optional(),
  accessToken: z.string().optional(),
  workerToken: z.string().optional(),
  orgSlug: z.string().optional(),
  personalOrgSlug: z.string().optional(),
  organizations: z.array(z.object({ slug: z.string(), name: z.string().optional() })),
});

/**
 * Reads `lobu whoami --json --include-tokens`. A Lobu on this machine takes
 * the worker token its `lobu run` minted, as in the Mac app; a remote Lobu
 * takes the session's access token. As in the Mac app, a Lobu that names no
 * personal workspace (a new local install lists none) saves to the login's own.
 */
export function parseWhoami(output: string): Session | null {
  let parsed: z.infer<typeof whoamiSchema>;
  try {
    const result = whoamiSchema.safeParse(JSON.parse(output.trim().split("\n").pop() ?? ""));
    if (!result.success) return null;
    parsed = result.data;
  } catch {
    return null;
  }
  const token = parsed.local ? (parsed.workerToken ?? parsed.accessToken) : parsed.accessToken;
  const personal = parsed.personalOrgSlug ?? parsed.orgSlug;
  const listed = parsed.organizations.length > 0 || parsed.orgSlug === undefined ? parsed.organizations : [{ slug: parsed.orgSlug }];
  return {
    account: parsed.email ?? null,
    token: parsed.loggedIn && token ? token : null,
    workspaces: listed.map((org) => ({ slug: org.slug, name: org.name ?? org.slug, personal: org.slug === personal })),
  };
}

export interface LobuApiOptions {
  baseUrl: string;
}

const cliContextsSchema = z.object({
  contexts: z.array(z.object({ name: z.string(), url: z.string(), current: z.boolean(), loggedIn: z.boolean() })),
});

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** A `lobu` CLI context and the Lobu origin it logs in to. */
export interface CliContext {
  name: string;
  origin: string;
  current: boolean;
  loggedIn: boolean;
}

/** Every context from `lobu context list --json`, the active one first. */
export function parseCliContexts(listed: unknown): CliContext[] {
  const parsed = cliContextsSchema.safeParse(listed);
  if (!parsed.success) return [];
  return parsed.data.contexts
    .flatMap((context) => {
      const origin = originOf(context.url);
      return origin === null ? [] : [{ name: context.name, origin, current: context.current, loggedIn: context.loggedIn }];
    })
    .sort((a, b) => Number(b.current) - Number(a.current));
}

const isLoopback = (url: URL) => ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);

/** Cloud origin bb signs in to; the CLI's built-in `lobu` context points here. */
export const CLOUD_ORIGIN = "https://app.lobu.ai";

/** Classify a Lobu origin the way the Mac app does: local loopback, Cloud, or another Lobu. */
export function kindOfOrigin(origin: string): "cloud" | "local" | "other" {
  try {
    const url = new URL(origin);
    if (isLoopback(url)) return "local";
  } catch {
    return "other";
  }
  return origin === CLOUD_ORIGIN ? "cloud" : "other";
}

/**
 * Picks the Cloud context to use, reusing what exists instead of duplicating
 * it: the preferred login when signed in, else any signed-in Cloud login,
 * else the preferred login when it exists, else any Cloud login.
 */
export function pickCloudContext(contexts: CliContext[], preferredName = "lobu"): CliContext | null {
  const cloud = contexts.filter((c) => kindOfOrigin(c.origin) === "cloud");
  return (
    cloud.find((c) => c.name === preferredName && c.loggedIn) ??
    cloud.find((c) => c.loggedIn) ??
    cloud.find((c) => c.name === preferredName) ??
    cloud[0] ??
    null
  );
}

/** Prefers a signed-in login for an origin, so adding reuses instead of duplicating. */
export function pickOriginContext(contexts: CliContext[], origin: string): CliContext | null {
  const matches = contexts.filter((c) => c.origin === origin);
  return matches.find((c) => c.loggedIn) ?? matches[0] ?? null;
}

/** A Lobu inbox notification, as `GET /api/:slug/notifications` reports it. */
export interface NotificationItem {
  id: number;
  type: string;
  title: string;
  body: string | null;
  resourceUrl: string | null;
  isRead: boolean;
  createdAt: string;
}

const notificationItemSchema = z.object({
  id: z.number(),
  type: z.string().optional(),
  title: z.string().optional(),
  body: z.string().nullable().optional(),
  resource_url: z.string().nullable().optional(),
  is_read: z.boolean().optional(),
  created_at: z.string().optional(),
});

function parseNotificationItem(row: unknown): NotificationItem | null {
  const parsed = notificationItemSchema.safeParse(row);
  if (!parsed.success || typeof parsed.data.id !== "number") return null;
  const item = parsed.data;
  return {
    id: item.id,
    type: item.type ?? "notification",
    title: item.title ?? `Notification ${item.id}`,
    body: item.body ?? null,
    resourceUrl: item.resource_url ?? null,
    isRead: item.is_read ?? false,
    createdAt: item.created_at ?? "",
  };
}
/** A feed as `manage_feeds` `list_feeds` reports it (subset). */
export interface FeedItem {
  id: number;
  displayName: string;
  status: string;
  connectorKey: string | null;
  /** Human connector name ("Google Chat"), when Lobu knows one. */
  connectorName: string | null;
  /** The feed's own key ("gchat:spaces/3eodnKAAAAE"); displayName often just repeats it. */
  feedKey: string | null;
  connectionId: number | null;
  lastError: string | null;
  itemsCollected: number | null;
  updatedAt: string | null;
}

/** An automation as `client.automations.list()` reports it (subset). */
export interface AutomationItem {
  id: string;
  name: string;
  status: string;
  triggers: { kind: string }[] | null;
  updatedAt: string | null;
}

/** A paired device as `GET /api/me/devices` reports it (subset). */
export interface DeviceItem {
  id: string;
  workerId: string;
  label: string | null;
  platform: string | null;
  online: boolean;
  lastSeenAt: string | null;
  capabilities: string[];
}

/** A connection as `manage_connections` `list` reports it (subset). */
export interface ConnectionItem {
  id: number;
  displayName: string;
  connectorKey: string | null;
  /** Human connector name ("Google Chat"), when Lobu knows one. */
  connectorName: string | null;
  /** The account this connection is signed in as, when it has one. */
  account: string | null;
  /** The paired device behind a browser or shell connection. */
  deviceLabel: string | null;
  status: string;
  errorMessage: string | null;
}

const feedItemSchema = z.object({
  id: z.number(),
  display_name: z.string().optional(),
  status: z.string().optional(),
  connector_key: z.string().nullable().optional(),
  connector_name: z.string().nullable().optional(),
  feed_key: z.string().nullable().optional(),
  connection_id: z.number().nullable().optional(),
  last_error: z.string().nullable().optional(),
  items_collected: z.number().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});

function parseFeedItem(row: unknown): FeedItem | null {
  const parsed = feedItemSchema.safeParse(row);
  if (!parsed.success) return null;
  const f = parsed.data;
  return {
    id: f.id,
    displayName: f.display_name ?? `Feed ${f.id}`,
    status: f.status ?? "unknown",
    connectorKey: f.connector_key ?? null,
    connectorName: f.connector_name ?? null,
    feedKey: f.feed_key ?? null,
    connectionId: f.connection_id ?? null,
    lastError: f.last_error ?? null,
    itemsCollected: f.items_collected ?? null,
    updatedAt: f.updated_at ?? null,
  };
}
/** A browser tab as the chrome bridge `list_tabs` operation reports it (subset). */
export interface TabItem {
  tabId: number;
  title: string;
  url: string;
  windowId: number | null;
  active: boolean;
  windowFocused?: boolean;
}

function parseTabItem(row: unknown): TabItem | null {
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;
  if (typeof record.tab_id !== "number") return null;
  const url = typeof record.url === "string" ? record.url : "";
  return {
    tabId: record.tab_id,
    title: typeof record.title === "string" && record.title !== "" ? record.title : url || `Tab ${record.tab_id}`,
    url,
    windowId: typeof record.window_id === "number" ? record.window_id : null,
    active: record.active === true,
    windowFocused: record.window_focused === true,
  };
}

/** Lobu origins the plugin talks to: HTTPS, or HTTP on this machine. */
export function lobuOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopback(parsed)) ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function createLobuApi({ baseUrl }: LobuApiOptions) {
  const cli = createCliRunner();
  const timeoutMs = isLoopback(new URL(baseUrl)) ? LOCAL_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  const runLobu = cli.run;
  const sessions = new Map<string, { session: Session; at: number }>();
  const contextLabel = (context: string | null) => context ?? "the active context";

  /** The session `lobu whoami` reports for a context, reused for a few minutes. */
  async function session(context: string | null, fresh: boolean): Promise<Session> {
    const key = context ?? "";
    const hit = sessions.get(key);
    if (!fresh && hit && Date.now() - hit.at < SESSION_TTL_MS) return hit.session;
    const args = ["whoami", "--json", "--include-tokens", ...(context === null ? [] : ["--context", context])];
    let stdout: string;
    try {
      stdout = await runLobu(args);
    } catch (error) {
      throw cliFailure(error, context);
    }
    const parsed = parseWhoami(stdout);
    if (parsed === null) throw new LobuSetupError("cli_failed", context, "lobu whoami printed something bb cannot read.");
    if (parsed.token === null) {
      throw new LobuSetupError("not_logged_in", context, `The lobu CLI has no login for ${contextLabel(context)}.`);
    }
    sessions.set(key, { session: parsed, at: Date.now() });
    return parsed;
  }

  async function request(context: string | null, path: string, body?: unknown, method?: string): Promise<unknown> {
    // A 401 means the cached token expired; mint a fresh one once.
    for (const fresh of [false, true]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          Authorization: `Bearer ${(await session(context, fresh)).token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 401 && !fresh) continue;
      if (response.status === 401) {
        throw new LobuSetupError(
          "not_logged_in",
          context,
          `Lobu rejected the login for ${contextLabel(context)}.`,
        );
      }
      const text = await response.text();
      if (!response.ok) throw new Error(`Lobu returned ${response.status} for ${path}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    }
    throw new Error("unreachable");
  }

  /** Who this CLI context is signed in as, and the workspaces it is authorized for. */
  async function identity(context: string | null): Promise<Session> {
    return session(context, true);
  }

  /** Every CLI context, the active one first; null when the CLI cannot list them as JSON. */
  async function cliContexts(): Promise<CliContext[] | null> {
    try {
      const listed = parseCliContexts(JSON.parse(await runLobu(["context", "list", "--json"])));
      return listed.length === 0 ? null : listed;
    } catch {
      return null;
    }
  }

  /**
   * Starts `lobu login` for a context (null: the CLI's active one). The CLI
   * opens Lobu's approval page for HTTPS and finishes once the user
   * approves; returns the approval URL it printed.
   */
  function signIn(context: string | null): Promise<string | null> {
    return cli.start(["login", ...(context === null ? [] : ["--context", context]), "--wait-for-approval"]);
  }

  return {
    cliContexts,

    /**
     * Adds a CLI context for this Lobu and starts its login, which the CLI
     * finishes once the user approves it in the browser (the CLI opens the
     * page itself for HTTPS). Returns the approval URL it printed.
     */
    async addContext(name: string, url: string): Promise<string | null> {
      try {
        // `--` keeps a name that starts with a dash from reading as an option.
        await runLobu(["context", "add", "--url", url, "--", name]);
      } catch (error) {
        const failure = error as { code?: unknown; stderr?: unknown; stdout?: unknown };
        if (failure.code === "ENOENT") throw cliFailure(error, name);
        const detail = [failure.stderr, failure.stdout].map((text) => (typeof text === "string" ? text.trim() : "")).find((text) => text !== "");
        throw new Error(detail ?? `lobu could not add the ${name} context.`);
      }
      return signIn(name);
    },

    signIn,
    identity,
    cliState: cli.state,
    installer: cli.installer,
    installCli: cli.install,
    serve: cli.serve,

    async workspaces(context: string | null): Promise<Workspace[]> {
      return (await identity(context)).workspaces;
    },

    /** Saves one memory with Lobu's save_memory tool; returns the saved event. */
    async saveMemory(context: string | null, workspace: string, memory: SaveMemoryInput): Promise<SavedMemory> {
      const saved = (await request(context, `/api/${encodeURIComponent(workspace)}/save_memory`, memory)) as {
        id?: number;
        view_url?: string;
        entity_ids?: unknown[];
        unlinked?: UnlinkedName[];
        error?: string | { message?: string };
      };
      if (typeof saved.id !== "number") {
        const error = typeof saved.error === "string" ? saved.error : saved.error?.message;
        throw new Error(error ?? "save_memory returned no event");
      }
      return {
        id: saved.id,
        viewUrl: saved.view_url ?? null,
        entityIds: (saved.entity_ids ?? []).map(Number).filter((id) => Number.isInteger(id) && id > 0),
        unlinked: saved.unlinked ?? [],
      };
    },

    /** Lobu's search_memory over one workspace's saved memory; the raw response. */
    async searchMemory(context: string | null, workspace: string, query: string, limit: number): Promise<unknown> {
      return request(context, `/api/${encodeURIComponent(workspace)}/search_memory`, {
        query,
        limit,
        content_limit: limit,
        include_content: true,
        include_connections: false,
        include_public_catalogs: false,
      });
    },

    /** Lobu's search_memory by entity ID; returns the entity details. */
    async readEntity(context: string | null, workspace: string, entityId: number): Promise<unknown> {
      return request(context, `/api/${encodeURIComponent(workspace)}/search_memory`, {
        entity_id: entityId,
        include_content: false,
        include_connections: false,
        include_public_catalogs: false,
      });
    },

    /** Recent current saved memories (platform=lobu) in one workspace, newest first. */
    async listMemories(context: string | null, workspace: string, limit: number): Promise<unknown> {
      return request(context, `/api/${encodeURIComponent(workspace)}/read_knowledge`, {
        platforms: ["lobu"],
        semantic_type: ["fact", "decision", "preference", "observation", "note"],
        sort_by: "date",
        sort_order: "desc",
        limit,
        include_total: false,
      });
    },

    /** Exact event lineages for saved event ids, including supersede and tombstone chains. */
    async readEvents(context: string | null, workspace: string, ids: number[]): Promise<unknown> {
      return request(context, `/api/${encodeURIComponent(workspace)}/read_knowledge`, {
        content_ids: ids,
        limit: Math.min(Math.max(ids.length * 3, 50), 200),
      });
    },

    /** Hides memories with Lobu's tombstone delete; they stay recoverable in Lobu. */
    async deleteMemories(context: string | null, workspace: string, ids: number[], reason: string): Promise<number[]> {
      const script = `export default async (_ctx, client) => client.knowledge.delete(${JSON.stringify({ content_ids: ids, reason })});`;
      const result = (await request(context, `/api/${encodeURIComponent(workspace)}/run_sdk`, {
        title: "Undo a memory saved from bb",
        script,
      })) as { success?: boolean; return_value?: { deleted_ids?: number[]; already_superseded_ids?: number[] }; error?: { message?: string } };
      if (result.success !== true) throw new Error(result.error?.message ?? "run_sdk failed");
      return [...(result.return_value?.deleted_ids ?? []), ...(result.return_value?.already_superseded_ids ?? [])];
    },

    /** Newest inbox notifications in one workspace, newest first. */
    async listNotifications(
      context: string | null,
      workspace: string,
      limit: number,
      cursor: number | null,
    ): Promise<{ notifications: NotificationItem[]; nextCursor: number | null }> {
      const params = new URLSearchParams({ limit: String(limit) });
      if (cursor !== null) params.set("cursor", String(cursor));
      const listed = (await request(context, `/api/${encodeURIComponent(workspace)}/notifications?${params}`)) as {
        notifications?: unknown[];
        nextCursor?: number | null;
      };
      return {
        notifications: (Array.isArray(listed.notifications) ? listed.notifications : [])
          .map((row) => parseNotificationItem(row))
          .filter((item): item is NotificationItem => item !== null),
        nextCursor: typeof listed.nextCursor === "number" ? listed.nextCursor : null,
      };
    },

    /** How many inbox notifications are unread in one workspace. */
    async unreadNotificationCount(context: string | null, workspace: string): Promise<number> {
      const result = (await request(context, `/api/${encodeURIComponent(workspace)}/notifications/unread-count`)) as {
        count?: number;
      };
      return typeof result.count === "number" ? result.count : 0;
    },

    /** Marks one inbox notification read. A 2xx from Lobu is the success signal. */
    async markNotificationRead(context: string | null, workspace: string, id: number): Promise<void> {
      await request(context, `/api/${encodeURIComponent(workspace)}/notifications/${id}/read`, undefined, "PATCH");
    },

    /** Feeds in one workspace, newest first. */
    async listFeeds(context: string | null, workspace: string, limit: number): Promise<FeedItem[]> {
      const listed = (await request(context, `/api/${encodeURIComponent(workspace)}/manage_feeds`, {
        action: "list_feeds",
        limit,
      })) as { feeds?: unknown[] };
      return (Array.isArray(listed.feeds) ? listed.feeds : [])
        .map((row) => parseFeedItem(row))
        .filter((item): item is FeedItem => item !== null);
    },

    /** Automations in one workspace, via the direct manage_automations tool. */
    async listAutomations(context: string | null, workspace: string, limit: number): Promise<AutomationItem[]> {
      const listed = (await request(context, `/api/${encodeURIComponent(workspace)}/manage_automations`, {
        action: "list",
        limit,
      })) as { automations?: unknown[] };
      const rows = listed.automations;
      if (!Array.isArray(rows)) return [];
      return rows.flatMap((row) => {
        if (typeof row !== "object" || row === null) return [];
        const record = row as Record<string, unknown>;
        const id = record.automation_id;
        if (typeof id !== "string" && typeof id !== "number") return [];
        const triggers = Array.isArray(record.triggers)
          ? record.triggers.flatMap((t) =>
              typeof t === "object" && t !== null && typeof (t as Record<string, unknown>).kind === "string"
                ? [{ kind: (t as Record<string, unknown>).kind as string }]
                : [],
            )
          : null;
        return [
          {
            id: String(id),
            name: typeof record.name === "string" ? record.name : `Automation ${String(id)}`,
            status: typeof record.status === "string" ? record.status : "unknown",
            triggers,
            updatedAt: typeof record.updated_at === "string" ? record.updated_at : null,
          },
        ];
      });
    },

    /** Connections in one workspace. */
    async listConnections(context: string | null, workspace: string): Promise<ConnectionItem[]> {
      const listed = (await request(context, `/api/${encodeURIComponent(workspace)}/manage_connections`, {
        action: "list",
      })) as { connections?: unknown[] };
      return (Array.isArray(listed.connections) ? listed.connections : []).flatMap((row) => {
        if (typeof row !== "object" || row === null) return [];
        const record = row as Record<string, unknown>;
        if (typeof record.id !== "number") return [];
        return [
          {
            id: record.id,
            displayName: typeof record.display_name === "string" ? record.display_name : `Connection ${record.id}`,
            connectorKey: typeof record.connector_key === "string" ? record.connector_key : null,
            connectorName: typeof record.connector_name === "string" ? record.connector_name : null,
            account: typeof record.auth_profile_name === "string" ? record.auth_profile_name : null,
            deviceLabel: typeof record.device_label === "string" ? record.device_label : null,
            status: typeof record.status === "string" ? record.status : "unknown",
            errorMessage: typeof record.error_message === "string" ? record.error_message : null,
          },
        ];
      });
    },

    /** Open tabs on one chrome-bridge connection. Volatile by nature: always fetched live, never cached. */
    async listTabs(context: string | null, workspace: string, connectionId: number): Promise<TabItem[]> {
      const result = (await request(context, `/api/${encodeURIComponent(workspace)}/manage_operations`, {
        action: "execute",
        connection_id: connectionId,
        operation_key: "list_tabs",
        input: {},
      })) as { tabs?: unknown[]; output?: { tabs?: unknown[] } };
      const rows = Array.isArray(result)
        ? result
        : Array.isArray(result.tabs)
          ? result.tabs
          : Array.isArray(result.output?.tabs)
            ? result.output.tabs
            : [];
      return rows
        .map((row) => parseTabItem(row))
        .filter((item): item is TabItem => item !== null);
    },

    /**
     * One open tab as it is right now: title, URL, and the page's visible text,
     * read in a single bridge call. The agent learns what the page says instead
     * of only where it is. Null when the tab is gone or the bridge refuses
     * (a chrome:// page, a sleeping browser).
     *
     * One call on purpose: the bridge runs operations for a connection in
     * order, so a `list_tabs` alongside this would queue ahead of it.
     */
    async readTabSnapshot(
      context: string | null,
      workspace: string,
      connectionId: number,
      tabId: number,
      maxChars: number,
    ): Promise<{ title: string; url: string; text: string } | null> {
      const result = (await request(context, `/api/${encodeURIComponent(workspace)}/manage_operations`, {
        action: "execute",
        connection_id: connectionId,
        operation_key: "evaluate",
        input: {
          tab_id: tabId,
          expression: `(() => { const text = (document.body?.innerText ?? "").replace(/\\s+/g, " ").trim(); return { title: document.title, url: location.href, text: text.slice(0, ${Math.floor(maxChars)}) }; })()`,
          await_promise: false,
        },
      })) as { output?: { value?: unknown } };
      const value = result.output?.value;
      if (typeof value !== "object" || value === null) return null;
      const record = value as Record<string, unknown>;
      return {
        title: typeof record.title === "string" && record.title !== "" ? record.title : "Browser tab",
        url: typeof record.url === "string" ? record.url : "",
        text: typeof record.text === "string" ? record.text.trim() : "",
      };
    },

    /** Devices paired to the user (user-scoped, not per workspace). */
    async listDevices(context: string | null): Promise<DeviceItem[]> {
      const listed = (await request(context, "/api/me/devices")) as { devices?: unknown[] };
      return (Array.isArray(listed.devices) ? listed.devices : []).flatMap((row) => {
        if (typeof row !== "object" || row === null) return [];
        const record = row as Record<string, unknown>;
        if (typeof record.id !== "string") return [];
        return [
          {
            id: record.id,
            workerId: typeof record.worker_id === "string" ? record.worker_id : record.id,
            label: typeof record.label === "string" ? record.label : null,
            platform: typeof record.platform === "string" ? record.platform : null,
            online: record.online === true,
            lastSeenAt: typeof record.last_seen_at === "string" ? record.last_seen_at : null,
            capabilities: Array.isArray(record.capabilities)
              ? record.capabilities.filter((c): c is string => typeof c === "string")
              : [],
          },
        ];
      });
    },
  };
}

export type LobuApi = ReturnType<typeof createLobuApi>;
