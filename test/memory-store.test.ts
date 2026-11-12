import { describe, expect, test } from "bun:test";
import type { SavedRecord } from "../lib/memory-contract";
import {
  briefFor,
  capThreadLogs,
  countUses,
  entitiesFromSearch,
  groupBySession,
  hitsFromSearch,
  learnedFor,
  parseSaved,
  parseThreadLogs,
} from "../lib/memory-store";

const record = (overrides: Partial<SavedRecord>): SavedRecord => ({
  eventId: 1,
  workspace: "me",
  title: "A fact",
  content: "Some content.",
  kind: "fact",
  url: null,
  threadId: "thread-1",
  projectId: "proj-1",
  savedAt: 1_000,
  uses: 0,
  lastUsedAt: null,
  ...overrides,
});

describe("briefFor", () => {
  test("is null when there is nothing to give", () => {
    expect(briefFor({ projectName: "Acme", linkedWorkspace: null, pins: [], learned: [] })).toBeNull();
  });

  test("puts pins first and stays inside bb's instruction limit", () => {
    const long = "word ".repeat(400);
    const learned = Array.from({ length: 30 }, (_, i) => record({ eventId: i + 10, title: `Learned ${i}`, content: long }));
    const pins = [{ eventId: null, workspace: "me", title: "Pinned note", content: "Pinned body", url: null, pinnedAt: 1 }];
    const brief = briefFor({ projectName: "Acme", linkedWorkspace: "team", pins, learned })!;
    expect(brief.text.length).toBeLessThan(4096);
    expect(brief.text.indexOf("Pinned note")).toBeLessThan(brief.text.indexOf("Learned 0"));
    expect(brief.text).toContain("including the team workspace");
    expect(brief.given[0]).toEqual({ eventId: null, workspace: "me", title: "Pinned note", source: "pinned" });
    expect(brief.given.length).toBeLessThanOrEqual(9);
  });

  test("includes the project repository and active browser tab when present", () => {
    const pins = [{ eventId: null, workspace: "me", title: "Pinned note", content: "Pinned body", url: null, pinnedAt: 1 }];
    const activeTab = {
      title: "Acme App Dashboard",
      url: "https://acme.example.com/dashboard",
    };
    const brief = briefFor({
      projectName: "Acme",
      linkedWorkspace: null,
      pins,
      learned: [],
      projectRepo: "acme/acme-app",
      activeTab,
    })!;
    expect(brief.text).toContain("Ambient workspace context:");
    expect(brief.text).toContain("Project repository: acme/acme-app");
    expect(brief.text).toContain("Active browser tab: Acme App Dashboard (https://acme.example.com/dashboard)");
    expect(brief.given).toHaveLength(1);
    expect(brief.given[0].source).toBe("pinned");
  });
});

describe("use counting", () => {
  test("ranks what agents found most, then newest", () => {
    const saved = [record({ eventId: 1, savedAt: 3 }), record({ eventId: 2, savedAt: 1 }), record({ eventId: 3, projectId: "other" })];
    const counted = countUses(saved, [{ eventId: 2 }], 99);
    expect(counted.find((r) => r.eventId === 2)).toMatchObject({ uses: 1, lastUsedAt: 99 });
    expect(learnedFor("proj-1", counted).map((r) => r.eventId)).toEqual([2, 1]);
    expect(countUses(saved, [{ eventId: 42 }], 99)).toBe(saved);
  });
});

describe("stored data", () => {
  test("drops entries that no longer parse instead of failing", () => {
    expect(parseSaved([record({}), { eventId: "nope" }, null]).map((r) => r.eventId)).toEqual([1]);
    expect(parseSaved("garbage")).toEqual([]);
    expect(Object.keys(parseThreadLogs({ good: { given: [], searches: [], updatedAt: 1 }, bad: { given: 3 } }))).toEqual(["good"]);
  });
});

describe("thread log budget", () => {
  const hit = (eventId: number, content: string) => ({
    eventId,
    workspace: "me",
    title: `Memory ${eventId}`,
    content,
    url: null,
    similarity: null,
    occurredAt: null,
  });
  const log = (updatedAt: number, hits: number, chars: number) => ({
    given: [],
    searches: Array.from({ length: 30 }, (_, index) => ({
      query: "x".repeat(400),
      at: updatedAt + index,
      results: Array.from({ length: 20 }, (_, n) => hit(n, "y".repeat(chars))),
    })),
    updatedAt,
  });

  test("keeps the serialized logs inside the plugin KV limit", () => {
    const logs = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`thread-${index}`, log(index, 20, 600)]),
    );
    const capped = capThreadLogs(logs);
    const bytes = JSON.stringify(capped).length;
    expect(bytes).toBeLessThan(200 * 1024);
    expect(Object.keys(capped).length).toBeGreaterThan(0);
    // The 256KB write limit is what broke the panel; this keeps a real thread.
    expect(parseThreadLogs(capped)["thread-79"]).toBeDefined();
  });

  test("keeps the newest threads and shortens each hit", () => {
    const logs = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`thread-${index}`, log(index, 20, 600)]),
    );
    const capped = capThreadLogs(logs);
    const kept = Object.keys(capped);
    expect(kept[0]).toBe("thread-79");
    const first = capped["thread-79"]!;
    expect(first.searches.length).toBeLessThanOrEqual(20);
    expect(first.searches[0]!.results.length).toBeLessThanOrEqual(5);
    expect(first.searches[0]!.results[0]!.content.length).toBeLessThanOrEqual(200);
  });
});

