/**
 * Claude Stats — Watcher / Daemon mode with optional OpenTelemetry export.
 *
 * This module watches ~/.claude/ for file changes and periodically recomputes
 * metrics. When OTEL_EXPORTER_OTLP_ENDPOINT is set, it exports metrics via
 * the OpenTelemetry OTLP/HTTP protocol.
 *
 * The watcher is fully optional — the main dashboard (`bun run dev`) works
 * without it. Run `bun run watch` only when you want OTLP metrics export.
 *
 * Usage:
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 bun run watch
 *
 * Environment variables:
 *   OTEL_EXPORTER_OTLP_ENDPOINT  — OTLP collector endpoint (required for export)
 *   OTEL_EXPORTER_OTLP_HEADERS   — Extra headers (e.g. "Authorization=Bearer tok")
 *   OTEL_SERVICE_NAME             — Service name (default: "agentistics")
 *   CLAUDE_STATS_WATCH_INTERVAL   — Polling interval in seconds (default: 30, min: 5)
 *
 * Multi-harness metrics (backward compatible):
 *   The existing claude_stats.* metrics are preserved unchanged for backward
 *   compatibility with existing dashboards. In addition, new agentistics.harness.*
 *   metrics are exported with a `harness` attribute
 *   (claude|codex|gemini|copilot|antigravity),
 *   aggregated from the per-session consolidated store (~/.agentistics/sessions/).
 */

import { join } from 'path'
import chokidar from 'chokidar'
import { markOtelWatcherHosted } from './watcher-state'

// OpenTelemetry imports

import { metrics, ValueType } from '@opentelemetry/api'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'

// Shared imports from the main codebase

import { calcCost, sessionCostUSD } from '@agentistics/core'
import type { ModelUsage, HarnessId, SessionMeta } from '@agentistics/core'
import type { OtelSnapshot } from '@agentistics/core'
import { HOME_DIR, CLAUDE_DIR, PROJECTS_DIR, SESSION_META_DIR, STATS_CACHE_FILE, CONSOLIDATED_DIR } from './config'
import { createLimiter, safeReadJson, safeReadDir, safeStat } from './utils'
import { getEnabledAdapters } from './adapters/types'

// Configuration

const MIN_INTERVAL_SEC = 5
const rawInterval = parseInt(process.env.CLAUDE_STATS_WATCH_INTERVAL ?? '30', 10)
const WATCH_INTERVAL_SEC = (!Number.isFinite(rawInterval) || rawInterval < MIN_INTERVAL_SEC)
  ? (() => {
      if (process.env.CLAUDE_STATS_WATCH_INTERVAL) {
        console.warn(`[config] Invalid CLAUDE_STATS_WATCH_INTERVAL="${process.env.CLAUDE_STATS_WATCH_INTERVAL}", using default 30s`)
      }
      return 30
    })()
  : rawInterval

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'agentistics'
const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? ''
const OTLP_HEADERS = process.env.OTEL_EXPORTER_OTLP_HEADERS ?? ''

// Snapshot builder

interface StatsCache {
  dailyActivity?: Array<{ date: string; messageCount: number; sessionCount: number; toolCallCount: number }>
  modelUsage?: Record<string, ModelUsage>
  longestSession?: { duration: number }
}

interface SessionMetaLight {
  session_id: string
  project_path: string
  tool_counts: Record<string, number>
  git_commits: number
  git_pushes: number
  lines_added: number
  lines_removed: number
  files_modified: number
}

/** Per-harness aggregated totals derived from the consolidated session store. */
export interface HarnessSnapshot {
  harness: HarnessId
  totalSessions: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
}

/** Aggregate per-harness totals from the ~/.agentistics/sessions/<harness>/ store.
 *  Only includes harnesses that are currently enabled (respects AGENTISTICS_HARNESS_<ID>=0).
 *  Uses per-session token fields and calcCost() — no inline math. */
