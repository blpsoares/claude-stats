/**
 * kimi-chat.ts — PURE: a Kimi Code agent's `wire.jsonl` lines → `ChatTurn[]`.
 *
 * No fs, no side effects. `harness-transcript.ts` finds the file and hands the lines over.
 *
 * ON-DISK SHAPE, measured 2026-09-05 over the 10 largest wires on this machine
 * (`~/.kimi-code/sessions/<workspaceId>/session_<uuid>/agents/<agentId>/wire.jsonl`).
 * `kimi-parse.ts` — the METRICS parser — documents the envelope; what follows is the part a
 * CONVERSATION needs. Counts over those 10 files:
 *
 *   context.append_loop_event  214   the assistant's work, one `event` per line
 *   llm.request                 95   the call being made — not a turn
 *   usage.record                41   tokens
 *   context.append_message      22   the messages the context holds
 *   turn.prompt                 15   the prompt that opened a turn
 *   turn.ended / metadata / profile.bind / permission.* / llm.tools_snapshot / interaction.*
 *
 * Inside `context.append_loop_event`, `event.type` is:
 *   step.begin  95   step.end  41   tool.call  34   tool.result  34   content.part  10
 *
 * THE PERSON IS `context.append_message`, AND KIMI SAYS SO ITSELF. `turn.prompt` carries the same
 * text and would be the obvious source, but it is a strict SUBSET: 15 prompts against 22 messages,
 * and reading both draws the person's turn twice — the same duplication trap `codex-chat.ts` and
 * `kimi-parse.ts` each document for their own file. The seven extra messages are the difference
 * that matters: kimi stamps every one with `message.origin`, and it came out
 * `{kind:'user'}` 15, `{kind:'injection', variant:'todo_list_reminder'}` 3 and
 * `{kind:'injection', variant:'permission_mode'}` 4. So the harness DECLARES which entries under
 * the user role nobody typed — the same thing Claude's `isMeta` does and the thing codex has no
 * field for at all. Anything that is not `origin.kind === 'user'` is a note, and the note names the
 * VARIANT rather than carrying the body, which is a `<system-reminder>`.
 *
 * THE ASSISTANT IS `content.part`, and its tools are `tool.call`. `context.append_message` holds
 * NO assistant rows at all (22 of 22 were `user`), so a reader that looked only there would show a
 * conversation of questions and no answers. `tool.result` is the result and is dropped, exactly as
 * agy's execution steps and codex's `function_call_output` are: the request above already said what
 * ran, and the result is the whole output.
 *
 * Kimi's tool names are ALREADY Claude's (`Write` verbatim in the measured wire), so `canonicalTool`
 * usually returns the name unchanged and `ChatTurn.tools.canonical` is simply absent. That is the
 * mapping doing nothing because there is nothing to do, not the mapping being skipped.
 */

import type { HarnessId } from '@agentistics/core'
import { canonicalTool } from '../harness-activity'
import type { ChatTurn } from './chat-turn'
import { commandSummary } from './shell-writes'

interface KimiLine {
  type?: unknown
  time?: unknown
  message?: unknown
  event?: unknown
}

/**
 * What each `origin.variant` is, for an entry the harness injected under the user role.
 *
 * A matched pair with the measurement above; a variant nobody has seen still becomes a note (the
 * `origin.kind` already said it is not the person) and simply says less — the same shape
 * `chat-envelope.ts`'s `META_KINDS` takes, and the reason a new one cannot regress anything.
 */
const INJECTION_NOTES: Record<string, string> = {
  todo_list_reminder: 'a reminder about the task list',
  permission_mode: 'the permission mode was announced',
}

