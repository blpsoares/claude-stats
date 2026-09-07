/**
 * fleetStale.ts — PURE: is the fleet on screen still the truth, and how do we say it is not?
 *
 * `pollOnce` keeps the last known answer when a poll fails, and the instinct is right: reporting an
 * empty fleet because one request 502'd would say "nothing is running" about a machine with nine
 * live sessions. But the cockpit's own poller keeps the previous list **plus a reason**
 * (`sessions-host.ts`), and the web kept only the list — so with the server down the page went on
 * showing a fleet from minutes ago, rows and all, with nothing on screen saying so. Observed
 * directly: the API answered 502 for a dozen consecutive polls while the list sat there looking
 * live, and the only clue was a header count that no longer matched the rows beneath it.
 *
 * A stale list is worse than an empty one, because an empty one is obviously wrong. This module is
 * the sentence that closes that gap.
 *
 * ONE failure is not staleness. A single missed poll during a rebuild, a laptop waking up, or a
 * server restart is the normal noise of a 5s poll, and a warning that fires on it is a warning
 * people stop reading — the same argument `linkState` makes for not colouring `stale` red on the
 * cockpit's central pill.
 */

/** Consecutive failures before the list is called into question. Two misses is ~10s of silence. */
export const STALE_AFTER_FAILURES = 2

export interface FleetStaleState {
  /** How many polls in a row have failed. Reset to 0 by any success. */
  failures: number
  /** ms epoch of the last poll that answered, or null if none ever has. */
  lastOkMs: number | null
}

/**
 * Should the page say the list may be out of date?
 *
 * `false` while nothing has ever succeeded: that is the LOADING case, and it has its own words
 * already. Saying "this list may be out of date" about a list that was never fetched would name the
 * wrong problem.
 */
export function fleetIsStale(s: FleetStaleState): boolean {
  return s.lastOkMs !== null && s.failures >= STALE_AFTER_FAILURES
}

/**
 * How long ago, in the coarsest unit that still says something. The age is what makes either
 * sentence below actionable — "a few seconds" and "eleven minutes" call for different reactions,
 * and a bare "may be out of date" leaves the reader to guess which one they are in.
 *
 * Never negative: a clock that jumped backwards is not a list from the future.
 */
function ageOf(since: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - since) / 1000))
  return secs < 90 ? `${secs}s` : `${Math.floor(secs / 60)} min`
}

/** The sentence for a list whose machine has STOPPED ANSWERING. */
export function fleetStaleNotice(s: FleetStaleState, now: number, lang: 'en' | 'pt'): string | null {
  if (!fleetIsStale(s)) return null
  const age = ageOf(s.lastOkMs ?? now, now)
  return lang === 'pt'
    ? `Sem resposta da máquina há ${age}. Esta lista é a última que chegou, não o que está rodando agora.`
    : `No answer from this machine for ${age}. This list is the last one that arrived, not what is running now.`
}

/**
 * The sentence for a list painted from the STORED SNAPSHOT, before the first live poll lands.
 *
 * It is a SEPARATE sentence, and that is the whole point of this function existing. A seeded list
 * borrowed `fleetStaleNotice` — same shape of problem, real rows not yet confirmed — and the
 * borrowed words say "no answer from this machine", which on a normal reopen is simply false: the
 * machine has not been asked yet. Announcing a failure that did not happen, at the exact moment the
 * page opens, is the alarming direction of the confident-wrong defect, and a warning that cries
 * wolf on every visit is one people stop reading.
 *
 * `null` when there is no seed (`at <= 0`): a fresh visit with an empty list is LOADING, which has
 * its own words, and `fleetIsStale` refuses the same case for the same reason.
 */
export function fleetSeedNotice(at: number, now: number, lang: 'en' | 'pt'): string | null {
  if (!Number.isFinite(at) || at <= 0) return null
  const age = ageOf(at, now)
  return lang === 'pt'
    ? `Última lista conhecida, de ${age} atrás — esperando esta máquina confirmar.`
    : `Last known list, from ${age} ago — waiting for this machine to confirm it.`
}
