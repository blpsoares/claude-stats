/**
 * antigravity-chat.ts — PURE: an Antigravity (agy) transcript's lines → `ChatTurn[]`.
 *
 * No fs, no side effects. `harness-transcript.ts` finds the file and hands the lines over.
 *
 * ON-DISK SHAPE, re-measured 2026-09-05 against the live conversation
 * `01d0814f-ef39-4838-8461-c50e540e552a` (agy 1.1.22, 2290 lines, appended to while it was read).
 * `antigravity-parse.ts` — the METRICS parser — already documents the envelope; what follows is the
 * part a CONVERSATION needs, which that parser never had to answer.
 *
 *   step_index  monotonic, unique in every file measured (0 duplicates in 2290)
 *   source      USER_EXPLICIT | MODEL | SYSTEM   — the honest role, and the only one
 *   type        USER_INPUT | PLANNER_RESPONSE | VIEW_FILE | RUN_COMMAND | GREP_SEARCH |
 *               CODE_ACTION | LIST_DIRECTORY | ERROR_MESSAGE | SYSTEM_MESSAGE | CHECKPOINT |
 *               CONVERSATION_HISTORY | GENERIC | …
 *   created_at  ISO with `Z`
 *   content     a STRING (never an object), absent on 1079 of the 2290 lines
 *   thinking    the model's reasoning, on a PLANNER_RESPONSE
 *   tool_calls  [{name, args}] — the REQUEST, and ONLY ever on a PLANNER_RESPONSE
 *   error / error_code / exit_code
 *
 * THE REQUEST AND THE EXECUTION ARE TWO STEPS, and this is the whole of the mapping.
 * A `PLANNER_RESPONSE` carries the model's prose, its thinking and the `tool_calls` it is asking
 * for — `{name: 'run_command', args: {CommandLine: 'agentop session kill 29bce', …}}`. The
 * execution then arrives as its OWN step (`RUN_COMMAND`, `VIEW_FILE`, …) whose `content` is the
 * result: for a command, the entire stdout. Measured: 1094 planner steps against 909 execution
 * steps, and the executions carry no `tool_calls` at all.
 *
 * So the conversation is built from the REQUESTS and the executions are dropped. This is the
 * inverse of the choice `harness-activity.ts` records for the same transcript ("Agy counts the
 * EXECUTION, never the request") and for the same reason — counting both is counting twice. A
 * COUNT wants the execution because that is the thing that happened; a CHAT BUBBLE wants the
 * request because that is the thing with the command in it, and the execution is pages of output
 * that `ChatTurn` has nowhere to put and a reader has no room for.
 *
 * WHAT NOBODY SAID IS NEVER DRAWN AS A MESSAGE. `USER_INPUT` is wrapped in `<USER_REQUEST>` with
 * an `<ADDITIONAL_METADATA>` block the harness appends (the local time); only the request is the
 * person's. `SYSTEM_MESSAGE`, `CHECKPOINT` and `ERROR_MESSAGE` are the harness talking and become
 * unattributed notes, exactly as `chat-envelope.ts` does for Claude's injected entries — and, like
 * those, a note NAMES the kind and never carries the body: agy's checkpoint summary is the whole
 * truncated conversation, and its error paragraph runs 206–633 characters (measured over all 77).
 *
 * `CONVERSATION_HISTORY` is a REPLAY of earlier turns and is skipped, the same rule
 * `antigravity-parse.ts` applies for the same reason: the turns it repeats are already in the file
 * as themselves, and reading both shows every one of them twice.
 */

import type { HarnessId } from '@agentistics/core'
import { canonicalTool } from '../harness-activity'
import type { ChatTurn } from './chat-turn'

/** One line of `transcript_full.jsonl`, as far as a conversation is concerned. */
interface AgyStep {
  step_index?: unknown
  source?: unknown
  type?: unknown
  created_at?: unknown
  content?: unknown
  thinking?: unknown
  error?: unknown
  tool_calls?: unknown
}

