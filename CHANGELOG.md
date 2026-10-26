# Changelog

## 0.3.0

- Recap on archive: with **Recap archived threads** on, archiving a thread
  starts a hidden agent that proposes memories from it. They wait in a new
  **Memories to review** card on the Lobu page until you save or skip them.
  **Recap provider** and **Recap model** pick a cheaper agent for the job.

## 0.2.1

- Fix git and marketplace installs: the page no longer imports the plugin
  SDK's server package, which those installs leave out.

## 0.2.0

- Save to Lobu: keep what agents learn in Lobu workspace memory. Agents
  propose memories with the new `lobu_remember` tool, any message or selected
  text can be saved from its action menu, and **Save learnings to Lobu** in the
  thread menu asks the agent for a recap. Every save goes through a review form
  where you untick, edit, and pick the kind and workspace first.

## 0.1.2

- Needs you rows say how many requests they group ("36 approvals waiting").
- Pending approvals beyond the newest 50 activity items are counted in an
  "Older approvals" row instead of being missed.
- Setup steps for a new CLI context include `lobu context add`.

## 0.1.1

- Fix git installs: match the plugin SDK's `@types/better-sqlite3` peer range.

## 0.1.0

- Lobu page with Needs you, Failed runs, Connections & devices, Activity, and
  Metrics cards across every workspace your `lobu` CLI logins cover.
- Ask an agent action that opens New thread with a prompt about a row.
- Needs-you summary on the New thread screen.
- Setup guidance when the CLI is missing, not logged in, or covers no
  visible workspaces.
