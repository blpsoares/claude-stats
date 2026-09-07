# The web Sessions workspace — design

**Status:** in progress · **Branch:** `feat/web-sessions-parity`

## The ask

Bring the web dashboard's Sessions surface to full parity with the `agentop` terminal cockpit's
sessions tab, and then go past it: turn Sessions from a *page* into a *workspace* shaped like the
AI chat applications, where the aside is the session list and the centre is the session — readable
either as its terminal or as a conversation.

## Why the web surface was not already this

The cockpit's sessions tab and the web Sessions page answered the same questions with two different
sets of rules, and the web's were the weaker ones.

- **The list was the wrong thing.** `SessionsPage` rendered `derived.filteredSessions` — the stored
  metrics history — and attached the live fleet as a decoration. So a session that is *running* but
  has no stored conversation (an `external` assistant, a `lost` row after a reboot, one started
  moments ago) was invisible on the web while the cockpit listed it and offered to reopen it.
- **Grouping, filtering and ordering were re-implemented in the browser** over `SessionMeta`, with
  hardcoded Portuguese strings in an English-only repo (`getSessionBucketKey`: "Sem repositório",
  "Todas as Sessões").
- **The title disagreed.** Two implementations of "what is this session called":
  `pickTitle` (`harness-session-file.ts`) competes the agentop label against the harness's OWN name
  — what `/rename` set, in `~/.claude/sessions/<pid>.json` — by recency, never lets a `derived` name
  compete, and treats a `collision` name as the user's name with a suffix rather than a rival.
  `sessionLabel` (`core/src/format.ts`) reads `user_label` → `title` (the AI-generated `ai-title`)
  → cleaned `first_prompt`, and never sees the harness's name at all. So a `/rename` inside Claude
  was invisible to the web, and an unlabelled session showed an AI-invented title where the CLI
  showed the real one.
- **Whole verbs were missing**: creating a session, and reopening what fell.

## The rule this design is built on

The semantics live in ONE place and both surfaces read them. That is why the first change was a
refactor rather than a feature: `sessions.ts` answered two questions in one module — what a row IS
and how many terminal columns it occupies — and the second half made the first unimportable
(`sessions.ts` → `chrome.ts` → `../components/Primitives` → Ink, which Vite cannot bundle).

- `session-fleet.ts` — the semantics: search, grouping, ordering, the cascade, the cursor, per-row
  facts, the spawn plan.
- `session-verbs.ts` — `sessionActions`, the single answer to "what may this row take", which the
  cockpit's keypress and `/api/fleet` both resolve against.
- `sessions.ts` — terminal geometry only, re-exporting every moved name so no importer changed.
- `session-purity.test.ts` — walks the transitive VALUE import graph and fails if either pure module
  ever reaches `./chrome`, `./surface`, `../components/`, Ink, or a `node:`/`bun:` builtin. Without
  it the regression is invisible here and only appears in Vite, on someone else's machine.

`/api/fleet` therefore carries the raw `ControlSession[]` alongside the presentation `FleetRow[]`.
Sending only the latter would force the browser to re-derive the arrangement, which is the one thing
this bridge exists to prevent. It is not a new class of exposure: the route is `localShell` in
`capability-guard.ts`, refused on a central and on every exposed profile.

## The workspace

`Sessions` stops being a nav item and becomes one of two **workspaces**, selected by a segmented
control pinned at the top of the aside.

- The aside is **not replaced** — it keeps its shell (width, header, footer, identity) and swaps its
  BODY. One sidebar component, two bodies; a second sidebar implementation would be a second thing
  to drift.
- The mode is **derived from the URL** (`workspaceMode.ts`), never held beside the router. A
  `useState` mode plus a router is two answers that disagree the first time anyone reloads, opens a
  link, or presses back — and a mode you cannot link to is a mode you cannot share.
- The switch is **pinned**: it sits above the scrolling body and never moves with it. The session
  list can run to hundreds of rows, and a switch that scrolls away strands somebody in a workspace
  with no visible way back.
- It carries the **attention count**, because that badge exists precisely for the moment you are
  looking at the dashboard and a session starts needing you. Number and colour together — a count
  said only in colour is a count nobody can read.
- `Sessions` leaves both the `SideNav` `items` array and the `MobileBottomNav` `navTiles`; the
  switch appears in the mobile sheet, because a mode reachable only on a wide screen is a mode a
  phone cannot leave.

### Aside layout

Icon row → pinned mode switch → the mode's nav items → a scrolling section with its own heading and
controls → a pinned footer (one standing item, then the account row).

Collapsed, the aside shrinks to the icon row; `Ctrl+B` toggles it, and hovering the toggle reveals
the whole sidebar as a floating panel. Three constraints on that flyout:

