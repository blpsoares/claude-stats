/**
 * harness-transcript.ts — WHICH harnesses can have their conversation read, and how.
 *
 * `Record<HarnessId, HarnessTranscript | null>`, so the compiler asks about a new harness on the
 * day it is added and a reader that does not exist is ABSENT rather than a call that fails. The
 * caller turns a `null` into a sentence; it never turns it into an empty conversation, which is the
 * defect this module was written to remove. Measured 2026-09-05 on a live antigravity session:
 * `GET /api/fleet/chat` answered `{"turns":[],"live":true}` and `SessionChat.tsx` drew a completely
 * blank pane with nothing on it explaining why — no reader, no refusal, no words.
 *
 * A READER IS ONLY EVER OFFERED A CONVERSATION ID THAT IS EXACT. `SessionView.conversationId` is
 * filled solely from `ManagedSession.conversationId`, which exists only because agentop handed that
 * id to the CLI (`SpawnSpec.assignId`, or `resume`) — verified on the live agy session, whose
 * `/proc/<pid>/cmdline` reads `agy --conversation 01d0814f-…` for exactly the id the registry
 * holds. The harness-and-directory INFERENCE behind `resume` never reaches here: it is good enough
 * to offer a reopen a person confirms by title, and putting SOME OTHER conversation from the same
 * folder on screen under this session's name is a confident wrong answer the reader cannot detect.
 *
 * Two budgets, deliberately. `read` is the CHAT VIEW's and reads the conversation; `readRecent` is
 * the 5 s fleet poll's and reads only the end of the file through `transcript-window.ts`. A poll
 * that reads whole transcripts is what made `/api/fleet` answer in 36 s cold — see that module's
 * header for the measurement.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessId } from '@agentistics/core'
import { ANTIGRAVITY_BRAIN_DIR, CODEX_SESSIONS_DIR, COPILOT_DIR, KIMI_DIR } from '../config'
import { UUID_RE } from '../git'
import { parseAntigravityChat } from './antigravity-chat'
import { parseCodexChat } from './codex-chat'
import { parseCopilotChat } from './copilot-chat'
import { parseKimiChat } from './kimi-chat'
import type { ChatTurn } from './chat-turn'
import { readChatWindow, readRecentChatTurns, resolveChatTranscriptPath } from './chat-tail'
import { readTailWindow } from './transcript-window'

/** Everything a reader is told about the session whose conversation is wanted. */
export interface TranscriptRef {
  /** The harness's own conversation id, known EXACTLY — never inferred. See the header. */
  conversationId: string
  /** The session's working directory. Some harnesses key their store on it; agy does not. */
  cwd?: string
}

/**
 * One read of a conversation, and whether the WINDOW cut it short.
 *
 * `older` is the honesty `readChatWindow` introduced for Claude and every reader owes: the cap is a
 * fact about the READ, not about the conversation, and everything built on these turns inherits it
 * silently — the gallery lists the files of the turns it was given, so on a long transcript it
 * emptied itself with nothing saying why. A window that hides things has to say it is a window.
 */
export interface TranscriptRead {
  /** The turns, oldest first. */
  turns: ChatTurn[]
  /** The read stopped ON the cap with more conversation above it. */
  older: boolean
}

export interface HarnessTranscript {
  /** The absolute path to this conversation's transcript here, or `null` when there is none. */
  resolve(ref: TranscriptRef): Promise<string | null>
  /** The conversation, oldest first, capped at `max` turns from the end. */
  read(path: string, max: number): Promise<TranscriptRead>
  /** The last `max` turns only, read from the END of the file. The fleet poll's budget. */
  readRecent(path: string, max: number): Promise<ChatTurn[]>
}

