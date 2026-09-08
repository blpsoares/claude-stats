import { canonicalTool, countGitCommands } from '../harness-activity'
import type { SessionMeta, TurnEvent } from '@agentistics/core'
import { activeMinutesOf, charCount } from '@agentistics/core'

/** Pure: parse a Gemini CLI chat file (rich JSON format or JSONL streaming format) into a
 *  normalized SessionMeta. Returns null when the content has no usable data.
 *
 *  Rich JSON format (the real format used by Gemini CLI >= 0.1.x):
 *  - Top-level object: {sessionId, projectHash, startTime, lastUpdated, messages:[...]}
 *  - Each message has: id, timestamp, type ('user'|'gemini'|'info'), content (string or [{text}])
 *  - 'gemini' messages carry: tokens{input,output,cached,thoughts,tool,total}, model, toolCalls[{id,name,...}]
 *
 *  JSONL streaming format (older format, now primarily used for automation stubs):
 *  - Line 0 is a header: {sessionId, projectHash, startTime, lastUpdated, kind}
 *  - Subsequent lines alternate between header state updates and MongoDB-style ops:
 *    {"$set":{"messages":[{id, timestamp, type:"user"|"model"|"gemini"|..., content:[{text}]}]}}
 *  - The messages array is a snapshot; we accumulate all unique messages across all $set lines.
 */
export function parseGeminiChat(
  content: string,
  fallbackId: string,
  projectPath: string,
): SessionMeta | null {
  const trimmed = content.trim()
  if (!trimmed) return null

  const firstChar = trimmed[0]
  if (firstChar !== '{') return null

  const firstNewline = trimmed.indexOf('\n')
  if (firstNewline === -1) {
    // Single-line JSON — rare edge case
    return parseRichJson(trimmed, fallbackId, projectPath)
  }

  // Multi-line: check if it's a rich JSON object (has multiple lines but is still a JSON object)
  // vs a JSONL file (each line is a separate JSON object).
  // Heuristic: try to parse the whole thing as a single JSON object first.
  // If it parses successfully and has a `messages` array → rich JSON.
  // Otherwise fall back to JSONL streaming format.
  let parsed: any
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    parsed = null
  }

  if (parsed !== null && Array.isArray(parsed.messages)) {
    return parseRichJson(trimmed, fallbackId, projectPath)
  }

  // JSONL streaming format
  return parseJsonl(trimmed, fallbackId, projectPath)
}

// ---------------------------------------------------------------------------
// Rich JSON format: {sessionId, startTime, lastUpdated, messages:[...]}
// Each 'gemini' message may carry tokens{input,output,cached,...} and model.
// ---------------------------------------------------------------------------

