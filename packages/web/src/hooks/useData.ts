import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { AppData, Filters, DateRange, AgentInvocation, HarnessId, SessionMeta, TokenBreakdown } from '@agentistics/core'
import { calcStreak, calcCost, sessionModelUsage, sessionCostUSD, getModelPrice, MODEL_PRICING, HARNESS_CAPABILITIES, filterByUsers, filterByHarnesses, filterByTeams, filterByMachines, resolveMachineCacheScope, distinctHarnesses, mergeStatsCaches, repoShortName, HARNESS_ORDER, EMPTY_TOKENS, addTokens, sessionTokens, sessionTokenTotal, sumTokens, totalTokens, usageTokenTotal, usageTokens } from '@agentistics/core'
import { subDays, isAfter, isBefore, parseISO, format, differenceInCalendarDays, addDays, getDay } from 'date-fns'
import { makeTagFilter, type TagDef } from '../lib/tagMatch'
import { isUsableDataCache } from '../lib/dataCache'

/**
 * True only for a non-empty string. `start_time`/`end_time`/`date` fields are typed as `string`
 * but that is a compile-time promise only — a malformed record from an external file (a raw
 * `stats-cache.json`, a harness adapter) can carry a number, a Date, or null at runtime. A bare
 * `!!x` truthy check lets any of those through unchanged, and `parseISO`/`format`/`getDay` then
 * throw deep inside date-fns ("e.split is not a function") — taking the whole render tree down
 * with it, since there is no boundary between "no date" and "wrong-shaped date" otherwise.
 */
function isDateStr(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0
}

/**
 * Split a day's per-model TOTAL token count into the input/output/cache breakdown pricing needs.
 *
 * `statsCache.dailyModelTokens` records only a total per model per day, so the split is
 * apportioned from that model's global proportions. It is an approximation and always has been —
 * this function exists so the approximation is written ONCE and tested, rather than living in two
 * copies (the date-filtered `modelUsage` builder and the day-cost series) that could drift into
 * pricing the same day two different ways.
 *
 * With no global row to apportion from, it falls back to 70/30 input/output and claims no cache:
 * inventing a cache split would move tokens onto the cheapest rate in the table and quietly
 * understate the day.
 */
export function apportionModelUsage(
  totalTokens: number,
  global: import('@agentistics/core').ModelUsage | undefined,
): import('@agentistics/core').ModelUsage {
  const gTotal = global
    ? global.inputTokens + global.outputTokens + global.cacheReadInputTokens + global.cacheCreationInputTokens
    : 0
  if (global && gTotal > 0) {
    return {
      inputTokens: Math.round(totalTokens * global.inputTokens / gTotal),
      outputTokens: Math.round(totalTokens * global.outputTokens / gTotal),
      cacheReadInputTokens: Math.round(totalTokens * global.cacheReadInputTokens / gTotal),
      cacheCreationInputTokens: Math.round(totalTokens * global.cacheCreationInputTokens / gTotal),
      webSearchRequests: 0,
      costUSD: 0,
    }
  }
  // @tokens-intentional — this SPLITS a known total, it does not sum one. Claiming no cache is the
  // conservative half of the guess: cache reads are the cheapest rate in the table, so inventing a
  // cache share here would move tokens onto it and understate the day's cost. See the header.
  return {
    inputTokens: Math.round(totalTokens * 0.7),
    outputTokens: Math.round(totalTokens * 0.3),
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
  }
}

/**
 * Close the day series against the headline it decomposes.
 *
 * The residue is the DIFFERENCE, taken exactly, never a reconciliation: `Σ(days) + undated`
 * equals `totalCostUSD` by construction, whichever fork produced the days. That is what lets the
 * plan basis cut A to a set of days and still be able to say, in money, how much of the total it
 * left out.
 */
export function summarizeApiCostByDay(
  days: Partial<Record<HarnessId, Record<string, { costUSD: number; tokens: number; sessions: number }>>>,
  totalCostUSD: number,
  totalTokens: number,
): import('@agentistics/core').ApiCostByDay {
  let datedCostUSD = 0
  let datedTokens = 0
  let firstDay: string | null = null
  let lastDay: string | null = null
  for (const byDay of Object.values(days)) {
    for (const [day, entry] of Object.entries(byDay ?? {})) {
      datedCostUSD += entry.costUSD
      datedTokens += entry.tokens
      if (firstDay === null || day < firstDay) firstDay = day
      if (lastDay === null || day > lastDay) lastDay = day
    }
  }
  return {
    days,
    undatedCostUSD: totalCostUSD - datedCostUSD,
    undatedTokens: totalTokens - datedTokens,
    firstDay,
    lastDay,
  }
}

export interface StageProgress {
  progress: number
  detail?: string
  status: 'pending' | 'active' | 'done'
}

/** Per-repository aggregate (group by normalized git remote), reactive to active filters.
 *  `remote === ''` is the "no linked repository" bucket. `_users`/`_harnesses` are internal
 *  accumulators; consumers read the finalized `members`/`harnesses` arrays. */
export interface RepoStat {
  /** Routing/identity key: the normalized remote for linked repos, or `folder:<project_path>`
   *  for unlinked folders (each unlinked folder is its own card). */
  id: string
  remote: string
  linked: boolean
  /** Display name: `org/repo` for linked, the folder basename for unlinked. */
  name: string
  /** Representative local folder path (most common project_path) — the card subtitle for all. */
  path: string
  sessions: number
  messages: number
  tools: number
  costUSD: number
  /** The two conversational counters. NOT the total — print `tokens` for that. */
  inputTokens: number
  outputTokens: number
  /** All four billed counters — what the card's "tokens" metric and the tokens sort read. */
  tokens: TokenBreakdown
  gitCommits: number
  linesAdded: number
  linesRemoved: number
  filesModified: number
  /** Sessions produced by CI runners (GitHub Actions), i.e. SessionMeta.ci === true. */
  ciSessions: number
  /** Distinct member display names that contributed to this repo (team/central). */
  members: string[]
  harnesses: HarnessId[]
  firstActive: string
  lastActive: string
  activityByDay: Record<string, number>
  _users: Set<string>
  _harnesses: Set<HarnessId>
  _paths: Record<string, number>
}

export type RepoSortKey = 'cost' | 'sessions' | 'tokens' | 'commits' | 'lastActive' | 'name' | 'linked'

/** Sort a repo list by a metric. Numeric/date keys compare numerically; `name`
 *  compares by locale. Non-mutating (returns a new array). `desc` reverses the
 *  ascending order. */
export function sortRepos(repos: RepoStat[], key: RepoSortKey, dir: 'asc' | 'desc'): RepoStat[] {
  const val = (r: RepoStat): number | string => {
    switch (key) {
      case 'cost': return r.costUSD
      case 'sessions': return r.sessions
      // Every billed counter, so the "tokens" column and the order it sorts in agree. Ranking by
      // the non-cached 4 % put a repository with one huge cached session below a chattier one.
      case 'tokens': return totalTokens(r.tokens)
      case 'commits': return r.gitCommits
      case 'lastActive': return r.lastActive ? new Date(r.lastActive).getTime() : 0
      case 'name': return r.name.toLowerCase()
      case 'linked': return r.linked ? 1 : 0   // desc = linked (with repo) first
    }
  }
  const sorted = [...repos].sort((a, b) => {
    const va = val(a), vb = val(b)
    if (typeof va === 'string' && typeof vb === 'string') return va.localeCompare(vb)
    return (va as number) - (vb as number)
  })
  return dir === 'desc' ? sorted.reverse() : sorted
}

export type LoadProgress = Record<string, StageProgress>

// Persisted snapshot of the last successful /api/data so reopening the app
// (especially as an installed PWA) renders instantly from cache while a fresh
// copy is fetched in the background — no full loading screen on every reopen.
const DATA_CACHE_KEY = 'agentistics-data-cache-v1'

function readDataCache(): AppData | null {
  try {
    const raw = localStorage.getItem(DATA_CACHE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    // VALIDATED, not cast. Seeding from this snapshot also sets `loading: false`, so whatever comes
    // out of here renders immediately with no loader and no server round-trip in between — a
    // payload that merely PARSES used to reach `computeDerivedStats` and throw there, and the error
    // boundary's Reload re-read the same bytes. That is an app bricked for its origin until someone
    // clears site data by hand. See `isUsableDataCache` for how a bad snapshot gets written.
    if (!isUsableDataCache(parsed)) {
      // DROPPED, not repaired: the missing half cannot be invented, and a fabricated `statsCache`
      // is a confident zero on every KPI. Removing it is what makes the next reload recover on its
      // own instead of hitting the same wall.
      clearDataCache()
      return null
    }
    return parsed as AppData
  } catch { return null }
}

function writeDataCache(data: AppData): void {
  // Guarded on the way IN as well as out. A 200 that is not an `AppData` (a proxy page, a captive
  // portal, an ingest-only central) was cached by the same blind cast that read it back, so the
  // next reopen started from a snapshot no server would ever produce again.
  if (!isUsableDataCache(data)) return
  try { localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(data)) } catch { /* quota/disabled — skip */ }
}

/** Forget the persisted snapshot. Exported for the root error boundary: a render crash caused by
 *  the cache cannot be cleared by reloading, because reloading reads the cache. */
export function clearDataCache(): void {
  try { localStorage.removeItem(DATA_CACHE_KEY) } catch { /* disabled — nothing to clear */ }
}

export const LIVE_INTERVAL_OPTIONS = [
  { label: '10s', value: 10 },
  { label: '30s', value: 30 },
  { label: '1m', value: 60 },
  { label: '5m', value: 300 },
]

export const LIVE_INTERVAL_OPTIONS_RISKY = [
  { label: '1s', value: 1 },
  { label: '2s', value: 2 },
  { label: '5s', value: 5 },
]

export function useData() {
  // Seed from the local cache so a reopen paints immediately instead of the
  // loading screen; a background refresh then replaces it with fresh data.
  const [data, setData] = useState<AppData | null>(() => readDataCache())
  const [loading, setLoading] = useState(() => readDataCache() === null)
  const [loadProgress, setLoadProgress] = useState<LoadProgress>({})
  const [error, setError] = useState<string | null>(null)
  const [liveUpdates, setLiveUpdates] = useState(true)
  const [updateInterval, setUpdateInterval] = useState(30)
  const streamRef = useRef<EventSource | null>(null)

  // Silent background refresh — no loading screen, no progress bars
  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/data')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const fresh = (await res.json()) as AppData
      setData(fresh)
      writeDataCache(fresh)
    } catch { /* ignore silent update errors */ }
  }, [])

  const startStreamLoad = useCallback(() => {
    streamRef.current?.close()
    streamRef.current = null

    setLoading(true)
    setError(null)
    setLoadProgress({})

    const es = new EventSource('/api/data-stream')
    streamRef.current = es
    let settled = false

    const complete = async (isError?: string) => {
      if (settled) return
      settled = true
      es.close()
      streamRef.current = null
      try {
        const res = await fetch('/api/data')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const fresh = (await res.json()) as AppData
        setData(fresh)
        writeDataCache(fresh)
        if (isError) setError(null)
      } catch (err) {
        setError(String(err))
      } finally {
        setLoading(false)
      }
    }

    es.addEventListener('progress', (e: Event) => {
      const ev = JSON.parse((e as MessageEvent).data) as { stage: string; progress: number; detail?: string }
      setLoadProgress(prev => ({
        ...prev,
        [ev.stage]: {
          progress: ev.progress,
          detail: ev.detail,
          status: ev.progress >= 1 ? 'done' : 'active',
        },
      }))
    })

    es.addEventListener('done', () => { void complete() })
    es.onerror = () => { void complete('stream error') }
  }, [])

  useEffect(() => {
    // If we painted from cache, refresh quietly (no loading screen). Otherwise
    // run the streamed first load with progress.
    if (readDataCache()) {
      void fetchData()
    } else {
      startStreamLoad()
    }
    return () => { streamRef.current?.close() }
    // Run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Subscribe to server-sent change events so the dashboard updates automatically
  // when Claude writes new session data to ~/.claude/.
  useEffect(() => {
    if (!liveUpdates) return
    const es = new EventSource('/api/events')
    es.addEventListener('change', () => { void fetchData() })
    return () => { es.close() }
  }, [liveUpdates, fetchData])

  // Fallback polling at the selected interval when live updates are enabled.
  useEffect(() => {
    if (!liveUpdates) return
    const id = setInterval(() => { void fetchData() }, updateInterval * 1000)
    return () => { clearInterval(id) }
  }, [liveUpdates, updateInterval, fetchData])

  const refetch = useCallback(() => startStreamLoad(), [startStreamLoad])

  return { data, loading, loadProgress, error, refetch, liveUpdates, setLiveUpdates, updateInterval, setUpdateInterval }
}

/** Start (00:00:00.000) of a Date's UTC calendar day. */
function utcStartOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0))
}
/** End (23:59:59.999) of a Date's UTC calendar day. */
function utcEndOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999))
}
/** Parse a `yyyy-MM-dd` string as a UTC calendar date, never through the browser's local
 *  timezone — `parseISO('2026-07-23')` returns LOCAL midnight, which is a different instant
 *  (and can even be a different UTC calendar day) depending on where the browser sits. */
