// Names of Lobu records. A memory links only to record ids an agent was
// shown, never to a guessed name: a wrong link puts a memory on an unrelated
// record's page, while an unlinked memory is still found by search.

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
function normalizeName(name: string): string {
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
