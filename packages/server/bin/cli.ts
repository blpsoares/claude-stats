#!/usr/bin/env bun
/**
 * agentop — AI agent usage dashboard
 *
 * Single entry point for the compiled binary.
 */

/**
 * `agentop tui` is an ALIAS for `agentop start`, resolved here so there is one code path.
 *
 * There used to be a second Ink application behind it — its own shell, its own keyboard, its own
 * help panel — drawing the same five screens the control center's `dashboard` tab draws. Every one
 * of those screens is shared code now (`packages/tui/src/dashboard`), so what the standalone app
 * still owned was a DUPLICATE of the chrome around them: a second set of keys for the same
 * material, and a second place for the two to disagree.
 *
 * It is renamed into `start` rather than given its own branch that opens the control center,
 * because a branch is a copy that starts identical and drifts — a flag added to `start` would have
 * to be remembered here. The dashboard is one keypress away inside the app.
 */
const command = process.argv[2] === 'tui' ? 'start' : process.argv[2]
const args = process.argv.slice(3)

/**
 * Load a central env file (KEY=VALUE) into process.env for keys not already set, so a NATIVE
 * central (no Docker) picks up MONGO_URL + the AGENTISTICS_TEAM_* secrets the same way the Docker
 * central reads central.env. Search order: $AGENTISTICS_CENTRAL_ENV, ./central.env,
 * ~/.agentistics/central.env. Values are trimmed (a stray space in `MONGO_URL= mongodb+srv…` would
 * otherwise break the driver). Never throws.
 */
function loadCentralEnv(): string | null {
  try {
    const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    const { homedir } = require('node:os') as typeof import('node:os')
    const candidates = [
      process.env.AGENTISTICS_CENTRAL_ENV,
      join(process.cwd(), 'central.env'),
      join(homedir(), '.agentistics', 'central.env'),
    ].filter((p): p is string => !!p)
    const file = candidates.find(p => existsSync(p))
    if (!file) return null
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq < 0) continue
      const key = t.slice(0, eq).trim()
      const value = t.slice(eq + 1).trim()
      if (key && process.env[key] === undefined) process.env[key] = value
    }
    return file
  } catch {
    return null
  }
}