function utcDateFromDayStr(dayStr: string): Date {
  const [y, m, d] = dayStr.split('-').map(Number)
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1))
}

/**
 * Day boundaries are computed in UTC, matching `sessionDay()` (`@agentistics/core`) — the
 * function that buckets Claude's own `dailyActivity`/`dailyModelTokens` rollup via a plain
 * `.slice(0, 10)` on the ISO `start_time` (always UTC, since that's what the trailing `Z` means).
 * Using the browser's LOCAL day boundary here instead — the previous behavior — made "a day"
 * mean two different 24h windows depending on which screen read it: a date-filtered dashboard KPI
 * (sourced from that UTC-bucketed rollup, see `filteredDailyModelTokens` below) and a Compare-page
 * total for the same nominal day (this function, filtering raw sessions) could disagree by up to a
 * timezone's width of sessions near midnight — enough, since cache tokens dominate the total, to
 * make one screen report billions more or fewer tokens than the other for what a user picked as
 * "the same day". Aligning everything here to UTC is what makes every screen agree.
 */
export function getDateRangeFilter(dateRange: DateRange, customStart?: string, customEnd?: string) {
  const now = utcEndOfDay(new Date())
  if (dateRange === '7d') return { start: utcStartOfDay(subDays(now, 7)), end: now }
  if (dateRange === '30d') return { start: utcStartOfDay(subDays(now, 30)), end: now }
  if (dateRange === '90d') return { start: utcStartOfDay(subDays(now, 90)), end: now }
  // 'all' sem datas customizadas → histórico completo
  if (dateRange === 'all' && !customStart && !customEnd) return { start: new Date(0), end: now }
  // 'all' com datas customizadas (ou qualquer outro caso) → aplica intervalo personalizado
  const start = customStart ? utcStartOfDay(utcDateFromDayStr(customStart)) : new Date(0)
  const end = customEnd ? utcEndOfDay(utcDateFromDayStr(customEnd)) : now
  return { start, end }
}

function inRange(date: Date, start: Date, end: Date) {
  return !isBefore(date, start) && !isAfter(date, end)
}

/** Streak math lives in @agentistics/core so the terminal UI shares this exact implementation.
 *  Re-exported here to keep every existing `from './useData'` import working. */
export { calcStreak } from '@agentistics/core'

/**
 * Calcula o maior streak já atingido no histórico completo de datas ativas.
 */
export function calcLongestStreak(activeDates: Set<string>): number {
  if (activeDates.size === 0) return 0
  const sorted = Array.from(activeDates).sort()
  let longest = 1
  let current = 1
  for (let i = 1; i < sorted.length; i++) {
    const diff = differenceInCalendarDays(parseISO(sorted[i]!), parseISO(sorted[i - 1]!))
    if (diff === 1) {
      current++
      if (current > longest) longest = current
    } else {
      current = 1
    }
  }
  return longest
}

/** Blended cost per token using global model usage proportions */
export function blendedCostPerToken(modelUsage: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>) {
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0
  let weightedInput = 0, weightedOutput = 0, weightedCacheRead = 0, weightedCacheWrite = 0

  for (const [modelId, u] of Object.entries(modelUsage)) {
    const price = getModelPrice(modelId)
    totalInput += u.inputTokens
    totalOutput += u.outputTokens
    totalCacheRead += u.cacheReadInputTokens
    totalCacheWrite += u.cacheCreationInputTokens
    weightedInput += u.inputTokens * price.input
    weightedOutput += u.outputTokens * price.output
    weightedCacheRead += u.cacheReadInputTokens * price.cacheRead
    weightedCacheWrite += u.cacheCreationInputTokens * price.cacheWrite
  }

  return {
    input: totalInput > 0 ? weightedInput / totalInput : 3,
    output: totalOutput > 0 ? weightedOutput / totalOutput : 15,
    cacheRead: totalCacheRead > 0 ? weightedCacheRead / totalCacheRead : 0.3,
    cacheWrite: totalCacheWrite > 0 ? weightedCacheWrite / totalCacheWrite : 3.75,
  }
}

export type BlendedRates = ReturnType<typeof blendedCostPerToken>

/**
 * Cost of one session at blended rates — the fallback for a session that names no model.
 *
 * Each counter at ITS OWN rate. Two call sites (the session drawer and the PDF's per-session
 * column) wrote this by hand over `input` and `output` only, so a session with no model was priced
 * on the 4 % of its volume that is not cache. Pricing the cache as fresh input would be the
 * opposite error — about tenfold too high — which is why the four rates exist separately.
 */
export function blendedSessionCost(s: Parameters<typeof sessionTokens>[0], rates: BlendedRates): number {
  const b = sessionTokens(s)
  return (b.input / 1_000_000) * rates.input
    + (b.output / 1_000_000) * rates.output
    + (b.cacheRead / 1_000_000) * rates.cacheRead
    + (b.cacheWrite / 1_000_000) * rates.cacheWrite
}

export function filterByHarness<T extends { harness?: HarnessId }>(sessions: T[], harness?: HarnessId): T[] {
  if (!harness) return sessions
  return sessions.filter(s => (s.harness ?? 'claude') === harness)
}

export interface HarnessSummary {
  sessions: number
  messages: number
  /**
   * The two conversational counters, kept because several surfaces legitimately want THEM — an
   * "Input" card and an "Output" card, each saying what it is.
   *
   * They are NOT the total, and anything printing the word "tokens" must read `tokens` below. On a
   * real machine these two are 0,34 % of the volume, so a headline built from them under-reports by
   * about 300× — which is exactly what the Compare page, the tag cards, the repository list and the
   * header counter were all doing.
   */
  inputTokens: number
  outputTokens: number
  /** All four billed counters. THE token figure — see `tokens.ts` in @agentistics/core. */
  tokens: TokenBreakdown
  costUSD: number
  hourCounts: number[]       // length 24, index = hour-of-day (0-23)
  peakHour: number | null    // hour with max count, null if all zero
  dowCounts: number[]        // length 7, index 0=Sunday..6=Saturday
  peakDow: number | null     // index of max dowCounts, null if all zero
  dailyActivity: { date: string; sessions: number }[]  // sorted ascending
  peakTokenDay: { date: string; tokens: number } | null  // null if no token data
  peakSessionCost: number | null  // null if no cost data / claude
  /** Per-model token + cost breakdown, sorted by costUSD desc. Empty when no model data. */
  models: { model: string; inputTokens: number; outputTokens: number; tokens: TokenBreakdown; costUSD: number }[]
  /**
   * Blended cost per 1M tokens, over ALL FOUR counters.
   *
   * It was over `input + output`, which is a rate per million of the 4 % of the volume that is not
   * cache — so a heavily cached harness (every long agentic session) reported a cost per million
   * tens of times higher than it charges, and the Compare page ranked harnesses by how much they
   * cache rather than by what they cost. `null` when tokens are 0 or the harness has no cost.
   */
  costPerMTokens: number | null
}

function peakIndex(arr: number[]): number | null {
  let maxVal = 0
  let maxIdx: number | null = null
  for (let i = 0; i < arr.length; i++) {
    if ((arr[i] ?? 0) > maxVal) {
      maxVal = arr[i]!
      maxIdx = i
    }
  }
  return maxIdx
}

/**
 * Summarize a set of sessions for ONE harness, purely from per-session data
 * (no statsCache). Filters `sessions` to the given harness internally (a missing
 * harness field counts as 'claude'). Used for non-Claude harnesses inside
 * computeHarnessSummaries, and for ALL harnesses on the Compare page when a
 * user/harness/date filter is active — statsCache has no per-user/-harness
 * granularity, so the filtered view must come from per-session sums. Pure.
 */
export function summarizeHarnessSessions(sessions: SessionMeta[], harness: HarnessId): HarnessSummary {
  return summarizeSessions(
    sessions.filter(s => (s.harness ?? 'claude') === harness),
    HARNESS_CAPABILITIES[harness].cost,
    HARNESS_CAPABILITIES[harness].tokens,
  )
}

/**
 * Core summarizer over an ALREADY-scoped session list (no harness filter). `hasCost`/`hasTokens`
 * gate cost/token-derived fields. Used by summarizeHarnessSessions (per harness) and by
 * computeMemberSummaries (per member, across all harnesses → both capabilities on). Pure.
 */
