/**
 * sessionRoute.ts — PURE: the URL of one session.
 *
 * A row's id is not always a token. `external:<harness>:<cwd>:<startedMs>` carries a DIRECTORY, and
 * a directory has slashes:
 *
 *     external:antigravity:/home/mithrandir/agentistics:1788625485620
 *
 * Interpolated raw into `/sessions/${id}`, those slashes become PATH SEPARATORS. The route is
 * `/sessions/:id`, which matches one segment, so nothing matched and the page rendered blank —
 * "tem uma external que se eu clicar nela ela crasha a aplicacao". Navigating to the same row with
 * the id encoded works, which is why it was invisible to anything that built the URL by hand.
 *
 * So the encoding happens HERE, in one function every caller goes through, rather than at five
 * `navigate()` sites where the sixth will forget. `useParams` decodes on the way back in, so
 * nothing downstream changes.
 *
 * The id is NOT reshaped to avoid the problem: `externalId()` composes it from the facts that
 * identify an external process, and a row's identity is not the place to make a routing concern
 * disappear.
 */

/** The path for one session row. `id` is used verbatim; only the URL encoding is added. */
export function sessionPath(id: string): string {
  return `/sessions/${encodeURIComponent(id)}`
}

// ---------------------------------------------------------------------------
// WHERE A REOPEN LANDS, and how long the page may say a session is on its way.
//
// A reopen mints a NEW managed row and retires the one it was asked about, so the id in the URL
// stops naming anything the moment it succeeds. Two separate things went wrong there, and only
// together do they produce what was reported — "reabro uma sessão e ele me joga pra tela de
// sessions":
//
//   1. THE NEW ID WAS THROWN AWAY on two of the four surfaces that can reopen. The composer's own
//      Reopen button (`SessionChat`) and the aside's row menu both called the action and kept only
//      its message, on the stated belief that "the page follows it there". Nothing followed it: the
//      URL still held the retired id, `collapseSupersededSessions` dropped that row on the next
//      poll, and the page fell through to its "nothing selected" branch — the fleet overview —
//      permanently.
//
//   2. THE "IT IS ON ITS WAY" GUARD WAS SCOPED TO THE MOUNT. `creatingSince` was a `useState`
//      initialised once and never reset, so the budget it measured against started when the page
//      was OPENED. Creating a session from the overview remounts the page (a different `<Route>`),
//      which is why it always looked right; reopening from inside a session is `/sessions/A` ->
//      `/sessions/B`, the SAME route, no remount — so on any page open longer than the budget the
//      guard was already spent and the overview showed anyway, for the whole poll interval.
//
// Both halves live here so the four call sites cannot each answer differently — the same reason
// `sessionPath` exists rather than five hand-built URLs.

/**
 * How long the page may claim a session is coming before it says the id names nothing here.
 *
 * BOUNDED on purpose: a loader with no end cannot be told from a session that never started.
 */
// `NewSessionModal.waitForRow` already gives the SERVER 6s to hold a new row; this covers the poll
// that brings it to THIS browser afterwards, and covers a reopen the same way.
export const ARRIVAL_WAIT_MS = 20_000

/** A session the page has been told to expect, and when it was told. */
export interface SessionArrival {
  id: string
  since: number
}

/**
 * The arrival record for the id now in the URL — PURE, and keyed on the ID rather than the mount.
 *
 * Returns `prev` unchanged while the same id is still arriving, so the budget is not restarted by
 * an unrelated re-render; a DIFFERENT id announced is a new arrival and gets a fresh stamp. An id
 * nobody announced clears the record: navigating to a session that already exists is not a wait.
 */
export function arrivalFor(
  prev: SessionArrival | null,
  sessionId: string | undefined,
  announced: boolean,
  now: number,
): SessionArrival | null {
  if (sessionId === undefined || !announced) return null
  if (prev !== null && prev.id === sessionId) return prev
  return { id: sessionId, since: now }
}

/** Whether the page is still entitled to say that session is on its way. PURE. */
export function stillArriving(
  arrival: SessionArrival | null,
  sessionId: string | undefined,
  now: number,
): boolean {
  if (arrival === null || sessionId === undefined) return false
  return arrival.id === sessionId && now - arrival.since < ARRIVAL_WAIT_MS
}

/** What a caller hands `navigate()` to land on a session it has just been given the id of. */
export interface SessionRoute {
  path: string
  options: { state: { creating: { harness?: string; label?: string } } }
}

/**
 * Where a REOPEN lands.
 *
 * The row it came FROM is what names the wait — the reopened conversation keeps its harness and
 * its title, and a wait that names neither is a bare spinner. Both are optional because two of the
 * callers have the id and nothing else; the state is still carried, because its presence is what
 * tells the page "this is coming" rather than "this id names nothing".
 */
export function reopenedSessionRoute(
  id: string,
  from?: { harness?: string; title?: string },
): SessionRoute {
  return {
    path: sessionPath(id),
    options: {
      state: {
        creating: {
          ...(from?.harness ? { harness: from.harness } : {}),
          ...(from?.title ? { label: from.title } : {}),
        },
      },
    },
  }
}
