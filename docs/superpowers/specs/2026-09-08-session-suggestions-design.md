# Session suggestions and the behaviour profile — design

**Date:** 2026-09-08
**Status:** Approved (brainstorming) — pending implementation plan
**Author:** Bryan Soares (with Claude)

## Goal

Turn what agentistics already measures about a session into two things a person can act on:

1. **Suggestions** — a card on a RUNNING session that states a measured fact and offers one action
   (send a prompt, migrate the session, answer a dialog).
2. **A behaviour profile** — the baselines those facts are read against ("you usually have 61
   messages"), which doubles as the sessions tab's empty state.

They are one feature, not two, and the reason is the sentence each card has to produce. `2 compacts`
is a threshold somebody invented. `2 compacts — 8 of your 452 sessions ever reached that` is a
measurement. The profile is what makes a suggestion earned rather than a nag, so it is built first.

## Scope

**In:** live sessions only (running rows, on the surfaces that show them), the four triggers below,
the profile, and the migrate orchestration.

**Out:** retrospective suggestions on finished sessions (a "migrate" button on a session that ended
three weeks ago is the same class of bug as offering `start` on a running service). They may come
later and would reuse `session-profile.ts` untouched.

## Ground truth (measured on one machine, 2026-09-08, 452 Claude sessions)

**Count SESSIONS, and read the whole history.** These figures were wrong twice. The first pass
scanned only `~/.claude/projects`, which Claude prunes after `cleanupPeriodDays` — it reaches back
to 2026-08-11 and holds 423 sessions, while `~/.agentistics/archive` holds more. The second pass
added the archive and counted 284 extra files, but 255 of those are SUBAGENT transcripts
(`<session>/subagents/agent-*.jsonl`), not sessions: they are one session's agents, and counting
them split that session's compactions across files while inflating every denominator. The numbers
below are over the 452 real session transcripts — 423 live plus 29 archive-only, basenames matching
a session UUID. See
"The compacts baseline is bounded by surviving transcripts" for why this is a permanent property of
these particular metrics rather than a one-off mistake.

Everything the profile can report today, and what it costs to add.

| Metric | Source | Available now? |
|---|---|---|
| messages | `user_message_count` / `assistant_message_count` | ✅ |
| active time, cost, tokens | `active_minutes`, `calcCost`, the four counters | ✅ |
| tool errors by category | `tool_error_categories` | ✅ |
| MCP servers used | `mcp__*` keys in `tool_counts` | ✅ (10 distinct, 90 sessions) |
| subagents | `agentMetrics` / `Agent` tool_use | ✅ (586 calls, 43 sessions) |
| **skills** | `Skill` tool_use, `input.skill` | ✅ (112 invocations, 26 distinct, 61 sessions) — **CLAUDE.md says otherwise and is stale** |
| **compacts** | `compact_boundary` + `compactMetadata` | ❌ **new field** |
| context level | `context_tokens` / `resolveContextWindow` | ✅ (gated by `contextWindow`) |

`compactMetadata` carries `trigger` (`auto`/`manual`), `preTokens`, `postTokens`,
`cumulativeDroppedTokens` and `durationMs`. Across those 452 sessions: **43 compacts in 18 sessions,
88 minutes spent compacting, 21,3M tokens dropped.**

`cumulativeDroppedTokens` is cumulative and monotonic — measured across one real five-compact
session: `954.238 → 1.910.306 → 2.876.708 → 3.829.252 → 4.785.215`. So a session's figure is its
LAST reading and the fleet total is the sum of those, never the sum of every record: that error
reported 30M against a true 19,4M, and 14,4M against a true 4,8M on the session above. The field is
also absent from 27 of the 46 records, so a session whose records all lack it reports nothing rather
than zero. `compactsFromClaudeJsonl` encodes both rules and its tests pin the sequence.

### Two measured facts that decide the design

**Messages are heavily skewed: median 58, mean 134.** The mean is 2,3x the
median and describes no session anybody has. So the profile reports the **median** by default. The
mean is used only where the question is literally a rate.

**Compacts are RARE, with a long tail.** Median 0, mean 0,095: 18 of 452 sessions had one at all,
and 8 had two or more — the tail runs 1 (x10), 2 (x3), 4 (x2), 5, 6, **8**. This kills the ratio
framing for that metric: "5x your average" is not a sentence when the average is 0,095, and dividing
by a zero median is not a sentence at all. See "Two ways to state a deviation" below.

The tail is the reason the trigger is worth having at all. A session at 8 compacts has spent real
time and dropped real context, and it is invisible in every average that includes the 434 sessions
that never compacted once.

## Architecture

Two pure modules in `@agentistics/core`. No surface holds any of this logic — the same shape as
`task-reopen.ts` and `attention.ts`, and for the same reason: this must read identically in the
cockpit, the VS Code panel, the web dashboard and `agentop session ls`.

```
session-profile.ts      (SessionMeta[], now) -> Baseline          PURE
session-suggestions.ts  (FleetRow, Baseline) -> Suggestion[]      PURE
```

### Where the baseline is computed and how it travels

Computed **server-side, once, cached** — it is a scan of the consolidate store — and shipped on the
**`/api/fleet` payload** as a few hundred bytes.

It must NOT be derived client-side from `/api/data`. That response is megabytes on a 300s timer while
the fleet poll is 5s and a few kilobytes; deriving the profile in the client would spend a megabyte a
minute to move a number that changes once per session. This is the rule `docs/vscode-extension.md`
already states for the two timers.

## `session-profile.ts`

`profileOf(sessions: SessionMeta[], nowMs: number): Baseline`

Pure and total. It **receives `now`** rather than reading the clock, so it is testable.

### The window

**The last 30 days, all sessions**, by the UTC day rule `start_time.slice(0, 10)` — the same rule
`tagSessionDay` and the billing basis use. There are two day rules in this repo and mixing them
drifts a session across the boundary; a rolling 30-day window is also what lets the profile follow a
change of habit instead of averaging over a year.

### `n` is PER METRIC, never a sample size

`agentMetrics` and `skill_uses` exist only for sessions with `_source: 'jsonl'`. A session whose
transcript Claude already deleted counts toward messages and cost and **cannot** count toward skills
or subagents. One shared `n` would compute the skills average over sessions that could never have
had one — a denominator that is quietly wrong in the direction of "you use fewer skills than you
think".

Measured over the 452: 444 carry messages, 61 carry skills, 43 carry subagents.

### What it reports

Per metric: `median`, `mean`, `n`, and the count of sessions above zero. Metrics: compacts, messages,
active minutes, cost, tokens, tool errors (by category), distinct skills, distinct MCP servers,
subagents, tools per turn.

## `session-suggestions.ts`

`suggestionsFor(row: FleetRow, baseline: Baseline): Suggestion[]`

```ts
interface Suggestion {
  id: SuggestionId
  facts: { observed: number; baseline: number; n: number; kind: 'ratio' | 'rarity' }
  sentence: string          // localized EN/PT, carrying the numbers
  action: { kind: 'migrate' } | { kind: 'prompt'; draft: string } | { kind: 'approve' } | { kind: 'none' }
}
```

### Two ways to state a deviation, chosen by the data

A card may only ever say something true, and which sentence is true depends on the baseline:

- **Ratio** — when the median is meaningfully above zero. *"340 messages — your median is 58 (30d,
  n=444)."*
