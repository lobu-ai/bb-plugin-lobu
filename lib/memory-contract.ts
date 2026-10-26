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