/**
 * Steps that are the RESULT of a `tool_calls` entry already carried by the planner step above them.
 *
 * Listed rather than inferred from "has no tool_calls", because that is also true of a step type
 * nobody here has seen: an unknown type falls through to a named note (see `noteFor`) so it shows
 * up as itself and gets looked at, which is the same rule `canonicalTool` follows for a tool name
 * nobody has mapped.
 */
const EXECUTION_TYPES = new Set([
  'VIEW_FILE', 'RUN_COMMAND', 'GREP_SEARCH', 'CODE_ACTION', 'LIST_DIRECTORY',
  'SEARCH_WEB', 'READ_URL_CONTENT', 'BROWSER_ACTION', 'MEMORY', 'GENERIC',
  'INVOKE_SUBAGENT', 'MANAGE_TASK', 'SCHEDULE',
])

/**
 * The note an unattributed step becomes. English, like every note `chat-envelope.ts` produces —
 * `ChatBubble` holds the Portuguese, because a note is chrome rather than a machine's answer.
 */
const NOTES: Record<string, string> = {
  SYSTEM_MESSAGE: 'a system message',
  CHECKPOINT: 'the conversation was truncated',
  ERROR_MESSAGE: 'the harness reported an error',
}

/**
 * The one line worth showing for a tool call — agy's field names, Claude's rule.
 *
 * Named fields in priority order rather than a dump of the args, exactly as `chat-tail.ts`'s
 * `toolDetail` does: a `write_to_file` carries the whole new file in `CodeContent` and a
 * `replace_file_content` carries both sides of the edit, and neither belongs in a chat bubble.
 * `toolSummary` is agy's OWN one-line label and is the last resort rather than the first: it says
 * "Edit a file", where `TargetFile` says which.
 */
const DETAIL_KEYS = [
  'CommandLine', 'AbsolutePath', 'TargetFile', 'DirectoryPath', 'Query', 'SearchPath',
  'Prompt', 'Instruction', 'Description', 'toolSummary', 'toolAction',
]

function toolDetail(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null
  const o = args as Record<string, unknown>
  for (const key of DETAIL_KEYS) {
    const v = o[key]
    if (typeof v === 'string' && v.trim() !== '') {
      const line = v.trim().split('\n')[0]!
      return line.length > 200 ? `${line.slice(0, 200)}…` : line
    }
  }
  return null
}

/**
 * The tools one planner step asked for — under AGY'S OWN NAMES, with the shared one beside them.
 *
 * The first version of this reader emitted only `canonicalTool`'s answer, so an Antigravity
 * conversation rendered its actions as `Bash`, `Read`, `Grep`, `Edit` and `Write` — Claude Code's
 * tool names, in a session that ran none of them. It was reported the moment it reached the screen,
 * and the result gave itself away: those five stood beside `manage_task` and `schedule`, which are
 * agy's own and which nothing maps, so the same list spoke two vocabularies at once.
 *
 * `name` is therefore what agy called it and `canonical` is the shared reading, carried separately
 * and only when the two differ — `sessionArtifacts.ts` still finds the writes (its set is Claude's
 * names) without the bubble claiming agy ran a tool it does not have. See `ChatTurn.tools`.
 */
function toolsOf(step: AgyStep, harness: HarnessId): ChatTurn['tools'] {
  if (!Array.isArray(step.tool_calls)) return undefined
  const out: NonNullable<ChatTurn['tools']> = []
  for (const raw of step.tool_calls as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue
    const call = raw as Record<string, unknown>
    if (typeof call.name !== 'string' || call.name === '') continue
    const detail = toolDetail(call.args)
    const canonical = canonicalTool(harness, call.name)
    out.push({
      name: call.name,
      ...(canonical !== call.name ? { canonical } : {}),
      ...(detail ? { detail } : {}),
    })
  }
  return out.length > 0 ? out : undefined
}

