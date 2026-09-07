import { rename, chmod, unlink, rm } from 'fs/promises'
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { platform } from 'os'
import { basename, dirname, join } from 'path'
import { getVersionInfo, CURRENT_VERSION, compareVersions } from './version.ts'
import { restartAutostart } from './autostart.ts'
import { AGENTISTICS_DATA_DIR } from './config.ts'
import { cliStrings, type CliLang, type CliStrings } from './cli-i18n.ts'

const GITHUB_REPO = 'blpsoares/agentistics'
/**
 * Where a release asset lives, addressed BY VERSION.
 *
 * It used to be `.../releases/latest/download`, which resolves through GitHub's rolling "Latest"
 * FLAG rather than through the version this command just resolved and printed. Those are different
 * things: the flag moves to whichever release GitHub considers latest, and a release that takes it
 * without publishing the `agentop` asset makes the download 404 — while the announced version's
 * binary sits there, present and unreachable.
 *
 * Measured on the real repo (linux/x64, 2026-09-02): the flag-addressed URL answered **404** while
 * `.../releases/download/v2.5.0/agentop` answered **206**. The command printed "Latest: v2.5.0" and
 * then failed to download v2.5.0 — the one thing an upgrade must never do is announce a version it
 * is not fetching.
 */
function releaseAssetUrl(version: string, asset: string): string {
  // The tag is `v<version>`; `version` arrives from the releases API without the prefix.
  return `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${asset}`
}
/** Where a user goes when self-install is refused (unsupported platform/arch). */
export const RELEASES_PAGE = `https://github.com/${GITHUB_REPO}/releases`

const _ESC = '\x1b'
const _R  = `${_ESC}[0m`
const _B  = `${_ESC}[1m`
const _GR = `${_ESC}[92m`
const _WH = `${_ESC}[97m`
const _D  = `${_ESC}[2m`
const _Y  = `${_ESC}[33m`
const _RD = `${_ESC}[91m`

// central.sh sets PROJECT=${PROJECT:-team-mode}; docker/machine.yml builds `agentistics-machine`.
const CENTRAL_PROJECT = 'team-mode'
const MACHINE_IMAGE = 'agentistics-machine'

// ---------------------------------------------------------------------------
// Platform/arch gate
//
// The release workflow (.github/workflows/release.yml) compiles exactly TWO assets:
//   • `agentop`      — `bun build --compile` on ubuntu-latest        → Linux x86_64 ELF
//   • `agentop.exe`  — `--target=bun-windows-x64`                    → Windows x86_64 PE
// There is no macOS asset and no arm64 asset. Downloading `agentop` on an arm64 Linux box
// (Raspberry Pi, Ampere VM) or on macOS replaces a WORKING binary with an ELF the kernel
// cannot exec — and the upgrade then restarts the user's services onto it. So the gate is
// an allowlist of the combinations the workflow actually publishes; everything else is
// refused before a single byte is downloaded.
// ---------------------------------------------------------------------------

export interface UpgradeTarget {
  /** Release asset name, as published by the workflow. */
  asset: string
  /** Full download URL for that asset. */
  url: string
}

/**
 * Pure: the asset for a platform/arch pair at a GIVEN VERSION, or null when self-install is not
 * supported there.
 *
 * `version` is required rather than optional. An optional one would default to the rolling flag
 * for any caller that forgot it, which is the defect this signature exists to make impossible —
 * and both callers (the manual command and the unattended path) already hold the version they
 * resolved.
 */
export function resolveUpgradeAsset(platformId: string, arch: string, version: string): UpgradeTarget | null {
  const key = `${platformId}/${arch}`
  if (key === 'linux/x64') return { asset: 'agentop', url: releaseAssetUrl(version, 'agentop') }
  if (key === 'win32/x64') return { asset: 'agentop.exe', url: releaseAssetUrl(version, 'agentop.exe') }
  return null
}

// ---------------------------------------------------------------------------
// Download verification
// ---------------------------------------------------------------------------

/** The compiled Bun binary is >100 MB; anything this small is an error page, a truncated
 *  transfer or an LFS/redirect stub — never a usable agentop. */
export const MIN_BINARY_BYTES = 4 * 1024 * 1024

