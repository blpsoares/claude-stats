# Filing a session under a delivery, and setting its status

The ALM board works and nobody can use it. This spec is about the second half of that sentence.

## 1. The complaint, and what was actually measured

Reported: *"não está funcionando corretamente as linkagens de sessão a uma tarefa, não está claro
a forma de fazer isso e está bem confuso — interface, componentes, formas de colocar status."*

Nothing is broken in the sense of a defect. `attachSession` works, the pickers work, the status
writes land. What was measured in the code instead:

- **The link is INVISIBLE on a session row.** `lib/sessionCard.ts` excludes `task` from the bands
  on purpose, `FleetOverview` never draws it, and only `SessionsAside` passes `row.task` through at
  all. So a session can be filed and there is no way to SEE that it is filed without opening a
  menu. This is the root cause: the feature is not missing, it is unfindable.
- **Seven doors to one gesture.** The row's three-dot menu (`SessionActions`, verb `task`), the
  right-click card menu (`SessionRowMenu`, verb `link-task`), the open session's Tasks tab
  (`SessionTasksTab`), the board table's sessions column (`SessionPicker`), the new-task wizard,
  the new-session modal's `initialTask`, and the CLI. Each is individually reasonable.
- **Two directions with two vocabularies.** "File under a task" (from the session) and "which
  session belongs to this task" (from the delivery) are the same relation named twice, so the
  reader has to work out which way round they are standing before they can act.
- **Six doors to a status**: the detail rail's chip, the table's status cell, a kanban drag, the
  batch bar, the `Mark delivered` / `Mark abandoned` buttons in the Actions rail, and the CLI.
- **The board is the only page in the product that ignores the language toggle.** `TasksPage`
  passes a hardcoded `lang="en"` to its children, so "Deliveries", "Mark delivered" and "Working on
  it" stay English on a dashboard the user is reading in Portuguese. Three words also coexist for
  one concept: the nav says *Entregas*, the components say *task*, the CLI says `agentop task`.

## 2. What the research says (Sep 2026)

- **A command palette is the power-user default** — Linear, Vercel, GitHub, Slack and Raycast all
  ship `Cmd+K`, and Linear additionally binds single keys (`E` to move/assign). Keyboard-first is
  the direction of travel, but it is an ACCELERATOR layered on a visible path, never a replacement
  for one.
- **Jira 2026 lets you edit a work item from the row** without opening it, and its status
  transitions live in one dropdown in a fixed position. When that dropdown was MOVED, the community
  complained loudly enough that it was moved back (Oct 2025). Position stability beats extra
  affordances.
- **Discoverability is made of signifiers, not affordances** (Norman). The line that decides this
  design: *a feature nobody finds works exactly like a feature that does not exist.*

