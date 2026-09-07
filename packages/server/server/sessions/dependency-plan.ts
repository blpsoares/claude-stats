/**
 * dependency-plan.ts — PURE. What to tell somebody whose machine is missing a dependency, and what
 * command would install it.
 *
 * IT PROPOSES; IT NEVER INSTALLS, and nothing here spawns anything. That is the repository's rule
 * applied at its strongest point: *anything agentop writes outside its own directories is an
 * explicit act of the user, and is exactly reversible*. A system package is far outside, so the
 * command is SHOWN and run only on an explicit confirmation.
 *
 * THREE HONEST REFUSALS, each with its own reason code rather than a shrug:
 *
 * - **No recognised package manager.** The dependency is named and NO command is offered. A guessed
 *   one is worse than none: it fails, or worse, it succeeds at something else.
 * - **Windows.** There is no Windows session backend at all — Bun exposes no PTY primitive and a
 *   native module cannot live in the single compiled binary — so a Windows machine is told to use
 *   WSL. Offering it a tmux install would be offering a fix for the wrong problem.
 * - **Needs root.** Most of these need it, and agentop is not going to prompt for a password inside
 *   an Ink alternate screen or a browser tab. `runnable` is false there and the command is offered
 *   to COPY, which is the honest form.
 *
 * The module is language-free, like `LiveUnavailableReason`: it emits reason CODES and the callers'
 * own string tables render them. A pure module that carries sentences is one that has to be edited
 * for every language.
 */

/** The dependencies agentop can be missing. Only tmux today; the shape is what matters. */
export type DependencyId = 'tmux'

/** Package managers this module knows how to write a command for. */
export type PackageManagerId = 'apt' | 'apt-get' | 'dnf' | 'yum' | 'pacman' | 'zypper' | 'apk' | 'brew'

export type DependencyReason =
  /** Nothing is missing. */
  | 'ok'
  /** No Windows session backend exists — use WSL. Not an install problem. */
  | 'windows'
  /** Missing, and no package manager this module recognises is present. */
  | 'no-manager'
  /** Missing, and installable — but the command needs root, so it is offered to copy. */
  | 'needs-root'
  /** Missing, installable, and the command can be run as this user. */
  | 'installable'

export interface DependencyPlan {
  dependency: DependencyId
  reason: DependencyReason
  /** The exact command, argv-style. Absent when there is none to offer. */
  command?: string[]
  /** Which manager the command is written for, so a caller can name it. */
  manager?: PackageManagerId
  /**
   * May agentop RUN this itself?
   *
   * False whenever the command needs root. agentop cannot prompt for a password inside an Ink
   * alternate screen or a browser tab, and a command that hangs on an invisible prompt is worse
   * than one the user was asked to paste.
   */
  runnable: boolean
}

/** The package each manager installs the dependency from. Verified names, not guesses. */
const PACKAGE: Record<DependencyId, Record<PackageManagerId, string>> = {
  tmux: {
    apt: 'tmux', 'apt-get': 'tmux', dnf: 'tmux', yum: 'tmux',
    pacman: 'tmux', zypper: 'tmux', apk: 'tmux', brew: 'tmux',
  },
}

/** How each manager is invoked, and whether it needs root. */
const INVOKE: Record<PackageManagerId, { argv: (pkg: string) => string[]; root: boolean }> = {
  apt: { argv: p => ['apt', 'install', '-y', p], root: true },
  'apt-get': { argv: p => ['apt-get', 'install', '-y', p], root: true },
  dnf: { argv: p => ['dnf', 'install', '-y', p], root: true },
  yum: { argv: p => ['yum', 'install', '-y', p], root: true },
  pacman: { argv: p => ['pacman', '-S', '--noconfirm', p], root: true },
  zypper: { argv: p => ['zypper', 'install', '-y', p], root: true },
  apk: { argv: p => ['apk', 'add', p], root: true },
  // Homebrew refuses to run as root by design, and installs into a prefix the user owns.
  brew: { argv: p => ['brew', 'install', p], root: false },
}

/**
 * Preference order.
 *
 * `apt` before `apt-get` because a machine with both should be told the modern one; `brew` last
 * because a Linux box with Homebrew installed still wants its system manager for a system tool.
 */
const ORDER: readonly PackageManagerId[] = [
  'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'apk', 'brew',
]

export interface DependencyFacts {
  /** `process.platform`. */
  platform: string
  /** True when the dependency's binary is already on PATH. */
  present: boolean
  /** The package managers found on PATH. */
  managers: readonly PackageManagerId[]
  /** True when this process is already root, so a root command can be run without a prompt. */
  isRoot: boolean
}

export function planDependency(id: DependencyId, facts: DependencyFacts): DependencyPlan {
  if (facts.present) return { dependency: id, reason: 'ok', runnable: false }

  // Not an install problem: there is no Windows session backend to install a dependency FOR.
  if (facts.platform === 'win32') return { dependency: id, reason: 'windows', runnable: false }

  const manager = ORDER.find(m => facts.managers.includes(m))
  if (manager === undefined) return { dependency: id, reason: 'no-manager', runnable: false }

  const invoke = INVOKE[manager]
  const command = invoke.argv(PACKAGE[id][manager])
  const needsRoot = invoke.root && !facts.isRoot

  return {
    dependency: id,
    reason: needsRoot ? 'needs-root' : 'installable',
    command: needsRoot ? ['sudo', ...command] : command,
    manager,
    runnable: !needsRoot,
  }
}

/** The command as one line, for showing and for copying. */
export function dependencyCommandLine(plan: DependencyPlan): string | null {
  return plan.command ? plan.command.join(' ') : null
}

/** Every manager this module can write a command for, for the impure caller to probe. */
export function knownManagers(): readonly PackageManagerId[] {
  return ORDER
}
