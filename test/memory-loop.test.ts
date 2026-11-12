import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi, PluginCliRegistration } from "@get-bb/plugin-sdk";
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
  entityIds?: number[];
  deleted: boolean;
  supersededBy: number | null;
}

interface StoredNotification {
  id: number;
  workspace: string;
  type: string;
  title: string;
  body: string | null;
  resource_url: string | null;
  is_read: boolean;
  created_at: string;
}

const lobu = {
  memories: [] as StoredMemory[],
  searches: [] as { workspace: string; query: string }[],
  notifications: [] as StoredNotification[],
  feeds: [] as Record<string, unknown>[],
  automations: [] as Record<string, unknown>[],
  connections: [] as Record<string, unknown>[],
  devices: [] as Record<string, unknown>[],
  tabs: [] as Record<string, unknown>[],
  // The default project's repository record; the project's git remote names it.
  entities: [{ id: 4242, name: "acme/acme-app", slug: "acme-app", type: "product", workspace: "me" }] as {
    id: number;
    name: string;
    slug: string;
    type: string;
    workspace: string;
    metadata?: unknown;
  }[],
  failFeeds: false,
  failDevices: false,
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
      const url = new URL(request.url);
      if (url.pathname === "/health") return new Response("ok", { status: 200 });
      if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("no", { status: 401 });
      const unreadMatch = url.pathname.match(/^\/api\/([^/]+)\/notifications\/unread-count$/);
      if (unreadMatch !== null) {
        const workspace = unreadMatch[1] as string;
        return Response.json({
          count: lobu.notifications.filter((n) => n.workspace === workspace && !n.is_read).length,
        });
      }
      const listMatch = url.pathname.match(/^\/api\/([^/]+)\/notifications$/);
      if (listMatch !== null && request.method === "GET") {
        const workspace = listMatch[1] as string;
        const limit = Math.max(Number(url.searchParams.get("limit")) || 20, 1);
        const cursorParam = url.searchParams.get("cursor");
        const cursor = cursorParam === null ? null : Number(cursorParam);
        const ordered = lobu.notifications
          .filter((n) => n.workspace === workspace && (cursor === null || n.id < cursor))
          .sort((a, b) => b.id - a.id);
        const page = ordered.slice(0, limit);
        return Response.json({
          notifications: page,
          nextCursor: ordered.length > page.length ? page[page.length - 1]!.id : null,
        });
      }
      const readMatch = url.pathname.match(/^\/api\/([^/]+)\/notifications\/(\d+)\/read$/);
      if (readMatch !== null && request.method === "PATCH") {
        const target = lobu.notifications.find((n) => n.workspace === readMatch![1] && n.id === Number(readMatch![2]));
        if (target === undefined) return new Response("not found", { status: 404 });
        target.is_read = true;
        return Response.json({ ok: true });
      }
      if (url.pathname === "/api/me/devices" && request.method === "GET") {
        if (lobu.failDevices) return new Response("devices are down", { status: 500 });
        return Response.json({ devices: lobu.devices });
      }
      const match = url.pathname.match(/^\/api\/([^/]+)\/([a-z_]+)$/);
      if (match === null) return new Response("not found", { status: 404 });
      const [, workspace, tool] = match as unknown as [string, string, string];
      const body = (await request.json()) as Record<string, unknown>;
      if (tool === "save_memory") {
        const supersedesId = typeof body.supersedes_event_id === "number" ? body.supersedes_event_id : null;
        // Like Lobu: an id links as given, a name links when exactly one non-system
        // record in the workspace has it (case-insensitive), and the rest come back.
        const refs = Array.isArray(body.entity_ids) ? (body.entity_ids as (number | { name: string })[]) : [];
        const unlinked: { name: string; reason: string }[] = [];
        const entityIds = refs.flatMap((ref) => {
          if (typeof ref === "number") return [ref];
          const named = lobu.entities.filter(
            (e) => e.workspace === workspace && !e.type.startsWith("$") && e.name.toLowerCase() === ref.name.toLowerCase(),
          );
          if (named.length === 1) return [named[0]!.id];
          unlinked.push({ name: ref.name, reason: named.length === 0 ? "not_found" : "ambiguous" });
          return [];
        });
        if (supersedesId !== null) {
          const target = lobu.memories.find((m) => m.id === supersedesId && m.workspace === workspace);
          if (target === undefined) return Response.json({ error: `Cannot supersede event ${supersedesId}` }, { status: 404 });
          if (target.supersededBy !== null || target.deleted) {
            return Response.json({ error: `Event ${supersedesId} already superseded` }, { status: 409 });
          }
          const id = lobu.nextId++;
          target.supersededBy = id;
          lobu.memories.push({
            id,
            workspace,
            title: String(body.title),
            content: String(body.content),
            kind: String(body.semantic_type),
            entityIds,
            deleted: false,
            supersededBy: null,
          });
          return Response.json({ id, view_url: `/${workspace}/events/${id}`, entity_ids: entityIds, unlinked });
        }
        const id = lobu.nextId++;
        lobu.memories.push({
          id,
          workspace,
          title: String(body.title),
          content: String(body.content),
          kind: String(body.semantic_type),
          entityIds,
          deleted: false,
          supersededBy: null,
        });
        return Response.json({ id, view_url: `/${workspace}/events/${id}`, entity_ids: entityIds, unlinked });
      }
      if (tool === "search_memory") {
        if (typeof body.entity_id === "number") {
          const known = lobu.entities.find((e) => e.id === body.entity_id);
          if (known !== undefined) {
            return Response.json({
              entity:
                known.workspace === workspace
                  ? { id: known.id, type: known.type, name: known.name, slug: known.slug, workspace_slug: workspace }
                  : null,
            });
          }
          return Response.json({
            entity: {
              id: body.entity_id,
              type: "project",
              name: `Project ${body.entity_id}`,
              slug: `proj-${body.entity_id}`,
              workspace_slug: workspace,
              metadata: { status: "active" },
            },
          });
        }
        const query = String(body.query);
        lobu.searches.push({ workspace, query });
        const content = lobu.memories
          .filter((m) => m.workspace === workspace && !m.deleted && m.supersededBy === null)
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
            entity_ids: m.entityIds,
          }));
        const matches: Record<string, unknown>[] = query.toLowerCase().includes("acme")
          ? [{ id: 42, type: "company", name: "Acme Corp", slug: "acme-corp", workspace_slug: workspace }]
          : [];
        // Like Lobu's trigram name search: any shared 4-letter run is a fuzzy match.
        const grams = (text: string) => {
          const out = new Set<string>();
          for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
            for (let i = 0; i + 4 <= word.length; i += 1) out.add(word.slice(i, i + 4));
          }
          return out;
        };
        const queryGrams = grams(query);
        for (const e of lobu.entities) {
          if (e.workspace !== workspace) continue;
          const exact = e.name.toLowerCase() === query.toLowerCase();
          if (!exact && ![...grams(e.name)].some((g) => queryGrams.has(g))) continue;
          matches.push({ id: e.id, type: e.type, name: e.name, slug: e.slug, workspace_slug: workspace, match_score: exact ? 1 : 0.31 });
        }
        return Response.json({ content, matches });
      }
      if (tool === "read_knowledge") {
        const requestedIds = Array.isArray(body.content_ids) ? (body.content_ids as number[]) : null;
        if (requestedIds !== null) {
          const resolved = new Map<number, StoredMemory>();
          for (const seed of requestedIds) {
            let cur = lobu.memories.find((m) => m.id === seed && m.workspace === workspace);
            while (cur !== undefined && !resolved.has(cur.id)) {
              resolved.set(cur.id, cur);
              cur = cur.supersededBy === null ? undefined : lobu.memories.find((m) => m.id === cur!.supersededBy && m.workspace === workspace);
            }
          }
          const content = [...resolved.values()].flatMap((m) => {
            const tombstoneId = m.deleted ? m.id + 100_000 : null;
            const row = {
              id: m.id,
              title: m.title,
              text_content: m.content,
              semantic_type: m.kind,
              occurred_at: "2026-10-01T00:00:00.000Z",
              platform: "lobu",
              superseded_by: m.deleted ? tombstoneId : m.supersededBy,
              is_superseded: m.deleted || m.supersededBy !== null,
            };
            if (!m.deleted) return [row];
            return [
              row,
              {
                id: tombstoneId!,
                title: null,
                text_content: "",
                semantic_type: "tombstone",
                occurred_at: "2026-10-01T00:00:01.000Z",
                platform: "lobu",
                superseded_by: null,
                is_superseded: false,
              },
            ];
          });
          return Response.json({ content });
        }
        const limit = typeof body.limit === "number" ? body.limit : 50;
        const kinds = Array.isArray(body.semantic_type)
          ? (body.semantic_type as string[])
          : typeof body.semantic_type === "string"
            ? [body.semantic_type]
            : null;
        const query = typeof body.query === "string" ? body.query : null;
        const content = lobu.memories
          .filter((m) => m.workspace === workspace && !m.deleted && m.supersededBy === null)
          .filter((m) => kinds === null || kinds.includes(m.kind))
          .map((m) => ({ m, score: query === null ? 0 : similarity(query, m) }))
          .filter(({ score }) => query === null || score > 0)
          .sort((a, b) => (query === null ? b.m.id - a.m.id : b.score - a.score))
          .slice(0, limit)
          .map(({ m, score }) => ({
            id: m.id,
            title: m.title,
            text_content: m.content,
            semantic_type: m.kind,
            occurred_at: "2026-10-01T00:00:00.000Z",
            platform: "lobu",
            superseded_by: null,
            is_superseded: false,
            ...(query === null ? {} : { similarity: score }),
          }));
        return Response.json({ content });
      }
      if (tool === "manage_feeds" && body.action === "list_feeds") {
        if (lobu.failFeeds) return new Response("lobu is having a moment", { status: 500 });
        const limit = typeof body.limit === "number" ? body.limit : 50;
        return Response.json({
          action: "list_feeds",
          feeds: lobu.feeds
            .filter((f) => f.workspace === workspace)
            .slice(-limit)
            .reverse(),
        });
      }
      if (tool === "manage_connections" && body.action === "list") {
        return Response.json({
          action: "list",
          connections: lobu.connections.filter((c) => c.organization_id === workspace || c.workspace === workspace),
        });
      }
      if (tool === "manage_operations" && body.action === "execute" && body.operation_key === "evaluate") {
        const input = body.input as { tab_id?: number } | undefined;
        if (input?.tab_id === 999) return new Response("no such tab", { status: 404 });
        return Response.json({
          action: "execute",
          status: "completed",
          output: {
            value: { title: "Lobu \u2014 Memory", url: "https://app.lobu.ai/buremba", text: "Inbox  (17)  Primary  Social  Promotions" },
          },
        });
      }
      if (tool === "manage_operations" && body.action === "execute" && body.operation_key === "list_tabs") {
        return Response.json({
          action: "execute",
          status: "completed",
          output: {
            tabs: lobu.tabs.filter((t) => t.workspace === workspace && t.connection_id === body.connection_id),
          },
        });
      }
      if (tool === "manage_automations" && body.action === "list") {
        return Response.json({
          action: "list",
          automations: lobu.automations.filter((a) => a.workspace === workspace),
        });
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
      `if [ "$1" = whoami ] && [ -e "${join(root, "signed-out")}" ]; then echo '{"loggedIn":false,"local":false,"organizations":[]}'; exit 0; fi`,
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
  let cli: PluginCliRegistration | null = null;
  const formRequests: unknown[] = [];
  const mentionProviders: { id: string; search: (ctx: unknown) => Promise<unknown[]>; resolve: (id: string) => Promise<unknown> }[] = [];
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
      projects: { list: async () => [{ id: "proj-1", name: "Acme app", gitRemoteUrl: "https://github.com/acme/acme-app.git" }] },
      threads: {
        get: async () => ({ projectId: "proj-1", title: "Plan the launch", titleFallback: null, archivedAt: null, deletedAt: null }),
        list: async () => [],
        getPluginMetadata: async () => ({}),
      },
      ...(overrides.sdk ?? {}),
    },
    events: { on: () => undefined },
    agents: {
      registerTool: (tool: Tool & { name: string }) => void tools.set(tool.name, tool),
      contributeInstructions: (provider: typeof instructions) => {
        instructions = provider;
      },
    },
    cli: {
      register: (registration: PluginCliRegistration) => {
        cli = registration;
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
      registerMentionProvider: (provider: (typeof mentionProviders)[number]) => void mentionProviders.push(provider),
    },
    log: { info: () => undefined, warn: () => undefined },
    onDispose: () => undefined,
  };
  await plugin(bb as unknown as BbPluginApi);
  // Let the startup project listing settle.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const call = (name: string, params: unknown, threadId = "thread-1", projectId = "proj-1") =>
    tools.get(name)!.execute(params, { threadId, projectId, signal: new AbortController().signal });
  const runCli = (argv: string[], threadId = "thread-1", projectId = "proj-1") =>
    cli!.run(argv, { threadId, projectId, signal: new AbortController().signal });
  return { kv, rpc, call, runCli, formRequests, mentions: mentionProviders, brief: (threadId: string, projectId = "proj-1") => instructions!({ threadId, projectId }) };
}

