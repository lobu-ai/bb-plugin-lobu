// Save to Lobu: turns reviewed drafts into Lobu memories with save_memory,
// through the same CLI login the dashboard reads with.
import { createHash } from "node:crypto";
import type { MemoryDraft, RememberSubmission } from "./memory-contract";
import type { LobuApi } from "./lobu-api";
import type { WorkspaceOwner } from "./snapshot";

const TITLE_MAX = 80;

export interface SaveOutcome {
  workspace: string;
  saved: { title: string; url: string | null }[];
  failed: { title: string; error: string }[];
}

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

/** The remembered choice when it is still available, else the personal workspace, else the first. */
export function pickWorkspace(owners: Map<string, WorkspaceOwner>, preferred: string | null): string | null {
  if (preferred !== null && owners.has(preferred)) return preferred;
  for (const [slug, owner] of owners) if (owner.personal) return slug;
  return owners.keys().next().value ?? null;
}

/** A draft's workspace hint matched to a granted workspace, by slug then case-insensitive name. */
export function matchWorkspaceHint(owners: Map<string, WorkspaceOwner>, hint: string | null | undefined): string | null {
  if (hint === null || hint === undefined) return null;
  const text = hint.trim();
  if (text === "") return null;
  if (owners.has(text)) return text;
  const lower = text.toLowerCase();
  for (const [slug, owner] of owners) {
    if (slug.toLowerCase() === lower || owner.name.toLowerCase() === lower) return slug;
  }
  return null;
}

/** A unanimous valid hint wins; otherwise the remembered choice, with a note when hints disagree. */
export function pickWorkspaceWithHints(
  owners: Map<string, WorkspaceOwner>,
  preferred: string | null,
  hints: readonly (string | null | undefined)[],
): { workspace: string | null; note: string | null } {
  const matched = hints.map((hint) => matchWorkspaceHint(owners, hint));
  const distinct = [...new Set(matched.filter((slug): slug is string => slug !== null))];
  if (distinct.length === 1) return { workspace: distinct[0], note: null };
  const workspace = pickWorkspace(owners, preferred);
  if (distinct.length === 0) return { workspace, note: null };
  return {
    workspace,
    note: `Drafts suggest different workspaces (${distinct.sort().join(", ")}); check before saving.`,
  };
}

/** Same thread, workspace, and text saves once, even if the form is submitted twice. */
export function idempotencyKey(threadId: string, workspace: string, memory: MemoryDraft): string {
  const digest = createHash("sha256").update(`${threadId}\n${workspace}\n${memory.title}\n${memory.content}`).digest("hex");
  return `bb-plugin-lobu:${digest}`;
}

export async function saveMemories(
  api: LobuApi,
  owner: WorkspaceOwner,
  baseUrl: string,
  threadId: string,
  submission: RememberSubmission,
): Promise<SaveOutcome> {
  const { workspace } = submission;
  const results = await Promise.all(
    submission.memories.map(async (memory) => {
      try {
        const saved = await api.saveMemory(owner.context, workspace, {
          title: memory.title,
          content: memory.content,
          semantic_type: memory.kind,
          idempotency_key: idempotencyKey(threadId, workspace, memory),
        });
        const url = saved.viewUrl === null ? null : saved.viewUrl.startsWith("http") ? saved.viewUrl : baseUrl + saved.viewUrl;
        return { ok: true as const, title: memory.title, url };
      } catch (cause) {
        return { ok: false as const, title: memory.title, error: cause instanceof Error ? cause.message : String(cause) };
      }
    }),
  );
  return {
    workspace,
    saved: results.filter((r) => r.ok).map(({ title, url }) => ({ title, url })),
    failed: results.filter((r) => !r.ok).map(({ title, error }) => ({ title, error })),
  };
}

const plural = (count: number) => `${count} ${count === 1 ? "memory" : "memories"}`;

/** The timeline row the form leaves behind. */
export function describeOutcome(outcome: SaveOutcome): { title: string; detail: string } {
  const { saved, failed, workspace } = outcome;
  const title =
    saved.length === 0 && failed.length === 0
      ? "Saved nothing to Lobu"
      : failed.length === 0
        ? `Saved ${plural(saved.length)} to ${workspace}`
        : `Saved ${saved.length} of ${saved.length + failed.length} memories to ${workspace}`;
  const lines = [
    ...saved.map((m) => `- ${m.url === null ? m.title : `[${m.title}](${m.url})`}`),
    ...failed.map((m) => `- Not saved: ${m.title} (${m.error})`),
  ];
  return { title, detail: lines.join("\n") };
}

/** What the agent hears back from lobu_remember. */
export function outcomeForAgent(outcome: SaveOutcome | null): string {
  if (outcome === null) return "The user chose not to save these memories. Do not propose them again.";
  const { title, detail } = describeOutcome(outcome);
  return detail === "" ? `${title}. The user unticked every proposed memory.` : `${title}:\n${detail}`;
}
