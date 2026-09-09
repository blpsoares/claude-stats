// packages/server/server/member-metrics.ts
//
// B7 — per-member / per-machine metrics.
//
// PURE aggregation over `SessionMeta[]`: no Mongo, no auth, no filesystem. The caller decides
// which sessions are visible (the central already scopes `/api/data` per signed-in principal),
// this module only summarizes whatever it is handed.
//
// A byte-for-byte mirror of the logic lives at `packages/web/src/lib/member-metrics.ts` — the web
// bundle must never import from `packages/server/*` (Vite would try to bundle Bun/Node APIs).
// Keep the two files in sync; this one is the canonical copy and the one under test.

import { calcCost, sessionCostUSD as sessionCostByModel, type HarnessId, type SessionMeta } from '@agentistics/core'

/** How rows are grouped: one row per person (`user`) or one row per machine (`memberId`). */
export type MemberGroupBy = 'user' | 'machine'

/** Bucket key used when a session carries neither a `user` nor a `memberId` (solo / local data). */
export const LOCAL_KEY = '__local__'

export interface TopEntry<K extends string = string> {
  key: K
  sessions: number
}

/** The busiest "project" of a member — a git repo or a plain folder, whichever has more sessions.
 *  `kind` tells the UI which label to render (repo short name vs. folder path). */
export interface TopProject extends TopEntry {
  kind: 'repo' | 'folder'
}

/** One machine's slice of a member row. `key` is the `memberId` (the machine's stable id). */
export interface MachineUsage {
  key: string
  sessions: number
  costUSD: number
  totalTokens: number
}

export interface MemberMetrics {
  /** Stable row identity: the `memberId` (machine grouping) or the `user` (user grouping). */
  key: string
  /** Display name of the owning user. Empty when the sessions carry no user (solo machine). */
  user: string
  /** The machine identity when the row maps to exactly one machine, else null. */
  memberId: string | null
  /** Distinct machines contributing to this row (always 1 when grouping by machine). */
  machineCount: number
  /** Per-machine breakdown of this row, ranked by cost desc (the page's primary metric), then
   *  sessions desc, then key asc. One entry when grouping by machine; the member's whole fleet
   *  when grouping by user — which is the only place the reader can see WHERE the work happened.
   *  Sums the same visible sessions as every other field on the row, so the parts always add up
   *  to the whole; it is NOT the deep statsCache history. */
  machines: MachineUsage[]
  /** True when this row's headline totals were replaced by the statsCache history rather than
   *  summed from the visible sessions. The per-machine `machines` breakdown is ALWAYS the visible
   *  sessions, so when this is set the parts legitimately add up to less than the whole and the UI
   *  must say so — silently showing chips that do not close is how a reader stops trusting both. */
  totalsFromCache?: boolean
  sessions: number
  costUSD: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** input + output + cache read + cache write. */
  totalTokens: number
  /** ISO timestamp of the earliest session start, or null when no session had a usable date. */
  firstActivity: string | null
  /** ISO timestamp of the latest session end (falling back to its start). */
  lastActivity: string | null
  /** All harnesses seen, ordered by session count desc then id asc. */
  harnesses: HarnessId[]
  topProject: TopProject | null
  topModel: TopEntry | null
  topHarness: TopEntry<HarnessId> | null
}

/** Cost of a single session. Always via `calcCost` — never an inline pricing formula.
 *  Sessions with no `model` fall through to `getModelPrice`'s default blend. */
export function sessionCostUSD(s: SessionMeta): number {
  // Per-model when the session spans several models (an Antigravity parent with its subagent
  // children folded in carries a `model_usage` breakdown); single-model otherwise.
  const byModel = sessionCostByModel(s)
  if (byModel !== null) return byModel
  return calcCost(
    {
      inputTokens: s.input_tokens ?? 0,
      outputTokens: s.output_tokens ?? 0,
      cacheReadInputTokens: s.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: s.cache_creation_input_tokens ?? 0,
      webSearchRequests: 0,
      costUSD: 0,
    },
    // THE SESSION'S OWN MODEL. This passed `''` — so every session was priced at
    // `getModelPrice`'s fallback blend whatever it actually ran, which the comment above already
    // said was only meant to happen when the model is unknown. Measured 2026-09-08 against a real
    // `claude-opus-5` session: the board showed $814.93 where the table says $871.45, because opus
    // costs more than the fallback. Under-reporting money is the reassuring direction, which is
    // why it survived.
    s.model ?? '',
  )
}

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1)
}

/** Highest count wins; ties break on the ascending key so the result never depends on Map order. */
function topOf(m: Map<string, number>): TopEntry | null {
  let best: TopEntry | null = null
  for (const [key, sessions] of m) {
    if (!best || sessions > best.sessions || (sessions === best.sessions && key < best.key)) {
      best = { key, sessions }
    }
  }
  return best
}

/** Millisecond value of an ISO-ish timestamp, or null when unparseable. */
function ms(value: string | undefined): number | null {
  if (!value) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}

interface Acc {
  key: string
  users: Map<string, number>
  /** memberId → that machine's slice of this row. Also the machine count (its size). */
  memberIds: Map<string, { sessions: number; costUSD: number; totalTokens: number }>
  sessions: number
  costUSD: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  firstAt: number | null
  firstIso: string | null
  lastAt: number | null
  lastIso: string | null
  repos: Map<string, number>
  folders: Map<string, number>
  models: Map<string, number>
  harnesses: Map<string, number>
}

