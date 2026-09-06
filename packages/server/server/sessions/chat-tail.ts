/**
 * chat-tail.ts — the LIVE session detail pane's chat content, read from the harness's own JSONL
 * transcript instead of the terminal screen.
 *
 * Only Claude Code has an exact live-session -> conversation-id link
 * (`harness-sessions.ts`'s `byManagedId`), so this is Claude-only; every other harness keeps the
 * existing raw-tail behavior in `sessions-host.ts`. Absence here is never an error, only "not
 * available for this row" — the same rule every other enrichment in this file follows.
 *
 * Claude encodes a project's absolute path into its directory name by replacing `/` and `.` with
 * `-` (`nay-sessions.ts` uses the same encoding), but that encoding is documented as ambiguous for
 * directory names that already contain dashes (`data.ts`). Rather than trust it, the resolver
 * treats the conversation id (a UUID) as the reliable key: it tries the direct encoded path first
 * — cheap, and right the overwhelming majority of the time — and falls back to a one-time scan of
 * `PROJECTS_DIR` for a file literally named `<id>.jsonl`, exactly as `transcript-search.ts` does.
 * Both the hit and the miss are cached per conversation id, so a resolved (or unresolvable) session
 * is never re-scanned on a later poll.
 */

// The TAIL reader (readRecentChatTurns, the 5s poll) reads through `transcript-window.ts`;
// `readFile` is the CHAT view's, which deliberately reads the whole transcript — see readChatTurns'
// own note on why a cache there would miss by construction. Two readers, two budgets.
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { PROJECTS_DIR } from '../config'
import { UUID_RE } from '../git'
import { isHumanUserEntry } from '../jsonl'
import { commandSummary, hasUnreadableWrite, shellWrites } from './shell-writes'
import { classifyUserEntry, type UserEntry } from './chat-envelope'
import type { ChatTurn } from './chat-turn'
import { MAX_TAIL_BYTES, TAIL_BYTES, readTailBytes, windowLines } from './transcript-window'

// The turn shape now lives in `chat-turn.ts` — every harness reader produces it, and this module
// is only one of them. Re-exported so nothing that already imports it from here has to move.
export type { ChatTurn } from './chat-turn'

/** Resolved paths and one-time-scan misses, keyed by conversation id. Never re-scanned once known. */
const pathCache = new Map<string, string | null>()

/** Reset the memo. Tests only. */
export function forgetChatTailPaths(): void {
  pathCache.clear()
}

function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

/** Find `<sessionId>.jsonl` under `projectsDir`, scanning every project directory once. */
async function scanForTranscript(sessionId: string, projectsDir: string): Promise<string | null> {
  let dirs: string[]
  try { dirs = await readdir(projectsDir) } catch { return null }
  for (const dir of dirs) {
    const candidate = join(projectsDir, dir, `${sessionId}.jsonl`)
    if (await exists(candidate)) return candidate
  }
  return null
}

/**
 * The absolute path to a live Claude conversation's transcript, or `null` when it cannot be found.
 *
 * `null` is cached too — a session whose directory encoding is ambiguous costs one scan, not one
 * scan per poll for the rest of its life.
 *
 * `projectsDir` defaults to the real `PROJECTS_DIR` and is overridable only so tests can point it
 * at a fixture tree without needing a subprocess — `config.ts`'s constants are fixed at import
 * time and shared across a whole `bun test` run.
 */
export async function resolveChatTranscriptPath(
  cwd: string,
  sessionId: string,
  projectsDir: string = PROJECTS_DIR,
): Promise<string | null> {
  if (!UUID_RE.test(sessionId)) return null
  const cached = pathCache.get(sessionId)
  if (cached !== undefined) return cached

  const direct = join(projectsDir, encodeProjectDir(cwd), `${sessionId}.jsonl`)
  const resolved = (await exists(direct)) ? direct : await scanForTranscript(sessionId, projectsDir)
  pathCache.set(sessionId, resolved)
  return resolved
}

interface Cached {
  mtimeMs: number
  turns: ChatTurn[]
}

/** Parsed turns, keyed by transcript path — re-parsed only when the file's mtime has moved. */
const contentCache = new Map<string, Cached>()

/** Reset the memo. Tests only. */
export function forgetChatTailContent(): void {
  contentCache.clear()
}