async function buildHarnessSnapshots(): Promise<HarnessSnapshot[]> {
  const limit = createLimiter(40)
  const results: HarnessSnapshot[] = []

  const enabledAdapters = await getEnabledAdapters()
  const enabledHarnesses: HarnessId[] = enabledAdapters.map(a => a.id as HarnessId)

  for (const harness of enabledHarnesses) {
    const dir = `${CONSOLIDATED_DIR}/${harness}`
    const files = (await safeReadDir(dir)).filter(f => f.endsWith('.json'))

    let totalSessions = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCostUsd = 0

    await Promise.all(
      files.map(f =>
        limit(async () => {
          const s = await safeReadJson<SessionMeta>(`${dir}/${f}`)
          if (!s) return
          totalSessions++
          const inp = s.input_tokens ?? 0
          const out = s.output_tokens ?? 0
          const cacheRead = s.cache_read_input_tokens ?? 0
          const cacheWrite = s.cache_creation_input_tokens ?? 0
          totalInputTokens += inp + cacheRead + cacheWrite
          totalOutputTokens += out
          // Per-model breakdown (multi-model sessions, e.g. Antigravity, price correctly)
          // instead of one dominant model's rate applied to the session's whole usage.
          // No model at all → calcCost falls back to the default price, same as everywhere else.
          totalCostUsd += sessionCostUSD(s) ?? calcCost({
            inputTokens: inp,
            outputTokens: out,
            cacheReadInputTokens: cacheRead,
            cacheCreationInputTokens: cacheWrite,
            webSearchRequests: 0,
            costUSD: 0,
          }, '')
        })
      )
    )

    results.push({ harness, totalSessions, totalInputTokens, totalOutputTokens, totalCostUsd })
  }

  return results
}

async function buildSnapshot(): Promise<OtelSnapshot & { harnessSnapshots: HarnessSnapshot[] }> {
  const statsCache = await safeReadJson<StatsCache>(STATS_CACHE_FILE) ?? {}

  // Load session-meta files in parallel with concurrency limit
  const metaFiles = (await safeReadDir(SESSION_META_DIR)).filter(f => f.endsWith('.json'))
  const limit = createLimiter(20)
  const sessions: SessionMetaLight[] = []

  await Promise.all(
    metaFiles.map(f =>
      limit(async () => {
        const data = await safeReadJson<SessionMetaLight>(join(SESSION_META_DIR, f))
        if (data) sessions.push(data)
      })
    )
  )

  // Aggregate from stats-cache (preferred for totals)
  const dailyActivity = statsCache.dailyActivity ?? []
  const totalMessages = dailyActivity.reduce((s, d) => s + d.messageCount, 0)
  const totalSessions = dailyActivity.reduce((s, d) => s + d.sessionCount, 0)
  const totalToolCalls = dailyActivity.reduce((s, d) => s + d.toolCallCount, 0)

  // Streak
  const activeDates = new Set(dailyActivity.map(d => d.date))
  const today = new Date()
  let streak = 0
  for (let i = 0; i <= 365; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().slice(0, 10)
    if (activeDates.has(dateStr)) streak++
    else if (i > 0) break
  }

  // Model tokens — use shared calcCost from types.ts
  const modelUsage = statsCache.modelUsage ?? {}
  const modelTokens: Record<string, { input: number; output: number }> = {}
  let totalCostUsd = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0

  for (const [modelId, u] of Object.entries(modelUsage)) {
    const inp = u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0)
    const out = u.outputTokens
    modelTokens[modelId] = { input: inp, output: out }
    totalInputTokens += inp
    totalOutputTokens += out
    totalCostUsd += calcCost(u, modelId)
  }

  // From sessions
  const toolCounts: Record<string, number> = {}
  let totalGitCommits = 0
  let totalGitPushes = 0
  let totalLinesAdded = 0
  let totalLinesRemoved = 0
  let totalFilesModified = 0
  const projectPaths = new Set<string>()

  for (const s of sessions) {
    totalGitCommits += s.git_commits ?? 0
    totalGitPushes += s.git_pushes ?? 0
    totalLinesAdded += s.lines_added ?? 0
    totalLinesRemoved += s.lines_removed ?? 0
    totalFilesModified += s.files_modified ?? 0
    if (s.project_path) projectPaths.add(s.project_path)

    for (const [tool, count] of Object.entries(s.tool_counts ?? {})) {
      toolCounts[tool] = (toolCounts[tool] ?? 0) + count
    }
  }

  // Build per-harness snapshots from the consolidated store (non-blocking; empty if dir not found)
  const harnessSnapshots = await buildHarnessSnapshots()

  return {
    totalMessages,
    totalSessions,
    totalToolCalls,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    totalGitCommits,
    totalGitPushes,
    totalLinesAdded,
    totalLinesRemoved,
    totalFilesModified,
    streak,
    longestSessionMinutes: statsCache.longestSession?.duration ?? 0, // duration is in minutes (mirrors SessionMeta.duration_minutes)
    activeProjects: projectPaths.size,
    modelTokens,
    toolCounts,
    harnessSnapshots,
  }
}

