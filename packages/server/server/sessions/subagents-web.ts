/**
 * subagents-web.ts — the SUBAGENTS one conversation ran, for the workspace's aside.
 *
 * The rules are the pure `subagents.ts`; this is the read. Three decisions live here.
 *
 * 1. THE CAPABILITY DECIDES, and a harness that cannot report subagents is told apart from a
 *    session that ran none. `HARNESS_CAPABILITIES[...].agents` is `true` for claude alone, and
 *    answering "0 subagents" for the other five would be the confident zero this whole area keeps
 *    being asked not to give.
 * 2. AN AGENT ID FROM A CLIENT NEVER REACHES A PATH UNCHECKED. It names a file, so it is matched
 *    against a closed shape first — the same discipline `artifact-file.ts` applies to a path.
 * 3. THE OUTCOMES COST A FULL READ OF THE PARENT, and that is why the browser polls this only while
 *    something is actually running. `<task-notification>` lines are anywhere in the file, so a tail
 *    would report a long-finished agent as running on a live session — a wrong answer to buy a read
 *    nobody is waiting on. It is ONE session's transcript while ONE tab is open, not the every-poll
 *    every-session read `chat-tail.ts` documents as a disk-burner.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { HARNESS_CAPABILITIES, totalTokens, type HarnessId, type TokenBreakdown } from '@agentistics/core'
import type { StartHost } from '../cli-start'
import type { CliLang } from '../cli-lang'
import { readChatWindow, resolveChatTranscriptPath, type ChatTurn } from './chat-tail'
import { conversationOfRow } from './row-conversation'
import {
  DEFAULT_AGENT_PAGE, agentIdFromFile, pageOfAgents, parseSubagentMeta, parseTaskOutcomes,
  subagentCost, subagentStatus, summarizeSubagent,
  type AgentFile, type SubagentMeta, type SubagentStatus, type SubagentUsage,
} from './subagents'

/** The shape an id from a client must have before it is allowed to name a file. */
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/

export interface SubagentRow {
  agentId: string
  agentType?: string
  description?: string
  /** The alias the call asked for (`haiku`); `modelId` is what actually answered and gets priced. */
  model?: string
  modelId?: string
  status: SubagentStatus
  /** The parent's `tool_use` id — the same `ref` the Live feed's row carries. */
  toolUseId?: string
  spawnDepth?: number
  /** The four counters, or `null` when the agent has not answered yet. NEVER a zeroed breakdown. */
  tokens: TokenBreakdown | null
  /** Every counter summed — the number the word "tokens" means here. `null` with `tokens`. */
  totalTokens: number | null
  /** `null` when there are no tokens, or no model the pricing table can resolve. */
  costUSD: number | null
  toolCalls: number
  turns: number
  startedAt?: string
  lastAt?: string
}

export type SubagentsPayload =
  | {
      ok: true
      supported: true
      rows: SubagentRow[]
      /** How many agents exist in all, so a page can say it is a page. */
      total: number
      /** There are older ones behind this page. */
      hasMore: boolean
    }
  /** This harness cannot report subagents at all — already localized, and NOT an empty list. */
  | { ok: true; supported: false; message: string }
  | { ok: false; message: string }

/**
 * A subagent transcript's summary, memoized on the file's own mtime + size.
 *
 * Without it this route re-read every transcript on every poll. Measured on one conversation: 57
 * agents, ~32 MB of transcript, 2,9 s per request — and the browser polls it while an agent runs.
 * A FINISHED agent's transcript never changes, so it is summarised once; only the ones still
 * writing are read again. The key is mtime AND size because either can move alone under an append.
 */
const summaryMemo = new Map<string, { mtimeMs: number; size: number; usage: SubagentUsage }>()

/**
 * The parent's `<task-notification>` outcomes, memoized on ITS stamp.
 *
 * One list request scans the whole conversation for them — 4,4 MB on a real one here — and paging
 * would otherwise pay that on every page. A finished conversation is scanned once; a live one is
 * re-scanned when it grows, which is exactly when a new outcome can appear.
 */
const outcomeMemo = new Map<string, { mtimeMs: number; size: number; outcomes: Map<string, string> }>()

async function readOutcomes(path: string): Promise<Map<string, string>> {
  let mtimeMs: number
  let size: number
  try {
    const st = await stat(path)
    mtimeMs = st.mtimeMs
    size = st.size
  } catch { return new Map() }
  const hit = outcomeMemo.get(path)
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.outcomes
  const outcomes = await readFile(path, 'utf-8').then(parseTaskOutcomes).catch(() => new Map<string, string>())
  outcomeMemo.set(path, { mtimeMs, size, outcomes })
  return outcomes
}

