import { describe, expect, test } from "bun:test";
import { recapPrompt, transcriptFromEvents, worthRecapping } from "../lib/distill";

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
    expect(worthRecapping(transcript)).toBe(false);
  });

  test("skips empty input and is not worth a recap without an answer", () => {
    const transcript = transcriptFromEvents([userTurn("  "), userTurn("hello"), { type: "x" }, null]);
    expect(transcript.userTurns).toBe(1);
    expect(worthRecapping(transcript)).toBe(false);
  });

  test("needs a real back-and-forth before a recap", () => {
    const twoTurns = transcriptFromEvents([userTurn("a"), agentMessage("b"), userTurn("c")]);
    expect(worthRecapping(twoTurns)).toBe(false);
    const threeTurns = transcriptFromEvents([userTurn("a"), agentMessage("b"), userTurn("c"), agentMessage("d"), userTurn("e")]);
    expect(worthRecapping(threeTurns)).toBe(true);
  });

  test("skips threads ending in diffs or status dumps", () => {
    const dump = transcriptFromEvents([
      userTurn("one"),
      userTurn("two"),
      userTurn("three"),
      agentMessage(`done\n\`\`\`diff\n+++ a\n--- b\ndiff --git a/x b/x\n\`\`\``),
    ]);
    expect(worthRecapping(dump)).toBe(false);
  });

  test("keeps the opening and the ending of a long conversation", () => {
    const transcript = transcriptFromEvents([userTurn("first ".repeat(10_000)), agentMessage("the latest answer")]);
    expect(transcript.text.startsWith("User: first")).toBe(true);
    expect(transcript.text).toContain("[middle messages omitted]");
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

  test("expects nothing to keep and caps proposals at three", () => {
    const prompt = recapPrompt("Anything", "User: hi");
    expect(prompt).toContain('"Nothing to keep."');
    expect(prompt).toContain("at most three");
  });
});
