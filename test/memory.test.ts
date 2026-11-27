import { describe, expect, test } from "bun:test";
import { memoryDraftSchema, memoryProposalSchema } from "../lib/memory-contract";
import { draftFromText, idempotencyKey } from "../lib/memory";
describe("draftFromText", () => {
  test("uses the first non-empty line as the title", () => {
    expect(draftFromText("\n  Lobu rejects bound tokens on REST\nUse MCP instead.")).toEqual({
      title: "Lobu rejects bound tokens on REST",
      content: "Lobu rejects bound tokens on REST\nUse MCP instead.",
      kind: "note",
    });
  });

  test("shortens a long first line", () => {
    const draft = draftFromText("x".repeat(200));
    expect(draft.title).toHaveLength(80);
    expect(draft.title.endsWith("…")).toBe(true);
    expect(draft.content).toHaveLength(200);
  });
});

describe("proposal schemas", () => {
  const legacy = { title: "Staging needs VPN", content: "Staging deploys need the office VPN.", kind: "fact" as const };
  test("older drafts without evidence or workspace still parse", () => {
    expect(memoryDraftSchema.safeParse(legacy).success).toBe(true);
  });
  test("new proposals require evidence", () => {
    expect(memoryProposalSchema.safeParse(legacy).success).toBe(false);
    expect(
      memoryProposalSchema.safeParse({ ...legacy, evidence: "User: staging fails on office wifi" }).success,
    ).toBe(true);
  });
  test("accepts entityIds and normalizes entity_ids alias", () => {
    const withCamel = memoryProposalSchema.safeParse({
      ...legacy,
      evidence: "User: staging fails",
      entityIds: [42, 99],
    });
    expect(withCamel.success).toBe(true);
    if (withCamel.success) expect(withCamel.data.entityIds).toEqual([42, 99]);

    const withSnake = memoryProposalSchema.safeParse({
      ...legacy,
      evidence: "User: staging fails",
      entity_ids: [123],
    });
    expect(withSnake.success).toBe(true);
    if (withSnake.success) expect(withSnake.data.entityIds).toEqual([123]);
  });
  test("accepts the event id of a memory the proposal contradicts", () => {
    const parsed = memoryProposalSchema.safeParse({ ...legacy, evidence: "User: staging moved", conflictsWithEventId: 42 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.conflictsWithEventId).toBe(42);
  });
});

describe("idempotencyKey", () => {
  const memory = { title: "Use bun", content: "The repo blocks npm.", kind: "preference" as const };
  test("is stable for the same thread, workspace, and memory, so a retry cannot duplicate", () => {
    expect(idempotencyKey("thread-1", "acme", memory)).toBe(idempotencyKey("thread-1", "acme", { ...memory }));
    expect(idempotencyKey("thread-2", "acme", memory)).not.toBe(idempotencyKey("thread-1", "acme", memory));
    expect(idempotencyKey("thread-1", "acme", { ...memory, replacesEventId: 7 })).not.toBe(
      idempotencyKey("thread-1", "acme", memory),
    );
  });
});
