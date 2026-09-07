# The VS Code extension

`packages/vscode` puts the session fleet inside the editor: the sessions your machine is hosting,
what each one is doing, which of them is blocked on you, their live screens to type into, and every
verb the terminal cockpit offers — without leaving the window.

It is a **client of the local `agentop server`** and nothing else. It never reads
`~/.agentistics`, never talks to tmux, and never imports the session manager. That is a
correctness constraint rather than a style preference: `registry.ts` serialises writes within ONE
process, and a second process read-modify-writing `managed-sessions.json` beside the running
server is the race that documentation exists to record — a record written by a short-lived process
has been observed erased by a longer-lived one, leaving a user sitting in a session no verb could
name.

```
VS Code window                          the machine
┌────────────────────────┐             ┌────────────────────────────┐
│ Sessions view (webview)│  HTTP       │ agentop server :47291      │
│ Session tabs (webview) │ ──────────► │  /api/fleet · /act · /new   │
│ status bar             │             │  /api/fleet/stream · /input │
│ integrated terminal    │ ──tmux───►  │  /api/fleet/attach          │
└────────────────────────┘             │  /api/data · /api/rates     │
                                       └────────────────────────────┘
```

## What it does

| Surface | What it shows | Where it comes from |
|---|---|---|
| **The fleet** (sidebar, or an editor tab) | every session, grouped by project, most urgent first | `GET /api/fleet` every 5s |
| **One session** — the sidebar walks into it, or it opens as its **own tab** | its LIVE SCREEN, the dialog it is blocked on with the options to answer, a composer to type into it, and every verb | `GET /api/fleet/stream` + `POST /api/fleet/act` |
| **Verbs** | approve · prompt · rename · note · task · open the whole task · finish the task · kill · reopen | `POST /api/fleet/act` |
| **Attach** | a real integrated terminal running the very `tmux` command the cockpit runs | `GET /api/fleet/attach` |
| **New session** | the wizard: which assistants this machine can start, where, the task, the first message, model and effort | `GET`/`POST /api/fleet/new` |
| **Status bar** | today's cost, tokens and session count, plus how many sessions are waiting on you | `GET /api/data`, slowly |

## Parity with the cockpit — arranged by the SERVER

Grouping, ordering, filtering and the scoped search are the cockpit's, not a second implementation:
`GET /api/fleet?view=1` runs `filterSessions` → `sessionKept` → `sortSessions` → `groupSessions`
— the same four pure functions the terminal cockpit and `agentop session ls` run — and puts the
bands on the wire already labelled (`fleet-arrange.ts`).

That is the third of three options, and the other two are why:

1. **Re-implement it in the client.** A second set of rules, which is the defect this repository is
   built against, and it drifts the day a dimension is added.
2. **Widen `FleetRow` until it IS a `ControlSession`** and make the pure functions generic. That
   couples the wire to an internal shape and rewrites modules three other surfaces depend on.
3. **Arrange it on the server**, where the real `ControlSession`s already are.

So the panel sends what the person chose and renders what comes back. It holds no list of
groupings, sorts or scopes either — those arrive from the response, already localized, so a
dimension added to `SESSION_DIMENSIONS` appears in the editor without a line changing here.

- **Group by** none · status · repo · project · task · harness · model · marked
- **Sort by** state · name · started · recent · usage · project, either direction
- **Filter** by any dimension, with counts. The counts are over the WHOLE fleet, never the filtered
  one: counting survivors makes every unselected value read zero the moment one filter is on, which
  turns the menu into a dead end you can only narrow.
- **Search in** name · folder · harness · note · task · prompt · **transcript** — the last one is a
  text scan of the conversation on disk, and is the reason the search runs on the server at all.
- **A task band** carries the task's own verbs: reopen the whole task, mark it finished (its band
  is struck through, never hidden — it is still a thing that happened), delete it. They live on the
  BAND because a task is not a session.
- **Sessions that fell together** — a reboot, a laptop closed — are offered as one group to reopen.
  The server resolves which sessions were in it (`crash-group.ts`), and it errs toward excluding: a
  row with no evidence it was ever alive is never in the group.

