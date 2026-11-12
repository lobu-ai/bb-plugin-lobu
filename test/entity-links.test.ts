import { describe, expect, test } from "bun:test";
import { githubRepoOf, nameAppearsIn } from "../lib/entity-links";

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
