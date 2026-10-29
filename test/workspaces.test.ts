import { describe, expect, test } from "bun:test";
import { LobuSetupError } from "../lib/cli";
import type { LobuApi } from "../lib/lobu-api";
import type { SavedRecord } from "../lib/memory-contract";
import { discoverWorkspaces, parseList, savedEventsPath } from "../lib/workspaces";

const fakeApi = (workspaces: (context: string | null) => Promise<{ slug: string; name: string; personal?: boolean }[]>) =>
  ({ workspaces: async (context: string | null) => (await workspaces(context)).map((w) => ({ personal: false, ...w })) }) as unknown as LobuApi;

const record = (eventId: number, workspace: string, savedAt: number): SavedRecord => ({
  eventId,
  workspace,
  title: `Memory ${eventId}`,
  content: "",
  kind: "fact",
  url: null,
  threadId: "thread-1",
  projectId: null,
  savedAt,
  uses: 0,
  lastUsedAt: null,
});

describe("parseList", () => {
  test("splits on commas and whitespace", () => {
    expect(parseList(" acme, beta  gamma,,")).toEqual(["acme", "beta", "gamma"]);
    expect(parseList("")).toEqual([]);
  });
});

describe("discoverWorkspaces", () => {
  test("gives each workspace to the first context that covers it", async () => {
    const api = fakeApi(async (context) =>
      context === "work" ? [{ slug: "acme", name: "Acme" }, { slug: "beta", name: "Beta" }] : [{ slug: "acme", name: "Acme" }],
    );
    const { owners, problem } = await discoverWorkspaces(api, ["work", "personal"]);
    expect([...owners].map(([slug, owner]) => [slug, owner.context])).toEqual([
      ["acme", "work"],
      ["beta", "work"],
    ]);
    expect(problem).toBeNull();
  });

  test("keeps working logins and reports a broken one", async () => {
    const api = fakeApi(async (context) => {
      if (context === "stale") throw new LobuSetupError("not_logged_in", context, "Lobu rejected the login for stale.");
      return [{ slug: "acme", name: "Acme" }];
    });
    const { owners, problem } = await discoverWorkspaces(api, ["work", "stale"]);
    expect([...owners.keys()]).toEqual(["acme"]);
    expect(problem).toBe("Lobu rejected the login for stale.");
  });
});

describe("savedEventsPath", () => {
  test("filters Lobu's events to the newest workspace's saves, newest first", () => {
    const saved = [record(1, "me", 10), record(2, "team", 30), record(3, "team", 20), record(4, "other", 40)];
    expect(savedEventsPath(saved, new Set(["me", "team"]))).toBe("/team/events?content_ids=2,3");
  });

  test("is null when nothing saved is reachable", () => {
    expect(savedEventsPath([record(1, "other", 10)], new Set(["me"]))).toBeNull();
    expect(savedEventsPath([], new Set(["me"]))).toBeNull();
  });

  test("caps the link at the newest hundred", () => {
    const saved = Array.from({ length: 120 }, (_, i) => record(i + 1, "me", i));
    const ids = savedEventsPath(saved, new Set(["me"]))!.split("content_ids=")[1]!.split(",");
    expect(ids).toHaveLength(100);
    expect(ids[0]).toBe("120");
  });
});
