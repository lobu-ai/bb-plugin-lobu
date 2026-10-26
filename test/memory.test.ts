import { describe, expect, test } from "bun:test";
import { rememberSubmissionSchema } from "../lib/memory-contract";
import type { LobuApi, SaveMemoryInput } from "../lib/lobu-api";
import {
  describeOutcome,
  draftFromText,
  idempotencyKey,
  outcomeForAgent,
  pickWorkspace,
  saveMemories,
} from "../lib/memory";
import type { WorkspaceOwner } from "../lib/snapshot";

const BASE = "https://lobu.example";
const owner = (overrides: Partial<WorkspaceOwner> = {}): WorkspaceOwner => ({
  context: null,
  name: "Acme",
  personal: false,
  ...overrides,
});

function fakeApi(fail: (memory: SaveMemoryInput) => boolean = () => false) {
  const saves: { context: string | null; workspace: string; memory: SaveMemoryInput }[] = [];
  const api = {
    saveMemory: async (context: string | null, workspace: string, memory: SaveMemoryInput) => {
      saves.push({ context, workspace, memory });
      if (fail(memory)) throw new Error("semantic_type rejected");
      return { id: saves.length, viewUrl: `/${workspace}/events?id=${saves.length}` };
    },
  } as unknown as LobuApi;
  return { api, saves };
}

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

describe("pickWorkspace", () => {
  const owners = new Map([
    ["acme", owner()],
    ["me", owner({ personal: true })],
  ]);
  test("prefers the remembered choice, then the personal workspace, then the first", () => {
    expect(pickWorkspace(owners, "acme")).toBe("acme");
    expect(pickWorkspace(owners, "gone")).toBe("me");
    expect(pickWorkspace(new Map([["acme", owner()]]), null)).toBe("acme");
    expect(pickWorkspace(new Map(), null)).toBeNull();
  });
});

describe("saveMemories", () => {
  const submission = rememberSubmissionSchema.parse({
    workspace: "acme",
    memories: [
      { title: "Use bun", content: "The repo blocks npm.", kind: "preference" },
      { title: "Bad kind", content: "This one fails.", kind: "fact" },
    ],
  });

  test("saves each kept memory with its kind and reports failures per memory", async () => {
    const { api, saves } = fakeApi((memory) => memory.title === "Bad kind");
    const outcome = await saveMemories(api, owner({ context: "work" }), BASE, "thread-1", submission);
    expect(saves.map((s) => [s.context, s.workspace, s.memory.semantic_type])).toEqual([
      ["work", "acme", "preference"],
      ["work", "acme", "fact"],
    ]);
    expect(outcome).toEqual({
      workspace: "acme",
      saved: [{ title: "Use bun", url: `${BASE}/acme/events?id=1` }],
      failed: [{ title: "Bad kind", error: "semantic_type rejected" }],
    });
    expect(describeOutcome(outcome)).toEqual({
      title: "Saved 1 of 2 memories to acme",
      detail: `- [Use bun](${BASE}/acme/events?id=1)\n- Not saved: Bad kind (semantic_type rejected)`,
    });
  });

  test("sends a stable idempotency key so a resubmit cannot duplicate", async () => {
    const first = fakeApi();
    const second = fakeApi();
    await saveMemories(first.api, owner(), BASE, "thread-1", submission);
    await saveMemories(second.api, owner(), BASE, "thread-1", submission);
    expect(first.saves.map((s) => s.memory.idempotency_key)).toEqual(second.saves.map((s) => s.memory.idempotency_key));
    const [a, b] = first.saves;
    expect(a?.memory.idempotency_key).not.toBe(b?.memory.idempotency_key);
    expect(idempotencyKey("thread-2", "acme", submission.memories[0]!)).not.toBe(a?.memory.idempotency_key);
  });
});

describe("outcomeForAgent", () => {
  test("tells the agent what happened", () => {
    expect(outcomeForAgent(null)).toContain("chose not to save");
    expect(outcomeForAgent({ workspace: "acme", saved: [], failed: [] })).toBe(
      "Saved nothing to Lobu. The user unticked every proposed memory.",
    );
    expect(outcomeForAgent({ workspace: "acme", saved: [{ title: "Use bun", url: null }], failed: [] })).toBe(
      "Saved 1 memory to acme:\n- Use bun",
    );
  });
});
