/**
 * stepDetail.ts — PURE: the rules for a Live-feed row that OPENS.
 *
 * Asked for directly: the feed's `RAN` / `WROTE` lines should be clickable and expand under
 * themselves, in real time, showing what is being done — the command's output, the content written.
 * The server half is `/api/fleet/step` (`step-detail.ts`, `step-web.ts`); this is the browser's
 * side of it, and it exists as a module rather than as conditions inside the panel because three of
 * its four rules are honesty rules and honesty rules belong in tests.
 *
 * 1. A ROW THAT CANNOT OPEN DOES NOT OFFER TO. A transcript that carries no `tool_use` id gives a
 *    row nothing to resolve, and a chevron whose only outcome is "this step is not in this
 *    transcript" is the control-that-reads-as-broken this codebase argues against everywhere else.
 * 2. REASONING OPENS WITH NO REQUEST. Its whole text is already in the payload, so it must not be
 *    made to look like a fetch — an spinner over data we are holding is a lie about where it is.
 * 3. A RUNNING STEP POLLS; A FINISHED ONE NEVER DOES. "In real time" is exactly this, and its
 *    converse matters as much: a finished step polled forever is a request per second per open row,
 *    for an answer that cannot change.
 * 4. TRUNCATION IS SAID. The server cuts a long output at a ceiling and reports the cut; a reader
 *    draws conclusions from the end of a log, so a silent cut is worse than a short answer.
 */

import type { LiveEvent } from './artifactTabs'

/** The server's answer for one step. Mirrors `StepResponse` in `sessions/step-web.ts`. */
export type StepPayload =
  | {
      ok: true
      name: string
      input: string
      inputTruncated: boolean
      output: string | null
      outputTruncated: boolean
      isError: boolean
      running: boolean
    }
  | { ok: false; message: string }

/** What the panel holds for one opened row. `local` is rule 2 — here already, never fetched. */
export type StepState =
  | { phase: 'local'; text: string }
  | { phase: 'loading' }
  | { phase: 'ready'; step: Extract<StepPayload, { ok: true }> }
  | { phase: 'failed'; message: string }

/** Rule 1 + 2: can this row be opened at all, and does opening it need the server? */
export function stepOpenable(e: LiveEvent): 'local' | 'remote' | null {
  if (e.full !== undefined && e.full !== '') return 'local'
  if (e.ref !== undefined && e.ref !== '') return 'remote'
  return null
}

/**
 * Rule 3: how often an OPEN row asks again, or `null` for "never ask again".
 *
 * Only a step the server says is still RUNNING polls. A failure does not retry on a timer either —
 * it says what happened and waits to be asked again, because a refusal that repeats itself every
 * two seconds is a refusal nobody can read.
 */
export const STEP_POLL_MS = 2000

export function stepPollMs(state: StepState): number | null {
  return state.phase === 'ready' && state.step.running ? STEP_POLL_MS : null
}

/**
 * Rule 4 + the running sentence: the one line under an open step, or null when it needs none.
 *
 * Deliberately ONE line for several facts, and ordered by what a reader needs first: that it is
 * still running outranks that its output was cut, because the cut is temporary while it runs.
 */
export function stepNotice(state: StepState, pt: boolean): string | null {
  if (state.phase !== 'ready') return null
  const s = state.step
  if (s.running) return pt ? 'Ainda rodando — a saída aparece conforme ela sai.' : 'Still running — the output appears as it comes.'
  const cut: string[] = []
  if (s.inputTruncated) cut.push(pt ? 'a chamada' : 'the call')
  if (s.outputTruncated) cut.push(pt ? 'a saída' : 'the output')
  if (cut.length === 0) return null
  return pt
    ? `Mostrando parte de ${cut.join(' e ')} — o resto é longo demais para esta coluna.`
    : `Showing part of ${cut.join(' and ')} — the rest is too long for this column.`
}

/**
 * The URL one step is read from. One place, so the panel never assembles it by hand.
 *
 * `agentId` opens a step of a SUBAGENT's conversation: the subagents aside draws its activity with
 * this very feed, and those rows carry refs from the subagent's own transcript, not the parent's.
 */
export function stepUrl(
  sessionId: string, ref: string, lang: 'pt' | 'en', agentId?: string,
): string {
  const agent = agentId ? `&agent=${encodeURIComponent(agentId)}` : ''
  return `/api/fleet/step?id=${encodeURIComponent(sessionId)}&ref=${encodeURIComponent(ref)}${agent}&lang=${lang}`
}
