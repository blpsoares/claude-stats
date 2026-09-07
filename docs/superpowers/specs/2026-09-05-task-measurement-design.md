# Task measurement — the delivery unit agentistics is missing

**Date:** 2026-09-05
**Status:** design, not yet implemented
**Scope:** the measurement spine only. The board (columns, assignees, comment threads) is
explicitly out — see *Deliberately not in scope*.

---

## 1. The question that cannot be answered today

> *This delivery cost how much, took how many rounds, and needed how many sessions?*

Every grouping agentistics has — session, project, repository, tag, model, harness, machine —
answers a question about **where work happened**. None of them answers **what one delivery cost**,
because a delivery is not a session:

- a context window fills up and the work continues in a second session;
- a session crashes, is reopened, and is now a third row;
- the spec is written by one model and implemented by another, in two harnesses;
- the same job is deliberately run several times under different configurations, to compare them.

Only a person knows those rows are one piece of work. That knowledge exists nowhere in the product,
so the arithmetic that depends on it cannot be performed. **The task is not project management here;
it is the missing unit of measurement.**

The motivating use case, stated by the user:

> Task: build a landing page for a pizzeria.
> Config A: claude + opus, prompt only.
> Config B: antigravity + gemini flash, spec-driven.
> Config C: opus writes the spec, sonnet implements.
> Which delivered more for less? Which needed the most rounds? Which needed more than one session?

## 2. What was measured before designing this

Every claim below was verified against real data on a development machine on 2026-09-05, not
inferred from documentation. Two prior assumptions were **wrong** and are corrected here.

### 2.1 A user turn is countable in all six harnesses

`SessionMeta.user_message_count` already exists and every adapter populates it. The per-harness
signals, confirmed in raw transcripts:

| Harness | Turn signal | Note |
|---|---|---|
| claude | `user` message carrying text | a naive count is catastrophically wrong — one sampled transcript held **114 `user` records, of which 112 were `tool_result` and 2 were real prompts** |
| codex | `event_msg/user_message` | `task_complete.duration_ms` is measured by Codex itself |
| gemini | `role: "user"` entry | |
| copilot | `user.message` | `assistant.turn_start` → `turn_end` brackets give real per-turn time |
| kimi | `turn.prompt` / `turn.ended` | the only harness with explicit turn boundaries; `interaction.request`/`resolved` additionally counts approval stops |
| antigravity | `USER_INPUT` step | `ERROR_MESSAGE` steps count failures (77 in one sampled conversation) |

**Rounds-to-delivery is therefore a sum over the task's sessions of a field that already exists.**

### 2.2 Claude Code records its own cost, and the product ignores it

Claude transcripts carry a `cost-state` record:

```json
{"type":"cost-state","totalCostUSD":3.8588,"totalAPIDuration":555198,
 "totalToolDuration":341048,"totalDuration":5883794,
 "totalLinesAdded":30,"totalLinesRemoved":4,
 "modelUsage":{"claude-sonnet-5":{"inputTokens":674,"outputTokens":49024,
   "cacheReadInputTokens":11023240,"costUSD":3.8568}}}
```

Present in **116 of the 150 most recent transcripts (77%)**, totalling **US$ 2,018.13** of Claude's
own accounting (median US$ 4.58, max US$ 372.15). A repo-wide grep for `cost-state` / `costState`
returns **zero hits**: the product estimates all of this with `calcCost()` while the measured figure
sits unread in the same file it already parses.

### 2.3 Two corrections to previously documented capabilities

- **Gemini does record tokens.** Each turn carries `{input, output, cached, thoughts, tool, total}`
  and a `model`. `HARNESS_CAPABILITIES` on `dev` already says `tokens/cost/model: true`; the stale
  claim survives in the `main` checkout's CLAUDE.md. **Caveat: only 4 of 31 local chats carry it,
  all dated 2026-08-14 or later** — it is a recent CLI version, so gemini measures going forward,
  never retroactively.
- **Copilot is measurable, in its own currency.** `session.usage_checkpoint` carries
  `totalNanoAiu` and `totalPremiumRequests` per model. Copilot bills in AI credits (live since
  June 2026), not tokens — for cost-per-delivery that is *better* than a token estimate, but it is
  **not dollars and must never be summed into one**.

### 2.4 The existing lightweight task feature is essentially unused

