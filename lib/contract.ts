// The RPC contract between server.ts and the page. app.tsx imports types only.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  learnResultSchema,
  pinInputSchema,
  projectMemorySchema,
  rememberResultSchema,
  threadMemorySchema,
} from "./memory-contract";

const cliContextSchema = z.object({ name: z.string(), origin: z.string(), current: z.boolean(), loggedIn: z.boolean() });
export type CliContextOption = z.infer<typeof cliContextSchema>;

export const rpcContract = defineRpcContract({
  /** The `lobu` CLI contexts for the page's context picker. Empty when the CLI cannot list them; the page then uses the active login on fallbackOrigin. */
  lobuContexts: {
    input: z.object({}),
    output: z.object({ contexts: z.array(cliContextSchema), fallbackOrigin: z.string() }),
  },
  /**
   * What bb saved, in the embedded Lobu app for one CLI context (null: the
   * active one). `path` is null when bb saved nothing this login reaches; then
   * there is no session either.
   */
  lobuApp: {
    input: z.object({ context: z.string().nullable() }),
    output: z.object({ origin: z.string(), path: z.string().nullable(), signInUrl: z.string().nullable() }),
  },
  /** Adds a CLI context and starts its browser login; the page waits for `lobuContexts` to show it signed in. */
  addContext: {
    input: z.object({ name: z.string().trim().min(1).max(64), url: z.string().trim().min(1) }),
    output: z.object({ approvalUrl: z.string().nullable() }),
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