/**
 * Ask a backward-walking parser for ONE turn more than the window, and the answer says both things.
 *
 * Every reader but Claude's walks from the end and stops at its cap, so "did the window cut this
 * short" is exactly "was there a turn beyond it". Asking for `max + 1` and getting it back IS that
 * evidence, which is the same question `readChatWindow` answers by hoisting its loop index — one
 * extra turn parsed instead of a second return channel through four pure parsers and their tests.
 *
 * THE `+ 1` IS WHAT MAKES IT EXACT, and it is the whole reason `older` can be REQUIRED of every
 * reader rather than optional. Inferring the answer from `turns.length === max` would call a
 * conversation of exactly `max` turns a window — a false sentence in the reassuring direction — so
 * that inference is refused; this one asks for a turn BEYOND the window and claims `older` only if
 * one came back. An optional flag would have been the alternative, and it is worse in the direction
 * that matters: four readers silently answering "nothing was hidden" is the very bug the notice was
 * written to fix, on a transcript measured at 1239 turns against a 400-turn window.
 */
function windowed(all: ChatTurn[], max: number): TranscriptRead {
  return all.length > max
    ? { turns: all.slice(all.length - max), older: true }
    : { turns: all, older: false }
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}

/**
 * agy writes one directory per conversation under `brain/`, and the transcript inside it.
 *
 * `transcript_full.jsonl` is the whole thing and `transcript.jsonl` is a truncated copy of it —
 * the same pair, and the same preference, `antigravity-parse.ts` records. Measured on the live
 * conversation: 5.598.537 bytes against 3.669.964, both being appended to as it ran.
 */
export async function resolveAntigravityTranscript(
  ref: TranscriptRef,
  // Overridable only so a test can point at a fixture tree without a subprocess — `config.ts`'s
  // constants are fixed at import time and shared across a whole `bun test` run. Same escape hatch,
  // for the same reason, as `resolveChatTranscriptPath`'s `projectsDir`.
  brainDir: string = ANTIGRAVITY_BRAIN_DIR,
): Promise<string | null> {
  if (!UUID_RE.test(ref.conversationId)) return null
  const dir = join(brainDir, ref.conversationId, '.system_generated', 'logs')
  for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
    const p = join(dir, name)
    if (await exists(p)) return p
  }
  return null
}

const ANTIGRAVITY: HarnessTranscript = {
  resolve: resolveAntigravityTranscript,
  async read(path, max) {
    // No cache and no window: a chat view re-reads a file that is being appended to, and a cache
    // keyed on mtime would miss every time by construction while holding whole transcripts in
    // memory. Same call `chat-tail.ts`'s `readChatTurns` makes, for the same reason.
    let content: string
    try { content = await readFile(path, 'utf-8') } catch { return { turns: [], older: false } }
    return windowed(parseAntigravityChat(content.split('\n'), 'antigravity', max + 1), max)
  },
  async readRecent(path, max) {
    return readTailWindow(path, max, lines => parseAntigravityChat(lines, 'antigravity', max))
  },
}


/**
 * Codex files its rollouts by DAY — `sessions/YYYY/MM/DD/rollout-<time>-<conversation-id>.jsonl` —
 * and the conversation id is both the filename suffix and `session_meta.id` inside (verified: the
 * file `rollout-2026-07-07T19-02-05-019f3e9a-…` carries `id: 019f3e9a-…`). It is the id
 * `codex-parse.ts` keys a session by, so it is the id the registry recorded and the one
 * `codex resume <id>` takes.
 *
 * The scan is three shallow `readdir`s rather than one deep walk, and both the hit and the MISS are
 * memoized — a machine keeps a directory per day forever, so an unresolvable id must cost one scan
 * and not one per poll. Same rule, same reason, as `resolveChatTranscriptPath`'s own cache.
 */
const codexPathCache = new Map<string, string | null>()

/** Reset the memo. Tests only. */
export function forgetCodexTranscriptPaths(): void {
  codexPathCache.clear()
}

async function subdirs(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter(d => d.isDirectory())
      .map(d => d.name)
  } catch { return [] }
}