const HELP = `
Usage: agentop [command] [options]

Bare \`agentop\` on a terminal opens the control center (services, setup, logs, help).
Without a terminal it prints this help. \`--help\` always prints it.

Commands:
  start         Same control center as bare agentop (non-interactive: runs like 'server')
  setup         Interactive first-run wizard (solo / central / member)
  server        Start the web dashboard + background daemon (non-interactive)
                (add --central to run the team central natively, no Docker; --bg to detach)
  restart       Restart a running mode's service so it picks up new code/config
  status        Show services (server/central/member) + health
  tui           Alias for 'start' — the metrics dashboard is its 'dashboard' tab
  watch         Start the background metrics daemon only
  central       Manage the team central (Docker; runs from anywhere)
  member        Configure this machine as a team member
  session       Start / list / attach assistant sessions (tmux-backed; --bg detaches);
                'session ls' prints the cockpit's table of what is running
  hooks         Teach Claude Code to run work in parallel through agentop
                (installs a skill + SessionStart/Stop hooks; explicit, reversible)
  events        Be told when a session starts waiting, blocks on a permission prompt or
                exits — in an inbox, in another Claude session, and on your desktop
                ('events watch' to subscribe, 'events status' to see who is watching)
  ci-push       One-shot push of a CI runner's metrics to a central
  upgrade       Upgrade agentop to the latest version
  autostart     Start a mode with the system (systemd user service on Linux)
  check-update  Print a notice if a newer version is available (else silent);
                a release marked [critical] says so louder (auto-install is opt-in)
  doctor        Run the exposure preflight; add --exposed to check against the
                strict public bar before opening a tunnel
  setup-token   Reissue the one-time OWNER setup token (central only; run it where the
                central runs: ./central.sh setup-token, or agentop central setup-token)
  reset-password
                Reset an account's password from the host (central only) — the recovery
                path when the last owner is locked out. --email <address>, optional
                --password <new> and --clear-mfa

Options:
  --help, -h       Show this help message
  --version, -v    Show current version
  --port <n>       Port for the web server (default: 47291)  [server, start]
  --central        Run as the team central natively (no Docker) — reads central.env for
                   MONGO_URL + secrets; requires an external MONGO_URL (Atlas/mongod)  [server only]
  --bg             Start detached in the background (logs to ~/.agentistics)  [server only]

Native central (no Docker):
  agentop server --central [--bg] [--port <n>]
    Runs the same server process with AGENTISTICS_TEAM_CENTRAL=1, loading central.env
    (search: $AGENTISTICS_CENTRAL_ENV, ./central.env, ~/.agentistics/central.env). There is no
    bundled Mongo — set MONGO_URL to an external cluster. Use --bg to run in the background like
    the local server. For the all-in-one Docker flow (bundled Mongo) use \`agentop central up\`.

Control center:
  agentop            (on a terminal)
  agentop start
    One full-screen application, in the terminal's alternate buffer — it adds nothing to
    your scrollback. Tabs: Services (start/stop/restart this machine, a central or the
    Docker machine; connect to or leave a central; enable a boot service), Setup (solo /
    central / member and the history-preservation consent), Logs, Cheat sheet, Help,
    Contribute. Picking "foreground" closes it and starts the server in this terminal.
    Non-interactive stdin runs like 'agentop server'.

Restart:
  agentop restart [server|watch|central|--all] [--rebuild] [-y|-n] [--cache]
    Restart a running mode so it picks up new code (after an upgrade/pull) or config.
    server/watch bounce the systemd user service; central restarts its container.
    --all bounces every service currently up (local + central + machine), non-interactively.
    --rebuild recreates the Docker image/container (central + machine) instead of just bouncing
    it — use it to pick up new code in Docker deployments (native server: use bun bin / upgrade).
    A --rebuild builds the image from SCRATCH (no Docker cache), so it cannot hand you back the
    image it just replaced. That is slow — several minutes — so:
      --cache      reuse Docker's layer cache instead (the fast path)
      -y / --yes   re-run the central's interactive setup, without being asked
      -n / --no    do not re-run it, without being asked (a rebuild's default when it has no
                   terminal to ask on). Passing both -y and -n is refused.

Setup:
  agentop setup
    Interactive wizard: pick solo, host a central, or join one as a member.
    The control center's Setup tab asks the same questions.

Central:
  agentop central <up|init|down|logs|status|restart|pull|setup-token|reset-password>
    HOW it runs is your choice, and \`up\` takes it as a flag:
      --image    Docker, published image (ghcr.io/blpsoares/agentistics) — no checkout needed
      --build    Docker, built from this checkout (central.sh)
      --native   the agentop binary IS the server — no Docker; needs an external MONGO_URL
      --bg       native only: detach instead of holding this terminal
    Unstated, it uses whatever \`agentop central init\` recorded, and failing that the same
    default as before (a checkout builds; otherwise the database decides). A shape that cannot
    work here is refused in a sentence, never silently swapped for another.
    \`up\` also accepts -y/--yes or -n/--no (answer "re-run interactive setup?" up front, for
    unattended runs; both together is refused) and --no-cache/--cache (build the image from
    scratch, or reuse Docker's layer cache — cached by default on a plain \`up\`).
    \`init\` asks for the port, org, bind interface, database and the shape above, and writes
    central.env (chmod 600). Publishing it on the internet is a separate step and a separate
    set of variables — see docs/exposure.md.
    setup-token reissues the one-time OWNER setup token (for when the boot that printed it
    scrolled away), running where the database is reachable. Refused once an owner exists.
    reset-password --email <address> resets an account's password from the host — there is no
    e-mail-based reset, so this is how a locked-out last owner gets back in.

Member (a machine may belong to several centrals at once):
  agentop member connect --token <token> [--endpoint <url>] [--org <org>] [--label <name>]
    Verify the token against the central, then add a new connection or UPDATE an existing
    one keyed by its endpoint (a token rotation on a known central updates in place).
    A token minted by a central with a public URL configured carries that URL, so the token
    alone is enough — --endpoint is only needed for a bare token.
  agentop member list
    List every connection this machine has, with its live sync state. ('status' is an alias.)
  agentop member status [--endpoint <url>]
    Show every connection's mode/endpoint/user/last-sync (or just one, with --endpoint).
  agentop member leave [--endpoint <url>] [--all]
    0 connections     nothing to do.
    1 connection      leaves it, no prompt.
    N, --endpoint     leaves that one connection.
    N, --all          leaves every connection — back to solo.
    N, no flag, TTY   arrow-key picker (pick one, "Leave all", or Cancel).
    N, no flag, non-TTY  refuses — pass --endpoint <url> or --all instead of guessing.

CI (GitHub Actions):
  agentop ci-push [--endpoint <url>] [--token <ci-token>] [--org <org>]
    One-shot push of this runner's metrics to a central. Prefers keyless
    GitHub OIDC (needs permissions: id-token: write); falls back to a
    static token. Reads AGENTISTICS_CENTRAL_URL / AGENTISTICS_CI_TOKEN /
    AGENTISTICS_OIDC_AUDIENCE / AGENTISTICS_TEAM_ORG when flags are omitted.
    Never fails the job on a push error.

Claude Code integration:
  agentop hooks <install|uninstall|status> [--hook-only|--skill-only]
    Two things, both explicit and both reversible:
      skill  ~/.claude/skills/agentop-parallel-sessions/SKILL.md — WHAT Claude needs to know
             to split independent work across several assistants and start them with
             \`agentop session batch\`. Loaded by Claude only when the task matches it, so it
             costs nothing on a session that never parallelises.
      hook   a SessionStart entry in ~/.claude/settings.json — FACTS a static file cannot
             hold: which agentop sessions are running now, which one is blocked on a
             permission prompt, which task can be reopened here. Prints nothing when there
             is nothing running.
    A hook infers nothing; it is a shell command on an event. The inference is Claude's,
    reading what the skill teaches and what the hook injected. \`uninstall\` removes exactly
    what \`install\` wrote, and every other key in settings.json is left untouched.

Updates:
  agentop upgrade
    Download the latest binary and restart whatever services are running. Only installs a
    release published for this platform/arch, verifies the download (size, executable magic
    and the new binary's own --version) before swapping it in, keeps the previous binary at
    <binary>.bak and restores it if anything fails. Exits non-zero when the install was
    refused/rolled back or a service could not be restarted onto the new version.
  agentop check-update
    Silent when up to date. Answers from ~/.agentistics/version-cache.json and refreshes it
    in a detached process, so it never delays a shell prompt. An OPTIONAL update prints a
    banner; a CRITICAL update (its GitHub release notes contain a "[critical]" line outside
    code fences) prints a louder one telling you to run \`agentop upgrade\`. Unattended install
    is OPT-IN: set AGENTISTICS_AUTO_UPGRADE=1 to let a critical release install itself in a
    detached background process, logged to ~/.agentistics/auto-upgrade.log.

Autostart:
  agentop autostart <mode> <enable|disable|status>
    mode ∈ { server, central, watch, machine }
    enable   Register + start the service at boot (also adds a terminal
             update-check hook to ~/.bashrc)
    disable  Stop and remove the service
    status   Show enabled/active state (omit mode to list all)
    Manager: systemd user units on Linux, launchd user agents on macOS, or pm2 anywhere it is
    installed (never chosen by default — it is your process list). None of them needs root, and
    each names the one step it cannot take for you so a reboot really does bring the service
    back: linger on systemd, login-not-boot on launchd, \`pm2 save\` + \`pm2 startup\` on pm2.
    \`central\` follows the shape that central was configured with, so a natively started
    central gets a unit that starts it natively rather than one that starts Docker.

Examples:
  agentop start
  agentop setup
  agentop central up --image        # a central from the published image, no clone
  agentop central up --native --bg  # a central on Atlas, detached, no Docker
  agentop server
  agentop server --port 4000
  agentop restart server
  agentop watch
  agentop central up
  agentop member connect --token act1_aHR0cHM6Ly9jZW50cmFsLmV4YW1wbGU.abc123
  agentop member connect --endpoint http://host:48080 --token abc123
  agentop member connect --endpoint http://other:48080 --token def456 --label "Client B"
  agentop member list
  agentop member leave --endpoint http://host:48080
  agentop member leave --all
  agentop upgrade
  agentop check-update
  agentop autostart server enable
  agentop autostart status
  agentop hooks install
  agentop hooks status
`.trim()