Sources: [Linear docs](https://linear.app/docs), [Command Palette UX
pattern](https://uxpatterns.dev/patterns/advanced/command-palette), [Jira workflows and
statuses](https://support.atlassian.com/jira-software-cloud/docs/workflows-and-statuses-for-boards-in-business-projects/),
[Why did the Status dropdown move in
Jira](https://community.atlassian.com/forums/Jira-questions/Why-did-the-Status-dropdown-move-in-Jira-Bad-UX/qaq-p/3114413),
[Discoverability in UX](https://www.uxpin.com/studio/blog/discoverability-in-ux/), [Don Norman's
seven fundamental design
principles](https://uxdesign.cc/ux-psychology-principles-seven-fundamental-design-principles-39c420a05f84).

The conclusion the research forces: **the fix is not another shortcut. It is one visible path, in a
stable position, with the same words everywhere.**

## 3. The decisions this rests on

Answered by the user before any of it was designed:

1. **Filing happens AT SPAWN.** The new-session form is the primary door; everything else is repair.
2. **The field SUGGESTS and never blocks.** No mandatory step, no empty field either when the
   machine can propose something honest.
3. **One status chip, in the same place on every surface.** The kanban keeps its drag; the
   standalone `Mark delivered` / `Mark abandoned` buttons collapse into that chip's menu.
4. **The board follows the language toggle, and the interface settles on ONE word** — *Entrega* /
   *Delivery*. `task` survives in code, routes and CLI, where it confuses nobody.

## 4. The design

### 4.1 One vocabulary, and a board that speaks the reader's language

`packages/web/src/components/tasks/copy.ts` (new) holds every sentence the board renders, EN + PT,
in the shape `components/team/copy.ts` already established. No component holds a sentence of its
own. `TasksPage` stops passing `lang="en"` and threads the `lang` it reads from `AppContext`, like
every other page; `SessionTasksTab`, `TaskSharing`, `TaskPicker`, `SessionPicker`, `TaskTable`,
`BoardOverviewView` and `AgentsView` receive it.

The UI word is **Entrega / Delivery** everywhere, including the picker titles, the empty states and
the menu entries. `Task` remains in `task-model.ts`, `/api/tasks` and `agentop task` — renaming
those would be churn with no reader on the other end.

### 4.2 The primary door: the new-session form

```
NEW SESSION
┌────────────────────────────────────────────┐
│ Harness   [claude ▾]   Model [opus ▾]      │
│ Folder    ~/agentistics/.claude/wt/alm     │
│                                            │
│ Delivery  [ALM board                  ▾]   │
│           ⤷ suggested: 4 sessions in this  │
│             folder are filed here     [×]  │
│                                            │
│ Prompt    …                                │
└────────────────────────────────────────────┘
```

`NewSessionModal` gains a first-class Delivery field (it has `initialTask` today, which the caller
had to supply). It opens the existing `TaskPicker` — search, pick, or create — so there is still
exactly one picker in the product.

**The suggestion is a pure function**, `packages/web/src/lib/taskSuggest.ts`, with tests:

```ts
suggestDelivery(o: {
  cwd: string
  sessions: readonly { cwd: string; task?: string; createdAt: string }[]
  tasks: readonly { id: string; title: string; status: string }[]
}): { taskId: string; title: string; reason: { sameFolder: number } } | null
```

Rules, each of which exists to keep the field trustworthy:

- Candidates are sessions whose `cwd` is **exactly** this directory. A prefix match would suggest a
  repository's delivery for a worktree that is doing something else entirely.
- The delivery must be **open** — `done` and `abandoned` are excluded. Filing new work under a
  finished delivery is how a delivery's own duration stops meaning anything.
- The winner is the delivery of the **most recent** candidate; the reason carries how many sessions
  of that folder are filed there, because a field that fills itself in without saying why is a
  field nobody trusts.
- **The join is by NAME, because that is the only join the browser can make.** A fleet row carries
  `task` as the delivery's TITLE (the id lives on the session record the server holds, not on the
  wire), which is the same honest join `SessionTasksTab` already performs. A title that matches no
  delivery in the list yields no suggestion rather than a dangling one; two deliveries with the
  same title cannot exist (`createTask` refuses a duplicate title), so the match is unambiguous.
- **No candidate yields NO suggestion** — an empty field, and the session starts unfiled. Nothing is
  ever blocked, and nothing is ever invented.
- `[×]` clears it, and a cleared field stays cleared for that spawn.

The CLI (`agentop session new` / `batch`) is deliberately unchanged in this pass: it already takes
`--task`, and a suggestion that a script cannot see is a suggestion that silently changes what a
script does.

### 4.3 The repair door, made visible

The sessions workspace's list — `components/nav/SessionsAside.tsx` for the aside and
`components/sessions/FleetOverview.tsx` for the centre, both fed by `lib/sessionCard.ts` — grows a
**Delivery** cell, always drawn:

```
SESSIONS
 ● 3f5f  claude  ALM board          ▾   32 rounds
 ● 9a5e  claude  — no delivery —    ▾   11 rounds     ← clickable
 ○ 1538  codex   Mobile fixes       ▾    4 rounds
```

Clicking the cell opens the same `TaskPicker`. `— no delivery —` is a control, not a blank: the
unfiled state is the one that needs the gesture most, so it is the one that must look clickable.

The menu entries stay (a narrow viewport drops the column, and a keyboard user needs a menu), but
they all become **one entry with one label** — *Filiar a uma entrega* / *File under a delivery* —
opening the same picker: `SessionActions`' `task`, `SessionRowMenu`'s `link-task`, and
`SessionTasksTab`'s link/unlink. Three names for one gesture is what made the feature read as three
half-features.

The opposite direction (`SessionPicker`, *Adicionar sessão* / *Add a session*) stays where it makes
sense — on the delivery's own screen — and nowhere else.

### 4.4 One status chip

`packages/web/src/components/tasks/StatusChip.tsx` (new) is the chip plus its menu, and it is the
only way to change a status outside the kanban:

```
  ALM board            [In progress ▾]
                         Backlog
                         To do
                       ✓ In progress
                         Blocked…          → opens the reason dialog
                         In review
                         Delivered         → attaches the git evidence
                         Abandoned
```

Same component, same position, in the table cell, on the kanban card and at the top of the delivery
screen. It replaces the rail's `ChipSelect` usage for status, the table's own status cell, and the
`Mark delivered` / `Mark abandoned` buttons in the Actions rail — those become two rows of this
menu, which is where every status already lives.

Unchanged on purpose: the kanban drag (a board exists to be dragged), `blocked` refusing without a
reason (the server enforces it, so every surface inherits it), and the delivery evidence.

### 4.5 What is deleted

- The `lang="en"` literals in `TasksPage`.
- The `Mark delivered` / `Mark abandoned` buttons as separate controls.
- Two of the three labels for the filing gesture.
- The status cell's private dropdown in `TaskTable`.

## 5. Testing

Pure functions get unit tests: `taskSuggest.ts` (every rule in §4.2, especially "no candidate → no
suggestion" and "a finished delivery is never suggested") and `copy.ts` (EN and PT carry the same
keys — a missing key renders a blank label, which is worse than English).

The surfaces get verified in a browser at 1440px and at 390px, against a preview server on its own
port with an isolated data directory, per the repo's standing rule. Screenshots of: the spawn form
with a suggestion, the sessions list showing the column, the same list with the picker open, and
the status chip's menu on all three surfaces.

## 6. Out of scope, deliberately

- **A command palette.** The research says it is the accelerator on top of a visible path; this
  spec builds the visible path. A `Cmd+K` over an unfindable feature would be a second unfindable
  feature.
- **Renaming `task` in the code, the API or the CLI.**
- **Suggesting a delivery in the CLI.**

## 7. The second half of the request: are the numbers right?

Asked in the same breath: *"quero que você TESTE as coisas, garanta que as métricas que estão
sendo exibidas são corretas — informações de sessões, tempo, tokens, etc."*

That is verification, not design, and it is its own phase with its own PR:

- Take ~10 real sessions across harnesses and reconcile, per session, what the board shows against
  what the raw sources hold: rounds (`user_message_count`) against the transcript's user turns,
  active time against `activeMinutesOf`, the four token counters against the transcript's own
  `usage` records, and cost against `calcCost` at the model's table rate.
- Reconcile a delivery's rollup against the sum of its sessions, and the board overview against the
  sum of its deliveries.
- Anything that disagrees is a defect with a test, not a note in a document.

This phase exists because two silent-drop bugs in the central-sync work were found by pushing to a
real central and none by reading the code. Here, only what is measured counts.
