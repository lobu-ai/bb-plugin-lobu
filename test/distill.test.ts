import { describe, expect, test } from "bun:test";
import {
  addPending,
  livePending,
  PENDING_MAX,
  PENDING_TTL_MS,
  type PendingRecap,
  recapPrompt,
  transcriptFromEvents,
  worthRecapping,
} from "../lib/distill";

const userTurn = (text: string) => ({
  type: "client/turn/requested",
  data: { input: [{ type: "text", text, mentions: [] }] },
});
const agentMessage = (text: string) => ({
  type: "item/completed",
  data: { item: { type: "agentMessage", id: "i1", text } },
});

describe("transcriptFromEvents", () => {
  test("keeps user turns and finished agent messages in order", () => {
    const transcript = transcriptFromEvents([
      userTurn("Why do staging deploys fail?"),
      { type: "item/completed", data: { item: { type: "commandExecution", command: "ls" } } },
      agentMessage("They need the office VPN."),
      { type: "turn/completed", data: {} },
    ]);
    expect(transcript).toEqual({
      text: "User: Why do staging deploys fail?\n\nAgent: They need the office VPN.",
      userTurns: 1,
      agentMessages: 1,
    });
    expect(worthRecapping(transcript)).toBe(true);
  });

  test("skips empty input and is not worth a recap without an answer", () => {
    const transcript = transcriptFromEvents([userTurn("  "), userTurn("hello"), { type: "x" }, null]);
    expect(transcript.userTurns).toBe(1);
    expect(worthRecapping(transcript)).toBe(false);
  });

  test("keeps the most recent part of a long conversation", () => {
    const transcript = transcriptFromEvents([userTurn("first ".repeat(10_000)), agentMessage("the latest answer")]);
    expect(transcript.text.startsWith("[earlier messages omitted]")).toBe(true);
    expect(transcript.text.endsWith("Agent: the latest answer")).toBe(true);
    expect(transcript.text.length).toBeLessThan(40_100);
  });
});

describe("recapPrompt", () => {
  test("fences the conversation as data", () => {
    const prompt = recapPrompt('Fix "deploys"', "User: hi");
    expect(prompt).toContain('"Fix \\"deploys\\""');
    expect(prompt).toContain("<<<CONVERSATION\nUser: hi\nCONVERSATION>>>");
    expect(prompt).toContain("lobu_remember");
  });
});

describe("pending recaps", () => {
  const recap = (id: string, sourceThreadId: string, createdAt: number): PendingRecap => ({
    id,
    sourceThreadId,
    sourceTitle: "Fix deploys",
    createdAt,
    drafts: [{ title: "Staging needs VPN", content: "Staging deploys need the office VPN.", kind: "fact" }],
  });

  test("drops expired and malformed entries", () => {
    const now = 10 * PENDING_TTL_MS;
    expect(livePending([recap("a", "t1", now - PENDING_TTL_MS - 1), recap("b", "t2", now - 1)], now).map((r) => r.id)).toEqual(["b"]);
    expect(livePending("garbage", now)).toEqual([]);
    expect(livePending(undefined, now)).toEqual([]);
  });

  test("replaces an earlier recap of the same thread and caps the list", () => {
    expect(addPending([recap("a", "t1", 1)], recap("b", "t1", 2)).map((r) => r.id)).toEqual(["b"]);
    let list: PendingRecap[] = [];
    for (let i = 0; i < PENDING_MAX + 3; i += 1) list = addPending(list, recap(`r${i}`, `t${i}`, i));
    expect(list).toHaveLength(PENDING_MAX);
    expect(list[0]?.id).toBe("r3");
  });
});