// ---------------------------------------------------------------------------
// Version check (runs in parallel with command startup — non-blocking)
// ---------------------------------------------------------------------------

const _ESC = '\x1b'
const _R   = `${_ESC}[0m`
const _B   = `${_ESC}[1m`
const _Y   = `${_ESC}[33m`
const _AM  = `${_ESC}[38;5;208m`
const _CY  = `${_ESC}[96m`
const _GR  = `${_ESC}[92m`
const _WH  = `${_ESC}[97m`
const _D   = `${_ESC}[2m`

/** Prints the "new version available" banner for a resolved VersionInfo. */
function printUpdateBanner(info: { current: string; latest: string }): void {
  const sep = `${_D}${''.repeat(52)}${_R}`
  process.stdout.write(
    `\n${sep}\n` +
    `  ${_Y}${_B}⚡ New version available!${_R}\n` +
    `${sep}\n` +
    `  ${_D}Current:${_R} ${_WH}v${info.current}${_R}\n` +
    `  ${_D}Latest: ${_R} ${_GR}${_B}v${info.latest}${_R}\n` +
    `${sep}\n` +
    `\n` +
    `  ${_B}Run ${_AM}agentop upgrade${_R}${_B} to update automatically.${_R}\n` +
    `${sep}\n\n`,
  )
}

