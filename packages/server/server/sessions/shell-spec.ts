/**
 * shell-spec.ts — PURE. What opening a utility shell decides, and every way it refuses.
 *
 * The shell is a PTY in the session's own directory, opened for the person, and it is the most
 * powerful thing this server can be asked for. So every decision that can be silently wrong lives
 * here and is tested without a tmux server: which binary, which directory, and which of the four
 * refusals applies.
 *
 * A REFUSAL IS A CODE, NEVER A SENTENCE. The route renders it, so this module stays language-free —
 * the same split `central-runtime.ts` makes with its reason codes and `LiveUnavailableReason` makes
 * with its own.
 */

/**
 * How many utility shells one machine may hold at once.
 *
 * A CEILING AND NOT A TIMER, and the number lives here alone. A TTL would kill the `bun test` that
 * finished at minute 61 and whose output the person wanted, at an hour nobody was watching, and it
 * needs a timer running for the life of the process. A ceiling needs nothing running: it is one
 * check, on open, and it only ever closes something at the instant somebody is asking for a new
 * one — so the trade is visible at the moment it is made.
 */
export const SHELL_CAP = 8

/** Why a shell could not be opened. Rendered into a sentence by the caller, never here. */
export type ShellRefusal =
  /** tmux is not on this host — no PTY, so no shell. Windows without WSL is this case. */
  | 'no-tmux'
  /** The row records no working directory, and there is no second-best place to open one. */
  | 'no-cwd'
  /** It records one, and that directory is gone — the removed-worktree case. */
  | 'cwd-missing'
  /** `SHELL_CAP` shells are already open. */
  | 'at-cap'

/** Everything the decision needs. Every field is a FACT the caller measured; none is read here. */
export interface ShellOpenFacts {
  /** The fleet row's `cwd`, or undefined when the registry holds none. */
  cwd: string | undefined
  /** Does that directory exist right now? Meaningless when `cwd` is undefined. */
  cwdExists: boolean
  tmuxAvailable: boolean
  /** How many shells are open on this machine already. */
  openCount: number
  /** `process.env.SHELL`, which may be absent or empty. */
  shell: string | undefined
}

export type ShellOpenPlan =
  | { ok: true; argv: string[]; cwd: string }
  | { ok: false; reason: ShellRefusal }

/** The shell to run when the environment names none. Present on every host that has tmux. */
const FALLBACK_SHELL = '/bin/bash'

/**
 * The order of the refusals is the design, not an accident.
 *
 * The IMPOSSIBLE ones come before the merely FULL one: at the ceiling the caller asks the person to
 * close a shell to make room, and asking somebody to destroy work to make room for an open that
 * could never have succeeded is worse than saying no.
 *
 * The shell is run BARE — no `-l`. tmux gives the pane a tty, so it is already an interactive
 * shell; adding a login flag would make it read a different set of rc files from the panes
 * `agentop session` opens, and two kinds of shell on one machine is a difference nobody asked for.
 */
export function planShellOpen(f: ShellOpenFacts): ShellOpenPlan {
  if (!f.tmuxAvailable) return { ok: false, reason: 'no-tmux' }
  if (!f.cwd) return { ok: false, reason: 'no-cwd' }
  if (!f.cwdExists) return { ok: false, reason: 'cwd-missing' }
  if (f.openCount >= SHELL_CAP) return { ok: false, reason: 'at-cap' }
  return { ok: true, argv: [f.shell || FALLBACK_SHELL], cwd: f.cwd }
}
