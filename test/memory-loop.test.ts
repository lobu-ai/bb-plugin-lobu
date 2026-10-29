import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../server";

// Runs the real plugin server against a fake bb host, a fake `lobu` CLI, and a
// fake Lobu that stores memories in memory. All identifiers are synthetic.
const TOKEN = "synthetic-token-0123456789abcdef";

interface StoredMemory {
  id: number;
  workspace: string;
  title: string;
  content: string;
  kind: string;
  deleted: boolean;
}

const lobu = {
  memories: [] as StoredMemory[],
  searches: [] as { workspace: string; query: string }[],
  nextId: 1000,
};

const words = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
function similarity(query: string, memory: StoredMemory): number {
  if (query === `${memory.title}\n${memory.content}`) return 0.99;
  const a = words(query);
  const b = words(`${memory.title} ${memory.content}`);
  const shared = [...a].filter((w) => b.has(w)).length;
  return shared === 0 ? 0 : shared / Math.max(a.size, 1) / 2;
}

let server: ReturnType<typeof Bun.serve>;
const saved = { SHELL: process.env.SHELL, HOME: process.env.HOME, PATH: process.env.PATH };
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lobu-memory-loop-"));
  // The plugin finds the fake `lobu` first on PATH; HOME keeps it from ~/.bun/bin.
  process.env.SHELL = join(root, "no-shell");
  process.env.HOME = root;
  process.env.PATH = `${root}:${saved.PATH}`;
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("no", { status: 401 });
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/api\/([^/]+)\/([a-z_]+)$/);
      if (match === null) return new Response("not found", { status: 404 });
      const [, workspace, tool] = match as unknown as [string, string, string];
      const body = (await request.json()) as Record<string, unknown>;
      if (tool === "save_memory") {
        const id = lobu.nextId++;
        lobu.memories.push({
          id,
          workspace,
          title: String(body.title),
          content: String(body.content),
          kind: String(body.semantic_type),
          deleted: false,
        });
        return Response.json({ id, view_url: `/${workspace}/events/${id}` });
      }
      if (tool === "search_memory") {
        const query = String(body.query);
        lobu.searches.push({ workspace, query });
        const content = lobu.memories
          .filter((m) => m.workspace === workspace && !m.deleted)
          .map((m) => ({ m, score: similarity(query, m) }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, Number(body.limit))
          .map(({ m, score }) => ({
            id: m.id,
            title: m.title,
            text_content: m.content,
            similarity: score,
            occurred_at: "2026-10-01T00:00:00.000Z",
            platform: "lobu",
            workspace_slug: m.workspace,
          }));
        return Response.json({ content });
      }
      if (tool === "run_sdk") {
        const ids = JSON.parse(String(body.script).match(/delete\((\{.*\})\)/)?.[1] ?? "{}").content_ids as number[];
        for (const m of lobu.memories) if (ids.includes(m.id) && m.workspace === workspace) m.deleted = true;
        return Response.json({ success: true, return_value: { deleted_ids: ids, already_superseded_ids: [] } });
      }
      return new Response("unknown tool", { status: 404 });
    },
  });
});

