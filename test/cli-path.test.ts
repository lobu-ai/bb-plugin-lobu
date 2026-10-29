import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliFailure, cliMajor, findInstaller, firstUrl, loginShellPath, mergePath, pathBetweenMarkers } from "../lib/cli";
import { createLobuApi } from "../lib/lobu-api";

// bb opened from the Dock runs plugins with launchd's PATH, while the CLI's
// `#!/usr/bin/env node` needs the node the user's shell finds. These fakes
// reproduce that: `lobu` needs an interpreter only the login shell's PATH has.
const WHOAMI = JSON.stringify({
  loggedIn: true,
  local: false,
  accessToken: "synthetic-token-0123456789abcdef",
  personalOrgSlug: "acme",
  organizations: [{ slug: "acme", name: "Acme" }],
});
const MINIMAL_PATH = "/usr/bin:/bin";

let root: string;
const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL };

function script(path: string, body: string) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lobu-cli-path-"));
  const shellOnly = join(root, "shell-only");
  mkdirSync(shellOnly);
  script(join(shellOnly, "fake-node"), `#!/bin/sh\nprintf '%s\\n' '${WHOAMI}'\n`);
  script(join(root, "lobu"), "#!/usr/bin/env fake-node\n");
  script(join(root, "lobu-broken"), "#!/usr/bin/env missing-interpreter\n");
  // A login shell whose rc files print noise and add a directory to PATH.
  script(
    join(root, "login-shell"),
    `#!/bin/sh\necho "rc file noise"\nPATH="${shellOnly}:${MINIMAL_PATH}"\nexport PATH\nshift\nexec /bin/sh -c "$1"\n`,
  );
});

afterEach(() => {
  process.env.PATH = saved.PATH;
  process.env.SHELL = saved.SHELL;
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("running the lobu CLI from a Dock-launched bb", () => {
  test("finds the CLI's interpreter on the login shell's PATH", async () => {
    process.env.PATH = MINIMAL_PATH;
    process.env.SHELL = join(root, "login-shell");
    const api = createLobuApi({ baseUrl: "https://lobu.example.com", lobuBin: join(root, "lobu") });
    expect(await api.workspaces(null)).toEqual([{ slug: "acme", name: "Acme", personal: true }]);
  });

  test("reports a CLI that cannot start, not a missing login", async () => {
    process.env.PATH = MINIMAL_PATH;
    process.env.SHELL = join(root, "login-shell");
    const api = createLobuApi({ baseUrl: "https://lobu.example.com", lobuBin: join(root, "lobu-broken") });
    const failure = await api.workspaces(null).then(
      () => null,
      (error: unknown) => error as { code?: string; message?: string },
    );
    expect(failure?.code).toBe("cli_failed");
    expect(failure?.message).toContain("missing-interpreter");
  });
});

describe("reading the login shell's PATH", () => {
  test("takes only the text between the markers", () => {
    expect(pathBetweenMarkers("rc noise\n__BB_PLUGIN_LOBU_PATH__/a:/b__BB_PLUGIN_LOBU_PATH__trailing")).toBe("/a:/b");
    expect(pathBetweenMarkers("no markers at all")).toBeNull();
    expect(pathBetweenMarkers("__BB_PLUGIN_LOBU_PATH____BB_PLUGIN_LOBU_PATH__")).toBeNull();
  });

  test("returns null when the shell is missing or fails", async () => {
    expect(await loginShellPath(undefined)).toBeNull();
    expect(await loginShellPath(join(root, "no-such-shell"))).toBeNull();
  });

  test("merges the shell's PATH first, then the inherited one, then installer defaults", () => {
    expect(mergePath("/shell:/usr/bin", "/usr/bin:/bin", "/home/u")).toEqual([
      "/shell",
      "/usr/bin",
      "/bin",
      "/home/u/.bun/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]);
    expect(mergePath(null, undefined, "/home/u")).toEqual(["/home/u/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin"]);
  });
});

describe("classifying a failed CLI run", () => {
  test("a missing binary asks to install the CLI", () => {
    expect(cliFailure({ code: "ENOENT" }, null).code).toBe("cli_missing");
  });

  test("lobu token's exit 1 means no usable login", () => {
    const failure = cliFailure({ code: 1, stderr: "Not logged in. Run `lobu login` first." }, "work");
    expect(failure.code).toBe("not_logged_in");
    expect(failure.message).toBe("The lobu CLI has no login for work.");
  });

  test("a CLI that cannot start shows the CLI's own error", () => {
    const failure = cliFailure({ code: 127, stderr: "env: node: No such file or directory\n" }, null);
    expect(failure.code).toBe("cli_failed");
    expect(failure.message).toBe("bb could not run the lobu CLI: env: node: No such file or directory");
  });

  test("a hung CLI is a CLI failure", () => {
    const failure = cliFailure({ code: null, killed: true, signal: "SIGTERM" }, null);
    expect(failure.code).toBe("cli_failed");
    expect(failure.message).toContain("did not answer");
  });
});

describe("firstUrl", () => {
  test("finds the approval URL lobu login prints on its own line", () => {
    const output = "\n  Open this URL to approve the login:\n  https://lobu.example/oauth/device?user_code=ABCD-EFGH\n  Code: ABCD-EFGH\n";
    expect(firstUrl(output)).toBe("https://lobu.example/oauth/device?user_code=ABCD-EFGH");
  });

  test("ignores prose and other schemes", () => {
    expect(firstUrl("Open this URL to approve the login:\njavascript:alert(1)\n")).toBeNull();
    expect(firstUrl("")).toBeNull();
  });
});

describe("installing the CLI", () => {
  const dirsWith = (tools: string[]) => {
    const root = mkdtempSync(join(tmpdir(), "lobu-installer-"));
    const dirs = tools.map((tool, index) => {
      const dir = join(root, `d${index}`);
      mkdirSync(dir);
      writeFileSync(join(dir, tool), "");
      return dir;
    });
    return { root, dirs };
  };

  test("prefers bun anywhere on the PATH over npm", () => {
    const { root, dirs } = dirsWith(["npm", "bun"]);
    try {
      const installer = findInstaller(dirs);
      expect(installer?.bin).toBe(join(dirs[1]!, "bun"));
      expect(installer?.command).toBe("bun add -g @lobu/cli@^24");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("falls back to npm, then to nothing", () => {
    const { root, dirs } = dirsWith(["npm"]);
    try {
      expect(findInstaller(dirs)?.command).toBe("npm install -g @lobu/cli@^24");
      expect(findInstaller([join(root, "empty")])).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads the major version lobu --version prints", () => {
    expect(cliMajor("24.2.0\n")).toBe(24);
    expect(cliMajor("warning: something\n23.0.0")).toBe(23);
    expect(cliMajor("lobu")).toBeNull();
    expect(cliMajor("")).toBeNull();
  });
});