function parseRichJson(content: string, fallbackId: string, projectPath: string): SessionMeta | null {
  let parsed: any
  try { parsed = JSON.parse(content) } catch { return null }

  const startTime = (parsed.startTime as string | undefined) ?? ''
  const lastUpdated = (parsed.lastUpdated as string | undefined) ?? ''

  // Summed in the SAME branch that increments the count beside it — see `promptChars.ts`.
  let userChars = 0, userCharMsgs = 0, assistantChars = 0, assistantCharMsgs = 0
  let userMessages = 0
  let assistantMessages = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let model: string | undefined
  let firstPrompt = ''
  const messageHours: number[] = []
  const userMessageTimestamps: string[] = []
  const toolCounts: Record<string, number> = {}
  let gitCommits = 0, gitPushes = 0
  let hasGenuineContent = false
  // Per-turn timeline for computeActiveTime() (docs/harness-contract.md). Gemini records no
  // duration of its own, so every turn is reconstructed from the message timestamps: a genuine
  // user message opens a turn, the model's last message before the next prompt closes it.
  const turnEvents: TurnEvent[] = []

  if (Array.isArray(parsed.messages)) {
    for (const msg of parsed.messages) {
      const msgType = msg.type as string | undefined
      const timestamp = msg.timestamp as string | undefined
      const tsMs = timestamp ? Date.parse(timestamp) : NaN
      let turnEvent: TurnEvent | null = null
      if (!Number.isNaN(tsMs)) {
        turnEvent = { ts: tsMs }
        turnEvents.push(turnEvent)
      }

      if (msgType === 'gemini') {
        // Extract token data from the rich format
        const tokens = msg.tokens
        if (tokens && typeof tokens === 'object') {
          inputTokens += (tokens.input as number | undefined) ?? 0
          outputTokens += (tokens.output as number | undefined) ?? 0
          cacheRead += (tokens.cached as number | undefined) ?? 0
        }

        // Track model (last seen wins, all should be the same)
        if (typeof msg.model === 'string' && msg.model) {
          model = msg.model
        }

        // Tool calls. The name goes through `canonicalTool` so Gemini's `run_shell_command` and
        // `read_file` sit in the same buckets as every other harness's equivalents — the tools
        // breakdown compares harnesses, and it cannot while each one uses its own words.
        if (Array.isArray(msg.toolCalls)) {
          for (const tc of msg.toolCalls) {
            const name = tc.name as string | undefined
            if (!name) continue
            const shared = canonicalTool('gemini', name)
            toolCounts[shared] = (toolCounts[shared] ?? 0) + 1

            // A shell call carries its command in `args.command` — verified against real chat
            // files. This is what lets Gemini report commits at all; it reported 0 not because the
            // data was missing but because nothing here ever looked.
            if (shared === 'Bash') {
              const args = tc.args as Record<string, unknown> | undefined
              const cmd = typeof args?.command === 'string' ? args.command : ''
              if (cmd) {
                const g = countGitCommands(cmd)
                gitCommits += g.commits
                gitPushes += g.pushes
              }
            }
          }
        }

        hasGenuineContent = true
        assistantMessages++
        { const n = charCount(extractMessageText(msg)); if (n > 0) { assistantChars += n; assistantCharMsgs++ } }

        if (timestamp) {
          const h = new Date(timestamp).getHours()
          if (!isNaN(h)) messageHours.push(h)
        }
      } else if (msgType === 'user') {
        const text = extractMessageText(msg)
        if (isGenuineUserMessage(text)) {
          hasGenuineContent = true
          userMessages++
          { const n = charCount(text); if (n > 0) { userChars += n; userCharMsgs++ } }
          if (turnEvent) turnEvent.userPrompt = true

          if (!firstPrompt && text) {
            // Use displayContent if available (stripped of injected file contents)
            const displayText = extractDisplayText(msg)
            firstPrompt = (displayText || text).slice(0, 200)
          }

          if (timestamp) {
            userMessageTimestamps.push(timestamp)
            const h = new Date(timestamp).getHours()
            if (!isNaN(h)) messageHours.push(h)
          }
        }
      }
      // 'info' messages are skipped entirely
    }
  }

  if (!hasGenuineContent) return null

  const durationMinutes = startTime && lastUpdated
    ? Math.max(0, (new Date(lastUpdated).getTime() - new Date(startTime).getTime()) / 60000)
    : 0

  return {
    session_id: fallbackId,
    project_path: projectPath,
    start_time: startTime || lastUpdated || '',
    end_time: lastUpdated || undefined,
    duration_minutes: durationMinutes,
    active_minutes: activeMinutesOf(turnEvents),
    user_message_count: userMessages,
    user_chars: userChars,
    user_char_messages: userCharMsgs,
    assistant_message_count: assistantMessages,
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
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: 0,
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
    message_hours: messageHours,
    user_message_timestamps: userMessageTimestamps,
    model,
    harness: 'gemini',
    _source: 'jsonl',
  }
}

// ---------------------------------------------------------------------------
// JSONL streaming format (automation stubs / bootstrap files)
// ---------------------------------------------------------------------------

function parseJsonl(content: string, fallbackId: string, projectPath: string): SessionMeta | null {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return null

  let startTime = ''
  let lastUpdated = ''

  // Accumulate unique messages by id across all $set snapshots
  const seenIds = new Set<string>()
  const allMessages: Array<{ type: string; timestamp?: string; text?: string }> = []

  // One message, from either source, counted once. `seenIds` spans BOTH: a resumed session's
  // opening snapshot repeats turns that then arrive again as their own lines, and counting those
  // twice would inflate every message count in the product.
  const take = (msg: any): void => {
    if (!msg || typeof msg !== 'object') return
    const id = msg.id as string | undefined
    if (id !== undefined) {
      if (seenIds.has(id)) return
      seenIds.add(id)
    }
    allMessages.push({
      type: msg.type as string,
      timestamp: msg.timestamp as string | undefined,
      text: extractMessageText(msg),
    })
  }

  for (const raw of lines) {
    let parsed: any
    try { parsed = JSON.parse(raw) } catch { continue }

    // Header line: {sessionId, projectHash, startTime, lastUpdated, kind}
    if (parsed.sessionId !== undefined || parsed.startTime !== undefined) {
      if (parsed.startTime) {
        if (!startTime || parsed.startTime < startTime) startTime = parsed.startTime as string
      }
      if (parsed.lastUpdated) {
        if (!lastUpdated || parsed.lastUpdated > lastUpdated) lastUpdated = parsed.lastUpdated as string
      }
      continue
    }

    // MongoDB-style state op: {"$set": {"messages": [...]}}
    const messages = parsed['$set']?.messages
    if (Array.isArray(messages)) {
      for (const msg of messages) take(msg)
      continue
    }

    // A `$set` that carries anything else is a PATCH of the session's own fields — the journal
    // writes `{"$set":{"lastUpdated":…}}` after every turn — and a patch is not a message.
    if (parsed['$set'] !== undefined) continue

    // AN APPENDED MESSAGE RECORD, which is how the journal writes a turn today.
    //
    // The snapshot above is written ONCE, at the top of the file, and is EMPTY for a fresh session;
    // every turn afterwards arrives as its own top-level line. Reading only the snapshot therefore
    // collected nothing at all, `hasGenuineContent` stayed false, and the session was dropped as a
    // bootstrap stub — measured 2026-09-08 on this machine, 27 of 34 chat files, and an adapter
    // whose newest session was from 2026-04-10.
    //
    // `type` is what makes it a message rather than some future record shape: an unrecognised line
    // is skipped, exactly as one that will not parse is, because inventing a turn is the expensive
    // direction here — this count is what decides whether the session exists at all.
    if (typeof parsed.type === 'string') take(parsed)
  }

  return buildJsonlSessionMeta({
    projectPath,
    startTime,
    endTime: lastUpdated,
    messages: allMessages,
    fallbackId,
  })
}

