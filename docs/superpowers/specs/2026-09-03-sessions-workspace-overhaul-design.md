# Sessions workspace overhaul — design

**Date:** 2026-09-03
**Base:** `origin/dev` (`14344e8e`)
**Branch:** `feat/sessions-overhaul`
**Status:** approved design, ready for an implementation plan

---

## What this is

Eleven changes to the Sessions workspace, agreed one by one with the user, plus the extension of
the central relay they require in order to hold on a central as well as on a machine. They are
grouped into phases that are independently verifiable and ordered so that nothing in a phase
depends on a later one.

The recurring rule the whole document is written against is the one CLAUDE.md already states in
several forms: **an absent capability is said in words, never rendered as a control that silently
does nothing, and never as a confident zero.** Every refusal below carries a sentence.

### The eleven asks, mapped to phases

| # | Ask | Phase |
|---|---|---|
| 1 | Reorder pinned sessions | 1 |
| 2 | The microphone must work on `https` **and** on `localhost` | 3 |
| 3 | The model list must be exactly the harness's own names and models | 0, 3, 4 |
| 4 | Invoke the skills available in the open session's harness | 3 |
| 5 | Right-click a session → rename / stop / reopen | 1 |
| 6 | Unify the filter bar into the fixed header (desktop; own strategy on small screens) | 2 |
| 7 | The strip above the composer must blur what is behind it, not cut it | 2 |
| 8 | "Active only" belongs inside the filter, on both pages; every filter must actually work | 1 |
| 9 | A general heatmap on the Sessions landing screen, honouring the filters | 1 |
| 10 | A new-session **wizard**, real vendor logos, and a session that is actually usable | 4 |
| 11 | Collapsed aside shows session icons, not the dashboard's, with a card-shaped tooltip | 1b |
| — | (found during design) An injected skill body is drawn as the user's own message | 3b |

All of it applies to **machine mode and central mode**. What that costs is Phase 5.

---

## Decisions taken during brainstorming

These were asked and answered; they are recorded so the implementer does not re-open them.

1. **Central parity is achieved by extending the relay**, not by hiding features on a central: the
   screen, the conversation, the approval dialog, `prompt`, `approve` and `spawn` all become
   relayable. (Phase 5.)
2. **Three consent switches, each off by default** — `sessions` (list + screenless verbs, exists
   today), `allowRemoteScreens` (screen, chat, dialog, `prompt`, `approve`), `allowRemoteSpawn`
   (start a session). Starting a billable process is a different question from reading a terminal,
   and one switch that grants both is a switch nobody can reason about.
3. **Models come from a verified `{ id, label }` table**, not from probing a CLI at request time.
   The repository's existing rule holds: *a value appears only if the CLI itself names it.*
4. **Skills: Claude only, and inserted into the draft** rather than sent. The other five harnesses
   get a sentence, following `modelSwitch.ts`.
5. **Pinned reorder: drag and drop**, plus `alt+↑/↓` for the keyboard.
6. **Heatmap: one combined calendar** for all harnesses, honouring every active filter, with the
   per-harness split in the day tooltip.
7. **Logos: the vendors' own marks**, SVG where published, colour preserved.
8. **"Active only" on the dashboard means intersecting with the live fleet**, which makes that
   scope cache-blind — and the page says so.
9. **Mobile keeps one bar**, with the filters in a full-screen bottom sheet.
10. **One spec, sequential phases.**

---

## Phase 0 — Foundations

Three small, load-bearing pieces the later phases all read.

### 0.1 `harnessModels.ts` — the model table gains names

**New:** `packages/core/src/harnessModels.ts` (pure).

```ts
export interface ModelOption {
  /** What the CLI accepts. Sent verbatim — never a label. */
  id: string
  /** What the harness itself calls it on screen. */
  label: string
  /** Where this pair was read from, and when. */
  verifiedAt: string
  source: string
}
export const HARNESS_MODELS: Record<HarnessId, ModelOption[]>
```

