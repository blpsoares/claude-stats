/**
 * pending-prompts.ts — a message handed to a session and not yet visible in its transcript.
 *
 * Reported: "quando eu envio uma mensagem pelo celular a mensagem não aparece em todos os
 * dispositivos… diferentes dispositivos, mesmo acessando a mesma aplicação, não estão
 * sincronizados". And then the worse half: "se eu fechar a aplicação e abrir de novo a mensagem
 * vira um fantasma e não dá pra saber se foi perdida ou está em fila".
 *
 * Both come from the same place. The queued message was a BROWSER fact — an echo held in the tab
 * that sent it — so a second device had no way to learn about it, and the tab that did know lost
 * the one thing that made it readable on a reload: when it was sent. A message you cannot tell
 * apart from a lost one is worse than either.
 *
 * So the queue moves to the server, which is the only party every device already agrees with. Two
 * consequences, and both are the point:
 *
 *  - **every device shows it**, because they all poll the same list;
 *  - **it carries `at`**, so any of them can say how long it has been waiting instead of showing a
 *    bubble with no age.
 *
 * IT IS IN MEMORY, DELIBERATELY. This is state about a message in flight, and the durable record of
 * whether it arrived is the transcript itself. A server restart drops the queue, which is honest:
 * afterwards the transcript either carries the message or it does not, and nothing here is claiming
 * otherwise. Persisting it would create the one thing this file exists to remove — an entry that
 * outlives the truth and cannot be told apart from it.
 *
 * RETIRING IS `pendingEchoes`, from `@agentistics/core`, which is where that rule now lives BECAUSE
 * of this file. The browser has always had it; a second implementation here would be a second
 * opinion about whether a message has landed, on the same screen, in the same second.
 */

import { pendingEchoes } from '@agentistics/core'

export interface PendingPrompt {
  /** Exactly what was handed to the session. */
  text: string
  /** When, as epoch ms — so any device can age it, not just the one that sent it. */
  at: number
}

/**
 * How long an unmatched entry is kept.
 *
 * `pendingEchoes` retires a message the transcript accounts for; this retires one it never will.
 * A harness can drop a line (a dialog swallowed it, the pane died mid-write), and without a ceiling
 * that message waits on every device forever — which is the ghost, moved from one browser to all of
 * them. Twenty minutes is far longer than any real queue here and far short of a session's life.
 */
export const PENDING_TTL_MS = 20 * 60 * 1000

/** The most entries kept per conversation — a runaway sender cannot grow this without bound. */
const MAX_PER_SESSION = 50

const byConversation = new Map<string, PendingPrompt[]>()

/** Record a message just handed to a session. Called only on a delivery the backend confirmed. */
export function recordPrompt(conversationId: string, text: string, now = Date.now()): void {
  if (conversationId === '' || text.trim() === '') return
  const list = byConversation.get(conversationId) ?? []
  list.push({ text, at: now })
  byConversation.set(conversationId, list.slice(-MAX_PER_SESSION))
}

/**
 * What is still waiting for this conversation, given the user turns its transcript now carries.
 *
 * PURE in everything that matters: the store is read and rewritten to what survives, so the same
 * comparison decides both what is returned and what is kept. Two passes could disagree.
 */
export function pendingFor(
  conversationId: string,
  userTurns: readonly string[],
  now = Date.now(),
): PendingPrompt[] {
  const list = byConversation.get(conversationId)
  if (list === undefined || list.length === 0) return []
  const fresh = list.filter(p => now - p.at < PENDING_TTL_MS)
  const stillWaiting = new Set(pendingEchoes(fresh.map(p => p.text), userTurns))
  const kept = fresh.filter(p => stillWaiting.has(p.text))
  if (kept.length === 0) byConversation.delete(conversationId)
  else byConversation.set(conversationId, kept)
  return kept
}

/** Drop everything for a conversation — used when a session is killed. */
export function clearPrompts(conversationId: string): void {
  byConversation.delete(conversationId)
}

/** Test seam only: the store is process-wide, so a test that writes must be able to reset it. */
export function resetPrompts(): void {
  byConversation.clear()
}