The **cascade** is still absent, for the reason below.

## Two views, and why a session gets its own tab

The panel has exactly two views. `list` is the fleet — cards, grouped by project, most urgent
first. Clicking one opens `session`: that session's live screen, its composer, its verbs, and a way
back. In the **sidebar** the two swap places, which is what makes a 300px column usable at all; the
list is a way IN, not a control panel with everything on it at once.

A session can also be opened as **its own editor tab**, and several can be open at once — one per
session, each keeping its own scroll position and its own half-typed line. A tab is created pinned
to one session and never shows the list, which is what makes "several at once" mean anything: the
sidebar can only ever be looking at one. Tabs are keyed by session id, so asking twice REVEALS the
one that exists rather than opening a second panel onto the same screen, and each is titled with
what the session is CALLED — a tab strip full of `3f5f21a8b0c1` is a tab strip nobody can use.

Both are the same document, driven by the same 5s poll and the same shared streams. An action taken
in the sidebar reports its result in the tab too.

## The live screen

`GET /api/fleet/stream` is the read channel documented in
[`docs/terminal-channel.md`](terminal-channel.md): SSE, one `capture-pane` loop per session however
many readers, each `frame` a complete picture with its SGR sequences intact.

- **The HOST opens the stream, not the webview.** A webview's `localhost` is the editor client's,
  which in a Remote-SSH or WSL window is not the machine the sessions are on. The extension host
  sits beside the fleet, so it is what asks, and it forwards each event over `postMessage`.
- **One connection per session, shared by every surface watching it** (`streams.ts`), mirroring the
  server's own model. Watching is tied to the route: entering a session asks for its stream, leaving
  gives it back. Capture is viewer-gated on the server, so a surface that forgot to unwatch would
  keep a loop running on the host for a screen nobody can see.
- **A stream that never delivers says so.** 10s without a first frame is reported as a stall, not
  as patience — a "Connecting…" that never resolves is indistinguishable from a dead session. A
  stall never blanks a screen that already has a frame.
- **The phase machine and the honesty line are imported, not restated**
  (`packages/web/src/lib/terminalStream.ts`). Whether you are looking at a live screen, a finished
  session or one that is gone is the same decision, in the same words, as on the dashboard. A second
  copy in an editor client would be a second set of honesty rules, and a frozen screen that looks
  alive is the one thing this feature may never be wrong about.
- **Rendering is `ansi.ts`, pure and tested — not xterm.js.** `capture-pane` has already resolved
  the spinners, the redraws and the cursor into final glyphs, so what is left is colour. xterm is
  300 KB that wants a fixed character grid and a fit addon, in a panel that is routinely 300px wide
  and resized by dragging; what it would buy is either already resolved or is the integrated
  terminal's job, one click away on every row. What it must not cost is colour fidelity, so the
  palette is the dashboard's own `xtermTheme` — the same session reads the same in both places.
  Verified against a real Claude Code frame: 19 coloured spans, no escape bytes and no unescaped
  `<` surviving into the HTML.

## Typing into a session

**You type into the screen itself.** Click it and the keys go to the session — every key, including
Enter, Esc, Tab, the arrows and Ctrl-C. There is no text field to compose a line in: that is the
dashboard's shape, where there is no focusable screen to type into, and it cannot express any of the
keys above.

That rides the WebSocket write channel at `/api/fleet/input`
([`docs/terminal-interactive.md`](terminal-interactive.md), Phase 2b): one socket per session, one
JSON message per keystroke, one ack per message. `text` is typed literally with **no submit**;
`key` is one name from the server's closed allowlist. The HOST opens the socket — a webview's
`localhost` is the editor client's, which under Remote-SSH or WSL is not the machine the sessions
run on — and `input.ts` keeps a copy of the allowlist so the client does not ASK for what will be
refused, while the server validates membership regardless.