/**
 * Prints the "critical update is installing itself" notice. Unlike the optional banner
 * this is informational only — there is nothing for the user to run.
 */
function printCriticalUpdateBanner(
  info: { current: string; latest: string },
  s: { updateCriticalTitle: string; updateCriticalInstalling: (v: string) => string; updateCriticalLog: (p: string) => string },
  logPath: string,
): void {
  process.stdout.write(
    `\n  ${_AM}${_B}⚡ ${s.updateCriticalTitle}${_R}\n` +
    `  ${_D}v${info.current} → ${_R}${_GR}${_B}v${info.latest}${_R}\n` +
    `  ${s.updateCriticalInstalling(info.latest)}\n` +
    `  ${_D}${s.updateCriticalLog(logPath)}${_R}\n\n`,
  )
}

/** CLI language: `--lang en|pt`, else preferences.lang, else English. Never throws. */
async function resolveCliLang(): Promise<'en' | 'pt'> {
  const i = process.argv.indexOf('--lang')
  const flag = process.argv[i + 1]
  if (i >= 0 && (flag === 'pt' || flag === 'en')) return flag
  try {
    const { readPreferences } = await import('../server/preferences.ts')
    const prefs = await readPreferences()
    return prefs.lang === 'pt' ? 'pt' : 'en'
  } catch {
    // Deliberately NOT readPreferencesOrExit: this runs before every command, including the one
    // that is about to report the corrupt file. Picking a language must never be what kills the
    // process — the command's own read (readPreferencesOrExit) reports it, in English.
    return 'en'
  }
}

/**
 * Set by the upgrade's verification probe (and honoured everywhere a command would
 * otherwise reach for GitHub): `agentop --version` must answer instantly and offline when
 * the installer runs the freshly downloaded binary to make it identify itself.
 */
function updateChecksDisabled(): boolean {
  return process.env.AGENTISTICS_NO_UPDATE_CHECK === '1'
}

async function checkVersionAndWarn(): Promise<void> {
  if (updateChecksDisabled()) return
  try {
    const { getVersionInfo } = await import('../server/version.ts')
    const info = await getVersionInfo()
    if (!info.hasUpdate) return
    printUpdateBanner(info)
  } catch {
    // Network unavailable — silently skip
  }
}

/**
 * Refreshes the shared on-disk version cache in a DETACHED process and returns immediately.
 * This is what keeps the shell rc hook off the network: `agentop check-update` answers from
 * the cache file, and a slow or failing GitHub call can never delay a prompt.
 */
async function spawnVersionCacheRefresh(): Promise<void> {
  try {
    const { spawn } = await import('node:child_process')
    const script = process.argv[1]
    const fromSource = !!script && (script.endsWith('.ts') || script.endsWith('.js'))
    const argv = fromSource
      ? [script, 'check-update', '--refresh']
      : ['check-update', '--refresh']
    const child = spawn(process.execPath, argv, { detached: true, stdio: 'ignore' })
    child.unref()
  } catch {
    // Can't spawn — the next shell simply tries again.
  }
}

// ---------------------------------------------------------------------------

if (command === '--help' || command === '-h') {
  console.log(HELP)
  process.exit(0)
}

/**
 * `--port` has to be in the environment BEFORE anything imports `server/config.ts`, which freezes
 * `PORT` at module load. `agentop start --port N` used to set it after `runStart()` had already
 * pulled `cli-start.ts` — and therefore `config.ts` — in, so the control center detected, reported
 * and started a server on 47291 while the flag it was given said otherwise, in silence.
 */
{
  const portIdx = args.indexOf('--port')
  const port = portIdx !== -1 ? args[portIdx + 1] : undefined
  if (port) process.env.PORT = port
}

// Bare `agentop` on a terminal IS the control center — the same screen `agentop start` opens,
// regardless of whether this machine is configured (setup is one of its tabs). Without a TTY it
// still prints HELP: a pipe, a CI job or `agentop | less` must keep answering in text.
if (!command) {
  if (!process.stdin.isTTY) {
    console.log(HELP)
    process.exit(0)
  }
  // Read the preferences BEFORE the control center opens, and before the alternate screen is
  // entered — a corrupt file must not be silently treated as "nothing configured". The control
  // center would then present this machine as solo and offer to write over a file that still
  // holds its connections. readPreferencesOrExit names the file on stderr and exits non-zero,
  // which it can only do while stdout is still the real terminal.
  const { readPreferencesOrExit } = await import('../server/preferences.ts')
  await readPreferencesOrExit()

  const { runStart } = await import('../server/cli-start.ts')
  const result = await runStart()
  if (result !== 'foreground') process.exit(result)
  // else: fall through to the shared server startup below.
}

