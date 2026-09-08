/**
 * autostart — register agentop to start with the system, plus a lightweight
 * terminal/boot update-check hook.
 *
 * THREE managers, chosen by `service-manager.ts`: systemd *user* services on Linux, launchd *user*
 * agents on macOS, and pm2 anywhere it is installed. None of them needs root. macOS used to print
 * a paragraph of manual steps and Windows still does — the difference is that the launchd recipe
 * was already written down in the docs, which means the product knew the answer and made the user
 * transcribe it.
 *
 * The `central` mode is the one with a second dimension: WHICH SHAPE of central this box runs
 * (`central-runtime.ts`). It decides both the command and — through `keepsRunning` — the kind of
 * unit. A native central holds the terminal, so it is a normal long-running service; a Docker one
 * returns as soon as the container is up, and registering THAT as a long-running service produces
 * a unit that reads inactive(dead) one second after a perfectly successful start.
 */

import { homedir, platform, userInfo } from 'os'
import { join, resolve } from 'path'
import { mkdir, writeFile, readFile, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import type { CentralRuntimeId } from './central-runtime'
import {
  availableServiceManagers,
  bootCaveat,
  defaultServiceManager,
  launchdPlist,
  launchdPlistName,
  pm2DeleteArgs,
  pm2StartArgs,
  systemdUnit,
  migrateUnitKillMode,
  type ServiceManagerFacts,
  type ServiceManagerId,
  type ServiceSpec,
} from './service-manager'

export type AutostartMode = 'server' | 'central' | 'watch' | 'machine'

export interface AutostartResult {
  ok: boolean
  message: string
}

const MODES: AutostartMode[] = ['server', 'central', 'watch', 'machine']

// --- shell-rc update-check hook markers (kept stable so uninstall is exact) ---
const HOOK_BEGIN = '# >>> agentop update check >>>'
const HOOK_END = '# <<< agentop update check <<<'
// POSIX one-liner — valid in both bash and zsh (the two shells we manage).
const HOOK_LINE = 'command -v agentop >/dev/null 2>&1 && agentop check-update 2>/dev/null'

/** Shell rc files we manage the update-check hook in. Different login shells source
 *  different files (bash → ~/.bashrc, zsh → ~/.zshrc), so a bash-only hook was invisible
 *  to zsh users. We install into whichever of these already exist. */
function hookRcCandidates(): string[] {
  return [join(homedir(), '.bashrc'), join(homedir(), '.zshrc')]
}

/** Pure: append the guarded hook block to rc `content` when absent. Returns null when the
 *  block is already present (idempotent no-op). */
export function addHookBlock(content: string): string | null {
  if (content.includes(HOOK_BEGIN)) return null
  return content + `\n${HOOK_BEGIN}\n${HOOK_LINE}\n${HOOK_END}\n`
}

/** Pure: remove the guarded hook block from rc `content`. Returns null when absent, or
 *  throws when the block is corrupt (a BEGIN with no matching END). */
export function removeHookBlock(content: string): string | null {
  const beginIdx = content.indexOf(HOOK_BEGIN)
  if (beginIdx === -1) return null
  const endIdx = content.indexOf(HOOK_END, beginIdx)
  if (endIdx === -1) throw new Error('corrupt hook block')
  // Consume the newline addHookBlock prepended before BEGIN and the one after END, so this is
  // an exact inverse of addHookBlock (no stray blank line left behind).
  let start = beginIdx
  if (start > 0 && content[start - 1] === '\n') start -= 1
  let end = endIdx + HOOK_END.length
  if (content[end] === '\n') end += 1
  return content.slice(0, start) + content.slice(end)
}

/** ~/.bashrc → "~/.bashrc" for user-facing messages. */
function tildeRc(rc: string): string {
  return rc.replace(homedir(), '~')
}

/**
 * Locate the repo checkout holding `central.sh`, used only by the `central` mode command.
 *
 * The old version derived it as three directories up from `import.meta.dir` and guarded that
 * with a try/catch. `resolve` does not throw, so the guard never fired: under the COMPILED
 * BINARY `import.meta.dir` is Bun's virtual root (`/$bunfs/root`), three up is `/`, and the
 * unit shipped `ExecStart=bash /central.sh up` — a service that exits 127 and is restarted
 * every 5 seconds forever. Existence is the only thing that distinguishes a real checkout from
 * a path that merely parses, so check for the file rather than assuming the layout.
 *
 * Returns null when no candidate holds the script — see `serviceCommandFor`.
 */
function findCentralScript(): string | null {
  const candidates = [
    // Running from source: <repoRoot>/packages/server/server/autostart.ts
    resolve(import.meta.dir, '..', '..', '..'),
    // Compiled binary invoked from inside a checkout.
    process.cwd(),
  ]
  for (const dir of candidates) {
    const script = join(dir, 'central.sh')
    if (existsSync(script)) return script
  }
  return null
}

/**
 * Locate `docker/machine.yml`, the same way `findCentralScript` locates `central.sh` — it
 * only exists in a repo checkout, so a boot unit for the Docker `machine` runtime can only be
 * written from one. Returns null otherwise, which `serviceCommandFor('machine')` turns into a
 * refusal rather than a unit whose `ExecStart` cannot resolve.
 */
function findMachineCompose(): string | null {
  const candidates = [
    resolve(import.meta.dir, '..', '..', '..'),
    process.cwd(),
  ]
  for (const dir of candidates) {
    const compose = join(dir, 'docker', 'machine.yml')
    if (existsSync(compose)) return compose
  }
  return null
}

/**
 * The exact shell command each mode's service should run, or null when this machine cannot run
 * that mode at all. `central` needs `central.sh`, which only exists in a repo checkout; from an
 * installed binary there is nothing to point at. Null means the caller must REFUSE — the same
 * rule the control center applies to a rebuild it cannot perform: absent beats present-and-failing.
 */
export interface ServiceCommandOpts {
  /**
   * For `central`: the shape this box is configured to run.
   *
   * Absent keeps the historical answer exactly — `bash central.sh up` in a checkout — so an
   * existing unit is regenerated as the same unit. Named, it decides both the command and whether
   * the service is long-running.
   */
  centralRuntime?: CentralRuntimeId
}

export function serviceCommandFor(mode: AutostartMode, opts: ServiceCommandOpts = {}): string | null {
  const bin = process.execPath
  switch (mode) {
    case 'server':
      return `${bin} server`
    case 'watch':
      return `${bin} watch`
    case 'central': {
      const script = findCentralScript()
      switch (opts.centralRuntime) {
        case 'native':
          // The binary IS the server on this path, and `central up` runs it in the foreground —
          // which is precisely the shape a service wants.
          return `${bin} central up --native`
        case 'docker-image':
          // `-n` states the answer to central.sh's "re-run interactive setup?" up front. At boot
          // stdin is not a tty so it would not have been asked, but a unit that depends on that
          // accident is a unit that hangs the day someone runs it by hand.
          return `${bin} central up --image -n`
        case 'docker-build':
          return script ? `bash ${script} up -n` : null
        default:
          // Unstated: the checkout wins, exactly as before. Without one, fall through to the
          // published image rather than refusing — `agentop autostart central enable` used to be
          // impossible from an installed binary, which is the ONE configuration where the user has
          // no `central.sh` to write a unit around by hand either.
          return script ? `bash ${script} up` : `${bin} central up -n`
      }
    }
    case 'machine': {
      // No `--build`: the boot-time unit brings back whatever image is already there. A rebuild
      // is a deliberate action (the control center's "Rebuild & restart"), never something that
      // should happen silently every time the machine reboots.
      const compose = findMachineCompose()
      return compose ? `docker compose -f ${compose} up -d` : null
    }
  }
}

/**
 * Does this mode's command stay in the FOREGROUND for as long as the service runs?
 *
 * See `service-manager.ts` — this is the field that decides `Type=simple` versus
 * `Type=oneshot` + `RemainAfterExit=yes`, launchd's `KeepAlive`, and pm2's `--no-autorestart`.
 */
export function serviceKeepsRunning(mode: AutostartMode, opts: ServiceCommandOpts = {}): boolean {
  switch (mode) {
    case 'server':
    case 'watch':
      return true
    case 'machine':
      return false
    case 'central':
      // Only the native central is the process. Both Docker shapes return once the container is up.
      return opts.centralRuntime === 'native'
  }
}

/** The full description of one registration, in the terms every manager needs. */
export function serviceSpecFor(mode: AutostartMode, opts: ServiceCommandOpts = {}): ServiceSpec | null {
  const command = serviceCommandFor(mode, opts)
  if (!command) return null
  return {
    name: `agentop-${mode}`,
    description: `agentop ${mode} (agentistics autostart)`,
    command,
    keepsRunning: serviceKeepsRunning(mode, opts),
  }
}

/** Which managers this box has. One `--version` probe each, none of them fatal. */
export async function serviceManagerFacts(): Promise<ServiceManagerFacts> {
  const has = async (bin: string) => {
    const res = await run([bin, '--version'])
    return res.code === 0
  }
  const plat = platform()
  return {
    platform: plat,
    // Only probed where it could exist: a `systemctl --version` on macOS is a spawn that always
    // fails, on every status refresh.
    systemctl: plat === 'linux' ? await has('systemctl') : false,
    launchctl: plat === 'darwin' ? existsSync('/bin/launchctl') : false,
    pm2: await has('pm2'),
  }
}

/**
 * The systemd unit that brings a mode back — the name a user has to be given.
 *
 * Exported because "starts at boot" is not an answer anyone can act on: the whole complaint this
 * module grew a `disable` path for was a central that came back with nothing on screen naming what
 * brought it. With the unit named, `systemctl --user status <unit>` answers, `agentop autostart
 * status` answers, and the cockpit's detail pane can print it beside the state.
 */
export function unitName(mode: AutostartMode): string {
  return `agentop-${mode}.service`
}

function unitPath(mode: AutostartMode): string {
  return join(homedir(), '.config', 'systemd', 'user', unitName(mode))
}

/** The unit text, composed by `service-manager.ts` so the Type/RemainAfterExit rule lives in one
 *  tested place rather than being restated per manager. */
function unitContents(spec: ServiceSpec): string {
  return systemdUnit(spec)
}

/**
 * Runs a command, capturing stdout/stderr. Never throws — a non-zero exit or a
 * missing binary is reported through the returned object.
 */
async function run(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { code, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (err: any) {
    return { code: 127, stdout: '', stderr: err?.message ?? String(err) }
  }
}

function notSupported(action: string): AutostartResult {
  const plat = platform()
  if (plat === 'darwin') {
    return {
      ok: false,
      message:
        `autostart is not yet supported on macOS.\n` +
        `Manual step: create a launchd agent that runs "${serviceCommandFor('server')}" ` +
        `(a plist under ~/Library/LaunchAgents with RunAtLoad=true), then ` +
        `\`launchctl load\` it. See https://www.launchd.info for details.`,
    }
  }
  if (plat === 'win32') {
    return {
      ok: false,
      message:
        `autostart is not yet supported on Windows.\n` +
        `Manual step: register a Task Scheduler task (or a Startup-folder shortcut) ` +
        `that runs "${serviceCommandFor('server')}" at logon.`,
    }
  }
  return {
    ok: false,
    message: `autostart (${action}) is not supported on this platform (${plat}).`,
  }
}

/**
 * Appends a single guarded line to each present shell rc (~/.bashrc and ~/.zshrc) that runs
 * `agentop check-update` on every terminal open (and thus at boot for login shells). Installs
 * into whichever candidates already exist; if NEITHER exists, creates ~/.bashrc as the default.
 * Idempotent per file.
 */
export async function installUpdateHook(): Promise<AutostartResult> {
  const candidates = hookRcCandidates()
  const present: string[] = []
  for (const rc of candidates) {
    try { await readFile(rc, 'utf8'); present.push(rc) } catch { /* missing */ }
  }
  // If the user has neither rc yet, seed ~/.bashrc (the historical default).
  const targets = present.length ? present : [join(homedir(), '.bashrc')]

  const touched: string[] = []
  for (const rc of targets) {
    let existing = ''
    try { existing = await readFile(rc, 'utf8') } catch { existing = '' }
    const next = addHookBlock(existing)
    if (next === null) { touched.push(`${tildeRc(rc)} (already present)`); continue }
    try {
      await writeFile(rc, next, 'utf8')
      touched.push(tildeRc(rc))
    } catch (err: any) {
      return { ok: false, message: `Could not write ${tildeRc(rc)}: ${err?.message ?? err}` }
    }
  }
  return { ok: true, message: `Update-check hook ensured in: ${touched.join(', ')}.` }
}

/** Removes the guarded update-check block from every present shell rc (exact marker match). */
export async function uninstallUpdateHook(): Promise<AutostartResult> {
  const candidates = hookRcCandidates()
  const removedFrom: string[] = []
  for (const rc of candidates) {
    let existing = ''
    try { existing = await readFile(rc, 'utf8') } catch { continue /* no such rc */ }
    let next: string | null
    try {
      next = removeHookBlock(existing)
    } catch {
      return { ok: false, message: `${tildeRc(rc)} has a corrupt hook block — remove it manually.` }
    }
    if (next === null) continue // not present in this file
    try {
      await writeFile(rc, next, 'utf8')
      removedFrom.push(tildeRc(rc))
    } catch (err: any) {
      return { ok: false, message: `Could not write ${tildeRc(rc)}: ${err?.message ?? err}` }
    }
  }
  return removedFrom.length
    ? { ok: true, message: `Removed update-check hook from: ${removedFrom.join(', ')}.` }
    : { ok: true, message: 'Update-check hook not present in any shell rc — nothing to remove.' }
}

/** Where a launchd agent's plist lives, and where its output goes. */
function launchdPaths(spec: ServiceSpec) {
  return {
    plist: join(homedir(), 'Library', 'LaunchAgents', launchdPlistName(spec)),
    stdout: join(homedir(), '.agentistics', `${spec.name}.log`),
    stderr: join(homedir(), '.agentistics', `${spec.name}.err`),
  }
}

/** The sentence naming what the user must still do for a REBOOT to bring this back. */
function bootCaveatText(id: ServiceManagerId, spec: ServiceSpec): string {
  switch (bootCaveat(id)) {
    case 'linger':
      return '' // handled inline: agentop attempts `loginctl enable-linger` and reports the result.
    case 'login-only':
      return 'Note: a launchd USER agent starts when you log in, not at boot. For a service that ' +
        'runs with no one logged in, install it as a LaunchDaemon under /Library/LaunchDaemons ' +
        '(that needs root).'
    case 'pm2-startup':
      return `Note: pm2 does not survive a reboot on its own. Run \`pm2 save\`, then \`pm2 startup\` ` +
        'and execute the command it prints (it needs root once).'
  }
}

export interface AutostartOptions {
  /** Which init system to register with. Defaults to the platform's own; pm2 never by default. */
  manager?: ServiceManagerId
  /** For `central`: the shape it runs as. Decides the command AND the unit type. */
  centralRuntime?: CentralRuntimeId
}

/** Refusal shared by every manager: this box cannot run this mode at all. */
function cannotResolve(mode: AutostartMode): AutostartResult {
  const missing = mode === 'machine' ? 'docker/machine.yml' : 'central.sh'
  return {
    ok: false,
    message: `Cannot enable agentop-${mode} here: ${missing} was not found. ` +
      `That file lives in the repository checkout, so run this from one ` +
      `(the installed binary has nothing to point the service at).`,
  }
}

/** Enables an agentop autostart service for the given mode, on whichever manager fits. */
export async function enableAutostart(mode: AutostartMode, opts: AutostartOptions = {}): Promise<AutostartResult> {
  const facts = await serviceManagerFacts()
  const manager = opts.manager ?? defaultServiceManager(facts)
  if (!manager) return notSupported('enable')
  if (opts.manager && !availableServiceManagers(facts).includes(opts.manager)) {
    return {
      ok: false,
      message: opts.manager === 'pm2'
        ? 'pm2 is not installed — `npm install -g pm2`, then run this again.'
        : `${opts.manager} is not available on this machine (${facts.platform}).`,
    }
  }

  // Refuse before writing anything. A unit whose ExecStart cannot resolve is not a partial
  // success — it is a service the manager retries every few seconds for the life of the machine.
  const spec = serviceSpecFor(mode, opts)
  if (!spec) return cannotResolve(mode)

  switch (manager) {
    case 'systemd': return enableSystemd(mode, spec)
    case 'launchd': return enableLaunchd(spec)
    case 'pm2': return enablePm2(spec)
  }
}

async function enableSystemd(mode: AutostartMode, spec: ServiceSpec): Promise<AutostartResult> {
  const path = unitPath(mode)
  try {
    await mkdir(join(homedir(), '.config', 'systemd', 'user'), { recursive: true })
    await writeFile(path, unitContents(spec), 'utf8')
  } catch (err: any) {
    return { ok: false, message: `Could not write unit file ${path}: ${err?.message ?? err}` }
  }

  const lines: string[] = [`Wrote ${path}`]

  const reload = await run(['systemctl', '--user', 'daemon-reload'])
  if (reload.code !== 0) {
    lines.push(`systemctl --user daemon-reload failed: ${reload.stderr || `exit ${reload.code}`}`)
    return { ok: false, message: lines.join('\n') }
  }

  const enable = await run(['systemctl', '--user', 'enable', '--now', `agentop-${mode}`])
  if (enable.code !== 0) {
    lines.push(`systemctl --user enable --now agentop-${mode} failed: ${enable.stderr || `exit ${enable.code}`}`)
    return { ok: false, message: lines.join('\n') }
  }
  lines.push(`Enabled and started agentop-${mode}.`)

  // Allow the user's services to run at boot without an active login session.
  const linger = await run(['loginctl', 'enable-linger', userInfo().username])
  if (linger.code === 0) {
    lines.push('Enabled linger so it starts at boot without login.')
  } else {
    lines.push(`Note: could not enable linger (${linger.stderr || `exit ${linger.code}`}); ` +
      `the service will start on your next login instead of at boot.`)
  }

  const hook = await installUpdateHook()
  lines.push(hook.message)

  return { ok: true, message: lines.join('\n') }
}

/**
 * macOS: a launchd USER agent under ~/Library/LaunchAgents.
 *
 * `bootstrap gui/<uid>` is the modern verb; `load` is deprecated and silently does nothing on
 * recent macOS for an agent already bootstrapped. Both are attempted, in that order, and a failure
 * of the second is not reported as a failure of the whole — the plist is written either way, and
 * it takes effect at the next login regardless.
 */
async function enableLaunchd(spec: ServiceSpec): Promise<AutostartResult> {
  const paths = launchdPaths(spec)
  try {
    await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
    await mkdir(join(homedir(), '.agentistics'), { recursive: true })
    await writeFile(paths.plist, launchdPlist(spec, { stdoutPath: paths.stdout, stderrPath: paths.stderr }), 'utf8')
  } catch (err: any) {
    return { ok: false, message: `Could not write ${paths.plist}: ${err?.message ?? err}` }
  }

  const lines = [`Wrote ${paths.plist}`]
  const uid = String(process.getuid?.() ?? '')
  const boot = await run(['launchctl', 'bootstrap', `gui/${uid}`, paths.plist])
  if (boot.code === 0) {
    lines.push(`Loaded ${launchdPlistName(spec)} — it starts at every login, and now.`)
  } else {
    const legacy = await run(['launchctl', 'load', '-w', paths.plist])
    lines.push(legacy.code === 0
      ? `Loaded ${launchdPlistName(spec)} — it starts at every login, and now.`
      : `Wrote the agent, but launchctl would not load it now (${boot.stderr || `exit ${boot.code}`}). ` +
        'It still takes effect at your next login.')
  }
  lines.push(`Logs: ${paths.stdout}`)
  lines.push(bootCaveatText('launchd', spec))

  const hook = await installUpdateHook()
  lines.push(hook.message)
  return { ok: true, message: lines.filter(Boolean).join('\n') }
}

/** pm2: explicit opt-in, on any platform that has it. */
async function enablePm2(spec: ServiceSpec): Promise<AutostartResult> {
  const res = await run(pm2StartArgs(spec))
  if (res.code !== 0) {
    return { ok: false, message: `pm2 start failed: ${res.stderr || res.stdout || `exit ${res.code}`}` }
  }
  const lines = [
    `Started ${spec.name} under pm2.`,
    bootCaveatText('pm2', spec),
  ]
  const hook = await installUpdateHook()
  lines.push(hook.message)
  return { ok: true, message: lines.filter(Boolean).join('\n') }
}

/**
 * Options for `disableAutostart`.
 *
 * `stop` is the whole of it, and it exists because the two callers mean genuinely different things.
 * `agentop autostart <mode> disable` has always meant "turn this service off, now and forever", and
 * changing that under people scripting it would be a silent behaviour change. The control center's
 * boot switch means only "do not bring it back", and a switch that also killed the running service
 * would be two actions behind one label — the cockpit has a `Stop` verb for the other one, sitting
 * two cells away on the same row.
 */
export interface DisableOptions {
  /** Also stop it right now (`--now`). Default true, which is what the CLI has always done. */
  stop?: boolean
}

/** Disables and removes an agentop autostart service for the given mode. */
export async function disableAutostart(
  mode: AutostartMode,
  opts: DisableOptions & AutostartOptions = {},
): Promise<AutostartResult> {
  const facts = await serviceManagerFacts()
  const manager = opts.manager ?? defaultServiceManager(facts)
  if (!manager) return notSupported('disable')
  if (manager === 'launchd') return disableLaunchd(mode, opts)
  if (manager === 'pm2') return disablePm2(mode)

  const stop = opts.stop ?? true
  const lines: string[] = []
  const argv = stop
    ? ['systemctl', '--user', 'disable', '--now', `agentop-${mode}`]
    : ['systemctl', '--user', 'disable', `agentop-${mode}`]
  const disable = await run(argv)
  if (disable.code === 0) {
    lines.push(stop
      ? `Disabled and stopped agentop-${mode}.`
      : `Disabled agentop-${mode} — it will not start at boot. Anything running now keeps running.`)
  } else {
    lines.push(`${argv.slice(0, -1).join(' ')} agentop-${mode}: ${disable.stderr || `exit ${disable.code}`}`)
  }

  const path = unitPath(mode)
  try {
    await unlink(path)
    lines.push(`Removed ${path}`)
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      lines.push(`No unit file at ${path}.`)
    } else {
      lines.push(`Could not remove ${path}: ${err?.message ?? err}`)
    }
  }

  await run(['systemctl', '--user', 'daemon-reload'])
  return { ok: true, message: lines.join('\n') }
}

/**
 * The launchd inverse: unload the agent, then remove its plist.
 *
 * `bootout` is the modern verb and `unload` the deprecated one, tried in that order — the same
 * pairing `enableLaunchd` uses, for the same reason. Removing the plist is what makes it not come
 * back; failing to unload only means it keeps running until the next logout, which is stated
 * rather than reported as success.
 */
async function disableLaunchd(mode: AutostartMode, opts: DisableOptions): Promise<AutostartResult> {
  const spec = serviceSpecFor(mode, opts as AutostartOptions)
  // A registration can be removed even when its command no longer resolves (the checkout moved),
  // so fall back to the bare name rather than refusing to clean up.
  const name = spec?.name ?? `agentop-${mode}`
  const plistName = `com.agentistics.${name}.plist`
  const plist = join(homedir(), 'Library', 'LaunchAgents', plistName)
  const lines: string[] = []

  if (opts.stop ?? true) {
    const uid = String(process.getuid?.() ?? '')
    const out = await run(['launchctl', 'bootout', `gui/${uid}/com.agentistics.${name}`])
    if (out.code !== 0) await run(['launchctl', 'unload', '-w', plist])
  }

  try {
    await unlink(plist)
    lines.push(`Removed ${plist} — it will not start at login any more.`)
  } catch (err: any) {
    lines.push(err?.code === 'ENOENT'
      ? `No launchd agent at ${plist}.`
      : `Could not remove ${plist}: ${err?.message ?? err}`)
  }
  return { ok: true, message: lines.join('\n') }
}

/** The pm2 inverse: `pm2 delete`. `pm2 save` is the user's to run — see `bootCaveat`. */
async function disablePm2(mode: AutostartMode): Promise<AutostartResult> {
  const name = `agentop-${mode}`
  const res = await run(pm2DeleteArgs({ name, description: '', command: '', keepsRunning: true }))
  if (res.code !== 0) {
    return { ok: true, message: `pm2 had no process named ${name} (${res.stderr || `exit ${res.code}`}).` }
  }
  return {
    ok: true,
    message: `Deleted ${name} from pm2.\nRun \`pm2 save\` so the removal survives a reboot.`,
  }
}

/**
 * Restarts an agentop mode so it picks up new code (after an upgrade or a local change) or a
 * changed config. Only meaningful when the mode runs as a systemd user service — a foreground
 * `agentop server` has no service to bounce. `central` is redirected to `agentop central restart`
 * (that path rebuilds/restarts the Docker service, which a systemctl bounce can't do).
 */
/** Is `mode` installed as a systemd user unit? The one fact that decides whether a restart goes
 *  through systemd or through the detached process the control center starts. */
export async function unitInstalled(mode: AutostartMode): Promise<boolean> {
  if (platform() !== 'linux') return false
  try {
    await readFile(unitPath(mode), 'utf8')
    return true
  } catch {
    return false
  }
}

export async function restartAutostart(mode: AutostartMode): Promise<AutostartResult> {
  if (platform() !== 'linux') return notSupported('restart')

  if (mode === 'central') {
    return {
      ok: false,
      message:
        'The central runs in Docker, not as a systemd service.\n' +
        'Use `agentop central restart` to bounce it, or `agentop central up` to rebuild it after a code change.',
    }
  }

  // A restart only makes sense when the mode is installed as a service.
  let unitExists = true
  let unitText = ''
  try {
    unitText = await readFile(unitPath(mode), 'utf8')
  } catch {
    unitExists = false
  }
  if (!unitExists) {
    return {
      ok: false,
      message:
        `No agentop-${mode} service is installed, so there is nothing to restart.\n` +
        `Run it in the foreground with \`agentop ${mode}\`, or install autostart first ` +
        `with \`agentop autostart ${mode} enable\`.`,
    }
  }

  // MIGRATE BEFORE BOUNCING, and reload before either. A unit written before `KillMode=process`
  // kills its whole cgroup on stop, which is the fleet — so a restart on the old unit is the very
  // event that loses the sessions, and migrating afterwards would fix the machine one crash too
  // late. `daemon-reload` first means the stop that follows already runs under the new rule, so
  // even THIS restart spares them.
  const notes: string[] = []
  const migrated = migrateUnitKillMode(unitText)
  if (migrated) {
    try {
      await writeFile(unitPath(mode), migrated, 'utf8')
      const reload = await run(['systemctl', '--user', 'daemon-reload'])
      if (reload.code === 0) notes.push('Updated the unit so a restart no longer stops your sessions.')
      else notes.push(`Updated the unit, but systemctl --user daemon-reload failed: ${reload.stderr || `exit ${reload.code}`}`)
    } catch (err: any) {
      notes.push(`Could not update ${unitPath(mode)}: ${err?.message ?? err}`)
    }
  }

  const res = await run(['systemctl', '--user', 'restart', `agentop-${mode}`])
  if (res.code !== 0) {
    return {
      ok: false,
      message: [...notes, `systemctl --user restart agentop-${mode} failed: ${res.stderr || `exit ${res.code}`}`].join('\n'),
    }
  }
  return {
    ok: true,
    message: [...notes, `Restarted agentop-${mode} — it now runs the current code and config.`].join('\n'),
  }
}

/**
 * Reports the enabled/active status of one or all agentop autostart services.
 *
 * It states WHAT each enabled unit runs, and it says the consequence in a sentence. `enabled=enabled,
 * active=inactive` is the exact shape of the bug people report — a central that is not running right
 * now and comes back anyway — and read as two words it looks like nothing is wrong. The unit is the
 * thing that brings it back; the sentence and the `ExecStart` are what make that discoverable
 * without reading systemd's manual.
 */
export async function autostartStatus(mode?: AutostartMode): Promise<AutostartResult> {
  if (platform() !== 'linux') return notSupported('status')

  const targets = mode ? [mode] : MODES
  const lines: string[] = []
  for (const m of targets) {
    const enabled = await run(['systemctl', '--user', 'is-enabled', `agentop-${m}`])
    const active = await run(['systemctl', '--user', 'is-active', `agentop-${m}`])
    // systemctl prints the state to stdout even on non-zero exit.
    const enabledState = enabled.stdout || enabled.stderr || 'unknown'
    const activeState = active.stdout || active.stderr || 'unknown'
    lines.push(`${unitName(m)}: enabled=${enabledState}, active=${activeState}`)
    // Only for a unit that is actually registered: reading the ExecStart of a unit that does not
    // exist would print an empty promise about a mechanism that is not installed.
    if (enabledState.startsWith('enabled') || enabledState.startsWith('linked')) {
      const exec = await run(['systemctl', '--user', 'show', `agentop-${m}`, '-p', 'ExecStart', '--value'])
      const cmd = exec.stdout.match(/argv\[\]=([^;]+);/)?.[1]?.trim()
      lines.push(`  → comes back at boot${cmd ? `, running: ${cmd}` : ''}`)
      lines.push(`  → \`agentop autostart ${m} disable\` removes it`)
    }
  }
  return { ok: true, message: lines.join('\n') }
}

/** Type guard used by the cli to validate the user-supplied mode. */
export function isAutostartMode(value: string): value is AutostartMode {
  return (MODES as string[]).includes(value)
}