// OpenTelemetry setup

function parseOtlpHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!raw) return headers
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=')
    if (idx > 0) {
      headers[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim()
    }
  }
  return headers
}

function buildOtlpUrl(endpoint: string): string {
  const base = endpoint.replace(/\/$/, '')
  // Don't append /v1/metrics if the user already included it
  if (base.endsWith('/v1/metrics')) return base
  return base + '/v1/metrics'
}

let latestSnapshot: (OtelSnapshot & { harnessSnapshots: HarnessSnapshot[] }) | null = null

function setupOtel(): { shutdown: () => Promise<void> } | null {
  if (!OTLP_ENDPOINT) {
    console.log('[otel] No OTEL_EXPORTER_OTLP_ENDPOINT set — metrics export disabled')
    return null
  }

  const exporter = new OTLPMetricExporter({
    url: buildOtlpUrl(OTLP_ENDPOINT),
    headers: parseOtlpHeaders(OTLP_HEADERS),
  })

  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: WATCH_INTERVAL_SEC * 1000,
  })

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
  })

  const meterProvider = new MeterProvider({
    resource,
    readers: [reader],
  })

  metrics.setGlobalMeterProvider(meterProvider)

  const meter = metrics.getMeter('agentistics', '1.0.0')

  // Define instruments
  // Cumulative totals use ObservableCounter; point-in-time values use ObservableGauge.

  const messagesTotal = meter.createObservableCounter('claude_stats.messages.total', {
    description: 'Total messages (user + assistant)',
    unit: '{messages}',
    valueType: ValueType.INT,
  })
  messagesTotal.addCallback(obs => {
    if (latestSnapshot) obs.observe(latestSnapshot.totalMessages)
  })

  const sessionsTotal = meter.createObservableCounter('claude_stats.sessions.total', {
    description: 'Total sessions',
    unit: '{sessions}',
    valueType: ValueType.INT,
  })
  sessionsTotal.addCallback(obs => {
    if (latestSnapshot) obs.observe(latestSnapshot.totalSessions)
  })

  const toolCallsTotal = meter.createObservableCounter('claude_stats.tool_calls.total', {
    description: 'Total tool calls',
    unit: '{calls}',
    valueType: ValueType.INT,
  })
  toolCallsTotal.addCallback(obs => {
    if (latestSnapshot) obs.observe(latestSnapshot.totalToolCalls)
  })

  const inputTokens = meter.createObservableCounter('claude_stats.tokens.input', {
    description: 'Total input tokens',
    unit: '{tokens}',
    valueType: ValueType.INT,
  })
  inputTokens.addCallback(obs => {
    if (latestSnapshot) obs.observe(latestSnapshot.totalInputTokens)
  })

  const outputTokens = meter.createObservableCounter('claude_stats.tokens.output', {
    description: 'Total output tokens',
    unit: '{tokens}',
    valueType: ValueType.INT,
  })
  outputTokens.addCallback(obs => {
    if (latestSnapshot) obs.observe(latestSnapshot.totalOutputTokens)
  })

  const costUsd = meter.createObservableCounter('claude_stats.cost.usd', {
    description: 'Estimated total cost in USD',
    unit: 'USD',
    valueType: ValueType.DOUBLE,
  })
  costUsd.addCallback(obs => {
    if (latestSnapshot) obs.observe(latestSnapshot.totalCostUsd)
  })

  const gitCommits = meter.createObservableCounter('claude_stats.git.commits', {
    description: 'Total git commits via Claude',
    unit: '{commits}',
    valueType: ValueType.INT,
  })
  gitCommits.addCallback(obs => {
    if (latestSnapshot) obs.observe(latestSnapshot.totalGitCommits)
  })

  const gitPushes = meter.createObservableCounter('claude_stats.git.pushes', {
    description: 'Total git pushes via Claude',
    unit: '{pushes}',
    valueType: ValueType.INT,
  })
  gitPushes.addCallback(obs => {
    if (latestSnapshot) obs.observe(latestSnapshot.totalGitPushes)
  })

  const linesAdded = meter.createObservableCounter('claude_stats.git.lines_added', {
    description: 'Total lines added',
    unit: '{lines}',
    valueType: ValueType.INT,
  })
  linesAdded.addCallback(obs => {
    if (latestSnapshot) obs.observe(latestSnapshot.totalLinesAdded)
  })

  const linesRemoved = meter.createObservableCounter('claude_stats.git.lines_removed', {
    description: 'Total lines removed',
    unit: '{lines}',
    valueType: ValueType.INT,
  })
  linesRemoved.addCallback(obs => {
    if (latestSnapshot) obs.observe(latestSnapshot.totalLinesRemoved)
  })

  const filesModified = meter.createObservableCounter('claude_stats.git.files_modified', {
    description: 'Total files modified',
    unit: '{files}',
    valueType: ValueType.INT,
  })
  filesModified.addCallback(obs => {
    if (latestSnapshot) obs.observe(latestSnapshot.totalFilesModified)
  })

  const streakGauge = meter.createObservableGauge('claude_stats.streak', {
    description: 'Current streak (consecutive active days)',
    unit: '{days}',
    valueType: ValueType.INT,
  })
  streakGauge.addCallback(obs => {
    if (latestSnapshot) obs.observe(latestSnapshot.streak)
  })

  const longestSessionGauge = meter.createObservableGauge('claude_stats.longest_session', {
    description: 'Longest session duration',
    unit: 'min',
    valueType: ValueType.INT,
  })
  longestSessionGauge.addCallback(obs => {
    if (latestSnapshot) obs.observe(latestSnapshot.longestSessionMinutes)
  })

  const activeProjectsGauge = meter.createObservableGauge('claude_stats.active_projects', {
    description: 'Number of active projects',
    unit: '{projects}',
    valueType: ValueType.INT,
  })
  activeProjectsGauge.addCallback(obs => {
    if (latestSnapshot) obs.observe(latestSnapshot.activeProjects)
  })

  // Per-model token counters
  const modelInputTokens = meter.createObservableCounter('claude_stats.tokens.by_model.input', {
    description: 'Input tokens by model',
    unit: '{tokens}',
    valueType: ValueType.INT,
  })
  modelInputTokens.addCallback(obs => {
    if (!latestSnapshot) return
    for (const [model, t] of Object.entries(latestSnapshot.modelTokens)) {
      obs.observe(t.input, { model })
    }
  })

  const modelOutputTokens = meter.createObservableCounter('claude_stats.tokens.by_model.output', {
    description: 'Output tokens by model',
    unit: '{tokens}',
    valueType: ValueType.INT,
  })
  modelOutputTokens.addCallback(obs => {
    if (!latestSnapshot) return
    for (const [model, t] of Object.entries(latestSnapshot.modelTokens)) {
      obs.observe(t.output, { model })
    }
  })

  // Per-tool call counter
  const toolCallsByTool = meter.createObservableCounter('claude_stats.tool_calls.by_tool', {
    description: 'Tool calls by tool name',
    unit: '{calls}',
    valueType: ValueType.INT,
  })
  toolCallsByTool.addCallback(obs => {
    if (!latestSnapshot) return
    for (const [tool, count] of Object.entries(latestSnapshot.toolCounts)) {
      obs.observe(count, { tool })
    }
  })

  // Per-harness metrics (backward-compatible additions)
  // These agentistics.harness.* metrics add a `harness` attribute so consumers
  // can track all AI assistants in a single dashboard, without touching the
  // existing claude_stats.* metrics above.

  const harnessSessions = meter.createObservableCounter('agentistics.harness.sessions.total', {
    description: 'Total sessions per harness (from consolidated store)',
    unit: '{sessions}',
    valueType: ValueType.INT,
  })
  harnessSessions.addCallback(obs => {
    if (!latestSnapshot) return
    for (const h of latestSnapshot.harnessSnapshots) {
      obs.observe(h.totalSessions, { harness: h.harness })
    }
  })

  const harnessInputTokens = meter.createObservableCounter('agentistics.harness.tokens.input', {
    description: 'Total input tokens per harness (includes cache reads/writes)',
    unit: '{tokens}',
    valueType: ValueType.INT,
  })
  harnessInputTokens.addCallback(obs => {
    if (!latestSnapshot) return
    for (const h of latestSnapshot.harnessSnapshots) {
      obs.observe(h.totalInputTokens, { harness: h.harness })
    }
  })

  const harnessOutputTokens = meter.createObservableCounter('agentistics.harness.tokens.output', {
    description: 'Total output tokens per harness',
    unit: '{tokens}',
    valueType: ValueType.INT,
  })
  harnessOutputTokens.addCallback(obs => {
    if (!latestSnapshot) return
    for (const h of latestSnapshot.harnessSnapshots) {
      obs.observe(h.totalOutputTokens, { harness: h.harness })
    }
  })

  const harnessCost = meter.createObservableCounter('agentistics.harness.cost.usd', {
    description: 'Estimated total cost in USD per harness',
    unit: 'USD',
    valueType: ValueType.DOUBLE,
  })
  harnessCost.addCallback(obs => {
    if (!latestSnapshot) return
    for (const h of latestSnapshot.harnessSnapshots) {
      obs.observe(h.totalCostUsd, { harness: h.harness })
    }
  })

  console.log(`[otel] Exporting metrics to ${OTLP_ENDPOINT} every ${WATCH_INTERVAL_SEC}s (service.name="${SERVICE_NAME}")`)

  return {
    shutdown: () => meterProvider.shutdown(),
  }
}