- **Focus is the gate.** Every terminal emulator works this way: click it and you are typing into
  it, click away and you are not. It is the same explicit, per-session, revocable decision the
  dashboard's composer asks for with a button, expressed the way a terminal expresses it — and the
  strip under the screen says which of the two states you are in, because a screen that silently
  swallows keys and one that silently ignores them look identical. It is an INTENT gate; the real
  authority is the server (`localShell`, scope, and a session that is running).
- **The editor keeps working.** `ctrl+shift+*` and anything with Cmd/Win is a VS Code command and
  is never swallowed.
- **Order is a property of the transport.** One socket per session, FIFO by construction, with a
  client `seq` echoed in each ack — so `abc` then Enter cannot arrive as Enter then `abc`, and a
  keystroke that did not land is a fact the panel is told rather than a silence. Printable
  characters are still batched for 25ms into one `text`: fewer messages, and each one spawns a
  `tmux send-keys` on the host.
- **A paste is one `text` per line, with Enter between them** — the newlines in a paste are Enter
  presses, and Enter is a key.
- **A dialog does not block typing here**, unlike the dashboard's line composer: answering a dialog
  by keypress is one of the reasons this exists, and you are looking at the dialog while you do it.
  `interactionBlock` still hides the keyboard for an external row (agentop did not start it, so
  nothing can write to it) and for one that is not running.
- **No toast per keystroke.** The screen is the feedback. Only a REFUSAL is reported, because a key
  that silently did nothing is indistinguishable from a session ignoring you.

## The rules it holds — none

Every `enabled` flag, every verb label and every refusal sentence arrives **already decided** from
the server, which resolves them through the same `sessionActions` the terminal cockpit resolves
every keypress against. A second implementation in an editor extension would be a third set of
rules — after the cockpit's and the browser's — and it would go wrong in the expensive direction:
offering "answer its question" on a numbered dialog belonging to a harness with no verified way to
select by number, where the keystroke takes whichever option happens to be highlighted.

Two things the extension does compute, and both are imported rather than restated:

- **What is most urgent** is `sessionRank` (`@agentistics/tui/control/session-order`).
- **What counts as running** is `sessionRunning` (`@agentistics/tui/control/session-dimensions`).

Both were widened from `ControlSession` to `Pick<ControlSession, 'state'>` so a client holding the
reduced `FleetRow` can ask them directly.

What it *does* own is the arrangement: grouping by project, ordering the bands by their most
urgent member, the search, and which of three sentences an empty list gets (`view-model.ts`, and
its tests). The **cascade** — the directory tree the cockpit draws inside each band — is
deliberately absent: it is measured against `ControlSession.projectRoot`, which is not on the wire,
and a tree derived in the client by string-matching the project name against each `cwd` goes wrong
wherever a path segment repeats.

## Attaching

A webview has no PTY. An in-panel emulation would mean streaming frames, diffing them and
reimplementing resize and the cursor — more moving parts for a worse result than the integrated
terminal, which gives real tmux fidelity (resize, real cursor, the native detach key) for free.

So `GET /api/fleet/attach?id=<id>` returns a **ticket** — `argv`, the real `detachHint` read from
the backend, and the session's label — and the extension runs it in `vscode.window.createTerminal`.
The detach key travels with the ticket because it is the one fact the user cannot recover for
themselves: a tmux prefix they rebound makes a guessed hint actively wrong, and someone who cannot
get out is stranded in a buffer that hides their editor.

The route checks SCOPE before it answers: the row must be one this machine manages and must be
running. `attachSession` composes the command from whatever id it is given without asking whether
that session exists, so before the check an unknown id came back as a perfectly well-formed ticket
for nothing, and the client opened a terminal that printed `no such session` and sat there.

One terminal per session, reused — pressing Attach twice must not leave two terminals attached to
one tmux session, both live, both echoing the other's keystrokes, with nothing saying why.

## Starting a session

`POST /api/fleet/new` is the most powerful call on the whole route table: it spawns a billable
coding assistant, with a prompt, in a directory the request names. It is the one fleet call that
reads a directory from the body — `resume` deliberately refuses to, because reopening names an
existing conversation and a directory in the body could only ever contradict it, while STARTING is
the act of choosing where work happens and has nothing else to read it from.

