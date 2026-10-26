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

export const rpcContract = defineRpcContract({
  snapshot: {
    input: z.object({ refresh: z.boolean() }),
    output: snapshotSchema,
  },
});

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
