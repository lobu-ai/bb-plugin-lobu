// Talks to Lobu with the user's existing `lobu` CLI login. Tokens stay in the
// plugin server process and are never sent to the page.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { SetupCode } from "./contract";

const execFileAsync = promisify(execFile);

/** How long a minted token is reused before asking the CLI again. */
const TOKEN_TTL_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** Lobu cannot be reached at all; the page turns this into setup steps. */
export class LobuSetupError extends Error {
  constructor(
    readonly code: SetupCode,
    readonly context: string | null,
    message: string,
  ) {
    super(message);
  }
}

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

/** The CLI binary: the configured path, else Bun's global bin, else PATH. */
export function resolveLobuBin(configured: string): string {
  if (configured !== "") return configured;
  const bunBin = join(homedir(), ".bun", "bin", "lobu");
  return existsSync(bunBin) ? bunBin : "lobu";
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

/** Contexts with a login on this Lobu, the active one first, from `lobu context list --json`. */
export function contextsForLobu(listed: unknown, baseUrl: string): string[] {
  const parsed = cliContextsSchema.safeParse(listed);
  if (!parsed.success) return [];
  const origin = originOf(baseUrl);
  return parsed.data.contexts
    .filter((context) => context.loggedIn && origin !== null && originOf(context.url) === origin)
    .sort((a, b) => Number(b.current) - Number(a.current))
    .map((context) => context.name);
}

export function createLobuApi({ baseUrl, lobuBin }: LobuApiOptions) {
  const tokens = new Map<string, { value: string; mintedAt: number }>();
  const contextLabel = (context: string | null) => context ?? "the active context";

  async function token(context: string | null, fresh: boolean): Promise<string> {
    const key = context ?? "";
    const hit = tokens.get(key);
    if (!fresh && hit && Date.now() - hit.mintedAt < TOKEN_TTL_MS) return hit.value;
    const args = ["token", "--raw", ...(context === null ? [] : ["--context", context])];
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(resolveLobuBin(lobuBin), args, { timeout: 20_000 }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new LobuSetupError("cli_missing", context, "The lobu CLI is not installed.");
      }
      throw new LobuSetupError(
        "not_logged_in",
        context,
        `The lobu CLI has no login for ${contextLabel(context)}.`,
      );
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
        const { stdout } = await execFileAsync(resolveLobuBin(lobuBin), ["context", "list", "--json"], { timeout: 20_000 });
        const names = contextsForLobu(JSON.parse(stdout), baseUrl);
        return names.length === 0 ? null : names;
      } catch {
        return null;
      }
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
