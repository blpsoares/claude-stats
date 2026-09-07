/**
 * service-path.ts — PURE: the PATH a background service needs in order to reach the harnesses.
 *
 * A user service inherits systemd's own minimal PATH — measured on this machine:
 *
 *     /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin
 *
 * and EVERY coding assistant lives outside it:
 *
 *     claude   ~/.local/bin        agy      ~/.local/bin
 *     codex    ~/.bun/bin          gemini   ~/.bun/bin
 *     copilot  ~/.volta/bin        kimi     ~/.kimi-code/bin
 *
 * So a server started by systemd could not spawn a single one of them. Every reopen answered `ok`
 * with a new id — the registry record was written, the row appeared — and the tmux pane died at
 * once (`status 1`, `claude: No such file or directory`). From the outside: "clicar em reopen n ta
 * funcionando… simplesmente n funciona, nao reabre". The same server run from a shell works
 * perfectly, which is why this survived a day of use: yesterday it was a dev process with the
 * user's PATH, today it is a service.
 *
 * THE INSTALLING SHELL IS THE ONLY THING THAT KNOWS. `agentop autostart` is typed in a terminal
 * whose PATH already reaches every harness that terminal can run — that is the whole definition of
 * "installed for this user". So the unit records THAT PATH rather than a list of directories this
 * file guesses at: guessing means naming `~/.bun/bin` and missing whatever the next tool uses, and
 * being wrong silently, which is the failure this replaces.
 *
 * Two rules:
 *
 * - RELATIVE AND EMPTY ENTRIES ARE DROPPED. A service has no meaningful working directory, so `.`
 *   or `` in a PATH is either useless or a way for whatever directory the service happens to start
 *   in to supply a binary. `$PATH` entries like that are common in interactive shells.
 * - IT IS ADDITIVE, never a replacement: the system directories stay, appended after the user's, so
 *   a unit still finds `sh`, `git` and `docker` if the caller's PATH somehow lacks them.
 */

/** The directories a systemd user service gets when nothing sets PATH. Kept so it is never lost. */
export const SYSTEM_PATH = [
  '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin',
]

/**
 * The `Environment=PATH=` value for a unit, from the PATH of the shell installing it.
 *
 * Returns `null` when there is nothing to add — the caller then writes NO `Environment=` line at
 * all, rather than one restating the default. A unit that says nothing is easier to read than one
 * that says the obvious, and this is a file people open when something is wrong.
 */
export function servicePath(callerPath: string | undefined): string | null {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (dir: string) => {
    // Absolute only. A relative entry in a service is either dead or a way for the starting
    // directory to decide which binary runs.
    if (!dir.startsWith('/')) return
    const clean = dir.length > 1 && dir.endsWith('/') ? dir.slice(0, -1) : dir
    if (seen.has(clean)) return
    seen.add(clean)
    out.push(clean)
  }
  for (const dir of (callerPath ?? '').split(':')) add(dir)
  const userDirs = out.length
  for (const dir of SYSTEM_PATH) add(dir)
  // Nothing the service would not already have had.
  if (userDirs === 0) return null
  const onlySystem = out.every(d => SYSTEM_PATH.includes(d))
  return onlySystem ? null : out.join(':')
}
