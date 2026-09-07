/**
 * harness-available.ts — which assistants this machine can actually START.
 *
 * `SPAWN_SPECS` answers a different question: which harnesses agentop knows how to spawn AT ALL. A
 * harness with no spec is absent from every offer, and that part is already right. What was missing
 * is the second half — a spec says how to run `codex`, not that `codex` exists here — so the session
 * wizard listed all six on a machine with one installed, and picking one of the other five started
 * a tmux session that died on `command not found` behind a screen nobody was looking at.
 *
 * The rule was already written once, in `cli-hooks.ts`, for the skill it generates: a skill that
 * offers `codex` where no codex exists teaches a command that fails. It lives here now so the two
 * cannot drift — the same reason `task-reopen.ts` exists.
 *
 * The FALLBACK is the part to keep. When nothing resolves — a PATH-less environment, a service
 * started from a unit file with a minimal `Environment=` — the honest answer is "this machine
 * cannot tell", and a wizard offering an empty list is indistinguishable from a broken one. So an
 * empty result yields every startable harness rather than nothing, which is the same
 * N/A-versus-a-confident-0 rule the dashboard applies to a metric no harness can produce.
 */

import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import { SPAWN_SPECS } from './spawn-spec'

/** Every harness agentop knows how to spawn, spec-derived and never a second hand-written list. */
export function startableHarnessIds(): HarnessId[] {
  return HARNESS_ORDER.filter(h => SPAWN_SPECS[h] !== null)
}

/**
 * Memoized: the wizard asks on every mount and the skill on every install, while a CLI appearing on
 * PATH mid-process is not a thing that happens. `Bun.which` is a filesystem walk per harness.
 */
let cached: HarnessId[] | null = null

/**
 * The startable harnesses whose CLI is on PATH — or, when none of them are, all of them.
 *
 * `narrowed` says which of the two answers this is, so a caller that wants to explain itself can.
 */
export function availableHarnesses(): { ids: HarnessId[]; narrowed: boolean } {
  if (cached === null) {
    const startable = startableHarnessIds()
    const installed = startable.filter(h => !!Bun.which(SPAWN_SPECS[h]!.bin))
    cached = installed.length > 0 ? installed : startable
  }
  return { ids: cached, narrowed: cached.length !== startableHarnessIds().length }
}

/** Test seam — the memo is per process, and a test that changes PATH must be able to clear it. */
export function resetHarnessAvailability(): void {
  cached = null
}
