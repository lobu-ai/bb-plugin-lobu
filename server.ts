// bb-plugin-lobu — server entry. Reads Lobu through the user's `lobu` CLI login
// and serves one cached snapshot to the page over RPC. Save to Lobu reviews
// memories in a thread form and saves the ones the user keeps; recaps of
// archived threads wait on the Lobu page for the same review.
import { randomUUID } from "node:crypto";
import type { BbPluginApi, PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { type MetricPin, metricPinsSchema, rpcContract, type Snapshot } from "./lib/contract";
import { createLobuApi } from "./lib/lobu-api";
import {
  type MemoryDraft,
  memoryProposalSchema,
  REMEMBER_RENDERER,
  type RememberForm,
  rememberSubmissionSchema,
} from "./lib/memory-contract";
import { describeOutcome, draftFromText, outcomeForAgent, pickWorkspaceWithHints, type SaveOutcome, saveMemories } from "./lib/memory";
import { buildSnapshot, discoverWorkspaces, parseList, type WorkspaceOwner } from "./lib/snapshot";
import {
  addPending,
  livePending,
  type PendingRecap,
  RECAP_SOURCE_KEY,
  RECAP_TITLE_KEY,
  recapPrompt,
  TRANSCRIPT_EVENT_TYPES,
  transcriptFromEvents,
  worthRecapping,
} from "./lib/distill";

const CACHE_MS = 60_000;
/** How long a review form waits before it closes itself. */
const REVIEW_TIMEOUT_MS = 24 * 60 * 60_000;
/** How long a recap thread may take before it is stopped. */
const RECAP_TIMEOUT_MS = 10 * 60_000;

const LEARN_PROMPT =
  "Look back over this thread and call lobu_remember with the learnings worth keeping across sessions: decisions, non-obvious facts or gotchas, and preferences I stated as standing rules. Most threads contain nothing worth keeping; if so, say so instead of calling the tool. Never propose what this thread built or changed, anything the repo or code already states, generic quality wishes, or task requirements restated as preferences. At most three short, self-contained memories, each with a short evidence quote of the turn or finding it came from. Skip anything temporary, obvious from the code, already saved to Lobu, or sensitive.";

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
    recapOnArchive: {
      type: "boolean",
      label: "Recap archived threads",
      description:
        "When you archive a thread, a hidden agent reads it and proposes memories worth keeping. They wait on the Lobu page until you review them; nothing is saved without you. Each recap is one agent turn.",
      default: false,
    },
    recapProvider: {
      type: "string",
      label: "Recap provider",
      description: "Provider id for recaps, such as acp-opencode. Leave empty to use the archived thread's provider.",
      default: "",
    },
    recapModel: {
      type: "string",
      label: "Recap model",
      description: "Model for recaps. Leave empty for the provider's default. A small, cheap model is enough.",
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

  /** Every CLI login on this Lobu, or the CLI's active context when it cannot list them. */
  async function loginContexts(): Promise<(string | null)[]> {
    return (await api.contexts()) ?? [null];
  }

  async function snapshot(refresh: boolean): Promise<Snapshot> {
    if (!refresh && cached !== null && Date.now() - cached.at < CACHE_MS) return cached.snapshot;
    inFlight ??= (async () => {
      const { hiddenWorkspaces, metrics } = await settings.get();
      return buildSnapshot(api, {
        contexts: await loginContexts(),
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

  /** The review form for these drafts, with the workspaces the user can save to. */
  async function formFor(drafts: MemoryDraft[]): Promise<{ owners: Map<string, WorkspaceOwner>; form: RememberForm }> {
    const { hiddenWorkspaces } = await settings.get();
    const { owners, setup } = await discoverWorkspaces(api, await loginContexts());
    for (const slug of parseList(hiddenWorkspaces)) owners.delete(slug);
    if (owners.size === 0) throw new Error(setup?.message ?? "No Lobu workspace is available. Open the Lobu page for setup steps.");
    const preferred = (await bb.storage.kv.get<string>(PREFERRED_WORKSPACE)) ?? null;
    const picked = pickWorkspaceWithHints(
      owners,
      preferred,
      drafts.map((draft) => draft.workspace ?? null),
    );
    const form: RememberForm = {
      drafts,
      workspaces: [...owners].map(([slug, owner]) => ({ slug, name: owner.name })),
      workspace: picked.workspace,
      workspaceNote: picked.note,
    };
    return { owners, form };
  }

  /** Saves a submitted review and remembers the workspace for next time. */
  async function save(owners: Map<string, WorkspaceOwner>, threadId: string, value: unknown): Promise<SaveOutcome> {
    const submission = rememberSubmissionSchema.parse(value);
    const owner = owners.get(submission.workspace);
    if (owner === undefined) throw new Error(`Unknown workspace ${submission.workspace}`);
    const outcome = await saveMemories(api, owner, (await apiOptions()).baseUrl, threadId, submission);
    await bb.storage.kv.set(PREFERRED_WORKSPACE, submission.workspace);
    return outcome;
  }

  /**
   * Shows the review form in the thread and saves what the user keeps.
   * Resolves to null when the user skips. Nothing is saved without a submit.
   */
  async function review(
    threadId: string,
    drafts: MemoryDraft[],
    signal?: AbortSignal,
  ): Promise<SaveOutcome | null> {
    const { owners, form } = await formFor(drafts);
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
          outcome = await save(owners, threadId, value);
          return describeOutcome(outcome);
        },
      },
      { signal },
    );
    if (result.outcome === "cancelled") return null;
    if (outcome === null) throw new Error("The memories were not saved.");
    return outcome;
  }

  // Recaps of archived threads wait here until the user reviews them on the Lobu page.
  const PENDING = "pendingRecaps";
  let pendingLock: Promise<unknown> = Promise.resolve();
  /** Serializes read-modify-write of the pending list. */
  function updatePending<T>(change: (list: PendingRecap[]) => { list: PendingRecap[]; result: T }): Promise<T> {
    const run = pendingLock.then(async () => {
      const { list, result } = change(livePending(await bb.storage.kv.get(PENDING), Date.now()));
      await bb.storage.kv.set(PENDING, list);
      return result;
    });
    pendingLock = run.catch(() => undefined);
    return run;
  }

  /** The archived thread a hidden recap thread is reading, or null for an ordinary thread. */
  async function recapSource(threadId: string): Promise<{ threadId: string; title: string } | null> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId, pluginId: bb.pluginId });
    const source = metadata[RECAP_SOURCE_KEY];
    const title = metadata[RECAP_TITLE_KEY];
    if (typeof source !== "string") return null;
    return { threadId: source, title: typeof title === "string" ? title : "Archived thread" };
  }

  /** The user turns and agent messages of a thread, newest pages first since the recap keeps the end. */
  async function readTranscript(threadId: string) {
    const pages: unknown[][] = [];
    let beforeSeq: string | undefined;
    // bb serves at most 100 events a page; 20 pages covers what the transcript keeps.
    for (let page = 0; page < 20; page += 1) {
      const batch = await bb.sdk.threads.events.list({
        threadId,
        types: [...TRANSCRIPT_EVENT_TYPES],
        order: "desc",
        limit: "100",
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      });
      pages.push([...batch].reverse());
      const oldest = batch.at(-1);
      if (batch.length < 100 || oldest === undefined) break;
      beforeSeq = String(oldest.seq);
    }
    return transcriptFromEvents(pages.reverse().flat());
  }

  async function recapArchived(thread: PluginThreadEventPayloads["thread.archived"]["thread"]) {
    const { recapOnArchive, recapProvider, recapModel } = await settings.get();
    if (!recapOnArchive || thread.visibility !== "visible" || thread.originPluginId === bb.pluginId) return;
    const transcript = await readTranscript(thread.id);
    if (!worthRecapping(transcript)) {
      bb.log.info(`Lobu recap of ${thread.id} skipped: no conversation to recap`);
      return;
    }
    const title = thread.title ?? thread.titleFallback ?? "Untitled thread";
    const provider = recapProvider.trim();
    const model = recapModel.trim();
    const worker = await bb.sdk.threads.spawn({
      projectId: thread.projectId,
      environment: { type: "project-default" },
      providerId: provider === "" ? thread.providerId : provider,
      ...(model === "" ? {} : { model }),
      visibility: "hidden",
      title: `Lobu recap: ${title}`,
      pluginMetadata: { [RECAP_SOURCE_KEY]: thread.id, [RECAP_TITLE_KEY]: title },
      prompt: recapPrompt(title, transcript.text),
    });
    await finishRecap(worker.id);
  }

  /** The archived thread's opening user message, for recap triage; null when unreadable. */
  async function readFirstUserMessage(threadId: string): Promise<string | null> {
    try {
      const batch = await bb.sdk.threads.events.list({
        threadId,
        types: [...TRANSCRIPT_EVENT_TYPES],
        order: "asc",
        limit: "100",
      });
      const transcript = transcriptFromEvents([...batch]);
      const first = transcript.text.split("\n").find((line) => line.startsWith("User: "));
      if (first === undefined) return null;
      const text = first.slice("User: ".length).trim();
      return text === "" ? null : text.slice(0, 200);
    } catch {
      return null;
    }
  }

  /** Lets a recap thread finish its turn, then archives it and releases its runtime. */
  async function finishRecap(threadId: string) {
    try {
      await bb.sdk.threads.wait({ threadId, status: "idle", timeoutMs: RECAP_TIMEOUT_MS });
    } finally {
      await bb.sdk.threads.archive({ threadId });
      await bb.sdk.threads.stop({ threadId });
    }
  }

  bb.events.on("thread.archived", ({ thread }) => {
    recapArchived(thread).catch((cause: unknown) => bb.log.warn(`Lobu recap of ${thread.id} failed: ${String(cause)}`));
  });

  // A reload while a recap runs drops its wait, so finish any recap threads left behind.
  void bb.sdk.threads
    .list({ originPluginId: bb.pluginId, includeHidden: true, archived: false })
    .then((leftover) =>
      Promise.all(
        leftover.map((thread) =>
          finishRecap(thread.id).catch((cause: unknown) => bb.log.warn(`Lobu recap cleanup of ${thread.id} failed: ${String(cause)}`)),
        ),
      ),
    )
    .catch((cause: unknown) => bb.log.warn(`Lobu recap cleanup failed: ${String(cause)}`));

  bb.agents.registerTool({
    name: "lobu_remember",
    description:
      "Propose memories to save to the user's Lobu workspace memory. The user reviews, edits, and picks the workspace in a form before anything is saved.",
    instructions:
      "When a task leaves something worth keeping across sessions, call lobu_remember once at the end with at most three short, self-contained memories. Propose one only if a different agent, on a different task next month, would act differently because of it: a decision, a non-obvious fact or gotcha, or a preference the user stated as a standing rule. Most tasks contain nothing worth keeping; then do not call the tool. Never propose what the task built or changed, anything the repo or code already states, generic quality wishes, task requirements, or one-off values. Each memory needs a short evidence quote of the turn or finding it came from. Never include secrets, credentials, or temporary state. Use lobu_remember rather than other memory-saving tools, because it shows the user a review form.",
    presentation: {
      label: { pending: "Proposing memories for Lobu", completed: "Proposed memories for Lobu" },
      icon: { glyph: "lobu/lobu" },
    },
    parameters: z.object({ memories: z.array(memoryProposalSchema).min(1).max(3) }),
    async execute({ memories }, { threadId, signal }) {
      try {
        const source = await recapSource(threadId);
        if (source !== null) {
          const recap = {
            id: randomUUID(),
            sourceThreadId: source.threadId,
            sourceTitle: source.title,
            createdAt: Date.now(),
            firstMessage: await readFirstUserMessage(source.threadId),
            drafts: memories,
          };
          await updatePending((list) => ({ list: addPending(list, recap), result: null }));
          const count = `${memories.length} ${memories.length === 1 ? "memory" : "memories"}`;
          return `Nothing was saved. ${count} now wait for the user to review on the Lobu page. Reply with exactly: "Queued ${count} for review on the Lobu page."`;
        }
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
    pendingReviews: async () => {
      const recaps = livePending(await bb.storage.kv.get(PENDING), Date.now());
      if (recaps.length === 0) return [];
      return Promise.all(
        recaps.map(async (recap) => ({
          id: recap.id,
          sourceTitle: recap.sourceTitle,
          createdAt: recap.createdAt,
          firstMessage: recap.firstMessage ?? null,
          form: (await formFor(recap.drafts)).form,
        })),
      );
    },
    savePendingReview: async ({ id, submission }) => {
      const recap = livePending(await bb.storage.kv.get(PENDING), Date.now()).find((r) => r.id === id);
      if (recap === undefined) throw new Error("This recap is no longer waiting for review.");
      const { owners } = await formFor(recap.drafts);
      // Keyed to the archived thread, so saving the same memory again stores it once.
      const outcome = await save(owners, recap.sourceThreadId, submission);
      await updatePending((list) => ({ list: list.filter((r) => r.id !== id), result: null }));
      return describeOutcome(outcome);
    },
    dismissPendingReview: ({ id }) =>
      updatePending((list) => ({ list: list.filter((r) => r.id !== id), result: { dismissed: list.some((r) => r.id === id) } })),
  });
}
