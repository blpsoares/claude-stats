/**
 * shellBandState.ts — PURE. The band's own state machine, and the one rule it exists to enforce:
 *
 *   **THE BAND NEVER CLAIMS TO BE OPENING WITH NOTHING IN FLIGHT.**
 *
 * This replaces an effect that resolved the shell and tracked its own `busy` flag. That shape had
 * two defects, and the second was on screen: the effect's cleanup set a `cancelled` flag which ALSO
 * suppressed the "no longer busy" write, so an attempt cancelled between its request and its answer
 * left the band spinning on "Abrindo…" over an empty terminal — no shell, no error, nothing in
 * flight, and no dependency left to change, so nothing ever retried. A hung spinner is the exact
 * shape of dishonesty this repo refuses everywhere else: it says work is happening when none is.
 *
 * A reducer makes both impossible by construction. `cancelled` returns to `wanted`, so the next
 * render simply asks again; `resolving` on an already-opening band is a no-op, so a re-render cannot
 * start a second request (which is how one session ended up holding three shells); and a refusal is
 * a DEAD STOP carrying its sentence, retried only by hand — a band that retried a refusal on its own
 * would hammer a server that already said no.
 */

export interface OpenShell {
  id: string
  cwd: string
}

export type ShellPhase =
  /** The band is collapsed. Nothing is captured; a shell may still be RUNNING (see `closeBand`). */
  | 'closed'
  /** The band is open and wants a shell; none is in flight yet. */
  | 'wanted'
  /** A request is in flight. Reachable only from `wanted`, and only one at a time. */
  | 'opening'
  /** A shell is resolved and the screen can be drawn. */
  | 'ready'
  /** The server said no, in a sentence. Only `retry` leaves this state. */
  | 'refused'

export interface ShellBandState {
  phase: ShellPhase
  /** The resolved shell. KEPT while the band is merely collapsed — it is still running. */
  shell: OpenShell | null
  /** The refusal's own sentence, verbatim from the server. Null unless `phase === 'refused'`. */
  message: string | null
  /**
   * How many times a person has ASKED for a shell here. `0` = never.
   *
   * It is the caller's effect dependency, and that is its whole job: an effect that resolves the
   * shell must not change the thing it depends on, or its own cleanup cancels the request it just
   * made and the next render starts another — a loop the first two versions of this band hit. So
   * only `openBand` (with no shell in hand) and `retry` advance it; every dispatch the effect makes
   * itself leaves it exactly where it was.
   */
  attempt: number
}

export const INITIAL_SHELL_BAND: ShellBandState = {
  phase: 'closed', shell: null, message: null, attempt: 0,
}

export type ShellBandAction =
  /** The person expanded the band (or the stored preference had it open). */
  | { type: 'openBand' }
  /** The person collapsed it. The shell keeps running; only the capture stops. */
  | { type: 'closeBand' }
  /** A request is going out now. */
  | { type: 'resolving' }
  | { type: 'resolved'; shell: OpenShell }
  /** The server refused, or the request failed — the sentence is the caller's to compose. */
  | { type: 'refused'; message: string }
  /** The attempt was abandoned (the component re-ran, the session changed). NOT a failure. */
  | { type: 'cancelled' }
  /** The person asked again after a refusal. */
  | { type: 'retry' }
  /** The shell is gone — closed by the person, or `exit` typed into it. */
  | { type: 'ended' }

export function shellBandReducer(state: ShellBandState, action: ShellBandAction): ShellBandState {
  switch (action.type) {
    case 'openBand':
      // A shell we already hold is shown again rather than re-minted: collapsing never ended it.
      if (state.shell) return { ...state, phase: 'ready', message: null }
      return state.phase === 'closed'
        ? { ...state, phase: 'wanted', message: null, attempt: state.attempt + 1 }
        : state

    case 'closeBand':
      return { ...state, phase: 'closed', message: null }

    case 'resolving':
      // ONLY from `wanted`, so a re-render cannot put a second request on the wire.
      return state.phase === 'wanted' ? { ...state, phase: 'opening' } : state

    case 'resolved':
      return { ...state, phase: 'ready', shell: action.shell, message: null }

    case 'refused':
      return { ...state, phase: 'refused', message: action.message }

    case 'cancelled':
      // Back to WANTED, never left in `opening`: the band must not claim work nobody is doing.
      return state.phase === 'opening' ? { ...state, phase: 'wanted' } : state

    case 'retry':
      return { ...state, phase: 'wanted', message: null, attempt: state.attempt + 1 }

    case 'ended':
      return { ...state, phase: 'closed', shell: null, message: null }

    default:
      return state
  }
}

/** Should the caller fire a resolve right now? Exactly when one is wanted and none is in flight. */
export function shellResolveWanted(state: ShellBandState): boolean {
  return state.phase === 'wanted'
}