- **Rarity** — when the median is zero or near it, which is the compacts case. *"2 compacts — 8 of
  your 452 sessions ever reached that."*

Picking the ratio unconditionally is how a rare event gets reported as a division by almost-zero and
reads as a fault in the dashboard rather than a fact about the session.

### The triggers

| Trigger | Reads | Action | Capability |
|---|---|---|---|
| context ≥85%, no compact yet | `context_tokens` / `resolveContextWindow` | **migrate** | `contextWindow` |
| ≥2 compacts | `compact_count` | migrate, stating what it already cost | `compaction` (claude only) |
| waiting on approval > N min | `attention.ts` + the poll | approve / open | all six |
| N tool errors of one category | `tool_error_categories` | prompt (editable) | where the adapter fills it |

**Context is the trigger that matters and compacts is the symptom.** After two compacts the session
is already at ~10k post-compact tokens: the handoff you would migrate has mostly been thrown away.
The context trigger fires *before* the loss. The compacts trigger stays because it is the most legible
sentence there is — it names minutes and tokens already spent — but it fires on roughly 1,8% of
sessions (8 of 452) and must not be mistaken for the load-bearing one.

### Anti-nag rules

- Every card carries its **measured numbers in the sentence**. Never "consider starting a new
  session".
- **At most 3 per session**, ranked. Ten suggestions is zero suggestions.
- **Dismissal is per session**, not per rule. Dismissing once for a session where it was wrong must
  not blind the user on a session where it matters.
- A capability-gated trigger is **absent** where the harness cannot produce it — never a card reading
  zero. Same rule `HARNESS_CAPABILITIES` applies to metrics.

### A prompt is editable before it is sent

The `prompt` action opens the draft in the composer. A canned prompt fired blind into somebody's
session is the same failure as an approve button that takes the highlighted row — the mistake
`dialog-choice.ts` exists to prevent, in a different costume.

## Migration

One button. `agentop` orchestrates the whole thing; the user does not read the handoff first, and the
safeguards are what make that acceptable:

```
ask for handoff → PERSIST to disk → spawn successor → confirm it is up → retire the predecessor
```

- **The handoff is written to `~/.agentistics/handoffs/<sessionId>.md` before anything is retired.**
  Even fully automatic, the artefact survives; if every later step fails, the work is on disk.
