// Save to Lobu shapes shared by the server and the page. The page imports this
// at runtime, so it must not import @get-bb/plugin-sdk (a dev-only dependency).
import { z } from "zod";

/** Lobu's built-in memory kinds; each maps to a save_memory semantic_type. */
export const memoryKinds = ["fact", "decision", "preference", "observation", "note"] as const;
export type MemoryKind = (typeof memoryKinds)[number];

export const memoryDraftSchema = z.object({
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(2000),
  kind: z.enum(memoryKinds),
  /** Short quote of the user turn or agent finding the memory came from. Absent on older queued drafts. */
  evidence: z.string().trim().max(500).nullish(),
  /** Workspace slug or name the memory belongs to; null lets the server pick. Absent on older queued drafts. */
  workspace: z.string().trim().min(1).nullish(),
  /** Event id of an older saved memory this one corrects or replaces (shown in lobu_search and the project brief). */
  replacesEventId: z.number().int().positive().nullish(),
  /** Lobu entity IDs to link this memory with (e.g. projects, people, repositories). */
  entityIds: z.array(z.number().int().positive()).nullish(),
  /** Full names of the specific records this memory is about; each links only on a unique exact match. */
  mentions: z.array(z.string().trim().min(2).max(120)).max(5).nullish(),
});
export type MemoryDraft = z.infer<typeof memoryDraftSchema>;

/** What agents must send: evidence is required, so invented preferences fail validation. */
export const memoryProposalSchema = memoryDraftSchema
  .extend({
    evidence: z.string().trim().min(1).max(500),
    /** Accepts snake_case alias commonly used in Lobu APIs. */
    entity_ids: z.array(z.number().int().positive()).nullish(),
  })
  .transform(({ entity_ids, ...data }) => ({
    ...data,
    entityIds: data.entityIds ?? entity_ids ?? null,
  }));
export type MemoryProposal = z.output<typeof memoryProposalSchema>;

/** What the review form shows. Drafts stay capped at ten so recaps queued by older tool versions still parse. */
export const rememberFormSchema = z.object({
  drafts: z.array(memoryDraftSchema).min(1).max(10),
  workspaces: z.array(z.object({ slug: z.string(), name: z.string() })),
  workspace: z.string().nullable(),
  /** Why this workspace is preselected, e.g. draft hints disagreeing; null when unremarkable. */
  workspaceNote: z.string().nullable(),
});
export type RememberForm = z.infer<typeof rememberFormSchema>;

/** What the review form submits: only the memories the user kept, as edited. The cap stays above the tool's so a kept subset always validates. */
export const rememberSubmissionSchema = z.object({
  workspace: z.string().min(1),
  memories: z.array(memoryDraftSchema).max(10),
});
export type RememberSubmission = z.infer<typeof rememberSubmissionSchema>;

/** The form's renderer id, shared by requestInput and the pendingInteraction slot. */
export const REMEMBER_RENDERER = "remember";

export const rememberResultSchema = z.object({ opened: z.boolean(), error: z.string().nullable() });
export const learnResultSchema = z.object({ sent: z.boolean() });

/** A memory the plugin saved on the user's behalf, with how often agents found it since. */
export const savedRecordSchema = z.object({
  eventId: z.number(),
  workspace: z.string(),
  title: z.string(),
  content: z.string(),
  kind: z.enum(memoryKinds),
  url: z.string().nullable(),
  threadId: z.string(),
  projectId: z.string().nullable(),
  entityIds: z.array(z.number()).nullish(),
  savedAt: z.number(),
  /** Times a lobu_search result returned this memory. */
  uses: z.number(),
  lastUsedAt: z.number().nullable(),
});
export type SavedRecord = z.infer<typeof savedRecordSchema>;