/** Reset the memo. Tests only. */
export function forgetSubagentSummaries(): void {
  summaryMemo.clear()
  outcomeMemo.clear()
}

async function summarize(path: string): Promise<SubagentUsage> {
  const unmeasured: SubagentUsage = { tokens: null, model: null, toolCalls: 0, turns: 0 }
  let mtimeMs: number
  let size: number
  try {
    const st = await stat(path)
    mtimeMs = st.mtimeMs
    size = st.size
  } catch {
    // An unreadable transcript is an UNMEASURED agent, not one that spent nothing.
    return unmeasured
  }
  const hit = summaryMemo.get(path)
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.usage
  const usage = await readFile(path, 'utf-8').then(summarizeSubagent).catch(() => unmeasured)
  summaryMemo.set(path, { mtimeMs, size, usage })
  return usage
}

/** `<conversation>.jsonl` → the directory the harness writes that conversation's subagents into. */
function subagentsDirFor(transcriptPath: string): string {
  return `${transcriptPath.replace(/\.jsonl$/, '')}/subagents`
}

interface Resolved {
  row: { harness?: string; cwd?: string; state?: string; conversationBlind?: string }
  transcript: string
  live: boolean
}

async function resolve(
  host: StartHost, lang: CliLang, id: string,
): Promise<Resolved | { error: string }> {
  const pt = lang === 'pt'
  const fleet = await host.sessions!()
  const row = fleet.sessions.find(r => r.id === id || r.conversationId === id)
  if (!row) {
    return {
      error: pt
        ? 'Esta sessão não está mais na lista desta máquina.'
        : 'This session is no longer in this machine’s list.',
    }
  }
  const conversationId = conversationOfRow(row)
  if (!conversationId) {
    return {
      error: row.conversationBlind ?? (pt
        ? 'Esta sessão não tem uma conversa vinculada, então não há subagentes para listar.'
        : 'This session has no linked conversation, so there are no subagents to list.'),
    }
  }
  const transcript = await resolveChatTranscriptPath(row.cwd, conversationId).catch(() => null)
  if (!transcript) {
    return {
      error: pt
        ? 'A transcrição desta conversa não está mais no disco.'
        : 'This conversation’s transcript is no longer on disk.',
    }
  }
  const live = row.state === 'working' || row.state === 'waiting' || row.state === 'waiting-approval'
  return { row, transcript, live }
}

/** The capability sentence — said in words, never as an empty list. */
function unsupported(harness: string | undefined, lang: CliLang): string {
  const name = harness ?? '?'
  return lang === 'pt'
    ? `${name} não registra os subagentes que uma sessão executa, então não há nada para listar aqui — isto é uma ausência de dados, não uma sessão sem subagentes.`
    : `${name} does not record the subagents a session runs, so there is nothing to list here — that is missing data, not a session that ran none.`
}

