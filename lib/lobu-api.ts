// Talks to Lobu with the user's existing `lobu` CLI login. Tokens stay in the
// plugin server process and are never sent to the page.
import { z } from "zod";
import { cliFailure, createCliRunner, LobuSetupError } from "./cli";

/** How long a minted token is reused before asking the CLI again. */
const TOKEN_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

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
}

export interface SavedMemory {
  id: number;
  viewUrl: string | null;
}

export interface LobuApiOptions {
  baseUrl: string;
  lobuBin: string;
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

/** Contexts with a login on this Lobu, the active one first. */
export function contextsForLobu(listed: unknown, baseUrl: string): string[] {
  const origin = originOf(baseUrl);
  return parseCliContexts(listed)
    .filter((context) => context.loggedIn && context.origin === origin)
    .map((context) => context.name);
}

/** Lobu origins the embedded app may load: HTTPS, or HTTP on this machine. */
export function embeddableOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback) ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function createLobuApi({ baseUrl, lobuBin }: LobuApiOptions) {
  const runLobu = createCliRunner(lobuBin);
  const tokens = new Map<string, { value: string; mintedAt: number }>();
  const contextLabel = (context: string | null) => context ?? "the active context";

  async function token(context: string | null, fresh: boolean): Promise<string> {
    const key = context ?? "";
    const hit = tokens.get(key);
    if (!fresh && hit && Date.now() - hit.mintedAt < TOKEN_TTL_MS) return hit.value;
    const args = ["token", "--raw", ...(context === null ? [] : ["--context", context])];
    let stdout: string;
    try {
      stdout = await runLobu(args);
    } catch (error) {
      throw cliFailure(error, context);
    }
    const value = stdout.trim().split("\n").pop()?.trim() ?? "";
    if (value.length < 20) {
      throw new LobuSetupError(
        "not_logged_in",
        context,
        `The lobu CLI has no login for ${contextLabel(context)}.`,
      );
    }
    tokens.set(key, { value, mintedAt: Date.now() });
    return value;
  }

  async function request(context: string | null, path: string, body?: unknown): Promise<unknown> {
    // A 401 means the cached token expired; mint a fresh one once.
    for (const fresh of [false, true]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${await token(context, fresh)}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

  return {
    /**
     * Every CLI login on this Lobu, so each workspace the user authorized
     * appears without configuration. Null when the CLI cannot list them
     * (missing, or older than `context list --json`); callers then use the
     * active context.
     */
    async contexts(): Promise<string[] | null> {
      try {
        const names = contextsForLobu(JSON.parse(await runLobu(["context", "list", "--json"])), baseUrl);
        return names.length === 0 ? null : names;
      } catch {
        return null;
      }
    },

    /** Every CLI context for the context picker; null when the CLI cannot list them as JSON. */
    async cliContexts(): Promise<CliContext[] | null> {
      try {
        const listed = parseCliContexts(JSON.parse(await runLobu(["context", "list", "--json"])));
        return listed.length === 0 ? null : listed;
      } catch {
        return null;
      }
    },

    /**
     * A Lobu web session for this CLI login, minted by the route Lobu's own
     * extension and Mac app use. The page gets this session, never the CLI token.
     */
    async webSession(context: string | null, origin: string): Promise<string> {
      for (const fresh of [false, true]) {
        const response = await fetch(`${origin}/api/extension-session`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: await token(context, fresh) }).toString(),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.status === 401 && !fresh) continue;
        const body = (await response.json().catch(() => null)) as {
          session_token?: unknown;
          error_description?: unknown;
        } | null;
        if (response.ok && typeof body?.session_token === "string") return body.session_token;
        const detail = typeof body?.error_description === "string" ? `: ${body.error_description}` : "";
        if (response.status === 401 || response.status === 403) {
          throw new LobuSetupError("not_logged_in", context, `Lobu would not open the app for ${contextLabel(context)}${detail}.`);
        }
        throw new Error(`Lobu returned ${response.status} when opening the app${detail}.`);
      }
      throw new Error("unreachable");
    },

    /** Workspaces the login for this CLI context is authorized for. */
    async workspaces(context: string | null): Promise<Workspace[]> {
      const info = (await request(context, "/oauth/userinfo")) as {
        organizations?: { slug: string; name?: string; personal?: boolean }[];
      };
      return (info.organizations ?? []).map((org) => ({
        slug: org.slug,
        name: org.name ?? org.slug,
        personal: org.personal === true,
      }));
    },

    /** Saves one memory with Lobu's save_memory tool; returns the saved event. */
    async saveMemory(context: string | null, workspace: string, memory: SaveMemoryInput): Promise<SavedMemory> {
      const saved = (await request(context, `/api/${encodeURIComponent(workspace)}/save_memory`, memory)) as {
        id?: number;
        view_url?: string;
        error?: string | { message?: string };
      };
      if (typeof saved.id !== "number") {
        const error = typeof saved.error === "string" ? saved.error : saved.error?.message;
        throw new Error(error ?? "save_memory returned no event");
      }
      return { id: saved.id, viewUrl: saved.view_url ?? null };
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

    /** Runs a read-only script in one workspace and returns its value. */
    async querySdk(context: string | null, workspace: string, title: string, script: string): Promise<unknown> {
      const result = (await request(context, `/api/${encodeURIComponent(workspace)}/query_sdk`, {
        title,
        script,
      })) as { success?: boolean; return_value?: unknown; error?: { message?: string } };
      if (result.success !== true) throw new Error(result.error?.message ?? "query_sdk failed");
      return result.return_value;
    },
  };
}

export type LobuApi = ReturnType<typeof createLobuApi>;
