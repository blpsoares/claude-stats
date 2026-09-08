/**
 * dependency-probe.ts — the IMPURE half of `dependency-plan.ts`: reading what is actually on this
 * machine so the pure module can decide what to say about it.
 *
 * Split the same way `backend-tmux.ts` sits beside the pure `tmux-cli.ts`: every decision that could
 * get a package manager wrong lives in `dependency-plan.ts`, and this file only does the I/O that
 * module cannot do for itself — `Bun.which` for presence, `process.platform`/`process.getuid` for
 * the rest.
 */

import { knownManagers, planDependency, type DependencyFacts, type DependencyId, type DependencyPlan } from './dependency-plan'

/** The binary each dependency is found under. Only tmux today — see `DependencyId`. */
const BINARY: Record<DependencyId, string> = { tmux: 'tmux' }

async function facts(id: DependencyId): Promise<DependencyFacts> {
  const managers = knownManagers()
  const [present, foundManagers] = await Promise.all([
    Promise.resolve(Bun.which(BINARY[id]) !== null),
    Promise.all(managers.map(async m => (Bun.which(m) !== null ? m : null))),
  ])
  return {
    platform: process.platform,
    present,
    managers: foundManagers.filter((m): m is typeof managers[number] => m !== null),
    // Root on Unix only — `process.getuid` does not exist on Windows, and a dependency there is
    // 'windows' before `isRoot` is ever consulted.
    isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
  }
}

/** What to tell somebody about `id` on THIS machine, right now. */
export async function probeDependency(id: DependencyId): Promise<DependencyPlan> {
  return planDependency(id, await facts(id))
}

/**
 * Run the plan's own command, inheriting this process's stdio.
 *
 * ONLY ever called after an explicit confirmation the caller obtained itself — this module offers
 * no consent of its own, matching `dependency-plan.ts`'s rule at its strongest point. Stdio is
 * inherited (not captured) so a `sudo` prompt reaches the real terminal, which is why this is meant
 * for a plain CLI command with a real tty — never from inside Ink's alternate screen or a browser
 * tab, where a hidden password prompt would just hang.
 */
export async function runDependencyInstall(plan: DependencyPlan): Promise<boolean> {
  const [cmd, ...args] = plan.command ?? []
  if (!cmd) return false
  const proc = Bun.spawn([cmd, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  return (await proc.exited) === 0
}