What bounds it is exposure, not wording: the route is registered under `localShell` in
`capability-guard.ts` and is unreachable on a `lan` or `public` profile whoever is authenticated.

The pure `fleet-spawn.ts` reads the request and refuses in a sentence rather than repairing
anything:

- **The directory must be absolute.** A relative path resolves against the SERVER's working
  directory — wherever `agentop server` was started — and the session would open somewhere nobody
  named, correctly filed under that project.
- **The harness must be one this machine can start**, checked against `startableHarnesses()`, so a
  harness with no spawn spec is refused here for the same reason it is absent from the wizard.
- **An `effort` must be one the CLI itself prints** (`SpawnSpec.efforts` is a genuine closed enum).
  A **model** is never validated — `claude --help` documents `--model` as an alias "or a model's
  full name", so a fixed list would reject valid input the day a model ships. It is refused only
  when the harness has no model flag at all, because starting the session without the model that
  was asked for is not the session that was asked for.

`attach` is not a field of the request and cannot be: the server has no tty to hand over. A caller
that wants to enter what it started asks for the ticket, by the id the spawn returned — never by
looking for "the newest row in that directory", which on a machine already running three sessions
there is a guess.

## Waiting on you

The bell rings on the **transition**, never on the level (`attention.ts`, and its tests):

- The **first** poll after the window opens announces nothing. There is no previous state to have
  transitioned from, and a machine with nine blocked sessions would greet the user with nine
  toasts.
- Only `waiting-approval` raises a notification. Plain `waiting` also means the assistant is
  waiting on you — and is counted in the badge for exactly that reason — but it is where a session
  sits at the end of every turn, so a toast on it is a toast per turn.

The count in the status bar is a level and is only ever shown as one.

## Configuration

| Setting | Default | What it is |
|---|---|---|
| `agentistics.apiUrl` | `http://127.0.0.1:47291` | the local server's api port |
| `agentistics.language` | `auto` | `auto` follows VS Code's display language and falls back to English |
| `agentistics.notifyOnAttention` | `true` | toast on the transition into blocked |
| `agentistics.statusBar` | `true` | show today's totals |
| `agentistics.currency` | `usd` | `brl` converts the status bar with the live rate the server already fetches (`/api/rates`), through the dashboard's own `fmtCost` |
| `agentistics.statusBarRefreshSeconds` | `300` | `/api/data` is megabytes on a well-used machine, so this timer is deliberately slow; the fleet list refreshes every 5s regardless |

A setting that cannot be parsed falls back to the default **and says so**: a working panel quietly
reading a machine the user did not name is worse than a complaint they can act on.

### Today's numbers

`/api/data` is summed **per session, for today only**, by the **UTC** day
(`start_time.slice(0, 10)`). Two day rules exist in this repo, and this is the one the dashboard's
own date presets use (`utcStartOfDay`); at UTC-3 the two disagree for three hours every night,
which is exactly when someone would notice a status bar contradicting the dashboard beside it and
stop believing both. `stats-cache.json` is not consulted: it is Claude-only, and today's sessions
are all still on disk for every harness, so the per-session sum is both complete and
cross-harness. Tokens means all four counters (`sessionTokenTotal`).

An unreachable server prints a sentence, never a zero — `R$ 0,00` from a machine whose server is
not running is a confident, wrong answer to the one question the item exists to answer.

## There is no Dashboard tab, and why

There was one: the web dashboard, framed in an editor tab. It never rendered. Three separate
server-side blockers were found and fixed along the way — `frame-ancestors 'none'`, an
`X-Frame-Options: DENY` that wins over a permissive CSP, and a `Cross-Origin-Resource-Policy:
same-origin` that a COEP embedder drops silently — and after all three the frame was still blank.
VS Code's own **Simple Browser**, which is the same webview-and-iframe mechanism, is blank on the
same URL, so whatever remains is not this extension's configuration.