// File watcher

async function watchDirectory(dir: string, onChange: () => void): Promise<void> {
  const dirStat = await safeStat(dir)
  if (!dirStat?.isDirectory()) {
    console.warn(`[watcher] Directory not found: ${dir}`)
    return
  }

  const watcher = chokidar.watch(dir, {
    persistent: true,
    ignoreInitial: true,
  })
  watcher.on('all', onChange)
  watcher.on('error', (err: unknown) => {
    console.warn(`[watcher] Watch error on ${dir}:`, String(err))
  })
  console.log(`[watcher] Watching ${dir}`)
}

// Snapshot rebuild serialization

let snapshotInFlight = false
let snapshotPending = false

async function rebuildSnapshot(): Promise<void> {
  if (snapshotInFlight) {
    // Another rebuild is running — schedule a follow-up after it finishes
    snapshotPending = true
    return
  }

  snapshotInFlight = true
  try {
    latestSnapshot = await buildSnapshot()
    const harnessLine = latestSnapshot.harnessSnapshots
      .filter(h => h.totalSessions > 0)
      .map(h => `${h.harness}=${h.totalSessions}s/$${h.totalCostUsd.toFixed(2)}`)
      .join(' ')
    console.log(`[snapshot] Messages=${latestSnapshot.totalMessages} Sessions=${latestSnapshot.totalSessions} Cost=$${latestSnapshot.totalCostUsd.toFixed(2)} Streak=${latestSnapshot.streak}d Projects=${latestSnapshot.activeProjects}${harnessLine ? ` | ${harnessLine}` : ''}`)
  } catch (err) {
    console.error('[snapshot] Error:', String(err))
  } finally {
    snapshotInFlight = false
    // If another trigger came in while we were building, run again
    if (snapshotPending) {
      snapshotPending = false
      void rebuildSnapshot()
    }
  }
}