if (command === 'setup') {
  const { runSetup } = await import('../server/cli-setup.ts')
  const code = await runSetup()
  process.exit(code)
}

if (command === 'central') {
  const { runCentral } = await import('../server/cli-central.ts')
  const action = args[0]
  if (!action) {
    console.error('Missing central action. Expected one of: up, init, down, logs, status, restart, pull.\n')
    console.log(HELP)
    process.exit(1)
  }
  // `up` takes the rebuild flags; every other action forwards its argv untouched (reset-password
  // has its own --email/--password, and -n there must stay reset-password's business).
  let extra = args.slice(1)
  if (action === 'up') {
    const { parseRebuildFlags, centralUpArgs } = await import('../server/rebuild-flags.ts')
    const parsed = parseRebuildFlags(extra)
    if (!parsed.ok) {
      const { cliStrings } = await import('../server/cli-i18n.ts')
      const { resolveLang } = await import('../server/cli-lang.ts')
      console.error(cliStrings(await resolveLang()).flagConflict(parsed.conflict[0], parsed.conflict[1]))
      process.exit(1)
    }
    extra = [...centralUpArgs(parsed.flags), ...parsed.rest]
  }
  const code = await runCentral(action, extra)
  process.exit(code)
}

if (command === 'session') {
  const { runSession } = await import('../server/sessions/cli-session.ts')
  const code = await runSession(args)
  process.exit(code)
}

if (command === 'hooks') {
  const { runHooks } = await import('../server/cli-hooks.ts')
  const code = await runHooks(args)
  process.exit(code)
}

if (command === 'events') {
  const { runEvents } = await import('../server/cli-events.ts')
  const code = await runEvents(args)
  process.exit(code)
}

if (command === 'backup') {
  const { runBackupCli } = await import('../server/cli-backup.ts')
  const code = await runBackupCli(args)
  process.exit(code)
}

if (command === 'restore') {
  const { runRestoreCli } = await import('../server/cli-backup.ts')
  const code = await runRestoreCli(args)
  process.exit(code)
}

if (command === 'member') {
  const sub = args[0]
  const rest = args.slice(1)
  // readFlag returns the NEXT argv token — a boolean flag like --all must NEVER be read this
  // way, or `member leave --all` would swallow whatever argument follows it (there happens to be
  // none today, but the bug is in the parsing, not in today's argv shape).
  const readFlag = (name: string): string | undefined => {
    const idx = rest.indexOf(name)
    return idx !== -1 && rest[idx + 1] ? rest[idx + 1] : undefined
  }
  const hasFlag = (name: string): boolean => rest.includes(name)

  if (sub === 'connect') {
    const { memberConnect } = await import('../server/cli-member.ts')
    const { parseMemberConnectArgs } = await import('../server/member-connect-args.ts')
    // Only the token is required: a composite `act1_…` token carries the central's URL, and
    // demanding --endpoint here refused the very command the central prints. See
    // member-connect-args.ts — resolving the endpoint is memberConnect's job, not the gate's.
    const parsed = parseMemberConnectArgs(rest)
    if (!parsed.ok) {
      console.error(`${parsed.usage}\n`)
      process.exit(1)
    }
    const code = await memberConnect(parsed.opts)
    process.exit(code)
  }
  if (sub === 'leave') {
    const { memberLeave } = await import('../server/cli-member.ts')
    const endpoint = readFlag('--endpoint')
    const all = hasFlag('--all')
    const code = await memberLeave({ endpoint, all })
    process.exit(code)
  }
  if (sub === 'status') {
    const { memberStatus } = await import('../server/cli-member.ts')
    const endpoint = readFlag('--endpoint')
    const code = await memberStatus({ endpoint })
    process.exit(code)
  }
  if (sub === 'list') {
    const { memberList } = await import('../server/cli-member.ts')
    const endpoint = readFlag('--endpoint')
    const code = await memberList({ endpoint })
    process.exit(code)
  }
  console.error(`Invalid member action: ${sub ?? '(none)'}. Expected one of: connect, leave, status, list.\n`)
  console.log(HELP)
  process.exit(1)
}

if (command === 'ci-push') {
  // One-shot push of this (ephemeral GitHub Actions) runner's metrics to a central.
  const readFlag = (name: string): string | undefined => {
    const idx = args.indexOf(name)
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined
  }
  const { runCiPush } = await import('../server/ci-push.ts')
  const code = await runCiPush({
    endpoint: readFlag('--endpoint'),
    token: readFlag('--token'),
    org: readFlag('--org'),
  })
  process.exit(code)
}

