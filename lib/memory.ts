// Save to Lobu helpers shared by the server's save paths: drafts from picked
// text, view links, and idempotency keys.
import { createHash } from "node:crypto";
import type { MemoryDraft } from "./memory-contract";

const TITLE_MAX = 80;

/** A draft from text the user picked in the timeline: first line as title, the rest as content. */
export function draftFromText(text: string): MemoryDraft {
  const content = text.trim().slice(0, 2000);
  const firstLine = content.split("\n").find((line) => line.trim() !== "") ?? content;
  const title = firstLine.trim();
  return {
    title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title,
    content,
    kind: "note",
  };
}

/** Lobu returns view links relative to its URL on some routes. */
export function absoluteUrl(viewUrl: string | null, baseUrl: string): string | null {
  if (viewUrl === null) return null;
  return viewUrl.startsWith("http") ? viewUrl : baseUrl + viewUrl;
}

/** Same thread, workspace, and text saves once, even when a save is retried. */
export function idempotencyKey(threadId: string, workspace: string, memory: MemoryDraft): string {
  const replaces = memory.replacesEventId ? `\nreplaces:${memory.replacesEventId}` : "";
  const ids = [...new Set(memory.entityIds ?? [])].sort((a, b) => a - b);
  const entities = ids.length > 0 ? `\nentities:${ids.join(",")}` : "";
  const digest = createHash("sha256")
    .update(`${threadId}\n${workspace}\n${memory.title}\n${memory.content}${replaces}${entities}`)
    .digest("hex");
  return `bb-plugin-lobu:${digest}`;
}
