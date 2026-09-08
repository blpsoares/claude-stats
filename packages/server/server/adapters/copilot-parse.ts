import type { SessionMeta, TurnEvent } from '@agentistics/core'
import { activeMinutesOf, charCount } from '@agentistics/core'
import { canonicalTool, countGitCommands } from '../harness-activity'

/** Pure: parse a Copilot events.jsonl string into a normalized SessionMeta.
 *  Returns null when the content has no usable lines. */
export function parseCopilotEvents(content: string, fallbackId: string): SessionMeta | null {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return null

  let sessionId = ''
  let cwd = ''
  let startTime = ''
  let endTime = ''
  // Summed in the SAME branch that increments the count beside it — see `promptChars.ts`.
  let userChars = 0, userCharMsgs = 0, assistantChars = 0, assistantCharMsgs = 0
  let userMessages = 0
  let assistantTurns = 0
  let toolErrors = 0
  const toolCounts: Record<string, number> = {}
  let gitCommits = 0, gitPushes = 0
  let usesMcp = false
  let firstPrompt = ''
  let mcpToolCallCount = 0
  const mcpToolNamesSet = new Set<string>()

  // Enriched fields from session.shutdown (clean-exit only)
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let model: string | undefined = undefined
  let linesAdded = 0
  let linesRemoved = 0
  let filesModified = 0

  const userMessageTimestamps: string[] = []
  const messageHours: number[] = []
  // Per-turn timeline for computeActiveTime() (docs/harness-contract.md). Copilot brackets every
  // turn itself: `assistant.turn_start` opens one, `assistant.turn_end` closes it, and an `abort` /
  // `session.shutdown` closes one the CLI never got to end. The bracket span IS the measurement, so
  // it is expressed as open/close markers and computeActiveTime does the arithmetic — computing the
  // span here too would be a second source of truth for one number.
  const turnEvents: TurnEvent[] = []

  for (const raw of lines) {
    let e: any
    try { e = JSON.parse(raw) } catch { continue }

    const type = e.type as string | undefined
    const data = (e.data && typeof e.data === 'object') ? e.data : {}
    const ts: string | undefined = typeof e.timestamp === 'string' ? e.timestamp : undefined

    if (ts) {
      if (!startTime) startTime = ts
      endTime = ts
    }
    let turnEvent: TurnEvent | null = null
    const tsMs = ts ? Date.parse(ts) : NaN
    if (!Number.isNaN(tsMs)) {
      turnEvent = { ts: tsMs }
      turnEvents.push(turnEvent)
    }

    if (type === 'session.start') {
      sessionId = data.sessionId ?? sessionId
      // prefer startTime from data if present (more accurate)
      if (typeof data.startTime === 'string') startTime = data.startTime
      const ctx = data.context
      if (ctx && typeof ctx === 'object') {
        cwd = ctx.cwd ?? cwd
      }
    } else if (type === 'user.message') {
      userMessages++
      { const n = charCount(typeof data.content === 'string' ? data.content : '')
        if (n > 0) { userChars += n; userCharMsgs++ } }
      if (ts) {
        userMessageTimestamps.push(ts)
        messageHours.push(new Date(ts).getHours())
      }
      // Capture first user prompt
      if (!firstPrompt && typeof data.content === 'string') {
        firstPrompt = data.content.trim().slice(0, 500)
      }
    } else if (type === 'assistant.message') {
      // THE ASSISTANT'S CHARACTERS COUNT THEMSELVES, on the event that carries the words.
      //
      // `assistant.turn_start` below is the TURN counter and holds no text — dividing characters by
      // it would be a division whose halves describe different sets, which is the defect
      // `promptChars.ts` records having measured on Claude. `data.content` is the same field
      // `copilot-chat.ts` reads for the bubble, so the two agree about what was said.
      { const n = charCount(typeof data.content === 'string' ? data.content : '')
        if (n > 0) { assistantChars += n; assistantCharMsgs++ } }
    } else if (type === 'assistant.turn_start') {
      assistantTurns++
      if (turnEvent) turnEvent.userPrompt = true
    } else if (type === 'assistant.turn_end') {
      if (turnEvent) turnEvent.turnEnd = true
    } else if (type === 'session.info') {
      if (data.infoType === 'mcp') usesMcp = true
    } else if (type === 'abort') {
      // The turn ended here even though no turn_end was written (the user aborted it). Without
      // this the open turn would run to the last line of the file, which can be hours of idle —
      // measured on a real session: aborted at 20:13:05, file ends 23:34.
      if (turnEvent) turnEvent.turnEnd = true
    } else if (type === 'session.error') {
      toolErrors++
    } else if (type === 'tool.execution_start') {
      // Copilot names its tool and hands over its arguments here. This is why the capability table
      // said `tools: false` for years while the data was sitting in the transcript.
      const raw = typeof data.toolName === 'string' ? data.toolName : ''
      if (raw) {
        const toolName = canonicalTool('copilot', raw)
        toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1
        if (toolName === 'Bash') {
          const args = data.arguments as Record<string, unknown> | undefined
          const cmd = typeof args?.command === 'string' ? args.command : ''
          if (cmd) {
            const g = countGitCommands(cmd)
            gitCommits += g.commits
            gitPushes += g.pushes
          }
        }
      }
    } else if (type === 'mcp.tool_call') {
      mcpToolCallCount++
      if (typeof data.toolName === 'string' && data.toolName) {
        mcpToolNamesSet.add(data.toolName)
      }
    } else if (type === 'session.shutdown') {
      // The CLI exited: any turn still open ended here, not at whatever line closes the file.
      if (turnEvent) turnEvent.turnEnd = true
      // Extract per-model token metrics — sum across all models present
      const modelMetrics = data.modelMetrics
      if (modelMetrics && typeof modelMetrics === 'object') {
        for (const [, metrics] of Object.entries(modelMetrics) as [string, any][]) {
          const usage = metrics?.usage
          if (usage && typeof usage === 'object') {
            inputTokens += (usage.inputTokens as number | undefined) ?? 0
            outputTokens += (usage.outputTokens as number | undefined) ?? 0
            cacheReadTokens += (usage.cacheReadTokens as number | undefined) ?? 0
            cacheWriteTokens += (usage.cacheWriteTokens as number | undefined) ?? 0
          }
        }
      }
      // Current model at shutdown
      if (typeof data.currentModel === 'string') {
        model = data.currentModel
      }
      // Code changes
      const cc = data.codeChanges
      if (cc && typeof cc === 'object') {
        linesAdded = (cc.linesAdded as number | undefined) ?? 0
        linesRemoved = (cc.linesRemoved as number | undefined) ?? 0
        const fm = cc.filesModified
        filesModified = Array.isArray(fm) ? fm.length : ((fm as number | undefined) ?? 0)
      }
    }
  }

  const durationMinutes = startTime && endTime
    ? Math.max(0, (new Date(endTime).getTime() - new Date(startTime).getTime()) / 60000)
    : 0

  return {
    session_id: sessionId || fallbackId,
    project_path: cwd,
    start_time: startTime || endTime || '',
    end_time: endTime || undefined,
    duration_minutes: durationMinutes,
    active_minutes: activeMinutesOf(turnEvents),
    user_message_count: userMessages,
    user_chars: userChars,
    user_char_messages: userCharMsgs,
    assistant_message_count: assistantTurns,
    assistant_chars: assistantChars,
    assistant_char_messages: assistantCharMsgs,
    tool_counts: toolCounts,
    tool_output_tokens: {},
    agent_file_reads: {},
    languages: [],
    git_commits: gitCommits,
    git_pushes: gitPushes,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_input_tokens: cacheWriteTokens,
    first_prompt: firstPrompt,
    user_interruptions: 0,
    user_response_times: [],
    tool_errors: toolErrors,
    tool_error_categories: {},
    uses_task_agent: false,
    uses_mcp: usesMcp,
    uses_web_search: false,
    uses_web_fetch: false,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
    files_modified: filesModified,
    message_hours: messageHours,
    user_message_timestamps: userMessageTimestamps,
    model,
    harness: 'copilot',
    _source: 'jsonl',
    mcp_tool_call_count: mcpToolCallCount,
    mcp_tool_names: mcpToolNamesSet.size > 0 ? Array.from(mcpToolNamesSet) : undefined,
  }
}