- **The successor must be confirmed on two consecutive polls** before the predecessor is touched —
  the discipline `event-plan.ts` already states, for the same reason: one poll is a repaint.
- **On timeout, or if the handoff never appears, the predecessor STAYS ALIVE** and a sentence says
  why. Nothing is retired that cannot be proven replaced — the rule `task-reopen.ts` holds.
- The predecessor is **retired** with `endedMs` and a `succeededBy` link, so
  `collapseSupersededSessions` already handles the pair and the fleet shows one lineage rather than
  two loose rows.
- **The session never kills itself.** It would be killing the pane it lives in, mid-turn. The server
  spawns and retires; the prompt only writes.

## The empty state

The sessions tab already explains **why** the list is empty, and those sentences are load-bearing:
"nothing is running", "the filter withheld it" and "the search found nothing" send a person to three
different places. **That sentence stays.** The profile renders below it — it is what fills the dead
space, never what replaces the explanation.

## The compacts baseline is bounded by surviving transcripts

`compact_count`, `skill_uses` and the subagent counts are **transcript-derived**: they exist only
while the raw JSONL does. That is not true of the metrics already on `SessionMeta`, which the
consolidate store keeps forever, and it has three consequences the profile must state rather than
paper over.

Measured on this machine, 2026-09-08:

| | count |
|---|---|
| sessions in the consolidate store | 708 |
| with a surviving SESSION transcript (live + archive) | 452 |
| subagent transcripts, which are not sessions and were once miscounted as such | 255 |
| live only (`~/.claude/projects`, back to 2026-08-11) | 423 |

- **The store holds more sessions than any transcript can still answer for** — those are already
  unrecoverable for these metrics.
- **The archive is frozen.** It holds 29 further session transcripts. It exists because
  `archiveMode` used to be `full`; it is
  `consolidate` now, so nothing is being added to it. From here on, a transcript that ages past
  `cleanupPeriodDays` is gone.
- **A further ~68 sessions are recoverable only through evidence that must not be used.** Their own
  transcript is gone but a `<session-id>/subagents/` directory survives (5 live, 63 archived), and
  `data.ts` already has a `_source: 'subdir'` fallback that reads the first agent file as a stand-in
  for every other metric. Compaction is the one metric where that would be wrong: a subagent runs
  its own context and compacts on its own (5 of this machine's 255 subagent transcripts carry their
  own `compact_boundary`), so the session would be credited with its agent's compactions — and this
  number feeds the MIGRATE trigger, so the error would not sit quietly on a dashboard, it would
  propose moving a session that never burned its own context. Those sessions keep `undefined`.
- **Therefore the field must be stamped early.** Once `compact_count` is written onto `SessionMeta`
  and persisted, it survives the cleanup like every other metric — but only from the day it ships.
  Backfill is a one-shot opportunity bounded by what is on disk when the feature lands, and it
  shrinks every day.

The `n` per metric already carries this honestly: the compacts baseline simply reports the smaller
denominator it actually had. What it must never do is compute the average over the store's 708 while
counting compacts from the smaller set that still has a transcript.

## The frontier, asserted in a test

A suggestion **carries facts and a proposed action; nothing in these modules executes anything**.
Execution is always a human click reaching `/api/fleet/act`. `suggestions-frontier.test.ts` greps the
modules' own source and fails on an IO call — the same shape as `events-frontier.test.ts`.

## New fields

- `SessionMeta.compact_count`, `compact_ms`, `compact_dropped_tokens` — aggregates of
  `compactMetadata`. Not the list: nobody needs the `preservedSegment` uuids.
- `SessionMeta.skill_uses?: Record<string, number>` — from the `Skill` tool_use.
- `HARNESS_CAPABILITIES.compaction` — `true` for claude only. The other five have no equivalent
  marker, so the compacts card is absent there rather than zero.

These are numbers, so they do not enter `DATE_FIELDS`, but they must travel through the consolidate
store and the team uploader like any other metric.

## Documentation debt this closes

`CLAUDE.md` states that Skills "are not recorded as individual tool_use events in the JSONL — only a
`skill_listing` attachment appears". That is no longer true: there is a `Skill` tool whose
`input.skill` names the skill, and this machine has 112 such invocations of 26 distinct skills across 61 sessions. The line
is corrected as part of this work, because this is the feature that depends on it.

## Open questions

- **The two `N` thresholds are not chosen yet** — how long a session must have been waiting on
  approval, and how many errors of one category count as repetition. Both should come from the
  profile rather than from taste, which is the point of building it first; the waiting one must
  additionally differ from the header's waiting counter, which fires immediately, or the card is a
  second copy of a signal one glance away.
- **Whether the profile is per harness.** Decided against for v1 (one 30-day baseline over all
  sessions), but a claude-only metric compared against a mixed baseline is a mild version of the
  cache-blind problem the billing basis documents. Revisit if the fleet becomes genuinely multi-harness.