`ManagedSession.task` is a free-text string; `preferences.finishedTasks` is a string array. On the
development machine: 5 managed sessions, **0 carrying a task**, and exactly **one** name ever
reaching `finishedTasks`. The sample is small and the registry has been cleared by the race
`registry.ts` documents, so this is a signal, not proof. It is recorded here because it is the one
piece of evidence that argues *against* this work, and it should be re-checked before Phase 2.

---

## 3. The model — three levels, not two

```
Task            "landing page for a pizzeria"   — the work; stable across configurations
  └── Attempt   "claude+opus, prompt only"      — one configuration of that work
        └── Session(s)                          — what actually ran; 1..N, possibly across harnesses
```

The middle level is not optional. Without it, "the same task under four configs" is one task holding
a dozen unattributed sessions, and nothing is comparable. With it, the comparison view is the
existing Compare page's shape with `attempt` substituted for `harness`.

An attempt holding **more than one session** is itself a finding — it means the configuration could
not carry the work in a single context, which is exactly one of the three metrics asked for.

### Entities

```ts
interface Task {
  id: string                  // stable, minted locally; never the title
  title: string
  detail?: string
  status: 'open' | 'delivered' | 'abandoned'
  createdAt: string           // ISO on the wire; Date if it ever reaches Mongo
  deliveredAt?: string
  repo?: string               // normalizeGitRemote key, when the work belongs to one
}

interface Attempt {
  id: string
  taskId: string
  label: string               // "opus, prompt only"
  config: {                   // what was ASKED for at spawn, never inferred afterwards
    harness: HarnessId
    model?: string
    effort?: string
    method?: string           // free text: "sdd", "prompt only", "spec then implement"
  }
  status: 'running' | 'delivered' | 'abandoned'
  startedAt: string
  deliveredAt?: string
}
```

`ManagedSession` gains `taskId` and `attemptId`. The existing free-text `task` field is **kept and
migrated**, not replaced: a name already typed becomes a Task on first read, deterministically and
idempotently, the way `migrateTeamConfig` handles legacy `deniedRepos`. Nothing a user typed is lost
and no existing verb changes meaning.

---

## 4. Attribution — the part that decides whether this works

**If a session is filed under the wrong task, every number is wrong without looking wrong.** That is
the confident-zero failure this codebase is built against. Attribution is therefore the first thing
built and the thing the tests are about.

### 4.1 Stamped at spawn, inherited forever

`taskId` / `attemptId` are written into the registry **at spawn**, the one moment the association is
a fact rather than a guess, and carried by every path that mints a new `managedId` for the same work
— resume, attach, takeover, `openTask`, adoption. This mirrors `SpawnRequest.conversationId`
exactly, and for the same reason.

`agentop session batch` already takes `--task`; it gains `--attempt`, which — like the existing
`--cwd` / `--model` / `--effort` defaults — **applies to every `--session` that follows it, until the
next `--attempt`**. One attempt may therefore hold several sessions, which is the case the middle
level exists for. The motivating use case becomes one command:

```
agentop session batch --task "pizzeria landing" \
  --attempt "opus, prompt only"        --session "claude@~/w/a: build ..." --model opus \
  --attempt "agy + flash, sdd"         --session "antigravity@~/w/b: build ..." \
  --attempt "opus spec, sonnet impl"   --session "claude@~/w/c: build ..."
```

### 4.2 The hard constraint: the conversation link does not exist everywhere

A task's numbers come from the conversation store, reached through `session-view.ts`'s `metricsOf`,
which accepts **only exact links** — the harness's own record matched by tmux session name, or the
id the registry recorded. Checked in `spawn-spec.ts`:

| Harness | `assignId` (fresh spawn) | `resume` (reopen) |
|---|---|---|
| claude | **yes** | yes |
| copilot | **yes** | yes |
| codex | no | yes |
| kimi | no | yes |
| antigravity | no | yes |
| gemini | no | **no** (its `--resume` takes "latest" or an index; its store id is synthetic) |

So a **freshly spawned codex / kimi / antigravity / gemini session has no recorded conversation id**,
and therefore contributes **no cost and no tokens** to its task. This directly threatens the
motivating use case: the `antigravity + gemini flash` attempt would show nothing.

### 4.3 First-sighting claim — narrow, exclusive, and marked

