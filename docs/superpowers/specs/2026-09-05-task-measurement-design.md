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

Per attempt, and summed per task:

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

**It must not inherit the registry's write race.** `registry.ts` serialises writes within one
process, and agentop runs as several (cockpit, daemon, every one-shot command) — a record written by
a short-lived process has been observed erased by a longer-lived one, which is what `session-adopt.ts`
exists to repair. A lost task is worse than a lost session row: the session can be adopted back from
a live process, while a task has no running thing to be recovered from. Every write therefore
**reads itself back and retries once**, the way `takeover` does, and says so when the record still
cannot be kept.

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

## 10. Deliberately not in scope

Kanban columns, assignees, comment threads, notifications, sprints, permissions. None of the three
metrics depends on any of them; each is a permanent maintenance surface across cockpit, web, VS Code,
EN/PT and mobile; and the cheap answer if the need appears is to **link** a task to an existing
issue, not to reimplement an issue tracker. Revisit only with evidence from real use of §3.

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
