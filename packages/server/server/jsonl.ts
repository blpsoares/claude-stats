import { readFile } from 'fs/promises'
import type { SessionMeta, TurnEvent } from '@agentistics/core'
import { activeMinutesOf } from '@agentistics/core'
import { getGitFileStats } from './git'
import { countGitCommands } from './harness-activity'
import { extractAgentMetrics } from './agent-metrics'
import { enrichFromSubagentTranscripts } from './subagent-metrics'
import { addDelta, editDelta, type EditDelta } from './edit-lines'

// File extension → language name (used when session-meta is absent)
export const EXT_TO_LANG: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
  mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rb: 'Ruby', go: 'Go', rs: 'Rust', java: 'Java',
  cs: 'C#', cpp: 'C++', cc: 'C++', cxx: 'C++', c: 'C', h: 'C', hpp: 'C++',
  php: 'PHP', swift: 'Swift', kt: 'Kotlin', scala: 'Scala',
  sh: 'Shell', bash: 'Shell', zsh: 'Shell',
  sql: 'SQL', html: 'HTML', css: 'CSS', scss: 'CSS', sass: 'CSS',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML',
  md: 'Markdown', mdx: 'Markdown',
  r: 'R', lua: 'Lua', dart: 'Dart', ex: 'Elixir', exs: 'Elixir',
  clj: 'Clojure', hs: 'Haskell', ml: 'OCaml', fs: 'F#',
  vue: 'Vue', svelte: 'Svelte',
}

// Agent-like instruction file patterns (basename matching)
export const AGENT_FILE_CATEGORY: Map<string, string> = new Map([
  ['claude.md', 'CLAUDE.md'],
  ['claude_instructions.md', 'CLAUDE.md'],
  ['agents.md', 'AGENTS.md'],
  ['codex.md', 'CODEX.md'],
  ['.cursorrules', '.cursorrules'],
  ['.cursorignore', 'cursor-config'],
  ['conventions.md', 'CONVENTIONS.md'],
  ['copilot-instructions.md', 'copilot-instructions'],
  ['.copilot-instructions.md', 'copilot-instructions'],
  ['.windsurfrules', '.windsurfrules'],
])

// Agent-like instruction file path patterns (directory-based matching)
// Use (^|\/) to match both absolute and relative paths
export const AGENT_PATH_PATTERNS: [RegExp, string][] = [
  [/(^|\/)\.claude\//i, '.claude/*'],
  [/(^|\/)\.github\/copilot-instructions/i, 'copilot-instructions'],
  [/(^|\/)\.cursor\//i, '.cursorrules'],
  [/(^|\/)\.windsurf\//i, '.windsurfrules'],
  [/(^|\/)AGENTS\.md$/i, 'AGENTS.md'],
  [/(^|\/)CLAUDE\.md$/i, 'CLAUDE.md'],
]

/** Classify a file path as an agent instruction file category or null */
export function classifyAgentFile(filePath: string): string | null {
  if (!filePath) return null
  const normalized = filePath.replace(/\\/g, '/')
  const basename = normalized.split('/').pop()?.toLowerCase() ?? ''

  const category = AGENT_FILE_CATEGORY.get(basename)
  if (category) return category

  for (const [pattern, cat] of AGENT_PATH_PATTERNS) {
    if (pattern.test(normalized)) return cat
  }

  return null
}

/** True when a `type: 'user'` entry is a HUMAN message rather than a tool result being fed back.
 *  A turn boundary depends on this distinction, and so does `user_message_count` — they must never
 *  disagree, hence one helper used by both the full parser and the standalone active-time pass. */
export function isHumanUserEntry(e: Record<string, unknown>): boolean {
  if (e.type !== 'user') return false
  const msgContent = (e.message as Record<string, unknown> | undefined)?.content
  const contentArr = Array.isArray(msgContent) ? msgContent as Record<string, unknown>[] : null
  const isPureToolResult = contentArr !== null && contentArr.length > 0 &&
    contentArr.every(p => p.type === 'tool_result')
  return !isPureToolResult
}

/**
 * Active time for a Claude transcript, computed on its own — see docs/harness-contract.md.
 *
 * `parseSessionJsonl` collects the same events inline during its single pass. This standalone
 * version exists for the `_source: 'meta'` path in data.ts: Claude's own session-meta files carry
 * no per-turn timing, so the value has to come from the transcript, and that path deliberately
 * does not run the full parser.
 */
/**
 * The context one `usage` record says was SENT — PURE.
 *
 * The three INPUT-side counters are the prompt: `input_tokens` is the uncached remainder and the
 * two cache figures are the rest of the same prefix. `output_tokens` is excluded — it came back,
 * it was not sent. `0` for a record with no input side, which callers read as "no reading" rather
 * than as an empty context.
 */
export function contextOfUsage(u: Record<string, number> | undefined): number {
  if (!u) return 0
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
}

/**
 * The LAST context reading in a Claude transcript — PURE, `undefined` when there is none.
 *
 * A sibling of `activeMinutesFromClaudeJsonl` and for the same reason: `session-meta` is the
 * preferred source and serves most Claude sessions, so a metric that exists only inside
 * `parseSessionJsonl` is a metric most sessions never get. That is the exact bug the comment on
 * the active-time branch in `data.ts` records; this function is what keeps the gauge out of it.
 */
export function contextTokensFromClaudeJsonl(lines: string[]): number | undefined {
  let last = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'assistant') continue
    const msg = e.message as Record<string, unknown> | undefined
    const sent = contextOfUsage(msg?.usage as Record<string, number> | undefined)
    if (sent > 0) last = sent
  }
  return last > 0 ? last : undefined
}

export function activeMinutesFromClaudeJsonl(lines: string[]): number | undefined {
  const events: TurnEvent[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(line) } catch { continue }
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN
    if (Number.isNaN(ts)) continue
    const event: TurnEvent = { ts }
    if (e.type === 'system' && e.subtype === 'turn_duration' && typeof e.durationMs === 'number') {
      event.measuredMs = e.durationMs
    } else if (isHumanUserEntry(e)) {
      event.userPrompt = true
    }
    events.push(event)
  }
  return activeMinutesOf(events)
}