Today `SpawnSpec.modelSuggestions` is `string[]` — ids only — so the picker can only print
`opus` while the harness's own `/model` prints `Opus 5`. The ask is that the two agree. The
answer is a second field, not a second list: `spawn-spec.ts` keeps naming what `--model` accepts
and this table carries the display name beside it.

Rules carried over verbatim from `spawn-spec.ts`'s header, because they are what makes the table
trustworthy:

- **A pair appears only if the CLI itself named it** — in `--help`, in a listing subcommand, or by
  answering with it when driven. Each entry carries the command and the date that established it.
- **The `id` is what is sent, everywhere.** `modelSwitch.ts` records the measured consequence of
  getting this wrong: typing `Opus 5` into `/model` answers `Model 'Opus 5' not found`, which is a
  silent no-op the user reads as a successful switch.
- **A harness whose CLI publishes no list gets an empty array** and the picker is *absent*, with a
  sentence — never a dropdown whose only entry is "the assistant's default".
- The list stays a convenience and never a validation set: `planSpawn` must not start checking
  membership, because every one of these CLIs also accepts a full model name and several scope
  what is available to the signed-in account.

Known starting point for Claude, verified 2026-09-02 against 2.1.259 and recorded in
`modelSwitch.ts`: `fable`→`Fable 5.1`, `opus`→`Opus 5`, `sonnet`→`Sonnet 5`, `haiku`→`Haiku 4.5`.
Any variant beyond those four (a 1M-context id, for instance) is added only after driving the CLI
and seeing it accepted — the same bar, not a lower one for a variant that "obviously" exists.

`spawn-web.ts`'s `WebHarnessOption` gains `models: ModelOption[]` **beside** the existing
`modelSuggestions: string[]`, which stays for one release so the VS Code extension and any older
client keep working.

### 0.2 The vendor marks

`HarnessMark.tsx` ships one asset (`/claudeLogo.png`) and a monogram for the other five, on
purpose: *"drawing an approximation of somebody's mark and presenting it as their logo is worse
than obviously not being one."* The user has asked for the real marks, so the fix is real assets,
not better approximations.

- Files land in `packages/web/public/harness/<id>.svg` (PNG only where no vector is published).
- `packages/web/public/harness/SOURCES.md` records, per file: the URL it came from, the date, and
  the vendor's brand-asset page. A file with no recorded source may not be committed.
- `MARK_FILE` in `HarnessMark.tsx` gains all six entries.
- **The monogram stays** as the fallback for a harness added later with no asset yet. Deleting it
  would make the next harness render a broken image.
- The mark is drawn at 14–28px in several places; each SVG is checked at 14px on both themes. A
  mark that disappears on a dark background gets the neutral plate `HarnessMark` already applies.

### 0.3 `planPinMove`

`packages/web/src/lib/pinnedSessions.ts` gains:

```ts
export function planPinMove(current: readonly string[], from: number, to: number): string[]
```

Pure and total: an out-of-range index returns the list unchanged. It joins `planPinToggle` under
the same store, so order and membership are decided in one module and every reader
(`SessionsAside`, `RecentSessions`, the collapsed rail) sees the same list.

---

## Phase 1 — The list

### 1.1 Reordering pinned sessions (ask 1)

Drag and drop inside the "Pinned" band only. Ordering the other bands is meaningless — they are
sorted by `DEFAULT_ORDER`, the same ranking the terminal cockpit uses, and letting a person
reorder a computed ordering produces a list that silently re-sorts itself on the next poll.

- Native HTML drag events; no new dependency.
- `alt+↑` / `alt+↓` moves the focused pinned row, so the feature exists for the keyboard.
- On touch the row's drag handle is a 44px target.
- The drop writes through `planPinMove` → the store → `localStorage`, so it survives a reload and
  reaches every surface at once.
- A pinned session that has ended keeps its slot and its position; the existing rule that only
  pinning and unpinning change the set is untouched.

### 1.2 The row's context menu (ask 5)

Right-click (and long-press on touch) on any session row opens a menu.