/** Pure: does the payload start with the executable magic for this platform? */
export function looksLikeExecutable(head: Uint8Array, platformId: string): boolean {
  if (platformId === 'win32') return head[0] === 0x4d && head[1] === 0x5a // "MZ"
  // 0x7F 'E' 'L' 'F'
  return head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46
}

/** Pure: gate on the bytes BEFORE they can ever replace a working binary. */
export function verifyDownload(
  bytes: Uint8Array,
  platformId: string,
  minBytes: number = MIN_BINARY_BYTES,
): { ok: true } | { ok: false; reason: string } {
  if (bytes.length < minBytes) {
    return { ok: false, reason: `downloaded file is only ${bytes.length} bytes (expected > ${minBytes})` }
  }
  if (!looksLikeExecutable(bytes.subarray(0, 4), platformId)) {
    return { ok: false, reason: `downloaded file is not an executable for ${platformId}` }
  }
  return { ok: true }
}

/**
 * Pure: does `agentop --version` output prove this binary is the release we expect?
 *
 * `>=` rather than `===`, and the reason CHANGED when the download URL stopped going through
 * GitHub's rolling "Latest" flag: it used to be that the flag could legitimately be one bump ahead
 * of the releases API. A version-addressed URL cannot be ahead of the version it names, so `>=` is
 * now only a tolerance — an asset republished under its own tag after a rebuild still passes. An
 * OLDER (or unparseable) version still means we downloaded the wrong thing and must not install
 * it, which is the check that actually matters.
 */
export function checkBinaryVersionOutput(
  out: string,
  expected: string,
): { ok: boolean; found: string | null } {
  const m = out.match(/agentop\s+v(\d+\.\d+\.\d+)/i)
  const found = m?.[1] ?? null
  return { ok: !!found && compareVersions(found, expected) >= 0, found }
}

/** Pure: unique temp path NEXT TO the target (same filesystem → rename is atomic), keeping the
 *  extension so Windows can still exec it. Unique per attempt so a hand-run `agentop upgrade`
 *  and the background one can never write the same file. */
export function tempBinaryPath(currentBin: string, unique: string): string {
  const dir = dirname(currentBin)
  const base = basename(currentBin)
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot) : ''
  const stem = dot > 0 ? base.slice(0, dot) : base
  return join(dir, `.${stem}.new-${unique}${ext}`)
}

/** Pure: where the replaced binary is kept so a failed install can be rolled back. */
export function backupBinaryPath(currentBin: string): string {
  return `${currentBin}.bak`
}

// ---------------------------------------------------------------------------
// Failure memory + backoff
//
// A critical update that can never succeed here (no write permission, unsupported arch, a
// 404 asset, a full disk) used to re-download ~140 MB on every shell that opened, forever.
// Failures are persisted with an attempt counter and retried on a widening schedule; any
// successful upgrade — or a NEW target version — clears the state.
// ---------------------------------------------------------------------------

export const UPGRADE_FAILURE_FILE = join(AGENTISTICS_DATA_DIR, 'upgrade-failure.json')
/** Backoff per consecutive failure: 30 min → 2 h → 8 h → 24 h (capped). */
export const UPGRADE_BACKOFF_STEPS_MS = [30 * 60_000, 2 * 60 * 60_000, 8 * 60 * 60_000, 24 * 60 * 60_000]

export interface UpgradeFailure {
  /** Target version that failed. */
  version: string
  failedAt: number
  attempts: number
  reason: string
}

/** Pure: how long to wait after `attempts` consecutive failures. */
export function upgradeBackoffMs(attempts: number): number {
  const idx = Math.min(Math.max(attempts, 1), UPGRADE_BACKOFF_STEPS_MS.length) - 1
  return UPGRADE_BACKOFF_STEPS_MS[idx]!
}

/** Pure: parse the persisted failure state. Junk → null (treated as "no failures"). */
export function parseUpgradeFailure(raw: string): UpgradeFailure | null {
  try {
    const o = JSON.parse(raw) as Partial<UpgradeFailure>
    if (!o || typeof o.version !== 'string' || !o.version) return null
    if (typeof o.failedAt !== 'number' || !Number.isFinite(o.failedAt)) return null
    const attempts = typeof o.attempts === 'number' && Number.isFinite(o.attempts) && o.attempts > 0
      ? Math.floor(o.attempts)
      : 1
    return { version: o.version, failedAt: o.failedAt, attempts, reason: typeof o.reason === 'string' ? o.reason : '' }
  } catch {
    return null
  }
}

