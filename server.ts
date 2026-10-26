// bb-plugin-lobu — server entry. Reads Lobu through the user's `lobu` CLI login
// and serves one cached snapshot to the page over RPC. Save to Lobu reviews
// memories in a thread form and saves the ones the user keeps.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  type MemoryDraft,
  memoryDraftSchema,
  type MetricPin,
  metricPinsSchema,
  REMEMBER_RENDERER,
  type RememberForm,
  rememberSubmissionSchema,
  rpcContract,
  type Snapshot,
} from "./lib/contract";
import { createLobuApi } from "./lib/lobu-api";
import { describeOutcome, draftFromText, outcomeForAgent, pickWorkspace, type SaveOutcome, saveMemories } from "./lib/memory";
import { buildSnapshot, discoverWorkspaces, parseList } from "./lib/snapshot";

const CACHE_MS = 60_000;
/** How long a review form waits before it closes itself. */
const REVIEW_TIMEOUT_MS = 24 * 60 * 60_000;

const LEARN_PROMPT =
  "Look back over this thread and call lobu_remember with the learnings worth keeping across sessions: decisions, non-obvious facts or gotchas, and preferences I stated. Keep each one short and self-contained. Skip anything temporary, obvious from the code, or sensitive. If nothing is worth keeping, say so instead of calling the tool.";