/**
 * Aggregate sessions into one row per member (`groupBy: 'user'`) or per machine
 * (`groupBy: 'machine'`, the default).
 *
 * Rows are sorted by session count desc, then cost desc, then key asc — fully deterministic.
 */
export function aggregateMemberMetrics(
  sessions: SessionMeta[],
  groupBy: MemberGroupBy = 'machine',
): MemberMetrics[] {
  const acc = new Map<string, Acc>()

  for (const s of sessions) {
    const user = (s.user ?? '').trim()
    const memberId = (s.memberId ?? '').trim()
    const key = groupBy === 'machine'
      ? (memberId || user || LOCAL_KEY)
      : (user || LOCAL_KEY)

    let a = acc.get(key)
    if (!a) {
      a = {
        key,
        users: new Map(),
        memberIds: new Map(),
        sessions: 0,
        costUSD: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        firstAt: null,
        firstIso: null,
        lastAt: null,
        lastIso: null,
        repos: new Map(),
        folders: new Map(),
        models: new Map(),
        harnesses: new Map(),
      }
      acc.set(key, a)
    }

    const cost = sessionCostUSD(s)
    a.sessions++
    a.costUSD += cost
    a.inputTokens += s.input_tokens ?? 0
    a.outputTokens += s.output_tokens ?? 0
    a.cacheReadTokens += s.cache_read_input_tokens ?? 0
    a.cacheWriteTokens += s.cache_creation_input_tokens ?? 0

    if (user) bump(a.users, user)
    if (memberId) {
      // The machine's slice is accumulated from the SAME session totals used above, so the
      // per-machine numbers always sum back to the row's own numbers.
      const slice = a.memberIds.get(memberId)
        ?? { sessions: 0, costUSD: 0, totalTokens: 0 }
      slice.sessions++
      slice.costUSD += cost
      slice.totalTokens += (s.input_tokens ?? 0) + (s.output_tokens ?? 0)
        + (s.cache_read_input_tokens ?? 0) + (s.cache_creation_input_tokens ?? 0)
      a.memberIds.set(memberId, slice)
    }

    const startAt = ms(s.start_time)
    if (startAt !== null && (a.firstAt === null || startAt < a.firstAt)) {
      a.firstAt = startAt
      a.firstIso = s.start_time
    }
    const endIso = s.end_time || s.start_time
    const endAt = ms(endIso)
    if (endAt !== null && (a.lastAt === null || endAt > a.lastAt)) {
      a.lastAt = endAt
      a.lastIso = endIso
    }

    const remote = (s.git_remote ?? '').trim()
    if (remote) bump(a.repos, remote)
    const folder = (s.project_path ?? '').trim()
    if (folder) bump(a.folders, folder)

    const model = (s.model ?? '').trim()
    if (model) bump(a.models, model)
    const harness = (s.harness ?? '').trim()
    if (harness) bump(a.harnesses, harness)
  }

  const rows: MemberMetrics[] = []
  for (const a of acc.values()) {
    const topRepo = topOf(a.repos)
    const topFolder = topOf(a.folders)
    // "Whichever is higher" (ROADMAP B7). On an exact tie the repo wins: it is the stable
    // cross-machine identity, while a folder path is local to one checkout.
    let topProject: TopProject | null = null
    if (topRepo && (!topFolder || topRepo.sessions >= topFolder.sessions)) {
      topProject = { kind: 'repo', key: topRepo.key, sessions: topRepo.sessions }
    } else if (topFolder) {
      topProject = { kind: 'folder', key: topFolder.key, sessions: topFolder.sessions }
    }

    const topHarness = topOf(a.harnesses)
    const harnessList = [...a.harnesses.entries()]
      .sort((x, y) => (y[1] - x[1]) || x[0].localeCompare(y[0]))
      .map(([id]) => id as HarnessId)

    const topUser = topOf(a.users)
    rows.push({
      key: a.key,
      user: topUser?.key ?? '',
      memberId: a.memberIds.size === 1 ? [...a.memberIds.keys()][0]! : null,
      machineCount: a.memberIds.size,
      machines: [...a.memberIds.entries()]
        .map(([key, v]) => ({ key, sessions: v.sessions, costUSD: v.costUSD, totalTokens: v.totalTokens }))
        .sort((x, y) => (y.costUSD - x.costUSD) || (y.sessions - x.sessions) || x.key.localeCompare(y.key)),
      sessions: a.sessions,
      costUSD: a.costUSD,
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
      cacheReadTokens: a.cacheReadTokens,
      cacheWriteTokens: a.cacheWriteTokens,
      totalTokens: a.inputTokens + a.outputTokens + a.cacheReadTokens + a.cacheWriteTokens,
      firstActivity: a.firstIso,
      lastActivity: a.lastIso,
      harnesses: harnessList,
      topProject,
      topModel: topOf(a.models),
      topHarness: topHarness ? { key: topHarness.key as HarnessId, sessions: topHarness.sessions } : null,
    })
  }

  rows.sort((a, b) => (b.sessions - a.sessions) || (b.costUSD - a.costUSD) || a.key.localeCompare(b.key))
  return rows
}