For the harnesses with no `assignId`, the poller (already running, already reading the store every
5s) resolves the link **once, at first sighting**:

> A conversation of the spawned harness, in the spawned `cwd`, whose `start_time` is later than the
> spawn timestamp, and which no other managed row has claimed, is claimed by this row, written to
> the registry once, and marked `conversationLink: 'observed'`.

This is emphatically **not** the harness-and-directory inference `metricsOf` refuses. That one is a
standing guess re-evaluated forever and gives every session in a repository the same conversation.
This is a one-time claim anchored in **time** and held **exclusively**.

Rules, all erring toward refusing:

- **Ambiguity refuses, it does not pick.** Two candidate conversations in the window, or two
  unclaimed rows of the same harness in the same `cwd`, and *neither* is linked. `agentop session
  batch` starting several sessions of one harness in one directory is exactly this case, and it must
  come out empty rather than swapped.
- **A claim is never revised.** Once written it is as good as an `assignId`; re-deriving it later is
  how a row silently changes what it measured.
- **Provenance is carried and shown.** `assigned` (the CLI was told the id), `observed` (claimed at
  first sighting), `none`. A rollup states how many of its sessions are linked and how — a task whose
  cost covers 2 of its 4 sessions must say so, never print a total as if complete.

### 4.4 Gemini is honestly degraded

Gemini's store id is synthetic (`${dir}/${file}`), so even an observed claim resolves to something no
`resume` can use. A gemini attempt gets its **rounds, wall time and turn count** — all readable from
the chat file — and is marked as carrying no reopenable link. It is listed with what it has, not
excluded and not padded.

---

## 5. The rollup, and the fact that there is no single currency

Per attempt, and summed per task. **The source is `loadConsolidated()`'s `SessionMeta`, not
`Conversation`** — the latter is a projection built by `toConversation` for the fleet row and carries
neither `user_message_count` nor `active_minutes`, which are two of the metrics this feature exists
for:

| Metric | Source | Availability |
|---|---|---|
| rounds | Σ `user_message_count` | all six |
| sessions used | count of attributed rows | all six |
| wall time | first start → delivery | all six |
| active time | Σ `active_minutes` (`activeMinutesOf`) | all six |
| tokens | Σ four counters via `tokens.ts` | all but copilot |
| cost | `cost-state` when present, else `calcCost()` | claude, codex, gemini, kimi, antigravity |
| credits / premium requests | `session.usage_checkpoint` | copilot only |
| approvals | kimi `interaction.request`; screen-probed elsewhere | partial — stated, never guessed |
| errors | `tool_errors`; agy `ERROR_MESSAGE` | most |
| lines / files / commits | existing git + edit-payload fields | not codex (`gitLines: false`) |

Three rules, each an existing rule of this codebase applied to a new dimension:

1. **A missing metric renders `N/A`, never `0`** — `HARNESS_CAPABILITIES` + `capable()` + `NAtag`,
   unchanged.
2. **Cost provenance is per session and never mixed silently.** `cost-state` is a measurement and
   `calcCost()` is an estimate. An attempt whose four sessions are three measured and one estimated
   says so, exactly as `apiCostByDay.undatedCostUSD` reports its residue rather than folding it into
   a day it did not happen on.
3. **Copilot's credits are their own column.** They are never converted to dollars and never summed
   with a token-derived figure. A cross-harness "total cost" spanning copilot is refused, with the
   reason in words.

### The honest limit, stated in the product

Agentistics measures **cost, tokens, rounds, time, approvals and errors**. It does **not** measure
whether the output is any good. The comparison answers *which configuration was cheaper, faster, and
needed fewer rounds*; *which one delivered better* stays a human judgement. The comparison screen
says this in a sentence rather than implying a verdict it cannot support.

---

## 6. Delivery marker — manual, with git evidence attached

Rounds-to-delivery needs a delivery. Three options were considered:

- **manual only** — free and universal, but two attempts both marked "delivered" look identical;
- **git only** — objective, but work that produces no commit has no marker, and an abandoned attempt
  never gets one;
- **manual, with git evidence attached** — chosen.

The person marks the attempt delivered (`finishTask` already exists and is a toggle). The product
then attaches the objective evidence from the attempt's window and repository: commits, PR
references found in commit messages, files touched, lines added/removed. The marker is a decision;
the evidence is a measurement; both are shown, and neither is inferred from the other.