async function scanCodexRollout(id: string, root: string): Promise<string | null> {
  const suffix = `-${id}.jsonl`
  for (const year of await subdirs(root)) {
    for (const month of await subdirs(join(root, year))) {
      for (const day of await subdirs(join(root, year, month))) {
        const dir = join(root, year, month, day)
        let names: string[]
        try { names = await readdir(dir) } catch { continue }
        const hit = names.find(n => n.startsWith('rollout-') && n.endsWith(suffix))
        if (hit) return join(dir, hit)
      }
    }
  }
  return null
}

export async function resolveCodexTranscript(
  ref: TranscriptRef,
  // Overridable for tests only — see `resolveAntigravityTranscript`'s note.
  sessionsDir: string = CODEX_SESSIONS_DIR,
): Promise<string | null> {
  // Codex's ids are UUIDv7; `UUID_RE` is version-agnostic, so this rejects a path fragment without
  // rejecting the real thing.
  if (!UUID_RE.test(ref.conversationId)) return null
  const cached = codexPathCache.get(ref.conversationId)
  if (cached !== undefined) return cached
  const found = await scanCodexRollout(ref.conversationId, sessionsDir)
  codexPathCache.set(ref.conversationId, found)
  return found
}

const CODEX: HarnessTranscript = {
  resolve: ref => resolveCodexTranscript(ref),
  async read(path, max) {
    let content: string
    try { content = await readFile(path, 'utf-8') } catch { return { turns: [], older: false } }
    return windowed(parseCodexChat(content.split('\n'), 'codex', max + 1), max)
  },
  async readRecent(path, max) {
    return readTailWindow(path, max, lines => parseCodexChat(lines, 'codex', max))
  },
}


/**
 * Copilot names the session's DIRECTORY with its own id — verified: the folder
 * `dbd94500-8d79-4c7c-8c69-a2cd0c044201` holds an `events.jsonl` whose `session.start` carries
 * exactly that `sessionId`. It is also the id `copilot --session-id <uuid>` assigns, which
 * `spawn-spec.ts` records as VERIFIED, so a copilot session agentop STARTED is linked from its
 * first turn rather than only after a reopen. No scan is needed.
 */
export async function resolveCopilotTranscript(
  ref: TranscriptRef,
  stateDir: string = join(COPILOT_DIR, 'session-state'),
): Promise<string | null> {
  if (!UUID_RE.test(ref.conversationId)) return null
  const p = join(stateDir, ref.conversationId, 'events.jsonl')
  return (await exists(p)) ? p : null
}

const COPILOT: HarnessTranscript = {
  resolve: ref => resolveCopilotTranscript(ref),
  async read(path, max) {
    let content: string
    try { content = await readFile(path, 'utf-8') } catch { return { turns: [], older: false } }
    return windowed(parseCopilotChat(content.split('\n'), 'copilot', max + 1), max)
  },
  async readRecent(path, max) {
    return readTailWindow(path, max, lines => parseCopilotChat(lines, 'copilot', max))
  },
}

/**
 * Kimi files a session under its WORKSPACE — `sessions/<workspaceId>/session_<uuid>/` — so the
 * conversation id alone does not name a path and the workspace directories have to be listed. One
 * shallow `readdir` plus a `stat` per workspace, memoized like codex's for the same reason.
 *
 * ONLY THE `main` AGENT IS READ. A kimi session can hold several agents and `kimi-parse.ts` folds
 * every one of them into its metrics, which is right for a COUNT — the work happened. A CHAT is a
 * different question: `main` is the conversation the person had, and a subagent's wire is the
 * assistant's own working notes, so splicing them together would interleave two dialogues under one
 * heading. Measured: every one of the 14 sessions on this machine has exactly one agent, `main`. The
 * fallback to the first agent directory costs nothing and covers a session that somehow has none.
 */
const kimiPathCache = new Map<string, string | null>()

/** Reset the memo. Tests only. */
export function forgetKimiTranscriptPaths(): void {
  kimiPathCache.clear()
}