It was removed rather than left in place. A tab that opens and shows nothing is worse than an
absent feature: it costs a click, a command, a setting and a page of explanation, and it teaches
people that the extension is broken. The metrics that were actually being used are in the **status
bar**, which reads `/api/data` directly, and the dashboard itself is one `agentop` away in a real
browser. The server-side header changes stay — they are correct on their own terms and they are
what an editor needs if this is ever revisited.

## The design system

The panel wears the **dashboard's** palette, not raw VS Code chrome: the same near-black surfaces,
the same Anthropic orange, the same green/amber/red accents, the same radii, and the same
per-harness colours. A panel that looks like a different product from the dashboard it sits beside
is a different product as far as the eye is concerned, and the two are one.

It is not theme-agnostic by accident. The host reads `vscode.window.activeColorTheme` and sets
`data-theme`, so a light editor gets the dashboard's LIGHT palette rather than a dark panel bolted
into a bright window — and the terminal's ANSI palette follows the same switch. Only the focus ring
and the scrollbar are borrowed from VS Code; those belong to the editor's input conventions.

## Remote windows

The dashboard URL goes through `vscode.env.asExternalUri`. In a Remote-SSH or Codespaces window
`127.0.0.1:47292` inside a webview is the LOCAL machine's, not the one the sessions are running
on, and the frame would show whatever happens to be listening at home. `asExternalUri` asks VS Code
to forward the port and hands back the address that reaches it; when it cannot, the plain URL is
used, because a local window needs no forwarding at all and a failure must not leave the tab blank
where the plain address would have worked.

For the same reason the **webview never fetches**: a webview's `localhost` is the browser's. The
extension host is the process that sits beside the fleet, so it is the process that asks.

## The two icons, and why they are different files

- **`media/icon.png`** is the gallery image — the one on the extension's marketplace page. It is
  the full-colour agentistics mark, squared, so the card does not letterbox a 323x441 image.
  Regenerate it from the vector source beside it:

  ```bash
  convert media/logo.svg -background none -gravity center -extent 441x441 -resize 256x256 media/icon.png
  ```

- **`media/icon.svg`** is the activity-bar icon and is deliberately MONOCHROME (`currentColor`).
  VS Code tints that one itself — dim when the view is inactive, the theme's foreground when it is
  — so the coloured mark would sit at one shade while every neighbour responds, which reads as a
  broken icon rather than a branded one.

## The README is the marketplace page

`packages/vscode/README.md` is what somebody reads to decide whether to install, and it is rendered
from the packaged copy — so **changing it costs a version**. It is written for that reader, not for
somebody already in the repository, and its links are ABSOLUTE: a relative link works on GitHub and
404s on the marketplace.

## Versioning

The extension is versioned **independently** of the product. It ships to a marketplace on its own
cadence and its users upgrade it separately from the `agentop` binary, so a version that moved with
every server release would carry no information about what changed in the editor.
`packages/vscode/package.json` is therefore absent from `PKG_FILES` in `release.yml` — the list of
files a product release stamps its version onto — and is bumped by hand.

## Building it

```bash
bun run build:vscode     # dist/extension.cjs + dist/webview.js
bun run package:vscode   # a .vsix, via @vscode/vsce
```

Then `F5` from the repo, or install the `.vsix` with
`code --install-extension packages/vscode/agentistics-vscode-*.vsix`.

## Installing it, and distributing it

Three routes, in order of how much they need from a maintainer.

**1. The `.vsix` on the GitHub release** — works today, needs no account from anybody.

```bash
# Download agentistics-vscode-<version>.vsix from the release page, then:
code --install-extension agentistics-vscode-1.0.0.vsix
```

The release workflow packages and attaches it beside the binaries. It is attached rather than
version-stamped by the release: the extension carries its own version, so the file says which
extension shipped *alongside* that server release rather than claiming to be the same thing. If
packaging fails, the server release still goes out and the asset is simply absent — an editor
extension must not hold back a binary.

**2. The VS Code Marketplace** — what "install it from the editor" means for most people. It needs,
once:

