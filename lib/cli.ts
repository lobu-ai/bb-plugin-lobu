// Runs the `lobu` CLI the way the user's terminal would. bb opened from the
// Dock inherits launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), so the CLI's
// `#!/usr/bin/env node` cannot find a Homebrew, nvm, or Bun install of node.
// The plugin therefore runs it with the PATH the user's login shell sets up.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SHELL_TIMEOUT_MS = 5_000;
const CLI_TIMEOUT_MS = 20_000;
/** How long `lobu login` may take to print its approval URL. */
const APPROVAL_URL_WAIT_MS = 15_000;
/** A global package install downloads the CLI and its dependencies. */
const INSTALL_TIMEOUT_MS = 180_000;
/** The CLI major the plugin is built against: `context list --json` arrived in 24. */
export const CLI_MAJOR = 24;
const CLI_PACKAGE = `@lobu/cli@^${CLI_MAJOR}`;
const MARKER = "__BB_PLUGIN_LOBU_PATH__";

/**
 * The user's home directory: HOME first, as Node's os.homedir() does. Bun's
 * homedir() ignores a HOME set after startup, which tests rely on to keep the
 * plugin away from the real CLI.
 */
export function userHome(): string {
  return process.env.HOME || homedir();
}

/** Where CLI installers put binaries, kept when the shell cannot be read. */
function wellKnownDirs(home: string): string[] {
  return [join(home, ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

export type SetupCode = "cli_missing" | "cli_failed" | "not_logged_in";

/** Lobu cannot be reached through the CLI login. */
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

/** The CLI binary: Bun's global bin, else the first `lobu` on the merged PATH. */
export function resolveLobuBin(pathDirs: string[], home: string): string {
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

/** A package manager on the user's PATH that can install the CLI globally. */
export interface Installer {
  bin: string;
  args: string[];
  /** The same install, as the user would type it. */
  command: string;
}

const INSTALL_ARGS = { bun: ["add", "-g", CLI_PACKAGE], npm: ["install", "-g", CLI_PACKAGE] } as const;

/** The install as typed, for when no package manager is found or the button fails. */
export const FALLBACK_INSTALL = `npm install -g ${CLI_PACKAGE}`;

/** Bun when it is anywhere on the PATH, else npm; null with neither. */
export function findInstaller(dirs: string[]): Installer | null {
  for (const tool of ["bun", "npm"] as const) {
    for (const dir of dirs) {
      const bin = join(dir, tool);
      if (existsSync(bin)) return { bin, args: [...INSTALL_ARGS[tool]], command: `${tool} ${INSTALL_ARGS[tool].join(" ")}` };
    }
  }
  return null;
}

/** The major version from `lobu --version` output such as "24.2.0"; null when it is not one. */
export function cliMajor(output: string): number | null {
  const major = Number(output.trim().split("\n").pop()?.trim().split(".")[0]);
  return Number.isInteger(major) && major > 0 ? major : null;
}

export type CliState =
  | { state: "missing" }
  | { state: "broken"; detail: string }
  | { state: "outdated"; version: string }
  | { state: "ready"; version: string };

/** The first line of CLI output that is a whole http(s) URL, such as `lobu login`'s approval page. */
export function firstUrl(output: string): string | null {
  for (const line of output.split("\n")) {
    try {
      const url = new URL(line.trim());
      if (url.protocol === "https:" || url.protocol === "http:") return url.href;
    } catch {
      // Not a URL line.
    }
  }
  return null;
}

/** Runs CLI commands with the login shell's PATH, read once per runner. */
export function createCliRunner() {
  const home = userHome();
  let prepared: Promise<{ bin: string; dirs: string[]; env: NodeJS.ProcessEnv }> | null = null;
  const prepare = () => {
    prepared ??= loginShellPath(process.env.SHELL).then((shellPath) => {
      const dirs = mergePath(shellPath, process.env.PATH, home);
      return { bin: resolveLobuBin(dirs, home), dirs, env: { ...process.env, PATH: dirs.join(delimiter) } };
    });
    return prepared;
  };
  async function run(args: string[]): Promise<string> {
    const { bin, env } = await prepare();
    const { stdout } = await execFileAsync(bin, args, { env, timeout: CLI_TIMEOUT_MS });
    return stdout;
  }
  return {
    run,

    /** Whether the CLI is installed, starts, and is new enough. */
    async state(): Promise<CliState> {
      let output: string;
      try {
        output = await run(["--version"]);
      } catch (error) {
        const failure = cliFailure(error, null);
        return failure.code === "cli_missing" ? { state: "missing" } : { state: "broken", detail: failure.message };
      }
      const version = output.trim().split("\n").pop()?.trim() ?? "";
      const major = cliMajor(output);
      if (major === null) return { state: "broken", detail: `lobu --version printed "${version}"` };
      return major < CLI_MAJOR ? { state: "outdated", version } : { state: "ready", version };
    },

    async installer(): Promise<Installer | null> {
      return findInstaller((await prepare()).dirs);
    },

    /** Installs or updates the CLI with bun or npm, never with sudo, then finds it again. */
    async install(): Promise<void> {
      const { dirs, env } = await prepare();
      const installer = findInstaller(dirs);
      if (installer === null) throw new Error("Neither bun nor npm is on your PATH.");
      try {
        await execFileAsync(installer.bin, installer.args, { env, timeout: INSTALL_TIMEOUT_MS });
      } catch (error) {
        const failure = error as { killed?: boolean; stderr?: unknown; stdout?: unknown };
        if (failure.killed) throw new Error(`${installer.command} did not finish within ${INSTALL_TIMEOUT_MS / 60_000} minutes.`);
        throw new Error(lastLine(failure.stderr) || lastLine(failure.stdout) || `${installer.command} failed.`);
      } finally {
        // The binary may now live somewhere the cached lookup did not find it.
        prepared = null;
      }
    },

    /**
     * Starts a long-running command, like `lobu run`, in `cwd` with extra
     * environment variables, appending its output to `logFile`.
     */
    async serve(args: string[], options: { cwd: string; env: Record<string, string>; logFile: string }): Promise<ChildProcess> {
      const { bin, env } = await prepare();
      const log = openSync(options.logFile, "a");
      try {
        return spawn(bin, args, { cwd: options.cwd, env: { ...env, ...options.env }, stdio: ["ignore", log, log] });
      } finally {
        closeSync(log);
      }
    },

    /**
     * Starts a command that keeps running, like `lobu login` waiting for
     * browser approval, and resolves with the first URL it prints (null if it
     * prints none in time). The CLI bounds its own wait; a failure before any
     * URL rejects with its last line of output.
     */
    async start(args: string[]): Promise<string | null> {
      const { bin, env } = await prepare();
      const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      child.unref();
      let output = "";
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(null), APPROVAL_URL_WAIT_MS);
        const read = (chunk: Buffer) => {
          output += chunk.toString();
          const url = firstUrl(output);
          if (url === null) return;
          clearTimeout(timer);
          resolve(url);
        };
        child.stdout.on("data", read);
        child.stderr.on("data", read);
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(cliFailure(error, null));
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(firstUrl(output));
          else reject(new Error(lastLine(output) || `lobu ${args[0]} exited with ${String(code)}`));
        });
      });
    },
  };
}