**It composes nothing.** The entries come from `row.verbs`, which the server already resolves
through the same `sessionActions` the cockpit resolves every keypress against, each carrying an
already-localized `label`, an `enabled` flag and a `reason`. The menu shows, in this order:
**rename**, **stop** (`interrupt` where the row is working, `kill` where it is not), **reopen**
(`resume`).

- A verb the row cannot take is shown **disabled with its reason**, never omitted: a menu that
  silently loses half its entries reads as a broken feature and its absence explains nothing.
- `rename` opens the existing rename flow, which already writes the label on every path and says
  in words what became of the harness half.
- `Escape` closes it; the trigger keeps focus. It closes on an outside `mousedown`, like every
  other menu in the app.
- **This works on a central today**, with no Phase 5 dependency: `verbs` already travels on a
  relayed row and all three verbs are in `REMOTE_SCREENLESS_ACTIONS`.

### 1.3 Every filter must actually work (ask 8, first half)

`fleetFilter.ts` applies harness / project / repo / model and deliberately ignores date, users,
teams, machines, presence and tags, each with a recorded reason. That set is not being widened —
a live session genuinely cannot answer "last 7 days". What this task does is:

1. **Audit each applied dimension against real rows** on a machine with a mixed fleet, and record
   the finding per dimension in the module's header. The repo has already been bitten here once:
   `matchesRepo` exists because the dashboard's chips are canonical remote keys while a fleet row
   carries the short name, so repo filtering returned an empty list *every single time*.
2. **Fix what does not match**, in `fleetFilter.ts` and nowhere else.
3. **Say what is ignored.** When a filter is set on a dimension the fleet cannot answer, the list
   states it in one line ("the date range does not narrow a live fleet") instead of appearing to
   have applied it. This is the difference between a filter that is honest and one that looks
   broken.
4. `fleetFilterOptions` keeps promising only values the current view can show — including under
   `activeOnly`, which it already handles.

### 1.4 "Active only" moves into the filter, on both pages (ask 8, second half)

- The switch leaves its standalone position and becomes a dimension of the `+ Filtro` menu, in
  `FiltersBar`, offered on **both** the Sessions and the dashboard pages.
- **On Sessions** it means what it means today: keep only rows in `ACTIVE_STATES`.
- **On the dashboard** it means *conversations running right now*: the stored session set is
  intersected with the live fleet by `conversationId`. Consequences that must be honoured:
  - the scope becomes **cache-blind** — `stats-cache.json` cannot answer it, so the totals come
    from per-session sums, exactly like the project and repo dimensions
    (`cacheBlindScope` in `@agentistics/core`);
  - the page **says so** in the same one-line form other cache-blind scopes use;
  - where no fleet can be read at all (an exposed profile, a central with no machine chosen), the
    dimension is **absent from the menu with its reason**, not present and inert.
- The default stays as it is today: on in the Sessions workspace, off on the dashboard.

### 1.5 The heatmap on the landing screen (ask 9)

`FleetOverview` — the Sessions page with nothing selected — gains a combined activity heatmap
under its stat row, drawn with the existing `ActivityHeatmap`.

- **One calendar for every harness in view**, not one per harness.
- **It honours every active filter**, including "active only" and the harness chips. A heatmap
  beside filtered stats that is itself unfiltered is two numbers on one screen under two different
  rules.
- The day tooltip carries the **per-harness split** for that day, which is where the per-harness
  detail lives instead of in five separate strips.
- It reads the same derived data the dashboard reads (`useDerivedStats`), never a second
  aggregation: `stats-cache.json` stays Claude-only here as everywhere.
- With no data in the window it says so; it never draws an all-zero grid as if that were a
  measurement.

### 1b — The collapsed aside (ask 11)

Today the sessions body is withheld when the aside is collapsed, and the rail falls through to the
dashboard's `<nav>` — so collapsing the sessions workspace shows Home, Costs, Tools, Projects.
`App.tsx` records the reasoning: *"a 64px rail cannot show a session's title, and a list of
unlabelled dots is a list nobody can read."*

