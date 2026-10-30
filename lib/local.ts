// Runs Lobu on this machine the way the Lobu Mac app does: `lobu run` under
// the `local` CLI context, reachable only from this machine. `lobu run` signs
// that context in by itself. Lobu encrypts stored secrets with the project's
// ENCRYPTION_KEY: bb's own project keeps it in its `.env`, which `lobu run`
// reads, while the Mac app's project (~/lobu) keeps it in the macOS Keychain,
// so bb only ever starts its own.
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LobuApi } from "./lobu-api";

/** The CLI context a Lobu on this machine signs in to, as in the Mac app. */
export const LOCAL_CONTEXT = "local";
/** The port the Mac app gives a new local Lobu. */
export const LOCAL_PORT = 8787;
const HEALTH_TIMEOUT_MS = 2_000;

export interface LocalFolders {
  /** bb's own project. */
  bb: string;
  /** The Mac app's project. */
  macApp: string;
}

export function localFolders(home: string): LocalFolders {
  return { bb: join(home, "lobu-bb"), macApp: join(home, "lobu") };
}

/** The port of the `local` context's URL when it is on this machine, else the Mac app's default. */
export function localPort(contextOrigin: string | null): number {
  if (contextOrigin === null) return LOCAL_PORT;
  const url = new URL(contextOrigin);
  const port = Number(url.port);
  return ["localhost", "127.0.0.1"].includes(url.hostname) && port > 0 ? port : LOCAL_PORT;
}

export async function isServing(origin: string): Promise<boolean> {
  try {
    return (await fetch(`${origin}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })).ok;
  } catch {
    return false;
  }
}

/** Whether bb has set up its own project here before. */
export const hasProject = (folders: LocalFolders) => existsSync(join(folders.bb, ".env"));

/**
 * Starts `lobu run` in bb's project, creating the project with a new
 * ENCRYPTION_KEY the first time. Throws when the only local Lobu here is the
 * Mac app's, which only the Mac app can start.
 */
export async function startLocal(
  api: Pick<LobuApi, "serve">,
  folders: LocalFolders,
  port: number,
): Promise<ChildProcess> {
  if (!hasProject(folders)) {
    if (existsSync(join(folders.macApp, "data"))) {
      throw new Error("Your Lobu on this machine belongs to the Lobu app. Open the Lobu app to start it, then try again.");
    }
    mkdirSync(folders.bb, { recursive: true });
    writeFileSync(join(folders.bb, ".env"), `ENCRYPTION_KEY=${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  }
  return api.serve(["run", "--port", String(port)], {
    cwd: folders.bb,
    env: { DATABASE_URL: `file://${join(folders.bb, "data")}`, HOST: "127.0.0.1", LOBU_CONTEXT: LOCAL_CONTEXT },
    logFile: logFile(folders),
  });
}

export const logFile = (folders: LocalFolders) => join(folders.bb, "lobu.log");

/** The last line `lobu run` logged, to explain why it stopped. */
export function lastLogLine(folders: LocalFolders): string {
  try {
    return readFileSync(logFile(folders), "utf8").trim().split("\n").pop()?.trim() ?? "";
  } catch {
    return "";
  }
}
