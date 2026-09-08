# Session behaviour profile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture compaction and skill usage per session, compute a 30-day behaviour baseline from them, and show it where the sessions list is empty.

**Architecture:** Two pure additions and one delivery path. `jsonl.ts` gains pure line-readers for the two new metrics, following the `contextTokensFromClaudeJsonl` pattern already there. `@agentistics/core/session-profile.ts` turns `SessionMeta[]` into a `Baseline` — pure, given `now`, never reading a clock. The server computes that baseline once behind a cache and ships it on the `/api/fleet` payload, which the cockpit and the web sessions view already poll.

**Tech Stack:** TypeScript (strict), Bun, `bun:test`, React (web), Ink (cockpit).

This is **plan 1 of 2** for `docs/superpowers/specs/2026-09-08-session-suggestions-design.md`. It delivers the profile alone, which is useful on its own and is what supplies the two `N` thresholds the suggestions plan still needs.

## Global Constraints

- **Everything in this project is in English** — code, comments, commit messages, PR titles.
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`).
- **Never a confident `0` where the answer is unknown** — an absent measurement is `undefined`, and the UI says N/A. This is the rule the whole repo is built on (`HARNESS_CAPABILITIES`).
- **`stats-cache.json` is Claude-only** — never aggregate non-Claude data from it.
- **Pure modules do no IO** and receive `now` rather than reading the clock.
- **Tokens means all four counters** — go through `@agentistics/core/tokens.ts`, never a two-term sum (`tokens.lint.test.ts` fails the build otherwise).
- **The day rule here is UTC `start_time.slice(0, 10)`**, matching `tagSessionDay` and the billing basis. The repo has two day rules; mixing them drifts a session across the window boundary.
- Every task ends green: `bun tsc --noEmit` and `bun test` both pass before the commit.

---

### Task 1: Capture compaction and skill usage on `SessionMeta`

**Files:**
- Modify: `packages/core/src/types.ts` (the `HarnessCapabilities` interface, the `HARNESS_CAPABILITIES` record, the `SessionMeta` interface)
- Modify: `packages/server/server/jsonl.ts` (add two pure readers; call them in `parseSessionJsonl`)
- Test: `packages/server/server/jsonl-compaction.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `CompactStats { count: number; ms: number; droppedTokens?: number }`, `compactsFromClaudeJsonl(lines: readonly string[]): CompactStats`, `skillUsesFromClaudeJsonl(lines: readonly string[]): Record<string, number>`, and the `SessionMeta` fields `compact_count?: number`, `compact_ms?: number`, `compact_dropped_tokens?: number`, `skill_uses?: Record<string, number>`.

**Why `droppedTokens` is a MAX and not a sum.** `compactMetadata.cumulativeDroppedTokens` is cumulative and monotonic. Measured on one real 5-compact session: `954.238 → 1.910.306 → 2.876.708 → 3.829.252 → 4.785.215`. Summing it reports 14,4M where the truth is 4,8M — a 3x inflation, on a field whose own name says so. Across this machine, summing gave 30M against a correct 19,4M.

**Why it is optional.** 27 of 46 real compact records carry no `cumulativeDroppedTokens` at all. A session whose records all lack it must report `undefined`, never `0`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/server/jsonl-compaction.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { compactsFromClaudeJsonl, skillUsesFromClaudeJsonl } from './jsonl'

/** One compact boundary, in the shape Claude Code writes it. */
const boundary = (m: Record<string, unknown>) =>
  JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: m })

/** One assistant line carrying tool_use blocks. */
const tools = (...blocks: Record<string, unknown>[]) =>
  JSON.stringify({ type: 'assistant', message: { content: blocks } })

describe('compactsFromClaudeJsonl', () => {
  it('counts the boundaries and sums the per-compact durations', () => {
    const out = compactsFromClaudeJsonl([
      boundary({ trigger: 'auto', durationMs: 104_960, cumulativeDroppedTokens: 954_238 }),
      boundary({ trigger: 'auto', durationMs: 123_621, cumulativeDroppedTokens: 1_910_306 }),
    ])
    expect(out.count).toBe(2)
    expect(out.ms).toBe(228_581)
  })

  it('takes the MAX of cumulativeDroppedTokens, never the sum', () => {
    // Measured on a real 5-compact session: the field is cumulative and monotonic, so summing
    // reported 14,4M where the truth was 4,8M.
    const out = compactsFromClaudeJsonl([
      boundary({ cumulativeDroppedTokens: 954_238 }),
      boundary({ cumulativeDroppedTokens: 1_910_306 }),
      boundary({ cumulativeDroppedTokens: 2_876_708 }),
      boundary({ cumulativeDroppedTokens: 3_829_252 }),
      boundary({ cumulativeDroppedTokens: 4_785_215 }),
    ])
    expect(out.droppedTokens).toBe(4_785_215)
  })

  it('leaves droppedTokens UNDEFINED when no record carries it', () => {
    // 27 of 46 real records have no such field. Reporting 0 would claim nothing was dropped by a
    // session that plainly compacted five times.
    const out = compactsFromClaudeJsonl([boundary({ durationMs: 900 }), boundary({ durationMs: 900 })])
    expect(out.count).toBe(2)
    expect(out.droppedTokens).toBeUndefined()
  })

  it('ignores a line that merely mentions the marker, and survives malformed JSON', () => {
    const out = compactsFromClaudeJsonl([
      JSON.stringify({ type: 'assistant', message: { content: 'we should log compact_boundary here' } }),
      '{ not json',
      JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 5 }),
    ])
    expect(out).toEqual({ count: 0, ms: 0 })
  })
})

