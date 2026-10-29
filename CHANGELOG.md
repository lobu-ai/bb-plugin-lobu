# Changelog

## Unreleased

- Setup is built in. A **Connect Lobu memory** card on the New thread screen
  installs or updates the Lobu CLI with bun or npm (showing the command when
  it cannot), then signs you in to Lobu Cloud or runs Lobu on this machine
  (`lobu run` in `~/lobu-bb`, or a local Lobu already serving), as the Lobu
  Mac app does, and disappears once bb is connected. Settings → Plugins → Lobu gains a **Lobu account**
  section showing the Lobu bb uses and how many memories it saved there,
  with buttons to switch between Lobu Cloud, Lobu on this machine, or
  another Lobu.
- bb uses one CLI login, picked in the Lobu account section (the CLI's active
  context until you pick one). The Lobu URL comes from the login. Identity,
  workspaces, and tokens come from `lobu whoami --json`, like the Mac app.
- Removed the `baseUrl`, `hiddenWorkspaces`, `lobuBin`, `recapProvider`, and
  `recapModel` settings. The CLI is found on its own, and recaps use the
  archived thread's provider.
- **Open what bb saved in Lobu**, in the thread's ⋯ menu and the Lobu memory
  panel, opens Lobu's events page filtered to the memories bb saved.
- Removed the Lobu sidebar page: the Needs you dashboard (approvals, failed
  runs, connections and devices, activity, metrics), its New thread screen
  summary, and the `metrics` setting. Lobu's own app covers them.
- Archived-thread recaps save like any other memory and need auto-save on;
  the review queue on the Lobu page is gone.
- Memory runs as a loop. New threads start with their project's Lobu brief:
  what you pinned there and what earlier threads learned, most used first.
- Agents get `lobu_search`, which searches your personal workspace and the
  Lobu workspace linked to the project, and returns saved memories only.
- `lobu_remember` saves straight to your personal workspace by default,
  skipping anything Lobu already holds. Turn off **Save memories
  automatically** to review each save in a form instead.
- A Lobu memory panel in each thread shows what it started with, looked up,
  and saved, with undo and pin on every saved memory.

- The plugin runs the `lobu` CLI with your login shell's `PATH`. bb opened
  from the Dock only sees launchd's minimal `PATH`, so a CLI that needs a
  Homebrew, nvm, or Bun `node` failed to start and the plugin wrongly
  asked you to log in.
- A CLI that cannot run now reports the CLI's own error instead of a missing
  login.

## 0.4.1

- Tighter proposal bar: agents propose up to three memories and only when a
  different agent next month would act differently; "nothing to keep" is the
  expected answer. Each proposal carries an evidence quote shown in the
  review form, and proposals without one fail validation.
- Drafts can name their Lobu workspace; a unanimous hint preselects it in
  the form, and disagreement is flagged before saving.
- Archive recaps need a real back-and-forth (three user turns) and skip
  threads ending in diffs or status dumps; long transcripts keep the opening
  as well as the ending. Queued recaps show the archived thread's opening
  message, and the review card gains a dismiss-all button.

## 0.4.0

- Every `lobu` CLI login on your Lobu is read, so all the workspaces you
  approved appear without configuration. The `contexts` setting is gone.
  Needs a CLI with `lobu context list --json`; older CLIs show the active
  context only.
- Workspace chips at the top of the Lobu page narrow it to one workspace and
  remember the choice.
- Recap threads now say their memories are queued for review, not saved.

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
