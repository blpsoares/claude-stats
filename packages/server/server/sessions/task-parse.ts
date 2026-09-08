/**
 * task-parse.ts — PURE. `agentop task …` argv -> a typed command.
 *
 * A TOP-LEVEL command rather than a `session` subcommand, because a task is not a session: it
 * outlives every row filed under it, and `agentop session task <ref> "<name>"` already means
 * something else (it files ONE row). The two verbs that act on a task from a session row (`open`,
 * `finish`) deliberately take the ROW's own task rather than a name, so a caller cannot reach
 * someone else's work; that stays true and this command is the other door.
 *
 * Pure, so the whole grammar is tested without touching the task book.
 */

export type TaskCommand =
  /** Every task, with its rollup. */
  | { kind: 'ls'; json?: boolean }
  /** One task: its attempts side by side. */
  | { kind: 'show'; ref: string; json?: boolean }
  /**
   * Mark the work done, or given up on.
   *
   * `deliver` is what makes "rounds to delivery" a closed number; `abandon` is first-class beside
   * it because an attempt that was given up on is the most informative row in a comparison, and
   * treating it as merely still-open inflates every average.
   */
  | { kind: 'deliver'; ref: string; json?: boolean }
  | { kind: 'abandon'; ref: string; json?: boolean }
  /**
   * Opt a delivery in or out of travelling to this machine's centrals.
   *
   * Two verbs rather than `share <ref> --on|--off`: the thing being decided is which of two states
   * the delivery is in, and a flag that can be forgotten defaults it — which on this particular
   * switch means publishing text nobody offered.
   */
  | { kind: 'share'; ref: string; on: boolean; json?: boolean }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

// The BETA is in the usage line because that is what a person meets when they get the command
// wrong — the one moment they are certainly reading it.
const USAGE = 'Usage: agentop task [ls | show <id|name> | deliver <id|name> | abandon <id|name>'
  + ' | share <id|name> | unshare <id|name>]'
  + '\n(beta — the delivery board is new and still changing)'

export function parseTaskArgs(argv: string[]): TaskCommand {
  const json = argv.includes('--json')
  const rest = argv.filter(a => a !== '--json')
  const head = rest[0]

  // Bare `agentop task` lists, the way bare `agentop session ls` does. A command whose commonest
  // question needs a subcommand to ask is one people look up every time.
  if (!head || head === 'ls' || head === 'list') return { kind: 'ls', ...(json ? { json: true } : {}) }
  if (head === 'help' || head === '--help' || head === '-h') return { kind: 'help' }

  if (head === 'share' || head === 'unshare') {
    const ref = rest.slice(1).join(' ').trim()
    if (!ref) return { kind: 'error', message: `Usage: agentop task ${head} <id|name>` }
    return { kind: 'share', ref, on: head === 'share', ...(json ? { json: true } : {}) }
  }

  if (head === 'show' || head === 'deliver' || head === 'abandon') {
    // The rest is JOINED rather than taken as one token: a task is named by a person and its name
    // has spaces in it far more often than not, so requiring quotes would make the commonest
    // invocation the one that fails. Same reading `agentop session open "<task>"` already uses.
    const ref = rest.slice(1).join(' ').trim()
    if (!ref) return { kind: 'error', message: `Usage: agentop task ${head} <id|name>` }
    return { kind: head, ref, ...(json ? { json: true } : {}) }
  }

  return { kind: 'error', message: `Unknown subcommand "${head}". ${USAGE}` }
}
