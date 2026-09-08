/**
 * fleet-baseline.ts — the behaviour baseline, computed once and cached.
 *
 * NOT `fleet-profile.ts`: that name is taken by the fleet's phase STOPWATCH
 * (`markFleetPhase` / `timeFleetPhase`), which `readFleet` itself imports. Two unrelated things
 * called "profile" in one directory is a name collision waiting to be resolved by whoever reads it
 * second.
 *
 * The arithmetic is pure and lives in `@agentistics/core/session-profile`. This is only the IO
 * boundary: reading the consolidate store is a directory scan, and the fleet poll runs every five
 * seconds, so the answer is held for a while.
 */
import { profileOf, type Baseline, type SessionMeta } from '@agentistics/core'

/** Long, because the answer moves once per session and the scan is the expensive part. */
export const BASELINE_TTL_MS = 5 * 60_000

let cached: { at: number; value: Baseline } | null = null

/** Test seam. Never called in production. */
export function resetBaselineCache(): void {
  cached = null
}

export async function cachedBaseline(
  load: () => Promise<SessionMeta[]>,
  nowMs: number,
): Promise<Baseline> {
  if (cached && nowMs - cached.at < BASELINE_TTL_MS) return cached.value
  try {
    const value = profileOf(await load(), nowMs)
    cached = { at: nowMs, value }
    return value
  } catch {
    // A store that cannot be read costs freshness, never the profile on screen. Same rule the
    // sessions poller applies to a failed poll: keep the previous answer.
    if (cached) return cached.value
    throw new Error('baseline unavailable')
  }
}
