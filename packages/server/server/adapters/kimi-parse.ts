import { isLocalModelId, charCount } from '@agentistics/core'
import { canonicalTool, countGitCommands } from '../harness-activity'
import type { SessionMeta, TurnEvent } from '@agentistics/core'
import { activeMinutesOf } from '@agentistics/core'

/**
 * Pure parser for Kimi Code CLI sessions.
 *
 * Layout (verified on disk):
 *   ~/.kimi-code/session_index.jsonl          → {sessionId, sessionDir, workDir} per session
 *   ~/.kimi-code/sessions/<workspace>/session_<uuid>/
 *       state.json                            → {title, workDir, createdAt, updatedAt, agents{}}
 *       agents/<agentId>/wire.jsonl           → the event stream
 *
 * The event stream is flat JSONL. Only two shapes matter:
 *   - `usage.record`             → {model, usage:{inputOther, output, inputCacheRead,
 *                                   inputCacheCreation}, usageScope:'turn', time}
 *   - `context.append_loop_event` → wraps the loop's own events at `.event.type`:
 *                                   step.begin / step.end / content.part / tool.call / tool.result
 *
 * DOUBLE-COUNTING TRAP: the nested `step.end` events carry a `usage` object that is byte-identical
 * to the matching top-level `usage.record` (verified pairwise on real data — summing both doubled
 * every figure). Only `usage.record` is counted here.
 */

export interface KimiState {
  title?: string
  workDir?: string
  /** Kimi writes this as an epoch NUMBER in most sessions and an ISO string in others — measured
   *  10 of 11 as numbers on a live machine. Both shapes are read; see `isoFromKimiTime`. */
  createdAt?: string | number
  /** Same inconsistency as `createdAt` — Kimi writes the same wire shape for both fields, so
   *  `updatedAt` is exactly as likely to arrive as an epoch number. It was typed `string` only
   *  and read raw (skipping `isoFromKimiTime`), which is what let a numeric `end_time` reach
   *  `SessionMeta` — a field the frontend calls `parseISO`/`.slice` on, unguarded, in several
   *  places. Same bug as `createdAt`, just not caught the first time. */
  updatedAt?: string | number
  /** agentId → {parentAgentId}. `main` has a null parent; subagents point at their parent. */
  agents?: Record<string, { parentAgentId?: string | null } | undefined>
}

/** Names of the agent directories to read, main first. A subagent's tokens belong to the session
 *  that spawned it, so every agent under one session folds into that single SessionMeta. */
export function kimiAgentIds(state: KimiState | null): string[] {
  const agents = state?.agents
  if (!agents) return ['main']
  const ids = Object.keys(agents)
  return ids.length ? ids : ['main']
}

export function parseKimiState(text: string): KimiState | null {
  try {
    const d = JSON.parse(text) as KimiState
    return d && typeof d === 'object' ? d : null
  } catch { return null }
}

/** `google/gemini-3.5-flash-lite` → `gemini-3.5-flash-lite`. Kimi routes to other providers and
 *  prefixes the alias; the bare id is what the pricing table is keyed by.
 *
 *  A LOCAL runtime's prefix is KEPT (`ollama-local/qwen2.5-coder-7b` stays whole). For a hosted
 *  model the prefix is noise the table does not want; for a local one it is the only thing saying
 *  the call was free, and stripping it left `qwen2.5-coder-7b` to be priced at the shared fallback
 *  — inventing spending for tokens that cost nothing. See `isLocalModelId`. */
export function stripProvider(model: string): string {
  if (isLocalModelId(model)) return model
  const slash = model.indexOf('/')
  return slash > 0 ? model.slice(slash + 1) : model
}

export interface KimiWireTotals {
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheCreation: number
  /** Model of the last usage record — the session's dominant label. */
  model?: string
  /**
   * How full the window was on the MAIN agent's last turn, and when that turn was.
   *
   * Two narrowings the accumulated totals do not need, both because this is a gauge:
   *
   *  - **Main agent only.** Every agent of a session folds into these totals, which is right for
   *    spend — a subagent's tokens are the session's tokens. It is wrong for a window: a subagent
   *    runs its own, usually far emptier, and reporting it as the session's would say the
   *    conversation you are looking at has plenty of room left when it does not.
   *  - **Latest by TIME, not last read.** The wires arrive one file after another, so "last seen"
   *    depends on directory order. `contextAtMs` makes the choice deterministic.
   */
  contextTokens?: number
  contextAtMs?: number
  userPrompts: number
  /** Characters the person wrote, and how many prompts they came from — see `promptChars.ts`. */
  userChars: number
  userCharMsgs: number
  assistantTurns: number
  toolCounts: Record<string, number>
  toolErrors: number
  gitCommits: number
  gitPushes: number
  usesMcp: boolean
  firstPrompt: string
  hours: number[]
  userTimestamps: string[]
  firstTimeMs: number
  lastTimeMs: number
  /** Per-turn timeline for computeActiveTime() (docs/harness-contract.md). Kimi records no
   *  duration of its own, so turns are reconstructed: a `turn.prompt` of origin `user` opens one,
   *  every later event advances the clock. A session's SUBAGENT wires are accumulated into this
   *  same list and run DURING the parent's turn, so the list is sorted by time before it is
   *  consumed — appending one agent's stream after another's would otherwise invent turns. */
  turnEvents: TurnEvent[]
}

