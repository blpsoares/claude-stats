# Session utility shell — design

**Date:** 2026-09-08
**Status:** approved, not implemented
**Branch:** `feat/session-shell`

A real shell, in the session's own folder, docked as the last band of the session panel — the
thing you reach for when the assistant says "run `bun test`" and you would rather not leave the
dashboard to do it.

---

## 1. What it is

A full PTY (`vim`, `htop`, colours, `Ctrl+C` — not a command runner) opened in the **cwd of the
selected session**, rendered inside `SessionPanel`. One shell per session. Selecting another
session shows that session's shell, in that session's folder.

It is docked as the **last band**, below the composer — the VS Code geometry, where the panel is
always the bottom-most strip. A drag handle sits on its top edge. On desktop it can be popped out
into the floating window; on mobile it is a full-screen sheet (§6).

### It is called "Shell", not "Terminal"

The session header already carries a `Chat | Terminal` toggle, and that "Terminal" is the
**assistant's own screen** — the tmux pane `claude` is drawing in, where a permission dialog is
answered. Two controls named "Terminal" on one bar, doing different things, is an ambiguity nobody
untangles on their own. So this one is **Shell**, and its band title reads `SHELL · ~/agentistics`.

### Three terminals, and what tells them apart

| surface | what it shows | who types into it |
|---|---|---|
| `Chat` | the readable conversation | you, to the assistant |
| `Terminal` (existing) | the assistant's tmux pane | you, to answer its dialogs |
| `Shell` (this) | a shell you started | you, to the shell |

---

## 2. Architecture — reuse, not a second emulator

Everything needed to render and drive a tmux pane in the browser already exists and is already
hardened. This feature opens a new pane and points that machinery at it.

| piece | file | reused as-is |
|---|---|---|
| xterm emulator, lazy chunk | `packages/web/src/components/SessionTerminal.tsx` | yes |
| SSE read channel + honesty line | `packages/web/src/lib/terminalStream.ts` | yes |
| WS write channel | `packages/web/src/lib/terminalInput.ts`, `sessions/input-web.ts` | yes |
| frame shape + dedup | `sessions/terminal-stream.ts` | yes |
| tmux argv and parsing | `sessions/tmux-cli.ts` | extended |
| floating window (drag/resize/minimise/FAB) | `packages/web/src/components/TtyChat.tsx` | pattern reused |
| shimmer motif | `filters-shimmer-scan` in `index.css` | reused |

The read and write channels are generic over *a tmux session name*. What is new is the **scope
check**: the fleet routes resolve an id against `managed-sessions.json`, and a shell is not in
there (§3). So the shell gets its own routes, and the capture/stream hub is keyed by tmux session
name with the scope decided per route.

New routes, all registered in `capability-guard.ts` under `localShell`:

```
POST   /api/shell/open    { sessionId }            -> { shellId, cwd } | refusal
GET    /api/shell/stream  ?id=<shellId>            -> SSE, same frames as /api/fleet/stream
WS     /api/shell/input   ?id=<shellId>            -> same protocol as /api/fleet/input
GET    /api/shell/list                             -> every open shell + the kill-modal facts
POST   /api/shell/close   { ids: string[] }        -> { closed, refused }
```

`/api/shell` is registered **explicitly** rather than riding the `/api/fleet` prefix: a shell is
not a fleet row, and filing it under that prefix would be the first step toward it becoming one.

### Backend

A shell is a tmux session named `agentop-shell-<shellId>` running `$SHELL` (falling back to
`/bin/bash`) with `-c <cwd>`. It is created detached and never attached by us — the browser reads
it through `capture-pane` and writes through `send-keys`, exactly as the assistant panes are read
and written today.

Windows without tmux: `SessionBackend` already has no Windows backend and says why (Bun exposes no
PTY primitive; a native module cannot live in the single compiled binary). The Shell button is
therefore **absent** there, and the sentence says to use WSL — the same refusal, not a new one.

---

## 3. The isolation that is the whole point

**Shells never enter `managed-sessions.json`.** They live in their own store,
`~/.agentistics/shells.json`.

This is not tidiness. Measured facts from this repo:

- `host.sessions()` — the fleet snapshot — **"walks every session and captures its pane: ~200 ms
  measured here"** (`sessions/fleet-web.ts`, the `SNAPSHOT_TTL_MS` comment). It runs every 5 s in
  the cockpit, in the web fleet poll, in the VS Code extension, and on every `/api/fleet` call.
  Its cost scales with the number of rows in the registry.
- The terminal capture loop is `TERMINAL_POLL_MS = 500` (`sessions/terminal-stream.ts`) — two tmux
  reads a second, and **viewer-gated**: a pane nobody watches costs nothing here.