/**
 * What a `user` entry actually is — the person, the harness, or neither.
 *
 * `isHumanUserEntry` only excludes a pure `tool_result`; every other envelope the harness writes
 * under this role reached the pane as the user's own message. `chat-envelope.ts` is the split.
 */
function extractUserEntry(e: Record<string, unknown>): UserEntry | null {
  if (!isHumanUserEntry(e)) return null
  const msgContent = (e.message as Record<string, unknown> | undefined)?.content
  let raw: string | undefined
  if (typeof msgContent === 'string') raw = msgContent
  else if (Array.isArray(msgContent)) {
    raw = (msgContent as Record<string, unknown>[])
      .find(p => p.type === 'text' && typeof p.text === 'string')?.text as string | undefined
  }
  if (raw === undefined || raw.trim() === '') return null
  // `isMeta` is the harness's own flag, and it travels with the RAW entry — 148 of the 192 meta
  // entries measured on this machine carry no envelope tag at all, so the tag table alone drew them
  // in the person's bubble. See `chat-envelope.ts`'s header.
  const entry = classifyUserEntry({
    text: raw, isMeta: e.isMeta === true, isCompactSummary: e.isCompactSummary === true,
  })
  // A system entry with nothing to name is dropped outright rather than drawn as a blank note.
  if (entry.kind === 'system' && entry.note === '') return null
  return entry
}

/**
 * A BACKGROUND TASK the assistant started, and its label.
 *
 * A watcher — a build being followed, a release being waited on — is the one tool call worth a line
 * in a conversation: it is long, it is usually the thing the reader is waiting for, and its END is
 * already reported (the `<task-notification>` that comes back as a system note). Only the start was
 * missing, so a task appeared to finish having never begun. Reported as "não aparece aqui os
 * watchers".
 *
 * ONLY background ones. Rendering every tool call would turn a conversation into a command log —
 * which is exactly why `ChatBubble` refuses `turn.tools` — and the discriminator is the tool's own
 * `run_in_background`, not a guess about how long something might take.
 *
 * The label is the call's own `description`, which is written for a person; the command is not
 * carried, because a line in a chat is not a terminal.
 */
function extractBackgroundTask(e: Record<string, unknown>): { id: string; label: string } | null {
  if (e.type !== 'assistant') return null
  const content = (e.message as Record<string, unknown> | undefined)?.content
  if (!Array.isArray(content)) return null
  for (const part of content as Record<string, unknown>[]) {
    if (part.type !== 'tool_use') continue
    const input = part.input as Record<string, unknown> | undefined
    if (!input || input.run_in_background !== true) continue
    const label = typeof input.description === 'string' ? input.description.trim() : ''
    const id = typeof part.id === 'string' ? part.id : ''
    return { id, label: label || (typeof part.name === 'string' ? part.name : 'background task') }
  }
  return null
}

/**
 * The `tool-use-id` a `<task-notification>` is reporting on, when it names one.
 *
 * This is the EXACT pairing between a task's start and its end — the notification carries the very
 * id of the `tool_use` that launched it. It is read off the raw text here because
 * `classifyUserText` deliberately discards a system entry's BODY, and rightly: a
 * `<system-reminder>` can be the whole of CLAUDE.md. One id is not a body.
 */
function rawEntryText(e: Record<string, unknown>): string {
  const c = (e.message as Record<string, unknown> | undefined)?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    const t = (c as Record<string, unknown>[]).find(p => p.type === 'text' && typeof p.text === 'string')
    if (t) return t.text as string
  }
  const a = e.attachment as Record<string, unknown> | undefined
  if (a && typeof a.prompt === 'string') return a.prompt
  return ''
}

function taskNotificationFor(text: string): string | null {
  if (!text.includes('<task-notification>')) return null
  const m = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)
  return m ? m[1]!.trim() : null
}