/** A factory, not a shared constant: spreading a constant copies its array REFERENCES, so every
 *  call would append into the same `hours`/`userTimestamps` and totals would bleed between
 *  sessions. */
export function emptyKimiTotals(): KimiWireTotals {
  return {
    inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreation: 0,
    userPrompts: 0, userChars: 0, userCharMsgs: 0, assistantTurns: 0, toolCounts: {}, toolErrors: 0, gitCommits: 0, gitPushes: 0, usesMcp: false,
    firstPrompt: '', hours: [], userTimestamps: [], firstTimeMs: 0, lastTimeMs: 0, turnEvents: [],
  }
}

/** Accumulate one agent's wire.jsonl into `acc`. Malformed lines are skipped, never thrown on.
 *
 *  `main` marks the session's own agent, so only its turns feed the context gauge — see
 *  `KimiWireTotals.contextTokens`. Everything else accumulates from every agent as before. */
export function accumulateKimiWire(
  text: string,
  acc: KimiWireTotals = emptyKimiTotals(),
  opts: { main?: boolean } = {},
): KimiWireTotals {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let d: Record<string, unknown>
    try { d = JSON.parse(line) as Record<string, unknown> } catch { continue }

    const time = typeof d.time === 'number' ? d.time : 0
    let turnEvent: TurnEvent | null = null
    if (time > 0) {
      if (!acc.firstTimeMs || time < acc.firstTimeMs) acc.firstTimeMs = time
      if (time > acc.lastTimeMs) acc.lastTimeMs = time
      turnEvent = { ts: time }
      acc.turnEvents.push(turnEvent)
    }

    switch (d.type) {
      case 'usage.record': {
        const u = d.usage as Record<string, number> | undefined
        if (u) {
          acc.inputTokens += num(u.inputOther)
          acc.outputTokens += num(u.output)
          acc.cacheRead += num(u.inputCacheRead)
          acc.cacheCreation += num(u.inputCacheCreation)
          // The INPUT side of one per-turn record is that turn's prompt — the context that was
          // sent. `output` is excluded: it is what came back. `usageScope: 'turn'` is what makes
          // this a gauge rather than a running total.
          const sent = num(u.inputOther) + num(u.inputCacheRead) + num(u.inputCacheCreation)
          if (opts.main && sent > 0 && time >= (acc.contextAtMs ?? 0)) {
            acc.contextTokens = sent
            acc.contextAtMs = time
          }
        }
        if (typeof d.model === 'string' && d.model) acc.model = stripProvider(d.model)
        break
      }
      case 'turn.prompt': {
        // Only a real user turn counts; the CLI also replays prompts with other origins.
        const origin = d.origin as { kind?: string } | undefined
        if (origin?.kind && origin.kind !== 'user') break
        acc.userPrompts++
        { const n = charCount(textOfPrompt(d.input))
          if (n > 0) { acc.userChars += n; acc.userCharMsgs++ } }
        if (turnEvent) turnEvent.userPrompt = true
        if (time > 0) {
          const dt = new Date(time)
          acc.hours.push(dt.getHours()) // local clock, same convention as every other adapter
          acc.userTimestamps.push(dt.toISOString())
        }
        if (!acc.firstPrompt) acc.firstPrompt = textOfPrompt(d.input)
        break
      }
      case 'context.append_loop_event': {
        const ev = d.event as Record<string, unknown> | undefined
        if (!ev) break
        // NOTE: ev.usage on a step.end duplicates the usage.record above — deliberately ignored.
        if (ev.type === 'step.end') acc.assistantTurns++
        else if (ev.type === 'tool.call') {
          const name = typeof ev.name === 'string' ? ev.name : ''
          if (name) {
            // Kimi already uses the shared vocabulary (`Bash`, `Read`, `Edit`, …) — its own
            // `tools.set_active_tools` lists exactly those names — so canonicalTool is a no-op here
            // and is called anyway, so the day Kimi renames one this does not silently drift.
            const shared = canonicalTool('kimi', name)
            acc.toolCounts[shared] = (acc.toolCounts[shared] ?? 0) + 1
            if (name.startsWith('mcp__')) acc.usesMcp = true

            // The command it ran. `args.command` is not a guess: it is what Kimi's own tool schema
            // declares for Bash ("The command to execute"), read out of the `llm.tools_snapshot`
            // event in a real wire.
            if (shared === 'Bash') {
              const args = ev.args as Record<string, unknown> | undefined
              const cmd = typeof args?.command === 'string' ? args.command : ''
              if (cmd) {
                const g = countGitCommands(cmd)
                acc.gitCommits += g.commits
                acc.gitPushes += g.pushes
              }
            }
          }
        } else if (ev.type === 'tool.result') {
          if (isToolError(ev)) acc.toolErrors++
        }
        break
      }
      default: break
    }
  }
  return acc
}