- it renders the SAME sidebar body, not a copy;
- **focus opens it too** and `Escape` closes it — a control reachable only by hover is unreachable
  to a keyboard;
- **touch has no hover**: at mobile widths this is a drawer.

The reference's search icon is deliberately absent from the dashboard workspace: it would have
nothing to open there, and a control that does nothing is indistinguishable from one that is broken.
It arrives with the session list, which is the thing there is to search.

### Sessions workspace, left column

The fleet, grouped by DAY (today first), ordered by most recent response, with rows needing a person
ranked up. Ordering and ranking already exist (`session-order.ts`). Day grouping does **not** exist
as a dimension yet — it must be added to `session-dimensions.ts` as a real dimension, which gives
the terminal cockpit the same grouping; `session-dimensions.test.ts` requires every
`SessionGroupingId` to agree with its filter dimension, so it cannot be a web-only special case.

Everything the cockpit's aside offers comes with it: the layout block and cascade, the groupings,
the SHOW switches, the sort block, the per-state block with counts, the task scope including the
unfiled bucket, the project scope, marks, and search with scopes.

### Sessions workspace, centre

With nothing selected: the active fleet's summary — spend, time in active sessions, harness
breakdown, a chart. It obeys the N/A rule. On a central, where `capability-guard` refuses the route,
or when the poll failed, it **says so in words** and draws no chart of zeros. `liveEmptyNotice`
(`web/src/lib/sessionLive.ts`) is the precedent.

With a session selected: that session, as **Terminal** or as **UI**.

- Terminal already exists — `SessionTerminal.tsx` over `/api/fleet/stream`, frames from
  `capture-pane`.
- UI is a conversational view: the transcript as message bubbles (the renderer exists in
  `HarnessChat.tsx`), a composer that sends through `POST /api/fleet/act` with `prompt`, and the
  approval dialog rendered as an in-chat choice card.

Four things the UI view must state rather than hide:

1. **It cannot exist for every harness.** The link between a live managed session and its transcript
   is exact only where the CLI accepts an id at spawn (`SpawnSpec.assignId` — claude, copilot). Where
   no link exists the view is ABSENT and the row says so; a chat silently showing another
   conversation from the same directory is the failure mode being avoided.
2. **It is not token-by-token.** The transcript is a file; content arrives per turn or per block.
3. **Approval dialogs are not in the transcript** — they are on the screen. They are parsed by
   `approval-spec.ts` / `dialog-choice.ts` and rendered as a choice card, and a numbered dialog on a
   harness with no verified way to select by number is REFUSED in words, never answered with the
   bare confirm key.
4. **The composer is disabled while a dialog is open**, because `promptSession` already refuses
   there: a prompt typed into a dialog goes into its filter and the submit takes the highlighted
   option. The UI must not offer what the server will refuse.

## Creating a session from the web

The full path the terminal wizard asks — harness, where, task, model, effort, prompt, name, how —
not a reduced form. What the web adds is that each answer is shown rather than spelled: vendor marks
on the harnesses, a git mark on a repository and a folder mark on a plain directory (read from
`repo-facts.ts` / `project-source.ts`, never re-guessed from the path string), and effort as a
coloured scale whose maximum plays an active effect.

Two constraints:

- The harness list comes from `availableHarnesses()` — CLIs actually on PATH, with the "cannot tell"
  fallback. Not a second list.
- `model` and `effort` are **skipped**, not shown-and-disabled, when the spawn spec has no flag for
  them. The effort scale decorates a CLOSED set read from each tool's own `--help`; the animation
  may never imply a level the harness does not accept.

`reopenFell` reuses `planCrashGroup` and `task-reopen.ts` rather than re-deciding what fell.

## System dependencies

When a dependency is missing — tmux above all — detect it, name it, and OFFER the install. Never run
a package manager unasked: *anything agentop writes outside its own directories is an explicit act of
the user, and is exactly reversible*. A pure module maps (platform, available package managers,
missing dependency) to a proposed command plus the words that describe it; a machine with no
recognised package manager gets a sentence and no command, never a guessed one. Windows gets an
explanation, not an offer — there is no Windows session backend.

## Order of work

1. ~~Ink-free semantics (`session-fleet.ts` / `session-verbs.ts` / purity test)~~ — done.
2. ~~Workspace switch, aside icon row, shared fleet poll, raw rows on the wire~~ — done.
3. Aside body: sections, pinned footer, collapsed hover flyout.
4. The session list in the aside: the `day` dimension, then the cockpit's full arrangement controls.
5. The centre: fleet summary, then Terminal ↔ UI per session.
6. Create a session, and reopen what fell.
7. Dependency preflight.
