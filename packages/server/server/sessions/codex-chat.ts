/**
 * codex-chat.ts — PURE: a Codex CLI rollout's lines → `ChatTurn[]`.
 *
 * No fs, no side effects. `harness-transcript.ts` finds the file and hands the lines over.
 *
 * ON-DISK SHAPE, measured 2026-09-05 over the 14 largest rollouts on this machine
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<conversation-id>.jsonl`). `codex-parse.ts` — the
 * METRICS parser — documents the envelope; what follows is the part a CONVERSATION needs.
 *
 * Every line is `{timestamp, type, payload}` and the semantic type is at `payload.type`
 * (`codex-parse.ts` says the same). Counts over those 14 files:
 *
 *   response_item / message            81   (user 42, developer 19, assistant 20)
 *   response_item / function_call      23   the tool REQUEST — `{name, arguments}` (a JSON STRING)
 *   response_item / function_call_output 23 the result
 *   response_item / reasoning          17   `summary` + `encrypted_content`
 *   response_item / ghost_snapshot      3
 *   event_msg / user_message           21
 *   event_msg / agent_message          20
 *
 * EVERY MESSAGE IS WRITTEN TWICE, and picking the wrong copy loses half the conversation.
 * `event_msg/{user_message,agent_message}` and `response_item/message` carry the same text, adjacent
 * in the file and in an order that is not even consistent (the user's `response_item` precedes its
 * `event_msg`; the assistant's follows it). Reading both draws every turn twice, which is the trap
 * `kimi-parse.ts` records for its duplicated usage records and `harness-activity.ts` for agy's
 * request/execution pair.
 *
 * `response_item` is the copy that is read, for three reasons and not merely because it is bigger:
 *   1. The `event_msg` family is a strict SUBSET — 21 user events against 42 user messages. Eleven
 *      turns exist only as `response_item`, so that family cannot be the source at all.
 *   2. `function_call` and `reasoning` are already `response_item`s. Taking messages from the other
 *      family would mean reconciling two orderings to rebuild one conversation.
 *   3. It is the only copy that carries the harness's own injected material, which has to be
 *      CLASSIFIED rather than silently dropped — see below.
 *
 * WHAT NOBODY SAID IS NEVER DRAWN AS A MESSAGE. Same rule, same reason, as `chat-envelope.ts`'s for
 * Claude. Two things decide it here, and the ROLE is the stronger one:
 *   - `developer` is ALWAYS the harness. All 19 measured were tagged (`permissions` 12,
 *     `collaboration_mode` 4, `model_switch` 3) and none of them is a person speaking.
 *   - `user` is the person UNLESS an envelope says otherwise: `<environment_context>` (7) and
 *     `<turn_aborted>` (1) are the harness, while `<user_shell_command>` (2) IS the person — they
 *     ran a command — and is UNWRAPPED to what they ran, exactly as `chat-envelope.ts` unwraps
 *     Claude's `<bash-input>`. 32 of the 42 carried no tag at all and are simply theirs.
 *   - An UNRECOGNISED tag is left as the person's. That is the safe direction and the one
 *     `chat-envelope.ts` argues for: a message that merely starts with `<` (a diff, a snippet) is
 *     real, and hiding it is the expensive mistake.
 *
 * THINKING EXISTS, SOMETIMES, AND IS NEVER THE ENCRYPTED FIELD. A `reasoning` item carries
 * `encrypted_content` (17 of 17) and a `summary` that is readable on only 5 of them. The summary is
 * used when it is there and the item contributes nothing when it is not — an absent thought is
 * absent, and `encrypted_content` is not one this or any reader can show.
 */

import type { HarnessId } from '@agentistics/core'
import { canonicalTool } from '../harness-activity'
import type { ChatTurn } from './chat-turn'
import { commandSummary } from './shell-writes'

interface CodexLine {
  timestamp?: unknown
  type?: unknown
  payload?: unknown
}

/**
 * The `user`-role envelopes, and what each one is.
 *
 * `unwrap` marks the one the person really performed. The table is a matched pair with the
 * measurement in the header and nothing more — an envelope nobody has seen is not in it, and an
 * unrecognised tag stays the person's.
 */
const USER_ENVELOPES: Record<string, { unwrap: boolean; note: string }> = {
  environment_context: { unwrap: false, note: 'the environment was described to the assistant' },
  turn_aborted: { unwrap: false, note: 'the turn was aborted' },
  user_shell_command: { unwrap: true, note: 'shell command' },
}

/** The `developer`-role envelopes. Every one of them is the harness; the tag only names which. */
const DEVELOPER_NOTES: Record<string, string> = {
  permissions: 'the harness stated its permissions',
  collaboration_mode: 'the collaboration mode changed',
  model_switch: 'the model was switched',
}

