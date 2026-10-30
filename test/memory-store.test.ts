import { describe, expect, test } from "bun:test";
import type { SavedRecord } from "../lib/memory-contract";
import { briefFor, countUses, hitsFromSearch, learnedFor, parseSaved, parseThreadLogs } from "../lib/memory-store";

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

describe("hitsFromSearch", () => {
  test("keeps saved memories, drops connector content, and builds Lobu links", () => {
    const hits = hitsFromSearch(
      {
        entity: { id: 5 },
        content: [
          { id: 7, title: "", text_content: "Body text here", similarity: 0.8, workspace_slug: "me", occurred_at: "2026-10-01", platform: "lobu" },
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
      },
    ]);
  });
});