- A detached idle `bash` is a few MB of RSS and 0 % CPU. `memory-budget.ts` exists because this
  machine really does hit swap thrash, but what it budgets is *assistants* (hundreds of MB), not
  shells.

So the bottleneck is not how long a shell lives — it is whether the shell is a fleet row. In the
registry, every shell ever opened would add a pane capture to a 5-second loop in four processes.
It would also:

- appear as a row in the sessions list, the cockpit, `agentop session ls` and the VS Code panel;
- be probed by `attention.ts` for dialog markers — and a shell displaying `attention-rules.ts` on
  screen is exactly the footer false-positive CLAUDE.md documents;
- take a `lastSeenMs` heartbeat write every 60 s;
- count toward "N sessions waiting on you", so an `htop` would read as a session needing a person.

Consequently, and asserted by tests:

- `shells.json` is a separate file with a separate writer.
- No shell id is ever accepted by a `/api/fleet` route.
- `buildSessionViews` never sees a shell.

### Unwatch discipline

The capture loop runs **only** while the band is open **and** the session is selected **and** the
document is visible. Collapsing the band, switching session, or backgrounding the tab stops the two
reads a second. This is the only per-second cost the feature has, and it is already the documented
rule for `/api/fleet/stream` ("capture is viewer-gated, so a surface that forgets to unwatch leaves
a `capture-pane` loop running for a screen nobody can see").

---

## 4. Lifetime — a ceiling, never a timer

A shell **lives until you close it**. It survives switching session, reloading the page and closing
the browser: coming back reattaches with the scrollback and with whatever finished while you were
away. Typing `exit` ends it and removes the record — the ordinary death.

**Ceiling: 8 shells per machine.** No idle timer.

A TTL was considered and rejected. It kills the `bun test` that finished at minute 61 and whose
output you wanted, at an hour you were not watching — and it needs a timer running forever. A
ceiling needs nothing running at all: it is one check, on open, and it only ever closes something at
the instant you are asking for a new one, so the trade is visible at the moment you make it.

---

## 5. The ceiling modal

Opens **only** on the attempt to open the ninth shell. Never on its own.

**The list:** one row per open shell, with a checkbox — the owning session, the folder, what is
running now, and how long since you last looked at it.

**"Recommended" means one of three rules, in this order**, and every recommended row **says which
rule caught it**:

1. `the owning session no longer exists`
2. `the folder no longer exists` — a real case, not hypothetical: on this machine
   `tmux list-panes` reports `agentop-908aa835a7` with an **empty** `pane_current_path`, the removed
   worktree that `repo-facts.ts` documents
3. `idle, and longest unseen` — the tiebreak, oldest first

**The rule that overrides all three: a shell with live work is never recommended.** Killing it
destroys work, and that is the one irreversible mistake this modal can make.

### How "idle" is decided, and why not the obvious way

`pane_current_command` reports only the **foreground** command — verified here: all eight assistant
panes report `cmd=claude`, an idle shell would report `bash`, a running test `bun`. But a job sent
to the background (`bun test &`) reports `bash` and would read as idle.

So the test is **"does the pane's shell have any child process"**, read from `/proc` the way
`proc-liveness.ts` already does. It costs one sweep, when the modal opens, never in a loop.

### The button

`Matar recomendados (N)` with the shimmer, built on the existing `filters-shimmer-scan` keyframes.

Pressing it **selects** the recommended rows; it does not kill. The kill is the second step, on the
confirm button, with the names in view. The shimmer chooses, the person authorises.

**When nothing is recommendable** (all eight have live work), the button is **absent** — not
disabled — and a sentence takes its place: *"Every terminal has a command running — pick one
yourself."* A control that is present and refuses teaches nothing; its absence plus the sentence
says why.

---

## 6. Mobile

The band does not survive literal translation. At 390 px with the keyboard open there are ~250 px of
visible height; split between conversation, composer and shell that is ~80 px each — four lines of
terminal.

So on mobile the Shell is a **full-screen sheet** over the session, with a back control at the top —
the same shape `ProjectsModal`, the drawers and the Nay chat already take there.

**Key strip:** `esc  tab  ctrl  ↑  ↓  ←  →`, above the system keyboard. Without it there is no
`Ctrl+C` on a phone, and the cockpit already records that a soft keyboard has no arrow keys at all.

Per the mobile rules in CLAUDE.md, delivered in the same change, not as a follow-up:

- touch targets ≥ 44 px on mobile (and 44 px is the *mobile* number — not applied on desktop);
- any visible `<input>` computes to ≥ 16 px, or iOS Safari zooms the viewport and breaks the sticky
  header (the global guard in `index.css` is not overridden inline);
- `document.documentElement.scrollWidth <= window.innerWidth` verified at 390 px;
- the terminal scrolls inside its own container, never the page body.

---

## 7. Security

A raw shell is strictly more powerful than the chat, which `chat-gate.ts` already calls "the most
powerful thing this server does". Same discipline, applied more strictly:

- **`CAPS.localShell` is required** — already false outside the `local` profile.
- **A switch of its own in Settings, and an absent preference reads as OFF.** Nobody acquires a
  browser shell by having upgraded. Deliberately the same reading `chatAllowed` takes, and
  deliberately not the `shareMode` migration reading.
- The preference may only ever **narrow** `CAPS.localShell`. A preference that could re-enable what
  `public` denied is the opt-in `exposure.ts` exists to make impossible.
- **Enforced in the route handlers, before the shell routes** — not only in the UI. A hidden button
  is not a closed door.
- **A central never offers it.** It aggregates other machines and has no host to serve; the same
  reason `usePlanBasis` refuses the plan basis there.
- `/api/team/session` reports `shellEnabled` (capability AND switch) separately from
  `capabilities.localShell` (the profile alone), so Settings can say "your profile allows this, you
  have it off" — mirroring what Chat already does.

---

## 8. Honest refusals

- **The session's folder no longer exists** → refuse, in a sentence naming the path. It does **not**
  fall back to `$HOME`. Opening a shell somewhere other than where it was asked for is the same
  class of error as a confident `0` for a metric nobody can produce.
- **No tmux** → the button is absent and says to use WSL (§2).
- **The shell's process died** → the last frame stays readable and is marked finished, with no
  cursor. `terminalStream.ts` already draws this distinction and it is inherited unchanged: a frozen
  screen that looks alive is the lie that channel exists to avoid.
- **The stream cannot be opened** → the band says which of "not found", "gone" and "error" happened.
  Three different facts keep three different sentences.

---

## 9. Client state

| state | where | why |
|---|---|---|
| which shells exist, their cwd, their tmux name | `~/.agentistics/shells.json` (server) | shared across every viewer; must outlive the tab |
| band open/closed, band height, floating vs docked | `localStorage` | a per-viewer convenience; the CLAUDE.md rule for exactly this |
| which session is selected | existing `SessionsPage` state | unchanged |

Every `localStorage` read and write is wrapped in `try/catch` and the band renders correctly with no
stored value — thumbnail capture and browsers blocking site data make the accessor itself throw.

---

## 10. Pure modules, and what is tested

Following the repo's own split, the decisions live in pure modules and the I/O is thin around them.

| module | purity | holds |
|---|---|---|
| `sessions/shell-spec.ts` | pure | which shell binary and argv, the cwd rule, the refusals |
| `sessions/shell-reap.ts` | pure | the three recommendation rules, their order, the never-recommend override, the ceiling arithmetic |
| `sessions/shell-store.ts` | I/O | `shells.json` read/write |
| `sessions/shell-web.ts` | I/O | the five routes |
| `web/src/lib/shellBand.ts` | pure | band geometry, the docked/floating/sheet decision, the empty-state sentences |

Tests that must exist:

- `shell-reap.test.ts` — a busy shell is never recommended, including with the job in the
  background; the rule order; an empty recommendation set; the ceiling boundary at 8 and 9.
- `shell-spec.test.ts` — a missing cwd refuses rather than falling back; no tmux refuses by name.
- An isolation test asserting no shell id resolves through any `/api/fleet` route and that
  `shells.json` and `managed-sessions.json` have separate writers.
- `capability-guard.test.ts` — `/api/shell` resolves to `localShell`.
- The mobile check at 390 px (`scrollWidth <= innerWidth`).

---

## 11. Deliberately not in scope

- **Tabs / several shells per session.** One per session is the shape that was asked for and the one
  the ceiling is sized against.
- **A shell not attached to a session.** There is no cwd to open it in that is not a guess.
- **Shells on remote members.** A member's shell would be a host shell on someone else's machine
  reached through the central; that is a different security question and belongs to its own design.
- **Reflowing the capture to the box width.** `SessionTerminal` scales instead, for the reason its
  header records; nothing here changes that.

---

## 12. Build order

Four phases, each one shippable and each one verifiable on its own. The gate rule from CLAUDE.md
holds throughout: **the mobile branch is built in the same change as its desktop half**, never as a
follow-up.

1. **The shell exists.** `shell-spec.ts`, `shell-store.ts`, the tmux session, `POST /api/shell/open`
   and `POST /api/shell/close`, the capability registration and the Settings switch. Verifiable
   from `curl` plus `tmux list-sessions`, with no UI at all.
2. **You can see and drive it.** `/api/shell/stream` and `/api/shell/input`, the docked band in
   `SessionPanel` with its drag handle, the unwatch discipline, and the full-screen sheet with the
   key strip on mobile.
3. **The ceiling.** `shell-reap.ts`, `/api/shell/list`, the modal, and the shimmer button.
4. **The floating window.** The `TtyChat` pop-out pattern, desktop only.
