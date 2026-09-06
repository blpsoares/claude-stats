/**
 * step-web.ts — ONE step of a session's work, for the Live feed's expanding rows.
 *
 * The sibling of `chat-web.ts`: same row resolution, same conversation link, same refusal wording.
 * All it adds is the read, and the read's one interesting decision.
 *
 * IT READS THE TAIL FIRST. `chat-tail.ts` records why reading whole transcripts on a timer is a
 * disk-burner (nine live transcripts, 31 MB, re-read every five seconds, `/api/fleet` answering in
 * 5-8 s). This route is polled too — a RUNNING step is polled until it finishes, which is the whole
 * point of "expanding in real time" — and a running step is by construction the NEWEST thing in the
 * file. So the tail window answers every polled read, and only a step scrolled back to in history
 * costs a full read: once, because a finished step never polls again.
 */

import type { StartHost } from '../cli-start'
import type { CliLang } from '../cli-lang'
import { controlStrings } from '@agentistics/tui/control/i18n'
import { resolveChatTranscriptPath } from './chat-tail'
// The tail window moved into `transcript-window.ts`, shared with every harness reader.
import { TAIL_BYTES, readTailBytes } from './transcript-window'
import { conversationOfRow } from './row-conversation'
import { findStepInTranscript, validStepRef, type StepDetail } from './step-detail'
import { readFile } from 'node:fs/promises'

export type StepResponse =
  | ({ ok: true } & StepDetail)
  /** Already localized. "I cannot open this one" and "there is nothing here" are different facts. */
  | { ok: false; message: string }

/** The shape a subagent id must have before it is allowed to name a file. Mirrors `subagents-web`. */
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/

export async function readSessionStep(
  host: StartHost,
  lang: CliLang,
  id: string,
  ref: string,
  /**
   * Open a step of a SUBAGENT's own conversation rather than the session's.
   *
   * The subagents aside renders its activity with the same feed and the same expanding rows, and
   * those rows carry refs from the subagent's transcript — which are not in the parent's. Without
   * this they would all answer "this step is not in this transcript", which is rule 1 of
   * `stepDetail.ts` broken from the server side.
   */
  agentId?: string,
): Promise<StepResponse> {
  const pt = lang === 'pt'
  if (!host.sessions) return { ok: false, message: controlStrings(lang).sessionsNoHost }
  // Checked BEFORE anything is read: this string decides how much of a multi-MB file is scanned.
  if (!validStepRef(ref)) {
    return {
      ok: false,
      message: pt ? 'Esse passo não tem um identificador válido.' : 'That step has no valid identifier.',
    }
  }

  const fleet = await host.sessions()
  const row = fleet.sessions.find(r => r.id === id || r.conversationId === id)
  if (!row) {
    return {
      ok: false,
      message: pt
        ? 'Esta sessão não está mais na lista desta máquina.'
        : 'This session is no longer in this machine’s list.',
    }
  }

  const conversationId = conversationOfRow(row)
  if (!conversationId) {
    return {
      ok: false,
      message: row.conversationBlind ?? (pt
        ? 'Esta sessão não tem uma conversa vinculada, então não há transcrição para abrir.'
        : 'This session has no linked conversation, so there is no transcript to open.'),
    }
  }

  const conversationPath = await resolveChatTranscriptPath(row.cwd, conversationId).catch(() => null)
  if (agentId !== undefined && !AGENT_ID.test(agentId)) {
    return { ok: false, message: pt ? 'Identificador de subagente inválido.' : 'Invalid subagent identifier.' }
  }
  const path = conversationPath === null || agentId === undefined
    ? conversationPath
    : `${conversationPath.replace(/\.jsonl$/, '')}/subagents/agent-${agentId}.jsonl`
  if (!path) {
    return {
      ok: false,
      message: pt
        ? 'A transcrição desta conversa não está mais no disco.'
        : 'This conversation’s transcript is no longer on disk.',
    }
  }

  // The tail answers every POLLED read — a running step is the newest thing in the file.
  const tail = await readTailBytes(path, TAIL_BYTES)
  if (tail) {
    // Drop a partial first line: the window almost always starts mid-line, and mid-character for any
    // multi-byte codepoint. Same rule `readChatTurns` applies to the same window.
    const text = tail.atStart ? tail.text : tail.text.slice(tail.text.indexOf('\n') + 1)
    const found = findStepInTranscript(text, ref)
    if (found) return { ok: true, ...found }
    if (tail.atStart) return notFound(pt)
  }

  // Only a step scrolled back to in history gets here, and only once: it is finished, so nothing
  // polls it again.
  let whole: string
  try { whole = await readFile(path, 'utf-8') } catch { return notFound(pt) }
  const found = findStepInTranscript(whole, ref)
  return found ? { ok: true, ...found } : notFound(pt)
}

function notFound(pt: boolean): StepResponse {
  return {
    ok: false,
    message: pt
      ? 'Este passo não está nesta transcrição.'
      : 'This step is not in this transcript.',
  }
}
