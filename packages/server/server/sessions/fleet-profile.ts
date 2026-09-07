/**
 * fleet-profile.ts — an opt-in stopwatch for `/api/fleet`'s cold path.
 *
 * Warm, `/api/fleet` answers in milliseconds; cold (the process's first call), it has been measured
 * at ~29s on a real machine with nine live sessions — after `chat-tail.ts`'s transcript-window fix
 * already cut it from 36s, and with `readRegistry` (10ms), `scanProcesses` (270ms),
 * `loadConversations` (415ms), `loadHarnessSessions` (97ms) and `backend.list` (77ms) individually
 * measured and ruled out. Those five run inside `Promise.all` in `sessions-host.ts`'s poll, so their
 * WALL cost is the slowest of them, not their sum — nowhere near 29s either way.
 *
 * The remaining ~28s has NOT been reproduced on every machine (this sandbox answers cold in
 * ~1.5s), so it is not yet known which phase below actually carries it there — module load
 * (`import('../cli-start')` reaches `@agentistics/tui/control`, which pulls in Ink and React),
 * `repo-facts.ts` spawning `git` once per distinct session directory on a cold memo, or something
 * else entirely. Rather than guess-fix a phase that turns out innocent, this prints a breakdown of
 * exactly where the wall-clock time went on the machine that is actually slow, gated behind an env
 * var so it costs a `?` and one comparison on every other machine.
 *
 * `AGENTISTICS_PROFILE_FLEET=1` turns it on; unset, `mark` and `time` are no-ops.
 */

const ENABLED = process.env.AGENTISTICS_PROFILE_FLEET === '1'

/** Wall-clock time a synchronous span took, printed immediately. */
export function markFleetPhase(label: string, startedAtMs: number): void {
  if (!ENABLED) return
  console.error(`[fleet-profile] ${label}: ${(performance.now() - startedAtMs).toFixed(0)}ms`)
}

/** The same, for an async span already awaited by the caller — kept separate so a call site never
 * has to branch on whether ENABLED before deciding whether to even start the clock. */
export async function timeFleetPhase<T>(label: string, run: () => Promise<T>): Promise<T> {
  if (!ENABLED) return run()
  const start = performance.now()
  try {
    return await run()
  } finally {
    markFleetPhase(label, start)
  }
}

export function fleetProfileEnabled(): boolean {
  return ENABLED
}