/** The flat `key: value` block Copilot writes next to each session's events. Not YAML in general —
 *  every value here is a scalar on one line — so a hand-rolled reader avoids a dependency and
 *  cannot be tripped by nested structures it would not know what to do with anyway. */
export interface CopilotWorkspace {
  cwd?: string
  /** `owner/name` as GitHub reports it. */
  repository?: string
  /** `github` for github.com; anything else is an enterprise host we cannot name from here. */
  hostType?: string
  branch?: string
  /** Session name. Copilot auto-generates one (`user_named: false`) unless the user renamed it. */
  name?: string
}

export function parseCopilotWorkspace(text: string): CopilotWorkspace {
  const out: CopilotWorkspace = {}
  for (const line of text.split('\n')) {
    const sep = line.indexOf(':')
    if (sep <= 0 || line.startsWith(' ') || line.startsWith('#')) continue
    const key = line.slice(0, sep).trim()
    let value = line.slice(sep + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!value) continue
    switch (key) {
      case 'cwd': out.cwd = value; break
      case 'repository': out.repository = value; break
      case 'host_type': out.hostType = value; break
      case 'branch': out.branch = value; break
      case 'name': out.name = value; break
      default: break
    }
  }
  return out
}

/** `repository` + `host_type` → the same protocol-less key every other harness is grouped by.
 *  Only github.com can be named with confidence; an enterprise host is not recorded here, and
 *  guessing one would file the sessions under a repo that does not exist. */
export function copilotGitRemote(ws: CopilotWorkspace): string | undefined {
  if (!ws.repository || ws.hostType !== 'github') return undefined
  return `github.com/${ws.repository}`
}