/**
 * A real @-menu keystroke never waits on a cold list fetch: it answers from the
 * cache and lets the fill finish in the background (a timeout would blow the
 * host's ~2s per-search box). Tests therefore warm the way the panel does on
 * mount, then assert on warmed searches.
 */
async function warmMentions(search: (ctx: unknown) => Promise<unknown[]>): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await search({ query: "", projectId: null })).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("mention lists never warmed");
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
    // Neither memory names a record, so neither is linked; not even to the project's repo.
    expect(saved).not.toContain("[entities:");
    expect(lobu.memories.filter((m) => m.workspace === "me")).toHaveLength(2);
    expect(lobu.memories[0].entityIds ?? []).toEqual([]);

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
    expect(text).toContain("Project repository: acme/acme-app");
    expect(text).toContain("Learned in earlier threads of this project:");
    expect(text).toContain(deployGotcha.title);
    const startLog = (await rpc.threadMemory!({ threadId: "thread-3" })) as {
      log: { given: unknown[] };
      startedWith: { source: string; threadId: string | null; threadTitle: string | null; url: string | null }[];
    };
    expect(startLog.log.given).toHaveLength(2);
    // The thread's panel shows each memory it started with under the session that taught it.
    for (const item of startLog.startedWith) {
      expect(item).toMatchObject({ source: "learned", threadId: "thread-1", threadTitle: "Plan the launch" });
      expect(item.url).not.toBeNull();
    }

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
    };
    expect(project.pins.map((p) => p.title)).toEqual(["Release notes go in CHANGELOG.md"]);
    const withNote = brief("thread-8")!;
    expect(withNote.indexOf("Pinned by the user:")).toBeLessThan(withNote.indexOf("Learned in earlier threads"));
    // A pinned note leads the brief once, not again among what was learned.
    expect(withNote.split("Release notes go in CHANGELOG.md")).toHaveLength(2);
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
      project: {
        name: string;
        workspace: string;
        pins: { title: string }[];
        learned: { title: string; threadId: string | null; threadTitle: string | null; url: string | null }[];
      };
    };
    expect(home.personal).toBe("me");
    expect(home.project).toMatchObject({ name: "Acme app", workspace: "team" });
    expect(home.project.pins.map((p) => p.title)).toEqual(["Release notes go in CHANGELOG.md"]);
    expect(home.project.learned.map((l) => l.title).sort()).toEqual([deployGotcha.title, prPreference.title].sort());
    // Each learned memory names the session that taught it and links to it in Lobu.
    for (const item of home.project.learned) {
      expect(item).toMatchObject({ threadId: "thread-1", threadTitle: "Plan the launch" });
      expect(item.url).not.toBeNull();
    }

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

  test("signed out, the agent's Lobu tools say so quietly instead of failing", async () => {
    const marker = join(root, "signed-out");
    writeFileSync(marker, "");
    try {
      const { call } = await startPlugin();
      const notConnected = "Lobu is not connected, so its memory is unavailable. Continue without it.";
      expect(await call("lobu_search", { query: "staging deploy vpn" }, "thread-10")).toBe(notConnected);
      expect(await call("lobu_remember", { memories: [prPreference] }, "thread-10")).toBe(notConnected);
    } finally {
      rmSync(marker);
    }
  });

  test("supersedes stale memories, exposes bb lobu CLI for ACP agents, shares to team, and reconciles Lobu edits", async () => {
    lobu.memories.length = 0;
    lobu.searches.length = 0;
    lobu.nextId = 2000;

    const { rpc, call, runCli, brief } = await startPlugin();

    // 1. Save an initial memory via bb lobu remember CLI (the ACP agent fallback).
    const firstCli = await runCli(
      [
        "remember",
        "--title",
        "Staging uses port 8080",
        "--content",
        "Staging listens on port 8080 behind the proxy.",
        "--kind",
        "fact",
        "--evidence",
        "Agent: curl localhost:8080 succeeded",
        "--json",
      ],
      "thread-acp-1",
    );
    expect(firstCli.exitCode).toBe(0);
    const firstParsed = JSON.parse(firstCli.stdout ?? "{}") as { ok: boolean; saved: { eventId: number; title: string }[] };
    expect(firstParsed.ok).toBe(true);
    expect(firstParsed.saved).toHaveLength(1);
    const firstId = firstParsed.saved[0]!.eventId;

    // Brief includes the memory and its eventId so later sessions can supersede it.
    expect(brief("thread-acp-2")).toContain(`Staging uses port 8080 (memory ${firstId})`);

    // 2. Search via bb lobu search CLI logs the lookup and increments usage count.
    const searchCli = await runCli(["search", "staging port", "--json"], "thread-acp-2");
    expect(searchCli.exitCode).toBe(0);
    const searchParsed = JSON.parse(searchCli.stdout ?? "{}") as { ok: boolean; results: { eventId: number }[] };
    expect(searchParsed.results.map((r) => r.eventId)).toContain(firstId);
    const afterCliSearch = (await rpc.threadMemory!({ threadId: "thread-acp-1" })) as {
      saved: { eventId: number; uses: number }[];
    };
    expect(afterCliSearch.saved.find((r) => r.eventId === firstId)?.uses).toBe(1);

    // 3. Supersede the stale memory via replacesEventId (--replaces-id).
    const replaceCli = await runCli(
      [
        "remember",
        "--title",
        "Staging uses port 9090",
        "--content",
        "Correction: staging moved to port 9090; 8080 is only the metrics sidecar.",
        "--kind",
        "fact",
        "--evidence",
        "Agent: healthcheck moved to :9090",
        "--replaces-id",
        String(firstId),
        "--json",
      ],
      "thread-acp-2",
    );
    expect(replaceCli.exitCode).toBe(0);
    const replaceParsed = JSON.parse(replaceCli.stdout ?? "{}") as { saved: { eventId: number }[] };
    const replacementId = replaceParsed.saved[0]!.eventId;
    expect(replacementId).not.toBe(firstId);
    expect(lobu.memories.find((m) => m.id === firstId)?.supersededBy).toBe(replacementId);

    // The superseded memory is gone from the brief; only the correction remains.
    const updatedBrief = brief("thread-acp-3")!;
    expect(updatedBrief).toContain("Staging uses port 9090");
    expect(updatedBrief).not.toContain("Staging uses port 8080");

    // 4. Link team workspace and one-click share the memory to team.
    await rpc.linkProject!({ projectId: "proj-1", workspace: "team" });
    const shared = (await rpc.shareMemory!({ eventId: replacementId, workspace: "team" })) as {
      eventId: number;
      workspace: string;
    };
    expect(shared.workspace).toBe("team");
    expect(lobu.memories.find((m) => m.id === shared.eventId)?.workspace).toBe("team");

    // 5. External save in linked team workspace + external edit & tombstone in Lobu sync back into bb.
    const teammateId = lobu.nextId++;
    lobu.memories.push({
      id: teammateId,
      workspace: "team",
      title: "Run migrations with make db-migrate",
      content: "Teammate note saved from Claude Desktop in the team workspace.",
      kind: "decision",
      deleted: false,
      supersededBy: null,
    });
    // Simulate editing replacementId directly in Lobu's web UI.
    const webEditedId = lobu.nextId++;
    lobu.memories.find((m) => m.id === replacementId)!.supersededBy = webEditedId;
    lobu.memories.push({
      id: webEditedId,
      workspace: "me",
      title: "Staging uses port 9091",
      content: "Edited in Lobu web UI to port 9091.",
      kind: "fact",
      deleted: false,
      supersededBy: null,
    });
    // Simulate deleting the shared team copy directly in Lobu's web UI.
    lobu.memories.find((m) => m.id === shared.eventId)!.deleted = true;

    const synced = (await rpc.projectMemory!({ projectId: "proj-1" })) as {
      project: { learned: { eventId: number | null; title: string }[] };
    };
    const learnedTitles = synced.project.learned.map((l) => l.title);
    expect(learnedTitles).toContain("Run migrations with make db-migrate");
    expect(learnedTitles).toContain("Staging uses port 9091");
    expect(learnedTitles).not.toContain("Staging uses port 9090");

    // Also verify lobu_remember tool directly supports replacesEventId.
    const toolReplaced = String(
      await call(
        "lobu_remember",
        {
          memories: [
            {
              title: "Staging uses port 9092",
              content: "Updated again via native tool.",
              kind: "fact",
              evidence: "User: switched staging port to 9092",
              replacesEventId: webEditedId,
              entityIds: [42, 99],
            },
          ],
        },
        "thread-acp-4",
      ),
    );
    expect(toolReplaced).toContain("Staging uses port 9092");
    expect(brief("thread-acp-5")).toContain("Staging uses port 9092");
    expect(brief("thread-acp-5")).not.toContain("Staging uses port 9091");
    expect(lobu.memories.find((m) => m.title === "Staging uses port 9092")?.entityIds).toEqual([42, 99]);

    // CLI remember with --entity-ids
    const entityCli = await runCli(
      [
        "remember",
        "--title",
        "Acme DB rules",
        "--content",
        "All queries require tenant_id filter.",
        "--kind",
        "decision",
        "--evidence",
        "User: always scope queries by tenant_id",
        "--entity-ids",
        "42,99",
        "--json",
      ],
      "thread-acp-6",
    );
    expect(entityCli.exitCode).toBe(0);
    const savedEntityMem = lobu.memories.find((m) => m.title === "Acme DB rules");
    expect(savedEntityMem?.entityIds).toEqual([42, 99]);
  });

  test("inbox lists personal notifications and marks them read", async () => {
    lobu.notifications.push(
      {
        id: 9001,
        workspace: "me",
        type: "agent_message",
        title: "Approval needed",
        body: "Please approve the run.",
        resource_url: "/me/runs/1",
        is_read: false,
        created_at: "2026-10-01T00:00:00.000Z",
      },
      {
        id: 9002,
        workspace: "me",
        type: "note",
        title: "Old news",
        body: null,
        resource_url: null,
        is_read: true,
        created_at: "2026-09-01T00:00:00.000Z",
      },
    );
    const { rpc } = await startPlugin();
    const inbox = (await rpc.inbox!({ cursor: null })) as {
      workspace: string;
      unreadCount: number;
      notifications: { id: number; title: string; resourceUrl: string | null; isRead: boolean }[];
      nextCursor: number | null;
      url: string;
    };
    expect(inbox.workspace).toBe("me");
    expect(inbox.unreadCount).toBe(1);
    expect(inbox.notifications.map((n) => n.id)).toEqual([9002, 9001]);
    expect(inbox.notifications.find((n) => n.id === 9001)).toMatchObject({ title: "Approval needed", isRead: false });
    expect(inbox.notifications.find((n) => n.id === 9001)?.resourceUrl).toBe(`http://localhost:${server.port}/me/runs/1`);
    expect(inbox.nextCursor).toBeNull();
    expect(inbox.url).toBe(`http://localhost:${server.port}/me`);
    await rpc.markNotificationRead!({ notificationId: 9001, workspace: "me" });
    const after = (await rpc.inbox!({ cursor: null })) as { unreadCount: number; notifications: { id: number; isRead: boolean }[] };
    expect(after.unreadCount).toBe(0);
    expect(after.notifications.find((n) => n.id === 9001)?.isRead).toBe(true);
  });

  test("@-mention providers search and resolve memory, feeds, automations, connections, and devices", async () => {
    lobu.memories.push({
      id: 7001,
      workspace: "me",
      title: "Deploy checklist",
      content: "Run migrations before deploying.",
      kind: "fact",
      deleted: false,
      supersededBy: null,
    });
    lobu.feeds.push(
      { workspace: "me", id: 81, display_name: "Gmail inbox", feed_key: "inbox", connector_name: "Gmail", status: "active", connector_key: "gmail", connection_id: 7, last_error: null, items_collected: 12, updated_at: "2026-10-01T00:00:00.000Z" },
      { workspace: "me", id: 82, display_name: "slack:general", feed_key: "gchat:spaces/CAAAA", connector_name: "Google Chat", status: "failing", connector_key: "slack", connection_id: 8, last_error: "auth expired", updated_at: "2026-10-02T00:00:00.000Z", items_collected: 3 },
    );
    lobu.automations.push({
      workspace: "me",
      automation_id: "a-1",
      name: "Morning digest",
      status: "active",
      triggers: [{ kind: "schedule" }],
      updated_at: "2026-10-03T00:00:00.000Z",
    });
    lobu.connections.push(
      {
        workspace: "me",
        organization_id: "me",
        id: 7,
        display_name: "Gmail (me@ex.com)",
        connector_key: "gmail",
        connector_name: "Gmail",
        auth_profile_name: "me@ex.com",
        status: "active",
        error_message: null,
      },
      // Lobu names a Google Chat space by its key, which reads as an id.
      {
        workspace: "me",
        organization_id: "me",
        id: 8,
        display_name: "spaces/CAAAA",
        connector_key: "gchat",
        connector_name: "Google Chat",
        auth_profile_name: null,
        device_label: null,
        status: "active",
        error_message: null,
      },
    );
    lobu.devices.push({
      id: "dev-1",
      worker_id: "macbook",
      label: "MacBook",
      platform: "darwin",
      online: true,
      last_seen_at: "2026-10-04T00:00:00.000Z",
      capabilities: ["os.shell"],
    });

    const { rpc, mentions } = await startPlugin();
    // Await a full sync so the seeded memory is hydrated into memory.saved.
    await rpc.projectMemory!({ projectId: "proj-1" });
    const byId = (id: string) => mentions.find((p) => p.id === id)!;
    expect(mentions.map((p) => p.id).sort()).toEqual([
      "lobu-automation",
      "lobu-connection",
      "lobu-entity",
      "lobu-feed",
      "lobu-memory",
      "lobu-tab",
    ]);
    await warmMentions(byId("lobu-feed").search as (ctx: unknown) => Promise<unknown[]>);

    // Memory: blank query lists recent saves, a query searches, resolve returns full text.
    const memSearch = byId("lobu-memory").search as (ctx: unknown) => Promise<{ id: string; title: string }[]>;
    const memResolve = byId("lobu-memory").resolve as (id: string) => Promise<{ context: string }>;
    const recent = await memSearch({ query: "", projectId: "proj-1" });
    expect(recent.some((item) => item.id === "mem:me:7001")).toBe(true);
    const hits = await memSearch({ query: "migrations deploying", projectId: "proj-1" });
    expect(hits.map((item) => item.id)).toContain("mem:me:7001");
    const memCtx = await memResolve("mem:me:7001");
    expect(memCtx.context).toContain("Deploy checklist");
    expect(memCtx.context).toContain("Run migrations before deploying.");
    // Unknown ids resolve gracefully instead of throwing (a throw would block the send).
    expect((await memResolve("mem:me:999999")).context).toContain("no longer available");

    // Feeds: filter by name, resolve to a fresh status summary.
    const feedSearch = byId("lobu-feed").search as (ctx: unknown) => Promise<{ id: string; title: string; subtitle?: string }[]>;
    const feedResolve = byId("lobu-feed").resolve as (id: string) => Promise<{ context: string }>;
    expect((await feedSearch({ query: "", projectId: null })).map((item) => item.id).sort()).toEqual(["feed:me:81", "feed:me:82"]);
    expect((await feedSearch({ query: "gmail", projectId: null })).map((item) => item.id)).toEqual(["feed:me:81"]);
    // A key-shaped name leads with the connector's human name; the key stays visible.
    const rawFeed = (await feedSearch({ query: "google chat", projectId: null })).find((item) => item.id === "feed:me:82");
    expect(rawFeed?.title).toBe("Google Chat");
    expect(rawFeed?.subtitle).toContain("slack:general");
    // Two workspaces are reachable here, so the org name is part of the label;
    // "Gmail" is dropped because the title already says it.
    expect((await feedSearch({ query: "gmail", projectId: null }))[0]?.subtitle).toBe("Me · active");
    // A resolve runs while the message waits to go out; when the refresh fails
    // it must answer from the mention cache instead of stalling or empty-handed.
    lobu.failFeeds = true;
    const staleFeed = (await feedResolve("feed:me:82")).context;
    lobu.failFeeds = false;
    expect(staleFeed).toContain("slack:general");
    expect(staleFeed).toContain("as of the last check");

    const feedCtx = (await feedResolve("feed:me:82")).context;
    expect(feedCtx).toContain("slack:general");
    expect(feedCtx).toContain("auth expired");
    // Resolved context links to Lobu's own page for the thing, not the org root.
    expect(feedCtx).toContain(`http://localhost:${server.port}/me/connectors/slack/8`);

    // Automations: list and resolve to name, status, and trigger kinds.
    const autoSearch = byId("lobu-automation").search as (ctx: unknown) => Promise<{ id: string; title: string }[]>;
    const autoResolve = byId("lobu-automation").resolve as (id: string) => Promise<{ context: string }>;
    expect((await autoSearch({ query: "", projectId: null })).map((item) => item.id)).toEqual(["auto:me:a-1"]);
    const autoCtx = (await autoResolve("auto:me:a-1")).context;
    expect(autoCtx).toContain("Morning digest");
    expect(autoCtx).toContain("schedule");
    expect(autoCtx).toContain(`http://localhost:${server.port}/me/automations/a-1`);

    // Connections and devices: paired device plus connection, each resolvable.
    const connSearch = byId("lobu-connection").search as (ctx: unknown) => Promise<{ id: string; title: string; subtitle?: string }[]>;
    const connResolve = byId("lobu-connection").resolve as (id: string) => Promise<{ context: string }>;
    expect((await connSearch({ query: "", projectId: null })).map((item) => item.id).sort()).toEqual([
      "conn:me:7",
      "conn:me:8",
      "dev:dev-1",
    ]);
    const macItems = await connSearch({ query: "macbook", projectId: null });
    expect(macItems.map((item) => item.id)).toEqual(["dev:dev-1"]);
    // Device rows name the device and read the platform as words, not a key.
    expect(macItems[0]?.subtitle).toBe("darwin · online");
    // Connections show the connector's human name and the account, never the key.
    const gmailRow = (await connSearch({ query: "gmail", projectId: null }))[0];
    expect(gmailRow?.title).toBe("Gmail (me@ex.com)");
    expect(gmailRow?.subtitle).toBe("Me · active");
    const chatRow = (await connSearch({ query: "google chat", projectId: null }))[0];
    expect(chatRow?.title).toBe("Google Chat");
    expect(chatRow?.subtitle).toContain("spaces/CAAAA");
    // The devices endpoint failing must not lose the row the menu already has.
    lobu.failDevices = true;
    const staleDevice = (await connResolve("dev:dev-1")).context;
    lobu.failDevices = false;
    expect(staleDevice).toContain("MacBook");

    const devCtx = (await connResolve("dev:dev-1")).context;
    expect(devCtx).toContain("MacBook");
    expect(devCtx).toContain("online");
    const connCtx = (await connResolve("conn:me:7")).context;
    expect(connCtx).toContain("Gmail (me@ex.com)");
    expect(connCtx).toContain("active");
    expect(connCtx).toContain(`http://localhost:${server.port}/me/connectors/gmail/7`);
    expect((await connResolve("conn:me:999")).context).toContain("no longer available");

    // Entities: query searches entities, resolve returns details with URL and metadata.
    const entSearch = byId("lobu-entity").search as (ctx: unknown) => Promise<{ id: string; title: string; subtitle?: string }[]>;
    const entResolve = byId("lobu-entity").resolve as (id: string) => Promise<{ context: string }>;
    const acmeEntities = await entSearch({ query: "acme", projectId: "proj-1" });
    expect(acmeEntities.map((item) => item.id)).toEqual(["ent:me:42", "ent:me:4242"]);
    expect(acmeEntities[0]?.title).toBe("Acme Corp");
    expect(acmeEntities[0]?.subtitle).toBe("company · me");
    const entCtx = (await entResolve("ent:me:42")).context;
    expect(entCtx).toContain("Entity Project 42 (project, id: 42) in me.");
    expect(entCtx).toContain("proj-42");
    expect(entCtx).toContain('Metadata: {"status":"active"}');
  });

  test("@-mention browser tabs list open tabs and resolve the picked one", async () => {
    lobu.connections.push({
      workspace: "me",
      organization_id: "me",
      id: 479,
      display_name: "Chrome \u2014 MacBook",
      connector_key: "chrome",
      status: "active",
      error_message: null,
    });
    // A second paired browser: tabs must say which machine they come from.
    lobu.connections.push({
      workspace: "me",
      organization_id: "me",
      id: 480,
      display_name: "Chrome \u2014 Mac mini",
      connector_key: "chrome",
      connector_name: "Chrome",
      status: "active",
      error_message: null,
    });
    lobu.tabs.push(
      { workspace: "me", connection_id: 479, tab_id: 101, title: "Inbox", url: "https://mail.google.com/mail/u/0/#inbox", window_id: 1, active: false },
      { workspace: "me", connection_id: 479, tab_id: 102, title: "Lobu \u2014 Memory", url: "https://app.lobu.ai/buremba", window_id: 1, active: true },
      { workspace: "me", connection_id: 480, tab_id: 201, title: "(2) WhatsApp", url: "https://web.whatsapp.com/", window_id: 9, active: true },
    );

    const { mentions } = await startPlugin();
    const byId = (id: string) => mentions.find((p) => p.id === id)!;
    expect(mentions.map((p) => p.id).sort()).toEqual([
      "lobu-automation",
      "lobu-connection",
      "lobu-entity",
      "lobu-feed",
      "lobu-memory",
      "lobu-tab",
    ]);

    const tabSearch = byId("lobu-tab").search as (ctx: unknown) => Promise<{ id: string; title: string; subtitle?: string }[]>;
    const tabResolve = byId("lobu-tab").resolve as (id: string) => Promise<{ context: string }>;
    await warmMentions(tabSearch as (ctx: unknown) => Promise<unknown[]>);
    expect((await tabSearch({ query: "", projectId: null })).map((item) => item.id)).toEqual([
      "tab:me:479:101",
      "tab:me:479:102",
      "tab:me:480:201",
    ]);
    const mailTab = (await tabSearch({ query: "mail", projectId: null }))[0];
    expect(mailTab?.id).toBe("tab:me:479:101");
    expect(mailTab?.subtitle).toContain("Chrome \u2014 MacBook");
    const miniTab = (await tabSearch({ query: "whatsapp", projectId: null }))[0];
    expect(miniTab?.id).toBe("tab:me:480:201");
    expect(miniTab?.title).toBe("(2) WhatsApp");
    expect(miniTab?.subtitle).toContain("Chrome \u2014 Mac mini");
    expect(miniTab?.subtitle).toContain("https://web.whatsapp.com/");
    const tabCtx = (await tabResolve("tab:me:479:102")).context;
    expect(tabCtx).toContain("Lobu \u2014 Memory");
    expect(tabCtx).toContain("https://app.lobu.ai/buremba");
    // The picked tab hands the agent what the page says, not just its address.
    expect(tabCtx).toContain("Page text: Inbox  (17)  Primary  Social  Promotions");
    // A tab the browser no longer has is answered as closed, not half-resolved.
    expect((await tabResolve("tab:me:479:999")).context).toContain("no longer open");
  });

  test("ambient browser context prioritizes BB desktop browser tabs over external Chrome", async () => {
    const { call, brief } = await startPlugin({
      sdk: {
        hosts: { list: async () => [{ id: "host-1" }] },
        experimental_desktopBrowsers: {
          listInstances: async () => ({ instances: [{ instanceId: "inst-1", generation: "gen-1" }] }),
          listTabs: async () => ({
            tabs: [
              { tabId: "t1", url: "http://localhost:3000/docs", title: "App Docs", presentation: "reveal" },
            ],
          }),
        },
      },
    });
    // Save memory so the project brief is active
    await call("lobu_remember", { memories: [deployGotcha] }, "thread-bb");
    const text = brief("thread-bb");
    expect(text).toContain("Active browser tab: App Docs (http://localhost:3000/docs)");
  });

  test("links a memory only to exact, unambiguous mentions, its project's repo included", async () => {
    // A realistic people graph: fuzzy name search turns "Hand off" into Hande,
    // Handy and Handel, and "Dmitry" into every Dmitry. None of them may be linked.
    const seeded = [
      { id: 5001, name: "acme/payments", slug: "payments", type: "product", workspace: "me" },
      { id: 5101, name: "Hande Örs", slug: "person-5101", type: "person", workspace: "me" },
      { id: 5102, name: "Tristan Handy", slug: "person-5102", type: "person", workspace: "me" },
      { id: 5103, name: "Nick Handel", slug: "person-5103", type: "person", workspace: "me" },
      { id: 5104, name: "Dmitry Karpov", slug: "person-5104", type: "person", workspace: "me" },
      { id: 5105, name: "Dmitry Sorokin", slug: "person-5105", type: "person", workspace: "me" },
      { id: 5106, name: "Priya Raman", slug: "person-5106", type: "person", workspace: "me" },
      { id: 5107, name: "Sam Rivera", slug: "person-5107", type: "person", workspace: "me" },
      { id: 5108, name: "Sam Rivera", slug: "person-5108", type: "person", workspace: "me" },
      { id: 5109, name: "Someone Example", slug: "member-5109", type: "$member", workspace: "me" },
      { id: 5201, name: "Team Service", slug: "team-service", type: "product", workspace: "team" },
    ];
    lobu.entities.push(...seeded);
    const entitiesBefore = lobu.entities.length;
    try {
      const { call, runCli, brief } = await startPlugin({
        sdk: {
          projects: {
            list: async () => [{ id: "proj-pay", name: "Payments", gitRemoteUrl: "git@github.com:acme/payments.git" }],
          },
          threads: {
            get: async () => ({ projectId: "proj-pay" }),
            list: async () => [],
            getPluginMetadata: async () => ({}),
            events: {
              list: async () => [
                {
                  seq: 1,
                  type: "client/turn/requested",
                  data: { input: [{ type: "text", text: "Hand off the stack to Dmitry; see https://github.com/acme/worker-service" }] },
                },
              ],
            },
          },
          hosts: { list: async () => [{ id: "host-1" }] },
          experimental_desktopBrowsers: {
            listInstances: async () => ({ instances: [{ instanceId: "inst-1", generation: "gen-1" }] }),
            listTabs: async () => ({
              tabs: [
                { tabId: "t1", url: "https://github.com/acme/worker-service", title: "worker-service", presentation: "reveal" },
                { tabId: "t2", url: "https://stripe.com/docs/api", title: "Stripe API Documentation", presentation: "reveal" },
              ],
            }),
          },
        },
      });
      const text = String(
        await call(
          "lobu_remember",
          {
            memories: [
              {
                title: "Hand off BB stack state to Dmitry's agents through PR comments",
                content: "Post the stack state as a PR comment so Dmitry's agents pick it up.",
                kind: "preference",
                evidence: "User: hand it off in the PR",
                mentions: ["Dmitry", "Dmitry Nasikanov"],
              },
              {
                title: "Priya Raman owns the webhook signing keys",
                content: "Ask Priya Raman before rotating webhook signing keys; Sam Rivera only reviews.",
                kind: "fact",
                evidence: "User: Priya owns the keys",
                mentions: ["Priya Raman", "Sam Rivera", "Someone Example"],
              },
              {
                title: "Payments webhooks retry for 24 hours",
                content: "acme/payments retries failed webhook deliveries for 24 hours before dropping them.",
                kind: "fact",
                evidence: "Agent: found the retry window in the worker",
                mentions: ["acme/payments"],
              },
              {
                title: "Ops runbook lives with the platform team",
                content: "The ops runbook for queue outages is kept by the platform team.",
                kind: "fact",
                evidence: "Agent: found the runbook owner",
                entityIds: [5201],
              },
            ],
          },
          "thread-pay",
          "proj-pay",
        ),
      );
      const linksOf = (title: string) => [...(lobu.memories.find((m) => m.title === title)?.entityIds ?? [])].sort();
      // A first name and a partial-name hit link nothing, and the project's repo is not linked unasked.
      expect(linksOf("Hand off BB stack state to Dmitry's agents through PR comments")).toEqual([]);
      // A unique exact name links; a duplicated name and a member do not.
      expect(linksOf("Priya Raman owns the webhook signing keys")).toEqual([5106]);
      // The project's repo links when the memory is about it.
      expect(linksOf("Payments webhooks retry for 24 hours")).toEqual([5001]);
      // An explicit id from another workspace cannot be linked to a memory saved here.
      expect(linksOf("Ops runbook lives with the platform team")).toEqual([]);
      // Tabs and transcript URLs never create entities.
      expect(lobu.entities.length).toBe(entitiesBefore);
      // The agent learns which mentions stayed unlinked and why.
      expect(text).toContain('"Dmitry"');
      expect(text).toContain('"Sam Rivera"');
      expect(text).toContain('"Dmitry Nasikanov": no record has this exact name');
      expect(brief("thread-pay-2", "proj-pay")).toContain("Project repository: acme/payments");

      // The CLI takes mentions too.
      const cli = await runCli(
        ["remember", "--title", "Priya Raman approves key rotation", "--content", "Key rotation needs Priya Raman's approval.", "--kind", "decision", "--evidence", "User: Priya approves rotations", "--mentions", "Priya Raman", "--json"],
        "thread-pay-3",
        "proj-pay",
      );
      expect(cli.exitCode).toBe(0);
      expect(linksOf("Priya Raman approves key rotation")).toEqual([5106]);

      // Search shows only exact entity matches, never fuzzy look-alikes.
      const search = String(await call("lobu_search", { query: "Hand off stack state" }, "thread-pay-4", "proj-pay"));
      expect(search).not.toContain("Hande");
      expect(search).not.toContain("Handy");
    } finally {
      lobu.entities.splice(0, lobu.entities.length, ...lobu.entities.filter((e) => !seeded.some((s) => s.id === e.id)));
    }
  });

  test("the New thread screen lists the project's sessions and what each saved", async () => {
    const { rpc, call } = await startPlugin();
    await call(
      "lobu_remember",
      {
        memories: [
          {
            title: "Panel save",
            content: "Saved from the sessions test.",
            kind: "note",
            evidence: "Synthetic test memory",
          },
        ],
      },
      "thread-panel",
      "proj-1",
    );
    type Sessions = {
      sessions: { threadId: string; title: string | null; projectName: string | null; records: { title: string }[] }[];
    };
    const saved = (await rpc.savedMemories!({ projectId: "proj-1" })) as Sessions;
    const panelSession = saved.sessions.find((session) => session.threadId === "thread-panel");
    expect(panelSession).toMatchObject({ title: "Plan the launch", projectName: "Acme app" });
    expect(panelSession?.records.map((record) => record.title)).toContain("Panel save");

    const elsewhere = (await rpc.savedMemories!({ projectId: "proj-other" })) as Sessions;
    expect(elsewhere.sessions).toEqual([]);
  });
});