- an Azure DevOps organisation, and a Personal Access Token scoped to **Marketplace → Manage**;
- a publisher at <https://marketplace.visualstudio.com/manage> whose id is exactly the `publisher`
  field in `packages/vscode/package.json`.

Then `bunx @vscode/vsce publish -p "$VSCE_TOKEN"` from `packages/vscode`, or the same as a release
step once the token is a repository secret.

**3. Open VSX** — the registry VSCodium, Cursor, Windsurf and Gitpod read; the Marketplace's terms
do not allow those editors to use it. Needs an eclipse.org account and a published-agreement
signature, then `bunx ovsx publish -p "$OVSX_TOKEN"`.

**Both are automated** by `.github/workflows/publish-vscode.yml`, on the extension's OWN tag:

```bash
git tag vscode-v1.0.1 && git push origin vscode-v1.0.1
```

Its own tag, and not the product release, because the extension is versioned on its own line:
tying them together would publish an unchanged extension every time the server ships, and would
make a one-line extension fix wait for a server release.

Two secrets, added once in **Settings → Secrets and variables → Actions** — which is a browser, so
nobody needs to be logged in on any particular machine:

| Secret | | |
|---|---|---|
| `VSCE_PAT` | required | the Azure DevOps PAT above. Missing, the job FAILS: tagging a publish and getting silence is the outcome the workflow exists to prevent. |
| `OVSX_PAT` | optional | Open VSX. Missing, it is skipped with a notice — a second registry is a decision, and its absence must not fail a publish that already succeeded. |

The job **refuses a tag that disagrees with the manifest**. Publishing 1.0.0 under a tag that says
1.0.1 is a lie about which code is in the marketplace, and neither a version nor a tag can be taken
back. It also attaches the `.vsix` to a release for that tag, so an editor that reads neither
registry still has a file.

## Where each piece lives

| File | What it owns |
|---|---|
| `src/extension.ts` | activation and wiring; nothing else |
| `src/api.ts` | the only process that talks HTTP; every method total, no method inventing a value |
| `src/sessions.ts` | one poll, any number of surfaces; performs every action |
| `src/streams.ts` | one live screen per session, shared by every surface watching it |
| `src/input.ts` | the write channel's socket, and **pure** `wireFor` — what this client puts on the wire |
| `src/panels.ts` | the editor tabs — one per session, keyed so asking twice reveals rather than duplicates |
| `src/ansi.ts` | **pure** — one terminal frame, rendered as HTML, in the dashboard's palette |
| `src/protocol.ts` | the wire shapes, and the note about why no rule lives on this side |
| `src/view-model.ts` | **pure** — grouping, ordering, the search, the three empty states |
| `src/attention.ts` | **pure** — which sessions have just started needing a person |
| `src/today.ts` | **pure** — today's totals, and the day rule they use |
| `src/config.ts` | **pure** — the two endpoints, one derived from the other |
| `src/webview/html.ts` | **pure** — the CSP'd documents, and the escaping |
| `src/webview/main.ts` | the panel: DOM calls only, never `innerHTML` |
| `src/terminal.ts` | attaching, and starting the server, in terminals this window owns |
| `src/status-bar.ts` | today, and the waiting count |
| `server/sessions/fleet-spawn.ts` | **pure** — what a start request off the wire may ask for |
| `server/sessions/fleet-web.ts` | the server half: attach ticket, wizard data, spawn |

Every string on the panel is somebody's session title, note, project path or a line captured off a
terminal, so the webview is built with DOM calls and never with `innerHTML`: a template literal is
one unescaped `<` away from executing it. There is exactly **one** exception, marked at the
assignment — the terminal screen, whose HTML `ansi.ts` builds, having escaped the frame before it
coloured it.

## See also

- [`docs/session-manager.md`](session-manager.md) — the fleet itself, and every rule these routes
  are a transport for.
- [`docs/terminal-channel.md`](terminal-channel.md) — `GET /api/fleet/stream`, the read-only screen
  stream the browser uses where this extension hands over a real terminal instead.
- [`docs/security.md`](security.md) — the exposure boundary these routes sit behind.
