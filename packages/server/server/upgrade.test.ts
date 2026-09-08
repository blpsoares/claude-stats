import { test, expect } from 'bun:test'
import {
  resolveUpgradeAsset,
  verifyDownload,
  looksLikeExecutable,
  checkBinaryVersionOutput,
  tempBinaryPath,
  backupBinaryPath,
  parseUpgradeFailure,
  nextUpgradeFailure,
  shouldAttemptUpgrade,
  upgradeBackoffMs,
  UPGRADE_BACKOFF_STEPS_MS,
  MIN_BINARY_BYTES,
} from './upgrade'

// --- platform/arch gate -----------------------------------------------------
// .github/workflows/release.yml publishes exactly two compiled assets: `agentop`
// (ubuntu-latest → linux x64) and `agentop.exe` (--target=bun-windows-x64). Anything
// else must be refused BEFORE a byte is downloaded — installing the x86_64 ELF on an
// arm64 box replaces a working binary with one the kernel cannot exec.

test('only the platform/arch pairs the release workflow publishes are self-installable', () => {
  expect(resolveUpgradeAsset('linux', 'x64', '2.5.0')).toEqual({
    asset: 'agentop',
    url: 'https://github.com/blpsoares/agentistics/releases/download/v2.5.0/agentop',
  })
  expect(resolveUpgradeAsset('win32', 'x64', '2.5.0')).toEqual({
    asset: 'agentop.exe',
    url: 'https://github.com/blpsoares/agentistics/releases/download/v2.5.0/agentop.exe',
  })
})

// The whole bug: the command printed "Latest: v2.5.0" and then downloaded through GitHub's rolling
// "Latest" FLAG, which a later release had taken without publishing the asset. Measured on the real
// repo (2026-09-02): the flag URL answered 404 while the version-addressed one answered 206.
test('the URL is addressed by VERSION, never by the rolling latest flag', () => {
  for (const [platform, arch] of [['linux', 'x64'], ['win32', 'x64']] as const) {
    const t = resolveUpgradeAsset(platform, arch, '1.23.1')!
    expect(t.url).toContain('/releases/download/v1.23.1/')
    expect(t.url).not.toContain('/releases/latest/download')
  }
})

test('the URL carries the version it was GIVEN — never a default', () => {
  // An upgrade that announces one version and fetches another is the failure this signature exists
  // to make impossible, so `version` is required rather than optional.
  expect(resolveUpgradeAsset('linux', 'x64', '9.9.9')!.url)
    .toBe('https://github.com/blpsoares/agentistics/releases/download/v9.9.9/agentop')
  expect(resolveUpgradeAsset('linux', 'x64', '1.0.0')!.url).toContain('/v1.0.0/')
})

test('the tag prefix is added once — the API reports a version, the tag is v<version>', () => {
  expect(resolveUpgradeAsset('linux', 'x64', '2.6.1')!.url).toContain('/v2.6.1/')
  expect(resolveUpgradeAsset('linux', 'x64', '2.6.1')!.url).not.toContain('/vv2.6.1/')
})

test('an unsupported platform is still refused whatever the version', () => {
  // The platform gate runs BEFORE any download; a version can never talk it into one.
  expect(resolveUpgradeAsset('darwin', 'arm64', '2.5.0')).toBeNull()
})

test('unsupported platform/arch combinations are refused', () => {
  expect(resolveUpgradeAsset('linux', 'arm64', '2.5.0')).toBeNull()   // Raspberry Pi / Ampere VM
  expect(resolveUpgradeAsset('linux', 'arm', '2.5.0')).toBeNull()
  expect(resolveUpgradeAsset('darwin', 'arm64', '2.5.0')).toBeNull()  // no macOS asset at all
  expect(resolveUpgradeAsset('darwin', 'x64', '2.5.0')).toBeNull()
  expect(resolveUpgradeAsset('win32', 'arm64', '2.5.0')).toBeNull()
  expect(resolveUpgradeAsset('freebsd', 'x64', '2.5.0')).toBeNull()
})

// --- download verification --------------------------------------------------

const elfHead = () => new Uint8Array([0x7f, 0x45, 0x4c, 0x46])
const peHead = () => new Uint8Array([0x4d, 0x5a, 0x90, 0x00])

function payload(head: Uint8Array, size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set(head, 0)
  return bytes
}

test('executable magic is checked per platform', () => {
  expect(looksLikeExecutable(elfHead(), 'linux')).toBe(true)
  expect(looksLikeExecutable(peHead(), 'win32')).toBe(true)
  expect(looksLikeExecutable(peHead(), 'linux')).toBe(false)   // Windows PE on Linux
  expect(looksLikeExecutable(elfHead(), 'win32')).toBe(false)
  // "<!DOCTYPE" — a GitHub error/redirect page, the classic 200-with-HTML case.
  expect(looksLikeExecutable(new Uint8Array([0x3c, 0x21, 0x44, 0x4f]), 'linux')).toBe(false)
})

test('verifyDownload rejects truncated payloads and non-executables', () => {
  expect(verifyDownload(payload(elfHead(), MIN_BINARY_BYTES + 1), 'linux')).toEqual({ ok: true })

  const short = verifyDownload(payload(elfHead(), 1024), 'linux')
  expect(short.ok).toBe(false)
  expect(short.ok === false && short.reason).toContain('1024 bytes')

  const html = verifyDownload(payload(new Uint8Array([0x3c, 0x21, 0x44, 0x4f]), MIN_BINARY_BYTES + 1), 'linux')
  expect(html.ok).toBe(false)
  expect(html.ok === false && html.reason).toContain('not an executable')

  // Empty body (dropped connection) never reaches the disk swap.
  expect(verifyDownload(new Uint8Array(0), 'linux').ok).toBe(false)
})

