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
/**
 * The scan currently running, shared by every caller that arrives while it is in flight.
 *
 * Without it, two callers landing on the same expired TTL each run a full consolidate-store
 * directory scan — and the caller is `/api/fleet`, which the dashboard, the cockpit and the VS Code
 * extension all poll every five seconds. A TTL bounds how OFTEN the scan runs; only this bounds how
 * MANY run at once.
 */
let inFlight: Promise<Baseline> | null = null

/** Test seam. Never called in production. */
export function resetBaselineCache(): void {
  cached = null
  inFlight = null
}

export async function cachedBaseline(
  load: () => Promise<SessionMeta[]>,
  nowMs: number,
): Promise<Baseline> {
  if (cached && nowMs - cached.at < BASELINE_TTL_MS) return cached.value
  if (inFlight) return inFlight
  const run = (async () => {
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
  })()
  inFlight = run
  // Released AFTER the assignment above, never in a `finally` inside the body: a `load()` that
  // throws synchronously settles the promise before `inFlight = run` runs, and an in-body clear
  // would then be overwritten by a settled promise that is served forever.
  void run.then(
    () => { if (inFlight === run) inFlight = null },
    () => { if (inFlight === run) inFlight = null },
  )
  return run
}