// Main

async function main() {
  // The hardware surface asks whether the watcher is running. Under `agentop server` it runs INSIDE
  // that process, so there is no pid to find — see watcher-state.ts.
  markOtelWatcherHosted()
  console.log('╔══════════════════════════════════════════════╗')
  console.log('║       Claude Stats — Watcher / Daemon       ║')
  console.log('╚══════════════════════════════════════════════╝')
  console.log()
  console.log(`  Home:       ${HOME_DIR}`)
  console.log(`  Claude dir: ${CLAUDE_DIR}`)
  console.log(`  Interval:   ${WATCH_INTERVAL_SEC}s`)
  console.log(`  OTLP:       ${OTLP_ENDPOINT || '(disabled)'}`)
  console.log()

  // Setup OpenTelemetry export FIRST, because it decides whether the snapshot is worth building.
  const otel = setupOtel()

  // THE SNAPSHOT HAS EXACTLY ONE CONSUMER: the observable callbacks `setupOtel` registers. With no
  // `OTEL_EXPORTER_OTLP_ENDPOINT` it returns null, registers nothing, and `latestSnapshot` is then
  // read by no one — so everything below was a full scan of every transcript on the machine,
  // rebuilt on every file change AND every 30 seconds, forever, feeding a variable nothing looks
  // at.
  //
  // Under `agentop server` this module runs INSIDE the HTTP server's process (cli.ts imports
  // both), so it also stood up a SECOND set of chokidar watchers on the two directories `sse.ts`
  // already watches there.
  //
  // What is MEASURED is the work, not a memory number: with a warm parse cache, skipping this loop
  // moved peak RSS by ~6% (492 MB → 461 MB over 120s on an 862 MB store), because the cache makes
  // an unchanged file cheap to re-scan. The cost it certainly removes is the scan itself — every
  // 30 seconds, forever, plus one per file change — and the two duplicate watchers. On a COLD
  // cache, or the first run after Claude rewrites its transcripts, that scan is the expensive one.
  // The honest claim is that this is work with no consumer, not that it was the whole 1 GB.
  //
  // The daemon still runs: the session-event producer below is the other reason it exists, it is
  // needed whether or not anyone exports metrics, and it does not read the snapshot.
  if (otel) {
    // Initial snapshot
    await rebuildSnapshot()

    // Debounce: after a file change, wait a short delay before rebuilding
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const DEBOUNCE_MS = 2000

    const triggerUpdate = () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => rebuildSnapshot(), DEBOUNCE_MS)
    }

    // Watch directories for changes
    await Promise.all([
      watchDirectory(SESSION_META_DIR, triggerUpdate),
      watchDirectory(PROJECTS_DIR, triggerUpdate),
    ])

    // Also do periodic polling as a fallback (chokidar can miss events in some edge cases)
    setInterval(() => rebuildSnapshot(), WATCH_INTERVAL_SEC * 1000)
  } else {
    // Said out loud, because "metrics export disabled" alone reads as "the numbers are not sent"
    // rather than "the numbers are not computed", and someone reading the log should be able to
    // tell that this process is now cheap.
    console.log('[otel] Snapshot loop not started — nothing would read it. The event producer still runs.')
  }

  // The session-event producer rides along here rather than being its own service: it has to be
  // long-lived to tell a working session from a finished one (see events/producer.ts), and a
  // separate process the user must remember to start is a process that will be dead at the moment
  // it matters. Never fatal to this daemon — see events/daemon.ts.
  const { startEventProducer } = await import('./events/daemon')
  const events = await startEventProducer()

  // The scheduled backup rides along for the same reason the event producer does — see
  // backup/daemon.ts. Never fatal to this daemon.
  const { startScheduledBackup } = await import('./backup/daemon')
  const backups = startScheduledBackup()

  console.log('[watcher] Running — use `bun run dev` in a separate terminal for the dashboard UI')

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[watcher] Shutting down...')
    await events?.stop()
    backups?.stop()
    if (otel) await otel.shutdown()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
