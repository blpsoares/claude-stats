/**
 * copilot-chat.ts — PURE: a Copilot CLI session's `events.jsonl` lines → `ChatTurn[]`.
 *
 * No fs, no side effects. `harness-transcript.ts` finds the file and hands the lines over.
 *
 * ON-DISK SHAPE, measured 2026-09-05 over the 11 largest sessions on this machine
 * (`~/.copilot/session-state/<session-id>/events.jsonl`). `copilot-parse.ts` — the METRICS parser
 * — documents the envelope; what follows is the part a CONVERSATION needs. Counts:
 *
 *   assistant.turn_start 26   tool.execution_start 26   assistant.turn_end 24
 *   tool.execution_complete 24   assistant.message 22   session.start 11   user.message 11
 *   session.model_change 9   session.shutdown 7   system.message 4   session.error 4
 *   session.auto_mode_resolved 3   session.usage_checkpoint 2   abort 2
 *
 * Every line is `{type, data, id, timestamp, parentId}` — a real ISO `timestamp`, unlike kimi's
 * epoch milliseconds.
 *
 * THE TRAP HERE IS INSIDE ONE FIELD, not across two families. `user.message` carries BOTH
 * `data.content` — what the person typed — and `data.transformedContent`, the same text wrapped by
 * the harness in `<current_datetime>` and `<system_reminder>` blocks. `transformedContent` is the
 * longer, more "complete"-looking field and is exactly the wrong one: it puts the harness's
 * injected reminders inside the reader's own bubble, which is the defect `chat-envelope.ts` exists
 * to prevent for Claude. `content` is read; `transformedContent` never is.
 *
 * THE TOOL REQUESTS RIDE ON THE MESSAGE. `assistant.message.data.toolRequests` is
 * `[{toolCallId, name, arguments}]` with `arguments` a real OBJECT (codex's is a JSON string), so
 * one assistant turn is one line — no gathering, unlike codex, kimi and agy. The separate
 * `tool.execution_start` / `tool.execution_complete` events are the EXECUTION and are dropped: the
 * request already said what ran, and the completion carries the whole output.
 *
 * THINKING EXISTS, SOMETIMES, AND IS NEVER THE OPAQUE FIELD. `assistant.message.data` carries
 * `reasoningText` on 4 of the 22 measured, `reasoningOpaque` on 6 and `encryptedContent` on 2. Only
 * `reasoningText` can be shown; the other two are not thoughts this or any reader can read.
 *
 * `system.message` is the whole system prompt under `data.role: 'system'`. It becomes a note that
 * names the kind and never carries the body — the measured one opens "You are the GitHub Copilot
 * CLI…" and runs for pages.
 */

import type { HarnessId } from '@agentistics/core'
import { canonicalTool } from '../harness-activity'
import type { ChatTurn } from './chat-turn'
import { commandSummary } from './shell-writes'

interface CopilotLine {
  type?: unknown
  timestamp?: unknown
  data?: unknown
}

/**
 * The session-level events that are worth a note, and what each says.
 *
 * Everything not listed is not a turn: `assistant.turn_start`/`turn_end` bracket a turn the
 * `assistant.message` inside it already represents, `tool.execution_*` is the execution, and
 * `session.usage_checkpoint` / `session.auto_mode_resolved` / `session.start` are bookkeeping the
 * reader has no use for. A note for every one of those would be a status log, not a conversation.
 */
const EVENT_NOTES: Record<string, string> = {
  'system.message': 'the system prompt was set',
  'session.model_change': 'the model was changed',
  'session.error': 'the session reported an error',
  'abort': 'the turn was aborted',
  'session.shutdown': 'the session ended',
}

const DETAIL_KEYS = ['command', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url', 'intent', 'description']

export function toolDetailOf(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null
  const o = args as Record<string, unknown>
  for (const key of DETAIL_KEYS) {
    const v = o[key]
    if (typeof v === 'string' && v.trim() !== '') {
      // Summarised past its `cd`, the same call every other reader here makes.
      if (key === 'command') return commandSummary(v)
      const line = v.trim().split('\n')[0]!
      return line.length > 200 ? `${line.slice(0, 200)}…` : line
    }
  }
  return null
}

function toolsOf(data: Record<string, unknown>, harness: HarnessId): ChatTurn['tools'] {
  const reqs = data.toolRequests
  if (!Array.isArray(reqs)) return undefined
  const out: NonNullable<ChatTurn['tools']> = []
  for (const raw of reqs as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    const name = typeof r.name === 'string' ? r.name : ''
    if (name === '') continue
    const detail = toolDetailOf(r.arguments)
    const canonical = canonicalTool(harness, name)
    out.push({
      // Copilot's own name for display; the shared one beside it. See `ChatTurn.tools`.
      name,
      ...(canonical !== name ? { canonical } : {}),
      ...(detail ? { detail } : {}),
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * The conversation these lines hold, oldest first, capped at `max` turns from the END.
 *
 * Walked BACKWARD so a tail window can stop as soon as it has enough. No gathering is needed: an
 * assistant turn is exactly one `assistant.message`, text and tools and thinking together.
 */
export function parseCopilotChat(
  lines: string[],
  harness: HarnessId = 'copilot',
  max = 400,
): ChatTurn[] {
  const turns: ChatTurn[] = []
  let newest = true

  for (let i = lines.length - 1; i >= 0 && turns.length < max; i--) {
    const line = (lines[i] ?? '').trim()
    if (line === '') continue
    let e: CopilotLine
    try { e = JSON.parse(line) as CopilotLine } catch { continue }
    const type = typeof e.type === 'string' ? e.type : ''
    const data = (typeof e.data === 'object' && e.data !== null)
      ? e.data as Record<string, unknown>
      : {}
    const at = typeof e.timestamp === 'string' ? e.timestamp : undefined
    const stamp = (t: ChatTurn): ChatTurn => (at ? { ...t, at } : t)

    if (type === 'user.message') {
      newest = false
      // `content`, NEVER `transformedContent` — see the header.
      const text = typeof data.content === 'string' ? data.content.trim() : ''
      if (text === '') continue
      turns.push(stamp({ role: 'user', text }))
      continue
    }

    if (type === 'assistant.message') {
      const isNewest = newest
      newest = false
      const text = typeof data.content === 'string' ? data.content.trim() : ''
      const tools = toolsOf(data, harness)
      // Only `reasoningText` is readable. `reasoningOpaque` and `encryptedContent` are not thoughts
      // anything here can show, and an absent thought is absent.
      const thinking = typeof data.reasoningText === 'string' ? data.reasoningText.trim() : ''
      if (text === '' && !tools && thinking === '') continue
      turns.push(stamp({
        role: 'assistant',
        text,
        ...(tools ? { tools } : {}),
        ...(thinking ? { thinking } : {}),
        // "no text has followed these calls yet" is a statement about right now, so only the
        // NEWEST message in the file can be pending.
        ...(isNewest && text === '' && tools ? { pending: true } : {}),
      }))
      continue
    }

    const note = EVENT_NOTES[type]
    if (note) {
      newest = false
      turns.push(stamp({ role: 'user', text: note, system: note }))
    }
    // Everything else is bracketing or bookkeeping — see `EVENT_NOTES`.
  }

  turns.reverse()
  return turns
}