That objection is answered rather than overruled: **the glyph never carries the fact alone — the
tooltip does.**

- Collapsed **in the sessions workspace**, the rail renders one entry per session: the
  `HarnessMark` for its harness, with the state dot the open row already draws.
- Order is the open list's order: pinned first, then active, then inactive; the rail is capped and
  says how many more there are rather than growing without bound.
- **Hovering an entry opens a tooltip carrying exactly what the open row carries** — title, state,
  harness, model, task, project — by rendering **the same component**. The tooltip and the row may
  not be two implementations of one card; a second one drifts.
- It renders through a portal, like `CollapsedTip`, so it escapes the aside's clipping.
- Hover-only is acceptable **here and only here**: the aside is desktop-only (`SideNav` is not
  rendered below the breakpoint), so there is no touch reader being asked to hover. The tooltip
  also opens on keyboard focus.
- The dashboard's nav is still reachable — the workspace switch lives above the body and is
  unchanged.

---

## Phase 2 — One header, and a composer that blurs

### 2.1 Desktop: the filter bar moves into the fixed strip (ask 6)

Today the sessions workspace has two stacked bars: the fixed 44px strip (mark, search, aside
toggle, and — with a session open — its title, the chat/terminal tabs and the actions menu), and
under it the sticky `<header>` carrying `FiltersBar`.

They become one row:

```
logo · search · aside toggle │ title · state · repo │ FILTERS (centre) │ chat/terminal │ ⋯
```

- `FiltersBar` gains an `inline` mode that fits a 44px row: the date presets and `+ Filtro` on the
  line, the selected-value chip rows rendered in a popover rather than as extra rows.
- The filters take the centre and are the element that gives up width first; the title gives up
  before the tabs, and the actions menu never shrinks — it is how you act on what you are looking
  at.
- The `<header>` element is not deleted: it still draws on the dashboard, unchanged. Only the
  sessions workspace stops rendering it.
- Alignment: `FleetOverview` exports `PAGE_INSET` / `PAGE_MAX_WIDTH` precisely because the body
  and the filter row must move together. Whatever the row becomes, those two constants stay the
  single definition, and the body keeps reading them.

### 2.2 Small screens: one bar plus a bottom sheet (ask 6, mobile half)

Mobile has no shared header at all — `SessionsPage` draws its own filter row and its own
back/title/tabs bar. The unification applies there too, in the shape a 390px screen can hold:

```
← · title · state │ ⚲ filters (count) │ chat/terminal │ ⋯
```

- The filter icon carries the active-dimension count and opens a **full-screen bottom sheet**:
  44px targets, `font-size ≥ 16px` on every input (the global guard in `index.css` handles this;
  it must not be overridden inline), Apply/Clear pinned at the bottom, `Escape` and the backdrop
  close it, focus returns to the icon.
- The filters stop occupying fixed vertical space in a viewport that has none to spare.
- Both bars carry `padding-top: var(--safe-top)`, as they do today: installed as a PWA this row is
  the topmost thing on screen.
- **Verify at 390px**: `document.documentElement.scrollWidth <= window.innerWidth` must hold on
  the list, on an open session, and with the sheet open.

### 2.3 The composer blurs what is behind it (ask 7)

The composer's container is already `background: transparent`, so what the user is seeing is the
region behind the field cutting the conversation with a hard edge. It becomes a real overlay:

- a `backdrop-filter: blur(…)` layer over a gradient that runs from fully transparent at the top
  to the surface colour at the bottom, with a matching mask, so a message scrolls *under* the
  composer and fades out instead of being clipped by a solid band;
- `-webkit-backdrop-filter` alongside it, and a solid `--bg-base` fallback under
  `@supports not (backdrop-filter: blur(1px))` — the effect degrades to today's behaviour rather
  than to unreadable text;
- the same treatment in the **terminal** view's input strip, so the two views do not disagree;
- the field itself keeps its border and its own opaque surface: the thing people recognise as
  "where I type" must stay a bounded box, which is a rule this file already records.

---

## Phase 3 — The composer