/** `<USER_REQUEST>` is the person; `<ADDITIONAL_METADATA>` is the harness stamping the local time. */
export function userRequestText(content: string): string {
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content)
  if (m) return m[1]!.trim()
  // No envelope at all: strip the metadata block the harness appends and keep what is left. An
  // unwrapped USER_INPUT has not been seen, and dropping it would erase a turn that happened.
  return content.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '').trim()
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * The turn one step becomes, or `null` when it is not a turn at all.
 *
 * `isNewest` is the last substantive step in the file, and the ONLY place "a tool call with no text
 * after it" means "busy right now" — the same shape earlier in the transcript is an ordinary call
 * whose result already exists further down. Identical rule, and identical reason, to `chat-tail.ts`.
 */
function turnOf(step: AgyStep, harness: HarnessId, isNewest: boolean): ChatTurn | null {
  const type = str(step.type)
  const at = typeof step.created_at === 'string' ? step.created_at : undefined
  const stamp = (t: ChatTurn): ChatTurn => (at ? { ...t, at } : t)

  if (type === 'CONVERSATION_HISTORY') return null
  if (EXECUTION_TYPES.has(type)) return null

  if (type === 'USER_INPUT') {
    const text = userRequestText(str(step.content))
    if (text === '') return null
    // Only `USER_EXPLICIT` is the person. Every USER_INPUT measured carried it, and a step arriving
    // under this type from SYSTEM would be the harness feeding itself input — which may never be
    // drawn over the reader's avatar, the same rule `chat-envelope.ts` exists to enforce.
    if (str(step.source) !== 'USER_EXPLICIT') {
      return stamp({ role: 'user', text: 'input from the harness', system: 'input from the harness' })
    }
    return stamp({ role: 'user', text })
  }

  if (type === 'PLANNER_RESPONSE') {
    const text = str(step.content)
    const thinking = str(step.thinking)
    const tools = toolsOf(step, harness)
    if (text === '' && thinking === '' && !tools) return null
    return stamp({
      role: 'assistant',
      text,
      ...(tools ? { tools } : {}),
      ...(thinking ? { thinking } : {}),
      ...(isNewest && text === '' && tools ? { pending: true } : {}),
    })
  }

  // Everything else is the harness, not either party. A note names the kind; a type nobody has
  // mapped is named by its own type rather than dropped, so a new one is visible instead of silent.
  const note = NOTES[type] ?? (type === '' ? '' : `a ${type.toLowerCase().replace(/_/g, ' ')} step`)
  if (note === '') return null
  return stamp({ role: 'user', text: note, system: note })
}

/**
 * The conversation these lines hold, oldest first, capped at `max` turns from the END.
 *
 * Walked BACKWARD so a tail window can stop as soon as it has enough, and so the `isNewest` rule
 * has a cheap answer. `atStart` tells the caller whether the window reached the beginning of the
 * file; the caller widens and asks again when it came back short.
 */
export function parseAntigravityChat(
  lines: string[],
  harness: HarnessId = 'antigravity',
  max = 400,
): ChatTurn[] {
  const turns: ChatTurn[] = []
  /**
   * `step_index` already emitted. The metrics parser dedupes on it and this one must too: a step
   * rewritten as it completes appears twice, and walking backward means the LATER write is the one
   * seen first — which is the one to keep.
   */
  const seen = new Set<number>()
  let newest = true
  for (let i = lines.length - 1; i >= 0 && turns.length < max; i--) {
    const line = (lines[i] ?? '').trim()
    if (line === '') continue
    let step: AgyStep
    try { step = JSON.parse(line) as AgyStep } catch { continue }

    const idx = typeof step.step_index === 'number' ? step.step_index : null
    if (idx !== null) {
      if (seen.has(idx)) continue
      seen.add(idx)
    }

    const isNewest = newest
    newest = false
    const turn = turnOf(step, harness, isNewest)
    if (turn) turns.push(turn)
  }
  turns.reverse()
  return turns
}
