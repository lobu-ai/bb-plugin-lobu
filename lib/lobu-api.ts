// Talks to Lobu with the user's existing `lobu` CLI login. Tokens stay in the
// plugin server process and are never sent to the page.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
    /** Workspaces the login for this CLI context is authorized for. */
    async workspaces(context: string | null): Promise<Workspace[]> {
      const info = (await request(context, "/oauth/userinfo")) as {
        organizations?: { slug: string; name?: string }[];
      };
      return (info.organizations ?? []).map((org) => ({ slug: org.slug, name: org.name ?? org.slug }));
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
