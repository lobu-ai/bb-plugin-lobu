// Runs the `lobu` CLI the way the user's terminal would. bb opened from the
// Dock inherits launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), so the CLI's
// `#!/usr/bin/env node` cannot find a Homebrew, nvm, or Bun install of node.
// The plugin therefore runs it with the PATH the user's login shell sets up.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { SetupCode } from "./contract";

const execFileAsync = promisify(execFile);

const SHELL_TIMEOUT_MS = 5_000;
const CLI_TIMEOUT_MS = 20_000;
const MARKER = "__BB_PLUGIN_LOBU_PATH__";

/** Where CLI installers put binaries, kept when the shell cannot be read. */
function wellKnownDirs(home: string): string[] {
  return [join(home, ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

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

/** The PATH between the markers, ignoring whatever the shell's rc files print around it. */
export function pathBetweenMarkers(stdout: string): string | null {
  const parts = stdout.split(MARKER);
  return parts.length >= 3 && parts[1] !== "" ? parts[1] : null;
}

/**
 * PATH from the user's interactive login shell, which reads the same rc files
 * a terminal does (Homebrew sets PATH in .zprofile, Bun and nvm in .zshrc).
 * Null when there is no shell or it fails or hangs.
 */
export async function loginShellPath(shell: string | undefined): Promise<string | null> {
  if (!shell) return null;
  try {
    const pending = execFileAsync(shell, ["-ilc", `printf '%s%s%s' ${MARKER} "$PATH" ${MARKER}`], {
      timeout: SHELL_TIMEOUT_MS,
      env: { ...process.env, DISABLE_AUTO_UPDATE: "true" },
    });
    // An rc file that prompts would otherwise wait on stdin until the timeout.
    pending.child.stdin?.end();
    return pathBetweenMarkers((await pending).stdout);
  } catch {
    return null;
  }
}

/** The shell's PATH, then the inherited one, then installer defaults; each directory once. */
export function mergePath(shellPath: string | null, inheritedPath: string | undefined, home: string): string[] {
  const dirs = [...(shellPath ?? "").split(delimiter), ...(inheritedPath ?? "").split(delimiter), ...wellKnownDirs(home)];
  return [...new Set(dirs.filter((dir) => dir !== ""))];
}

/** The CLI binary: the configured path, else Bun's global bin, else the first `lobu` on the merged PATH. */
export function resolveLobuBin(configured: string, pathDirs: string[], home: string): string {
  if (configured !== "") return configured;
  for (const dir of [join(home, ".bun", "bin"), ...pathDirs]) {
    const candidate = join(dir, "lobu");
    if (existsSync(candidate)) return candidate;
  }
  return "lobu";
}

function lastLine(text: unknown): string {
  return typeof text === "string" ? (text.trim().split("\n").pop()?.trim() ?? "") : "";
}

/**
 * Turns a failed CLI run into setup steps from its exit status: a missing
 * binary, a CLI that could not run (126/127 from the shell or `env`, a signal,
 * a timeout, or an unexpected status), or `lobu token`'s exit 1 for no usable login.
 */
export function cliFailure(error: unknown, context: string | null): LobuSetupError {
  const failure = error as { code?: unknown; killed?: boolean; signal?: unknown; stderr?: unknown };
  if (failure.code === "ENOENT") return new LobuSetupError("cli_missing", context, "The lobu CLI is not installed.");
  if (failure.code === 1) {
    const label = context ?? "the active context";
    return new LobuSetupError("not_logged_in", context, `The lobu CLI has no login for ${label}.`);
  }
  const detail = failure.killed
    ? `it did not answer within ${CLI_TIMEOUT_MS / 1000} seconds`
    : lastLine(failure.stderr) || `it exited with ${String(failure.signal ?? failure.code)}`;
  return new LobuSetupError("cli_failed", context, `bb could not run the lobu CLI: ${detail}`);
}

/** Runs CLI commands with the login shell's PATH, read once per runner. */
export function createCliRunner(lobuBin: string) {
  const home = homedir();
  let prepared: Promise<{ bin: string; env: NodeJS.ProcessEnv }> | null = null;
  const prepare = () => {
    prepared ??= loginShellPath(process.env.SHELL).then((shellPath) => {
      const dirs = mergePath(shellPath, process.env.PATH, home);
      return { bin: resolveLobuBin(lobuBin, dirs, home), env: { ...process.env, PATH: dirs.join(delimiter) } };
    });
    return prepared;
  };
  return async function run(args: string[]): Promise<string> {
    const { bin, env } = await prepare();
    const { stdout } = await execFileAsync(bin, args, { env, timeout: CLI_TIMEOUT_MS });
    return stdout;
  };
}