export function summarizeSessions(list: SessionMeta[], hasCost: boolean, hasTokens: boolean): HarnessSummary {
  const sessionCount = list.length
  let messages = 0
  let inputTokens = 0
  let outputTokens = 0
  let tokens: TokenBreakdown = EMPTY_TOKENS
  let costUSD = 0

  const hourCounts = Array.from({ length: 24 }, () => 0)
  const dowCounts = Array.from({ length: 7 }, () => 0)
  const dailyMap: Record<string, number> = {}
  const tokensByDay: Record<string, number> = {}
  let peakSessionCost: number | null = null
  // Per-model token accumulation; cost computed via calcCost after the loop.
  const modelMap: Record<string, import('@agentistics/core').ModelUsage> = {}

  for (const s of list) {
    messages += (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0)
    inputTokens += s.input_tokens ?? 0
    outputTokens += s.output_tokens ?? 0
    tokens = addTokens(tokens, sessionTokens(s))

    // hour-of-day
    for (const h of s.message_hours ?? []) {
      if (h >= 0 && h <= 23) hourCounts[h] = (hourCounts[h] ?? 0) + 1
    }

    // day-of-week + daily activity
    if (isDateStr(s.start_time)) {
      const dow = getDay(parseISO(s.start_time))
      dowCounts[dow] = (dowCounts[dow] ?? 0) + 1
      const day = format(parseISO(s.start_time), 'yyyy-MM-dd')
      dailyMap[day] = (dailyMap[day] ?? 0) + 1

      if (hasTokens) {
        tokensByDay[day] = (tokensByDay[day] ?? 0) + sessionTokenTotal(s)
      }
    }

    // per-model token accumulation — skip sessions with no/empty model (cannot be priced).
    // `sessionModelUsage` yields the per-model split for multi-model sessions (an Antigravity
    // parent with its subagent children folded in) and a single entry for everything else.
    const perModel = sessionModelUsage(s)
    if (hasTokens) {
      for (const [key, u] of perModel) {
        const entry = modelMap[key] ?? (modelMap[key] = {
          inputTokens: 0, outputTokens: 0,
          cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
          webSearchRequests: 0, costUSD: 0,
        })
        entry.inputTokens += u.inputTokens
        entry.outputTokens += u.outputTokens
        entry.cacheReadInputTokens += u.cacheReadInputTokens
        entry.cacheCreationInputTokens += u.cacheCreationInputTokens
      }
    }

    // cost — priced per model, so a session spanning several models stays exact
    if (hasCost && perModel.length > 0) {
      const sessionCost = perModel.reduce((sum, [model, u]) => sum + calcCost(u, model), 0)
      costUSD += sessionCost
      if (peakSessionCost === null || sessionCost > peakSessionCost) {
        peakSessionCost = sessionCost
      }
    }
  }

  // daily activity sorted asc
  const dailyActivity = Object.entries(dailyMap)
    .map(([date, sessions]) => ({ date, sessions }))
    .sort((a, b) => a.date.localeCompare(b.date))

  // peak token day (only set when there is actual token data > 0)
  let peakTokenDay: { date: string; tokens: number } | null = null
  if (hasTokens) {
    for (const [date, tokens] of Object.entries(tokensByDay)) {
      if (tokens > 0 && (!peakTokenDay || tokens > peakTokenDay.tokens)) {
        peakTokenDay = { date, tokens }
      }
    }
  }

  // per-model breakdown — cost via calcCost (never inline).
  // modelMap only contains sessions that had a real model, so every entry is priceable.
  const models = Object.entries(modelMap)
    .map(([model, u]) => ({
      model,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      tokens: usageTokens(u),
      costUSD: hasCost ? calcCost(u, model) : 0,
    }))
    .sort((a, b) => b.costUSD - a.costUSD)

  // Blended cost per 1M tokens over EVERY billed counter — see `costPerMTokens` on the interface.
  const tokensM = totalTokens(tokens) / 1e6
  const costPerMTokens = hasCost && tokensM > 0 ? costUSD / tokensM : null

  return {
    sessions: sessionCount,
    messages,
    inputTokens,
    outputTokens,
    tokens,
    costUSD,
    hourCounts,
    peakHour: peakIndex(hourCounts),
    dowCounts,
    peakDow: peakIndex(dowCounts),
    dailyActivity,
    peakTokenDay,
    peakSessionCost: hasCost ? peakSessionCost : null,
    models,
    costPerMTokens,
  }
}

export interface MemberSummary { user: string; summary: HarnessSummary }

/**
 * Group a session list by `user` and summarize each member (across all harnesses), sorted by
 * cost desc. Drives the repo-detail "Compare" tab (member-vs-member), mirroring how
 * computeHarnessSummaries drives the /compare page (harness-vs-harness). Pure.
 */
export function computeMemberSummaries(sessions: SessionMeta[]): MemberSummary[] {
  const byUser = new Map<string, SessionMeta[]>()
  for (const s of sessions) {
    if (!s.user) continue
    const arr = byUser.get(s.user) ?? []
    arr.push(s)
    byUser.set(s.user, arr)
  }
  return [...byUser.entries()]
    .map(([user, list]) => ({ user, summary: summarizeSessions(list, true, true) }))
    .sort((a, b) => b.summary.costUSD - a.summary.costUSD)
}

/**
 * Compute per-harness summary totals — pure function, no hooks.
 *
 * For 'claude': sessions = statsCache.dailyActivity sum + gap days (days with Claude
 * sessions in data.sessions whose date is NOT already covered by statsCache.dailyActivity).
 * This mirrors the `allTimeTotalSessions` claude branch in useDerivedStats exactly so the
 * Compare page always matches the main dashboard SESSIONS KPI.
 *
 * For non-claude harnesses: pure per-session sums (statsCache has no data for them).
 *
 * Only harnesses present in data.harnesses are included in the output.
 */
/**
 * Compute the Claude HarnessSummary from a given statsCache + the session list used to
 * fill gap days. Extracted so both computeHarnessSummaries (canonical, data.statsCache)
 * and the Compare page (user-scoped merge of data.userStatsCaches) share ONE code path,
 * guaranteeing the Compare Claude column matches the dashboard exactly.
 *
 * `sc` is the authoritative aggregated Claude history (survives Claude's 30-day cleanup).
 * `gapSessions` supplies days with Claude sessions not yet covered by sc.dailyActivity;
 * pass the user-scoped session slice so gap days respect the selected members.
 */
export function claudeSummaryFromStatsCache(
  sc: import('@agentistics/core').StatsCache,
  gapSessions: import('@agentistics/core').SessionMeta[],
): HarnessSummary {
  const allDailyDates = new Set((sc.dailyActivity ?? []).map(d => d.date))
  const claudeBase = (sc.dailyActivity ?? []).reduce((s, d) => s + d.sessionCount, 0)
  const messageBase = (sc.dailyActivity ?? []).reduce((s, d) => s + d.messageCount, 0)

  // Gap days: Claude sessions whose date is NOT in sc.dailyActivity
  let claudeGapSessions = 0
  let claudeGapMessages = 0
  for (const s of gapSessions) {
    if ((s.harness ?? 'claude') !== 'claude') continue
    if (!isDateStr(s.start_time)) continue
    const day = format(parseISO(s.start_time), 'yyyy-MM-dd')
    if (!allDailyDates.has(day)) {
      claudeGapSessions += 1
      claudeGapMessages += (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0)
    }
  }

  // Tokens and cost from sc.modelUsage (all-time Claude totals)
  const modelUsage = sc.modelUsage ?? {}
  const inputTokens = Object.values(modelUsage).reduce((s, u) => s + (u.inputTokens ?? 0), 0)
  const outputTokens = Object.values(modelUsage).reduce((s, u) => s + (u.outputTokens ?? 0), 0)
  // All four counters, so Claude's side of the Compare page is the same measurement as everyone
  // else's. The cache lives in `modelUsage` and was simply never read here.
  const tokens = sumTokens(Object.values(modelUsage).map(usageTokens))
  const costUSD = Object.entries(modelUsage).reduce((s, [modelId, u]) => s + calcCost(u, modelId), 0)

  // Claude: per-model breakdown from sc.modelUsage
  // Skip entries with empty or 'unknown' model keys — they cannot be priced.
  const claudeModels = Object.entries(modelUsage)
    .filter(([model]) => model && model !== 'unknown')
    .map(([model, u]) => ({
      model,
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      tokens: usageTokens(u),
      costUSD: calcCost(u, model),
    }))
    .sort((a, b) => b.costUSD - a.costUSD)

  // Claude: blended cost per 1M tokens over EVERY billed counter — see the interface.
  const claudeTokensM = totalTokens(tokens) / 1e6
  const claudeCostPerMTokens = claudeTokensM > 0 ? costUSD / claudeTokensM : null

  // Claude: hour-of-day from sc.hourCounts
  const claudeHourCounts = Array.from({ length: 24 }, (_, i) => sc.hourCounts?.[String(i)] ?? 0)

  // Claude: dow from sc.dailyActivity
  const claudeDowCounts = Array.from({ length: 7 }, () => 0)
  for (const d of sc.dailyActivity ?? []) {
    if (!isDateStr(d.date)) continue
    const dow = getDay(parseISO(d.date))
    claudeDowCounts[dow] = (claudeDowCounts[dow] ?? 0) + d.sessionCount
  }

  // Claude: daily activity for sparkline
  const claudeDailyActivity = (sc.dailyActivity ?? [])
    .filter(d => isDateStr(d.date))
    .map(d => ({ date: d.date, sessions: d.sessionCount }))
    .sort((a, b) => a.date.localeCompare(b.date))

  // Claude: peak token day from sc.dailyModelTokens
  let claudePeakTokenDay: { date: string; tokens: number } | null = null
  for (const d of sc.dailyModelTokens ?? []) {
    const tokens = Object.values(d.tokensByModel).reduce((s, t) => s + t, 0)
    if (!claudePeakTokenDay || tokens > claudePeakTokenDay.tokens) {
      claudePeakTokenDay = { date: d.date, tokens }
    }
  }

  return {
    sessions: claudeBase + claudeGapSessions,
    messages: messageBase + claudeGapMessages,
    inputTokens,
    outputTokens,
    tokens,
    costUSD,
    hourCounts: claudeHourCounts,
    peakHour: peakIndex(claudeHourCounts),
    dowCounts: claudeDowCounts,
    peakDow: peakIndex(claudeDowCounts),
    dailyActivity: claudeDailyActivity,
    peakTokenDay: claudePeakTokenDay,
    peakSessionCost: null,  // statsCache has no per-session cost breakdown
    models: claudeModels,
    costPerMTokens: claudeCostPerMTokens,
  }
}

export function computeHarnessSummaries(
  data: import('@agentistics/core').AppData,
): Record<HarnessId, HarnessSummary> {
  const result = {} as Record<HarnessId, HarnessSummary>

  for (const harness of data.harnesses) {
    if (harness === 'claude') {
      result['claude'] = claudeSummaryFromStatsCache(data.statsCache, data.sessions)
    } else {
      result[harness] = summarizeHarnessSessions(data.sessions, harness)
    }
  }

  return result
}

/** Most recent activity timestamp for one harness in a session list (end_time, else start_time). */
export function lastActiveFor(sessions: { harness?: HarnessId; start_time?: string; end_time?: string }[], harness: HarnessId): string | null {
  return sessions
    .filter(s => (s.harness ?? 'claude') === harness)
    .reduce<string | null>((best, s) => {
      const ts = s.end_time ?? s.start_time
      return ts && (!best || ts > best) ? ts : best
    }, null)
}

export interface FilteredHarnessSummaries {
  activeHarnesses: HarnessId[]
  summaries: Record<HarnessId, HarnessSummary>
  lastActive: Record<HarnessId, string | null>
}

/**
 * Compute per-harness comparison summaries scoped by the GLOBAL filters (users, harnesses,
 * date, projects, models) — same semantics as the main dashboard / Compare page. With NO
 * filter active this returns the statsCache-canonical Claude totals (computeHarnessSummaries)
 * so the default view matches the dashboard's all-time KPIs; the moment any filter narrows the
 * scope, every harness (incl. Claude) is summarized from the filtered per-session slice, since
 * statsCache has no per-user/-harness/-date/-project granularity. Pure — shared by ComparePage
 * and the PDF Export page's Compare section so both always agree.
 */
