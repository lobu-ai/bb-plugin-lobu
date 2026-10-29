import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWhoami } from "../lib/lobu-api";
import { LOCAL_PORT, localFolders, localPort, startLocal } from "../lib/local";

const whoami = (fields: Record<string, unknown>) =>
  JSON.stringify({ loggedIn: true, local: false, organizations: [{ slug: "me", name: "Me" }, { slug: "team" }], personalOrgSlug: "me", ...fields });

describe("parseWhoami", () => {
  test("a Lobu on this machine uses the worker token its lobu run minted", () => {
    const session = parseWhoami(whoami({ local: true, accessToken: "session", workerToken: "worker", email: "a@example.com" }));
    expect(session).toEqual({
      account: "a@example.com",
      token: "worker",
      workspaces: [
        { slug: "me", name: "Me", personal: true },
        { slug: "team", name: "team", personal: false },
      ],
    });
  });

  test("a login with no personal workspace saves to its own, as in the Mac app", () => {
    const session = parseWhoami(
      JSON.stringify({ loggedIn: true, local: true, workerToken: "worker", orgSlug: "local-install", organizations: [] }),
    );
    expect(session?.workspaces).toEqual([{ slug: "local-install", name: "local-install", personal: true }]);
  });

  test("a remote Lobu uses the session's access token", () => {
    expect(parseWhoami(whoami({ accessToken: "session", workerToken: "worker" }))?.token).toBe("session");
  });

  test("a signed-out login has no token", () => {
    expect(parseWhoami(whoami({ loggedIn: false, accessToken: "stale" }))?.token).toBeNull();
  });

  test("output that is not whoami JSON reads as null", () => {
    expect(parseWhoami("Signed in as someone")).toBeNull();
    expect(parseWhoami(JSON.stringify({ loggedIn: true }))).toBeNull();
  });
});

describe("localPort", () => {
  test("follows the local context's port on this machine", () => {
    expect(localPort("http://localhost:8795")).toBe(8795);
    expect(localPort("http://127.0.0.1:9000")).toBe(9000);
  });

  test("falls back to the Mac app's default", () => {
    expect(localPort(null)).toBe(LOCAL_PORT);
    expect(localPort("https://lobu.example.com")).toBe(LOCAL_PORT);
  });
});

describe("startLocal", () => {
  let home: string;
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("leaves the Mac app's local Lobu to the Mac app", async () => {
    home = mkdtempSync(join(tmpdir(), "lobu-local-"));
    const folders = localFolders(home);
    mkdirSync(join(folders.macApp, "data"), { recursive: true });
    const serve = () => Promise.reject(new Error("must not start"));
    await expect(startLocal({ serve }, folders, LOCAL_PORT)).rejects.toThrow("Open the Lobu app");
    expect(existsSync(folders.bb)).toBe(false);
  });

  test("creates bb's project with a private key once, then runs lobu run in it", async () => {
    home = mkdtempSync(join(tmpdir(), "lobu-local-"));
    const folders = localFolders(home);
    const runs: { args: string[]; cwd: string; env: Record<string, string> }[] = [];
    const serve = async (args: string[], options: { cwd: string; env: Record<string, string> }) => {
      runs.push({ args, cwd: options.cwd, env: options.env });
      return {} as never;
    };
    await startLocal({ serve }, folders, 8795);
    const env = join(folders.bb, ".env");
    const key = readFileSync(env, "utf8");
    expect(key).toMatch(/^ENCRYPTION_KEY=[0-9a-f]{64}\n$/);
    expect(statSync(env).mode & 0o777).toBe(0o600);
    await startLocal({ serve }, folders, 8795);
    expect(readFileSync(env, "utf8")).toBe(key);
    expect(runs[0]).toEqual({
      args: ["run", "--port", "8795"],
      cwd: folders.bb,
      env: { DATABASE_URL: `file://${join(folders.bb, "data")}`, HOST: "127.0.0.1", LOBU_CONTEXT: "local" },
    });
  });
});