beforeAll(() => {
  // A CLI 24 with one context, logged in to the fake Lobu.
  const contexts = JSON.stringify({
    current: "work",
    contexts: [{ name: "work", url: `http://localhost:${server.port}/api/v1`, current: true, loggedIn: true }],
  });
  const whoami = JSON.stringify({
    loggedIn: true,
    context: "work",
    apiUrl: `http://localhost:${server.port}/api/v1`,
    local: true,
    email: "someone@example.com",
    hasAccessToken: true,
    accessToken: "synthetic-session-token",
    hasWorkerToken: true,
    workerToken: TOKEN,
    personalOrgSlug: "me",
    organizations: [
      { slug: "me", name: "Me" },
      { slug: "team", name: "Team" },
    ],
  });
  const cli = join(root, "lobu");
  writeFileSync(
    cli,
    [
      "#!/bin/sh",
      `if [ "$1" = whoami ]; then echo '${whoami}'; exit 0; fi`,
      'if [ "$1" = --version ]; then echo 24.2.0; exit 0; fi',
      `if [ "$1" = context ] && [ "$2" = list ]; then echo '${contexts}'; exit 0; fi`,
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(cli, 0o755);
});

afterAll(() => {
  Object.assign(process.env, saved);
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

type Tool = { execute: (params: unknown, ctx: { threadId: string; projectId: string; signal: AbortSignal }) => Promise<unknown> };

async function startPlugin(overrides: Record<string, unknown> = {}) {
  const kv = new Map<string, unknown>();
  const tools = new Map<string, Tool>();
  let instructions: ((ctx: { threadId: string; projectId: string }) => string | null) | null = null;
  let rpc: Record<string, (input: unknown) => unknown> = {};
  const formRequests: unknown[] = [];
  const values = { autoSave: true, recapOnArchive: false, ...overrides };
  const bb = {
    pluginId: "lobu",
    settings: {
      define: () => ({
        get: async () => values,
        experimental_set: async (next: Record<string, unknown>) => Object.assign(values, next),
        onChange: () => undefined,
      }),
    },
    storage: {
      kv: {
        get: async (key: string) => kv.get(key),
        set: async (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
      },
    },
    sdk: {
      projects: { list: async () => [{ id: "proj-1", name: "Acme app" }] },
      threads: {
        get: async () => ({ projectId: "proj-1" }),
        list: async () => [],
        getPluginMetadata: async () => ({}),
      },
    },
    events: { on: () => undefined },
    agents: {
      registerTool: (tool: Tool & { name: string }) => void tools.set(tool.name, tool),
      contributeInstructions: (provider: typeof instructions) => {
        instructions = provider;
      },
    },
    rpc: {
      register: (_contract: unknown, handlers: typeof rpc) => {
        rpc = handlers;
      },
    },
    ui: {
      requestInput: async (request: unknown) => {
        formRequests.push(request);
        return { outcome: "cancelled", reason: "user" };
      },
    },
    log: { info: () => undefined, warn: () => undefined },
    onDispose: () => undefined,
  };
  await plugin(bb as unknown as BbPluginApi);
  // Let the startup project listing settle.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const call = (name: string, params: unknown, threadId = "thread-1") =>
    tools.get(name)!.execute(params, { threadId, projectId: "proj-1", signal: new AbortController().signal });
  return { kv, rpc, call, formRequests, brief: (threadId: string) => instructions!({ threadId, projectId: "proj-1" }) };
}

const deployGotcha = {
  title: "Staging deploys need the VPN",
  content: "Deploys to staging time out unless the office VPN is connected.",
  kind: "fact",
  evidence: "Agent: the deploy timed out until the VPN was on",
  workspace: "team",
};
const prPreference = {
  title: "Keep PR descriptions short",
  content: "The user wants PR descriptions under ten lines.",
  kind: "preference",
  evidence: "User: keep PR descriptions short from now on",
};

describe("the memory loop", () => {
  test("saves, dedupes, briefs, counts uses, links, pins notes, and undoes", async () => {
    const { rpc, call, brief } = await startPlugin();
    expect(brief("thread-0")).toBeNull();

    // Auto-save goes to the personal workspace.
    const saved = String(await call("lobu_remember", { memories: [deployGotcha, prPreference] }));
    expect(saved).toContain("Saved to the user's personal Lobu workspace (me)");
    expect(lobu.memories.filter((m) => m.workspace === "me")).toHaveLength(2);

    // The same memories again are recognised as already in Lobu.
    const again = String(await call("lobu_remember", { memories: [deployGotcha] }, "thread-2"));
    expect(again).toContain("Already in Lobu, so not saved again");
    expect(lobu.memories).toHaveLength(2);

    const savedIn = async (threadId: string) =>
      ((await rpc.threadMemory!({ threadId })) as {
        saved: { eventId: number; title: string; projectId: string | null; uses: number }[];
      }).saved;
    const overview = { saved: await savedIn("thread-1") };
    expect(overview.saved.map((r) => r.title).sort()).toEqual([deployGotcha.title, prPreference.title].sort());
    expect(overview.saved.every((r) => r.projectId === "proj-1")).toBe(true);

    // A new thread in the project starts with what earlier threads learned.
    const text = brief("thread-3");
    expect(text).toContain("## Lobu memory for Acme app");
    expect(text).toContain("Learned in earlier threads of this project:");
    expect(text).toContain(deployGotcha.title);
    const startLog = (await rpc.threadMemory!({ threadId: "thread-3" })) as { log: { given: unknown[] } };
    expect(startLog.log.given).toHaveLength(2);

    // An agent search is logged on the thread and counted as a use.
    const found = String(await call("lobu_search", { query: "staging deploy vpn" }, "thread-3"));
    expect(found).toContain(deployGotcha.title);
    const afterSearch = { saved: await savedIn("thread-1") };
    expect(afterSearch.saved.find((r) => r.title === deployGotcha.title)?.uses).toBe(1);
    const thread3 = (await rpc.threadMemory!({ threadId: "thread-3" })) as { log: { searches: { query: string }[] } };
    expect(thread3.log.searches.map((s) => s.query)).toEqual(["staging deploy vpn"]);

    // Linking the project makes agent searches include the team workspace.
    await rpc.linkProject!({ projectId: "proj-1", workspace: "team" });
    lobu.searches.length = 0;
    await call("lobu_search", { query: "descriptions" }, "thread-3");
    expect(lobu.searches.map((s) => s.workspace).sort()).toEqual(["me", "team"]);

    // A note is saved to the personal workspace, pinned, and leads the brief.
    const project = (await rpc.addNote!({ projectId: "proj-1", text: "Release notes go in CHANGELOG.md" })) as {
      pins: { title: string }[];
      brief: string;
    };
    expect(project.pins.map((p) => p.title)).toEqual(["Release notes go in CHANGELOG.md"]);
    expect(project.brief.indexOf("Pinned by the user:")).toBeLessThan(project.brief.indexOf("Learned in earlier threads"));
    const fakeLobuNote = lobu.memories.find((m) => m.title === "Release notes go in CHANGELOG.md")!;
    // Lobu's idempotency returns the same memory for the same note; the fake does too.
    const savedCount = lobu.memories.length;
    lobu.nextId = fakeLobuNote.id;
    const repeated = (await rpc.addNote!({ projectId: "proj-1", text: "Release notes go in CHANGELOG.md" })) as { pins: unknown[] };
    lobu.memories.splice(savedCount);
    lobu.nextId = 5000;
    expect(repeated.pins).toHaveLength(1);

    // The New thread screen shows the project in view as a new thread there receives it.
    const home = (await rpc.projectMemory!({ projectId: "proj-1" })) as {
      personal: string;
      project: { name: string; workspace: string; pins: unknown[]; learned: number; brief: string };
    };
    expect(home.personal).toBe("me");
    expect(home.project).toMatchObject({ name: "Acme app", workspace: "team", learned: 2 });
    expect(home.project.pins).toHaveLength(1);
    expect(home.project.brief).toBe(project.brief);
    // A pinned note leads the brief once, not again among what was learned.
    expect(home.project.brief.split("Release notes go in CHANGELOG.md")).toHaveLength(2);

    // Undo hides the memory in Lobu and drops it from the plugin's list.
    const preference = afterSearch.saved.find((r) => r.title === prPreference.title)!;
    await rpc.undoMemory!({ eventId: preference.eventId });
    expect(lobu.memories.find((m) => m.id === preference.eventId)?.deleted).toBe(true);
    const final = { saved: await savedIn("thread-1") };
    expect(final.saved.map((r) => r.eventId)).not.toContain(preference.eventId);

    // The setup check sees the CLI, the login bb uses, and its personal workspace.
    const status = (await rpc.setupStatus!({})) as { cli: { state: string }; login: { context: string; account: string; personal: string; problem: null } };
    expect(status.cli.state).toBe("ready");
    expect(status.login).toMatchObject({ context: "work", account: "someone@example.com", personal: "me", problem: null });
    expect(status).toMatchObject({ starting: false });

    // "Open in Lobu" lands on the events page filtered to what bb saved and has not undone.
    const { url } = (await rpc.savedLink!({})) as { url: string };
    expect(url.startsWith(`http://localhost:${server.port}/me/events?content_ids=`)).toBe(true);
    expect(url).not.toContain(String(preference.eventId));
    expect(url).toContain(String(final.saved.find((r) => r.title === deployGotcha.title)!.eventId));
  });

  test("with auto-save off, memories go through the review form", async () => {
    const { call, formRequests } = await startPlugin({ autoSave: false });
    const before = lobu.memories.length;
    const result = String(await call("lobu_remember", { memories: [prPreference] }, "thread-9"));
    expect(formRequests).toHaveLength(1);
    expect(result).toContain("chose not to save");
    expect(lobu.memories).toHaveLength(before);
  });
});
