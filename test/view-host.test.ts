import { describe, expect, test } from "bun:test";
import {
  coerceViewParams,
  directiveTarget,
  planEmbeds,
  readOnlyToolNames,
  VIEW_EMBED_MAX_COUNT,
  viewCallRequest,
} from "../lib/view-host";

const mounted = { workspace: "acme", view: "pipeline", contentHash: "hash-1", title: "Pipeline" };
const none = new Set<string>();

describe("viewCallRequest", () => {
  test("SDK reads pass and take the view's title when they carry none", () => {
    expect(viewCallRequest(mounted, "query_sql", { sql: "select 1" }, none)).toEqual({
      path: "/api/acme/query_sql",
      body: { sql: "select 1", title: "Pipeline" },
    });
    expect(viewCallRequest(mounted, "query_sdk", { code: "x", title: "Own" }, none)).toEqual({
      path: "/api/acme/query_sdk",
      body: { code: "x", title: "Own" },
    });
  });

  test("a mixed tool passes only for its read actions", () => {
    expect(viewCallRequest(mounted, "manage_entity", { action: "list" }, none)).toEqual({
      path: "/api/acme/manage_entity",
      body: { action: "list" },
    });
    expect("error" in viewCallRequest(mounted, "manage_entity", { action: "delete" }, none)).toBe(true);
  });

  test("a write tool is refused unless the registry marks it read-only", () => {
    expect("error" in viewCallRequest(mounted, "save_memory", { content: "x" }, none)).toBe(true);
    expect(viewCallRequest(mounted, "get_automation", { id: 1 }, new Set(["get_automation"]))).toEqual({
      path: "/api/acme/get_automation",
      body: { id: 1 },
    });
  });

  test("an action runs only for the mounted view, naming the bundle on screen", () => {
    expect(
      viewCallRequest(mounted, "invoke_view_action", { view: "pipeline", action: "approve", value: { ok: true }, interaction_id: "i-1" }, none),
    ).toEqual({
      path: "/api/acme/views/pipeline/actions/approve",
      body: { value: { ok: true }, interaction_id: "i-1", expected_content_hash: "hash-1" },
    });
    expect("error" in viewCallRequest(mounted, "invoke_view_action", { view: "other", action: "approve" }, none)).toBe(true);
    expect("error" in viewCallRequest(mounted, "invoke_view_action", { view: "pipeline", action: "" }, none)).toBe(true);
    expect(
      "error" in viewCallRequest(mounted, "invoke_view_action", { view: "pipeline", action: "approve", scope: { event: 9 } }, none),
    ).toBe(true);
  });

  test("an action on an event view names that event, and only that one", () => {
    const onEvent = { ...mounted, event: 9 };
    expect(
      viewCallRequest(onEvent, "invoke_view_action", { view: "pipeline", action: "approve", interaction_id: "i-1", scope: { event: 9 } }, none),
    ).toEqual({
      path: "/api/acme/views/pipeline/actions/approve",
      body: { value: null, interaction_id: "i-1", expected_content_hash: "hash-1", scope: { event: 9 } },
    });
    expect(
      "error" in viewCallRequest(onEvent, "invoke_view_action", { view: "pipeline", action: "approve", scope: { event: 10 } }, none),
    ).toBe(true);
  });

  test("workspace and tool names are path-encoded", () => {
    const planned = viewCallRequest({ ...mounted, workspace: "a/b" }, "query_sql", {}, none);
    expect("path" in planned && planned.path).toBe("/api/a%2Fb/query_sql");
  });
});

describe("readOnlyToolNames", () => {
  test("keeps only tools annotated readOnlyHint true", () => {
    const listing = {
      tools: [
        { name: "read_knowledge", annotations: { readOnlyHint: true } },
        { name: "save_memory", annotations: { readOnlyHint: false } },
        { name: "query_sql" },
        { annotations: { readOnlyHint: true } },
      ],
    };
    expect([...readOnlyToolNames(listing)]).toEqual(["read_knowledge"]);
    expect(readOnlyToolNames(null).size).toBe(0);
  });
});

