// Linking a saved memory to Lobu entities. A wrong link puts a memory on an
// unrelated person's page, while an unlinked memory is still found by search,
// so a link needs certainty. Lobu decides it: save_memory links a name only
// when exactly one record carries it, and reports the rest. Nothing here
// searches fuzzily or creates entities.

/** "owner/repo" for a GitHub remote or URL, or null for anything else. */
export function githubRepoOf(value: string): string | null {
  const match = value
    .trim()
    .match(/^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?(?:[/?#].*)?$/);
  if (match === null) return null;
  const [, owner, repo] = match as unknown as [string, string, string];
  // "owner/..." or "owner/." is a truncated reference, not a repository.
  if (/^\.+$/.test(repo)) return null;
  return `${owner}/${repo}`;
}

/** Case, Unicode form, and spacing differences do not make two names different. */
export function normalizeName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Whether `name` appears as a whole phrase in `text` ("Acme" in "Acme deploys", not "Hand" in "Hande"). */
export function nameAppearsIn(name: string, text: string): boolean {
  const words = (value: string) =>
    normalizeName(value)
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const phrase = words(name);
  return phrase !== "" && ` ${words(text)} `.includes(` ${phrase} `);
}

/** The text to link a mention by: a repository's "owner/repo", else the mention itself. */
export function lookupTermOf(mention: string): string {
  return githubRepoOf(mention) ?? mention.trim();
}

/** A record reference save_memory accepts in entity_ids: an id, or an exact full name Lobu resolves. */
export type EntityRef = number | { name: string };

/** One name Lobu did not link, as save_memory reports it. */
export interface UnlinkedName {
  name: string;
  reason: string;
}

/** The entity_ids to send: confirmed ids, then each mention once, by exact name. */
export function entityRefsOf(ids: readonly number[], mentions: readonly string[]): EntityRef[] {
  const names = new Map<string, string>();
  for (const mention of mentions) {
    const name = lookupTermOf(mention);
    if (name !== "") names.set(normalizeName(name), name);
  }
  return [...new Set(ids), ...[...names.values()].map((name) => ({ name }))];
}

/** One line per name Lobu left unlinked, telling the agent what it can do. */
export function describeUnlinked(unlinked: readonly UnlinkedName[]): string[] {
  return unlinked.map(({ name, reason }) =>
    reason === "ambiguous"
      ? `${JSON.stringify(name)}: several records share this exact name; pass entityIds only if you know which one, else leave it unlinked.`
      : `${JSON.stringify(name)}: no record has this exact name; left unlinked.`,
  );
}