/**
 * A message the person typed WHILE the assistant was working.
 *
 * Claude Code does not store these as `type: 'user'`. They are QUEUED, and land as an `attachment`
 * of type `queued_command` carrying the prompt — so the chat pane, which only ever read user
 * entries, showed the assistant answering a question nobody could see it being asked. Reported
 * exactly that way: "esse ultimo prompt que te mandei n apareceu na interface de sessao".
 *
 * IT IS NOT ALWAYS THE PERSON, and that assumption is what this function used to get wrong. The
 * note here read: "it is not an envelope: nothing wraps the text, the entry's SHAPE is what
 * identifies it" — so the text was pushed straight into a `user` turn, and the envelope table
 * never saw it. But the HARNESS queues through this very shape too: a `<task-notification>`
 * reporting a background task's completion arrives as an `attachment` / `queued_command`, exactly
 * like a message typed while the assistant was working.
 *
 * Measured on a live transcript: 7 of them were drawn in the reader's own bubble, and were
 * reported the same way the injected skill body was — "essas mensagens não são minhas". The shape
 * says WHERE the text came from; it says nothing about WHO wrote it, and only the envelope table
 * answers the second question.
 *
 * So the classification happens HERE rather than at each call site. There are two of them
 * (`readRecentChatTurns` and `readChatTurns`), both of which had the identical raw push, and a
 * rule enforced at the call site is a rule the next call site forgets — the same argument
 * `rowMenu.ts` and `task-reopen.ts` make about their own duplicated gestures.
 */
function extractQueuedEntry(e: Record<string, unknown>): UserEntry | null {
  if (e.type !== 'attachment') return null
  const a = e.attachment as Record<string, unknown> | undefined
  if (!a || a.type !== 'queued_command') return null
  const raw = queuedPromptText(a.prompt)
  if (raw === null) return null
  // THE TWO HALVES OF ONE BUG MEET HERE. The queued path reaches `classifyUserEntry` — the
  // `isMeta`-aware classifier — and not the tag-only `classifyUserText` it was written against:
  // a queued entry can carry BOTH an envelope tag (a task notification) and the harness's own
  // meta flag (a loaded skill body), and reading only the tag leaves the second in the user's
  // bubble. `isMeta` is read off the attachment entry itself, which is where the harness sets it.
  const entry = classifyUserEntry({
    text: raw, isMeta: e.isMeta === true, isCompactSummary: e.isCompactSummary === true,
  })
  // A system entry with nothing to name is dropped outright rather than drawn as a blank note —
  // the same call `extractUserEntry` makes on the other path.
  if (entry.kind === 'system' && entry.note === '') return null
  return entry
}

/** The prompt's text, whether it was stored as a string or as content blocks. */
function queuedPromptText(prompt: unknown): string | null {
  if (typeof prompt === 'string') return prompt.trim() || null
  if (!Array.isArray(prompt)) return null
  const text = (prompt as Record<string, unknown>[])
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string)
    .join('\n')
    .trim()
  return text || null
}

/** The turn one classified entry becomes. */
function userTurn(entry: UserEntry): ChatTurn {
  return entry.kind === 'person'
    ? { role: 'user', text: entry.text }
    : { role: 'user', text: entry.note, system: entry.note }
}

function extractAssistantText(e: Record<string, unknown>): string | null {
  if (e.type !== 'assistant') return null
  const msgContent = (e.message as Record<string, unknown> | undefined)?.content
  if (!Array.isArray(msgContent)) return null
  const text = (msgContent as Record<string, unknown>[])
    .find(p => p.type === 'text' && typeof p.text === 'string')?.text as string | undefined
  return text?.trim() || null
}

/** The tool names an assistant entry is calling, when it carries no text at all — see `ChatTurn.pending`. */
/** The tools one assistant event invoked, each with the first meaningful line of its input. */
function extractToolCalls(e: Record<string, unknown>): Array<{ name: string; detail?: string }> {
  if (e.type !== 'assistant') return []
  const msgContent = (e.message as Record<string, unknown> | undefined)?.content
  if (!Array.isArray(msgContent)) return []
  const out: Array<{ name: string; detail?: string }> = []
  for (const part of msgContent as Record<string, unknown>[]) {
    if (part.type !== 'tool_use' || typeof part.name !== 'string') continue
    const detail = toolDetail(part.input)
    // The FULL command, for the write reader — `toolDetail` keeps only the first line, and the
    // redirection is usually on a later one.
    const cmd = typeof (part.input as Record<string, unknown> | null)?.['command'] === 'string'
      ? (part.input as Record<string, string>)['command']!
      : ''
    const writes = cmd === '' ? [] : shellWrites(cmd)
    out.push({
      name: part.name,
      ...(detail ? { detail } : {}),
      ...(writes.length > 0 ? { writes } : {}),
      ...(cmd !== '' && writes.length === 0 && hasUnreadableWrite(cmd) ? { opaqueWrite: true } : {}),
    })
  }
  return out
}