// --- post-download identity check -------------------------------------------

test('the downloaded binary must identify itself as the expected version (or newer)', () => {
  expect(checkBinaryVersionOutput('agentop v1.7.0\n', '1.7.0')).toEqual({ ok: true, found: '1.7.0' })
  // The download URL is the ROLLING `latest` release, which can be one bump ahead of the
  // newest version the releases API lists — newer is fine, older is not.
  expect(checkBinaryVersionOutput('agentop v1.7.1\n', '1.7.0')).toEqual({ ok: true, found: '1.7.1' })
  expect(checkBinaryVersionOutput('agentop v1.6.9\n', '1.7.0')).toEqual({ ok: false, found: '1.6.9' })
  // Nothing usable printed → the file did not run (wrong arch, corrupt, killed).
  expect(checkBinaryVersionOutput('', '1.7.0')).toEqual({ ok: false, found: null })
  expect(checkBinaryVersionOutput('bash: cannot execute binary file', '1.7.0')).toEqual({ ok: false, found: null })
  expect(checkBinaryVersionOutput('<!DOCTYPE html>', '1.7.0')).toEqual({ ok: false, found: null })
})

// --- atomic staging paths ---------------------------------------------------

test('the staged file is unique, hidden and next to the binary it will replace', () => {
  // Same directory → rename() is atomic (a cross-filesystem move is a copy, i.e. a window
  // where the live binary is half-written).
  expect(tempBinaryPath('/home/u/.local/bin/agentop', 'abc123'))
    .toBe('/home/u/.local/bin/.agentop.new-abc123')
  // The extension survives, or Windows cannot exec the staged file to verify it.
  expect(tempBinaryPath('/opt/tools/agentop.exe', 'deadbeef'))
    .toBe('/opt/tools/.agentop.new-deadbeef.exe')
  // Two concurrent upgrades never collide on the same temp name.
  expect(tempBinaryPath('/bin/agentop', 'a')).not.toBe(tempBinaryPath('/bin/agentop', 'b'))
})

test('the replaced binary is kept next to the target for rollback', () => {
  expect(backupBinaryPath('/home/u/.local/bin/agentop')).toBe('/home/u/.local/bin/agentop.bak')
  expect(backupBinaryPath('/opt/tools/agentop.exe')).toBe('/opt/tools/agentop.exe.bak')
})

// --- failure memory + backoff ----------------------------------------------

test('parseUpgradeFailure accepts a valid state and rejects junk', () => {
  expect(parseUpgradeFailure('{"version":"1.7.0","failedAt":1000,"attempts":2,"reason":"HTTP 404"}'))
    .toEqual({ version: '1.7.0', failedAt: 1000, attempts: 2, reason: 'HTTP 404' })
  expect(parseUpgradeFailure('{"version":"1.7.0","failedAt":1000}'))
    .toEqual({ version: '1.7.0', failedAt: 1000, attempts: 1, reason: '' })
  expect(parseUpgradeFailure('not json')).toBeNull()
  expect(parseUpgradeFailure('{"failedAt":1000}')).toBeNull()          // no version
  expect(parseUpgradeFailure('{"version":"1.7.0"}')).toBeNull()        // no timestamp
})

test('backoff widens with consecutive failures and caps', () => {
  expect(upgradeBackoffMs(1)).toBe(UPGRADE_BACKOFF_STEPS_MS[0]!)
  expect(upgradeBackoffMs(2)).toBe(UPGRADE_BACKOFF_STEPS_MS[1]!)
  expect(upgradeBackoffMs(4)).toBe(UPGRADE_BACKOFF_STEPS_MS[3]!)
  expect(upgradeBackoffMs(99)).toBe(UPGRADE_BACKOFF_STEPS_MS[3]!)      // capped, never grows forever
  expect(upgradeBackoffMs(0)).toBe(UPGRADE_BACKOFF_STEPS_MS[0]!)       // defensive
})

test('consecutive failures on the same version increment; a new version resets', () => {
  const first = nextUpgradeFailure(null, '1.7.0', 1000, 'HTTP 404')
  expect(first).toEqual({ version: '1.7.0', failedAt: 1000, attempts: 1, reason: 'HTTP 404' })
  const second = nextUpgradeFailure(first, '1.7.0', 2000, 'HTTP 404')
  expect(second.attempts).toBe(2)
  // A newer release may well fix whatever failed — it gets a clean slate.
  expect(nextUpgradeFailure(second, '1.7.1', 3000, 'HTTP 404').attempts).toBe(1)
})

test('a permanently failing update backs off instead of re-downloading on every shell', () => {
  const t0 = 1_000_000
  const state = { version: '1.7.0', failedAt: t0, attempts: 1, reason: 'permission denied' }
  expect(shouldAttemptUpgrade(state, '1.7.0', t0 + 1000)).toBe(false)                       // seconds later
  expect(shouldAttemptUpgrade(state, '1.7.0', t0 + upgradeBackoffMs(1) - 1)).toBe(false)
  expect(shouldAttemptUpgrade(state, '1.7.0', t0 + upgradeBackoffMs(1))).toBe(true)         // window elapsed
  // A different target version is always retried immediately.
  expect(shouldAttemptUpgrade(state, '1.7.1', t0 + 1000)).toBe(true)
  // Nothing recorded → always allowed.
  expect(shouldAttemptUpgrade(null, '1.7.0', t0)).toBe(true)
  // After 4 failures the wait is a full day, not another 140 MB download per terminal.
  const worn = { ...state, attempts: 4 }
  expect(shouldAttemptUpgrade(worn, '1.7.0', t0 + 8 * 60 * 60_000)).toBe(false)
  expect(shouldAttemptUpgrade(worn, '1.7.0', t0 + 24 * 60 * 60_000)).toBe(true)
})