// ---------------------------------------------------------------------------
// Shared builder for JSONL streaming format
// ---------------------------------------------------------------------------

interface JsonlParsedData {
  projectPath: string
  startTime: string
  endTime: string
  messages: Array<{ type: string; timestamp?: string; text?: string }>
  fallbackId: string
}

function buildJsonlSessionMeta(data: JsonlParsedData): SessionMeta | null {
  const { projectPath, startTime, endTime, messages } = data

  // Summed in the SAME branch that increments the count beside it — see `promptChars.ts`.
  let userChars = 0, userCharMsgs = 0, assistantChars = 0, assistantCharMsgs = 0
  let userMessages = 0
  let assistantMessages = 0
  const messageHours: number[] = []
  const userMessageTimestamps: string[] = []
  let hasGenuineContent = false
  // Same reconstruction as parseRichJson — see computeActiveTime() / docs/harness-contract.md.
  const turnEvents: TurnEvent[] = []
  // The session's LABEL. `sessionLabel()` falls back to `first_prompt` when a harness writes no
  // title, and gemini writes none — so leaving this empty, as this path did, gives every gemini
  // session a blank name in every list it appears in. Taken from the FIRST message that already
  // passed `isGenuineUserMessage`, so an injected context block never becomes the title.
  let firstPrompt = ''

  for (const msg of messages) {
    const isUser = msg.type === 'user'
    const isAssistant = msg.type === 'model' || msg.type === 'gemini'

    const tsMs = msg.timestamp ? Date.parse(msg.timestamp) : NaN
    let turnEvent: TurnEvent | null = null
    if (!Number.isNaN(tsMs)) {
      turnEvent = { ts: tsMs }
      turnEvents.push(turnEvent)
    }

    let counted = false
    if (isAssistant) {
      hasGenuineContent = true
      assistantMessages++
      { const n = charCount(msg.text ?? ''); if (n > 0) { assistantChars += n; assistantCharMsgs++ } }
      counted = true
    } else if (isUser && isGenuineUserMessage(msg.text ?? '')) {
      hasGenuineContent = true
      if (!firstPrompt) firstPrompt = (msg.text ?? '').trim()
      userMessages++
      { const n = charCount(msg.text ?? ''); if (n > 0) { userChars += n; userCharMsgs++ } }
      if (turnEvent) turnEvent.userPrompt = true
      if (msg.timestamp) userMessageTimestamps.push(msg.timestamp)
      counted = true
    }

    if (counted && msg.timestamp) {
      const h = new Date(msg.timestamp).getHours()
      if (!isNaN(h)) messageHours.push(h)
    }
  }

  if (!hasGenuineContent) return null

  const durationMinutes = startTime && endTime
    ? Math.max(0, (new Date(endTime).getTime() - new Date(startTime).getTime()) / 60000)
    : 0

  return {
    session_id: data.fallbackId,
    project_path: projectPath,
    start_time: startTime || endTime || '',
    end_time: endTime || undefined,
    duration_minutes: durationMinutes,
    active_minutes: activeMinutesOf(turnEvents),
    user_message_count: userMessages,
    user_chars: userChars,
    user_char_messages: userCharMsgs,
    assistant_message_count: assistantMessages,
    assistant_chars: assistantChars,
    assistant_char_messages: assistantCharMsgs,
    tool_counts: {},
    tool_output_tokens: {},
    agent_file_reads: {},
    languages: [],
    git_commits: 0,
    git_pushes: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
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
    message_hours: messageHours,
    user_message_timestamps: userMessageTimestamps,
    model: undefined,
    harness: 'gemini',
    _source: 'jsonl',
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the text content from a message object (handles both array and string forms). */
function extractMessageText(msg: any): string {
  const content = msg.content
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c === 'object' && c !== null ? c.text ?? '' : '')).join('')
  }
  if (typeof content === 'string') return content
  return ''
}

/** Extract the display text from a message (user-visible portion only, skipping injected context). */
function extractDisplayText(msg: any): string {
  const display = msg.displayContent
  if (Array.isArray(display)) {
    return display.map((c: any) => (typeof c === 'object' && c !== null ? c.text ?? '' : '')).join('')
  }
  return ''
}

/** Returns true when a user message is a genuine user message (not a bootstrap injection). */
function isGenuineUserMessage(text: string): boolean {
  if (!text || text.trim() === '') return false
  if (text.includes('<session_context>')) return false
  if (text.includes('<environment_context>')) return false
  return true
}
