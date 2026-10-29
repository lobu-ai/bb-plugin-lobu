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

const setupStatusSchema = z.object({
  cli: z.discriminatedUnion("state", [
    z.object({ state: z.literal("missing") }),
    z.object({ state: z.literal("broken"), detail: z.string() }),
    z.object({ state: z.literal("outdated"), version: z.string() }),
    z.object({ state: z.literal("ready"), version: z.string() }),
  ]),
  /** The install command the button runs; null when neither bun nor npm is found. */
  installCommand: z.string().nullable(),
  /** The command to show when the button cannot run or fails. */
  manualCommand: z.string(),
  /** The login bb saves and searches through; null until the CLI runs. */
  login: z
    .object({
      context: z.string().nullable(),
      /** Lobu Cloud (the CLI's `lobu` context), Lobu on this machine (`local`), or another Lobu. */
      kind: z.enum(["cloud", "local", "other"]),
      origin: z.string(),
      /** Who it is signed in as; null when it is not signed in. */
      account: z.string().nullable(),
      personal: z.string().nullable(),
      problem: z.string().nullable(),
    })
    .nullable(),
  /** bb started Lobu on this machine and it has not stopped. */
  starting: z.boolean(),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;

const approvalSchema = z.object({ approvalUrl: z.string().nullable() });

export const rpcContract = defineRpcContract({
  /** Whether bb can reach Lobu: the CLI and the login bb uses. */
  setupStatus: {
    input: z.object({}),
    output: setupStatusSchema,
  },
  /** Installs or updates the CLI with bun or npm. `error` is the installer's last line when it fails. */
  installCli: {
    input: z.object({}),
    output: z.object({ error: z.string().nullable() }),
  },
  /** Uses Lobu Cloud and starts its `lobu login`; the page waits for `setupStatus` to show it signed in. */
  useCloud: {
    input: z.object({}),
    output: approvalSchema,
  },
  /** Uses Lobu on this machine, starting it when it is not running. `error` says why it cannot start. */
  useLocal: {
    input: z.object({}),
    output: z.object({ error: z.string().nullable() }),
  },
  /** Adds a CLI context, makes it the login bb uses, and starts its sign-in. */
  addLogin: {
    input: z.object({ name: z.string().trim().min(1).max(64), url: z.string().trim().min(1) }),
    output: approvalSchema,
  },
  /** Lobu's events page filtered to what bb saved through the login it uses (null when nothing is saved there), and how many memories bb saved there. */
  savedLink: {
    input: z.object({}),
    output: z.object({ url: z.string().nullable(), count: z.number() }),
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