export function makeEmptySession(
  sessionId: string,
  projectPath: string,
  startTime: string,
  firstPrompt: string,
  source: 'jsonl' | 'subdir'
): SessionMeta {
  return {
    session_id: sessionId,
    project_path: projectPath,
    start_time: startTime,
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
    first_prompt: firstPrompt,
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
    _source: source,
  }
}

/** Parse an entire JSONL session file and extract full metrics. */
/**
 * Walk a file's lines WITHOUT materialising them as an array.
 *
 * `content.split('\n')` allocates a second copy of every byte in the file, plus a string header
 * per line — and this parser used to do it TWICE on the same content (once for the main loop, once
 * for `extractAgentMetrics`). On a 25 MB transcript that is ~50 MB of strings for a file already
 * held whole in memory, and `scanProjects` runs 30 of these concurrently.
 *
 * Measured on a real store (862 MB of transcripts across 2.694 files): the boot warm-build peaked
 * at 1.095 MB RSS. The peak is what matters, not the settled figure — it is what makes a laptop
 * swap, and several agentop instances plus the assistants they are watching share that machine.
 *
 * A generator yields each line as it is found, so the peak holds one line at a time on top of the
 * file itself. `trim()` stays the caller's job — the two callers already do it, and doing it here
 * would allocate a second string per line for no gain.
 */
export function* iterLines(content: string): Generator<string> {
  let start = 0
  for (;;) {
    const nl = content.indexOf('\n', start)
    if (nl === -1) {
      if (start < content.length) yield content.slice(start)
      return
    }
    yield content.slice(start, nl)
    start = nl + 1
  }
}