describe('skillUsesFromClaudeJsonl', () => {
  it('counts each skill by the name the Skill tool was given', () => {
    const out = skillUsesFromClaudeJsonl([
      tools({ type: 'tool_use', name: 'Skill', input: { skill: 'superpowers:brainstorming' } }),
      tools({ type: 'tool_use', name: 'Skill', input: { skill: 'superpowers:brainstorming' } }),
      tools({ type: 'tool_use', name: 'Skill', input: { skill: 'artifact-design' } }),
    ])
    expect(out).toEqual({ 'superpowers:brainstorming': 2, 'artifact-design': 1 })
  })

  it('is empty when no skill was invoked, and ignores other tools', () => {
    expect(skillUsesFromClaudeJsonl([
      tools({ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }),
    ])).toEqual({})
  })

  it('skips a Skill call with no readable name rather than inventing one', () => {
    expect(skillUsesFromClaudeJsonl([
      tools({ type: 'tool_use', name: 'Skill', input: {} }),
    ])).toEqual({})
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/server/server/jsonl-compaction.test.ts`
Expected: FAIL — `compactsFromClaudeJsonl` is not exported from `./jsonl`.

- [ ] **Step 3: Add the two pure readers to `jsonl.ts`**

Add near `contextTokensFromClaudeJsonl` (the same shape: pure, takes lines, no IO):

```ts
/** What a session's compactions cost it. `droppedTokens` is absent when no record reported one. */
export interface CompactStats {
  count: number
  ms: number
  droppedTokens?: number
}

/**
 * COMPACTIONS, off the raw transcript — PURE.
 *
 * `cumulativeDroppedTokens` is CUMULATIVE and monotonic, so it is a MAX and never a sum: measured
 * on a real five-compact session it runs 954.238 → 4.785.215, and adding those reports 14,4M for a
 * session that dropped 4,8M. The field is also frequently absent (27 of 46 real records), and an
 * absent measurement stays `undefined` — a `0` there would claim a session that compacted five
 * times dropped nothing.
 */
export function compactsFromClaudeJsonl(lines: readonly string[]): CompactStats {
  let count = 0
  let ms = 0
  let dropped: number | undefined
  for (const line of lines) {
    // Cheap reject before the parse: most lines are not this.
    if (!line.includes('compact_boundary')) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(line) as Record<string, unknown> } catch { continue }
    if (e.type !== 'system' || e.subtype !== 'compact_boundary') continue
    const meta = e.compactMetadata as Record<string, unknown> | undefined
    if (!meta) continue
    count++
    if (typeof meta.durationMs === 'number') ms += meta.durationMs
    const c = meta.cumulativeDroppedTokens
    if (typeof c === 'number') dropped = Math.max(dropped ?? 0, c)
  }
  return dropped === undefined ? { count, ms } : { count, ms, droppedTokens: dropped }
}

/**
 * SKILL INVOCATIONS, by the skill's own name — PURE.
 *
 * A skill is a `Skill` tool_use whose `input.skill` names it. A call with no readable name is
 * skipped rather than filed under a placeholder: an invented bucket would show up in the profile as
 * a skill somebody uses.
 */
export function skillUsesFromClaudeJsonl(lines: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of lines) {
    if (!line.includes('"Skill"')) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(line) as Record<string, unknown> } catch { continue }
    const msg = e.message as Record<string, unknown> | undefined
    const content = msg?.content
    if (!Array.isArray(content)) continue
    for (const p of content as Record<string, unknown>[]) {
      if (p.type !== 'tool_use' || p.name !== 'Skill') continue
      const input = p.input as Record<string, unknown> | undefined
      const name = input?.skill
      if (typeof name !== 'string' || name === '') continue
      out[name] = (out[name] ?? 0) + 1
    }
  }
  return out
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/server/server/jsonl-compaction.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Add the fields to `SessionMeta`**

In `packages/core/src/types.ts`, inside `interface SessionMeta`, immediately after `context_window?: number`:

```ts
  /**
   * WHAT COMPACTION COST THIS SESSION. Claude-only — gated by `HARNESS_CAPABILITIES.compaction`.
   *
   * `compact_dropped_tokens` is the LAST cumulative reading, not a sum of them, and is absent when
   * no record reported one. See `compactsFromClaudeJsonl`.
   */
  compact_count?: number
  compact_ms?: number
  compact_dropped_tokens?: number
  /** Skill invocations by name (`superpowers:brainstorming`), from the `Skill` tool_use. */
  skill_uses?: Record<string, number>
```

- [ ] **Step 6: Add the capability flag**

In `packages/core/src/types.ts`, add to `interface HarnessCapabilities` after `contextWindow`:

```ts
  /**
   * The harness records when it compacted the conversation, so `compact_count` can be filled.
   * Claude Code writes a `compact_boundary` system line with a `compactMetadata` block; no other
   * harness has an equivalent marker, so the profile's compaction figures are absent there rather
   * than zero.
   */
  compaction: boolean
```

Then add `compaction` to all six entries of `HARNESS_CAPABILITIES`: `true` for `claude`, `false` for `codex`, `gemini`, `copilot`, `antigravity` and `kimi`. The record is typed `Record<HarnessId, HarnessCapabilities>`, so the build fails until every entry has it.

- [ ] **Step 7: Wire the readers into `parseSessionJsonl`**

In `packages/server/server/jsonl.ts`, in the object literal returned by `parseSessionJsonl` (the one containing `tool_counts: toolCounts,`), add after `tool_counts`:

```ts
    ...(compaction.count > 0
      ? {
          compact_count: compaction.count,
          compact_ms: compaction.ms,
          ...(compaction.droppedTokens !== undefined
            ? { compact_dropped_tokens: compaction.droppedTokens }
            : {}),
        }
      : {}),
    ...(Object.keys(skillUses).length > 0 ? { skill_uses: skillUses } : {}),
```

and compute both from the same `lines` array the function already read, before that return:

```ts
  const compaction = compactsFromClaudeJsonl(lines)
  const skillUses = skillUsesFromClaudeJsonl(lines)
```

If the local variable holding the file's lines is not named `lines`, use whatever it is named — do not re-read the file.

- [ ] **Step 8: Verify against real data**

Run:

```bash
bun -e '
import { compactsFromClaudeJsonl } from "./packages/server/server/jsonl.ts"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
const root = join(process.env.HOME!, ".claude/projects")
let count = 0, sessions = 0, dropped = 0
for (const d of readdirSync(root)) {
  let files: string[] = []
  try { files = readdirSync(join(root, d)) } catch { continue }
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue
    const out = compactsFromClaudeJsonl(readFileSync(join(root, d, f), "utf8").split("\n"))
    if (out.count) { count += out.count; sessions++; dropped += out.droppedTokens ?? 0 }
  }
}
console.log({ count, sessions, droppedM: (dropped / 1e6).toFixed(1) })
'
```

Expected: a non-zero `count` over several `sessions`. On the machine this was written on (live directory only, which is ~60% of the history): `{ count: 19, sessions: 14 }`. **The exact numbers will differ per machine and over time — what must hold is that `count > 0` and that `droppedM` is far below the sum of the individual readings.** If `count` is 0, the marker shape has changed and Step 3 needs re-probing against a real transcript before going further.

- [ ] **Step 9: Run the full suite**

Run: `bun tsc --noEmit && bun test`
Expected: PASS, no failures.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/types.ts packages/server/server/jsonl.ts \
        packages/server/server/jsonl-compaction.test.ts
git commit -m "feat(sessions): capture compaction and skill usage per session

\`cumulativeDroppedTokens\` is cumulative, so it is a MAX and never a sum — on a
real five-compact session, summing reported 14,4M against a true 4,8M. It is
also absent from 27 of 46 real records, so it stays undefined rather than 0.

Claude-only, behind a new HARNESS_CAPABILITIES.compaction."
```

---

### Task 2: The pure baseline module

**Files:**
- Create: `packages/core/src/session-profile.ts`
- Create: `packages/core/src/session-profile.test.ts`
- Modify: `packages/core/src/index.ts` (add the barrel export)

**Interfaces:**
- Consumes: `SessionMeta` and its Task 1 fields.
- Produces: `interface MetricBaseline { median: number; mean: number; n: number; nonZero: number }`, `interface Baseline { windowDays: number; sessions: number; metrics: Record<ProfileMetric, MetricBaseline> }`, `type ProfileMetric = 'compacts' | 'messages' | 'activeMinutes' | 'tokens' | 'toolErrors' | 'skills' | 'mcpServers' | 'subagents'`, and `profileOf(sessions: readonly SessionMeta[], nowMs: number, windowDays?: number): Baseline`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/session-profile.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { profileOf } from './session-profile'
import type { SessionMeta } from './types'

const DAY = 86_400_000
const NOW = Date.parse('2026-09-08T12:00:00Z')

/** The narrowest session this module accepts, dated `daysAgo` before NOW. */
function session(daysAgo: number, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    session_id: `s${daysAgo}-${Math.random()}`,
    project_path: '/p',
    start_time: new Date(NOW - daysAgo * DAY).toISOString(),
    duration_minutes: 0,
    user_message_count: 0,
    assistant_message_count: 0,
    tool_counts: {},
    tool_output_tokens: {},
    agent_file_reads: {},
    languages: [],
    git_commits: 0,
    git_pushes: 0,
    input_tokens: 0,
    output_tokens: 0,
    first_prompt: '',
    user_interruptions: 0,
    user_response_times: [],
    tool_errors: 0,
    tool_error_categories: {},
    uses_task_agent: false,
    uses_mcp: false,
    uses_web_search: false,
    uses_web_fetch: false,
    lines_added: 0,
    lines_removed: 0,
    files_modified: 0,
    message_hours: [],
    user_message_timestamps: [],
    harness: 'claude',
    ...over,
  }
}

describe('the window', () => {
  it('keeps sessions inside 30 days and drops the ones outside', () => {
    const p = profileOf([
      session(1, { user_message_count: 10 }),
      session(29, { user_message_count: 10 }),
      session(31, { user_message_count: 999 }),
    ], NOW)
    expect(p.sessions).toBe(2)
    expect(p.metrics.messages.n).toBe(2)
  })

  it('uses the UTC day rule, not the local clock', () => {
    // 23:30 UTC on the boundary day. A local-clock reading at UTC-3 would file this on the next
    // day and move it in or out of the window depending on the machine's timezone.
    const p = profileOf(
      [session(0, { start_time: '2026-08-09T23:30:00Z', user_message_count: 5 })],
      NOW,
    )
    expect(p.sessions).toBe(0)
  })
})

describe('median over mean', () => {
  it('reports both, and they differ on a skewed set', () => {
    // Real shape, measured over 692 sessions: median 30, mean 92. The mean describes no session
    // anybody has, which is why the median is what a card quotes.
    const p = profileOf(
      [1, 2, 3, 4, 500].map(n => session(1, { user_message_count: n })),
      NOW,
    )
    expect(p.metrics.messages.median).toBe(3)
    expect(p.metrics.messages.mean).toBe(102)
  })
})

describe('n is PER METRIC', () => {
  it('counts only the sessions that could have carried the metric', () => {
    // `skill_uses` exists only for sessions whose transcript survived. A shared `n` would average
    // skills over sessions that could never have had one.
    const p = profileOf([
      session(1, { user_message_count: 10, skill_uses: { a: 2 } }),
      session(2, { user_message_count: 10 }),
      session(3, { user_message_count: 10 }),
    ], NOW)
    expect(p.metrics.messages.n).toBe(3)
    expect(p.metrics.skills.n).toBe(1)
  })

  it('counts a present-but-empty measurement, and not an absent one', () => {
    // `skill_uses: {}` is "this session used no skills" — a real zero. An absent field is "we
    // cannot know", and it must not be averaged in as a zero.
    const p = profileOf([
      session(1, { skill_uses: {} }),
      session(2, {}),
    ], NOW)
    expect(p.metrics.skills.n).toBe(1)
    expect(p.metrics.skills.median).toBe(0)
  })
})

describe('compacts', () => {
  it('is zero-median with a long tail, and reports how many sessions ever had one', () => {
    const p = profileOf([
      ...Array.from({ length: 17 }, () => session(1, { compact_count: 1 })),
      session(1, { compact_count: 8 }),
      ...Array.from({ length: 40 }, () => session(1, { compact_count: 0 })),
    ], NOW)
    expect(p.metrics.compacts.median).toBe(0)
    expect(p.metrics.compacts.nonZero).toBe(18)
    expect(p.metrics.compacts.n).toBe(58)
  })
})

describe('an empty window', () => {
  it('reports n = 0 rather than a median of 0', () => {
    const p = profileOf([], NOW)
    expect(p.sessions).toBe(0)
    expect(p.metrics.messages.n).toBe(0)
    expect(p.metrics.messages.median).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/core/src/session-profile.test.ts`
Expected: FAIL — module `./session-profile` not found.

- [ ] **Step 3: Write the module**

Create `packages/core/src/session-profile.ts`:

```ts
/**
 * session-profile.ts — PURE. What this machine's sessions USUALLY look like.
 *
 * The baselines a suggestion is read against. `2 compacts` is a threshold somebody invented;
 * `2 compacts — 6 of your 700 sessions ever reached that` is a measurement, and only the second
 * earns a card. See docs/superpowers/specs/2026-09-08-session-suggestions-design.md.
 *
 * Pure and total: it receives `now` rather than reading a clock, so a test can place a session on
 * either side of the window without touching the machine's time.
 */
import { sessionTokens, totalTokens } from './tokens'
import type { SessionMeta } from './types'

/**
 * `costUSD` is deliberately ABSENT. Cost is not a field on `SessionMeta` — it is computed by
 * `calcCost` from the model and the four counters — and reaching for it here would make this pure
 * module depend on the pricing table. The suggestions plan adds it there if it needs it.
 */
export type ProfileMetric =
  | 'compacts' | 'messages' | 'activeMinutes' | 'tokens'
  | 'toolErrors' | 'skills' | 'mcpServers' | 'subagents'

export interface MetricBaseline {
  /** What a typical session looks like. The headline, because these distributions are skewed. */
  median: number
  /** Kept beside it because a rate question ("compacts per session") legitimately wants it. */
  mean: number
  /** How many sessions in the window could have carried THIS metric — see below. */
  n: number
  /** Of those, how many were above zero. The only honest denominator for a rare event. */
  nonZero: number
}

export interface Baseline {
  windowDays: number
  /** Sessions inside the window, whatever they carry. */
  sessions: number
  metrics: Record<ProfileMetric, MetricBaseline>
}

export const PROFILE_WINDOW_DAYS = 30

/**
 * The day a session belongs to — UTC, from `start_time`.
 *
 * The same rule `tagSessionDay` and the billing basis use. The repo has two day rules and the other
 * one is the local clock; at UTC-3 they disagree, which would move a session in or out of the
 * window depending on the machine reading it.
 */
function dayMs(s: SessionMeta): number {
  const day = (s.start_time ?? '').slice(0, 10)
  const t = Date.parse(`${day}T00:00:00Z`)
  return Number.isNaN(t) ? Number.NaN : t
}

/**
 * `n` IS PER METRIC, NEVER THE SAMPLE SIZE.
 *
 * `skill_uses`, the subagent counts and the compaction figures exist only for sessions whose raw
 * transcript survived Claude's cleanup. One shared `n` would compute the skills average over
 * sessions that could not possibly have carried one — a denominator that is quietly wrong in the
 * direction of "you use fewer skills than you think".
 *
 * A reader returning `undefined` means "this session cannot answer"; `0` means "it answered zero".
 */
type Reader = (s: SessionMeta) => number | undefined

const READERS: Record<ProfileMetric, Reader> = {
  compacts: s => s.compact_count,
  messages: s => s.user_message_count,
  activeMinutes: s => s.active_minutes,
  tokens: s => totalTokens(sessionTokens(s)),
  toolErrors: s => s.tool_errors,
  skills: s => (s.skill_uses ? Object.keys(s.skill_uses).length : undefined),
  mcpServers: s => {
    const names = Object.keys(s.tool_counts ?? {}).filter(t => t.startsWith('mcp__'))
    return new Set(names.map(t => t.split('__')[1] ?? t)).size
  },
  subagents: s => s.agentMetrics?.totalInvocations,
}

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

function baselineOf(values: number[]): MetricBaseline {
  if (values.length === 0) return { median: 0, mean: 0, n: 0, nonZero: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((t, v) => t + v, 0)
  return {
    median: median(sorted),
    mean: sum / sorted.length,
    n: sorted.length,
    nonZero: sorted.filter(v => v > 0).length,
  }
}

export function profileOf(
  sessions: readonly SessionMeta[],
  nowMs: number,
  windowDays: number = PROFILE_WINDOW_DAYS,
): Baseline {
  const floor = nowMs - windowDays * 86_400_000
  const inWindow = sessions.filter(s => {
    const d = dayMs(s)
    return !Number.isNaN(d) && d >= floor && d <= nowMs
  })

  const metrics = {} as Record<ProfileMetric, MetricBaseline>
  for (const key of Object.keys(READERS) as ProfileMetric[]) {
    const read = READERS[key]
    const values: number[] = []
    for (const s of inWindow) {
      const v = read(s)
      if (typeof v === 'number' && Number.isFinite(v)) values.push(v)
    }
    metrics[key] = baselineOf(values)
  }

  return { windowDays, sessions: inWindow.length, metrics }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/core/src/session-profile.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Export from the barrel**

In `packages/core/src/index.ts`, add alongside the other exports:

```ts
export * from './session-profile'
```

- [ ] **Step 6: Run the full suite**

Run: `bun tsc --noEmit && bun test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/session-profile.ts packages/core/src/session-profile.test.ts \
        packages/core/src/index.ts
git commit -m "feat(core): the 30-day session behaviour baseline

Pure, given \`now\`. Medians are the headline because these distributions are
skewed — measured over 692 sessions, messages run median 30 against mean 92.

\`n\` is per metric, never the sample size: skills and subagents exist only for
sessions whose transcript survived, and one shared denominator would average
them over sessions that could never have carried one."
```

---

### Task 3: Ship the baseline on `/api/fleet`

**Files:**
- Create: `packages/server/server/sessions/fleet-profile.ts`
- Create: `packages/server/server/sessions/fleet-profile.test.ts`
- Modify: `packages/server/server/index.ts` (the `GET /api/fleet` handler)
- Modify: `packages/server/server/sessions/fleet-row.ts` (the response type)

**Interfaces:**
- Consumes: `profileOf`, `Baseline`, `PROFILE_WINDOW_DAYS` from `@agentistics/core`.
- Produces: `cachedBaseline(load: () => Promise<SessionMeta[]>, nowMs: number): Promise<Baseline>` and a `baseline?: Baseline` field on the `/api/fleet` response body.

**Why cached, and why on this payload.** The baseline is a scan of the consolidate store. `/api/data` is megabytes on a 300s timer while the fleet poll is 5s and a few kilobytes, so deriving the profile client-side would spend a megabyte a minute to move a number that changes once per session. It travels here, computed once, behind a TTL.

- [ ] **Step 1: Write the failing test**

Create `packages/server/server/sessions/fleet-profile.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { cachedBaseline, resetBaselineCache, BASELINE_TTL_MS } from './fleet-profile'
import type { SessionMeta } from '@agentistics/core'

const NOW = Date.parse('2026-09-08T12:00:00Z')

const one = (): SessionMeta[] => ([{
  session_id: 's1', project_path: '/p', start_time: '2026-09-07T00:00:00Z',
  duration_minutes: 0, user_message_count: 7, assistant_message_count: 0,
  tool_counts: {}, tool_output_tokens: {}, agent_file_reads: {}, languages: [],
  git_commits: 0, git_pushes: 0, input_tokens: 0, output_tokens: 0, first_prompt: '',
  user_interruptions: 0, user_response_times: [], tool_errors: 0, tool_error_categories: {},
  uses_task_agent: false, uses_mcp: false, uses_web_search: false, uses_web_fetch: false,
  lines_added: 0, lines_removed: 0, files_modified: 0, message_hours: [],
  user_message_timestamps: [], harness: 'claude',
}])

describe('cachedBaseline', () => {
  it('loads once and serves the cached answer inside the TTL', async () => {
    resetBaselineCache()
    let loads = 0
    const load = async () => { loads++; return one() }
    const a = await cachedBaseline(load, NOW)
    const b = await cachedBaseline(load, NOW + BASELINE_TTL_MS - 1)
    expect(loads).toBe(1)
    expect(a.metrics.messages.median).toBe(7)
    expect(b).toEqual(a)
  })

  it('reloads once the TTL has passed', async () => {
    resetBaselineCache()
    let loads = 0
    const load = async () => { loads++; return one() }
    await cachedBaseline(load, NOW)
    await cachedBaseline(load, NOW + BASELINE_TTL_MS + 1)
    expect(loads).toBe(2)
  })

  it('keeps the previous answer when a reload throws', async () => {
    // A failed store read must not blank a profile that was correct a minute ago — the same rule
    // `sessions-host.ts` applies to a failed poll.
    resetBaselineCache()
    let loads = 0
    const load = async () => {
      loads++
      if (loads === 2) throw new Error('store unreadable')
      return one()
    }
    const first = await cachedBaseline(load, NOW)
    const second = await cachedBaseline(load, NOW + BASELINE_TTL_MS + 1)
    expect(second).toEqual(first)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/server/server/sessions/fleet-profile.test.ts`
Expected: FAIL — module `./fleet-profile` not found.

- [ ] **Step 3: Write the cache**

Create `packages/server/server/sessions/fleet-profile.ts`:

```ts
/**
 * fleet-profile.ts — the behaviour baseline, computed once and cached.
 *
 * The arithmetic is pure and lives in `@agentistics/core/session-profile`. This is only the IO
 * boundary: reading the consolidate store is a directory scan, and the fleet poll runs every five
 * seconds, so the answer is held for a while.
 */
import { profileOf, type Baseline, type SessionMeta } from '@agentistics/core'

/** Long, because the answer moves once per session and the scan is the expensive part. */
export const BASELINE_TTL_MS = 5 * 60_000

let cached: { at: number; value: Baseline } | null = null

/** Test seam. Never called in production. */
export function resetBaselineCache(): void {
  cached = null
}

export async function cachedBaseline(
  load: () => Promise<SessionMeta[]>,
  nowMs: number,
): Promise<Baseline> {
  if (cached && nowMs - cached.at < BASELINE_TTL_MS) return cached.value
  try {
    const value = profileOf(await load(), nowMs)
    cached = { at: nowMs, value }
    return value
  } catch {
    // A store that cannot be read costs freshness, never the profile on screen. Same rule the
    // sessions poller applies to a failed poll: keep the previous answer.
    if (cached) return cached.value
    throw new Error('baseline unavailable')
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/server/server/sessions/fleet-profile.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 5: Add `baseline` to the fleet response**

In `packages/server/server/sessions/fleet-row.ts`, on the interface describing the `/api/fleet` response body (the one holding `sessions`), add:

```ts
  /** This machine's 30-day behaviour baseline. Absent when the store could not be read at all. */
  baseline?: Baseline
```

and import the type: `import type { Baseline } from '@agentistics/core'`.

- [ ] **Step 6: Fill it in the handler**

In `packages/server/server/index.ts`, in the `GET /api/fleet` handler, wrap the baseline read so a failure never costs the fleet:

```ts
      const baseline = await cachedBaseline(loadConsolidated, Date.now()).catch(() => undefined)
```

and include `...(baseline ? { baseline } : {})` in the JSON body beside `sessions`. Import `cachedBaseline` from `./sessions/fleet-profile` and `loadConsolidated` from `./consolidate` — if `loadConsolidated`'s signature does not match `() => Promise<SessionMeta[]>`, wrap it in an arrow that adapts it rather than changing its signature.

- [ ] **Step 7: Verify the route answers**

Run, with a server already running on this machine:

```bash
curl -s localhost:47291/api/fleet | python3 -c "import json,sys; d=json.load(sys.stdin); b=d.get('baseline'); print('sessions in window:', b and b['sessions']); print('messages:', b and b['metrics']['messages'])"
```

Expected: a non-null `sessions` count and a `messages` object carrying `median`, `mean`, `n`, `nonZero`. If `baseline` is `null`, the store read failed — check the server log rather than assuming the field is wrong.

- [ ] **Step 8: Run the full suite**

Run: `bun tsc --noEmit && bun test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/server/server/sessions/fleet-profile.ts \
        packages/server/server/sessions/fleet-profile.test.ts \
        packages/server/server/sessions/fleet-row.ts packages/server/server/index.ts
git commit -m "feat(server): ship the behaviour baseline on /api/fleet

Computed once behind a 5-minute TTL. It rides the fleet payload rather than
being derived client-side from /api/data, which is megabytes on a 300s timer
against a 5s fleet poll. A failed store read keeps the previous answer."
```

---

### Task 4: Show the profile where the cockpit's list is empty

**Files:**
- Create: `packages/tui/src/control/profile-lines.ts`
- Create: `packages/tui/src/control/profile-lines.test.ts`
- Modify: `packages/tui/src/control/tabs/Sessions.tsx:1578` (the `emptyReason` region and the empty branch at line 1899)
- Modify: `packages/tui/src/control/types.ts` (carry `baseline` on the fleet snapshot)
- Modify: `packages/tui/src/control/i18n.ts` (the labels)

**Interfaces:**
- Consumes: `Baseline` from `@agentistics/core`.
- Produces: `profileLines(baseline: Baseline | undefined, width: number, s: ControlStrings): string[]`.

**The empty-state sentence STAYS.** "nothing is running", "the filter withheld it" and "the search found nothing" send a person to three different places, and that distinction is why `emptyReason` exists. The profile renders BELOW it — it fills the dead space, it does not replace the explanation.

- [ ] **Step 1: Write the failing test**

Create `packages/tui/src/control/profile-lines.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { profileLines } from './profile-lines'
import { controlStrings } from './i18n'
import type { Baseline } from '@agentistics/core'

const S = controlStrings('en')

const baseline = (over: Partial<Baseline['metrics']> = {}): Baseline => ({
  windowDays: 30,
  sessions: 692,
  metrics: {
    compacts: { median: 0, mean: 0.066, n: 700, nonZero: 23 },
    messages: { median: 30, mean: 92, n: 692, nonZero: 692 },
    activeMinutes: { median: 12, mean: 40, n: 500, nonZero: 480 },
    tokens: { median: 1000, mean: 5000, n: 692, nonZero: 692 },
    toolErrors: { median: 0, mean: 2, n: 692, nonZero: 100 },
    skills: { median: 0, mean: 0.3, n: 57, nonZero: 40 },
    mcpServers: { median: 0, mean: 1, n: 692, nonZero: 88 },
    subagents: { median: 0, mean: 2, n: 50, nonZero: 34 },
    ...over,
  },
})

describe('profileLines', () => {
  it('states the median with the metric it belongs to', () => {
    const out = profileLines(baseline(), 80, S).join('\n')
    expect(out).toContain('30')
    expect(out).toContain('messages')
  })

  it('names the window and the denominator, because a baseline without them is an opinion', () => {
    const out = profileLines(baseline(), 80, S).join('\n')
    expect(out).toContain('30')
    expect(out).toContain('692')
  })

  it('drops a metric no session could answer rather than printing a zero', () => {
    // A row reading "skills: 0" on a machine where no transcript survived would claim the user
    // never invokes one. `n === 0` means unanswerable, and unanswerable is absent.
    const out = profileLines(baseline({ skills: { median: 0, mean: 0, n: 0, nonZero: 0 } }), 80, S)
    expect(out.join('\n')).not.toContain('skills')
  })

  it('returns nothing at all when there is no baseline', () => {
    expect(profileLines(undefined, 80, S)).toEqual([])
  })

  it('never emits a line wider than the width it was given', () => {
    for (const w of [30, 50, 80, 120]) {
      for (const line of profileLines(baseline(), w, S)) {
        expect(line.length).toBeLessThanOrEqual(w)
      }
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/tui/src/control/profile-lines.test.ts`
Expected: FAIL — module `./profile-lines` not found.

- [ ] **Step 3: Write the renderer**

Create `packages/tui/src/control/profile-lines.ts`:

```ts
/**
 * profile-lines.ts — PURE. The behaviour profile as lines, for the empty sessions list.
 *
 * A metric no session could answer (`n === 0`) is DROPPED, never printed as a zero: a row reading
 * "cost: 0" would claim every session was free. Same rule the dashboard applies to a harness
 * capability it does not have.
 */
import type { Baseline, ProfileMetric } from '@agentistics/core'
import type { ControlStrings } from './i18n'

/** The metrics worth a row, most-recognisable first. Order is the reading order. */
const SHOWN: ProfileMetric[] = ['messages', 'activeMinutes', 'compacts', 'skills', 'mcpServers', 'subagents']

function round(n: number): string {
  return n >= 10 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(2)
}

export function profileLines(
  baseline: Baseline | undefined,
  width: number,
  s: ControlStrings,
): string[] {
  if (!baseline) return []
  const out: string[] = [s.profileHeading(baseline.windowDays, baseline.sessions)]
  for (const key of SHOWN) {
    const m = baseline.metrics[key]
    if (!m || m.n === 0) continue
    out.push(`  ${s.profileMetric(key)}: ${round(m.median)}  (n=${m.n})`)
  }
  return out.map(l => (l.length > width ? l.slice(0, width) : l))
}
```

- [ ] **Step 4: Add the strings**

In `packages/tui/src/control/i18n.ts`, add to the `ControlStrings` interface and to BOTH the `en` and `pt` objects:

```ts
  profileHeading: (days: number, sessions: number) => string
  profileMetric: (key: string) => string
```

English:

```ts
  profileHeading: (days, sessions) => `Your last ${days} days · ${sessions} sessions`,
  profileMetric: key => ({
    messages: 'messages', activeMinutes: 'active minutes', compacts: 'compacts',
    skills: 'skills', mcpServers: 'MCP servers', subagents: 'subagents',
  }[key] ?? key),
```

Portuguese:

```ts
  profileHeading: (days, sessions) => `Seus últimos ${days} dias · ${sessions} sessões`,
  profileMetric: key => ({
    messages: 'mensagens', activeMinutes: 'minutos ativos', compacts: 'compacts',
    skills: 'skills', mcpServers: 'servidores MCP', subagents: 'subagentes',
  }[key] ?? key),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/tui/src/control/profile-lines.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Render it under the empty-state sentence**

In `packages/tui/src/control/types.ts`, add `baseline?: Baseline` to the fleet snapshot type the sessions tab receives, importing `Baseline` from `@agentistics/core`.

In `packages/tui/src/control/tabs/Sessions.tsx`, at the empty branch around line 1899 (`: truncate(emptyReason, listBody)`), keep that sentence as the first line and append the profile under it:

```tsx
            : (
              <Box flexDirection="column">
                <Text>{truncate(emptyReason, listBody)}</Text>
                {profileLines(fleet?.baseline, listBody, s).map((line, i) => (
                  <Text key={i} dimColor>{line}</Text>
                ))}
              </Box>
            )}
```

Import `profileLines` from `../profile-lines`. Budget check: the list body already has a row budget; the profile is at most 7 lines, so if `listBody` rows are constrained, slice the result to the rows available rather than letting it overflow — a screen that overflows its `height` is composited over the rows below it, not clipped.

- [ ] **Step 7: Run the full suite and build the binary**

Run: `bun tsc --noEmit && bun test && bun run build:binary`
Expected: PASS, and `./release/agentop` is produced. The binary build is required for any TUI change — the `react-devtools-core` failure mode only appears at compile time.

- [ ] **Step 8: Commit**

```bash
git add packages/tui/src/control/profile-lines.ts \
        packages/tui/src/control/profile-lines.test.ts \
        packages/tui/src/control/i18n.ts packages/tui/src/control/types.ts \
        packages/tui/src/control/tabs/Sessions.tsx
git commit -m "feat(tui): the behaviour profile fills the empty sessions list

Under the empty-state sentence, never instead of it: 'nothing is running',
'the filter withheld it' and 'the search found nothing' send a person to three
different places, which is why that sentence exists.

A metric no session could answer is dropped rather than printed as a zero."
```

---

### Task 5: Show the profile in the web sessions view

**Files:**
- Create: `packages/web/src/components/sessions/ProfilePanel.tsx`
- Modify: `packages/web/src/lib/fleet.ts` (carry `baseline` on the fleet response type)
- Modify: `packages/web/src/components/sessions/FleetOverview.tsx` (its empty branch) — `packages/web/src/pages/SessionsPage.tsx` is the page that renders it

**Interfaces:**
- Consumes: `Baseline` from `@agentistics/core`, the `baseline` field added in Task 3.
- Produces: `<ProfilePanel baseline={...} pt={...} />`.

- [ ] **Step 1: Carry the field**

In `packages/web/src/lib/fleet.ts`, on the type describing the `/api/fleet` response, add:

```ts
  /** This machine's 30-day behaviour baseline — see `session-profile.ts`. */
  baseline?: Baseline
```

importing `Baseline` from `@agentistics/core`.

- [ ] **Step 2: Write the panel**

Create `packages/web/src/components/sessions/ProfilePanel.tsx`:

```tsx
import type { Baseline, ProfileMetric } from '@agentistics/core'

const SHOWN: ProfileMetric[] = ['messages', 'activeMinutes', 'compacts', 'skills', 'mcpServers', 'subagents']

const LABEL_EN: Record<string, string> = {
  messages: 'messages', activeMinutes: 'active minutes', compacts: 'compacts',
  skills: 'skills', mcpServers: 'MCP servers', subagents: 'subagents',
}
const LABEL_PT: Record<string, string> = {
  messages: 'mensagens', activeMinutes: 'minutos ativos', compacts: 'compacts',
  skills: 'skills', mcpServers: 'servidores MCP', subagents: 'subagentes',
}

const round = (n: number) => (n >= 10 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(2))

/**
 * The behaviour profile, shown where the sessions list is empty.
 *
 * A metric with `n === 0` is DROPPED, never rendered as a zero — the same N/A-versus-a-confident-0
 * rule `HARNESS_CAPABILITIES` applies to harness metrics.
 */
export function ProfilePanel({ baseline, pt }: { baseline?: Baseline; pt: boolean }) {
  if (!baseline) return null
  const label = pt ? LABEL_PT : LABEL_EN
  const rows = SHOWN
    .map(k => ({ k, m: baseline.metrics[k] }))
    .filter(r => r.m && r.m.n > 0)
  if (rows.length === 0) return null

  return (
    <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {pt
          ? `Seus últimos ${baseline.windowDays} dias · ${baseline.sessions} sessões`
          : `Your last ${baseline.windowDays} days · ${baseline.sessions} sessions`}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
        {rows.map(({ k, m }) => (
          <div key={k} style={{
            padding: '10px 12px', borderRadius: 10,
            background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', minWidth: 0,
          }}>
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>{round(m!.median)}</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{label[k] ?? k}</div>
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>n={m!.n}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Render it under the existing empty state**

In `packages/web/src/components/sessions/FleetOverview.tsx`, find the branch that renders the "no sessions" sentence and add `<ProfilePanel baseline={fleet?.baseline} pt={pt} />` **after** it, never in place of it. Do not change the sentence — it is what distinguishes "nothing is running" from "the filter withheld it".

- [ ] **Step 4: Verify at 390px**

Run `bun run dev`, open the sessions view with no sessions matching, set the viewport to 390px wide, and confirm in the browser console:

```js
document.documentElement.scrollWidth <= window.innerWidth
```

Expected: `true`. The grid uses `auto-fit` with a 120px minimum, so it collapses to two columns at 390px; if it does not, reduce the minimum rather than adding a media query.

- [ ] **Step 5: Run the full suite**

Run: `bun tsc --noEmit && bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/sessions/ProfilePanel.tsx packages/web/src/lib/fleet.ts
git commit -m "feat(web): the behaviour profile in the empty sessions view

Verified at 390px: the grid collapses rather than scrolling the page body."
```

---

### Task 6: Correct the spec's dropped-token figure

**Files:**
- Modify: `docs/superpowers/specs/2026-09-08-session-suggestions-design.md`

The spec says **30M tokens dropped**. That figure summed `cumulativeDroppedTokens`, which Task 1 establishes is cumulative — the correct total is **19,4M**, and 27 of 46 records carry no such field at all. The correction rides with the code that implements the rule, because they are the same fact.

- [ ] **Step 1: Fix the figure and record why**

In the "Ground truth" section, replace:

```
83 minutes spent compacting, 30M tokens dropped.**
```

with:

```
83 minutes spent compacting, 19,4M tokens dropped.**

`cumulativeDroppedTokens` is cumulative and monotonic (measured on a real five-compact session:
954.238 → 1.910.306 → 2.876.708 → 3.829.252 → 4.785.215), so the per-session figure is its LAST
reading and the fleet total is the sum of those — never the sum of every record, which reported 30M
against a true 19,4M. It is also absent from 27 of the 46 records, so a session whose records all
lack it reports nothing rather than zero.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-09-08-session-suggestions-design.md
git commit -m "docs(sessions): the dropped-token total was a sum of a cumulative field

30M was the sum of every cumulativeDroppedTokens reading; the field is
cumulative, so the per-session figure is its last one and the true total is
19,4M. Caught while writing the parser that reads it."
```

---

### Task 7: Backfill the archived transcripts, once

**Files:**
- Create: `packages/server/scripts/backfill-compaction.ts`

**Why this task exists and why it cannot wait.** Task 1 fills the new fields for every session
`parseSessionJsonl` reads from now on. It does NOT reach the sessions whose raw transcript lives
only in `~/.agentistics/archive` — with `archiveMode: consolidate` (the default and the common
setting) `data.ts` reads the live root alone, so those transcripts are never parsed again.

Measured on the machine this was written on: 420 live transcripts, **284 archive-only**, 708 entries
in the consolidate store. Without this task, 284 sessions keep `compact_count: undefined` forever
even though the evidence is sitting on disk — and Claude deletes live transcripts after
`cleanupPeriodDays`, so the set this can still recover shrinks every day the field is not stamped.

- [ ] **Step 1: Write the script**

Create `packages/server/scripts/backfill-compaction.ts`:

```ts
/**
 * One-shot: stamp `compact_count` / `compact_ms` / `compact_dropped_tokens` / `skill_uses` onto
 * consolidate-store entries whose raw transcript still exists.
 *
 * Idempotent — re-running it changes nothing. It only ever ADDS the four fields; it never rewrites
 * a session's other metrics, because those were computed by a parser that had the whole file and
 * this script has only the lines.
 *
 *   bun run packages/server/scripts/backfill-compaction.ts [--dry-run]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compactsFromClaudeJsonl, skillUsesFromClaudeJsonl } from '../server/jsonl'
import { PROJECTS_DIR, ARCHIVE_PROJECTS_DIR, CONSOLIDATED_DIR } from '../server/config'

const dryRun = process.argv.includes('--dry-run')

/** Every transcript we can still read, keyed by session id. Live wins over archive. */
function transcripts(): Map<string, string> {
  const found = new Map<string, string>()
  for (const root of [ARCHIVE_PROJECTS_DIR, PROJECTS_DIR]) {
    let dirs: string[] = []
    try { dirs = readdirSync(root) } catch { continue }
    for (const d of dirs) {
      let files: string[] = []
      try { files = readdirSync(join(root, d)) } catch { continue }
      for (const f of files) {
        if (f.endsWith('.jsonl')) found.set(f.slice(0, -6), join(root, d, f))
      }
    }
  }
  return found
}

let stamped = 0
let skipped = 0
const files = transcripts()

for (const [sessionId, path] of files) {
  // The consolidate store is namespaced by harness; compaction is Claude-only.
  const storePath = join(CONSOLIDATED_DIR, 'claude', `${sessionId}.json`)
  let doc: Record<string, unknown>
  try { doc = JSON.parse(readFileSync(storePath, 'utf8')) } catch { skipped++; continue }
  if (doc.compact_count !== undefined && doc.skill_uses !== undefined) { skipped++; continue }

  const lines = readFileSync(path, 'utf8').split('\n')
  const c = compactsFromClaudeJsonl(lines)
  const skills = skillUsesFromClaudeJsonl(lines)

  if (c.count > 0) {
    doc.compact_count = c.count
    doc.compact_ms = c.ms
    if (c.droppedTokens !== undefined) doc.compact_dropped_tokens = c.droppedTokens
  }
  doc.skill_uses = skills

  if (!dryRun) writeFileSync(storePath, JSON.stringify(doc))
  stamped++
}

console.log(JSON.stringify({ transcripts: files.size, stamped, skipped, dryRun }))
```

These three names are verified against `packages/server/server/config.ts`: `PROJECTS_DIR` is
`~/.claude/projects`, `ARCHIVE_PROJECTS_DIR` is `~/.agentistics/archive/projects` (the archive
mirrors the `projects/` layout, so the transcripts are one level in, NOT at the archive root), and
`CONSOLIDATED_DIR` is `~/.agentistics/sessions`, namespaced by harness.

- [ ] **Step 2: Dry-run it**

Run: `bun run packages/server/scripts/backfill-compaction.ts --dry-run`
Expected: JSON naming a `transcripts` count in the hundreds and a non-zero `stamped`. If `stamped` is 0 and `skipped` equals `transcripts`, the store path is wrong — check `CONSOLIDATED_DIR` and the `claude/` namespace before running it for real.

- [ ] **Step 3: Run it**

Run: `bun run packages/server/scripts/backfill-compaction.ts`
Expected: the same counts, with `dryRun: false`.

- [ ] **Step 4: Confirm it is idempotent**

Run it a second time. Expected: `stamped` is now 0 and everything is `skipped`.

- [ ] **Step 5: Run the full suite**

Run: `bun tsc --noEmit && bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/scripts/backfill-compaction.ts
git commit -m "feat(server): backfill compaction and skill usage from surviving transcripts

The parser only reaches sessions it reads from now on. With archiveMode
consolidate, the archive root is never parsed again — 284 archive-only
transcripts on the machine this was written on. Claude deletes live
transcripts after cleanupPeriodDays, so the recoverable set shrinks daily.

Idempotent, and it only ever ADDS the four fields."
```

---

## After this plan

Plan 2 covers `session-suggestions.ts`, the four triggers and the migrate orchestration. It is deliberately not written yet: the two `N` thresholds it needs (how long a session must be waiting on approval, how many errors of one category count as repetition) should come from the baseline this plan produces, read against real data, rather than from taste.
