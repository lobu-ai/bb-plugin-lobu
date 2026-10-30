// The RPC contract between server.ts and the page. app.tsx imports types only.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  learnResultSchema,
  memoryOverviewSchema,
  pendingReviewSchema,
  pinInputSchema,
  projectMemorySchema,
  rememberResultSchema,
  rememberSubmissionSchema,
  savedSummarySchema,
  threadMemorySchema,
} from "./memory-contract";

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

export const setupCodes = ["cli_missing", "cli_failed", "not_logged_in", "no_workspaces"] as const;
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
  /** Recaps of archived threads waiting for review, oldest first. */
  pendingReviews: {
    input: z.object({}),
    output: z.array(pendingReviewSchema),
  },
  /** Saves the memories the user kept from one recap, then drops the recap. */
  savePendingReview: {
    input: z.object({ id: z.string(), submission: rememberSubmissionSchema }),
    output: savedSummarySchema,
  },
  /** Drops a recap without saving anything. */
  dismissPendingReview: {
    input: z.object({ id: z.string() }),
    output: z.object({ dismissed: z.boolean() }),
  },
  /** Memories the plugin saved, every bb project's Lobu link, pins, and brief. */
  memoryOverview: {
    input: z.object({}),
    output: memoryOverviewSchema,
  },
  /** What one thread was given at its start, searched for, and saved. */
  threadMemory: {
    input: z.object({ threadId: z.string() }),
    output: threadMemorySchema,
  },
  /** Hides a saved memory in Lobu (recoverable there) and drops it from the plugin's list and pins. */
  undoMemory: {
    input: z.object({ eventId: z.number() }),
    output: z.object({ removed: z.boolean() }),
  },
  pinMemory: {
    input: z.object({ projectId: z.string(), item: pinInputSchema }),
    output: projectMemorySchema,
  },
  unpinMemory: {
    input: z.object({ projectId: z.string(), pinnedAt: z.number() }),
    output: projectMemorySchema,
  },
  /** Saves a note to the personal workspace and pins it to the project. */
  addNote: {
    input: z.object({ projectId: z.string(), text: z.string().trim().min(1).max(2000) }),
    output: projectMemorySchema,
  },
  /** Links a bb project to a Lobu workspace, or unlinks it with null. */
  linkProject: {
    input: z.object({ projectId: z.string(), workspace: z.string().min(1).nullable() }),
    output: projectMemorySchema,
  },
});
