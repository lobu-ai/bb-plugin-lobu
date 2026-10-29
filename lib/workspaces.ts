// Which Lobu workspaces the user's CLI logins reach, and which bb saves the
// embedded app shows.
import type { LobuApi } from "./lobu-api";
import type { SavedRecord } from "./memory-contract";

/** At most this many saved memories go into the embedded app's link. */
const MAX_SHOWN = 100;

export function parseList(value: string): string[] {
  return value
    .replaceAll(",", " ")
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

export interface WorkspaceOwner {
  context: string | null;
  name: string;
  personal: boolean;
}

/**
 * Which workspaces each login covers, keyed by slug. The first context in
 * `contexts` that lists a workspace reads it. `problem` explains an empty map.
 */
export async function discoverWorkspaces(api: LobuApi, contexts: (string | null)[]) {
  const problems: string[] = [];
  const listed = await Promise.all(
    contexts.map(async (context) => {
      try {
        return await api.workspaces(context);
      } catch (cause) {
        problems.push(cause instanceof Error ? cause.message : String(cause));
        return [];
      }
    }),
  );
  const owners = new Map<string, WorkspaceOwner>();
  listed.forEach((workspaces, index) => {
    const context = contexts[index] ?? null;
    for (const { slug, name, personal } of workspaces) {
      if (!owners.has(slug)) owners.set(slug, { context, name, personal });
    }
  });
  return { owners, problem: problems[0] ?? null };
}

/**
 * Lobu's events page filtered to what bb saved, in the reachable workspace
 * bb saved to most recently. Null when bb saved nothing these workspaces hold.
 */
export function savedEventsPath(saved: SavedRecord[], reachable: ReadonlySet<string>): string | null {
  const shown = saved.filter((record) => reachable.has(record.workspace));
  const newest = shown.reduce<SavedRecord | null>((best, record) => (best === null || record.savedAt > best.savedAt ? record : best), null);
  if (newest === null) return null;
  const ids = shown
    .filter((record) => record.workspace === newest.workspace)
    .sort((a, b) => b.savedAt - a.savedAt)
    .slice(0, MAX_SHOWN)
    .map((record) => record.eventId);
  return `/${encodeURIComponent(newest.workspace)}/events?content_ids=${ids.join(",")}`;
}
