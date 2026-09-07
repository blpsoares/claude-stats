/**
 * mirrorSchedule.ts — how much mirroring work one frame is allowed to do.
 *
 * There is no cap on the number of lenses, so the cost has to be bounded somewhere else. It is
 * bounded here: at most `maxPerFrame` lenses re-clone per frame, oldest first, off-screen lenses
 * never, and the floor between two syncs of the same lens BACKS OFF when a measured cycle blows
 * the budget. Twenty lenses therefore cost ten frames of catching up rather than one frame of
 * twenty clones.
 *
 * PURE — no timers, no DOM. The caller passes `nowMs`.
 */

export interface MirrorLensState {
  id: string
  /** Something under this lens changed since it last synced. */
  dirty: boolean
  /** False when the lens rectangle is off-screen; such a lens is skipped entirely. */
  onScreen: boolean
  lastSyncMs: number
}

export interface MirrorScheduleConfig {
  minIntervalMs: number
  heartbeatMs: number
  maxPerFrame: number
}

/** The floor `nextMinInterval` recovers to. Distinct from MirrorScheduleConfig.minIntervalMs,
 *  which is the CURRENT interval and moves every cycle. */
export const MIRROR_MIN_INTERVAL_MS = 100

export const MIRROR_DEFAULTS: MirrorScheduleConfig = {
  minIntervalMs: MIRROR_MIN_INTERVAL_MS,
  heartbeatMs: 500,
  maxPerFrame: 2,
}

/** Above this, one sync cycle is eating the frame and the interval backs off. */
export const MIRROR_BUDGET_MS = 8
export const MIRROR_MAX_INTERVAL_MS = 1000

export function pickLensesToSync(
  lenses: readonly MirrorLensState[],
  nowMs: number,
  cfg: MirrorScheduleConfig,
): string[] {
  return lenses
    .filter(l => {
      if (!l.onScreen) return false
      // A clean lens still needs the heartbeat: a canvas repaint and a CSS animation move no DOM,
      // so the MutationObserver never marks them dirty.
      const wait = l.dirty ? cfg.minIntervalMs : cfg.heartbeatMs
      return nowMs - l.lastSyncMs >= wait
    })
    .sort((a, b) => a.lastSyncMs - b.lastSyncMs)
    .slice(0, Math.max(0, cfg.maxPerFrame))
    .map(l => l.id)
}

/** Doubling on overrun, three-quarters on recovery: fast to protect, slow to spend again. */
export function nextMinInterval(cycleMs: number, current: number): number {
  if (cycleMs > MIRROR_BUDGET_MS) return Math.min(MIRROR_MAX_INTERVAL_MS, current * 2)
  return Math.max(MIRROR_MIN_INTERVAL_MS, Math.round(current * 0.75))
}