function num(v: unknown): number { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }

function isToolError(ev: Record<string, unknown>): boolean {
  if (ev.isError === true || ev.error) return true
  const status = typeof ev.status === 'string' ? ev.status.toLowerCase() : ''
  if (status === 'error' || status === 'failed') return true
  const exit = ev.exitCode
  return typeof exit === 'number' && exit !== 0
}

/** `input` is a list of content parts; the text ones make the prompt. */
function textOfPrompt(input: unknown): string {
  if (!Array.isArray(input)) return ''
  return input
    .filter((p): p is { type?: string; text?: string } => !!p && typeof p === 'object')
    .map(p => (typeof p.text === 'string' ? p.text : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Build the SessionMeta. Returns null when nothing usable was recorded (no user turn at all),
 *  the same rule the Gemini adapter uses to drop bootstrap stubs. */
/** Kimi's `createdAt`, whatever shape it arrived in, as an ISO string.
 *
 *  A number here is an epoch in milliseconds. Letting it through as a number is not a cosmetic
 *  slip: `SessionMeta.start_time` is a STRING by contract, it is persisted to the consolidate store
 *  as written, and every consumer that slices it for a day (`supplementStatsCache`) throws on a
 *  number — one such session took the whole /api/data response down with a 500.
 *
 *  Anything unusable yields '' — the adapter's own way of saying "no start time", which the rest of
 *  the pipeline already handles. */
export function isoFromKimiTime(v: string | number | undefined): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? '' : d.toISOString()
  }
  return ''
}

export function buildKimiSession(
  sessionId: string,
  state: KimiState | null,
  totals: KimiWireTotals,
  workDirFallback = '',
): SessionMeta | null {
  if (totals.userPrompts === 0) return null

  const start = isoFromKimiTime(state?.createdAt)
    || (totals.firstTimeMs ? new Date(totals.firstTimeMs).toISOString() : '')
  const end = isoFromKimiTime(state?.updatedAt)
    || (totals.lastTimeMs ? new Date(totals.lastTimeMs).toISOString() : '')
  if (!start) return null

  const startMs = Date.parse(start)
  const endMs = Date.parse(end || start)
  const duration = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
    ? Math.round((endMs - startMs) / 60000)
    : 0

  const toolCalls = Object.values(totals.toolCounts).reduce((a, b) => a + b, 0)
  // Sorted: the events arrive one agent's wire at a time, but a subagent runs inside the parent's
  // turn — merging them chronologically is what keeps that from reading as extra turns.
  const activeMinutes = activeMinutesOf([...totals.turnEvents].sort((a, b) => a.ts - b.ts))

  return {
    session_id: sessionId,
    project_path: state?.workDir || workDirFallback,
    start_time: start,
    end_time: end || undefined,
    duration_minutes: duration,
    active_minutes: activeMinutes,
    user_message_count: totals.userPrompts,
    user_chars: totals.userChars,
    user_char_messages: totals.userCharMsgs,
    assistant_message_count: totals.assistantTurns,
    // NO `assistant_chars` FOR KIMI, and it is a finding rather than an omission.
    //
    // Kimi's assistant text is on `context.append_message`, and WHICH of those is the assistant is
    // decided by the `message.origin` kimi stamps — a classification that already exists, in
    // `kimi-chat.ts`. Counting it here would be a second implementation of that rule, in a module
    // that cannot see the first, and the two would drift; copilot needed no such rule, which is why
    // it HAS the field. So this is absent, the surface says N/A, and it becomes writable the day
    // the classification is shared rather than copied.
    tool_counts: totals.toolCounts,
    tool_output_tokens: {},
    agent_file_reads: {},
    languages: [],
    git_commits: totals.gitCommits,
    git_pushes: totals.gitPushes,
    input_tokens: totals.inputTokens,
    output_tokens: totals.outputTokens,
    cache_read_input_tokens: totals.cacheRead,
    cache_creation_input_tokens: totals.cacheCreation,
    ...(totals.contextTokens ? { context_tokens: totals.contextTokens } : {}),
    first_prompt: totals.firstPrompt,
    ...(state?.title ? { title: state.title } : {}),
    user_interruptions: 0,
    user_response_times: [],
    tool_errors: totals.toolErrors,
    tool_error_categories: totals.toolErrors ? { tool_result: totals.toolErrors } : {},
    uses_task_agent: !!totals.toolCounts['Agent'] || !!totals.toolCounts['AgentSwarm'],
    uses_mcp: totals.usesMcp,
    uses_web_search: !!totals.toolCounts['WebSearch'],
    uses_web_fetch: !!totals.toolCounts['WebFetch'],
    lines_added: 0,
    lines_removed: 0,
    files_modified: 0,
    message_hours: totals.hours,
    user_message_timestamps: totals.userTimestamps,
    ...(totals.model ? { model: totals.model } : {}),
    harness: 'kimi',
    _source: 'jsonl',
    ...(toolCalls === 0 ? {} : {}),
  } as SessionMeta
}