export function computeFilteredHarnessSummaries(data: AppData, filters: Filters): FilteredHarnessSummaries {
  const usersSel = filters.users ?? []
  const harnessSel = filters.harnesses ?? []
  const projects = filters.projects ?? []
  const projectSet = new Set(projects)
  const modelSet = filters.models && filters.models.length > 0 ? new Set(filters.models) : null
  const { start, end } = getDateRangeFilter(filters.dateRange, filters.customStart, filters.customEnd)

  // Team data present (a central) → always aggregate per-session: statsCache only
  // represents the central machine's own Claude, never the members'.
  const teamData = data.sessions.some(s => s.user)
  const teamsSel = filters.teams ?? []
  const machinesSel = filters.machines ?? []
  const anyFilter =
    teamData ||
    usersSel.length > 0 || harnessSel.length > 0 || teamsSel.length > 0 || machinesSel.length > 0 || projects.length > 0 ||
    modelSet !== null || filters.dateRange !== 'all' || !!filters.customStart || !!filters.customEnd

  // Columns: the explicitly selected harnesses, else the harnesses the selected users used
  // (so picking a member narrows the columns), else every harness in the data.
  const order: HarnessId[] = HARNESS_ORDER
  const userScoped = filterByUsers(data.sessions, usersSel)
  const scopedHarnesses = distinctHarnesses(userScoped)
  const cols: HarnessId[] = harnessSel.length > 0
    ? order.filter(h => harnessSel.includes(h))
    : (scopedHarnesses.length > 0 ? scopedHarnesses : data.harnesses)

  if (!anyFilter) {
    const sums = computeHarnessSummaries(data)
    const la = {} as Record<HarnessId, string | null>
    for (const h of cols) la[h] = lastActiveFor(data.sessions, h)
    return { activeHarnesses: cols, summaries: sums, lastActive: la }
  }

  // Filtered per-session view — every harness (incl. Claude) summarized from sessions,
  // since statsCache has no per-user/-harness/-date/-team/-machine granularity.
  const filtered = filterByHarnesses(
    filterByMachines(
      filterByTeams(userScoped, teamsSel),
      machinesSel
    ),
    harnessSel
  ).filter(s => {
    if (!isDateStr(s.start_time)) return false
    const d = parseISO(s.start_time)
    if (d < start || d > end) return false
    if (projects.length > 0 && !projectSet.has(s.project_path)) return false
    if (modelSet && (!s.model || !modelSet.has(s.model))) return false
    return true
  })

  // Claude canonical source: on a central the deep Claude history lives only in
  // data.userStatsCaches (aggregated, never as individual sessions). Merge the selected
  // members' caches (or ALL when no member filter) so the Claude column matches the
  // dashboard exactly — same rule as useDerivedStats' effectiveStatsCache. Only usable
  // when NO slice filter is active (statsCache has no project/model/date granularity);
  // otherwise fall back to the per-session sum.
  const usc = data.userStatsCaches
  const hasUserStats = !!usc && Object.keys(usc).length > 0
  // Same machine/team resolution as useDerivedStats — the two must agree or the Compare page
  // contradicts the dashboard for the exact same selection.
  const machineScope = resolveMachineCacheScope({
    machineOwners: data.machineOwners,
    machineStatsCaches: data.machineStatsCaches,
    users: usersSel, teams: teamsSel, machines: machinesSel,
  })
  const machineCacheScoped = machineScope !== null
  const sliceActive =
    projects.length > 0 || modelSet !== null ||
    filters.dateRange !== 'all' || !!filters.customStart || !!filters.customEnd ||
    ((teamsSel.length > 0 || machinesSel.length > 0) && !machineCacheScoped)
  // Same "empty pool is not an authoritative zero" rule as useDerivedStats — a selected member
  // whose cache this viewer never received must fall back to the per-session sum, not merge to an
  // empty cache. The two must agree or Compare contradicts the dashboard for the same selection.
  const resolvedUserCaches = (usersSel.length > 0 ? usersSel : Object.keys(usc ?? {}))
    .map(u => usc![u])
    .filter((c): c is NonNullable<typeof c> => !!c)
  const userCacheUsable = hasUserStats && resolvedUserCaches.length > 0
  const claudeStatsCache = machineCacheScoped
    ? mergeStatsCaches(machineScope.map(id => data.machineStatsCaches![id]!))
    : userCacheUsable
      ? mergeStatsCaches(resolvedUserCaches)
      : data.statsCache
  const claudeFromStatsCache = (userCacheUsable || machineCacheScoped) && !sliceActive

  const sums = {} as Record<HarnessId, HarnessSummary>
  const la = {} as Record<HarnessId, string | null>
  for (const h of cols) {
    // Gap-fill from the FULLY scoped slice, not just the user-scoped one: `claudeFromStatsCache`
    // implies no date/project/model slice, so `filtered` differs from `userScoped` only by the
    // team/machine/harness scoping the cache above was already narrowed to.
    sums[h] = h === 'claude' && claudeFromStatsCache
      ? claudeSummaryFromStatsCache(claudeStatsCache, filtered)
      : summarizeHarnessSessions(filtered, h)
    la[h] = lastActiveFor(filtered, h)
  }
  return { activeHarnesses: cols, summaries: sums, lastActive: la }
}

/**
 * @param tags Tag definitions (as returned by `GET /api/tags`) backing the `tags` filter
 *   dimension. Optional: without them a `filters.tags` selection is inert rather than blanking
 *   the dashboard. Note the tag filter can only NARROW what the viewer already sees — /api/data
 *   is team-scoped, so a grantee may see smaller numbers here than on the tag's own card.
 */
/**
 * Picks the "longest session" — by ACTIVE time (work actually done), never wall clock.
 *
 * Wall clock crowns whichever session merely stayed OPEN longest: a session reopened across three
 * weeks reports ~958h and maybe 3h of real work. Sessions whose transcript Claude already deleted
 * carry no `active_minutes` and can never have one computed, so they are excluded from the
 * ranking rather than winning it on a number that means something else.
 *
 * Falls back to wall clock only when NO session in the set has active time — otherwise the card
 * would go blank for a set made entirely of old, already-cleaned-up sessions.
 *
 * `unmeasured` = how many sessions were excluded, so the UI can disclose it instead of pretending
 * the set was fully measured.
 */
export function pickLongestSession(sessions: SessionMeta[]): {
  session: SessionMeta | null
  unmeasured: number
} {
  const withActive = sessions.filter(s => s.active_minutes !== undefined)
  const useActive = withActive.length > 0
  const pool = useActive ? withActive : sessions
  const rank = useActive
    ? (s: SessionMeta) => s.active_minutes ?? 0
    : (s: SessionMeta) => s.duration_minutes ?? 0
  const session = pool.reduce<SessionMeta | null>(
    (best, s) => (!best || rank(s) > rank(best) ? s : best), null)
  return { session, unmeasured: useActive ? sessions.length - withActive.length : 0 }
}


export interface RepoGitTotals {
  commits: number
  linesAdded: number
  linesRemoved: number
  filesModified: number
}

/**
 * PURE: what happened IN THE REPOSITORY over the scope, or `undefined` when that cannot be said.
 *
 * This is a `git log`, so it also counts commits made by hand, by a teammate on the same checkout
 * and by CI. It is therefore NOT a fact about any assistant, and it is deliberately kept apart from
 * the per-session totals rather than being swapped in for them: those two used to be one number
 * that switched source depending on whether a project filter was active, so the same card meant
 * different things from one click to the next, and repository work was credited to an assistant.
 *
 * `undefined` when a harness filter is active — the figure cannot be attributed to one harness, and
 * showing it beside a harness's name reads as if it belonged to it — and when no project in scope
 * has git stats at all. The UI omits the line in that case; it never renders a zero, the same
 * N/A-versus-a-confident-0 rule `HARNESS_CAPABILITIES` applies to metrics.
 */
export function repositoryGitTotals(
  allProjects: { path: string; git_stats?: { commits: number; lines_added: number; lines_removed: number; files_modified: number } }[],
  /** The paths in scope, or `null` for "every project". */
  scopedPaths: string[] | null,
  harnessFiltered: boolean,
): RepoGitTotals | undefined {
  if (harnessFiltered) return undefined
  const scoped = scopedPaths === null
    ? allProjects.map(p => p.git_stats)
    : scopedPaths.map(path => allProjects.find(p => p.path === path)?.git_stats)
  const matched = scoped.filter((gs): gs is NonNullable<typeof gs> => gs !== undefined)
  if (matched.length === 0) return undefined
  return matched.reduce<RepoGitTotals>(
    (acc, gs) => ({
      commits: acc.commits + gs.commits,
      linesAdded: acc.linesAdded + gs.lines_added,
      linesRemoved: acc.linesRemoved + gs.lines_removed,
      filesModified: acc.filesModified + gs.files_modified,
    }),
    { commits: 0, linesAdded: 0, linesRemoved: 0, filesModified: 0 },
  )
}


/**
 * The presence scope every scoped aggregate (header totals, per-member/-machine cache totals)
 * must agree on. An explicit `filters.presence` always wins; otherwise a central whose operator
 * turned OFF `includeOfflineData` narrows to online members by DEFAULT — a policy decision, not
 * something the viewer asked for on this screen.
 *
 * `isPolicyDefault` is what lets a consumer decide whether the narrowing needs a label: a viewer
 * who explicitly picked the "Offline" pill already knows their total is scoped, but nobody chose
 * the silent default, and CLAUDE.md's own rule is that an unexplained smaller total reads as a
 * bug. Any surface that reads a presence-scoped aggregate (a statsCache merge, a per-row cache
 * substitution) must resolve scope through THIS function — a second inline copy is exactly how
 * the header and the Members drill-down disagreed: the header excluded an offline machine's
 * history from its total while the machine's own row kept substituting that history whole,
 * unfiltered, with nothing on screen explaining why one dwarfed the other.
 */
export interface PresenceScope {
  /** The presence actually being enforced, or null when nothing narrows the scope. */
  effective: 'online' | 'offline' | null
  /** True when `effective` came from the central's policy default rather than an explicit
   *  `filters.presence` choice. */
  isPolicyDefault: boolean
  /** Display names ("user") allowed under `effective`, or null when there is no scoping. */
  allowedUsers: Set<string> | null
}

export function resolvePresenceScope(
  data: Pick<AppData, 'presence' | 'includeOfflineData'> | null | undefined,
  filters: Filters,
): PresenceScope {
  const presence = data?.presence
  const effective: 'online' | 'offline' | null =
    filters.presence ?? (presence && data?.includeOfflineData === false ? 'online' : null)
  const isPolicyDefault = effective !== null && filters.presence == null
  const allowedUsers: Set<string> | null =
    effective && presence
      ? new Set(
          Object.entries(presence)
            .filter(([, p]) => (effective === 'online' ? p.online : !p.online))
            .map(([name]) => name),
        )
      : null
  return { effective, isPolicyDefault, allowedUsers }
}

/**
 * The whole derivation, as a PURE function of (data, filters, tags).
 *
 * Extracted from the hook so it can be called N TIMES for N scopes — the compare page derives one
 * per side and the count is dynamic, which the rules of hooks forbid a hook from doing. It also
 * makes the derivation directly testable without mounting anything.
 *
 * It reads nothing but its arguments; `useDerivedStats` below is the memoized single-scope wrapper
 * every page uses.
 */
