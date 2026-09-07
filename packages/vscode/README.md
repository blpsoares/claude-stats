# Agentistics

**Your coding-assistant fleet, inside the editor.** Every Claude Code, Codex, Gemini, Copilot, Kimi
and Antigravity session your machine is running — what each one is doing, which of them is blocked
waiting on you, their live screens to type into — without leaving VS Code.

It is a client of [agentistics](https://github.com/blpsoares/agentistics), the local analytics and
session manager for AI coding assistants.

---

## What it does

**Sees the whole fleet.** Every session, grouped by project, with the one that needs you at the top.
A coloured stripe, a dot and a word — so a blocked session is findable in a list of forty without
reading any of them. Pin the ones you keep coming back to.

**Shows the live screen.** Not a log: the actual terminal the assistant is drawing, colours and
cursor included, streamed from the session itself.

**Lets you type into it.** Click the screen and your keys go to the session — every key, including
Enter, Esc, Tab, the arrows and Ctrl-C. No text box, no implicit submit. The keystroke ordering is a
property of the connection rather than a hope, and one that does not land says so.

**Answers its questions.** When a session is waiting on a permission prompt, the options are read
off its screen and listed — you pick one. There is no blind "approve" button, because a key that
takes whichever row happens to be highlighted is choosing for you.

**Every verb the terminal cockpit has.** Rename, note, file under a task, open the whole task,
finish it, reopen a session that fell, stop one (with a confirmation, in red).

**Attaches for real.** One click opens a VS Code integrated terminal running the very `tmux` command
`agentop` runs, with the real detach key — read from the backend, never guessed.

**Opens sessions as editor tabs.** Several at once, one per session, each keeping its own scroll and
its own half-typed line.

**Tells you what today cost.** Cost, tokens and session count in the status bar, in USD or BRL, plus
how many sessions are waiting on you — and a notification the moment one starts waiting, fired on
the transition, never on the level.

## Requirements

- **[agentistics](https://github.com/blpsoares/agentistics) running locally** — `agentop server`.
  The panel says so and offers to start it when nothing is answering.
- **tmux**, for the session-management half — so Linux and macOS, or **WSL** on Windows. The metrics
  and the status bar work wherever the server runs.

The extension never reads your files or your `~/.agentistics` directly and never talks to tmux
itself: everything it shows comes from the local server over HTTP, on `127.0.0.1`.

## Settings

| Setting | Default | What it is |
|---|---|---|
| `agentistics.apiUrl` | `http://127.0.0.1:47291` | the local server's API |
| `agentistics.language` | `auto` | follows VS Code's display language; English otherwise |
| `agentistics.currency` | `usd` | `brl` converts with the live rate the server already fetches |
| `agentistics.notifyOnAttention` | `true` | notify when a session starts waiting on you |
| `agentistics.statusBar` | `true` | show today's totals |
| `agentistics.statusBarRefreshSeconds` | `300` | how often to re-read them |

## Commands

`Agentistics: Start a session here` · `Open a session in a tab` · `Attach to a session in a
terminal` · `Open the whole fleet in an editor tab` · `Start the local agentop server` · `Refresh`

---

Full documentation:
[docs/vscode-extension.md](https://github.com/blpsoares/agentistics/blob/main/docs/vscode-extension.md).
Issues and source: [github.com/blpsoares/agentistics](https://github.com/blpsoares/agentistics).

MIT.
