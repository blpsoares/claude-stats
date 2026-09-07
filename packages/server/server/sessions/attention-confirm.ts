/**
 * attention-confirm.ts — PURE. Turns the fleet's INSTANTANEOUS per-poll reading into a CONFIRMED
 * one, so the "needs you" counter stops lying.
 *
 * ## The defect this exists for
 *
 * `attention.ts` answers "what is this session doing" from a SINGLE frame, and it is right to: for
 * the several harnesses whose only working signal is movement, "the screen moved, so it is working"
 * is the only rule there is. But a single frame is a noisy sample. A session that has just finished
 * a turn, or one whose pane a plugin repainted for a moment, reads `working` on one poll and
 * `waiting` on the next with nothing about the session having changed — and a coordinator operating
 * a fleet reported being sent to a session as "waiting on you" that had already gone back to work.
 * The written rule in that workspace became "do not trust the activity field; read the pane with
 * `tmux capture-pane`" — which is exactly the manual work the monitor exists to remove.
 *
 * ## The asymmetry that shapes the rule
 *
 * Getting these two states wrong does NOT cost the same. Saying "working" about a session that has
 * stopped merely delays a person by one poll. Saying "needs you" about a session that is moving
 * WASTES the person — the most expensive resource here — and, worse, corrodes trust in the
 * indicator; once it has cried wolf, it stops being read, and that cost is permanent. So the two
 * directions are confirmed differently:
 *
 *  - **Returning to work (`working`) and exiting (`exited`) are believed at once.** A screen that
 *    moved is unambiguous proof, and clearing attention eagerly is the cheap error — a person is
 *    never sent to a session that has already resumed. This also makes the counter DROP on the very
 *    next sample after work resumes, which is the behaviour a person watching the fleet expects.
 *  - **`waiting` and `waiting-approval` — the states that summon a person — are believed only once
 *    the same reading has been seen on TWO CONSECUTIVE polls.** A one-frame quiet or a cosmetic
 *    repaint never reaches the counter; genuine attention holds the screen for longer than one
 *    interval and is confirmed on the following poll (one interval of latency, the cheap direction).
 *
 * ## Relationship to `event-plan.ts`
 *
 * The event channel confirms EVERY transition on two polls (`planEvents`), because a duplicate
 * notification is the failure IT is judged on. This module confirms only the needs-you direction and
 * clears eagerly, because a stale "needs you" on a live dashboard is the failure THIS surface is
 * judged on. The two therefore AGREE on the reported harm — neither raises `waiting` from a single
 * frame — and diverge only on how fast they clear it, by design: the fleet display drops attention a
 * poll sooner than the notification stream, which is the right way round for each.
 *
 * Pure, and total: it reads a memory + one poll's raw readings and returns the confirmed readings
 * plus the memory for the next poll. The poller (`sessions-host.ts`) carries the memory and feeds
 * the confirmed map to `buildSessionViews`, so the count, the sort, the bell and the TUI all read
 * the confirmed state without knowing this step happened.
 */

import type { SessionActivity } from './types'

/**
 * What the confirmer carries between polls.
 *
 * `lastRaw` is the previous poll's RAW reading and exists only to decide whether the current reading
 * has now been seen twice. `confirmed` is the state the fleet currently BELIEVES a session is in,
 * and is what a new needs-you reading is held against.
 */
export interface ConfirmMemory {
  lastRaw: ReadonlyMap<string, SessionActivity>
  confirmed: ReadonlyMap<string, SessionActivity>
}

export const EMPTY_CONFIRM_MEMORY: ConfirmMemory = { lastRaw: new Map(), confirmed: new Map() }

/** The states that summon a PERSON — the expensive-to-get-wrong ones, confirmed before believed. */
function needsPerson(a: SessionActivity): boolean {
  return a === 'waiting' || a === 'waiting-approval'
}

export interface ConfirmResult {
  /** The confirmed reading per session — what every downstream surface should show. */
  activities: Map<string, SessionActivity>
  /** What to carry into the next poll. */
  memory: ConfirmMemory
}

/**
 * Confirm one poll's raw readings against the memory — PURE.
 *
 * Only sessions present in `raw` are carried forward, so the memory cannot grow with every session
 * the machine has ever hosted: a session that leaves the fleet is simply forgotten and, if it comes
 * back, is a first sighting again.
 */
export function confirmActivities(
  memory: ConfirmMemory,
  raw: ReadonlyMap<string, SessionActivity>,
  /**
   * The sessions whose reading is CORROBORATED — believe them at once.
   *
   * The asymmetry below (work resumed is believed immediately, needing a person is confirmed) was
   * right about the direction and wrong about the evidence. `attentionOf` reads `working` from
   * whether the pane MOVED, and a pane moves for reasons that are not a turn: a repaint, an
   * advisory line, a plugin notice. Each of those flipped a row to `working` for one poll and back,
   * so the row changed colour and wording continuously and a notification went out each time —
   * reported as exactly that.
   *
   * So `working` keeps its immediacy only where something CORROBORATES it: the harness's own
   * working marker on screen (`esc to interrupt`). A harness that prints no marker has nothing
   * better than movement and must keep believing it at once, or codex would never read as working
   * at all — which is why this is a set the CALLER fills, not a rule this module can decide.
   *
   * Absent (the parameter omitted) means "everything is corroborated", so existing callers and the
   * tests written against them keep their exact behaviour.
   */
  corroborated?: ReadonlySet<string>,
): ConfirmResult {
  const lastRaw = new Map<string, SessionActivity>()
  const confirmed = new Map<string, SessionActivity>()
  const activities = new Map<string, SessionActivity>()

  for (const [id, r] of raw) {
    lastRaw.set(id, r)
    const prevConfirmed = memory.confirmed.get(id)
    const prevRaw = memory.lastRaw.get(id)

    let next: SessionActivity
    if (!needsPerson(r) && (corroborated === undefined || corroborated.has(id))) {
      // Work resumed, or the session exited, AND something corroborates it. Believed at once — see
      // the header's asymmetry and the `corroborated` parameter.
      next = r
    } else if (prevConfirmed === r || prevRaw === r) {
      // Already the believed state, or seen on two consecutive polls: confirmed.
      next = r
    } else if (prevConfirmed !== undefined) {
      // A single new needs-you reading is not yet a fact. Hold the last believed state (typically
      // `working`) rather than assert attention the fleet may not actually need.
      next = prevConfirmed
    } else {
      // First sighting: nothing prior to contradict. A session first seen at its prompt genuinely IS
      // waiting, and there is no `working` being overturned — so the reading stands.
      next = r
    }

    confirmed.set(id, next)
    activities.set(id, next)
  }

  return { activities, memory: { lastRaw, confirmed } }
}