/**
 * The one line worth showing for a tool call.
 *
 * Named fields in priority order rather than a dump of the input: `command` is what a shell call
 * IS, and a path is what a file call is. Everything else is truncated hard — a tool input can be a
 * whole file, and a chat bubble is not where that belongs.
 */
function toolDetail(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const o = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
    const v = o[key]
    if (typeof v === 'string' && v.trim() !== '') {
      // A SHELL command is summarised rather than truncated to its first line: a session that opens
      // nearly every command with `cd <worktree>` otherwise shows a column of identical `cd` rows,
      // which says where the work happened and never what it was.
      if (key === 'command') return commandSummary(v)
      const line = v.trim().split('\n')[0]!
      return line.length > 200 ? `${line.slice(0, 200)}…` : line
    }
  }
  return null
}

/** The assistant's extended thinking in one event, when it carries any. */
function extractThinking(e: Record<string, unknown>): string | null {
  if (e.type !== 'assistant') return null
  const msgContent = (e.message as Record<string, unknown> | undefined)?.content
  if (!Array.isArray(msgContent)) return null
  const parts = (msgContent as Record<string, unknown>[])
    .filter(p => p.type === 'thinking' && typeof p.thinking === 'string')
    .map(p => (p.thinking as string).trim())
    .filter(t => t !== '')
  return parts.length > 0 ? parts.join('\n\n') : null
}

function extractToolActivity(e: Record<string, unknown>): string[] | null {
  if (e.type !== 'assistant') return null
  const msgContent = (e.message as Record<string, unknown> | undefined)?.content
  if (!Array.isArray(msgContent)) return null
  const names = (msgContent as Record<string, unknown>[])
    .filter(p => p.type === 'tool_use' && typeof p.name === 'string')
    .map(p => p.name as string)
  return names.length > 0 ? names : null
}

function toolActivityLabel(tools: string[]): string {
  return `Running ${tools.join(', ')}`
}

// The tail window — its size, its growth and the byte read — is `transcript-window.ts`, shared
// with every other harness reader. Its header carries the measurement that made it necessary.


/**
 * The most recent chat turns in a Claude transcript, oldest first.
 *
 * Reads the END of the file and parses backwards from it, stopping as soon as `max` turns are
 * collected — so a long-running session's transcript is neither fully read nor fully `JSON.parse`d
 * to show the last few lines. See `TAIL_BYTES` for why the window grows instead of truncating.
 */
export async function readRecentChatTurns(path: string, max = 6): Promise<ChatTurn[]> {
  let mtimeMs: number
  try { mtimeMs = (await stat(path)).mtimeMs } catch { return [] }

  const hit = contentCache.get(path)
  if (hit && hit.mtimeMs === mtimeMs) return hit.turns

  let turns = await readTurnsFromTail(path, max, TAIL_BYTES)
  // Fewer turns than asked for, and the window did not reach the start of the file: the answer is
  // incomplete because of the WINDOW, not because the transcript is short. Widen and read again.
  let window = TAIL_BYTES
  while (turns !== null && turns.turns.length < max && !turns.atStart && window < MAX_TAIL_BYTES) {
    window = Math.min(window * 4, MAX_TAIL_BYTES)
    turns = await readTurnsFromTail(path, max, window)
  }
  const found = turns?.turns ?? []

  contentCache.set(path, { mtimeMs, turns: found })
  return found
}