export function computeDerivedStats(
  data: AppData | null,
  filters: Filters,
  tags: TagDef[] = [],
  /**
   * The fleet's own "only what is running" switch, and — when it is on — the exact conversations
   * it is running right now. Not part of `Filters` (see `fleetFilter.ts`'s header): it is a
   * statement about what a session is DOING, which no stored metric has.
   *
   * `runningIds` is required whenever `activeOnly` is true rather than defaulted to "everything
   * running" — a caller that cannot read the fleet must not silently report the unfiltered totals
   * under a switch that claims to have narrowed them.
   */
  activeOnly = false,
  runningIds: ReadonlySet<string> = new Set(),
) {
  {
    if (!data) return null

    const { start, end } = getDateRangeFilter(filters.dateRange, filters.customStart, filters.customEnd)
    const projects = filters.projects ?? []
    const projectFiltered = projects.length > 0
    const projectSet = new Set(projects)
    // Repository (git-remote) filter. An empty-string entry targets the "no linked repo" bucket,
    // so a session's key is `git_remote || ''`. Treated like a project filter for aggregation
    // (session-scoped cost/token breakdown) below.
    const repos = filters.repos ?? []
    const repoFiltered = repos.length > 0
    const repoSet = new Set(repos)
    // Tag filter — a session is kept when it matches ANY source of ANY selected tag, mirroring
    // the server rule (see lib/tagMatch.ts). null = inert (nothing selected / unknown tag ids).
    const tagMatches = makeTagFilter(filters.tags ?? [], tags)
    const tagFiltered = tagMatches !== null
    const users = filters.users ?? []
    const userFiltered = users.length > 0
    // Central-only dimensions (C3). statsCache has no team/machine granularity either, so they
    // narrow the scope exactly as project/repo/tag do.
    const teamsFiltered = (filters.teams ?? []).length > 0
    const machinesFiltered = (filters.machines ?? []).length > 0
    const modelSet = filters.models && filters.models.length > 0 ? new Set(filters.models) : null

    // Presence scope — team/central: restrict to online/offline members. Resolved through the
    // single shared `resolvePresenceScope` so every scoped aggregate (this function's totals, the
    // Members page's per-row cache substitution) agrees on the same scope — see its docstring.
    const presenceScope = resolvePresenceScope(data, filters)
    const effectivePresence = presenceScope.effective
    const presenceAllowedUsers = presenceScope.allowedUsers

    // Harness filter — applied first so all downstream filters compose on top
    // Compose (all AND predicates): presence scope → legacy single-harness field (now always
    // unset) → user filter → multi-select harnesses filter (the sole harness selection mechanism).
    const presenceScoped = presenceAllowedUsers
      ? data.sessions.filter(s => !!s.user && presenceAllowedUsers.has(s.user))
      : data.sessions
    const harnessSessions = filterByHarnesses(
      filterByMachines(
        filterByTeams(
          filterByUsers(filterByHarness(presenceScoped, filters.harness), users),
          filters.teams ?? []
        ),
        filters.machines ?? []
      ),
      filters.harnesses ?? [],
    )
    // Harness selection comes solely from the multi-select filter (filters.harnesses).
    // harnessActive: any harness chosen. nonClaudeHarness: a selection that excludes Claude
    // (statsCache is Claude-only, so those views must aggregate purely from per-session data).
    const harnessSel = filters.harnesses ?? []
    const harnessActive = harnessSel.length > 0
    const nonClaudeHarness = harnessActive && !harnessSel.includes('claude')

    // Effective statsCache — the deep aggregated Claude history for the SELECTED scope
    // On a central, each member pushes its own statsCache (data.userStatsCaches). We merge the
    // selected members' caches (or ALL of them when no user filter) so the totals match each
    // machine exactly — the deep history only exists aggregated, never as individual sessions.
    // Solo (no userStatsCaches) → the machine's own statsCache, unchanged.
    const userStatsCaches = data.userStatsCaches
    const hasUserStats = !!userStatsCaches && Object.keys(userStatsCaches).length > 0
    const statsCachePool = (users.length > 0 ? users : Object.keys(userStatsCaches ?? {}))
      .filter(u => !presenceAllowedUsers || presenceAllowedUsers.has(u))
    // Machine/team selection: `userStatsCaches` groups (and sums) a member's machines under one
    // display name, so it cannot answer "these two machines". `machineStatsCaches` is the same
    // history un-grouped — merging the machines in scope gives the machine/team filter the exact
    // deep history the member filter already gets. `null` = not resolvable → previous behaviour.
    const machineScope = resolveMachineCacheScope({
      machineOwners: data.machineOwners,
      machineStatsCaches: data.machineStatsCaches,
      users, teams: filters.teams ?? [], machines: filters.machines ?? [],
      allowedUsers: presenceAllowedUsers,
    })
    const machineCacheScoped = machineScope !== null
    // The selected members' caches that actually resolved. A selection can name a member whose
    // cache this viewer never received — a scoped principal (a manager) gets `userStatsCaches`
    // pruned to the members they may see — and merging an EMPTY list yields an empty cache that
    // every KPI then reports as a confident 0. An unusable pool must fall back to the per-session
    // sum (`cacheBlindScope` below), never stand in as an authoritative zero.
    const resolvedUserCaches = statsCachePool
      .map(u => userStatsCaches![u])
      .filter((c): c is NonNullable<typeof c> => !!c)
    const userCacheUsable = hasUserStats && resolvedUserCaches.length > 0
    const effectiveStatsCache = machineCacheScoped
      ? mergeStatsCaches(machineScope.map(id => data.machineStatsCaches![id]!))
      : userCacheUsable
        ? mergeStatsCaches(resolvedUserCaches)
        : data.statsCache

    // Filter daily activity (date-range only — no project granularity in statsCache)
    const filteredDailyActivity = (effectiveStatsCache.dailyActivity ?? []).filter(d =>
      isDateStr(d.date) && inRange(parseISO(d.date), start, end)
    )
    const filteredDailyModelTokens = (effectiveStatsCache.dailyModelTokens ?? []).filter(d =>
      isDateStr(d.date) && inRange(parseISO(d.date), start, end)
    )

    // Shared date predicate — reused for filteredSessions and nonClaudeInRange
    const inDateRange = (s: { start_time?: string }) =>
      isDateStr(s.start_time) && inRange(parseISO(s.start_time), start, end)

    // Filter sessions (date + projects + model + active-only)
    const filteredSessions = harnessSessions.filter(s => {
      if (!inDateRange(s)) return false
      if (projectFiltered && !projectSet.has(s.project_path)) return false
      if (repoFiltered && !repoSet.has(s.git_remote || '')) return false
      if (tagMatches && !tagMatches(s)) return false
      if (modelSet && (!s.model || !modelSet.has(s.model))) return false
      if (activeOnly && !runningIds.has(s.session_id)) return false
      return true
    })

    // Non-Claude sessions in the active date range — used to supplement statsCache totals
    // in the unified view (no harness filter). When a harness filter is active OR there are
    // no non-Claude sessions, this is always empty so all addenda contribute +0.
    const nonClaudeInRange = !harnessActive
      ? harnessSessions.filter(s => (s.harness ?? 'claude') !== 'claude' && inDateRange(s))
      : []

    // Extend dailyActivity with sessions on days not yet in statsCache
    // statsCache can be stale (lastComputedDate < today); sessions from JSONL cover the gap.
    // Only applies when NOT project-filtered (project filter already uses filteredSessions directly).
    const dailyActivityDates = new Set(filteredDailyActivity.map(d => d.date))
    const supplementByDay: Record<string, { messageCount: number; sessionCount: number; toolCallCount: number }> = {}
    for (const s of filteredSessions) {
      if (!isDateStr(s.start_time)) continue
      const day = format(parseISO(s.start_time), 'yyyy-MM-dd')
      if (dailyActivityDates.has(day)) continue // already covered by statsCache
      if (!supplementByDay[day]) supplementByDay[day] = { messageCount: 0, sessionCount: 0, toolCallCount: 0 }
      supplementByDay[day].messageCount += (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0)
      supplementByDay[day].sessionCount += 1
      supplementByDay[day].toolCallCount += Object.values(s.tool_counts ?? {}).reduce((a, b) => a + b, 0)
    }
    const extendedDailyActivity = [
      ...filteredDailyActivity,
      ...Object.entries(supplementByDay).map(([date, v]) => ({ date, ...v })),
    ]

    // All-time total sessions (no date/project filter) — used by the header
    // statsCache.dailyActivity is CLAUDE-ONLY. So:
    // - non-Claude harness selected → pure per-session count of that harness
    // - Claude harness selected → Claude statsCache history + Claude sessions on gap days
    // - unified (no harness filter) → Claude history+gap PLUS all non-Claude sessions
    // Narrowed along a dimension `stats-cache.json` cannot represent (it has no project/repo/tag/
    // model/user granularity). Every all-time number must then come from sessions, otherwise a
    // filtered view reports the whole global Claude history as if it were the filtered scope.
    // Annotated `boolean` on purpose: without it TypeScript treats this const as an aliased
    // condition and narrows `modelSet` to null inside every `else` branch below, breaking the
    // guards there. The annotation keeps the flag a plain boolean.
    // Team/machine are only cache-blind when the per-machine caches cannot serve the selection
    // (`machineCacheScoped` false) — otherwise `effectiveStatsCache` above already IS that scope's
    // deep history, and forcing the per-session sum here is what made the same scope report a
    // fraction of what the member filter reports.
    const cacheBlindScope: boolean = projectFiltered || repoFiltered || tagFiltered || modelSet !== null
      || ((teamsFiltered || machinesFiltered) && !machineCacheScoped)
      // `!userCacheUsable`, not `!hasUserStats`: a central HAS member caches, but the selected
      // member's cache may be missing from this viewer's pruned copy. Keying on `hasUserStats`
      // left that case cache-backed and reported the empty merge as a real zero.
      || (userFiltered && !userCacheUsable)
      // A live-fleet intersection has no cache granularity of any kind: `stats-cache.json` is
      // keyed by day and model, never by conversation. Treating it as cache-backed would report
      // the CACHE's totals under a scope the cache cannot express — the same scope reporting a
      // fraction of itself, which `resolveMachineCacheScope` exists to prevent for team/machine.
      || activeOnly

    let allTimeTotalSessions: number
    if (nonClaudeHarness || cacheBlindScope) {
      // Pure per-session count: non-Claude-only selection, a cache-blind filter, or team/central
      // data (statsCache does not represent the members). harnessSessions is already scoped.
      allTimeTotalSessions = cacheBlindScope ? filteredSessions.length : harnessSessions.length
    } else {
      const allDailyDates = new Set((effectiveStatsCache.dailyActivity ?? []).map(d => d.date))
      const claudeBase = (effectiveStatsCache.dailyActivity ?? []).reduce((s, d) => s + d.sessionCount, 0)
      let claudeGap = 0
      for (const s of harnessSessions) {
        if ((s.harness ?? 'claude') !== 'claude') continue
        if (!isDateStr(s.start_time)) continue
        const day = format(parseISO(s.start_time), 'yyyy-MM-dd')
        if (!allDailyDates.has(day)) claudeGap += 1
      }
      // harnessSessions is already restricted to the selected harnesses (or all, when none
      // selected), so this counts exactly the non-Claude sessions in scope (statsCache has none).
      const nonClaudeCount = harnessSessions.filter(s => (s.harness ?? 'claude') !== 'claude').length
      allTimeTotalSessions = claudeBase + claudeGap + nonClaudeCount
    }

    // Aggregate stats
    // Use filteredSessions when project/model/non-claude-harness filter is active
    // (statsCache has no per-project/model/harness granularity)
    // A selection of EXACTLY Claude is NOT a cache-blind scope. `stats-cache.json` is Claude's own
    // history and holds nothing else, so it answers that selection precisely — which is what the
    // comment above already promised ("Claude harness selected → statsCache history + gap days")
    // while this flag quietly did the opposite. Treating it as a session-only filter made the SAME
    // scope report a different number with the chip set than without it: the deep history the cache
    // retains and the session list no longer does simply vanished. Measured on real data as a 1.2%
    // drop in A, which showed up as the plan multiple moving 24,5× → 24,2× on the same window.
    //
    // A MIXED selection (`['claude','codex']`) stays session-based: `nonClaudeInRange` is empty
    // whenever any harness chip is set, so a cache-backed branch would silently drop Codex.
    const claudeOnlyHarness = harnessSel.length === 1 && harnessSel[0] === 'claude'
    const harnessesFiltered = harnessActive && !claudeOnlyHarness
    const sessionFiltered = cacheBlindScope || nonClaudeHarness || harnessesFiltered || (userFiltered && !hasUserStats)

    const totalMessages = sessionFiltered
      ? filteredSessions.reduce((s, sess) => s + (sess.user_message_count ?? 0) + (sess.assistant_message_count ?? 0), 0)
      : extendedDailyActivity.reduce((s, d) => s + d.messageCount, 0)
        + nonClaudeInRange.reduce((s, sess) => s + (sess.user_message_count ?? 0) + (sess.assistant_message_count ?? 0), 0)

    const totalSessions = sessionFiltered
      ? filteredSessions.length
      : extendedDailyActivity.reduce((s, d) => s + d.sessionCount, 0) + nonClaudeInRange.length

    const totalToolCalls = sessionFiltered
      ? filteredSessions.reduce((s, sess) => s + Object.values(sess.tool_counts ?? {}).reduce((a, b) => a + b, 0), 0)
      : extendedDailyActivity.reduce((s, d) => s + d.toolCallCount, 0)
        + nonClaudeInRange.reduce((s, sess) => s + Object.values(sess.tool_counts ?? {}).reduce((a, b) => a + b, 0), 0)

    // Streak
    // When project filter is active, derive active dates from filteredSessions only.
    // Otherwise, supplement stats-cache dates with all session start dates (fresher than stats-cache).
    // Session start_times are ISO UTC strings — format() normalises to local date.
    // Multi-day sessions: use user_message_timestamps when available (most accurate); otherwise
    // add both start_time and end_time so days beyond the first are not silently dropped.
    const activeDates = sessionFiltered
      ? (() => {
          const set = new Set<string>()
          for (const s of filteredSessions) {
            if (!isDateStr(s.start_time)) continue
            if (s.user_message_timestamps?.length) {
              for (const ts of s.user_message_timestamps) {
                if (isDateStr(ts)) set.add(format(parseISO(ts), 'yyyy-MM-dd'))
              }
            } else {
              set.add(format(parseISO(s.start_time), 'yyyy-MM-dd'))
              if (isDateStr(s.end_time)) set.add(format(parseISO(s.end_time), 'yyyy-MM-dd'))
            }
          }
          return set
        })()
      : new Set([
          ...(effectiveStatsCache.dailyActivity ?? []).map(d => d.date),
          ...(harnessSessions ?? []).filter(s => isDateStr(s.start_time)).map(s => format(parseISO(s.start_time), 'yyyy-MM-dd')),
        ])
    const streak = calcStreak(activeDates)
    const streakLastActiveDate = streak === 0 && activeDates.size > 0
      ? (Array.from(activeDates).sort().at(-1) ?? null)
      : null

    // Per-project streaks (for streak breakdown popup)
    // Uses all sessions (no date-range filter) to mirror the global streak, which also
    // ignores the date filter (it reads from statsCache.dailyActivity covering all history).
    // Model filter is preserved when active so per-project streaks remain consistent.
    // Project filter IS applied so the breakdown only shows projects in the active filter.
    const projectDateMap: Record<string, Set<string>> = {}
    for (const sess of harnessSessions) {
      if (!sess.project_path || !isDateStr(sess.start_time)) continue
      if (projectFiltered && !projectSet.has(sess.project_path)) continue
      if (modelSet && (!sess.model || !modelSet.has(sess.model))) continue
      const dates = projectDateMap[sess.project_path] ?? (projectDateMap[sess.project_path] = new Set())
      if (sess.user_message_timestamps?.length) {
        for (const ts of sess.user_message_timestamps) {
          if (isDateStr(ts)) dates.add(format(parseISO(ts), 'yyyy-MM-dd'))
        }
      } else {
        dates.add(format(parseISO(sess.start_time), 'yyyy-MM-dd'))
        if (isDateStr(sess.end_time)) dates.add(format(parseISO(sess.end_time), 'yyyy-MM-dd'))
      }
    }
    // Streak day breakdown: which projects were active on each day of the current streak
    const streakDayBreakdown: { date: string; projects: string[] }[] = []
    {
      const now = new Date()
      for (let i = 0; i <= 365; i++) {
        const dateStr = format(subDays(now, i), 'yyyy-MM-dd')
        if (!activeDates.has(dateStr)) { if (i > 0) break; continue }
        const projects = Object.entries(projectDateMap)
          .filter(([, dates]) => dates.has(dateStr))
          .map(([path]) => path)
          .sort()
        streakDayBreakdown.push({ date: dateStr, projects })
      }
    }

    // Longest streak ever (respects project/model/harness filter, ignores date range)
    const allTimeActiveDates = (() => {
      const set = new Set<string>()
      // Same rule as allTimeTotalSessions: once the scope is narrowed along something the cache
      // cannot represent, the active days must be derived from the sessions in scope. Reading
      // dailyActivity here made longestStreak count days from the whole Claude history.
      if (cacheBlindScope || nonClaudeHarness) {
        for (const s of (cacheBlindScope ? filteredSessions : harnessSessions)) {
          if (!isDateStr(s.start_time)) continue
          if (projectFiltered && !projectSet.has(s.project_path)) continue
          if (modelSet && (!s.model || !modelSet.has(s.model))) continue
          if (s.user_message_timestamps?.length) {
            for (const ts of s.user_message_timestamps) {
              set.add(format(parseISO(ts), 'yyyy-MM-dd'))
            }
          } else {
            set.add(format(parseISO(s.start_time), 'yyyy-MM-dd'))
            if (isDateStr(s.end_time)) set.add(format(parseISO(s.end_time), 'yyyy-MM-dd'))
          }
        }
      } else {
        for (const d of effectiveStatsCache.dailyActivity ?? []) set.add(d.date)
        for (const s of harnessSessions) {
          if (s.start_time) set.add(format(parseISO(s.start_time), 'yyyy-MM-dd'))
        }
      }
      return set
    })()
    const longestStreak = calcLongestStreak(allTimeActiveDates)

    // Heatmap data
    let heatmapData: { date: string; value: number; sessions: number; tools: number }[]
    if (sessionFiltered) {
      const byDay: Record<string, { value: number; sessions: number; tools: number }> = {}
      for (const s of filteredSessions) {
        if (!isDateStr(s.start_time)) continue
        const day = format(parseISO(s.start_time), 'yyyy-MM-dd')
        if (!byDay[day]) byDay[day] = { value: 0, sessions: 0, tools: 0 }
        byDay[day].value += (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0)
        byDay[day].sessions += 1
        byDay[day].tools += Object.values(s.tool_counts ?? {}).reduce((a, b) => a + b, 0)
      }
      heatmapData = Object.entries(byDay).map(([date, v]) => ({ date, ...v }))
    } else {
      const heatmapByDay: Record<string, { value: number; sessions: number; tools: number }> = {}
      for (const d of extendedDailyActivity) {
        heatmapByDay[d.date] = { value: d.messageCount, sessions: d.sessionCount, tools: d.toolCallCount }
      }
      for (const s of nonClaudeInRange) {
        if (!isDateStr(s.start_time)) continue
        const day = format(parseISO(s.start_time), 'yyyy-MM-dd')
        if (!heatmapByDay[day]) heatmapByDay[day] = { value: 0, sessions: 0, tools: 0 }
        heatmapByDay[day].value += (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0)
        heatmapByDay[day].sessions += 1
        heatmapByDay[day].tools += Object.values(s.tool_counts ?? {}).reduce((a, b) => a + b, 0)
      }
      heatmapData = Object.entries(heatmapByDay).map(([date, v]) => ({ date, ...v }))
    }
    heatmapData.sort((a, b) => a.date.localeCompare(b.date))

    /**
     * The same days, split BY HARNESS — one series each, for the trend beside the calendar.
     *
     * It follows the two branches above exactly rather than re-deriving anything, and that is the
     * whole reason it lives here: `stats-cache.json` is Claude-only, so in the unfiltered branch
     * Claude's days come from its OWN cache (which reaches back past the transcripts Claude
     * deletes) while every other harness is summed per session — the rule this file already keeps
     * for the totals. A single session-sum for all six would have drawn a Claude line that stops
     * 30 days ago beside a calendar that does not.
     *
     * A harness with no day in the window gets NO entry, never an all-zero series: a flat line
     * along the axis reads as a measurement that came back zero.
     */
    const heatmapByHarness: Record<string, { date: string; value: number; sessions: number }[]> = {}
    {
      const perSession = sessionFiltered ? filteredSessions : nonClaudeInRange
      const byHarnessDay: Record<string, Record<string, { value: number; sessions: number }>> = {}
      for (const s of perSession) {
        if (!isDateStr(s.start_time)) continue
        const day = format(parseISO(s.start_time), 'yyyy-MM-dd')
        const h = s.harness ?? 'claude'
        const days = byHarnessDay[h] ?? (byHarnessDay[h] = {})
        const cell = days[day] ?? (days[day] = { value: 0, sessions: 0 })
        cell.value += (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0)
        cell.sessions += 1
      }
      for (const [h, days] of Object.entries(byHarnessDay)) {
        heatmapByHarness[h] = Object.entries(days)
          .map(([date, v]) => ({ date, ...v }))
          .sort((a, b) => a.date.localeCompare(b.date))
      }
      if (!sessionFiltered) {
        // Claude's own history, from the cache. `add` is unused on this path by design — the cache
        // carries a count per day, not one row per session.
        const claude = extendedDailyActivity
          .filter(d => d.sessionCount > 0)
          .map(d => ({ date: d.date, value: d.messageCount, sessions: d.sessionCount }))
        if (claude.length > 0) heatmapByHarness.claude = claude
      }
    }

    // Model usage — respects date + model filters
    const globalModelUsage = effectiveStatsCache.modelUsage ?? {}
    const dateFiltered = filters.dateRange !== 'all' || !!filters.customStart || !!filters.customEnd

    let filteredModelUsage: Record<string, import('@agentistics/core').ModelUsage>

    if (cacheBlindScope || nonClaudeHarness || harnessesFiltered) {
      // Build per-model breakdown from sessions, via sessionModelUsage — same helper the other
      // two branches use below, and the same one every per-session cost path in this file goes
      // through. A session's own `model` field can be empty while it still carries real tokens
      // (an Antigravity rollup whose root conversation never generated a token itself, only its
      // subagent children did — see mergeAntigravityChild's model fallback), and a plain
      // `sess.model` read here used to drop that session's tokens/cost from every total that
      // isn't the raw per-session sum, while cards summing `input_tokens` directly stayed correct
      // — the two disagreeing is what made the filtered totals read far below the real spend.
      // Also used when a non-Claude harness is selected (statsCache has no harness granularity).
      filteredModelUsage = {}
      for (const sess of filteredSessions) {
        for (const [m, u] of sessionModelUsage(sess)) {
          if (modelSet && !modelSet.has(m)) continue
          if (!filteredModelUsage[m]) {
            filteredModelUsage[m] = {
              inputTokens: 0, outputTokens: 0,
              cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
              webSearchRequests: 0, costUSD: 0,
            }
          }
          const entry = filteredModelUsage[m]!
          entry.inputTokens              += u.inputTokens
          entry.outputTokens             += u.outputTokens
          entry.cacheReadInputTokens     += u.cacheReadInputTokens
          entry.cacheCreationInputTokens += u.cacheCreationInputTokens
        }
      }
    } else if (dateFiltered) {
      // Build approximate model usage from dailyModelTokens (date-filtered, Claude-only).
      // We only have total tokens per model per day, so we split input/output using
      // global proportions from statsCache as an approximation.
      filteredModelUsage = {}
      for (const day of filteredDailyModelTokens) {
        for (const [model, totalTok] of Object.entries(day.tokensByModel)) {
          if (modelSet && !modelSet.has(model)) continue
          if (!filteredModelUsage[model]) {
            filteredModelUsage[model] = {
              inputTokens: 0, outputTokens: 0,
              cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
              webSearchRequests: 0, costUSD: 0,
            }
          }
          const entry = filteredModelUsage[model]
          // Same apportionment the day-cost series uses — one implementation, so the two can
          // never price the same day differently.
          const split = apportionModelUsage(totalTok, globalModelUsage[model])
          entry.inputTokens              += split.inputTokens
          entry.outputTokens             += split.outputTokens
          entry.cacheReadInputTokens     += split.cacheReadInputTokens
          entry.cacheCreationInputTokens += split.cacheCreationInputTokens
        }
      }
      // Supplement with non-Claude sessions in range (unified view, date-filtered)
      for (const sess of nonClaudeInRange) {
        // Per-model split: a multi-model session (Antigravity parent + folded subagents)
        // contributes to each of its models, never all of it to one label.
        for (const [m, u] of sessionModelUsage(sess)) {
          if (modelSet && !modelSet.has(m)) continue
          if (!filteredModelUsage[m]) {
            filteredModelUsage[m] = {
              inputTokens: 0, outputTokens: 0,
              cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
              webSearchRequests: 0, costUSD: 0,
            }
          }
          const entry = filteredModelUsage[m]!
          entry.inputTokens              += u.inputTokens
          entry.outputTokens             += u.outputTokens
          entry.cacheReadInputTokens     += u.cacheReadInputTokens
          entry.cacheCreationInputTokens += u.cacheCreationInputTokens
        }
      }
    } else {
      // No date filter, no project filter, no harness filter — use global statsCache (Claude)
      // then supplement with non-Claude sessions (unified view).
      if (modelSet) {
        filteredModelUsage = {}
        for (const m of modelSet) {
          if (globalModelUsage[m]) filteredModelUsage[m] = { ...globalModelUsage[m] }
        }
      } else {
        filteredModelUsage = { ...globalModelUsage }
      }
      // Supplement with non-Claude sessions (unified view, no date filter)
      for (const sess of nonClaudeInRange) {
        // Per-model split: a multi-model session (Antigravity parent + folded subagents)
        // contributes to each of its models, never all of it to one label.
        for (const [m, u] of sessionModelUsage(sess)) {
          if (modelSet && !modelSet.has(m)) continue
          if (!filteredModelUsage[m]) {
            filteredModelUsage[m] = {
              inputTokens: 0, outputTokens: 0,
              cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
              webSearchRequests: 0, costUSD: 0,
            }
          }
          const entry = filteredModelUsage[m]!
          entry.inputTokens              += u.inputTokens
          entry.outputTokens             += u.outputTokens
          entry.cacheReadInputTokens     += u.cacheReadInputTokens
          entry.cacheCreationInputTokens += u.cacheCreationInputTokens
        }
      }
    }

    // Cost calculation
    //
    // The day-granular series (`apiCostByDay`) is built from the SAME fork, in the same pass, so
    // the headline and the per-day decomposition can never drift apart. Whatever the fork cannot
    // attribute to a day becomes `undatedCostUSD`, computed below as an EXACT residue rather than
    // by trying to make two sources agree — see the ApiCostByDay doc comment in @agentistics/core.
    //
    // The day key is `start_time.slice(0, 10)` (UTC), matching `tagSessionDay` and the billing
    // module. Deliberately NOT `format(parseISO(...), 'yyyy-MM-dd')` (local), which is used a few
    // lines above for the session-gap count: mixing the two rules would drift a session across a
    // billing-period boundary at UTC-3 while the chart beside it plots the other day.
    const costDays: Partial<Record<HarnessId, Record<string, { costUSD: number; tokens: number; sessions: number }>>> = {}
    const addDayCost = (harness: HarnessId, day: string, costUSD: number, tokens: number, sessions: number) => {
      const byDay = (costDays[harness] ??= {})
      const entry = (byDay[day] ??= { costUSD: 0, tokens: 0, sessions: 0 })
      entry.costUSD += costUSD
      entry.tokens += tokens
      entry.sessions += sessions
    }
    const dayOf = (s: { start_time?: string }): string | null =>
      isDateStr(s.start_time) ? s.start_time.slice(0, 10) : null

    let totalCostUSD = 0
    let totalTokensAll = 0
    if (cacheBlindScope || nonClaudeHarness || harnessesFiltered) {
      // Use per-session calcCost with the session's model field (includes cache tokens).
      // Also used when a non-Claude harness is selected (statsCache lacks harness granularity).
      // Sessions without a model fall back to blended rate on input+output only.
      // Every contribution here IS a session, so every one of them carries a day: this branch
      // attributes in full and leaves no residue.
      const blended = blendedCostPerToken(globalModelUsage)
      const modelSetFallback = modelSet?.size === 1 ? [...modelSet][0]! : undefined
      for (const sess of filteredSessions) {
        // Per-model pricing (multi-model sessions carry a `model_usage` breakdown).
        const cost = sessionCostUSD(sess, modelSetFallback)
        const sessCost = cost !== null
          ? cost
          : ((sess.input_tokens ?? 0) / 1_000_000) * blended.input
            + ((sess.output_tokens ?? 0) / 1_000_000) * blended.output
        totalCostUSD += sessCost
        const tokens = (sess.input_tokens ?? 0) + (sess.output_tokens ?? 0)
          + (sess.cache_read_input_tokens ?? 0) + (sess.cache_creation_input_tokens ?? 0)
        totalTokensAll += tokens
        const day = dayOf(sess)
        if (day) addDayCost(sess.harness ?? 'claude', day, sessCost, tokens, 1)
      }
    } else {
      totalCostUSD = Object.entries(filteredModelUsage).reduce((s, [id, u]) => s + calcCost(u, id), 0)
      totalTokensAll = Object.values(filteredModelUsage).reduce((s, u) => s + usageTokenTotal(u), 0)

      // Claude's half. `dailyModelTokens` is the ONLY day series Claude has, and it carries a
      // per-model total with no input/output/cache split — so the split is apportioned from the
      // global per-model proportions, exactly as `filteredModelUsage` already does a few lines
      // above. When a date filter is active those two are built from the same rows and the day
      // series sums to the headline; with no filter the headline comes from the CUMULATIVE
      // `modelUsage` instead, which covers history the daily series no longer retains. That gap
      // is the residue, and it is real spend — reported, never folded into a day it did not
      // happen on.
      for (const day of filteredDailyModelTokens) {
        if (!isDateStr(day.date)) continue
        let dayCost = 0
        let dayTokens = 0
        for (const [model, totalTok] of Object.entries(day.tokensByModel)) {
          if (modelSet && !modelSet.has(model)) continue
          dayCost += calcCost(apportionModelUsage(totalTok, globalModelUsage[model]), model)
          dayTokens += totalTok
        }
        if (dayCost > 0 || dayTokens > 0) addDayCost('claude', day.date.slice(0, 10), dayCost, dayTokens, 0)
      }

      // Claude's SESSIONS also carry a day, and they reach further back than `dailyModelTokens`
      // does. Without this, ticking the Claude harness chip — which flips the fork above to the
      // per-session branch — changed the plan comparison enormously for the same underlying data,
      // because the unfiltered path could only date a fraction of the cost and excluded the rest.
      //
      // MERGED PER DAY BY MAX, never added: the two sources overlap, so summing them would
      // double-count every day both describe. Same rule, and the same reason, as
      // `applyArchivedStats` reconciling the archive against the live stats.
      // Sessions SUM among themselves within a day — they are distinct pieces of work — and only
      // the day's total then competes with the daily series for the max.
      const fromSessions: Record<string, { costUSD: number; tokens: number; sessions: number }> = {}
      for (const sess of filteredSessions) {
        if ((sess.harness ?? 'claude') !== 'claude') continue
        const day = dayOf(sess)
        if (!day) continue
        const entry = (fromSessions[day] ??= { costUSD: 0, tokens: 0, sessions: 0 })
        entry.costUSD += sessionCostUSD(sess) ?? 0
        entry.tokens += (sess.input_tokens ?? 0) + (sess.output_tokens ?? 0)
          + (sess.cache_read_input_tokens ?? 0) + (sess.cache_creation_input_tokens ?? 0)
        entry.sessions += 1
      }
      const claudeDays = (costDays.claude ??= {})
      for (const [day, entry] of Object.entries(fromSessions)) {
        const prev = claudeDays[day]
        claudeDays[day] = prev
          ? {
              costUSD: Math.max(prev.costUSD, entry.costUSD),
              tokens: Math.max(prev.tokens, entry.tokens),
              sessions: Math.max(prev.sessions, entry.sessions),
            }
          : entry
      }

      // The non-Claude half is per-session and therefore fully dated.
      for (const sess of nonClaudeInRange) {
        const day = dayOf(sess)
        if (!day) continue
        let sessCost = 0
        let tokens = 0
        for (const [m, u] of sessionModelUsage(sess)) {
          if (modelSet && !modelSet.has(m)) continue
          sessCost += calcCost(u, m)
          tokens += usageTokenTotal(u)
        }
        addDayCost(sess.harness ?? 'claude', day, sessCost, tokens, 1)
      }
    }

    // Exact by construction: Σ(days) + undated === totalCostUSD, whichever fork ran. A NEGATIVE
    // residue means the daily series reports MORE than the cumulative total it is supposed to
    // decompose — the two local sources contradicting each other, not merely disagreeing about
    // how far back they reach. `usePlanBasis` treats that as a fault and withholds the plan
    // basis, because A over the covered days would then exceed the total shown beside it.
    const apiCostByDay = summarizeApiCostByDay(costDays, totalCostUSD, totalTokensAll)

    // Model tokens by model (for date range)
    const modelTokensByDate: Record<string, number> = {}
    for (const day of filteredDailyModelTokens) {
      for (const [model, tokens] of Object.entries(day.tokensByModel)) {
        if (modelSet && !modelSet.has(model)) continue
        modelTokensByDate[model] = (modelTokensByDate[model] ?? 0) + tokens
      }
    }

    // Tools + Languages
    const toolCounts: Record<string, number> = {}
    const toolOutputTokens: Record<string, number> = {}
    const agentFileReads: Record<string, number> = {}
    const langCounts: Record<string, number> = {}
    for (const s of filteredSessions) {
      for (const [tool, count] of Object.entries(s.tool_counts ?? {})) {
        toolCounts[tool] = (toolCounts[tool] ?? 0) + count
      }
      for (const [tool, tokens] of Object.entries(s.tool_output_tokens ?? {})) {
        toolOutputTokens[tool] = (toolOutputTokens[tool] ?? 0) + tokens
      }
      for (const [file, count] of Object.entries(s.agent_file_reads ?? {})) {
        agentFileReads[file] = (agentFileReads[file] ?? 0) + count
      }
      for (const lang of s.languages ?? []) {
        langCounts[lang] = (langCounts[lang] ?? 0) + 1
      }
    }

    // Git / Files — TWO facts, never one switching between two sources.
    //
    // `gitCommits` / `lines*` / `filesModified` are what the ASSISTANTS did: summed per session,
    // so they are filterable by harness and consistent with tokens and cost, which are also per
    // session. `repoGit` is what happened IN THE REPOSITORY over the same window: a `git log`,
    // which also counts commits made by hand, by a teammate on the same checkout, and by CI.
    //
    // These used to be one number that silently switched source — project git_stats when a project
    // filter was active, session sums otherwise — so the same card meant different things depending
    // on an unrelated filter, and a repo-level figure was credited to an assistant.
    const gitCommits = filteredSessions.reduce((s, sess) => s + (sess.git_commits ?? 0), 0)
    const gitPushes = filteredSessions.reduce((s, sess) => s + (sess.git_pushes ?? 0), 0)
    const linesAdded = filteredSessions.reduce((s, sess) => s + (sess.lines_added ?? 0), 0)
    const linesRemoved = filteredSessions.reduce((s, sess) => s + (sess.lines_removed ?? 0), 0)
    const filesModified = filteredSessions.reduce((s, sess) => s + (sess.files_modified ?? 0), 0)

    const repoGit = repositoryGitTotals(
      data.projects,
      projectFiltered ? projects : null,
      (filters.harnesses ?? []).length > 0,
    )

    // Tokens from sessions
    const inputTokens = filteredSessions.reduce((s, sess) => s + (sess.input_tokens ?? 0), 0)
    const outputTokens = filteredSessions.reduce((s, sess) => s + (sess.output_tokens ?? 0), 0)

    // Hour distribution
    const hourCounts: Record<number, number> = {}
    for (const s of filteredSessions) {
      for (const h of s.message_hours ?? []) {
        hourCounts[h] = (hourCounts[h] ?? 0) + 1
      }
    }

    // Hour metadata: first/last timestamp per hour (for tooltip)
    const hourMeta: Record<number, { firstTs: string; lastTs: string }> = {}
    for (const s of filteredSessions) {
      for (const ts of s.user_message_timestamps ?? []) {
        try {
          const h = new Date(ts).getHours()
          if (!hourMeta[h]) {
            hourMeta[h] = { firstTs: ts, lastTs: ts }
          } else {
            if (ts < hourMeta[h].firstTs) hourMeta[h].firstTs = ts
            if (ts > hourMeta[h].lastTs) hourMeta[h].lastTs = ts
          }
        } catch { /* skip */ }
      }
    }

    // Project stats
    const projectStats: Record<string, { sessions: number; messages: number; tools: number }> = {}
    for (const s of filteredSessions) {
      const p = s.project_path || 'Unknown'
      if (!projectStats[p]) projectStats[p] = { sessions: 0, messages: 0, tools: 0 }
      projectStats[p].sessions++
      projectStats[p].messages += (s.user_message_count ?? 0)
      projectStats[p].tools += Object.values(s.tool_counts ?? {}).reduce((a, b) => a + b, 0)
    }

    // Repository stats (group by normalized git remote)
    // The key is `git_remote || ''`; the empty-string bucket collects sessions with no linked
    // repo (shown as a flagged "no repository" card, never hidden). Cost is per-session (same
    // blended/calcCost path as the KPI total) so repo cards reconcile with the rest of the app.
    // Reactive to every active filter because it derives purely from filteredSessions.
    const blendedRepo = blendedCostPerToken(globalModelUsage)
    const repoModelFallback = modelSet?.size === 1 ? [...modelSet][0]! : undefined
    const repoSessionCostUSD = (sess: SessionMeta): number => {
      const cost = sessionCostUSD(sess, repoModelFallback)
      if (cost !== null) return cost
      return ((sess.input_tokens ?? 0) / 1_000_000) * blendedRepo.input
           + ((sess.output_tokens ?? 0) / 1_000_000) * blendedRepo.output
    }

    const repoStatsMap: Record<string, RepoStat> = {}
    for (const s of filteredSessions) {
      const linked = !!s.git_remote
      // Linked sessions group by remote; unlinked sessions group per project folder so each
      // shows up as its own card (folder name + path), never lumped into one bucket.
      const key = linked ? s.git_remote! : `folder:${s.project_path || 'Unknown'}`
      let r = repoStatsMap[key]
      if (!r) {
        r = repoStatsMap[key] = {
          id: key, remote: linked ? s.git_remote! : '', linked, name: '', path: '',
          sessions: 0, messages: 0, tools: 0, costUSD: 0,
          inputTokens: 0, outputTokens: 0, tokens: EMPTY_TOKENS,
          gitCommits: 0, linesAdded: 0, linesRemoved: 0, filesModified: 0,
          ciSessions: 0, members: [], harnesses: [],
          firstActive: '', lastActive: '', activityByDay: {},
          _users: new Set<string>(), _harnesses: new Set<HarnessId>(), _paths: {},
        }
      }
      if (s.project_path) r._paths[s.project_path] = (r._paths[s.project_path] ?? 0) + 1
      r.sessions++
      r.messages += (s.user_message_count ?? 0)
      r.tools += Object.values(s.tool_counts ?? {}).reduce((a, b) => a + b, 0)
      r.costUSD += repoSessionCostUSD(s)
      r.inputTokens += s.input_tokens ?? 0
      r.outputTokens += s.output_tokens ?? 0
      r.tokens = addTokens(r.tokens, sessionTokens(s))
      r.gitCommits += s.git_commits ?? 0
      r.linesAdded += s.lines_added ?? 0
      r.linesRemoved += s.lines_removed ?? 0
      r.filesModified += s.files_modified ?? 0
      if (s.ci) r.ciSessions++
      if (s.user) r._users.add(s.user)
      r._harnesses.add(s.harness ?? 'claude')
      if (s.start_time) {
        if (!r.firstActive || s.start_time < r.firstActive) r.firstActive = s.start_time
        if (!r.lastActive || s.start_time > r.lastActive) r.lastActive = s.start_time
        const day = s.start_time.slice(0, 10)
        r.activityByDay[day] = (r.activityByDay[day] ?? 0) + 1
      }
    }
    // Finalize Set-backed fields into plain arrays + resolve the representative folder path/name.
    for (const r of Object.values(repoStatsMap)) {
      r.members = Array.from(r._users).sort()
      r.harnesses = Array.from(r._harnesses)
      const topPath = Object.entries(r._paths).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
      r.path = topPath
      r.name = r.linked
        ? repoShortName(r.remote)
        : (topPath.split('/').filter(Boolean).pop() || topPath)
    }
    const repoStats = Object.values(repoStatsMap).sort((a, b) => b.costUSD - a.costUSD || b.sessions - a.sessions)

    // Agent metrics
    const agentInvocations: AgentInvocation[] = []
    const agentTypeBreakdown: Record<string, { count: number; tokens: number; costUSD: number; durationMs: number }> = {}

    for (const s of filteredSessions) {
      if (!s.agentMetrics?.invocations) continue
      for (const inv of s.agentMetrics.invocations) {
        agentInvocations.push(inv)
        const type = inv.agentType || 'unknown'
        if (!agentTypeBreakdown[type]) agentTypeBreakdown[type] = { count: 0, tokens: 0, costUSD: 0, durationMs: 0 }
        agentTypeBreakdown[type].count++
        agentTypeBreakdown[type].tokens += inv.totalTokens
        agentTypeBreakdown[type].costUSD += inv.costUSD
        agentTypeBreakdown[type].durationMs += inv.totalDurationMs
      }
    }

    const totalAgentInvocations = agentInvocations.length
    const totalAgentTokens = agentInvocations.reduce((s, i) => s + i.totalTokens, 0)
    const totalAgentCostUSD = agentInvocations.reduce((s, i) => s + i.costUSD, 0)
    const totalAgentDurationMs = agentInvocations.reduce((s, i) => s + i.totalDurationMs, 0)

    const { session: longestSession, unmeasured: longestSessionUnmeasured } =
      pickLongestSession(filteredSessions)

    // Cache efficiency (filter-aware, derived from filteredModelUsage)
    // hit rate = cacheRead / (input + cacheRead + cacheCreation).
    // cacheCreation tokens are included in the denominator because they ARE tokens sent to the
    // model — including them avoids artificially inflated rates that approach 100% for heavy
    // Claude Code users where cacheRead dwarfs uncached input by orders of magnitude.
    // Savings model: compare actual spend with what the same tokens would have cost as
    // plain input, then subtract the extra we paid for cache writes.
    const cacheTotals = Object.values(filteredModelUsage).reduce(
      (acc, u) => ({
        inputTokens: acc.inputTokens + (u.inputTokens ?? 0),
        cacheReadInputTokens: acc.cacheReadInputTokens + (u.cacheReadInputTokens ?? 0),
        cacheCreationInputTokens: acc.cacheCreationInputTokens + (u.cacheCreationInputTokens ?? 0),
      }),
      { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    )
    const cacheDenominator = cacheTotals.inputTokens + cacheTotals.cacheReadInputTokens + cacheTotals.cacheCreationInputTokens
    const cacheHitRate = cacheDenominator > 0 ? cacheTotals.cacheReadInputTokens / cacheDenominator : 0

    /**
     * The four billed counters for the CURRENT filter — the one place any surface should read a
     * token total from.
     *
     * Built from `filteredModelUsage`, which is the same source `totalCostUSD` is priced from, so
     * the token figure and the money beside it always describe the same set of turns. Everything
     * that used to write `derived.inputTokens + derived.outputTokens` — the header counter, the
     * comparison sides, the totals panel — reads this instead.
     */
    const tokenTotals: TokenBreakdown = sumTokens(Object.values(filteredModelUsage).map(usageTokens))

    const blended = blendedCostPerToken(globalModelUsage)
    // What cacheRead tokens would have cost as plain input
    const cacheHypotheticalInputUSD = (cacheTotals.cacheReadInputTokens / 1_000_000) * blended.input
    // What cacheRead tokens actually cost
    const cacheActualReadUSD = (cacheTotals.cacheReadInputTokens / 1_000_000) * blended.cacheRead
    // Gross savings vs paying as regular input
    const cacheGrossSavedUSD = cacheHypotheticalInputUSD - cacheActualReadUSD
    // Premium paid for cache writes (extra over regular input)
    const cacheWriteOverheadUSD = Math.max(
      0,
      (cacheTotals.cacheCreationInputTokens / 1_000_000) * (blended.cacheWrite - blended.input),
    )
    // Net savings
    const cacheNetSavedUSD = cacheGrossSavedUSD - cacheWriteOverheadUSD

    // Per-model hit rate (only for models with data)
    const cachePerModel: Record<string, { hitRate: number; cacheReadTokens: number; inputTokens: number }> = {}
    for (const [modelId, u] of Object.entries(filteredModelUsage)) {
      const denom = (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0)
      if (denom === 0) continue
      cachePerModel[modelId] = {
        hitRate: (u.cacheReadInputTokens ?? 0) / denom,
        cacheReadTokens: u.cacheReadInputTokens ?? 0,
        inputTokens: u.inputTokens ?? 0,
      }
    }

    // Meta coverage range (commits/files only exist in meta sessions)
    const allMetaDates = (data.sessions ?? [])
      .filter(s => s._source === 'meta' && s.start_time)
      .map(s => s.start_time.slice(0, 10))
      .sort()
    const metaCoverageFrom = allMetaDates[0] ?? null
    const metaCoverageTo = allMetaDates[allMetaDates.length - 1] ?? null

    // Session date range (reactive to active filters)
    const sortedStartTimes = filteredSessions
      .filter(s => s.start_time)
      .map(s => s.start_time)
      .sort()
    const firstSessionDate = sortedStartTimes.length > 0 ? parseISO(sortedStartTimes[0]!) : null
    const lastSessionDate = sortedStartTimes.length > 0 ? parseISO(sortedStartTimes[sortedStartTimes.length - 1]!) : null
    const sessionSpanDays = firstSessionDate && lastSessionDate
      ? differenceInCalendarDays(lastSessionDate, firstSessionDate) + 1
      : filteredSessions.length > 0 ? 1 : 0

    return {
      presenceScope,
      /** True when "active only" narrowed this scope to conversations running right now — the
       *  page must say so, exactly as every other cache-blind scope does (see `fleetFilter.ts`'s
       *  header and `activeConversations.ts`'s). */
      activeOnlyScoped: activeOnly,
      totalMessages,
      totalSessions,
      allTimeTotalSessions,
      totalToolCalls,
      totalCostUSD,
      /** `totalCostUSD` decomposed by day and harness, plus the part no day can carry.
       *  Feeds the plan cost basis — see `billing.ts` in @agentistics/core. */
      apiCostByDay,
      streak,
      streakLastActiveDate,
      longestStreak,
      streakDayBreakdown,
      heatmapData,
      heatmapByHarness,
      modelUsage: filteredModelUsage,
      modelTokensByDate,
      toolCounts,
      toolOutputTokens,
      agentFileReads,
      langCounts,
      gitCommits,
      repoGit,
      gitPushes,
      linesAdded,
      linesRemoved,
      filesModified,
      inputTokens,
      outputTokens,
      hourCounts,
      hourMeta,
      projectStats,
      repoStats,
      filteredSessions,
      filteredDailyActivity,
      longestSession,
      longestSessionUnmeasured,
      metaCoverageFrom,
      metaCoverageTo,
      agentInvocations,
      agentTypeBreakdown,
      totalAgentInvocations,
      totalAgentTokens,
      totalAgentCostUSD,
      totalAgentDurationMs,
      firstSessionDate,
      lastSessionDate,
      sessionSpanDays,
      cacheHitRate,
      cacheTotals,
      tokenTotals,
      cacheGrossSavedUSD,
      cacheWriteOverheadUSD,
      cacheNetSavedUSD,
      cachePerModel,
    }
  }
}

export function useDerivedStats(
  data: AppData | null,
  filters: Filters,
  tags: TagDef[] = [],
  activeOnly = false,
  runningIds: ReadonlySet<string> = new Set(),
) {
  return useMemo(
    () => computeDerivedStats(data, filters, tags, activeOnly, runningIds),
    [data, filters, tags, activeOnly, runningIds],
  )
}