/**
 * UNTAGGED `user` messages that no person wrote, named by their opening line.
 *
 * Codex has no `isMeta` flag — the payload of one of these is literally `{type, role, content}`,
 * indistinguishable in SHAPE from a message somebody typed — so the text is the only signal there
 * is. This is `chat-envelope.ts`'s `META_KINDS` applied to a different harness, and it is a matched
 * pair with a measurement: over the 40 largest rollouts, 32 user messages carried no envelope tag
 * and **11 of them were these two** (`# AGENTS.md instructions for <path>` nine times, `# Context
 * from my IDE setup:` twice) — a third of the reader's own bubble was the harness loading a file.
 *
 * The NOTE never carries the body, for the reason `chat-envelope.ts` gives: an AGENTS.md dump is a
 * whole file. And a line nobody has measured stays the PERSON's — a heuristic that guesses wider
 * hides real messages, which is the expensive direction.
 */
const INJECTED: Array<{ test: RegExp; note: string }> = [
  { test: /^# AGENTS\.md instructions for /, note: 'project instructions were loaded' },
  { test: /^# Context from my IDE setup:/, note: 'context from the editor' },
]

/** The leading `<tag` of a message, lowercased, or `null` when it does not open with one. */
function leadingTag(text: string): string | null {
  const m = /^<([a-zA-Z][\w-]*)/.exec(text)
  return m ? m[1]!.toLowerCase() : null
}

/** The text of a `message` payload — its content parts joined. */
function messageText(payload: Record<string, unknown>): string {
  const c = payload.content
  if (typeof c === 'string') return c.trim()
  if (!Array.isArray(c)) return ''
  return (c as Record<string, unknown>[])
    .map(part => (typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim()
}

/**
 * What the person actually ran, out of a `<user_shell_command>` envelope.
 *
 * The envelope carries the command AND its whole stdout in a `<result>` block. Only the command is
 * the person's act; the output is the machine answering, and a chat bubble is not a terminal — the
 * same reason `chat-tail.ts`'s `toolDetail` keeps one line of a tool input.
 */
export function shellCommandOf(text: string): string {
  const m = /<command>([\s\S]*?)<\/command>/.exec(text)
  const cmd = (m ? m[1]! : '').trim()
  if (cmd === '') return ''
  const line = cmd.split('\n')[0]!
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}

/** The readable half of a `reasoning` item. Never `encrypted_content`. */
export function reasoningText(payload: Record<string, unknown>): string {
  const s = payload.summary
  if (!Array.isArray(s)) return ''
  return (s as Record<string, unknown>[])
    .map(part => (typeof part.text === 'string' ? part.text : ''))
    .filter(t => t.trim() !== '')
    .join('\n\n')
    .trim()
}

/**
 * The one line worth showing for a tool call.
 *
 * `arguments` is a JSON STRING, not an object. Only `exec_command` was measured (23 of 23) and its
 * argument is `cmd`; the other keys are budget and sandbox settings that say nothing about what
 * ran. A name nobody has mapped still shows, keyed on the first string-valued field it does carry,
 * so a new tool appears as itself rather than as a bare chip.
 */
const DETAIL_KEYS = ['cmd', 'command', 'path', 'file_path', 'pattern', 'query', 'url']

export function toolDetailOf(rawArguments: unknown): string | null {
  if (typeof rawArguments !== 'string' || rawArguments.trim() === '') return null
  let args: unknown
  try { args = JSON.parse(rawArguments) } catch { return null }
  if (typeof args !== 'object' || args === null) return null
  const o = args as Record<string, unknown>
  for (const key of DETAIL_KEYS) {
    const v = o[key]
    if (typeof v === 'string' && v.trim() !== '') {
      // A SHELL command is SUMMARISED, not truncated to its first line — the same call
      // `chat-tail.ts`'s `toolDetail` makes, and measured here for the same reason: on a real
      // rollout every one of five consecutive calls opened with `cd /home/…/embark`, so the chips
      // read as a column of identical `cd` rows saying where the work happened and never what it
      // was. `commandSummary` skips the `cd`/`set`/`export` segments and shows the one that acts.
      if (key === 'cmd' || key === 'command') return commandSummary(v)
      const line = v.trim().split('\n')[0]!
      return line.length > 200 ? `${line.slice(0, 200)}…` : line
    }
  }
  return null
}

type Tool = NonNullable<ChatTurn['tools']>[number]

function toolOf(payload: Record<string, unknown>, harness: HarnessId): Tool | null {
  const name = typeof payload.name === 'string' ? payload.name : ''
  if (name === '') return null
  const detail = toolDetailOf(payload.arguments)
  const canonical = canonicalTool(harness, name)
  return {
    // The harness's OWN name is what a conversation shows; `canonical` is the shared vocabulary
    // anything selecting or counting reads. See `ChatTurn.tools`.
    name,
    ...(canonical !== name ? { canonical } : {}),
    ...(detail ? { detail } : {}),
  }
}

/**
 * The conversation these lines hold, oldest first, capped at `max` turns from the END.
 *
 * Walked BACKWARD so a tail window can stop as soon as it has enough. Two items are gathered onto
 * the assistant turn they belong to rather than becoming turns of their own, because in this
 * format one turn is several lines:
 *
 *   reasoning → message(assistant) → function_call, function_call, …
 *
 * so the tool calls are FLUSHED onto the assistant message above them and the reasoning is attached
 * to the turn below it. That reproduces the single assistant turn Claude's reader emits, where text,
 * thinking and tool calls arrive in one event. A batch of calls with no assistant text is still a
 * turn — it is what the session did — and a `reasoning` with nowhere to attach becomes a turn
 * carrying only the thought.
 */
export function parseCodexChat(
  lines: string[],
  harness: HarnessId = 'codex',
  max = 400,
): ChatTurn[] {
  const turns: ChatTurn[] = []
  /** Tool calls seen since the assistant message they belong to, in FILE order. */
  let pending: Tool[] = []
  let pendingAt: string | undefined
  /** Whether the batch currently accumulating is the LAST thing in the file. */
  let newestBatch = false
  let newest = true

  /** The tool calls become a turn of their own when no assistant message claims them. */
  const flushTools = (): void => {
    if (pending.length === 0) return
    turns.push({
      role: 'assistant',
      text: '',
      tools: pending,
      ...(pendingAt ? { at: pendingAt } : {}),
      // "no text has followed these calls yet" is a statement about RIGHT NOW, so only the newest
      // batch in the file can be pending. Identical rule, and reason, to `chat-tail.ts`.
      ...(newestBatch ? { pending: true } : {}),
    })
    pending = []
    pendingAt = undefined
    newestBatch = false
  }

  for (let i = lines.length - 1; i >= 0 && turns.length < max; i--) {
    const line = (lines[i] ?? '').trim()
    if (line === '') continue
    let e: CodexLine
    try { e = JSON.parse(line) as CodexLine } catch { continue }
    if (e.type !== 'response_item') continue
    const payload = (typeof e.payload === 'object' && e.payload !== null)
      ? e.payload as Record<string, unknown>
      : null
    if (!payload) continue
    const at = typeof e.timestamp === 'string' ? e.timestamp : undefined
    const kind = typeof payload.type === 'string' ? payload.type : ''

    if (kind === 'function_call') {
      const tool = toolOf(payload, harness)
      if (tool) {
        if (pending.length === 0) { pendingAt = at; newestBatch = newest }
        // Backward walk, file order kept: the earliest call of the batch ends up first.
        pending.unshift(tool)
        newest = false
      }
      continue
    }

    if (kind === 'message') {
      const role = typeof payload.role === 'string' ? payload.role : ''
      const text = messageText(payload)
      if (role === 'assistant') {
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
      flushTools()
      newest = false
      if (text === '') continue
      const turn = userTurn(role, text)
      if (turn) turns.push(at ? { ...turn, at } : turn)
      continue
    }

    if (kind === 'reasoning') {
      flushTools()
      newest = false
      const thinking = reasoningText(payload)
      if (thinking === '') continue
      // The reasoning precedes its assistant message in the file, so walking backward the message
      // has already been pushed — attach to it rather than drawing the thought as a second turn.
      const last = turns[turns.length - 1]
      if (last && last.role === 'assistant' && last.thinking === undefined) last.thinking = thinking
      else turns.push({ role: 'assistant', text: '', thinking, ...(at ? { at } : {}) })
      continue
    }

    // `function_call_output` (the result, whose body is the whole stdout) and `ghost_snapshot` are
    // not turns. The request above already said what ran — the same choice `antigravity-chat.ts`
    // makes, and for the same reason.
    flushTools()
    newest = false
  }

  flushTools()
  turns.reverse()
  return turns
}

/** One `message` that is not the assistant's, classified. `null` when there is nothing to draw. */
function userTurn(role: string, text: string): ChatTurn | null {
  if (role === 'developer') {
    const tag = leadingTag(text)
    const note = (tag && DEVELOPER_NOTES[tag]) ?? 'instructions from the harness'
    return { role: 'user', text: note, system: note }
  }
  const tag = leadingTag(text)
  const env = tag ? USER_ENVELOPES[tag] : undefined
  if (!env) {
    // No envelope. It is still not certainly the person: see `INJECTED`.
    const injected = INJECTED.find(k => k.test.test(text))
    if (injected) return { role: 'user', text: injected.note, system: injected.note }
    // Otherwise the person's, verbatim. The safe direction — a real message wrongly hidden is
    // gone, while an unknown envelope wrongly shown is what already shipped.
    return { role: 'user', text }
  }
  if (!env.unwrap) return { role: 'user', text: env.note, system: env.note }
  const cmd = shellCommandOf(text)
  return cmd === ''
    ? { role: 'user', text: env.note, system: env.note }
    : { role: 'user', text: cmd }
}