if (command === '--version' || command === '-v') {
  const { CURRENT_VERSION, getVersionInfo } = await import('../server/version.ts')
  process.stdout.write(`agentop v${CURRENT_VERSION}\n`)
  // The upgrade's verification probe runs exactly this command on the downloaded binary and
  // must not wait on GitHub (nor recurse into an update check mid-install).
  if (updateChecksDisabled()) process.exit(0)
  const info = await getVersionInfo()
  if (info.hasUpdate) {
    process.stdout.write(
      `${_Y}${_B}⚡ New version available: v${info.latest}${_R}\n` +
      `  Run ${_AM}agentop upgrade${_R} to update.\n`,
    )
  }
  process.exit(0)
}

if (command === 'upgrade' || command === 'update') {
  const { runUpgrade } = await import('../server/upgrade.ts')
  // Exit code reflects reality: non-zero when the install was refused/rolled back, or when a
  // running service could not be restarted onto the new version.
  process.exit(await runUpgrade(await resolveCliLang()))
}

// Lightweight boot/terminal update check — prints the banner only when a newer version exists,
// otherwise stays completely silent. This is what the ~/.bashrc hook installed by
// `agentop autostart ... enable` runs on EVERY terminal open, so it must be instant:
//
//   • the verdict is read from the shared on-disk cache (~/.agentistics/version-cache.json),
//     never from a live GitHub call — a slow or dead network cannot delay a prompt;
//   • when that cache is due for a refresh, a DETACHED `agentop check-update --refresh`
//     updates it in the background and this process exits immediately.
//
// Optional updates inform and let the user decide. A CRITICAL release (its GitHub release body
// carries a `[critical]` line, outside code fences) does the same by default but with a louder
// banner; with AGENTISTICS_AUTO_UPGRADE=1 it instead spawns a detached `agentop upgrade` (which
// verifies, backs up, installs and restarts the running services) and returns the terminal
// immediately. Unattended install stays opt-in until the hardened path has been reviewed.
if (command === 'check-update') {
  try {
    const {
      CURRENT_VERSION, getVersionInfo, readVersionCache, cachedVersionInfo, shouldRefreshVersionCache,
    } = await import('../server/version.ts')

    // Hidden: the detached refresh. Does the blocking network call, writes the shared cache,
    // prints nothing. Never spawned recursively (this branch never spawns).
    if (args.includes('--refresh')) {
      await getVersionInfo({ force: true })
      process.exit(0)
    }

    const entry = readVersionCache()
    if (shouldRefreshVersionCache(entry, Date.now(), CURRENT_VERSION)) await spawnVersionCacheRefresh()

    const info = cachedVersionInfo(entry, CURRENT_VERSION)
    // No usable answer yet (first run, or a fresh install whose version the cache predates) →
    // stay silent; the refresh just spawned will have one for the next shell.
    if (!info || !info.hasUpdate) process.exit(0)

    // Unattended install is OPT-IN, not opt-out. The install path is now hardened (arch gate,
    // unique temp file, lock across the whole install, verified download, backup + rollback,
    // surfaced restart failures, failure backoff) but flipping the default is a separate,
    // reviewed change. Until then a critical release gets a loud banner and the user runs it.
    const { autoInstallAllowed } = await import('../server/version.ts')
    const autoAllowed = autoInstallAllowed()
    if (info.critical && autoAllowed) {
      const { startBackgroundUpgrade, AUTO_UPGRADE_LOG } = await import('../server/upgrade.ts')
      const { cliStrings } = await import('../server/cli-i18n.ts')
      const s = cliStrings(await resolveCliLang())
      const started = await startBackgroundUpgrade(info.latest)
      if (started === 'started') printCriticalUpdateBanner(info, s, AUTO_UPGRADE_LOG)
      else if (started === 'in-progress') process.stdout.write(`\n  ${_D}${s.updateCriticalRunning}${_R}\n\n`)
      // No release asset for this platform/arch — never download a binary that cannot run here.
      else if (started === 'unsupported') {
        process.stdout.write(
          `\n  ${_AM}${_B}⚡ ${s.updateCriticalManualTitle}${_R}\n` +
          `  ${_D}v${info.current} → ${_R}${_GR}${_B}v${info.latest}${_R}\n` +
          `  ${s.updateCriticalUnsupported(`${process.platform}/${process.arch}`)}\n\n`,
        )
      }
      // The same version already failed recently → say so once, quietly, instead of
      // re-downloading ~140 MB on every shell that opens.
      else if (started === 'backoff') process.stdout.write(`\n  ${_D}${s.updateCriticalRetryLater}${_R}\n\n`)
      // 'failed' (couldn't spawn) or 'not-installed' (running from a source checkout,
      // where self-replacing the binary is unsafe) → fall back to asking the user.
      else printUpdateBanner(info)
    } else if (info.critical) {
      // Critical but not auto-installing: say so plainly instead of using the ordinary banner,
      // otherwise an urgent release looks like any other optional one.
      const { cliStrings } = await import('../server/cli-i18n.ts')
      const s = cliStrings(await resolveCliLang())
      process.stdout.write(
        `\n  ${_AM}${_B}⚡ ${s.updateCriticalManualTitle}${_R}\n` +
        `  ${_D}v${info.current} → ${_R}${_GR}${_B}v${info.latest}${_R}\n` +
        `  ${s.updateCriticalManualHow('agentop upgrade')}\n\n`,
      )
    } else {
      printUpdateBanner(info)
    }
  } catch {
    // Network unavailable — stay silent
  }
  process.exit(0)
}