describe("directiveTarget", () => {
  test("splits the view, its subject and its params", () => {
    expect(directiveTarget({ workspace: "acme", view: "deal", "scope-event": "42", section: "2" })).toEqual({
      workspace: "acme",
      view: "deal",
      scope: { event: 42 },
      params: { section: "2" },
    });
    expect(directiveTarget({ workspace: "acme", view: "card", "scope-type": "company", "scope-entity": "7" })).toMatchObject({
      scope: { type: "company", entity: 7 },
    });
    expect(directiveTarget({ workspace: "acme", view: "card", "scope-type": "repo", "scope-entity": "lobu-ai/lobu" })).toMatchObject({
      scope: { type: "repo", entity: "lobu-ai/lobu" },
    });
  });

  test("a view param named like a scope field stays a param", () => {
    expect(directiveTarget({ workspace: "acme", view: "compare", type: "product", event: "x" })).toEqual({
      workspace: "acme",
      view: "compare",
      scope: {},
      params: { type: "product", event: "x" },
    });
  });

  test("refuses a subject open_view would refuse", () => {
    expect("error" in directiveTarget({ workspace: "acme", view: "deal", "scope-event": "x" })).toBe(true);
    expect("error" in directiveTarget({ workspace: "acme", view: "deal", "scope-event": "4", "scope-type": "company" })).toBe(true);
    expect("error" in directiveTarget({ workspace: "acme", view: "card", "scope-entity": "lobu-ai/lobu" })).toBe(true);
    expect("error" in directiveTarget({ view: "deal" })).toBe(true);
  });
});

describe("coerceViewParams", () => {
  test("types string params by their declarations and leaves the rest", () => {
    const declared = { limit: { type: "number" }, open: { type: "boolean" }, name: { type: "string" } };
    expect(coerceViewParams(declared, { limit: "20", open: "false", name: "7", other: "x", bad: "nan" })).toEqual({
      limit: 20,
      open: false,
      name: "7",
      other: "x",
      bad: "nan",
    });
    expect(coerceViewParams(declared, { limit: "lots" })).toEqual({ limit: "lots" });
    expect(coerceViewParams(undefined, { limit: "3" })).toEqual({ limit: "3" });
  });
});

describe("planEmbeds", () => {
  const rect = { x: 0, y: 0, width: 100, height: 80 };
  const slot = (id: string, view: string, extra: Record<string, unknown> = {}) => ({ id, view, scope: {}, params: {}, rect, ...extra });

  test("mounts valid slots and refuses cycles, bad shapes and duplicates", () => {
    const { instances, statuses } = planEmbeds(
      [
        slot("a", "child"),
        slot("b", "parent"),
        slot("c", "other", { scope: { event: 3, type: "company" } }),
        slot("a", "child"),
        { view: "no-id" },
        slot("d", "other", { rect: { x: 0, y: 0, width: -1, height: 1 } }),
      ],
      ["parent"],
    );
    expect(instances.map((i) => i.id)).toEqual(["a"]);
    expect(statuses).toEqual([
      { id: "a", status: "mounted" },
      { id: "b", status: "refused", reason: "cycle" },
      { id: "c", status: "refused", reason: "invalid" },
      { id: "a", status: "refused", reason: "invalid" },
      { id: "d", status: "refused", reason: "invalid" },
    ]);
  });

  test("bounds depth and count", () => {
    expect(planEmbeds([slot("a", "x")], ["top", "child", "grandchild"]).statuses).toEqual([
      { id: "a", status: "refused", reason: "depth" },
    ]);
    const many = Array.from({ length: VIEW_EMBED_MAX_COUNT + 1 }, (_, i) => slot(`s${i}`, "x"));
    const planned = planEmbeds(many, ["top"]);
    expect(planned.instances).toHaveLength(VIEW_EMBED_MAX_COUNT);
    expect(planned.statuses.at(-1)).toEqual({ id: `s${VIEW_EMBED_MAX_COUNT}`, status: "refused", reason: "limit" });
  });
});