`abandoned` is a first-class status. An attempt that was given up on is the most informative row in
a comparison, and treating it as merely "still open" would quietly inflate every average.

---

## 7. Storage

`~/.agentistics/tasks.json`, with ids and `updatedAt` on every record so a later central sync needs
no new model.

**It reuses the cross-process lock that already exists.** An earlier draft of this section called
for a bespoke read-back-and-retry; that was written against a stale reading of the codebase.
`withFileLock` (`sessions/file-lock.ts`, `mkdir` as the lock) already serialises `managed-sessions.json`
across the several processes agentop runs as, and the task store takes the same path — the
`createLocalTagStore` shape (temp file + rename, corrupt bytes quarantined rather than overwritten,
a no-op mutation writing nothing) wrapped in that lock.

One property of the lock must be carried through rather than assumed away: **the wait is bounded**
(`WAIT_MS`), and past it the caller proceeds without the lock and reports `contended`, because
refusing to record a session that has already been spawned is the worse harm. For a task write the
same trade does not hold — nothing has been spawned — so a contended task write is **retried once**
and, if still contended, reported. A task silently lost has no live process to be adopted back from,
which is what makes it different from a session row.

Local-first and deliberately not Mongo in this phase: the fleet is local, the motivating use case is
local, and a solo machine must have the whole feature. `TaskDoc`-shaped from the start so the central
path is additive. **If it ever reaches a central, `share-rules.ts` must gate it like any other
session-derived data, and it must be added to `DATE_FIELDS` and `rotate-identity.ts`'s enumeration** —
the latter is the same omission that has stranded a collection on rotation three times.

---

## 8. Where this appears — no new tab

Task is **already a grouping dimension** (`session-dimensions.ts`, `groupSessions`). The first UI is
therefore not a screen:

- **The task band gains a header with its rollup** — cost, rounds, sessions, attempts, status. It
  inherits the cascade, search, filters, cards, paging and row budget for free, and `agentop session
  ls` renders it through the same pure `session-table.ts`.
- **The detail pane, with a task row selected, lists its attempts** and their numbers.
- **One new screen is justified: attempt comparison**, side by side, following the Compare page's
  established pattern — per-column units, `N/A` where a harness cannot produce a metric, and the
  quality caveat in words.

Per CLAUDE.md this means the web half ships its **mobile layout in the same change**, both nav
arrays, EN/PT strings, and verification at 390px. The cockpit half budgets its rows through
`cockpitLayout` rather than clipping.

## 9. Out of this spec, but next

- **MCP tools.** Session verbs are thin wrappers over `/api/fleet` (which already exists and is
  already guarded by `capability-guard` → `localShell`); board verbs wrap the task routes this spec
  creates. The MCP implements nothing itself — a second process read-modify-writing the registry
  beside the server is the race `registry.ts` documents. This is a separate spec, written after the
  spine exists, because the interesting tools are the ones that can only be written once a task can
  answer for itself.
- **`cost-state` adoption.** Small, independent, non-blocking; own PR. Subject to §5 rule 2.

## 10. The board — comments, subtasks, files, and who is working on what

An earlier draft of this section argued the board out of scope: build the measurement, link a task
to an existing issue tracker, and never reimplement one. **That was overruled, and the reason it was
wrong is worth writing down rather than merely reversing.** The argument rested on "you already have
a board" — true of THIS repository and false of the product, which exists for someone working across
many repositories, harnesses and machines. A GitHub Project is per organisation; it cannot hold a
task that spans two repos, cannot know which sessions are touching it, and cannot answer what the
work cost. And the coordination problem is not a person's — it is the ASSISTANTS': several of them
run at once, and each needs to know what the others are doing and where the shared documents are.
An issue tracker they cannot see is not a board.

So the task carries:

- **Title and description.** The description is optional. A task nobody described is still a task.
- **Comments** — the channel a person and an assistant share. `author` is free text (a name, a
  session handle, an agent label): a closed enum would mean an assistant could not say who it was
  without a schema change, and the entire point is that anything working on the task leaves a trace.
- **Subtasks** — a checkbox, deliberately NOT a second Task. A subtask has no attempts, no sessions
  and no cost; making it a Task would mean two things called a task with different arithmetic.
