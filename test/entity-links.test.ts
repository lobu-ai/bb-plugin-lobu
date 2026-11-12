import { describe, expect, test } from "bun:test";
import { githubRepoOf, nameAppearsIn, resolveMention } from "../lib/entity-links";
import type { EntityHit } from "../lib/memory-contract";

const entity = (id: number, name: string, type = "person"): EntityHit => ({
  id,
  name,
  type,
  slug: `${type}-${id}`,
  workspace: "me",
  url: null,
});

describe("githubRepoOf", () => {
  test.each([
    ["git@github.com:acme/payments.git", "acme/payments"],
    ["https://github.com/acme/payments", "acme/payments"],
    ["https://github.com/acme/payments.git", "acme/payments"],
    ["https://github.com/acme/payments/pull/12", "acme/payments"],
    ["ssh://git@github.com/acme/payments.git", "acme/payments"],
    ["github.com/acme/my.repo", "acme/my.repo"],
    ["acme/payments", "acme/payments"],
  ])("%s names %s", (input, repo) => {
    expect(githubRepoOf(input)).toBe(repo);
  });

  test.each([
    "lobu-ai/...",
    "https://gitlab.com/acme/payments",
    "git@gitlab.com:acme/payments.git",
    "payments",
    "",
  ])("%s names no repository", (input) => {
    expect(githubRepoOf(input)).toBeNull();
  });
});

describe("nameAppearsIn", () => {
  test("matches whole phrases only", () => {
    expect(nameAppearsIn("Acme", "why do Acme deploys fail")).toBe(true);
    expect(nameAppearsIn("Hande Örs", "hand off stack state")).toBe(false);
    expect(nameAppearsIn("Dot", "how to reach Dot: Slack")).toBe(true);
    expect(nameAppearsIn("Dot", "dotfiles sync")).toBe(false);
  });
});

describe("resolveMention", () => {
  const people = [entity(1, "Dmitry Karpov"), entity(2, "Dmitry Sorokin"), entity(3, "Priya Raman"), entity(4, "Sam Rivera"), entity(5, "Sam Rivera")];

  test("a unique exact name links, ignoring case and spacing", () => {
    expect(resolveMention("priya  RAMAN", people)).toMatchObject({ status: "linked", entity: { id: 3 } });
  });

  test("one word never links, whatever matches", () => {
    expect(resolveMention("Dmitry", people).status).toBe("vague");
  });

  test("a shared exact name is ambiguous", () => {
    const outcome = resolveMention("Sam Rivera", people);
    expect(outcome.status).toBe("ambiguous");
    if (outcome.status === "ambiguous") expect(outcome.candidates.map((c) => c.id)).toEqual([4, 5]);
  });

  test("a member record is never a link", () => {
    expect(resolveMention("Someone Example", [entity(9, "Someone Example", "$member")]).status).toBe("self");
  });

  test("a partial-name hit is not a link, and an unanswered search is unknown", () => {
    // Older Lobu servers pad an exact search that found nothing with partial-name matches.
    expect(resolveMention("Dmitry Nasikanov", people).status).toBe("not_found");
    expect(resolveMention("Dmitry Nasikanov", null).status).toBe("unknown");
  });

  test("a repository URL resolves by its owner/repo name", () => {
    const repo = entity(7, "acme/payments", "product");
    expect(resolveMention("https://github.com/acme/payments/pull/3", [repo])).toMatchObject({ status: "linked", entity: { id: 7 } });
  });
});