function parsePins(value: string): MetricPin[] | null {
  try {
    const parsed = metricPinsSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end -= 1;
  return url.slice(0, end);
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    contexts: {
      type: "string",
      label: "Lobu CLI contexts",
      description:
        "Comma-separated `lobu` CLI contexts to read. Leave empty for the CLI's active context. Every workspace a login is authorized for appears. Add one with `lobu context add <name> --url https://app.lobu.ai/api/v1`, then `lobu login --context <name>`.",
      default: "",
    },
    hiddenWorkspaces: {
      type: "string",
      label: "Hidden workspaces",
      description: "Comma-separated workspace slugs to leave off the dashboard.",
      default: "",
    },
    metrics: {
      type: "string",
      label: "Pinned metrics",
      description:
        'JSON array of metric queries. Example: [{"workspace":"acme","entity_type":"company","measure":"spend","by":["month"],"label":"Spend by month"}]. The Metrics card lists the measures each workspace declares.',
      experimental_multiline: true,
      experimental_schema: z
        .string()
        .refine(
          (value) => parsePins(value) !== null,
          "Use a JSON array of { workspace, entity_type, measure, by?, segment?, label? }",
        ),
      default: "[]",
    },
    baseUrl: {
      type: "string",
      label: "Lobu URL",
      description: "Change this only for a self-hosted Lobu.",
      default: "https://app.lobu.ai",
    },
    lobuBin: {
      type: "string",
      label: "lobu CLI path",
      description: "Leave empty to use ~/.bun/bin/lobu, then `lobu` on PATH.",
      default: "",
    },
  });

  async function apiOptions() {
    const { baseUrl, lobuBin } = await settings.get();
    return { baseUrl: trimTrailingSlashes(baseUrl.trim()), lobuBin: lobuBin.trim() };
  }

  let api = createLobuApi(await apiOptions());
  let cached: { at: number; snapshot: Snapshot } | null = null;
  let inFlight: Promise<Snapshot> | null = null;

  async function snapshot(refresh: boolean): Promise<Snapshot> {
    if (!refresh && cached !== null && Date.now() - cached.at < CACHE_MS) return cached.snapshot;
    inFlight ??= (async () => {
      const { contexts, hiddenWorkspaces, metrics } = await settings.get();
      const named = parseList(contexts);
      return buildSnapshot(api, {
        contexts: named.length === 0 ? [null] : named,
        hiddenWorkspaces: new Set(parseList(hiddenWorkspaces)),
        baseUrl: (await apiOptions()).baseUrl,
        pins: parsePins(metrics) ?? [],
        now: Date.now(),
      });
    })().finally(() => {
      inFlight = null;
    });
    const next = await inFlight;
    cached = { at: Date.now(), snapshot: next };
    return next;
  }

  settings.onChange(async () => {
    api = createLobuApi(await apiOptions());
    cached = null;
  });

  /** The workspace the user last saved memories to. */
  const PREFERRED_WORKSPACE = "memoryWorkspace";

  /**
   * Shows the review form in the thread and saves what the user keeps.
   * Resolves to null when the user skips. Nothing is saved without a submit.
   */
  async function review(
    threadId: string,
    drafts: MemoryDraft[],
    signal?: AbortSignal,
  ): Promise<SaveOutcome | null> {
    const { contexts, hiddenWorkspaces } = await settings.get();
    const named = parseList(contexts);
    const hidden = new Set(parseList(hiddenWorkspaces));
    const { owners, setup } = await discoverWorkspaces(api, named.length === 0 ? [null] : named);
    for (const slug of hidden) owners.delete(slug);
    if (owners.size === 0) throw new Error(setup?.message ?? "No Lobu workspace is available. Open the Lobu page for setup steps.");
    const preferred = (await bb.storage.kv.get<string>(PREFERRED_WORKSPACE)) ?? null;
    const form: RememberForm = {
      drafts,
      workspaces: [...owners].map(([slug, owner]) => ({ slug, name: owner.name })),
      workspace: pickWorkspace(owners, preferred),
    };
    let outcome: SaveOutcome | null = null;
    const result = await bb.ui.requestInput(
      {
        threadId,
        rendererId: REMEMBER_RENDERER,
        title: "Save to Lobu",
        payload: form,
        timeoutMs: REVIEW_TIMEOUT_MS,
        presentation: {
          label: { pending: "Review memories for Lobu", completed: "Reviewed memories for Lobu" },
          icon: { glyph: "lobu/lobu" },
        },
        // Saving here lets the row name exactly what was saved.
        async describeSubmission(value) {
          const submission = rememberSubmissionSchema.parse(value);
          const owner = owners.get(submission.workspace);
          if (owner === undefined) throw new Error(`Unknown workspace ${submission.workspace}`);
          outcome = await saveMemories(api, owner, (await apiOptions()).baseUrl, threadId, submission);
          await bb.storage.kv.set(PREFERRED_WORKSPACE, submission.workspace);
          return describeOutcome(outcome);
        },
      },
      { signal },
    );
    if (result.outcome === "cancelled") return null;
    if (outcome === null) throw new Error("The memories were not saved.");
    return outcome;
  }

  bb.agents.registerTool({
    name: "lobu_remember",
    description:
      "Propose memories to save to the user's Lobu workspace memory. The user reviews, edits, and picks the workspace in a form before anything is saved.",
    instructions:
      "When a task leaves something worth keeping across sessions (a decision, a non-obvious fact or gotcha, a preference the user stated), call lobu_remember once at the end with at most five short, self-contained memories. Never include secrets, credentials, or temporary state. Use lobu_remember rather than other memory-saving tools, because it shows the user a review form.",
    presentation: {
      label: { pending: "Proposing memories for Lobu", completed: "Proposed memories for Lobu" },
      icon: { glyph: "lobu/lobu" },
    },
    parameters: z.object({ memories: z.array(memoryDraftSchema).min(1).max(10) }),
    async execute({ memories }, { threadId, signal }) {
      try {
        return outcomeForAgent(await review(threadId, memories, signal));
      } catch (cause) {
        return { content: [{ type: "text", text: cause instanceof Error ? cause.message : String(cause) }], isError: true };
      }
    },
  });

  bb.rpc.register(rpcContract, {
    snapshot: ({ refresh }) => snapshot(refresh),
    remember: async ({ threadId, text }) => {
      // The form stays open until the user answers, so do not hold the RPC.
      const opened = review(threadId, [draftFromText(text)]);
      const early = await Promise.race([
        opened.then(
          () => null,
          (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
        ),
        new Promise<"open">((resolve) => setTimeout(() => resolve("open"), 1500)),
      ]);
      opened.catch((cause: unknown) => bb.log.warn(`Save to Lobu failed: ${String(cause)}`));
      return early === "open" || early === null ? { opened: true, error: null } : { opened: false, error: early };
    },
    learn: async ({ threadId }) => {
      await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text: LEARN_PROMPT, mentions: [] }] });
      return { sent: true };
    },
  });
}