export async function parseSessionJsonl(
  filePath: string,
  sessionId: string,
  fallbackPath: string,
  source: 'jsonl' | 'subdir'
): Promise<SessionMeta> {
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    return makeEmptySession(sessionId, fallbackPath, '', '', source)
  }

  let cwd = '', lastCwd = '', startTime = '', lastTime = '', firstPrompt = '', modelId = '', sessionTitle = ''
  let userMsgs = 0, assistantMsgs = 0, inputTokens = 0, outputTokens = 0
  let cacheReadTokens = 0, cacheCreationTokens = 0
  /**
   * How full the window was on the LAST turn — a gauge, reassigned rather than accumulated.
   *
   * The three input-side counters of one `usage` record ARE the prompt that turn sent: `input_tokens`
   * is the uncached remainder, and the two cache figures are the rest of the same prefix (see
   * `prompt-caching`: total prompt = input + cache_creation + cache_read). `output_tokens` is
   * deliberately excluded — it is what came back, not what was sent.
   *
   * Verified on a real transcript (2026-08-14, claude 2.1.232): 2 + 1.380 + 211.577 = 212.959.
   */
  let contextTokens = 0
  let gitCommits = 0, gitPushes = 0
  let toolErrors = 0, userInterruptions = 0
  let hasMcp = false
  const claudeFilesModified = new Set<string>()
  /** Lines this session's OWN edits changed — see `edit-lines.ts`. */
  let editLines: EditDelta = { added: 0, removed: 0 }
  const toolCounts: Record<string, number> = {}
  const toolOutputTokens: Record<string, number> = {}
  const agentFileReads: Record<string, number> = {}
  const toolErrorCategories: Record<string, number> = {}
  const messageHours: number[] = []
  const userMessageTimestamps: string[] = []
  const userResponseTimes: number[] = []
  const languageSet = new Set<string>()
  // Maps tool_use_id → tool name for error attribution
  const toolUseIdToName = new Map<string, string>()
  let lastAssistantTs = ''
  // Per-turn timeline feeding computeActiveTime() — see docs/harness-contract.md. Every
  // timestamped line advances the clock; only a genuine human message opens a turn; Claude Code's
  // own `system`/`turn_duration` line closes one with the duration IT measured.
  const turnEvents: TurnEvent[] = []

  for (const raw of iterLines(content)) {
    const line = raw.trim()
    if (!line) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(line) } catch { continue }

    // First cwd = the project the session belongs to; last cwd = where it is now. They differ when
    // the session moved (a git worktree), and the live-session detector needs the latter.
    if (e.cwd && typeof e.cwd === 'string') {
      if (!cwd) cwd = e.cwd
      lastCwd = e.cwd
    }
    // `as string` alone is a compile-time promise only — a malformed transcript line can carry a
    // number here just as Kimi's state.json did for its own timestamp fields (see
    // isoFromKimiTime/normalizeSessionTimes), and every consumer downstream calls a string method
    // on `startTime`/`endTime` (parseISO, .slice, .localeCompare). Verify the runtime type here,
    // at the one place this value enters the pipeline, rather than trusting it all the way down.
    const ts = typeof e.timestamp === 'string' ? e.timestamp : undefined
    let turnEvent: TurnEvent | null = null
    if (ts) {
      if (!startTime) startTime = ts
      lastTime = ts
      try { messageHours.push(new Date(ts).getHours()) } catch { /* skip */ }
      const tsMs = Date.parse(ts)
      if (!Number.isNaN(tsMs)) {
        turnEvent = { ts: tsMs }
        turnEvents.push(turnEvent)
      }
    }

    // Claude Code measures each turn itself and writes it out — that number beats anything we
    // could reconstruct, so it closes the open turn.
    if (e.type === 'system' && e.subtype === 'turn_duration' && typeof e.durationMs === 'number') {
      if (turnEvent) turnEvent.measuredMs = e.durationMs
      continue
    }

    // Claude writes the auto-generated session title as an `ai-title` line (current format)
    // or a `summary` line (legacy). ai-title can be regenerated as the chat grows, so the last
    // one wins; summary only fills the gap when no ai-title is present.
    if (e.type === 'ai-title' && typeof e.aiTitle === 'string' && e.aiTitle.trim()) {
      sessionTitle = e.aiTitle.trim()
      continue
    }
    if (e.type === 'summary' && typeof e.summary === 'string' && e.summary.trim()) {
      if (!sessionTitle) sessionTitle = e.summary.trim()
      continue
    }

    if (e.type === 'user') {
      const msgContent = (e.message as Record<string, unknown> | undefined)?.content
      const contentArr = Array.isArray(msgContent) ? msgContent as Record<string, unknown>[] : null

      // Tool result messages: content is an array where every item is type='tool_result'
      const isPureToolResult = !isHumanUserEntry(e)

      if (isPureToolResult) {
        // Count tool errors and attribute them to the originating tool
        for (const p of contentArr!) {
          if (p.is_error === true) {
            toolErrors++
            const toolName = toolUseIdToName.get(p.tool_use_id as string) ?? 'unknown'
            toolErrorCategories[toolName] = (toolErrorCategories[toolName] ?? 0) + 1
          }
        }
      } else {
        // Real human message (initial prompt or interruption) — this is what opens a turn.
        userMsgs++
        if (turnEvent) turnEvent.userPrompt = true
        if (ts) {
          userMessageTimestamps.push(ts)
          // Response time: how long since the last assistant message
          if (lastAssistantTs) {
            const delta = (new Date(ts).getTime() - new Date(lastAssistantTs).getTime()) / 1000
            if (delta >= 0 && delta < 3600) userResponseTimes.push(Math.round(delta))
          }
        }
        // All messages after the first count as interruptions
        if (userMsgs > 1) userInterruptions++

        if (!firstPrompt && contentArr) {
          for (const p of contentArr) {
            if (p.type === 'text' && typeof p.text === 'string') {
              firstPrompt = (p.text as string).slice(0, 200)
              break
            }
          }
        } else if (!firstPrompt && typeof msgContent === 'string') {
          firstPrompt = msgContent.slice(0, 200)
        }
      }
    } else if (e.type === 'assistant') {
      assistantMsgs++
      if (ts) lastAssistantTs = ts
      const msg = e.message as Record<string, unknown> | undefined
      if (!modelId && typeof msg?.model === 'string' && msg.model.startsWith('claude-')) modelId = msg.model
      const msgOutputTokens = (msg?.usage as Record<string, number> | undefined)?.output_tokens ?? 0
      if (msg?.usage) {
        const u = msg.usage as Record<string, number>
        inputTokens         += u.input_tokens ?? 0
        outputTokens        += u.output_tokens ?? 0
        cacheReadTokens     += u.cache_read_input_tokens ?? 0
        cacheCreationTokens += u.cache_creation_input_tokens ?? 0
        // LAST wins, and only when the record actually carries an input side. A synthetic record of
        // all zeros would otherwise reset a real reading to "context empty" on the final turn.
        const sent = contextOfUsage(u)
        if (sent > 0) contextTokens = sent
      }
      // Collect tool names in this message for token attribution
      const toolsInMessage: string[] = []
      if (Array.isArray(msg?.content)) {
        for (const p of msg!.content as Record<string, unknown>[]) {
          if (p.type === 'tool_use' && typeof p.name === 'string') {
            const toolName = p.name as string
            toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1
            toolsInMessage.push(toolName)

            // Track id→name for error attribution
            if (typeof p.id === 'string') toolUseIdToName.set(p.id, toolName)

            if (toolName.startsWith('mcp__')) hasMcp = true

            // Count git commits/pushes from Bash tool calls. The rule itself lives in
            // `harness-activity.ts` so every harness counts the same thing the same way — it used to
            // be inline here, which is why no adapter could reuse it and all of them reported 0.
            if (toolName === 'Bash') {
              const cmd = (p.input as Record<string, string> | undefined)?.command ?? ''
              const g = countGitCommands(cmd)
              gitCommits += g.commits
              gitPushes += g.pushes
            }

            // Detect language and agent files from file-based tool calls
            if (['Read', 'Edit', 'Write', 'MultiEdit'].includes(toolName)) {
              const inp = p.input as Record<string, string> | undefined
              const fp = inp?.file_path ?? inp?.path ?? ''
              if (fp) {
                const ext = fp.split('.').pop()?.toLowerCase() ?? ''
                const lang = EXT_TO_LANG[ext]
                if (lang) languageSet.add(lang)

                // Count files Claude directly wrote or edited (not git-based)
                if (['Edit', 'Write', 'MultiEdit'].includes(toolName)) {
                  claudeFilesModified.add(fp)
                  // …and the LINES, from the same call. See `edit-lines.ts`: the git-diff figure
                  // measures uncommitted work, so a session that commits as it goes reported
                  // `+0 / −0` beside a real file count.
                  editLines = addDelta(editLines, editDelta(toolName, p.input))
                }

                // Detect agent instruction file reads (Read tool only — Glob/Grep/Search
                // operate on patterns/queries rather than file paths, so they are excluded
                // to avoid false positives)
                if (toolName === 'Read') {
                  const agentCategory = classifyAgentFile(fp)
                  if (agentCategory) {
                    agentFileReads[agentCategory] = (agentFileReads[agentCategory] ?? 0) + 1
                  }
                }
              }
            }

          }
        }
      }
      // Attribute output tokens evenly among tools in this message
      if (toolsInMessage.length > 0 && msgOutputTokens > 0) {
        const share = Math.floor(msgOutputTokens / toolsInMessage.length)
        const remainder = msgOutputTokens % toolsInMessage.length
        for (let i = 0; i < toolsInMessage.length; i++) {
          const tn = toolsInMessage[i]
          if (tn === undefined) continue
          toolOutputTokens[tn] = (toolOutputTokens[tn] ?? 0) + share + (i < remainder ? 1 : 0)
        }
      }
    }
  }

  const durationMinutes = (startTime && lastTime)
    ? Math.max(0, Math.round((new Date(lastTime).getTime() - new Date(startTime).getTime()) / 60000))
    : 0

  const projectPath = cwd || fallbackPath
  const gitFileStats = gitCommits > 0
    ? await getGitFileStats(projectPath, startTime, lastTime)
    : { linesAdded: 0, linesRemoved: 0, filesModified: 0 }
  // Use whichever count is higher: git-tracked files changed or files Claude directly edited
  const filesModifiedCount = Math.max(gitFileStats.filesModified, claudeFilesModified.size)

  // Extract agent metrics if this session used the Agent tool.
  //
  // The parse alone can no longer produce the NUMBERS: since Claude Code made the Agent tool
  // asynchronous the parent transcript names the subagent and nothing else, so the invocations come
  // back marked `unmeasured` and are filled in from each subagent's own transcript, which sits
  // beside this file. See `subagent-metrics.ts`.
  const agentMetrics = toolCounts['Agent']
    ? await enrichFromSubagentTranscripts(extractAgentMetrics(iterLines(content), modelId), filePath, sessionId)
    : undefined

  return {
    session_id: sessionId,
    project_path: projectPath,
    ...(lastCwd && lastCwd !== projectPath ? { current_cwd: lastCwd } : {}),
    start_time: startTime,
    end_time: lastTime || undefined,
    duration_minutes: durationMinutes,
    active_minutes: activeMinutesOf(turnEvents),
    user_message_count: userMsgs,
    assistant_message_count: assistantMsgs,
    tool_counts: toolCounts,
    tool_output_tokens: toolOutputTokens,
    agent_file_reads: agentFileReads,
    languages: Array.from(languageSet),
    git_commits: gitCommits,
    git_pushes: gitPushes,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    // Absent rather than zero when nothing was measured — a confident "0% of the window" on a
    // session that simply recorded no usage is the same lie `HARNESS_CAPABILITIES` prevents.
    ...(contextTokens > 0 ? { context_tokens: contextTokens } : {}),
    first_prompt: firstPrompt,
    title: sessionTitle || undefined,
    user_interruptions: userInterruptions,
    user_response_times: userResponseTimes,
    tool_errors: toolErrors,
    tool_error_categories: toolErrorCategories,
    uses_task_agent: 'Task' in toolCounts || 'Agent' in toolCounts,
    uses_mcp: hasMcp,
    uses_web_search: 'WebSearch' in toolCounts,
    uses_web_fetch: 'WebFetch' in toolCounts,
    // The session's OWN edits win over the working-tree diff, and fall back to it: the diff is 0
    // for a session that committed its work, while the edits are what it actually changed. Taking
    // the larger keeps a session that edited outside git (or through the shell) from reporting less
    // than git can see — the same `Math.max` shape `filesModifiedCount` already uses, and for the
    // same reason.
    lines_added: Math.max(gitFileStats.linesAdded, editLines.added),
    lines_removed: Math.max(gitFileStats.linesRemoved, editLines.removed),
    files_modified: filesModifiedCount,
    message_hours: messageHours,
    user_message_timestamps: userMessageTimestamps,
    model: modelId || undefined,
    harness: 'claude',
    _source: source,
    agentMetrics,
  }
}