### 3.1 The microphone (ask 2)

**The browser fact this design is built on:** no browser grants a microphone on an insecure
origin. `getUserMedia` and the Web Speech API are both blocked on `http://<lan-ip>`, and
`localhost` **is** a secure context. So "it must work on localhost" is a bug report about
localhost, not a request for a new transport — and it must be reproduced before it is patched.

Three corrections, all of which stand whatever the reproduction finds:

1. **The recogniser's error reason must reach the screen.** `rec.onerror = () => {…}` currently
   discards the event, so a `network`, `not-allowed`, `no-speech`, `audio-capture` or
   `service-not-allowed` failure all look identical: the button lights up and goes out. Each maps
   to its own sentence in EN and PT. `network` in particular is the common Chrome failure and
   today is indistinguishable from "nothing happened".
2. **`dictationSupport` must distinguish the origin from the API, and offer the way out.** It
   already returns `insecure`; the page should additionally name the `localhost` URL that would
   work, since a member machine reached at `http://192.168.x.y:47292` has an exact equivalent one
   click away. (This is the WSL case in particular: a Windows browser reaching a WSL server by IP
   has no microphone, while `localhost` forwards and does.)
3. **Reproduce and fix the localhost failure.** Under systematic debugging: confirm
   `isSecureContext`, confirm the constructor resolves, capture the actual `onerror` code, and fix
   the cause. Candidate causes already visible in the code — `continuous = true` with an
   `onresult` handler that re-reads `e.results` from index 0 on every event (which duplicates text
   as the result list grows), and an `onend` that fires immediately after a `network` error — are
   hypotheses to test, not conclusions.

No audio leaves the browser. That rule is unchanged and is not up for renegotiation in this work.

### 3.2 The model picker shows the harness's names (ask 3)

Both the composer's model menu and the wizard read `HARNESS_MODELS` (Phase 0.1): the **label** is
displayed, the **id** is sent. `modelSwitchLine` is untouched — it already takes the id.

Where a harness has no verified pairs the picker stays absent with its sentence, and where
mid-conversation switching is unverified `modelSwitchReason` still says so. Neither of those
becomes a dropdown that cannot work.

### 3.3 Invoking the session's skills (ask 4)

**New:** `packages/server/server/sessions/harness-skills.ts` — a `Record<HarnessId, SkillSource |
null>`, shaped like `rename-spec.ts` so that adding a harness breaks the build rather than
silently shipping a control that does nothing, and every `null` is a finding with its own
sentence.

Claude is the one non-null entry. Skills are discovered from:

