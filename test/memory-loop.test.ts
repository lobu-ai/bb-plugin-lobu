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
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "lobu-memory-loop-"));
  const cli = join(root, "lobu");
  writeFileSync(cli, `#!/bin/sh\nif [ "$1" = token ]; then echo ${TOKEN}; else exit 1; fi\n`);
  chmodSync(cli, 0o755);
  process.env.SHELL = join(root, "no-shell");
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("no", { status: 401 });
      const url = new URL(request.url);
      if (url.pathname === "/oauth/userinfo") {
        return Response.json({
          organizations: [
            { slug: "me", name: "Me", personal: true },
            { slug: "team", name: "Team" },
          ],
        });
      }
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

afterAll(() => {
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
  const values = {
    hiddenWorkspaces: "",
    metrics: "[]",
    baseUrl: `http://localhost:${server.port}`,
    lobuBin: join(root, "lobu"),
    autoSave: true,
    recapOnArchive: false,
    recapProvider: "",
    recapModel: "",
    ...overrides,
  };
  const bb = {
    pluginId: "lobu",
    settings: { define: () => ({ get: async () => values, onChange: () => undefined }) },
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
  test("saves, dedupes, briefs, counts uses, links, moves, pins notes, and undoes", async () => {
    const { rpc, call, brief } = await startPlugin();
    expect(brief("thread-0")).toBeNull();

    // Auto-save goes to the personal workspace and keeps the agent's workspace hint.
    const saved = String(await call("lobu_remember", { memories: [deployGotcha, prPreference] }));
    expect(saved).toContain("Saved to the user's personal Lobu workspace (me)");
    expect(lobu.memories.filter((m) => m.workspace === "me")).toHaveLength(2);

    // The same memories again are recognised as already in Lobu.
    const again = String(await call("lobu_remember", { memories: [deployGotcha] }, "thread-2"));
    expect(again).toContain("Already in Lobu, so not saved again");
    expect(lobu.memories).toHaveLength(2);

    const overview = (await rpc.memoryOverview!({})) as {
      saved: { eventId: number; title: string; suggestedWorkspace: string | null; projectId: string | null }[];
      stats: { total: number; found: number };
    };
    expect(overview.saved.map((r) => r.title).sort()).toEqual([deployGotcha.title, prPreference.title].sort());
    expect(overview.saved.find((r) => r.title === deployGotcha.title)?.suggestedWorkspace).toBe("team");
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
    const afterSearch = (await rpc.memoryOverview!({})) as typeof overview;
    expect(afterSearch.stats.found).toBe(1);
    const thread3 = (await rpc.threadMemory!({ threadId: "thread-3" })) as { log: { searches: { query: string }[] } };
    expect(thread3.log.searches.map((s) => s.query)).toEqual(["staging deploy vpn"]);

    // Linking the project makes agent searches include the team workspace.
    await rpc.linkProject!({ projectId: "proj-1", workspace: "team" });
    lobu.searches.length = 0;
    await call("lobu_search", { query: "descriptions" }, "thread-3");
    expect(lobu.searches.map((s) => s.workspace).sort()).toEqual(["me", "team"]);

    // Moving saves to the target and hides the original.
    const gotcha = afterSearch.saved.find((r) => r.title === deployGotcha.title)!;
    const moved = (await rpc.moveMemory!({ eventId: gotcha.eventId, workspace: "team" })) as { eventId: number; workspace: string };
    expect(moved.workspace).toBe("team");
    expect(lobu.memories.find((m) => m.id === gotcha.eventId)?.deleted).toBe(true);
    expect(lobu.memories.find((m) => m.id === moved.eventId)?.workspace).toBe("team");

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

    // Undo hides the memory in Lobu and drops it from the plugin's list.
    const preference = afterSearch.saved.find((r) => r.title === prPreference.title)!;
    await rpc.undoMemory!({ eventId: preference.eventId });
    expect(lobu.memories.find((m) => m.id === preference.eventId)?.deleted).toBe(true);
    const final = (await rpc.memoryOverview!({})) as typeof overview;
    expect(final.saved.map((r) => r.eventId)).not.toContain(preference.eventId);
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