/** The `text` parts of a content array, joined. */
function partsText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return (content as Record<string, unknown>[])
    .map(p => (p && p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim()
}

/**
 * The one line worth showing for a tool call.
 *
 * `args` is a real object here. `command` is summarised rather than truncated — the same
 * `commandSummary` `chat-tail.ts` and `codex-chat.ts` use, so a session that opens every call with
 * `cd <dir>` does not draw a column of identical rows.
 */
const DETAIL_KEYS = ['command', 'cmd', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url', 'description']

export function toolDetailOf(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null
  const o = args as Record<string, unknown>
  for (const key of DETAIL_KEYS) {
    const v = o[key]
    if (typeof v === 'string' && v.trim() !== '') {
      if (key === 'command' || key === 'cmd') return commandSummary(v)
      const line = v.trim().split('\n')[0]!
      return line.length > 200 ? `${line.slice(0, 200)}…` : line
    }
  }
  return null
}

/** Kimi stamps epoch MILLISECONDS; every other reader here emits ISO. */
export function isoOf(time: unknown): string | undefined {
  if (typeof time !== 'number' || !Number.isFinite(time) || time <= 0) return undefined
  const d = new Date(time)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

type Tool = NonNullable<ChatTurn['tools']>[number]

function toolOf(event: Record<string, unknown>, harness: HarnessId): Tool | null {
  const name = typeof event.name === 'string' ? event.name : ''
  if (name === '') return null
  const detail = toolDetailOf(event.args)
  const canonical = canonicalTool(harness, name)
  return {
    name,
    ...(canonical !== name ? { canonical } : {}),
    ...(detail ? { detail } : {}),
  }
}

/**
 * The conversation these lines hold, oldest first, capped at `max` turns from the END.
 *
 * Walked BACKWARD so a tail window can stop as soon as it has enough. `tool.call`s are gathered
 * onto the `content.part` above them, reproducing the single assistant turn Claude's reader emits;
 * a batch with no text of its own is still a turn, because it is what the session did.
 */
export function parseKimiChat(
  lines: string[],
  harness: HarnessId = 'kimi',
  max = 400,
): ChatTurn[] {
  const turns: ChatTurn[] = []
  /** Tool calls seen since the assistant text they belong to, in FILE order. */
  let pending: Tool[] = []
  let pendingAt: string | undefined
  /** Whether the batch currently accumulating is the LAST thing in the file. */
  let newestBatch = false
  let newest = true

  const flushTools = (): void => {
    if (pending.length === 0) return
    turns.push({
      role: 'assistant',
      text: '',
      tools: pending,
      ...(pendingAt ? { at: pendingAt } : {}),
      ...(newestBatch ? { pending: true } : {}),
    })
    pending = []
    pendingAt = undefined
    newestBatch = false
  }

  for (let i = lines.length - 1; i >= 0 && turns.length < max; i--) {
    const line = (lines[i] ?? '').trim()
    if (line === '') continue
    let e: KimiLine
    try { e = JSON.parse(line) as KimiLine } catch { continue }
    const at = isoOf(e.time)

    if (e.type === 'context.append_loop_event') {
      const event = (typeof e.event === 'object' && e.event !== null)
        ? e.event as Record<string, unknown>
        : null
      if (!event) continue
      if (event.type === 'tool.call') {
        const tool = toolOf(event, harness)
        if (tool) {
          if (pending.length === 0) { pendingAt = at; newestBatch = newest }
          pending.unshift(tool)
          newest = false
        }
        continue
      }
      if (event.type === 'content.part') {
        const part = (typeof event.part === 'object' && event.part !== null)
          ? event.part as Record<string, unknown>
          : null
        const text = part && typeof part.text === 'string' ? part.text.trim() : ''
        newest = false
        if (text === '' && pending.length === 0) continue
        turns.push({
          role: 'assistant',
          text,
          ...(pending.length > 0 ? { tools: pending } : {}),
          ...(at ? { at } : {}),
          ...(text === '' && pending.length > 0 && newestBatch ? { pending: true } : {}),
        })
        pending = []
        pendingAt = undefined
        newestBatch = false
        continue
      }
      // `step.begin` / `step.end` bracket a step and `tool.result` is the result — the request
      // above already said what ran, and the result is the whole output.
      continue
    }

    if (e.type === 'context.append_message') {
      const m = (typeof e.message === 'object' && e.message !== null)
        ? e.message as Record<string, unknown>
        : null
      if (!m) continue
      flushTools()
      newest = false
      const text = partsText(m.content)
      if (text === '') continue
      const turn = messageTurn(m, text)
      if (turn) turns.push(at ? { ...turn, at } : turn)
      continue
    }

    // `turn.prompt` is deliberately ignored — it is the same text as the `context.append_message`
    // above and a strict subset of it (15 against 22). See the header.
  }

  flushTools()
  turns.reverse()
  return turns
}

/** One `context.append_message`, classified by the origin KIMI ITSELF stamped on it. */
function messageTurn(message: Record<string, unknown>, text: string): ChatTurn | null {
  const origin = (typeof message.origin === 'object' && message.origin !== null)
    ? message.origin as Record<string, unknown>
    : null
  const kind = origin && typeof origin.kind === 'string' ? origin.kind : ''
  if (kind === 'user') return { role: 'user', text }

  // Not the person, and kimi said so. The note names the VARIANT and never the body — the injected
  // entries measured here are `<system-reminder>` blocks.
  const variant = origin && typeof origin.variant === 'string' ? origin.variant : ''
  const note = INJECTION_NOTES[variant]
    ?? (variant !== '' ? `an injected ${variant.replace(/_/g, ' ')}` : 'injected by the harness')
  return { role: 'user', text: note, system: note }
}
