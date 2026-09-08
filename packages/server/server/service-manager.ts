/**
 * service-manager.ts — PURE: which init system can keep an agentop mode running on THIS box, and
 * the exact file (or argv) each one needs.
 *
 * `autostart.ts` was systemd-only and said so honestly, printing a paragraph of manual steps on
 * macOS and Windows. The paragraph is the problem: the docs carried launchd and pm2 recipes that
 * a user had to transcribe by hand, which means the product knew the answer and made someone else
 * type it. This module holds those recipes as data so `agentop autostart <mode> enable` can write
 * them, and so the docs can point at one implementation instead of repeating a plist.
 *
 * The rule that made this worth extracting, though, is not portability — it is `keepsRunning`.
 *
 * A service command is one of two shapes, and confusing them produces a unit that looks installed
 * and is wrong. `agentop server` runs in the FOREGROUND: the process is the service, and systemd's
 * `Type=simple` is correct. `docker compose up -d` and `central.sh up` RETURN once the container is
 * up: under `Type=simple` systemd watches the wrapper exit, marks the unit inactive(dead) within a
 * second, and every later `is-active` answers `inactive` for a central that is serving traffic
 * perfectly well. `Type=oneshot` + `RemainAfterExit=yes` is what states "the command finishing is
 * the service starting". Same distinction drives pm2's `--no-autorestart`: without it pm2 re-runs
 * `docker compose up -d` in a loop forever.
 *
 * Nothing here touches the filesystem, `process`, or the network — facts in, file contents out.
 */

import { servicePath } from './sessions/service-path'

/** An init system this product can register a mode with. */
export type ServiceManagerId = 'systemd' | 'launchd' | 'pm2'

/** Stable order for every surface that lists them: the platform's own first, pm2 last. */
export const SERVICE_MANAGERS: readonly ServiceManagerId[] = ['systemd', 'launchd', 'pm2']

/** Why a manager cannot be used here. Codes, not sentences — the CLI's i18n renders them. */
export type ServiceManagerBlock = 'wrong-platform' | 'not-installed'

export interface ServiceManagerFacts {
  /** `process.platform`. */
  platform: string
  /** `systemctl` is on PATH. */
  systemctl: boolean
  /** `launchctl` is on PATH. */
  launchctl: boolean
  /** `pm2` is on PATH. */
  pm2: boolean
}

export interface ServiceManagerOption {
  id: ServiceManagerId
  available: boolean
  reason?: ServiceManagerBlock
}

function blockFor(id: ServiceManagerId, facts: ServiceManagerFacts): ServiceManagerBlock | null {
  switch (id) {
    case 'systemd':
      if (facts.platform !== 'linux') return 'wrong-platform'
      return facts.systemctl ? null : 'not-installed'
    case 'launchd':
      if (facts.platform !== 'darwin') return 'wrong-platform'
      return facts.launchctl ? null : 'not-installed'
    case 'pm2':
      // Deliberately platform-free: pm2 is the answer for a host whose init system this product
      // does not speak (a container, a BSD, a Windows box with pm2 installed), which is exactly
      // the case where refusing on platform would leave the user with nothing.
      return facts.pm2 ? null : 'not-installed'
  }
}

/** Every manager, in `SERVICE_MANAGERS` order, each with whether it works here and why not. */
export function serviceManagerOptions(facts: ServiceManagerFacts): ServiceManagerOption[] {
  return SERVICE_MANAGERS.map(id => {
    const reason = blockFor(id, facts)
    return reason ? { id, available: false, reason } : { id, available: true }
  })
}

export function availableServiceManagers(facts: ServiceManagerFacts): ServiceManagerId[] {
  return serviceManagerOptions(facts).filter(o => o.available).map(o => o.id)
}

/**
 * The one to use when the user did not say: the platform's native manager, pm2 only as a
 * fallback.
 *
 * pm2 never wins by default even when installed. It is a process manager a user chose for their
 * own apps, and quietly filing agentop into someone's pm2 list — where it then appears in every
 * `pm2 ls` and gets caught by their `pm2 restart all` — is a decision that belongs to them.
 */
export function defaultServiceManager(facts: ServiceManagerFacts): ServiceManagerId | null {
  const available = availableServiceManagers(facts)
  if (available.includes('systemd')) return 'systemd'
  if (available.includes('launchd')) return 'launchd'
  return available.includes('pm2') ? 'pm2' : null
}

// ---------------------------------------------------------------------------
// What a service IS
// ---------------------------------------------------------------------------

/**
 * One registration, described in the terms every manager needs.
 *
 * `keepsRunning` is the field this module exists for — see the header. It is a property of the
 * COMMAND, not of the mode: a central started natively holds the terminal while the same central
 * started through Docker returns, so the same `agentop autostart central enable` produces
 * different unit types depending on the runtime the central was configured with.
 */
