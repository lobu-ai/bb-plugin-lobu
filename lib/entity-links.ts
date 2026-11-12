// Linking a saved memory to Lobu entities. A wrong link puts a memory on an
// unrelated person's page, while an unlinked memory is still found by search,
// so a link needs certainty: a name the agent wrote (the project's repository
// included) that exactly one entity carries. Nothing here searches fuzzily or
// creates entities.
import type { EntityHit } from "./memory-contract";

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

/** A one-word name ("Dmitry", "Dot") never identifies a single record. */
export function tooVagueToLink(mention: string): boolean {
  const name = normalizeName(mention);
  if (name.length < 3) return true;
  return !/[\s/@]/.test(name);
}

export type MentionOutcome =
  | { mention: string; status: "linked"; entity: EntityHit }
  | { mention: string; status: "self" }
  | { mention: string; status: "vague" }
  | { mention: string; status: "ambiguous"; candidates: EntityHit[] }
  | { mention: string; status: "not_found" }
  | { mention: string; status: "unknown" };

/** The text to look a mention up by: a repository's "owner/repo", else the mention itself. */
export function lookupTermOf(mention: string): string {
  return githubRepoOf(mention) ?? mention.trim();
}

/**
 * Decides one mention against Lobu's exact-name search hits (null when Lobu
 * could not be asked). Hits are re-checked by name, because older Lobu servers
 * pad an exact search that found nothing with partial-name matches. One exact
 * match links, several are ambiguous, and a member record means a workspace
 * member, whose memories authorship already attributes.
 */
export function resolveMention(mention: string, hits: readonly EntityHit[] | null): MentionOutcome {
  if (tooVagueToLink(mention)) return { mention, status: "vague" };
  if (hits === null) return { mention, status: "unknown" };
  const target = normalizeName(lookupTermOf(mention));
  const exact = hits.filter((entity) => normalizeName(entity.name) === target);
  if (exact.some((entity) => entity.type === "$member")) return { mention, status: "self" };
  const linkable = exact.filter((entity) => !entity.type.startsWith("$"));
  if (linkable.length === 1) return { mention, status: "linked", entity: linkable[0] as EntityHit };
  if (linkable.length > 1) return { mention, status: "ambiguous", candidates: linkable };
  return { mention, status: "not_found" };
}

/** One line per mention that stayed unlinked, telling the agent what it can do. */
export function describeUnlinked(outcomes: readonly MentionOutcome[]): string[] {
  return outcomes.flatMap((outcome) => {
    const name = JSON.stringify(outcome.mention);
    switch (outcome.status) {
      case "vague":
        return [`${name}: one word cannot identify a record; use the full name or leave it unlinked.`];
      case "ambiguous":
        return [
          `${name}: ${outcome.candidates.length} records share this exact name (${outcome.candidates
            .slice(0, 5)
            .map((entity) => `${entity.type} id ${entity.id}`)
            .join(", ")}); pass entityIds only if you know which one, else leave it unlinked.`,
        ];
      case "not_found":
        return [`${name}: no record has this exact name; left unlinked.`];
      case "unknown":
        return [`${name}: Lobu could not be searched; left unlinked.`];
      default:
        return [];
    }
  });
}