- **Files** — the specs, plans and notes assistants write. The BYTES live under the data dir; the
  book holds only an index, so it stays small enough to read on every poll and a failed write leaves
  no row claiming a file exists.
- **Its sessions, visible** — which conversations are attached to this task right now, so any
  assistant reading the board knows what the others are on.

**Deleting a task never deletes work.** Its comments, subtasks and files go with it; the SESSIONS do
not. A row's `taskId` becomes a dangling reference and reads as unattributed — a board entry is a
label on work, and removing the label may not remove the work.

## 10a. Starting a session names its task

The task list is a searchable dropdown at the moment a session is created, with **create a new one**
inside it. That is the only moment attribution is free: asked for later it is a chore, and inferred
later it is a guess (§4). The wizard and `session batch` resolve the same book, so a task created
from either is the same task.

## 10b. What the detail screen answers

Beyond §5's cost / rounds / sessions, all of it from what the sessions actually reported and `N/A`
wherever they reported nothing:

- **models** used, ranked, with the tokens each carried;
- **harnesses** used, likewise;
- **agents** — subagent invocations across the task's sessions (claude only records these);
- **tokens**, as the four counters;
- **files touched, lines added/removed, commits, tool errors**;
- **delivery time** in hours and days — `deliveredAt − createdAt`, and **null while the task is
  open**. A duration "so far" placed beside a delivered task's duration reads as the same
  measurement and is not.

## 10c. Where the board is STORED, and why not the SQLite that is already here

**Not `cache.db`.** The SQLite this application already carries is `PARSE_CACHE_FILE`, and its own
header states the rule: *"DERIVED STATE ONLY — every row is recomputable from the file it names, so
deleting this file may only ever cost one slow build. Never store anything here that is not also on
disk somewhere else."* A task board is the opposite of derived: a comment an assistant wrote is
recomputable from nothing. Putting it there would make `rm cache.db` — a documented, safe act —
destroy a person's board.

**So: JSON, `<data dir>/tasks.json`**, the shape `tags-local-store.ts` and `preferences.ts` already
established for local source-of-truth state, with the same durability rules (temp-file-then-rename,
corrupt bytes quarantined, cross-process `withFileLock`) and ISO strings for timestamps, which is
what CLAUDE.md's date rule prescribes for the local stores.

**When that stops being right, and what replaces it.** The book is rewritten whole on every
mutation. That is correct for hundreds of tasks and comments and wrong for tens of thousands; the
first collection to get there will be comments, then files. The migration when it comes is **a
SQLite of its own** (`tasks.db`, via `bun:sqlite`, which the antigravity adapter already uses), NOT
a table inside the parse cache — the derived/durable line is the whole point. Nothing in the reader
API (`task-store.ts`) exposes the file format, so the swap is one module.

**File bytes never go in either.** They live at `<data dir>/task-files/<taskId>/<fileId>` and the
book holds only an index — a small book stays cheap to read on every poll, and a failed write leaves
no row claiming a file exists. The path is built from MINTED ids only; the user's filename is kept
in the record and never on disk, because a name from a browser upload is attacker-controlled and
`../../.ssh/authorized_keys` is a path.

## 10d. The central — the machine decides which tasks travel

The central aggregates many machines; a board is per machine until its owner says otherwise. The
model follows `team-uploader.ts` exactly, and adds ONE new decision.

- **Per-task opt-in.** `Task.shared?: boolean`, absent reading as NOT shared. This is deliberately
  NOT the `shareMode` migration rule (absence there reads as denylist, i.e. share): a board carries
  descriptions, comments and file names a person wrote for themselves, and defaulting those to
  travel would publish text nobody offered. Same reasoning as `chat-gate.ts`, where absent reads OFF.
- **The repository rules still bind.** A shared task whose sessions sit in a repository this
  connection withholds ships its own record and NONE of those sessions — `sessionShared` decides
  that half, unchanged. The task then reports a smaller session count to the central than it shows
  locally, and **says so**, exactly as `withheld` already does for the fleet.