/** One bb session's saves for the Lobu page: the thread, what it started with, what it saved. */
export const savedSessionSchema = z.object({
  /** A bb thread id, "cli" for `bb lobu remember` in a terminal, or "project:<id>" for a project note. */
  threadId: z.string(),
  kind: z.enum(["thread", "terminal", "project"]),
  /** The thread's title; null when bb no longer has the thread. */
  title: z.string().nullable(),
  projectName: z.string().nullable(),
  archived: z.boolean(),
  /**
   * Memories the thread's brief gave it, and lobu_search calls it made. Null
   * when bb no longer keeps the thread's log (old logs are trimmed to fit kv).
   */
  startedWith: z.number().nullable(),
  lookedUp: z.number().nullable(),
  records: z.array(
    savedRecordSchema.extend({
      /** Saved by the archive recap, after the thread was archived. */
      recap: z.boolean(),
    }),
  ),
});
export type SavedSession = z.infer<typeof savedSessionSchema>;

/** A Lobu memory or note the user pinned to a bb project; every thread there starts with it. */
export const pinnedMemorySchema = z.object({
  eventId: z.number().nullable(),
  workspace: z.string(),
  title: z.string(),
  content: z.string(),
  url: z.string().nullable(),
  entityIds: z.array(z.number()).nullish(),
  pinnedAt: z.number(),
});
export type PinnedMemory = z.infer<typeof pinnedMemorySchema>;

/** One memory a Lobu search returned. */
export const memoryHitSchema = z.object({
  eventId: z.number(),
  workspace: z.string(),
  title: z.string(),
  content: z.string(),
  url: z.string().nullable(),
  similarity: z.number().nullable(),
  occurredAt: z.string().nullable(),
  entityIds: z.array(z.number()).nullish(),
});
export type MemoryHit = z.infer<typeof memoryHitSchema>;

/** One entity matching a Lobu search or mention query. */
export const entityHitSchema = z.object({
  id: z.number(),
  type: z.string(),
  name: z.string(),
  slug: z.string(),
  workspace: z.string(),
  url: z.string().nullable(),
});
export type EntityHit = z.infer<typeof entityHitSchema>;

/** What a thread was handed at its start, and what its agent looked up. */
export const threadLogSchema = z.object({
  given: z.array(
    z.object({
      eventId: z.number().nullable(),
      workspace: z.string(),
      title: z.string(),
      source: z.enum(["pinned", "learned"]),
    }),
  ),
  searches: z.array(z.object({ query: z.string(), at: z.number(), results: z.array(memoryHitSchema) })),
  updatedAt: z.number(),
});
export type ThreadLog = z.infer<typeof threadLogSchema>;

const workspaceOptionSchema = z.object({ slug: z.string(), name: z.string() });

/** A bb project with its Lobu link, pins, and what its new threads start with. */
export const projectMemorySchema = z.object({
  id: z.string(),
  name: z.string(),
  workspace: z.string().nullable(),
  pins: z.array(pinnedMemorySchema),
  /** The learned memories a new thread here receives after the pins, in brief order. */
  learned: z.array(
    z.object({
      eventId: z.number().nullable(),
      workspace: z.string(),
      title: z.string(),
      content: z.string(),
      url: z.string().nullable(),
      /** The bb thread that saved it, and that thread's title; null when bb did not save it or no longer has the thread. */
      threadId: z.string().nullable(),
      threadTitle: z.string().nullable(),
    }),
  ),
});
export type ProjectMemory = z.infer<typeof projectMemorySchema>;

export const threadMemorySchema = z.object({
  personal: z.string().nullable(),
  workspaces: z.array(workspaceOptionSchema),
  project: projectMemorySchema.nullable(),
  log: threadLogSchema.nullable(),
  saved: z.array(savedRecordSchema),
});
export type ThreadMemory = z.infer<typeof threadMemorySchema>;

export const projectMemoryViewSchema = z.object({
  personal: z.string().nullable(),
  workspaces: z.array(workspaceOptionSchema),
  project: projectMemorySchema,
});
export type ProjectMemoryView = z.infer<typeof projectMemoryViewSchema>;

/** What the page sends to pin something; pinnedAt is stamped by the server. */
export const pinInputSchema = pinnedMemorySchema.omit({ pinnedAt: true });
