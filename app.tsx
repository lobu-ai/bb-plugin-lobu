// bb-plugin-lobu — frontend entry. Compiled by `bb plugin build`; React and
// the SDK come from the bb app at load time.
import {
  definePluginApp,
  experimental_THREAD_ACTION_GROUPS,
  type PluginBrowserBbSdk,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { SetupCard, SetupSettings } from "@/components/setup";
import { ThreadMemoryPanel } from "@/components/memory";
import { RememberFormView } from "@/components/remember-form";
import { z } from "zod";
import { learnResultSchema, REMEMBER_RENDERER, rememberResultSchema } from "@/lib/memory-contract";

const PLUGIN_ID = "lobu";

// Message actions get no SDK client of their own; the thread action's
// app-wide data hook hands it over. It is the same client for every thread.
let sdk: PluginBrowserBbSdk | null = null;

async function openReview(threadId: string, text: string) {
  if (sdk === null) throw new Error("Lobu is still loading. Try again in a moment.");
  const result = await sdk.plugins.callRpc({
    pluginId: PLUGIN_ID,
    method: "remember",
    input: { threadId, text },
    outputSchema: rememberResultSchema,
  });
  if (result.error !== null) throw new Error(result.error);
}

export default definePluginApp((app) => {
  // Setup: a card on the New thread screen until bb is connected, and an
  // account section on the plugin's settings page.
  app.slots.homepageSection({ id: "connect", title: "Lobu", component: SetupCard });
  app.slots.settingsSection({
    id: "account",
    title: "Lobu account",
    description: "Where agents in bb save and search memory.",
    component: SetupSettings,
  });

  // What this thread started with, looked up, and saved, with undo and pin.
  app.slots.threadPanelAction({
    id: "memory",
    title: "Lobu memory",
    icon: "lobu/memory",
    component: ThreadMemoryPanel,
  });

  // The review form shown in place of the composer.
  app.slots.pendingInteraction({ id: REMEMBER_RENDERER, component: RememberFormView });

  // "Remember this": a message, or the text selected in it, straight into the form.
  app.slots.messageAction({
    id: "save-to-lobu",
    title: "Save to Lobu",
    icon: "lobu/lobu",
    run: ({ threadId, message, selectedText }) =>
      openReview(threadId, selectedText?.trim() ? selectedText : message.text),
  });

  // Lobu's own page of everything bb saved.
  app.slots.experimental_threadAction({
    id: "open-in-lobu",
    title: "Open what bb saved in Lobu",
    icon: "lobu/lobu",
    group: experimental_THREAD_ACTION_GROUPS.organize,
    item: ({ sdk: client, navigate }) => ({
      label: "Open what bb saved in Lobu",
      icon: "lobu/lobu",
      run: async () => {
        const { url } = await client.plugins.callRpc({
          pluginId: PLUGIN_ID,
          method: "savedLink",
          input: {},
          outputSchema: z.object({ url: z.string().nullable() }),
        });
        if (url === null) throw new Error("bb has not saved anything to Lobu through this login yet.");
        navigate.openUrl(url);
      },
    }),
  });

  // Ask the thread's agent to propose what is worth keeping.
  app.slots.experimental_threadAction({
    id: "save-learnings",
    title: "Save learnings to Lobu",
    icon: "lobu/lobu",
    group: experimental_THREAD_ACTION_GROUPS.organize,
    useData: () => {
      sdk = useSdk();
      return undefined;
    },
    item: ({ thread, sdk: client }) => ({
      label: "Save learnings to Lobu",
      icon: "lobu/lobu",
      run: async () => {
        await client.plugins.callRpc({
          pluginId: PLUGIN_ID,
          method: "learn",
          input: { threadId: thread.id },
          outputSchema: learnResultSchema,
        });
      },
    }),
  });
});