export interface ServiceSpec {
  /** Unit / label / pm2 process name, e.g. `agentop-central`. */
  name: string
  /** One line for a human, e.g. "agentop central (agentistics autostart)". */
  description: string
  /** The command, already resolved to absolute paths. */
  command: string
  /** True when the command stays in the foreground for as long as the service runs. */
  keepsRunning: boolean
}

/**
 * A systemd USER unit (no root, ever).
 *
 * `Restart=on-failure` is only meaningful for a long-running command; on a oneshot it would re-run
 * `docker compose up -d` after a failed pull, which is a retry loop with no backoff against a
 * registry. The one-shot form leaves restarting to Docker's own `restart: unless-stopped`, which
 * is what actually keeps those containers up.
 */
export function systemdUnit(spec: ServiceSpec, callerPath?: string): string {
  const lines = [
    '[Unit]',
    `Description=${spec.description}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
  ]
  // THE PATH THE HARNESSES LIVE ON. A user service inherits systemd's minimal PATH, and every
  // coding assistant is installed in a per-user bin directory outside it — so without this the
  // server cannot spawn a single one, and every reopen answers `ok` while its pane dies at once.
  // See `sessions/service-path.ts` for the measurement, and for why it is the INSTALLING SHELL's
  // PATH rather than a list of directories guessed here.
  const path = servicePath(callerPath ?? process.env.PATH)
  if (path) {
    lines.push("# systemd's own PATH reaches none of the per-user bin directories the coding")
    lines.push('# assistants are installed in — see sessions/service-path.ts.')
    lines.push(`Environment=PATH=${path}`)
  }
  if (spec.keepsRunning) {
    lines.push('Type=simple', `ExecStart=${spec.command}`, 'Restart=on-failure', 'RestartSec=5')
  } else {
    // The command RETURNS once the thing it started is up. Without RemainAfterExit the unit is
    // inactive(dead) a second after a perfectly successful start, and every status readout lies.
    lines.push('Type=oneshot', 'RemainAfterExit=yes', `ExecStart=${spec.command}`)
  }
  lines.push('', '[Install]', 'WantedBy=default.target', '')
  return lines.join('\n')
}

/** Reverse-DNS label for a launchd agent, e.g. `com.agentistics.agentop-central`. */
export function launchdLabel(spec: ServiceSpec): string {
  return `com.agentistics.${spec.name}`
}

/** XML-escape a string for a plist `<string>` value. */
function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * A launchd USER agent (`~/Library/LaunchAgents`), the macOS equivalent of the systemd user unit.
 *
 * The command is run through `/bin/sh -c` rather than split into argv. It is composed here from
 * absolute paths and a fixed set of subcommands — never from user input — and the alternative is
 * this module growing a shell tokenizer to take `docker compose -f … up -d` apart, which is more
 * ways to be wrong than it removes.
 *
 * `KeepAlive` follows `keepsRunning` for the same reason `Type` does on systemd: a plist with
 * `KeepAlive` over `docker compose up -d` relaunches it every time it succeeds.
 */
export function launchdPlist(spec: ServiceSpec, opts: { stdoutPath: string; stderrPath: string }): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xml(launchdLabel(spec))}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/sh</string>',
    '    <string>-c</string>',
    `    <string>${xml(spec.command)}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    spec.keepsRunning ? '  <true/>' : '  <false/>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(opts.stdoutPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(opts.stderrPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

/** The relative path of a launchd agent's plist, under the user's home. */
export function launchdPlistName(spec: ServiceSpec): string {
  return `${launchdLabel(spec)}.plist`
}

/**
 * The `pm2 start` argv for a spec.
 *
 * `--no-autorestart` on a returning command is the same correction as `Type=oneshot`: pm2's whole
 * model is "the process died, start it again", which over `docker compose up -d` is an infinite
 * loop that also masks a failing pull as activity.
 */
export function pm2StartArgs(spec: ServiceSpec): string[] {
  const args = ['pm2', 'start', spec.command, '--name', spec.name]
  if (!spec.keepsRunning) args.push('--no-autorestart')
  return args
}

/** The `pm2 delete` argv — the exact inverse of `pm2StartArgs`. */
export function pm2DeleteArgs(spec: ServiceSpec): string[] {
  return ['pm2', 'delete', spec.name]
}

/**
 * What the user still has to do themselves, per manager, for the registration to survive a REBOOT.
 *
 * Enabling a service and making it come back after a power cycle are different acts on every one
 * of these, and each has a step this product cannot take for the user: systemd needs
 * `loginctl enable-linger` (agentop attempts it and reports when it could not), launchd user
 * agents only start at LOGIN and never before it, and pm2 needs `pm2 save` plus the root command
 * `pm2 startup` prints. Saying so is the difference between a service that comes back and a user
 * who believes one will.
 */
export function bootCaveat(id: ServiceManagerId): 'linger' | 'login-only' | 'pm2-startup' {
  switch (id) {
    case 'systemd': return 'linger'
    case 'launchd': return 'login-only'
    case 'pm2': return 'pm2-startup'
  }
}
