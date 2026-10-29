# Lobu for bb

A [bb](https://getbb.app) plugin that saves what your agents learn to
[Lobu](https://lobu.ai) memory, hands it back to the next thread, and shows
what bb saved inside Lobu's own app.

## The Lobu page

A **Lobu** page in the bb sidebar shows Lobu's events page, signed in with
your `lobu` CLI login and filtered to the memories bb saved. When bb saved to
more than one workspace, it shows the one saved to most recently.

The bar at the top has:

- A **context picker** listing your `lobu` CLI contexts, like the Lobu Mac
  app. The choice is remembered.
- **New context** (+), which adds a CLI context from a name and a Lobu URL and
  signs it in. The CLI opens Lobu's approval page in your browser, and the
  page switches to the new context once you approve.
- **Reload**, and **Open in browser** for the same view in a browser tab.

The Lobu server has to allow bb's address to frame it; see [Notes](#notes).

## Memory

Agents in bb forget everything when a thread ends. The plugin keeps the
useful parts in your Lobu memory and hands them back to the next thread, so
a gotcha found once is not rediscovered every week.

It works as a loop:

- **Threads start with their project's brief.** Every new thread gets a short
  section with what you pinned to its bb project and what earlier threads
  there learned, most used first. It stays under bb's 4,096-character limit
  for plugin instructions.
- **Agents search before they work.** A `lobu_search` tool searches your
  personal workspace and the Lobu workspace you linked to the project. Only
  saved memories come back, not browser history or other connector content.
- **Agents save what they learn.** A `lobu_remember` tool saves decisions,
  non-obvious facts, and standing preferences, at most three at a time and
  each with an evidence quote. With **Save memories automatically** on (the
  default), they go straight to your personal workspace, and anything Lobu
  already holds is skipped. With it off, a review form opens first.

You see it in the thread's **Lobu memory panel**. Open it from the side
panel's new-tab menu. It shows what the thread started with, what the agent
looked up, and what it saved. Every saved memory can be undone or pinned to
the project. The panel also shows the project's linked workspace, its pins,
a box to add a note every new thread should know, and the exact brief its
threads start with. Undo hides the memory with Lobu's own delete, which keeps
it recoverable in Lobu. To move or edit a memory, open it in Lobu.

You can still save by hand. Hover any message and choose **Save to Lobu**, or
highlight part of an answer and pick **Save to Lobu** from the selection
menu; a review form opens with that text. **Save learnings to Lobu** in the
thread's ⋯ menu asks the agent to look back over the thread.

![The review form, with two memories proposed from a thread](docs/screenshots/save-to-lobu.jpg)

**Recap archived threads**, off by default, has a hidden agent read each
thread you archive and saves its memories like any other. It needs auto-save
on, since nobody reviews a form in an archived thread. Each recap is one agent
turn; set **Recap provider** and **Recap model** to a small, cheap model.

Agents pick up new tools and the brief when their session starts, so threads
that were already open before you installed or updated the plugin need a new
thread first.

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

The plugin reuses your `lobu` CLI logins. bb opened from the Dock does not
see your shell's `PATH`, so the plugin reads `PATH` once from your login shell
and runs the CLI with it, the same way your terminal does. It runs `lobu context list --json`
and keeps every context that is logged in to the configured Lobu URL. For each
one it runs `lobu token --raw` and asks Lobu which workspaces that login covers.

Memory writes use Lobu's own tools: `save_memory` to save, and `run_sdk` with
`knowledge.delete` to undo. Searches use
`search_memory`. What the plugin saved, project links, pins, and each
thread's log stay in the plugin's bb storage. Recaps read the archived thread through bb's
own thread API. CLI tokens stay in the bb server process. The page receives
the form's contents and, for the embedded app, a Lobu web session
the server mints with Lobu's `/api/extension-session`, the route Lobu's Chrome
extension and Mac app use. The session reaches the frame in the URL fragment,
which is never sent to a server, and Lobu's bootstrap page removes it from
history before signing the frame in. Lobu's bootstrap page always lands on
its home page, so the plugin then moves the signed-in frame to the events
page filtered by the ids of the memories bb saved (`content_ids`).

## Settings

Open them in bb under Settings → Plugins → Lobu, or use `bb plugin config lobu`.

| Setting | Default | Description |
|---|---|---|
| `hiddenWorkspaces` | empty | Comma-separated workspace slugs bb never saves to or searches. |
| `baseUrl` | `https://app.lobu.ai` | Change only for a self-hosted Lobu. |
| `lobuBin` | empty | Path to the `lobu` CLI. Empty tries `~/.bun/bin/lobu`, then `lobu` on your login shell's `PATH`. |
| `autoSave` | `true` | Save what agents learn to your personal workspace without asking. Off opens a review form for every save. |
| `recapOnArchive` | `false` | Recap threads when you archive them and save what they learned. Needs `autoSave`. |
| `recapProvider` | empty | Provider id for recaps, such as `acp-opencode`. Empty uses the archived thread's provider. |
| `recapModel` | empty | Model for recaps. Empty uses the provider's default. |

## Notes

- Memory uses the workspaces your CLI logins on the configured Lobu URL
  cover. Each login only covers the workspaces you approved when you signed
  in. If one is missing, sign in again and approve it, or add a context with
  **New context**.
- The context picker needs a Lobu CLI with `lobu context list --json`. An
  older CLI shows only its active context.
- bb saves to the Lobu in the `baseUrl` setting, so a context on another
  Lobu shows nothing from bb.
- The embedded app needs the Lobu server to allow bb as a frame ancestor.
  Lobu sends `frame-ancestors` from its `FRAME_ANCESTORS` setting, so a
  self-hosted Lobu adds bb's address there, for example
  `http://127.0.0.1:38886`. Until it does, the frame shows the browser's
  blocked-page icon; **Open in browser** still works.

## Development

```sh
bun install
bun test
bun run typecheck
bun run build        # bb plugin build
bb plugin install .  # path install for live testing
```

## License

Apache-2.0
