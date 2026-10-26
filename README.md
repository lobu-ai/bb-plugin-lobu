# Lobu for bb

A [bb](https://getbb.app) plugin that shows what needs you across your
[Lobu](https://lobu.ai) workspaces, without leaving bb.

![The Lobu page in bb](docs/screenshots/dashboard.jpg)

## What you get

A **Lobu** page in the bb sidebar with five cards, grouped by workspace:

- **Needs you**: pending approvals and Automations that are due. Identical
  requests collapse into one row that links to all of them.
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

## How it reads Lobu

The plugin reuses your `lobu` CLI login. For each configured CLI context it
runs `lobu token --raw`, asks Lobu which workspaces that login covers, and
makes one read-only `query_sdk` call per workspace. The summary is computed
inside Lobu, so only the rows the page shows come back. Results are cached for
a minute and the page refreshes every two minutes.

Tokens stay in the bb server process. The page only receives the summary. The
plugin never writes to Lobu.

## Settings

Open them in bb under Settings → Plugins → Lobu, or use `bb plugin config lobu`.

| Setting | Default | Description |
|---|---|---|
| `contexts` | empty | Comma-separated `lobu` CLI contexts. Empty uses the CLI's active context. A login only covers the workspaces you authorized; add another with `lobu login --context <name>` and list it here. |
| `hiddenWorkspaces` | empty | Comma-separated workspace slugs to leave out. |
| `metrics` | `[]` | JSON array of metric queries, for example `[{"workspace":"acme","entity_type":"company","measure":"spend","by":["month"],"label":"Spend by month"}]`. |
| `baseUrl` | `https://app.lobu.ai` | Change only for a self-hosted Lobu. |
| `lobuBin` | empty | Path to the `lobu` CLI. Empty tries `~/.bun/bin/lobu`, then `lobu` on `PATH`. |

## Notes

- "Items synced" counts every item a feed run fetched, including ones it had
  already seen, so it measures sync volume rather than new data.
- The 24-hour activity scan reads at most the newest 3,000 feed runs per
  workspace and says so when it hits that cap.
- "Needs you" reads the 50 newest activity items per workspace, the largest
  page Lobu returns.

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
