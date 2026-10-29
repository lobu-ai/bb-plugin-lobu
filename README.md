# Lobu for bb

A [bb](https://getbb.app) plugin that saves what your agents learn to
[Lobu](https://lobu.ai) memory and hands it back to the next thread.

## Getting connected

After you install the plugin, a **Connect Lobu memory** card on bb's New
thread screen walks you through setup, one button at a time:

1. **Install the Lobu CLI.** The plugin talks to Lobu through the `lobu`
   CLI. If bun or npm is on your login shell's `PATH`, the button runs
   `bun add -g @lobu/cli@^24` (or `npm install -g @lobu/cli@^24`), never
   with sudo, then checks that `lobu --version` runs. If that fails, or
   neither tool is found, the card shows the command to run yourself and a
   **Check again** button. An older CLI gets an **Update** button instead.
2. **Choose where your memory lives**, as in the Lobu Mac app:
   - **Use Lobu Cloud** runs `lobu login --context lobu`, which opens Lobu's
     approval page in your browser. You can create a Lobu account there too.
     The card updates once you approve.
   - **Run Lobu on this machine** uses a local Lobu that is already serving
     (the Mac app's, or your own `lobu run`) through the `local` CLI context.
     Otherwise it starts `lobu run` in `~/lobu-bb`, a project whose `.env`
     holds the key Lobu encrypts stored secrets with, and stops it when bb
     stops. `lobu run` signs the `local` context in by itself. The Mac app's
     own project (`~/lobu`) keeps its key in the Keychain, so bb never starts
     it: open the Lobu app instead.
3. The card disappears once bb is connected.

The same steps live on in Settings → Plugins → Lobu, in a **Lobu account**
section: which Lobu bb uses, who it is signed in as, the workspace agents
save to, and how many memories bb has saved there, with a link to them. Switch
between Lobu Cloud and Lobu on this machine there, or pick **Another Lobu…**
to add a self-hosted Lobu by name and URL, which adds a `lobu` CLI context
and signs it in the same way.

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

To see everything bb saved, choose **See everything bb saved in Lobu** in the
panel, or **Open what bb saved in Lobu** in the thread's ⋯ menu. Both open
Lobu's events page filtered to those memories, in bb's browser or yours,
following your bb browser setting.

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
- bun or npm, so the plugin can install the Lobu CLI for you. Without either,
  install `@lobu/cli` yourself.

## Install

```sh
bb plugin install git:https://github.com/lobu-ai/bb-plugin-lobu.git
```

## How it talks to Lobu

The plugin uses one `lobu` CLI login: the context picked in the Lobu account
section (kept in the plugin's bb storage), or the CLI's active context until
you pick one. It runs `~/.bun/bin/lobu`, else the first `lobu` on your login
shell's `PATH`. bb opened from the Dock does not
see your shell's `PATH`, so the plugin reads `PATH` once from your login shell
and runs the CLI with it, the same way your terminal does. It reads the
context's Lobu URL from `lobu context list --json`, and who it is signed in
as, its workspaces, and its token from `lobu whoami --json --include-tokens`,
the same source the Lobu Mac app reads. A Lobu on this machine takes the
worker token its `lobu run` minted.

Memory writes use Lobu's own tools: `save_memory` to save, and `run_sdk` with
`knowledge.delete` to undo. Searches use
`search_memory`. What the plugin saved, project links, pins, and each
thread's log stay in the plugin's bb storage. Recaps read the archived thread through bb's
own thread API. CLI tokens stay in the bb server process; the page never
receives one. "Open in Lobu" links to Lobu's events page filtered by the ids
of the memories bb saved (`content_ids`), so it shows them to whoever is
signed in to Lobu in that browser.

## Settings

Open them in bb under Settings → Plugins → Lobu, or use `bb plugin config lobu`.

| Setting | Default | Description |
|---|---|---|
| `autoSave` | `true` | Save what agents learn to your personal workspace without asking. Off opens a review form for every save. |
| `recapOnArchive` | `false` | Recap threads when you archive them, with the thread's own provider, and save what they learned. Needs `autoSave`. |

## Notes

- Memory uses the workspaces the login bb uses covers. Each login only covers
  the workspaces you approved when you signed in. If one is missing, sign in
  again and approve it.
- Switching logins needs CLI 24 or newer (`lobu context list --json`). With an
  older CLI the plugin uses its active context on `https://app.lobu.ai`, and
  the setup card offers an update.

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
