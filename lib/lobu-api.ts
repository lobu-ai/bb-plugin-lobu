// Talks to Lobu with the user's existing `lobu` CLI login. Tokens stay in the
// plugin server process and are never sent to the page.
import { z } from "zod";
import { cliFailure, createCliRunner, LobuSetupError } from "./cli";

/** How long a `lobu whoami` session is reused before asking the CLI again. */
const SESSION_TTL_MS = 5 * 60_000;
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

/** Lobu origins the plugin talks to: HTTPS, or HTTP on this machine. */
export function lobuOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback) ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function createLobuApi({ baseUrl }: LobuApiOptions) {
  const cli = createCliRunner();
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

  async function request(context: string | null, path: string, body?: unknown): Promise<unknown> {
    // A 401 means the cached token expired; mint a fresh one once.
    for (const fresh of [false, true]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${(await session(context, fresh)).token}`,
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
  };
}

export type LobuApi = ReturnType<typeof createLobuApi>;