- `~/.claude/skills/*/SKILL.md` (via `HOME_DIR`, **never** `CLAUDE_DIR` — the same distinction
  `cli-hooks.ts` and `mcp-list.ts` make, because `CLAUDE_DIR` can be a container's read-only mount
  of somebody else's home);
- installed plugins' skill directories;
- the session's own project, `<cwd>/.claude/skills/*/SKILL.md`.

The parser reads the frontmatter `name` and `description` and is pure and total: a malformed or
unreadable `SKILL.md` is skipped, never thrown.

`GET /api/fleet/skills?id=<session>` answers the list for that session's harness and cwd. It is
`localShell` by the existing `/api/fleet` prefix rule in `capability-guard.ts` — no second table.

In the composer, a picker beside the model menu **inserts `/<name> ` into the draft** and focuses
the field. It does not send. Two reasons: most skills take an argument, and the composer's whole
contract is that what reaches the session is what the person chose to send.

It inherits the `prompt` action's refusals, and states them: the session must be running, and it
is **refused while a dialog is open** — a slash command typed into a permission prompt goes into
that dialog's filter and the submit takes the highlighted option.

### 3b — A message the user did not send

**The defect.** The chat pane draws harness-injected content inside the user's own bubble. The
user circled a skill body — the whole of `SKILL.md`, headed `Base directory for this skill: …` —
and said *"that message wasn't me"*. They are right, and it is the same class of defect
`chat-envelope.ts` was created to fix, one layer deeper.

**Measured** across the 25 most recently touched transcripts on this machine — 553 `user` entries
carrying text:

| count | shape | today |
|---:|---|---|
| 439 | the person, `isMeta: false`, untagged | correct |
| 81 | the person or an envelope, tagged | handled by `chat-envelope.ts` |
| 114 | `isMeta: true` | **98 of them untagged, and drawn as the person** |

The untagged `isMeta` entries, by first line:

```
 37  Another Claude session sent a message:
 26  [Image: source: /…]
 16  Continue from where you left off.
  4  Base directory for this skill: /…      ← the block in the screenshot
  4  [Cross-session idle notice] …
  2  ## Context Usage
  2  (Re-invocation of /… — the skill …)
```

**The fix is structural, not a prefix hunt.** Claude Code already marks these entries itself:
every one carries `isMeta: true`, several also `turnCompanion: true` and a `sourceToolUseID`, and
**all 439 real person messages carry `isMeta: false`**. So:

- `classifyUserText(text)` becomes `classifyUserEntry({ text, isMeta })`;
- **`isMeta === true` is `system`**, tagged or not;
- the existing tag table stays, and keeps doing the job the flag cannot: unwrapping
  `<command-name>` / `<command-message>` / `<command-args>` / `<bash-input>` to the thing the
  person actually typed, because those *are* the person acting and dropping them would erase a
  turn that happened;
- the **body is never rendered** — a one-line note naming the kind, exactly as the module already
  does for `<system-reminder>`. A skill body is the whole of a `SKILL.md`; a pane that renders it
  has stopped being a conversation;
- an **unrecognised, non-meta** entry is still treated as the person's. That direction stays the
  safe one: a real message wrongly hidden is gone, while a new injection wrongly shown is only
  today's behaviour.

`jsonl.ts` and `chat-web.ts` must thread the flag through; the tests are fed the seven measured
shapes above.

---

## Phase 4 — The new-session wizard

### 4.1 Four steps and a review (ask 10)

`NewSessionModal` becomes a stepped wizard. The questions are the ones it already asks — nothing
is dropped, because the terminal wizard asks the full set and a reduced web form would be a second
contract.

1. **Assistant · model · effort · name.** Assistants are `startableHarnesses()` — the CLIs found
   on PATH — with the real vendor mark from Phase 0.2. Model and effort are **skipped, not shown
   disabled**, where the spawn spec has no flag for them; effort is a closed set read from each
   CLI's own `--help`.
2. **Project / repository · task.** The existing search over the local store, with a repository
   distinguished from a plain folder by the store's own answer, never guessed from the path.
3. **First message · attachments.** A textarea, a file button, and `ctrl+v` paste. Attachments go
   through the existing `POST /api/fleet/attach`: the file is stored on the machine and its
   **path** goes into the message. The wizard says so, in the words the composer already uses —
   this is not what "attach" means in a chat application, and leaving that unsaid is how somebody
   attaches a file expecting it to be uploaded somewhere.
4. **Review · Start session.** Every answer restated with the step it came from and a way back to
   it. Moving backwards never discards an answer; changing the assistant clears only what the new
   one cannot accept (today's `useEffect` on `harness.id`, kept).

Step state is a pure reducer (`wizardSteps.ts`) so "can I advance", "what is missing" and "what
did they choose" are testable without rendering. `Escape` closes with a confirm when anything has
been entered.

### 4.2 The session must actually be usable

The user's report: *"I already tried creating sessions through the UI and it created it as
inactive and there is simply no way to interact with it."*

**Two spawn paths exist**, and that is the first thing to remove:

- `POST /api/fleet/new` — used by the VS Code extension, planned by the pure `fleet-spawn.ts`,
  which refuses rather than repairs (a relative path, an effort outside the CLI's closed enum, a
  model on a harness with no model flag);
- `POST /api/fleet/spawn` — used by the web modal, through `spawn-web.ts`, **without those
  checks**, reading its fields with `String(v['…'] ?? '')`.

There are also **two `GET /api/fleet/new` handlers** registered in `index.ts` (lines ~1153 and
~1261); the second is unreachable.

Required work, in order:

1. **Reproduce** the failure from the UI and record what the row actually shows (state, whether
   tmux holds a live pane, what the pane's last lines say) — under systematic debugging, before
   any patch.
2. **Fix the cause.**
3. **Unify on one spawn route**, planned by `fleet-spawn.ts`, so the browser and the extension
   cannot get different validation for the same act. Keep the surviving path's URL stable for the
   extension; the removed one may 410 for a release if anything still calls it.
4. **Delete the dead duplicate `GET` handler.**
5. **Acceptance:** a session started from the wizard appears in the list as running, its terminal
   view shows the live screen, and a message sent from the composer reaches it — with no terminal
   attach and no CLI intervention.

---

## Phase 5 — The central

Everything above draws on a central already, except what needs the session's screen or spawns a
process. This phase supplies those.

### 5.1 What stands in the way, and why it was built that way

- `MACHINE_FLEET_ROW_KEYS` is an **allowlist** of the fields a relayed row may carry. It
  deliberately excludes `lastLines`, `chatTurns`, `approvalLines` and `dialogOptions`. Of those,
  three become crossable behind a switch; `chatTurns` does not (see 5.3). An
  allowlist rather than a spread-and-delete, so the next field added to `ControlSession` does not
  leak silently on every machine.
- `machineActions.ts` refuses `prompt` and `approve`, and states the reason: *the dialog being
  readable **is** the safety.* A permission prompt is `1. Yes / 2. Yes, always / 3. No`; an
  `AskUserQuestion` can offer five answers that do different work; a key that "approves" takes
  whichever row is highlighted. One user was offered a destructive key over a question they never
  asked.
- `GET /api/team/session-chat` is a **410** on purpose: on-demand chat retrieval was removed from
  the reverse channel.

None of that is being deleted. It is being **gated**, which is what `allowRemoteScreens` was
already declared for: *"it is a parameter rather than an afterthought so that turning them on is a
change in ONE predicate rather than a new gate scattered across the member and the central."*

### 5.2 Three consent switches

Per connection, in the member's `preferences.json`, each **off by default**, each stated in words
on the connection card with exactly what it grants:

| switch | grants |
|---|---|
| `sessions` (today) | list the fleet; `rename`, `note`, `task`, `interrupt`, `kill`, `resume`, `openTask`, `finishTask` |
| `allowRemoteScreens` | the screen, the conversation, the approval dialog; `prompt` and `approve` |
| `allowRemoteSpawn` | start a session on this machine from the central |

`remoteActionAllowed` / `remoteActionRefusal` grow the corresponding branches; `machineActions.ts`
stays the one place a verb's remote availability is decided, and `machineActions.test.ts` pins the
tables exactly, so adding a verb is a product decision and not a drive-by. A refused verb travels
**disabled with its reason** — the rule `fleet-row.ts` already records.

### 5.3 The screen crosses by its own allowlist

- `MACHINE_FLEET_SCREEN_KEYS` — `lastLines`, `approvalLines`, `dialogOptions` — is a second
  explicit allowlist, and is only populated when `allowRemoteScreens` is on for that connection.
  `machineFleet.test.ts` gains the mirror of its existing assertion: with the switch off, a row
  carrying every one of those fields arrives with none of them.
- **`chatTurns` is deliberately NOT in it, and stays uncrossable.** On-demand chat retrieval was
  removed from the reverse channel on purpose (`GET /api/team/session-chat` is a 410), and
  `remoteSessions.ts` records that neither switch grants it: *"the transcript stays where the 410
  put it."* The screen is that transcript with the formatting left on, so a central holding the
  consent can read what a session is saying — live, for as long as it watches — without being
  handed the stored conversation. Those are different powers and only one has been agreed to.
  Reversing the 410 is a separate decision, to be asked for by name, and is not taken here.
- The member applies its **sharing rules first**, as it does today: a session in a withheld
  repository never becomes a row, so it never carries a screen either.
- The relay is a question-and-answer with a timeout, one in flight per machine per kind. A screen
  is a third kind (`screen`), not a widened `read`: a background screen poll must not block the
  action somebody is waiting on. Nothing is persisted — a fleet is true for a few seconds.

### 5.4 `approve` from a central

The rule that makes this safe is the machine's, not the central's:

- the **machine** re-reads the frame immediately before sending and **refuses if the options
  changed**, exactly as `answerSession` does locally;
- the **central sends a chosen number**, never a confirm key, and composes no wording of its own —
  `message` on the reply is always the machine's own already-localized sentence;
- a numbered dialog on a harness with no verified way to select by number is **refused in words
  naming what does work**, as it is locally.

### 5.5 `spawn` from a central

- A new relay action, gated on `allowRemoteSpawn`, planned by the same `fleet-spawn.ts` the local
  route uses after Phase 4 — one validation for both.
- The wizard's **project list travels through the connection's sharing rules**: it names
  directories, and a machine that withholds a repository must not disclose its path through the
  picker.
- The wizard on a central asks which machine first (the existing `CentralSessions` picker
  supplies it) and reports the machine's own sentence on failure.

### 5.6 Audit and exposure

- Every new remote action writes an audit event through `audit.ts`, whose pure builder redacts
  secret-shaped fields. No field carrying a credential is added.
- `/api/team/machine-fleet` stays out of `capability-guard.ts` — it needs no local capability —
  and `capability-guard.test.ts` keeps pinning that as deliberate.
- `docs/security.md` gains a section for the three switches and what each one actually permits.
  A guarantee that is not written down is a guarantee nobody can check.

---

## Testing

Pure modules get unit tests; nothing here mocks a filesystem.

| module | what is pinned |
|---|---|
| `harnessModels.ts` | every id has a label and a provenance; ids match `spawn-spec.ts`'s flags |
| `planPinMove` | reorder, out-of-range, idempotence |
| `fleetFilter.ts` | each dimension against real row shapes, including the repo two-vocabulary case |
| `chat-envelope.ts` | the seven measured shapes; `isMeta` wins over an absent tag; unwrapping still works |
| `wizardSteps.ts` | advance/blocked per step, back preserves answers, harness change clears only what is invalid |
| `harness-skills.ts` | frontmatter parsing, malformed file skipped, the five nulls each carry a sentence |
| `machineActions.ts` | the three tables, exactly, per switch combination |
| `machineFleet.ts` | screen fields absent with the switch off, present with it on |
| `dictation.ts` | each error code maps to its own sentence; insecure vs no-api |

Plus the repo's standing gates: `bun tsc --noEmit`, `bun test`, and `tokens.lint.test.ts`.

**Verification must not use browser automation** — it hangs in this environment. Verify server
behaviour with `curl`, verify a build landed with `curl` + `grep` against the served bundle, and
ask the user to open the page. After a rebuild the PWA service worker can still serve the old
bundle: say so rather than concluding the change did not work.

---

## Non-goals

- No new filter dimension for the fleet beyond "active only". Date, tags, members, teams,
  presence stay ignored there, each with its recorded reason.
- No audio leaves the browser, and no server-side transcription engine.
- No guessed slash command for a harness that has not been driven and verified.
- No model id in `HARNESS_MODELS` that a CLI has not itself named.
- No monogram replacing a real mark, and no invented mark replacing a monogram.
- `stats-cache.json` stays Claude-only, on the machine and on the central.

---

## Work order

```
0  foundations        →  1 list  →  1b collapsed rail
                       →  2 header + blur
                       →  3 composer  →  3b false-attribution fix
                       →  4 wizard + the creation bug
                       →  5 central relay
```

Phases 1, 2 and 3 are independent of each other and depend only on 0. Phase 4 depends on 0. Phase
5 depends on 4 (it reuses the unified spawn plan) and on 3 (it relays the composer). Each phase
ends green on `bun tsc --noEmit` and `bun test`, and is a commit that could ship alone.
