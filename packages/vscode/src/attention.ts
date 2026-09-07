/**
 * attention.ts — PURE. Which sessions have just started needing a person.
 *
 * The rule is the cockpit's, restated for a different surface: **the bell rings on the TRANSITION,
 * never on the level.** A session that has been blocked on a permission prompt for an hour is not
 * news; the moment it became blocked is. Announcing the level instead would fire a toast every
 * five seconds for as long as the user did not answer, and a notification stream nobody can stop is
 * one people turn off — taking the one that mattered with it.
 *
 * Two consequences, both of which cost more than they look:
 *
 * - **The FIRST snapshot announces nothing.** There is no previous state to have transitioned from,
 *   and a machine with nine blocked sessions would greet the user with nine toasts the moment the
 *   window opened. The first poll is a baseline; `null` is what says so, and it is deliberately not
 *   an empty map — "we have not looked yet" and "we looked and the fleet was empty" are different
 *   facts, and treating the second as the first would re-announce the whole fleet after a poll that
 *   failed.
 * - **Only `waiting-approval` is announced.** Plain `waiting` also means the assistant is waiting on
 *   you, and it is counted in the badge for exactly that reason — but it is where a session sits at
 *   the end of every single turn, so a toast on it is a toast per turn. `waiting-approval` is the
 *   one state where the session is BLOCKED and cannot proceed without an answer.
 */

import type { FleetRow, SessionState } from './protocol'

/** States that raise a notification when a row enters one. See the header for why it is just one. */
const ANNOUNCE: ReadonlySet<SessionState> = new Set<SessionState>(['waiting-approval'])

/** States that count toward the badge — everything that is, in fact, waiting on a person. */
const ATTENTION: ReadonlySet<SessionState> = new Set<SessionState>(['waiting', 'waiting-approval'])

/** The previous states, by session id. `null` means nothing has been read yet. */
export type AttentionMemory = ReadonlyMap<string, SessionState> | null

export interface AttentionUpdate {
  /** The rows that JUST entered a blocked state. Empty on the first read, always. */
  announce: FleetRow[]
  /** How many rows are waiting on a person right now — a level, and only ever shown as one. */
  count: number
  /** The memory to pass to the next call. */
  memory: ReadonlyMap<string, SessionState>
}

export function readAttention(previous: AttentionMemory, rows: readonly FleetRow[]): AttentionUpdate {
  const memory = new Map<string, SessionState>()
  const announce: FleetRow[] = []

  for (const row of rows) {
    memory.set(row.id, row.state)
    if (!previous) continue
    if (!ANNOUNCE.has(row.state)) continue
    // A row that was ALREADY in this state has not just entered it. A row this poll has never seen
    // before HAS — a session started from another window, or by a hook, arriving already blocked.
    if (previous.get(row.id) === row.state) continue
    announce.push(row)
  }

  return {
    announce,
    count: rows.filter(r => ATTENTION.has(r.state)).length,
    memory,
  }
}
