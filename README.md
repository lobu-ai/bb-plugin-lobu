# Lobu for bb

A [bb](https://getbb.app) plugin that shows what needs you across your
[Lobu](https://lobu.ai) workspaces, and saves what your agents learn to Lobu
memory, without leaving bb.

![The Lobu page in bb](docs/screenshots/dashboard.jpg)

## What you get

A **Lobu** page in the bb sidebar with five cards, grouped by workspace:

- **Needs you**: pending approvals and Automations that are due. Identical
  requests collapse into one row ("36 approvals waiting") that links to all of
  them. Approvals older than the newest 50 activity items are counted in an
  "Older approvals" row.
- **Failed runs**: Automation and feed failures from the last 24 hours.
  Failed ad-hoc agent tool calls are left out.
- **Connections & devices**: connections and feeds that need attention, and
  paired devices that are offline, erroring, or need an update.
- **Activity**: agent briefings, the busiest feeds by items synced, and
  Automation runs over the last 24 hours.
- **Metrics**: metric queries you pin, plus the measures each workspace
  declares.

Every row links to Lobu. Hover a row and choose **Ask an agent** to open
bb's New thread screen with a prompt about it; you pick the project and send.

A one-line summary also appears on the New thread screen when something needs
you.

## Save to Lobu

Agents in bb forget everything when a thread ends. Save to Lobu keeps the
useful parts in your Lobu workspace memory, where any agent connected to Lobu
can find them later with `search_memory`.

![The agent proposed two memories after being asked to remember them; the user reviews them before saving](docs/screenshots/save-to-lobu.jpg)

Nothing is saved until you review it. A form takes the place of the message
box: untick what you don't want, edit the wording, pick the kind (fact,
decision, preference, observation, or note) and the workspace, then choose
**Save**. **Skip** saves nothing. Afterwards the thread shows what was saved,
with links to each memory in Lobu.

There are three ways to get there:

- **The agent offers.** Agents get a `lobu_remember` tool and are asked to use
  it when a task leaves something worth keeping, proposing a few short
  memories at the end of the task. For example, after fixing a flaky deploy it might propose
  "Staging deploys need the office VPN".
- **Save a message.** Hover any message and choose **Save to Lobu**, or
  highlight part of an answer and pick **Save to Lobu** from the selection
  menu. The form opens with that text, so "remember this" is two clicks.
- **Ask for a recap.** Choose **Save learnings to Lobu** from the thread's ⋯
  menu. The agent looks back over the thread and proposes what is worth
  keeping.

The workspace defaults to the last one you saved to, or your personal
workspace the first time. Saving the same memory twice from one thread stores it once.
It works with any agent bb runs. Agents that cannot wait on a tool call, such
as opencode, end their turn while the form is open and receive the result as
a follow-up message once you save or skip.
Agents pick up the `lobu_remember` tool when their session starts, so threads
that were already open before you installed the plugin need a new thread
first.

## Requirements

- bb 0.46 or newer.
- The Lobu CLI, logged in:

  ```sh
  npm install -g @lobu/cli
  lobu login
  ```

## Install

```sh
bb plugin install git:https://github.com/lobu-ai/bb-plugin-lobu.git
```

## How it talks to Lobu

The plugin reuses your `lobu` CLI login. For each configured CLI context it
runs `lobu token --raw`, asks Lobu which workspaces that login covers, and
makes one read-only `query_sdk` call per workspace. The summary is computed
inside Lobu, so only the rows the page shows come back. Results are cached for
a minute and the page refreshes every two minutes.

The only write is Save to Lobu, which calls Lobu's own `save_memory` for each
memory you approve in the form. Tokens stay in the bb server process; the page
only receives summaries and the form's contents.

## Settings

Open them in bb under Settings → Plugins → Lobu, or use `bb plugin config lobu`.

| Setting | Default | Description |
|---|---|---|
| `contexts` | empty | Comma-separated `lobu` CLI contexts. Empty uses the CLI's active context. A login only covers the workspaces you authorized; add another with `lobu context add <name> --url https://app.lobu.ai/api/v1` and `lobu login --context <name>`, then list it here. |
| `hiddenWorkspaces` | empty | Comma-separated workspace slugs to leave out. |
| `metrics` | `[]` | JSON array of metric queries, for example `[{"workspace":"acme","entity_type":"company","measure":"spend","by":["month"],"label":"Spend by month"}]`. |
| `baseUrl` | `https://app.lobu.ai` | Change only for a self-hosted Lobu. |
| `lobuBin` | empty | Path to the `lobu` CLI. Empty tries `~/.bun/bin/lobu`, then `lobu` on `PATH`. |

## Notes

- "Items synced" counts every item a feed run fetched, including ones it had
  already seen, so it measures sync volume rather than new data.
- The 24-hour activity scan reads at most the newest 3,000 feed runs per
  workspace and says so when it hits that cap.
- "Needs you" groups the 50 newest activity items per workspace, the largest
  page Lobu returns, and counts every pending approval separately so none are
  missed.

## Development

```sh
bun install
bun test             # unit tests, including the script Lobu runs
bun run typecheck
bun run build        # regenerates lib/lobu-scripts.generated.ts, then bb plugin build
bb plugin install .  # path install for live testing
```

`lib/workspace-summary.ts` holds the code that runs inside Lobu. It must stay
self-contained. `bun run generate` turns it into the plain JavaScript in
`lib/lobu-scripts.generated.ts`, and a test fails when that file is stale.

## License

Apache-2.0