/** One pass over the last `windowBytes` of the transcript. `null` when the file could not be read. */
async function readTurnsFromTail(
  path: string,
  max: number,
  windowBytes: number,
): Promise<{ turns: ChatTurn[]; atStart: boolean } | null> {
  const tail = await readTailBytes(path, windowBytes)
  if (!tail) return null

  const lines = windowLines(tail)
  const turns: ChatTurn[] = []
  /** Tasks started in this file, and the `tool-use-id` each completion will name. */
  const taskTurns: Array<{ id: string; turn: ChatTurn }> = []
  /** Ids whose `<task-notification>` has already arrived. */
  const finishedTasks = new Set<string>()
  // Set once, on the first substantive (non-blank, parseable) line the loop inspects — which is the
  // NEWEST event in the transcript. Only there does "no text yet" mean "busy right now"; the same
  // shape earlier in the file is just an ordinary tool call whose result and follow-up text already
  // exist further down and will be read on a later iteration.
  let newest = true
  for (let i = lines.length - 1; i >= 0 && turns.length < max; i--) {
    const line = (lines[i] ?? '').trim()
    if (!line) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(line) } catch { continue }
    const isNewest = newest
    newest = false

    // The event's own time, stamped onto whatever this iteration pushes. A turn with no recorded
    // time gets none rather than "now" — the Live feed's whole promise is its ordering, and an
    // invented timestamp is the one thing that could quietly break it.
    const at = typeof e.timestamp === 'string' ? e.timestamp : undefined
    const add = (t: ChatTurn): void => { turns.push(at ? { ...t, at } : t) }

    const done = taskNotificationFor(rawEntryText(e))
    if (done) finishedTasks.add(done)

    const bg = extractBackgroundTask(e)
    if (bg) {
      // A status line, never a message — nobody said it. `running` is settled after the walk,
      // once every completion in the file has been seen.
      add({ role: 'assistant', text: bg.label, task: { label: bg.label, running: true }, pending: true })
      taskTurns.push({ id: bg.id, turn: turns[turns.length - 1]! })
      continue
    }

    const userEntry = extractUserEntry(e)
    if (userEntry) { add(userTurn(userEntry)); continue }
    const queued = extractQueuedEntry(e)
    if (queued) { add(userTurn(queued)); continue }
    const assistantText = extractAssistantText(e)
    if (assistantText) { add({ role: 'assistant', text: assistantText }); continue }
    if (isNewest) {
      const tools = extractToolActivity(e)
      if (tools) add({ role: 'assistant', text: toolActivityLabel(tools), pending: true })
    }
  }
  // Settled AFTER the walk: a completion always comes later in the file than its start, so this is
  // the only point where "still running" can be answered without reading the file twice. An id
  // that never arrives stays running — which is the truth for a task the session is still on, and
  // for one whose session ended mid-flight there is nothing better to say.
  for (const t of taskTurns) {
    if (t.turn.task && finishedTasks.has(t.id)) {
      t.turn.task.running = false
      delete t.turn.pending
    }
  }

  turns.reverse()

  return { turns, atStart: tail.atStart }
}

/**
 * The conversation, oldest first, capped at `max` turns from the END.
 *
 * `readRecentChatTurns` above is the six-row detail pane's reader and stops at its own small
 * budget; a chat view wants the conversation. The difference is only the budget and the
 * `pending` rule — which still applies to the NEWEST event only, because "no text has followed
 * this tool call yet" is a statement about right now, and the same shape earlier in the file is an
 * ordinary tool call whose follow-up already exists further down.
 *
 * No content cache here: a chat view re-reads a file that is being appended to, and a cache keyed
 * on mtime would be a cache that misses every time by construction while holding whole transcripts
 * in memory.
 */
/**
 * How many times this conversation has been COMPACTED.
 *
 * The harness DECLARES it (`isCompactSummary: true` on the entry it writes), so this is a count of
 * something stated rather than a heuristic — the same field `classifyUserEntry` uses to keep a
 * compaction summary out of the chat as a message nobody sent.
 *
 * Over the WHOLE file, never the chat window: it answers "how much of this conversation has already
 * been thrown away", and counting only the part still on screen would answer it with the one number
 * that is always too low. Measured on a real 39 MB transcript: 70 ms.
 *
 * A file that cannot be read yields `null`, never `0` — "no compactions" and "we could not look"
 * are different facts, and a confident zero here would read as a fresh conversation.
 */
export async function countCompactions(path: string): Promise<number | null> {
  let content: string
  try { content = await readFile(path, 'utf-8') } catch { return null }
  let n = 0
  for (const line of content.split('\n')) if (line.includes('"isCompactSummary":true')) n++
  return n
}

export async function readChatTurns(path: string, max = 400): Promise<ChatTurn[]> {
  return (await readChatWindow(path, max)).turns
}