async function findKimiWire(id: string, root: string): Promise<string | null> {
  for (const ws of await subdirs(root)) {
    const agents = join(root, ws, `session_${id}`, 'agents')
    const main = join(agents, 'main', 'wire.jsonl')
    if (await exists(main)) return main
    const others = await subdirs(agents)
    for (const a of others) {
      const p = join(agents, a, 'wire.jsonl')
      if (await exists(p)) return p
    }
  }
  return null
}

export async function resolveKimiTranscript(
  ref: TranscriptRef,
  sessionsDir: string = join(KIMI_DIR, 'sessions'),
): Promise<string | null> {
  if (!UUID_RE.test(ref.conversationId)) return null
  const cached = kimiPathCache.get(ref.conversationId)
  if (cached !== undefined) return cached
  const found = await findKimiWire(ref.conversationId, sessionsDir)
  kimiPathCache.set(ref.conversationId, found)
  return found
}

const KIMI: HarnessTranscript = {
  resolve: ref => resolveKimiTranscript(ref),
  async read(path, max) {
    let content: string
    try { content = await readFile(path, 'utf-8') } catch { return { turns: [], older: false } }
    return windowed(parseKimiChat(content.split('\n'), 'kimi', max + 1), max)
  },
  async readRecent(path, max) {
    return readTailWindow(path, max, lines => parseKimiChat(lines, 'kimi', max))
  },
}

const CLAUDE: HarnessTranscript = {
  resolve: ref => (ref.cwd === undefined
    ? Promise.resolve(null)
    : resolveChatTranscriptPath(ref.cwd, ref.conversationId)),
  read: (path, max) => readChatWindow(path, max),
  readRecent: (path, max) => readRecentChatTurns(path, max),
}

/**
 * The reader for each harness, and the one `null` that is not a gap.
 *
 * GEMINI CAN NEVER BE READ HERE, and that is a fact about the LINK rather than about the format.
 * A reader is only ever offered a `conversationId`, and `ManagedSession.conversationId` exists only
 * where agentop handed the id to the CLI. Measured against `spawn-spec.ts`: claude and copilot have
 * `assignId`, and codex, kimi and antigravity have `resume` — so every one of those five can carry
 * an exact id. **Gemini has neither** (`-r, --resume` takes "latest" or an index, not an id, and
 * `--session-id` is deliberately excluded because gemini's id in this product is synthetic —
 * `${dir}/${file}` — so a recorded UUID would resolve to nothing while LOOKING exact). A gemini row
 * therefore never has a conversation id at all, `conversationBlind` already says so in words, and
 * `SessionsPage` hides the chat tab on such a row.
 *
 * So a gemini entry here would be code nothing can reach, plus a claim the product cannot honour.
 * Its chat file WAS read and understood — it is a patch log, not one message per line: a header,
 * then `{"$set":{messages:[…]}}` seeding the list once (measured: 1 seed, always at line 1, in 4 of
 * 12 files) and bare message objects appended after it, with types `user` / `gemini` / `info` /
 * `error` and a `<session_context>` bootstrap block the harness writes under the user role. That
 * note is here so the next reader of this file does not spend the measurement again, and so the
 * absence reads as a finding rather than as a to-do. It becomes writable the day gemini accepts an
 * id agentop can hand it — not before.
 */
export const HARNESS_TRANSCRIPTS: Record<HarnessId, HarnessTranscript | null> = {
  claude: CLAUDE,
  antigravity: ANTIGRAVITY,
  codex: CODEX,
  copilot: COPILOT,
  kimi: KIMI,
  gemini: null,
}

/**
 * The reader for a harness named as a plain string.
 *
 * `ControlSession.harness` is a `string` — a `HarnessId`, or `''` when the registry has forgotten
 * which harness a row is. Both of those, and an id from a newer build, resolve to `null` here
 * rather than to a throw: a row nobody can name is a row whose conversation nobody can read.
 */
export function transcriptReaderFor(harness: string | undefined): HarnessTranscript | null {
  if (!harness) return null
  return HARNESS_TRANSCRIPTS[harness as HarnessId] ?? null
}