- **Text is redacted at BOTH boundaries.** Title, description and comment bodies go through
  `redactSecrets` on the member (so a pasted credential never crosses the wire) and again on the
  central (a mixed-version fleet's old machine is exactly the one that leaks) — the rule
  `first_prompt` already follows.
- **File bytes do not travel in this phase.** The central sees that N files exist and their names;
  fetching one is an on-demand pull over the reverse channel, the way raw chat already works, and is
  its own piece of work.
- **`tasks` is a collection keyed by machine, so it goes in `rotate-identity.ts`.** That module's
  header records this as "the same bug three times already": a collection keyed by `memberId` and
  not enumerated there is silently stranded when a token rotates. Its timestamps go in
  `DATE_FIELDS` with a `DATE_MIGRATION_VERSION` bump, or they stay strings in Mongo forever while
  the writing code looks correct.

**On the central's board**, tasks are grouped BY MACHINE (and therefore by the person it belongs to)
with a switch to see them all at once — the same shape the members panel already uses. A machine
that shares nothing is present in the list and empty, which is a different fact from having no
tasks, and reads as such.

## 10e. Repositories → Tasks

The Repositories page gains a **Tasks** tab beside Overview / Members / Actions / Sessions /
Dynamic Workflows, listing the tasks that touched this repository — the ones in flight and the ones
already delivered — with every metric §10b defines. A task belongs to a repository through its
SESSIONS' `git_remote`, never through a field somebody typed: that is the same rule the repository
dimension already follows (`normalizeGitRemote` is the only key), and it is what makes a task that
spans two repositories appear correctly under both.

## 10f. Ordering, and the fields a board needs to be operable

Researched against Jira, Linear and monday.com (Sep 2026) and taken selectively — the useful half of
each, and none of the ceremony.

**Sorting is one rule, `@agentistics/core/taskSort.ts`.** The table's headers and the kanban's
picker write the same stored field. A board that ranks its cards one way in the grid and another in
the columns is two boards, and the reader has to hold both. Three properties it must keep:

- **`null` sorts LAST in both directions.** A task nobody could price is not the cheapest task;
  putting it at the top of an ascending cost sort is the confident zero this product refuses
  everywhere else. Reversing the arrow moves the measured rows and leaves the unmeasurable ones at
  the bottom, where they read as "no answer" rather than "least".
- **Every sort is TOTAL** — rank, then creation, then id. A board whose rows shuffle when nothing
  changed is one people stop trusting to have shown them everything.
- **The header cycle is asc → desc → the board's own order.** Three states, because "I did not
  choose a sort" has to be reachable without remembering what the default key was, and here the
  default IS a key (`manual`).

**Manual order is a STRING** (`task-rank.ts`), the LexoRank / fractional-indexing trick: a drop is
one write instead of renumbering the column. That matters twice over on this store — the book is a
JSON file several processes read-modify-write, so an integer position would make every drag a race
as well as a fan of writes. Ranks that cannot be split trigger a rebalance rather than a failure:
leaving the card the user just dropped where it was is not an option.

**A drop between columns is a STATUS change; inside one it is a reorder.** One gesture, one write.
Doing both would leave a card in a column its status does not name if the second failed.

**Fields**: `priority` (`urgent | high | medium | low | none`), `assignee`, `startDate` / `dueDate`,
`labels`. **Absent priority is `none`, never `medium`** — "nobody has said" is a real answer and a
board full of a default nobody chose is a board where priority means nothing. An overdue date is
red, and **never on a closed task**: finished work cannot be late, and saying so is a false alarm
about something nobody can act on.

**Swimlanes** (repo / owner / harness / priority) are rows of the whole pipeline — how you see that
three agents are all inside one repository. **WIP limits WARN and never block**: the limit is an
agreement a team makes with itself, and a board that refuses a drop teaches people to route around
it rather than to look at it. Linear ships no WIP limit at all and Jira enforces one; the warning is
the honest middle.

---

## 10g. Orchestration — the board as a work queue for agents

The three questions a person or an assistant running a fleet asks, which a kanban does not answer.
Grounded in the swarm/supervisor patterns the 2026 multi-agent literature converged on: atomic
claiming, lease recovery, dependency-aware readiness, convergence detection.

**1. What can be picked up?** `planNext` returns the open, unblocked, unclaimed tasks in the order
an agent would take them, numbered from 1 — plus **`withheld`: every task that is NOT available,
with the reason** (closed / blocked / claimed / not pickable in this status). An agent told
"nothing" learns nothing; the difference between "it is all done" and "it is all blocked" is the
difference between stopping and going to unblock something.

**2. Is this mine?** `claimTask` is an atomic take decided INSIDE the store's lock, so two agents
asking in the same millisecond cannot both be told yes. It is a **LEASE, not a lock** — the naive
boolean has a worse failure behind it: an agent that dies holding a task removes it from the board
forever with nothing on screen saying why. So:

- a claim expires (30 min default) and is refreshed by re-claiming;
- an unparseable expiry reads as EXPIRED, never as forever;
- a refusal NAMES the holder and the moment their lease runs out;
- `takeover` / `force` exist for a person overriding on purpose — an agent that sends them has
  defeated the point;
- an expired lease is stated in words ("lease expired") rather than blanked: the task is available
  again, and a card that simply stopped naming a holder reads as one nobody ever took.

**3. What happened while I was away?** A board-wide activity log — status moves, claims, releases,
priority and assignee changes, sessions filed — capped at 2000 events, oldest dropped. One list
rather than an array per task: the question is asked across the board, and a per-task cap would let
a hundred tasks hold a hundred caps' worth of history in a file read on every poll.

**Convergence** is `boardProgress`, and it is deliberately TWO facts: nothing to hand out AND
nothing in flight. A coordinator that reads "no work available" while three agents are mid-task will
re-dispatch forever.

**The Agents view** is where all of it is drawn, and a CLAIM and a LIVE SESSION are two different
things on it: a claim is a statement somebody made, a session is something observed on this machine
this second. Conflating them lets "an agent said it would" read as "an agent is". The only write on
that screen is clearing a lease that has visibly lapsed — a correction, not an instruction.

**MCP**: `task_next`, `task_claim` (claim / release / refresh), `task_activity`, `task_edit`,
`task_session`, plus `actor` on `task_status` so every move is recorded against whoever made it.

### `blocked` must say what it is waiting on

The one status that names a problem somebody has to go and solve, and the one that is REFUSED
without an answer (HTTP 422, `blocked_needs_reason`). A board of blocked cards that do not say why
is a board nobody can unblock: the fact lives only in the head of whoever moved it, who by then has
moved on — and `task_next` reports these as withheld, which without a reason is "you cannot have
this" with no way forward.

Two ways to answer, because there are two kinds of blocked: **another task** (a dependency the board
knows, which lets the card unblock itself when that task closes) or **a sentence** (waiting on a
person, a key, a deploy — not everything that blocks work is on the board, and forcing it to be
would breed placeholder tasks). Either is enough.

The check lives in `markTask`, so it binds the browser, the CLI and the MCP alike — an assistant
that cannot say why it is blocked has not finished thinking about being blocked. The reason is
CLEARED when the task leaves `blocked` (a sentence that outlived its block reads as current) and
kept in the activity log, so "why was this blocked on Tuesday" survives the unblocking.

### Progress is one arithmetic

`taskProgress` (core) is the only place the percentage is computed, and four surfaces draw it: the
card, the table column, the detail header and the subtask grid. It **rounds DOWN**, so a task with
99 of 100 closed never reads 100% — a bar that says finished while something is open is the one
error this figure cannot afford — and it returns `null` for a task with NO subtasks, which draws
nothing rather than an empty 0% bar: "nobody broke this up" and "nothing is done yet" are different
facts.

---

## 11. Testing

Pure modules, tested without spawning anything, following the repo's existing shape:

- `task-model.ts` — the entities, the legacy `task`-string migration (idempotent, deterministic).
- `task-attribution.ts` — the first-sighting claim. The tests that matter are the **refusals**: two
  candidates in the window, two unclaimed rows in one `cwd`, a claim that already exists, a
  conversation older than the spawn.
- `task-rollup.ts` — the arithmetic, and above all the provenance: a mixed measured/estimated
  attempt, a copilot attempt whose credits must not become dollars, a harness that cannot produce a
  metric rendering `N/A`.
- A cross-check that `user_message_count` counts prompts and not tool results, pinned against a
  transcript fixture with the 112/2 shape from §2.1.

## 12. Risks

1. **Attribution is the whole feature.** Wrong numbers here are invisible. Mitigated by stamping at
   spawn, refusing on ambiguity, and never revising a claim.
2. **The evidence in §2.4 says the lightweight predecessor is unused.** Re-check before building the
   comparison screen; if tasks are still not being named after the spine ships, stop there.
3. **Harness formats are undocumented and move.** Gemini began recording tokens in August 2026;
   `cost-state` is in 77% of transcripts, not 100%. Every reader degrades to `N/A`, never to a
   fabricated zero.

---

## 13. Delivery checklist

Every line is a thing that must be true of the shipped feature, in the order it was asked for.

**The measurement spine**
- [x] Task → Attempt → Session(s), with the attempt carrying the configuration asked for at spawn
- [x] Attribution stamped at spawn and inherited by resume / attach / takeover / reopen
- [x] First-sighting claim for the harnesses with no `assignId`, refusing on any ambiguity
- [x] Rollup: cost, rounds, sessions used, sessions linked, tokens, active time
- [x] Provenance stated: how many sessions a cost covers, measured vs estimated
- [x] Copilot credits kept out of the money, `mixedCurrency` refusing a single total
- [x] `N/A` everywhere a harness reported nothing — never a `0`
- [x] Delivery marker: manual, with git evidence attached; `abandoned` first-class and evidence-free

**The board**
- [x] Task has title + optional description
- [x] Comments, with a free-text author, editable and deletable, taking pasted files and images
- [x] Subtasks as RECORDS — status, owner, start, due, session — in the same columns the table
      expands inside a row
- [x] Files: upload, list, download, delete — bytes on disk, index in the book; list AND grid, with
      a lightbox that walks the images only
- [x] The task's sessions listed on its screen
- [x] Deleting a task removes its board and leaves its sessions alone
- [x] Table split into one minimizable component per GROUP, with a chooser for which groups show
- [x] Column chooser, sortable headers, and the arrangement restored on returning from a task
- [x] Kanban: one horizontal row, hand ordering by drag, swimlanes, WIP warnings
- [x] Priority / owner / start / due / labels, `none` meaning "nobody has said"

**The metrics**
- [x] Models ranked, with tokens
- [x] Harnesses ranked, with tokens
- [x] Agent runs
- [x] Tokens as the four counters
- [x] Files / lines / commits / tool errors
- [x] Delivery time in hours and days, null while open
- [x] Metrics are the DEFAULT view, not the kanban

**Orchestration**
- [x] `task_next`: ready queue + withheld with reasons + convergence
- [x] Atomic claim with an expiring LEASE, refusable, refreshable, takeover-able by a person
- [x] Board-wide activity log, capped, and a per-task Activity tab
- [x] Agents view: queue, who is on what, activity — claim and live session drawn apart

**The surfaces**
- [x] `agentop task` — ls / show / deliver / abandon
- [x] `GET`/`POST` `/api/tasks`, guarded in `capability-guard.ts`
- [x] Web: task list, task detail with comments / subtasks / files / sessions, attempt comparison
- [x] Web mobile: nav entry in BOTH arrays, 44px touch targets, no horizontal scroll at 390px
- [x] Session creation: task dropdown with search + create-new
- [x] Session linking: multi-select, paginated, offline reachable, live/offline toggle
- [x] MCP: tools for the board (list / show / create / status / comment / subtask / link /
      blocked-by / delete / edit / session) AND for orchestration (next / claim / activity)
- [ ] MCP: session management tools (start / attach / kill) — deliberately still the CLI, see
      `cli-hooks.ts`'s note on Bash's permission prompt being the consent gate

**Storage and the central**
- [x] `blocked` refused without a reason or a blocker, in the ONE place every surface goes through
- [x] Progress bar on the parent task, one arithmetic, four surfaces
- [x] Board in `tasks.json`, never in the parse cache (`cache.db` is derived state only)
- [x] File bytes under `task-files/<taskId>/<fileId>`, paths built from minted ids only
- [ ] `Task.shared`, absent reading as NOT shared
- [ ] Repository sharing rules still bind a shared task's sessions; the shortfall is stated
- [ ] Title / description / comments redacted at both boundaries
- [ ] `tasks` added to `rotate-identity.ts` and its dates to `DATE_FIELDS`
- [ ] Central board grouped by machine, with a see-all switch
- [ ] Repositories → Tasks tab, keyed by the sessions' `git_remote`

**The rules that must still hold**
- [x] One resolution shared by CLI, HTTP, web and MCP — no surface computes its own rollup
- [x] One SORT shared by the table and the kanban, in `@agentistics/core`
- [x] `bun test` green, `tsc --noEmit` clean, `build:binary` compiles
