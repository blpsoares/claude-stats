/**
 * Resolving "which conversation is this row, and is it live?" — one implementation.
 *
 * Every session-scoped reader needs the same three steps (find the row, find its conversation,
 * find the transcript on disk) and the same three REFUSALS in the user's language. This lived
 * inside `subagents-web.ts` while that was the only reader; the workflows reader needs it
 * identically, and a second copy would be a second set of sentences to drift.
 */
import type { StartHost } from '../cli-start'
import type { CliLang } from '../cli-lang'
import { conversationOfRow } from './row-conversation'
import { resolveChatTranscriptPath } from './chat-tail'

export interface Resolved {
  row: { harness?: string; cwd?: string; state?: string; conversationBlind?: string }
  transcript: string
  live: boolean
}

export async function resolveSessionTranscript(
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