/** Pure: next state after a failure — consecutive only while the target version is the same. */
export function nextUpgradeFailure(
  prev: UpgradeFailure | null,
  version: string,
  now: number,
  reason: string,
): UpgradeFailure {
  const attempts = prev && prev.version === version ? prev.attempts + 1 : 1
  return { version, failedAt: now, attempts, reason }
}

/**
 * Pure: may an UNATTENDED upgrade to `version` run now? A different target version always
 * gets a fresh chance (the new release may well fix what failed). A hand-run
 * `agentop upgrade` never consults this — the user asked explicitly.
 */
export function shouldAttemptUpgrade(
  state: UpgradeFailure | null,
  version: string,
  now: number,
): boolean {
  if (!state || state.version !== version) return true
  return now - state.failedAt >= upgradeBackoffMs(state.attempts)
}

/** Reads the persisted failure state. Never throws. */
export function readUpgradeFailure(): UpgradeFailure | null {
  try {
    return parseUpgradeFailure(readFileSync(UPGRADE_FAILURE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function recordUpgradeFailure(version: string, reason: string): void {
  try {
    mkdirSync(AGENTISTICS_DATA_DIR, { recursive: true })
    const next = nextUpgradeFailure(readUpgradeFailure(), version, Date.now(), reason)
    writeFileSync(UPGRADE_FAILURE_FILE, JSON.stringify(next))
  } catch { /* best-effort */ }
}

function clearUpgradeFailure(): void {
  try { unlinkSync(UPGRADE_FAILURE_FILE) } catch { /* nothing recorded */ }
}

/** Run a command, capturing trimmed stdout (stderr discarded). Never throws. */
async function sh(cmd: string[]): Promise<{ code: number; out: string }> {
  try {
    const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' })
    const out = (await new Response(p.stdout).text()).trim()
    const code = await p.exited
    return { code, out }
  } catch {
    return { code: 1, out: '' }
  }
}

/** Run a command with inherited stdio so the user sees progress (docker pull/up, etc.). */
async function shInherit(cmd: string[]): Promise<number> {
  try {
    const p = Bun.spawn(cmd, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
    return await p.exited
  } catch {
    return 1
  }
}

async function dockerRunning(filter: string): Promise<boolean> {
  const r = await sh(['docker', 'ps', '-q', '-f', filter])
  return r.out.split(/\s+/).filter(Boolean).length > 0
}

/**
 * Runs `<bin> --version` and returns its stdout ('' when it can't run). Killed after
 * `timeoutMs` so a hung/incompatible binary can't wedge the upgrade.
 *
 * AGENTISTICS_NO_UPDATE_CHECK=1 keeps the probe offline: `agentop --version` otherwise does a
 * GitHub round-trip, which would make every install wait on the network.
 */
async function probeBinaryVersion(bin: string, timeoutMs = 20_000): Promise<string> {
  try {
    const p = Bun.spawn([bin, '--version'], {
      stdout: 'pipe',
      stderr: 'ignore',
      env: { ...process.env, AGENTISTICS_NO_UPDATE_CHECK: '1' },
    })
    const timer = setTimeout(() => { try { p.kill() } catch { /* already gone */ } }, timeoutMs)
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    clearTimeout(timer)
    return code === 0 ? out : ''
  } catch {
    return ''
  }
}

export type RestartOutcome = { ok: boolean; failures: string[] }

/**
 * After the new binary is in place, bounce whatever is actually running so it runs the new
 * version — the whole point of `upgrade` is that the user doesn't have to restart by hand.
 *
 * Self-restart is safe: `agentop upgrade` runs as a foreground CLI, a *separate* process from
 * the systemd user service or Docker container it restarts, so restarting those never kills
 * this process. `systemctl --user restart` is handled out-of-process by systemd, and the
 * central/machine live in their own containers.
 *
 * Every step's result is CHECKED and collected: a swallowed restart failure leaves the user
 * on the old code while the CLI claims success — exactly the case where a critical update
 * silently did not take effect.
 *
 * @param newBin path to the just-installed binary — the central/machine restart is driven by
 *   THIS binary so the image tag matches the version we just installed (the running process
 *   still carries the old version number).
 */
async function restartRunningServices(newBin: string): Promise<RestartOutcome> {
  let didSomething = false
  const failures: string[] = []

  // 1) Native systemd user services: solo/member run as `agentop server`; `agentop watch` is the
  //    OTel daemon. Restart only the ones that are actually active so we never start a stopped one.
  if (platform() === 'linux') {
    for (const mode of ['server', 'watch'] as const) {
      const active = await sh(['systemctl', '--user', 'is-active', `agentop-${mode}`])
      if (active.out === 'active') {
        process.stdout.write(`  Restarting the agentop-${mode} service…\n`)
        const res = await restartAutostart(mode)
        process.stdout.write(`    ${res.message.split('\n')[0]}\n`)
        if (!res.ok) failures.push(`agentop-${mode} service: ${res.message.split('\n')[0]}`)
        didSomething = true
      }
    }
  }

  // 2) Central (Docker): pull the new version-tagged image and recreate. Driven through the NEW
  //    binary so `agentop central` resolves the image tag to the version we just installed.
  if (await dockerRunning(`label=com.docker.compose.project=${CENTRAL_PROJECT}`)) {
    process.stdout.write('  Updating the central (Docker): pulling the new image and recreating…\n')
    const pull = await shInherit([newBin, 'central', 'pull'])
    if (pull !== 0) failures.push(`central: \`agentop central pull\` exited ${pull}`)
    const up = await shInherit([newBin, 'central', 'up'])
    if (up !== 0) failures.push(`central: \`agentop central up\` exited ${up}`)
    didSomething = true
  }

  // 3) Machine-in-Docker: recreate. The machine image is built from a repo checkout
  //    (docker/machine.yml), so this only applies when that compose is reachable —
  //    and when it isn't, the container KEEPS RUNNING THE OLD VERSION, which is a failure,
  //    not a footnote.
  if (await dockerRunning(`ancestor=${MACHINE_IMAGE}`)) {
    const compose = join(process.cwd(), 'docker', 'machine.yml')
    if (await Bun.file(compose).exists()) {
      process.stdout.write('  Recreating the machine container (Docker)…\n')
      const code = await shInherit(['docker', 'compose', '-f', compose, 'up', '-d', '--build'])
      if (code !== 0) failures.push(`machine container: \`docker compose up -d --build\` exited ${code}`)
      didSomething = true
    } else {
      failures.push(
        'machine container: docker/machine.yml not found here — it still runs the old version ' +
        '(re-run `agentop start` from the repo)',
      )
    }
  }

  if (!didSomething && failures.length === 0) {
    process.stdout.write(
      `  ${_D}No managed services detected running. If agentop is running in the foreground, ` +
      `restart it to apply.${_R}\n`,
    )
  }

  return { ok: failures.length === 0, failures }
}

// ---------------------------------------------------------------------------
// Unattended (critical) upgrade — lock + detached spawn
//
// `agentop check-update` runs from a shell rc hook on every terminal open. When the
// newest release is flagged critical it installs the update WITHOUT asking, but it
// must never hold the user's terminal — so it spawns a detached `agentop upgrade`,
// logs to a file and returns immediately. Two terminals opening at once would race,
// hence the lock file below. The lock is held for the WHOLE install (runUpgrade takes
// it too), so a hand-run `agentop upgrade` can never interleave with the background one.
// ---------------------------------------------------------------------------

/** Guards concurrent upgrades. Holds the pid of the running upgrade. */
export const UPGRADE_LOCK_FILE = join(AGENTISTICS_DATA_DIR, 'upgrade.lock')
/** Where the detached upgrade's output goes (the terminal gets nothing). */
export const AUTO_UPGRADE_LOG = join(AGENTISTICS_DATA_DIR, 'auto-upgrade.log')
/** A lock older than this is treated as abandoned (crash / killed -9 / pid reuse). */
export const UPGRADE_LOCK_TTL_MS = 30 * 60 * 1000
/** Set on the detached child so it ADOPTS the lock its spawner already took instead of
 *  seeing it as somebody else's and refusing to run. */
export const UPGRADE_LOCK_ENV = 'AGENTISTICS_UPGRADE_LOCK'

export interface UpgradeLock {
  pid: number
  version: string
  startedAt: number
}

/** Pure: parse a lock file's contents. Returns null for junk/truncated content. */
export function parseUpgradeLock(raw: string): UpgradeLock | null {
  try {
    const o = JSON.parse(raw) as Partial<UpgradeLock>
    if (!o || typeof o.pid !== 'number' || !Number.isFinite(o.pid) || o.pid <= 0) return null
    return {
      pid: o.pid,
      version: typeof o.version === 'string' ? o.version : '',
      startedAt: typeof o.startedAt === 'number' && Number.isFinite(o.startedAt) ? o.startedAt : 0,
    }
  } catch {
    return null
  }
}

/**
 * Pure: is an existing lock still held? A lock counts as active only while its process
 * is alive AND it is younger than the TTL — so a crashed upgrade can never wedge the
 * mechanism permanently, and a reused pid can't keep it alive forever either.
 */
export function isUpgradeLockActive(
  lock: UpgradeLock | null,
  now: number,
  isPidAlive: (pid: number) => boolean,
  ttlMs: number = UPGRADE_LOCK_TTL_MS,
): boolean {
  if (!lock) return false
  if (now - lock.startedAt >= ttlMs) return false
  return isPidAlive(lock.pid)
}

/** signal 0 probes liveness without delivering anything. EPERM = alive but not ours. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

const lockPayload = (pid: number, version: string) => JSON.stringify({ pid, version, startedAt: Date.now() })

export type LockResult =
  | { state: 'acquired' | 'adopted' | 'unavailable' }
  | { state: 'busy'; pid: number }

/**
 * Takes the upgrade lock for THIS process.
 *
 * `adopt` (the detached child, via UPGRADE_LOCK_ENV) re-stamps the lock with its own pid
 * unconditionally: the lock is already ours, taken by the spawner on our behalf.
 * Otherwise the lock is created with the exclusive `wx` flag (atomic), so of two racing
 * processes exactly one wins; a stale lock (dead pid or past the TTL) is taken over.
 *
 * `unavailable` means the lock file itself could not be written (read-only HOME): the caller
 * proceeds unlocked rather than refusing to ever upgrade.
 */
export function acquireUpgradeLock(version: string, adopt: boolean): LockResult {
  try {
    mkdirSync(AGENTISTICS_DATA_DIR, { recursive: true })
    if (adopt) {
      writeFileSync(UPGRADE_LOCK_FILE, lockPayload(process.pid, version))
      return { state: 'adopted' }
    }
    try {
      writeFileSync(UPGRADE_LOCK_FILE, lockPayload(process.pid, version), { flag: 'wx' })
      return { state: 'acquired' }
    } catch (err: any) {
      if (err?.code !== 'EEXIST') return { state: 'unavailable' }
      let existing: UpgradeLock | null = null
      try { existing = parseUpgradeLock(readFileSync(UPGRADE_LOCK_FILE, 'utf8')) } catch { /* unreadable → stale */ }
      if (isUpgradeLockActive(existing, Date.now(), pidAlive)) return { state: 'busy', pid: existing!.pid }
      writeFileSync(UPGRADE_LOCK_FILE, lockPayload(process.pid, version))
      return { state: 'acquired' }
    }
  } catch {
    return { state: 'unavailable' }
  }
}

/** Re-stamps the held lock with the version we resolved (informational only). */
function stampUpgradeLock(version: string): void {
  try { writeFileSync(UPGRADE_LOCK_FILE, lockPayload(process.pid, version)) } catch { /* best-effort */ }
}

export type BackgroundUpgradeResult =
  | 'started'
  | 'in-progress'
  | 'not-installed'
  | 'unsupported'
  | 'backoff'
  | 'failed'

/**
 * Pure: is this process the installed `agentop` binary (as opposed to `bun bin/cli.ts` in a
 * source checkout)? runUpgrade replaces process.execPath — from a checkout that path is the
 * BUN runtime itself, so an unattended upgrade there would clobber the user's bun install.
 * Auto-install is therefore restricted to the compiled binary; source checkouts get the
 * normal banner and can still run `agentop upgrade` deliberately.
 */
export function isInstalledBinary(execPath: string, scriptPath: string | undefined): boolean {
  if (scriptPath && (scriptPath.endsWith('.ts') || scriptPath.endsWith('.js'))) return false
  const base = (execPath.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '')
  return base !== 'bun' && base !== 'node'
}

/**
 * Starts `agentop upgrade` as a DETACHED background process and returns immediately —
 * the caller's terminal is never held. Output is appended to AUTO_UPGRADE_LOG.
 *
 * Refuses (without downloading anything) when self-install is unsupported on this
 * platform/arch, and when the same version already failed recently (backoff).
 */
export async function startBackgroundUpgrade(version: string): Promise<BackgroundUpgradeResult> {
  // Never self-install over a dev checkout's runtime — see isInstalledBinary.
  if (!isInstalledBinary(process.execPath, process.argv[1])) return 'not-installed'
  // No published asset for this platform/arch → an unattended install would brick it. The version
  // is threaded through here too, not just on the manual path: `runUpgrade` is what actually
  // downloads, and both share it, so a gate that resolved a different URL from the one about to be
  // fetched would be checking the wrong thing.
  if (!resolveUpgradeAsset(process.platform, process.arch, version)) return 'unsupported'
  // A previously failing target backs off instead of re-downloading on every shell.
  if (!shouldAttemptUpgrade(readUpgradeFailure(), version, Date.now())) return 'backoff'

  const lock = acquireUpgradeLock(version, false)
  if (lock.state === 'busy') return 'in-progress'
  if (lock.state === 'unavailable') return 'failed'

  try {
    // Guaranteed by isInstalledBinary above: execPath IS agentop, so it takes the
    // subcommand directly (no script argument to forward).
    appendFileSync(AUTO_UPGRADE_LOG, `\n=== ${new Date().toISOString()} — auto-installing v${version} ===\n`)
    const fd = openSync(AUTO_UPGRADE_LOG, 'a')
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, ['upgrade'], {
      detached: true,
      stdio: ['ignore', fd, fd],
      // The child adopts this lock instead of colliding with it.
      env: { ...process.env, [UPGRADE_LOCK_ENV]: '1' },
    })
    // Detach fully: a new process group + unref so this process can exit right now.
    child.unref()
    try { closeSync(fd) } catch { /* the child kept its own dup */ }
    // Re-stamp the lock with the pid that actually does the work, so liveness tracks it.
    if (child.pid) writeFileSync(UPGRADE_LOCK_FILE, lockPayload(child.pid, version))
    return 'started'
  } catch {
    try { unlinkSync(UPGRADE_LOCK_FILE) } catch { /* nothing to release */ }
    return 'failed'
  }
}

/**
 * Releases the lock on exit when THIS process owns it. Registered by runUpgrade so every
 * exit path (success, `process.exit(1)`, throw) frees the lock without extra bookkeeping.
 */
function armUpgradeLockRelease(): void {
  process.on('exit', () => {
    try {
      const lock = parseUpgradeLock(readFileSync(UPGRADE_LOCK_FILE, 'utf8'))
      if (lock?.pid === process.pid) unlinkSync(UPGRADE_LOCK_FILE)
    } catch { /* no lock (unwritable HOME) or already gone */ }
  })
}

interface InstallOutcome {
  ok: boolean
  /** Machine-readable failure cause, recorded for the backoff state. */
  reason?: string
  /** Set when the failure was a permission problem — the download is left here for `sudo mv`. */
  keptTmp?: string
  /** Set when the previous binary was restored after a failed install. */
  rolledBack?: boolean
  /** Where the replaced binary was kept on success. */
  backup?: string
}

/**
 * Verify → stage → back up → swap → re-verify. The live binary is only ever replaced by a
 * file we have already RUN successfully, and the file it replaces is kept so any failure
 * (including one only visible after the swap) can be undone.
 */
async function installDownloadedBinary(
  bytes: Uint8Array,
  currentBin: string,
  expected: string,
  s: CliStrings,
): Promise<InstallOutcome> {
  // 1) Bytes must look like an executable for THIS platform before they touch the disk.
  const verified = verifyDownload(bytes, process.platform)
  if (!verified.ok) return { ok: false, reason: verified.reason }

  // 2) Stage next to the target under a name nobody else can pick (same dir → atomic rename).
  const tmpPath = tempBinaryPath(currentBin, `${process.pid}-${randomBytes(6).toString('hex')}`)
  try {
    await Bun.write(tmpPath, bytes)
    if (process.platform !== 'win32') await chmod(tmpPath, 0o755)
  } catch (err: any) {
    await unlink(tmpPath).catch(() => {})
    return { ok: false, reason: `could not write ${tmpPath}: ${err?.message ?? String(err)}` }
  }

  // 3) The strongest cheap check there is: run it and make it identify itself.
  process.stdout.write(`${s.upgradeVerifying}\n`)
  const probe = checkBinaryVersionOutput(await probeBinaryVersion(tmpPath), expected)
  if (!probe.ok) {
    await unlink(tmpPath).catch(() => {})
    return {
      ok: false,
      reason: probe.found
        ? `downloaded binary reports v${probe.found}, expected v${expected}`
        : 'downloaded binary did not run (`--version` produced nothing usable)',
    }
  }

  // 4) Move the working binary aside FIRST — that is the rollback copy, and on Windows it is
  //    also the only way to replace a running executable.
  const backup = backupBinaryPath(currentBin)
  try {
    await rm(backup, { force: true })
    await rename(currentBin, backup)
  } catch (err: any) {
    if (err?.code === 'EACCES' || err?.code === 'EPERM') {
      return { ok: false, reason: 'permission denied', keptTmp: tmpPath }
    }
    await unlink(tmpPath).catch(() => {})
    return { ok: false, reason: `could not back up the current binary: ${err?.message ?? String(err)}` }
  }

  // 5) Swap in the verified file; anything going wrong here restores the backup.
  try {
    await rename(tmpPath, currentBin)
  } catch (err: any) {
    await rename(backup, currentBin).catch(() => {})
    await unlink(tmpPath).catch(() => {})
    return { ok: false, reason: `could not install the new binary: ${err?.message ?? String(err)}`, rolledBack: true }
  }

  // 6) Post-install check at the FINAL path (permissions/ACLs/noexec can differ from the temp
  //    name). If the installed binary can't identify itself, put the old one back.
  const after = checkBinaryVersionOutput(await probeBinaryVersion(currentBin), expected)
  if (!after.ok) {
    await rm(currentBin, { force: true }).catch(() => {})
    await rename(backup, currentBin).catch(() => {})
    return { ok: false, reason: 'the installed binary failed its post-install check', rolledBack: true }
  }

  return { ok: true, backup }
}

/**
 * `agentop upgrade`. Returns a process exit code — 0 only when the new binary is installed,
 * verified AND every running service was restarted onto it.
 */
export async function runUpgrade(lang: CliLang = 'en'): Promise<number> {
  const s = cliStrings(lang)

  // The install replaces process.execPath. From a source checkout (`bun bin/cli.ts upgrade`)
  // that path is the BUN RUNTIME — installing over it would clobber the user's bun. Only the
  // background spawner used to check this; a hand-run upgrade must be gated too.
  if (!isInstalledBinary(process.execPath, process.argv[1])) {
    process.stderr.write(`\n  ${_Y}${s.upgradeFromSource(process.execPath)}${_R}\n\n`)
    return 1
  }

  // The lock covers the WHOLE upgrade, not just the spawner: two installs writing the binary
  // at the same time is exactly the interleaving that corrupts it.
  const lock = acquireUpgradeLock('', process.env[UPGRADE_LOCK_ENV] === '1')
  if (lock.state === 'busy') {
    process.stdout.write(`\n  ${_D}${s.upgradeInProgress(lock.pid)}${_R}\n\n`)
    return 0
  }
  if (lock.state === 'unavailable') {
    process.stderr.write(`  ${_Y}${s.upgradeLockUnavailable}${_R}\n`)
  } else {
    armUpgradeLockRelease()
  }

  process.stdout.write('Checking for updates...\n')

  let info
  try {
    info = await getVersionInfo()
  } catch {
    console.error('Failed to check for updates. Check your internet connection.')
    return 1
  }

  if (!info.hasUpdate) {
    console.log(`Already on the latest version (${_GR}${_B}v${info.current}${_R}).`)
    clearUpgradeFailure()
    return 0
  }
  stampUpgradeLock(info.latest)

  // Platform/arch gate — refuse BEFORE downloading anything.
  const target = resolveUpgradeAsset(process.platform, process.arch, info.latest)
  if (!target) {
    const id = `${process.platform}/${process.arch}`
    process.stderr.write(
      `\n  ${_Y}${_B}${s.upgradeUnsupported(id)}${_R}\n` +
      `  ${s.upgradeManualHow(RELEASES_PAGE)}\n\n`,
    )
    recordUpgradeFailure(info.latest, `unsupported platform ${id}`)
    return 1
  }

  process.stdout.write(
    `\n  ${_D}Current:${_R} ${_WH}v${info.current}${_R}\n` +
    `  ${_D}Latest: ${_R} ${_GR}${_B}v${info.latest}${_R}\n\n`,
  )
  process.stdout.write(`Downloading ${target.asset}...\n`)

  let resp: Response
  try {
    resp = await fetch(target.url, {
      headers: { 'User-Agent': `agentistics/${CURRENT_VERSION}` },
      signal: AbortSignal.timeout(120_000),
    })
  } catch (err: any) {
    console.error(`Download failed: ${err.message}`)
    recordUpgradeFailure(info.latest, `download failed: ${err?.message ?? String(err)}`)
    return 1
  }

  if (!resp.ok) {
    // A 404 on a VERSION-addressed URL is a different fact from a network failure, and now that
    // the URL names a version it can say which one: the release exists but this platform's asset
    // was not published for it. Naming both is what makes a missing binary reportable instead of
    // looking like a broken connection.
    const detail = resp.status === 404
      ? `HTTP 404 — release v${info.latest} has no ${target.asset} asset`
      : `HTTP ${resp.status}`
    console.error(`Download failed: ${detail}`)
    recordUpgradeFailure(info.latest, `download failed: ${detail}`)
    return 1
  }

  const currentBin = process.execPath
  // Reading the body must be guarded too, not just the fetch: the transfer is ~140 MB, so the
  // 120s timeout firing mid-stream (or a reset connection) is the MOST likely failure of the whole
  // command. Outside the guard it rejected out of runUpgrade, skipping recordUpgradeFailure — so
  // the backoff never learned about the one failure it exists to throttle, and the user got a raw
  // stack trace instead of a message.
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await resp.arrayBuffer())
  } catch (err: any) {
    console.error(`Download failed: ${err?.message ?? String(err)}`)
    recordUpgradeFailure(info.latest, `download interrupted: ${err?.message ?? String(err)}`)
    return 1
  }
  const installed = await installDownloadedBinary(bytes, currentBin, info.latest, s)

  if (!installed.ok) {
    if (installed.keptTmp) {
      process.stderr.write(
        `\n${_Y}Permission denied.${_R} The binary was downloaded and verified at:\n` +
        `  ${installed.keptTmp}\n\n` +
        `Run the following to finish the upgrade:\n` +
        `  ${_WH}sudo mv ${installed.keptTmp} ${currentBin}${_R}\n\n`,
      )
    } else {
      process.stderr.write(`\n  ${_RD}${s.upgradeVerifyFailed(installed.reason ?? 'unknown error')}${_R}\n`)
      if (installed.rolledBack) {
        process.stderr.write(`  ${s.upgradeRolledBack(backupBinaryPath(currentBin))}\n`)
      } else {
        process.stderr.write(`  ${s.upgradeUntouched}\n`)
      }
      process.stderr.write('\n')
    }
    recordUpgradeFailure(info.latest, installed.reason ?? 'install failed')
    return 1
  }

  clearUpgradeFailure()
  process.stdout.write(`\n${_GR}${_B}Updated to v${info.latest}!${_R}\n`)
  process.stdout.write(`${_D}${s.upgradeBackupKept(installed.backup ?? '')}${_R}\n\n`)

  // Auto-apply: bounce any running services so they run the new version immediately.
  process.stdout.write('Applying the update to running services…\n')
  let restart: RestartOutcome
  try {
    restart = await restartRunningServices(currentBin)
  } catch (err: any) {
    restart = { ok: false, failures: [`unexpected error: ${err?.message ?? String(err)}`] }
  }

  if (!restart.ok) {
    // The binary IS installed — but claiming "Done, now running vX" while a service still runs
    // the old code is the lie that hides a failed critical update.
    process.stderr.write(
      `\n  ${_Y}${_B}${s.upgradeRestartFailed(info.latest)}${_R}\n` +
      restart.failures.map(f => `    • ${f}\n`).join('') +
      `  ${s.upgradeRestartHint}\n\n`,
    )
    return 1
  }

  process.stdout.write(`\n${_GR}${_B}Done — now running v${info.latest}.${_R}\n\n`)
  return 0
}
