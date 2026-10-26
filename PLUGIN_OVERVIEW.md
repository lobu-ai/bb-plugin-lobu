See what needs you across your Lobu workspaces without leaving bb.

## What you get

- A **Lobu** page in the sidebar: pending approvals and due Automations,
  failed Automation and feed runs, connections and devices that need
  attention, the last 24 hours of activity, and pinned metrics.
- An **Ask an agent** action on each row that opens New thread with a prompt
  about it.
- A one-line summary on the New thread screen when something needs you.

## How it works

The plugin reuses your `lobu` CLI login and makes one read-only call per
workspace. Tokens stay in the bb server; the page only receives the summary.
It never writes to Lobu.

## Requirements

The Lobu CLI (`npm install -g @lobu/cli`), logged in with `lobu login`.