describe("hitsFromSearch", () => {
  test("keeps saved memories, drops connector content, and builds Lobu links", () => {
    const hits = hitsFromSearch(
      {
        entity: { id: 5 },
        content: [
          { id: 7, title: "", text_content: "Body text here", similarity: 0.8, workspace_slug: "me", occurred_at: "2026-10-01", platform: "lobu", entity_ids: [42, 99] },
          { id: 8, title: "A web page", text_content: "Visited", similarity: 0.9, workspace_slug: "me", platform: "chrome.history" },
          { id: "x", workspace_slug: "me", platform: "lobu" },
        ],
      },
      "https://lobu.example",
    );
    expect(hits).toEqual([
      {
        eventId: 7,
        workspace: "me",
        title: "Body text here",
        content: "Body text here",
        url: "https://lobu.example/me/events/7",
        similarity: 0.8,
        occurredAt: "2026-10-01",
        entityIds: [42, 99],
      },
    ]);
  });
});

describe("entitiesFromSearch", () => {
  test("extracts unique entities from entity and matches", () => {
    const entities = entitiesFromSearch(
      {
        entity: { id: 10, name: "Acme", slug: "acme", type: "company", workspace_slug: "team" },
        matches: [
          { id: 10, name: "Acme duplicate", slug: "acme", type: "company", workspace_slug: "team" },
          { id: 20, name: "Project Lobu", slug: "lobu", type: "project", workspace_slug: "team" },
        ],
      },
      "https://lobu.example",
      "team",
    );
    expect(entities).toEqual([
      { id: 10, type: "company", name: "Acme", slug: "acme", workspace: "team", url: "https://lobu.example/team/company/acme" },
      { id: 20, type: "project", name: "Project Lobu", slug: "lobu", workspace: "team", url: "https://lobu.example/team/project/lobu" },
    ]);
  });
});

describe("groupBySession", () => {
  const log = (given: number, searches: number) => ({
    given: Array.from({ length: given }, (_, i) => ({ eventId: i, workspace: "acme", title: `m${i}`, source: "learned" as const })),
    searches: Array.from({ length: searches }, (_, i) => ({ query: `q${i}`, at: i, results: [] })),
    updatedAt: 1,
  });

  test("groups by session, marks saves after archiving as the recap, and names terminal and project saves", () => {
    const threads = new Map([["thr_a", { title: "Fix the login banner", projectName: "Acme", archivedAt: 500 }]]);
    const sessions = groupBySession(
      [
        record({ eventId: 4, threadId: "thr_a", savedAt: 600 }),
        record({ eventId: 3, threadId: "cli", savedAt: 450, projectId: "p1" }),
        record({ eventId: 2, threadId: "thr_a", savedAt: 400 }),
        record({ eventId: 1, threadId: "project:p1", savedAt: 300, projectId: "p1" }),
      ],
      threads,
      { thr_a: log(8, 2) },
      (projectId) => (projectId === "p1" ? "Acme" : null),
    );
    expect(sessions.map((s) => [s.threadId, s.kind, s.title, s.projectName])).toEqual([
      ["thr_a", "thread", "Fix the login banner", "Acme"],
      ["cli", "terminal", null, "Acme"],
      ["project:p1", "project", null, "Acme"],
    ]);
    expect(sessions[0]?.archived).toBe(true);
    expect([sessions[0]?.startedWith, sessions[0]?.lookedUp]).toEqual([8, 2]);
    expect(sessions[0]?.records.map((r) => [r.eventId, r.recap])).toEqual([
      [4, true],
      [2, false],
    ]);
  });

  test("a thread bb no longer has keeps its saves, untitled and not a recap", () => {
    const [session] = groupBySession([record({ eventId: 9, threadId: "thr_gone", savedAt: 900 })], new Map(), {}, () => null);
    expect([session?.kind, session?.title, session?.archived, session?.records[0]?.recap]).toEqual(["thread", null, false, false]);
    expect([session?.startedWith, session?.lookedUp]).toEqual([null, null]);
  });
});