/**
 * The same read, plus whether the window CUT the conversation short.
 *
 * The cap is a fact about the READ, not about the conversation, and every surface built on top of
 * these turns inherits it silently: the gallery lists the files of the turns it was given, so on a
 * long transcript it emptied itself with nothing on screen saying why — reported exactly that way,
 * as "everything in the gallery disappeared and there is no warning about it". A window that hides
 * things has to say it is a window. `older` is true only when the walk stopped ON the cap with
 * substantive lines still above it; a conversation shorter than `max` reports nothing.
 */
export async function readChatWindow(
  path: string,
  max = 400,
): Promise<{ turns: ChatTurn[]; older: boolean }> {
  let content: string
  try { content = await readFile(path, 'utf-8') } catch { return { turns: [], older: false } }

  const lines = content.split('\n')
  const turns: ChatTurn[] = []
  /** Tasks started in this file, and the `tool-use-id` each completion will name. */
  const taskTurns: Array<{ id: string; turn: ChatTurn }> = []
  /** Ids whose `<task-notification>` has already arrived. */
  const finishedTasks = new Set<string>()
  let newest = true
  // Hoisted so the walk can report WHERE it stopped — see `older` at the return.
  let i = lines.length - 1
  for (; i >= 0 && turns.length < max; i--) {
    const line = (lines[i] ?? '').trim()
    if (!line) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(line) } catch { continue }
    const isNewest = newest
    newest = false

    // The event's own time. Stamped onto whatever this iteration pushes — the Live feed's whole
    // promise is its ordering, and a turn with no recorded time gets none rather than an invented
    // "now". THIS is the loop the chat view reads; an earlier one in this file builds the six-row
    // tail and was stamped first by mistake, which is why the feed showed no times at all.
    const at = typeof e.timestamp === 'string' ? e.timestamp : undefined
    const add = (t: ChatTurn): void => { turns.push(at ? { ...t, at } : t) }

    const done = taskNotificationFor(rawEntryText(e))
    if (done) finishedTasks.add(done)

    const bg = extractBackgroundTask(e)
    if (bg) {
      // A status line, never a message — nobody said it. `running` is settled after the walk,
      // once every completion in the file has been seen.
      add({ role: 'assistant', text: bg.label, task: { label: bg.label, running: true }, pending: true })
      taskTurns.push({ id: bg.id, turn: turns[turns.length - 1]! })
      continue
    }

    const userEntry = extractUserEntry(e)
    if (userEntry) { add(userTurn(userEntry)); continue }
    const queued = extractQueuedEntry(e)
    if (queued) { add(userTurn(queued)); continue }

    // An assistant event can carry text, thinking and tool calls at once, and all three belong to
    // the same turn. Emitted together rather than as separate rows: they happened together, and
    // splitting them puts the reasoning under the answer it produced.
    const assistantText = extractAssistantText(e)
    const calls = extractToolCalls(e)
    const thinking = extractThinking(e)
    if (assistantText || calls.length > 0 || thinking) {
      add({
        role: 'assistant',
        text: assistantText ?? '',
        ...(calls.length > 0 ? { tools: calls } : {}),
        ...(thinking ? { thinking } : {}),
        // Only the NEWEST event can be "still running": the same shape earlier in the file is a
        // finished call whose result already exists further down.
        ...(isNewest && !assistantText && calls.length > 0 ? { pending: true } : {}),
      })
    }
  }
  // Settled AFTER the walk: a completion always comes later in the file than its start, so this is
  // the only point where "still running" can be answered without reading the file twice. An id
  // that never arrives stays running — which is the truth for a task the session is still on, and
  // for one whose session ended mid-flight there is nothing better to say.
  for (const t of taskTurns) {
    if (t.turn.task && finishedTasks.has(t.id)) {
      t.turn.task.running = false
      delete t.turn.pending
    }
  }

  turns.reverse()
  // The walk stopped on the cap with content still above it: this is a WINDOW onto a longer
  // conversation, and every surface reading these turns has to be able to say so. A blank tail is
  // not content — a transcript ends with one, and reporting that as "there is more" would put the
  // notice on every conversation.
  const older = i >= 0 && lines.slice(0, i + 1).some(l => l.trim() !== '')
  return { turns, older }
}
