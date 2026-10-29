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
  logins: z.array(cliContextSchema),
  /** The login bb saves and searches through; null until the CLI runs. */
  login: z
    .object({
      context: z.string().nullable(),
      origin: z.string(),
      /** Who it is signed in as; null when it is not signed in. */
      account: z.string().nullable(),
      personal: z.string().nullable(),
      problem: z.string().nullable(),
    })
    .nullable(),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;

const approvalSchema = z.object({ approvalUrl: z.string().nullable() });

export const rpcContract = defineRpcContract({
  /** Whether bb can reach Lobu: the CLI, the login bb uses, and every login to pick from. */
  setupStatus: {
    input: z.object({}),
    output: setupStatusSchema,
  },
  /** Installs or updates the CLI with bun or npm. `error` is the installer's last line when it fails. */
  installCli: {
    input: z.object({}),
    output: z.object({ error: z.string().nullable() }),
  },
  /** Starts `lobu login` for the login bb uses; the page waits for `setupStatus` to show it signed in. */
  signIn: {
    input: z.object({}),
    output: approvalSchema,
  },
  /** Adds a CLI context and starts its login. */
  addLogin: {
    input: z.object({ name: z.string().trim().min(1).max(64), url: z.string().trim().min(1) }),
    output: approvalSchema,
  },
  /** Picks the login bb saves and searches through; null follows the CLI's active context. */
  useLogin: {
    input: z.object({ context: z.string().nullable() }),
    output: z.object({ context: z.string().nullable() }),
  },
  /** Lobu's events page filtered to what bb saved through the login it uses; null when nothing is saved there. */
  savedLink: {
    input: z.object({}),
    output: z.object({ url: z.string().nullable() }),
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