if (command === 'autostart') {
  const {
    isAutostartMode,
    enableAutostart,
    disableAutostart,
    autostartStatus,
  } = await import('../server/autostart.ts')

  const modeArg = args[0]
  const actionArg = args[1]

  // `agentop autostart status` (no mode) lists every service.
  if (modeArg === 'status' && !actionArg) {
    const res = await autostartStatus()
    process.stdout.write(res.message + '\n')
    process.exit(res.ok ? 0 : 1)
  }

  if (!modeArg || !isAutostartMode(modeArg)) {
    console.error(`Invalid mode: ${modeArg ?? '(none)'}. Expected one of: server, central, watch, machine.\n`)
    console.log(HELP)
    process.exit(1)
  }

  const action = actionArg ?? 'status'
  if (action !== 'enable' && action !== 'disable' && action !== 'status') {
    console.error(`Invalid action: ${action}. Expected one of: enable, disable, status.\n`)
    console.log(HELP)
    process.exit(1)
  }

  const res =
    action === 'enable'  ? await enableAutostart(modeArg) :
    action === 'disable' ? await disableAutostart(modeArg) :
                           await autostartStatus(modeArg)

  process.stdout.write(res.message + '\n')
  process.exit(res.ok ? 0 : 1)
}

if (command === 'status') {
  const { runStatus } = await import('../server/cli-status.ts')
  process.exit(await runStatus())
}

if (command === 'restart') {
  // `--rebuild` recreates Docker images/containers (central + machine) instead of just bouncing,
  // from scratch unless `--cache` says otherwise; `-y`/`-n` answer the central's setup prompt.
  const rebuild = args.includes('--rebuild')
  const { parseRebuildFlags, centralRebuildArgs } = await import('../server/rebuild-flags.ts')
  const parsed = parseRebuildFlags(args.filter(a => a !== '--rebuild' && a !== '--all'))
  if (!parsed.ok) {
    const { cliStrings } = await import('../server/cli-i18n.ts')
    const { resolveLang } = await import('../server/cli-lang.ts')
    console.error(cliStrings(await resolveLang()).flagConflict(parsed.conflict[0], parsed.conflict[1]))
    process.exit(1)
  }
  const flags = parsed.flags
  const positional = parsed.rest.filter(a => !a.startsWith('-'))
  const modeArg = positional[0] ?? (args.includes('--all') ? 'all' : 'server')
  // `agentop restart --all [--rebuild]` — bounce (or rebuild) every service currently up.
  if (modeArg === 'all') {
    const { restartAllServices } = await import('../server/cli-start.ts')
    process.exit(await restartAllServices(rebuild, flags))
  }
  // The central runs in Docker — delegate to its own compose. `up` rebuilds/pulls + recreates;
  // `restart` just bounces the running container.
  if (modeArg === 'central') {
    const { runCentral } = await import('../server/cli-central.ts')
    const code = rebuild
      ? await runCentral('up', centralRebuildArgs(flags))
      : await runCentral('restart', [])
    process.exit(code)
  }
  const { restartAutostart, isAutostartMode } = await import('../server/autostart.ts')
  if (!isAutostartMode(modeArg)) {
    console.error(`Invalid mode: ${modeArg}. Expected one of: server, watch, central, machine.\n`)
    process.exit(1)
  }
  // The server is the mode this tool actually starts for you, and it starts it DETACHED, not as a
  // systemd unit — so restarting it cannot assume systemd. `restartNativeServer` restarts whatever
  // is running (and rebuilds first when asked); `watch` has only the unit form.
  if (modeArg === 'server') {
    const { restartNativeServer } = await import('../server/cli-start.ts')
    const r = await restartNativeServer(rebuild, flags)
    process.stdout.write(r.message + '\n')
    process.exit(r.ok ? 0 : 1)
  }
  // --rebuild on a native mode rebuilds + reinstalls the binary from the repo so the restart
  // serves new frontend/code (a plain bounce would keep the old build).
  if (rebuild) {
    const { rebuildNativeBinary } = await import('../server/cli-start.ts')
    const r = await rebuildNativeBinary()
    if (r === 'not-repo') {
      console.error('--rebuild for the native server needs the repo checkout. Run it from the agentistics repo (or `agentop upgrade`).\n')
      process.exit(1)
    }
    if (r === 'failed') { console.error('native rebuild failed.\n'); process.exit(1) }
  }
  const res = await restartAutostart(modeArg)
  process.stdout.write(res.message + '\n')
  process.exit(res.ok ? 0 : 1)
}

