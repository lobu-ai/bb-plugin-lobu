// The RPC contract between server.ts and the page. app.tsx imports types only.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const itemSchema = z.object({
  title: z.string(),
  detail: z.string().nullable(),
  at: z.string().nullable(),
  url: z.string().nullable(),
});
export type DashboardItem = z.infer<typeof itemSchema>;

const countedItemSchema = itemSchema.extend({ count: z.number() });
export type CountedItem = z.infer<typeof countedItemSchema>;

const pinnedMetricSchema = z.object({
  label: z.string(),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
  error: z.string().nullable(),
});
export type PinnedMetric = z.infer<typeof pinnedMetricSchema>;

const workspaceSchema = z.object({
  slug: z.string(),
  name: z.string(),
  needsYou: z.array(countedItemSchema),
  unreadCount: z.number(),
  failedRuns: z.array(countedItemSchema),
  connections: z.array(itemSchema),
  activity: z.object({
    syncedTotal: z.number(),
    syncRuns: z.number(),
    truncated: z.boolean(),
    feeds: z.array(countedItemSchema),
    automations: z.array(countedItemSchema),
    briefings: z.array(itemSchema),
  }),
  metrics: z.object({
    available: z.array(z.string()),
    pinned: z.array(pinnedMetricSchema),
  }),
  error: z.string().nullable(),
});
export type WorkspaceSummary = z.infer<typeof workspaceSchema>;

export const setupCodes = ["cli_missing", "not_logged_in", "no_workspaces"] as const;
export type SetupCode = (typeof setupCodes)[number];

const snapshotSchema = z.object({
  fetchedAt: z.string(),
  baseUrl: z.string(),
  workspaces: z.array(workspaceSchema),
  devices: z.array(itemSchema),
  /** Set when the plugin cannot read Lobu at all; the page shows setup steps. */
  setup: z
    .object({ code: z.enum(setupCodes), context: z.string().nullable(), message: z.string() })
    .nullable(),
  errors: z.array(z.string()),
});
export type Snapshot = z.infer<typeof snapshotSchema>;


export const metricPinSchema = z.object({
  workspace: z.string().min(1),
  entity_type: z.string().min(1),
  measure: z.string().min(1),
  by: z.array(z.string()).optional(),
  segment: z.string().optional(),
  label: z.string().optional(),
});
export type MetricPin = z.infer<typeof metricPinSchema>;
export const metricPinsSchema = z.array(metricPinSchema);

/** Lobu's built-in memory kinds; each maps to a save_memory semantic_type. */
export const memoryKinds = ["fact", "decision", "preference", "observation", "note"] as const;
export type MemoryKind = (typeof memoryKinds)[number];

export const memoryDraftSchema = z.object({
  title: z.string().trim().min(1).max(120),
  content: z.string().trim().min(1).max(2000),
  kind: z.enum(memoryKinds),
});
export type MemoryDraft = z.infer<typeof memoryDraftSchema>;

/** What the review form shows. */
export const rememberFormSchema = z.object({
  drafts: z.array(memoryDraftSchema).min(1).max(10),
  workspaces: z.array(z.object({ slug: z.string(), name: z.string() })),
  workspace: z.string().nullable(),
});
export type RememberForm = z.infer<typeof rememberFormSchema>;

/** What the review form submits: only the memories the user kept, as edited. */
export const rememberSubmissionSchema = z.object({
  workspace: z.string().min(1),
  memories: z.array(memoryDraftSchema).max(10),
});
export type RememberSubmission = z.infer<typeof rememberSubmissionSchema>;

/** The form's renderer id, shared by requestInput and the pendingInteraction slot. */
export const REMEMBER_RENDERER = "remember";

export const rememberResultSchema = z.object({ opened: z.boolean(), error: z.string().nullable() });
export const learnResultSchema = z.object({ sent: z.boolean() });

export const rpcContract = defineRpcContract({
  snapshot: {
    input: z.object({ refresh: z.boolean() }),
    output: snapshotSchema,
  },
  /** Opens the review form in a thread with text the user picked. */
  remember: {
    input: z.object({ threadId: z.string(), text: z.string().min(1) }),
    output: rememberResultSchema,
  },
  /** Asks the thread's agent to propose learnings through lobu_remember. */
  learn: {
    input: z.object({ threadId: z.string() }),
    output: learnResultSchema,
  },
});