export async function readSessionSubagents(
  host: StartHost, lang: CliLang, id: string,
  page: { limit?: number; offset?: number } = {},
): Promise<SubagentsPayload> {
  if (!host.sessions) return { ok: false, message: 'no session host' }
  const r = await resolve(host, lang, id)
  if ('error' in r) return { ok: false, message: r.error }

  const harness = r.row.harness as HarnessId | undefined
  const caps = harness ? HARNESS_CAPABILITIES[harness] : undefined
  if (!caps?.agents) return { ok: true, supported: false, message: unsupported(harness, lang) }

  const dir = subagentsDirFor(r.transcript)
  let names: string[]
  // A conversation that ran no subagents has no directory at all — a real empty list, and a
  // different fact from the harness not recording them.
  try { names = await readdir(dir) } catch { return { ok: true, supported: true, rows: [], total: 0, hasMore: false } }

  /**
   * ONE `stat` PER AGENT, and nothing opened yet.
   *
   * This is the whole point of paging here: choosing which twenty to show costs a stat each, while
   * SUMMARISING one costs reading its transcript. 57 agents over 35 MB is what made this tab take
   * long enough to look broken.
   */
  const files: AgentFile[] = []
  await Promise.all(names.map(async name => {
    const agentId = agentIdFromFile(name)
    if (!agentId) return
    const st = await stat(`${dir}/${name}`).catch(() => null)
    // A file we cannot stat still EXISTS and is still an agent; it simply sorts oldest.
    files.push({ agentId, mtimeMs: st?.mtimeMs ?? 0 })
  }))
  const chosen = pageOfAgents(files, page.limit ?? DEFAULT_AGENT_PAGE, page.offset ?? 0)

  const outcomes = await readOutcomes(r.transcript)

  const rows: SubagentRow[] = []
  for (const { agentId } of chosen.files) {
    const meta = await readFile(`${dir}/agent-${agentId}.meta.json`, 'utf-8')
      .then(raw => parseSubagentMeta(agentId, raw))
      .catch((): SubagentMeta => ({ agentId }))
    const usage = await summarize(`${dir}/agent-${agentId}.jsonl`)
    const tokens = usage.tokens
    rows.push({
      agentId,
      ...(meta.agentType ? { agentType: meta.agentType } : {}),
      ...(meta.description ? { description: meta.description } : {}),
      ...(meta.model ? { model: meta.model } : {}),
      ...(usage.model ? { modelId: usage.model } : {}),
      ...(meta.toolUseId ? { toolUseId: meta.toolUseId } : {}),
      ...(meta.spawnDepth !== undefined ? { spawnDepth: meta.spawnDepth } : {}),
      status: subagentStatus(outcomes.get(agentId), r.live),
      tokens,
      totalTokens: tokens ? totalTokens(tokens) : null,
      costUSD: subagentCost(tokens, usage.model),
      toolCalls: usage.toolCalls,
      turns: usage.turns,
      ...(usage.startedAt ? { startedAt: usage.startedAt } : {}),
      ...(usage.lastAt ? { lastAt: usage.lastAt } : {}),
    })
  }

  // The ORDER was already decided by `pageOfAgents`, from the files' own last-write times — not
  // re-sorted here on `startedAt`, or page 2 would interleave with page 1.
  return { ok: true, supported: true, rows, total: chosen.total, hasMore: chosen.hasMore }
}

export type SubagentActivityPayload =
  | {
      ok: true
      turns: ChatTurn[]
      status: SubagentStatus
      /**
       * The read stopped ON its cap with more conversation above it.
       *
       * A window that hides things has to say it is a window — the rule `readChatWindow` exists
       * for, applied to the surface that inherits the same cap. A subagent that ran for hours is
       * exactly the one whose feed gets cut, and a feed that silently starts in the middle reads
       * as an agent that began there.
       */
      older: boolean
    }
  | { ok: false; message: string }

/**
 * ONE subagent's own conversation — what it is doing, or what it did.
 *
 * It is read with `readChatTurns`, the very reader the chat view uses, so a subagent's activity is
 * parsed by one implementation rather than a second one that would drift from it.
 */
export async function readSubagentActivity(
  host: StartHost, lang: CliLang, id: string, agentId: string,
): Promise<SubagentActivityPayload> {
  const pt = lang === 'pt'
  if (!host.sessions) return { ok: false, message: 'no session host' }
  // Rule 2: it names a file, so it is checked before it can.
  if (!AGENT_ID.test(agentId)) {
    return { ok: false, message: pt ? 'Identificador de subagente inválido.' : 'Invalid subagent identifier.' }
  }
  const r = await resolve(host, lang, id)
  if ('error' in r) return { ok: false, message: r.error }

  const path = `${subagentsDirFor(r.transcript)}/agent-${agentId}.jsonl`
  let turns: ChatTurn[]
  let older = false
  try {
    const read = await readChatWindow(path)
    turns = read.turns
    older = read.older
  } catch { turns = [] }
  if (turns.length === 0) {
    // Launched and silent so far, or a transcript that is gone. Both are said rather than drawn as
    // an empty pane, which reads as "it did nothing".
    const outcomes = await readOutcomes(r.transcript)
    const status = subagentStatus(outcomes.get(agentId), r.live)
    return status === 'running'
      ? { ok: true, turns: [], status, older: false }
      : {
        ok: false,
        message: pt
          ? 'Não há transcrição para este subagente — ele não escreveu nada, ou o arquivo não está mais no disco.'
          : 'There is no transcript for this subagent — it wrote nothing, or the file is no longer on disk.',
      }
  }
  const outcomes = await readOutcomes(r.transcript)
  return { ok: true, turns, status: subagentStatus(outcomes.get(agentId), r.live), older }
}