// `agentop start` — the control center, same as bare `agentop`. When the user picks "foreground"
// (or stdin isn't a TTY) runStart returns 'foreground' and we fall through to the same in-process
// server startup as `agentop server` below (keeping the Bun.serve alive).
if (command === 'start') {
  const { runStart } = await import('../server/cli-start.ts')
  const result = await runStart()
  if (result !== 'foreground') process.exit(result)
  // else: fall through to the shared server startup below.
}

if (command === 'server' || command === 'start' || !command) {
  // `--port` is already in the environment — see the note above the command dispatch. The index is
  // still needed here to forward the flag to a detached copy.
  const portIdx = args.indexOf('--port')
  // Native central (no Docker): same server process with TEAM_CENTRAL=1, reading central.env for
  // MONGO_URL + secrets. Unlike the Docker central there is NO bundled Mongo, so an external
  // MONGO_URL (Atlas or your own mongod) is required.
  const central = args.includes('--central')
  if (central) {
    const envFile = loadCentralEnv()
    process.env.AGENTISTICS_TEAM_CENTRAL = '1'
    if (!process.env.MONGO_URL) {
      console.error('\n  ✗ native central needs MONGO_URL — there is no bundled Mongo without Docker.')
      console.error('    Set MONGO_URL (external Mongo/Atlas) in central.env or the environment.')
      console.error('    (Or use `agentop central up` for the all-in-one Docker flow.)\n')
      process.exit(1)
    }
    if (envFile) console.log(`  central: loaded ${envFile}`)
  }

  // Background: spawn a detached copy (logging to ~/.agentistics) and return the terminal.
  if (args.includes('--bg') || args.includes('--background')) {
    const { spawn } = await import('node:child_process')
    const { homedir } = await import('node:os')
    const { join } = await import('node:path')
    const log = join(homedir(), '.agentistics', 'agentop-server.log')
    const script = process.argv[1]
    const fromSource = !!script && (script.endsWith('.ts') || script.endsWith('.js'))
    const selfBase = fromSource ? `"${process.execPath}" "${script}"` : `"${process.execPath}"`
    // Re-invoke `server` in the foreground (drop --bg), forwarding --central / --port.
    const fwd = [central ? '--central' : '', portIdx !== -1 && args[portIdx + 1] ? `--port ${args[portIdx + 1]}` : '']
      .filter(Boolean).join(' ')
    const cmd = `${selfBase} server ${fwd}`.trim()
    const child = spawn('sh', ['-c', `nohup ${cmd} >> "${log}" 2>&1 &`], { stdio: 'ignore', detached: true })
    child.unref()
    const webPort = parseInt(process.env.WEB_PORT ?? String((parseInt(process.env.PORT ?? '47291', 10)) + 1), 10)
    console.log(`\n  started ${central ? 'central ' : ''}in the background.`)
    console.log(`  web:  http://localhost:${webPort}`)
    console.log(`  logs: ${log}\n`)
    process.exit(0)
  }

  process.env.SERVE_STATIC = '1'
  // Server, daemon and version check run in parallel
  await Promise.all([
    import('../server/index.ts'),
    import('../server/otel-watcher.ts'),
    checkVersionAndWarn(),
  ])
} else if (command === 'watch') {
  checkVersionAndWarn() // fire-and-forget
  await import('../server/otel-watcher.ts')
} else if (command === 'doctor') {
  const { runDoctor } = await import('../server/cli-doctor.ts')
  await runDoctor(args)
} else if (command === 'setup-token') {
  const { runSetupToken } = await import('../server/cli-setup-token.ts')
  await runSetupToken()
} else if (command === 'reset-password') {
  const { runResetPassword } = await import('../server/cli-reset-password.ts')
  await runResetPassword(args)
} else {
  console.error(`Unknown command: ${command}\n`)
  console.log(HELP)
  process.exit(1)
}
