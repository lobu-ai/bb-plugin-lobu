# Changelog

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
