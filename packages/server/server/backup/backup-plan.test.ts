import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { HARNESS_ORDER } from '@agentistics/core'
import { BACKUP_LAYERS, EXCLUDE_RULES, HARNESS_SECRETS, excludeFor, omittedSecrets, planSources, withMetrics } from './backup-plan'

test('metrics is always planned, whatever the caller asked for', () => {
  const s = planSources({ layers: ['raw'], harnesses: ['claude'] })
  expect(s.some(e => e.layer === 'metrics')).toBe(true)
})

test('withMetrics adds metrics when it is missing, and orders the result by BACKUP_LAYERS', () => {
  expect(withMetrics(['raw', 'repos'])).toEqual(['metrics', 'repos', 'raw'])
})

test('withMetrics is a no-op — up to order — when metrics is already there', () => {
  expect(withMetrics(['metrics', 'archive'])).toEqual(['metrics', 'archive'])
})

test('withMetrics on an empty list yields metrics alone, never an empty backup', () => {
  expect(withMetrics([])).toEqual(['metrics'])
})

test('a harness contributes its consolidate dir AND its raw dir', () => {
  const s = planSources({ layers: ['metrics', 'raw'], harnesses: ['codex'] })
  const rels = s.map(e => e.rel)
  expect(rels).toContain('.agentistics/sessions/codex')
  expect(rels).toContain('.codex')
})

test('an unselected harness contributes nothing of its own', () => {
  const rels = planSources({ layers: ['metrics', 'raw'], harnesses: ['codex'] }).map(e => e.rel)
  expect(rels).not.toContain('.agentistics/sessions/claude')
  expect(rels).not.toContain('.claude')
})

// Antigravity lives INSIDE ~/.gemini. Selecting both must not archive .gemini twice — the second
// entry is a subpath of the first, and tar would walk the same bytes again.
test('a source nested inside another selected source is dropped', () => {
  const rels = planSources({ layers: ['raw'], harnesses: ['gemini', 'antigravity'] }).map(e => e.rel)
  expect(rels).toContain('.gemini')
  expect(rels).not.toContain('.gemini/antigravity-cli')
})

test('antigravity alone still reaches its own dir inside .gemini', () => {
  const rels = planSources({ layers: ['raw'], harnesses: ['antigravity'] }).map(e => e.rel)
  expect(rels).toContain('.gemini/antigravity-cli')
  expect(rels).not.toContain('.gemini')
})

test('cross-harness data is always in, whatever the harness selection', () => {
  const rels = planSources({ layers: ['metrics'], harnesses: [] }).map(e => e.rel)
  expect(rels).toContain('.agentistics/tags.json')
  expect(rels).toContain('.agentistics/workflows')
  expect(rels).toContain('.claude/stats-cache.json')
})

test('every credential path is excluded, and names how to re-establish it', () => {
  for (const rel of [
    '.claude/.credentials.json',
    '.codex/auth.json',
    '.gemini/oauth_creds.json',
    '.agentistics/connections/some-central.json',
  ]) {
    const rule = excludeFor(rel)
    expect(rule?.reason).toBe('secret')
    expect(rule?.restoreWith ?? '').not.toBe('')
  }
})

// One credential per harness, so a harness added without a secrets decision fails here rather than
// in someone's tarball. The Record makes the omission a compile error; keying the probe off
// `HARNESS_SECRETS[h]` — rather than the flattened `EXCLUDE_RULES`, which this loop used to read
// without ever using `h` — is what makes a harness with an EMPTY array fail here BY NAME instead of
// the loop silently passing on some other harness's rule.
test('every harness has at least one credential rule, and each names how to re-establish it', () => {
  for (const h of HARNESS_ORDER) {
    const rules = HARNESS_SECRETS[h]
    expect(rules.length, `${h} has no credential rule`).toBeGreaterThan(0)
    for (const r of rules) {
      expect(r.why.length, `${h}: ${r.pattern} has no explanation`).toBeGreaterThan(0)
      expect(r.restoreWith ?? '', `${h}: ${r.pattern} has no restore command`).not.toBe('')
    }
  }
  for (const [rel, harness] of [
    ['.claude/.credentials.json', 'claude'],
    ['.codex/auth.json', 'codex'],
    ['.gemini/oauth_creds.json', 'gemini'],
    ['.gemini/gemini-credentials.json', 'gemini'],
    ['.gemini/google_accounts.json', 'gemini'],
    ['.gemini/antigravity-cli/antigravity-oauth-token', 'antigravity'],
    ['.copilot/token', 'copilot'],
    ['.copilot/mcp-oauth-config/github.tokens.json', 'copilot'],
    ['.kimi-code/config.toml', 'kimi'],
  ] as [string, string][]) {
    const rule = excludeFor(rel)
    expect(rule?.reason, `${harness}: ${rel} must be excluded`).toBe('secret')
    expect(rule?.restoreWith ?? '').not.toBe('')
  }
})

test('preferences.json is not walked — it travels redacted, staged', () => {
  const rels = planSources({ layers: ['metrics'], harnesses: ['claude'] }).map(e => e.rel)
  expect(rels).not.toContain('.agentistics/preferences.json')
})

test('regenerable and runtime files are excluded', () => {
  expect(excludeFor('.agentistics/cache.db')?.reason).toBe('regenerable')
  expect(excludeFor('.agentistics/cache.db-wal')?.reason).toBe('regenerable')
  expect(excludeFor('.agentistics/agentop-server.log')?.reason).toBe('regenerable')
  expect(excludeFor('.claude/shell-snapshots/x.sh')?.reason).toBe('regenerable')
  expect(excludeFor('.agentistics/managed-sessions.json')?.reason).toBe('runtime')
  expect(excludeFor('.agentistics/managed-sessions.json.corrupt-123')?.reason).toBe('regenerable')
})

// E5: local control-socket tokens, credential-shaped (a `--with-raw` backup walked them all: 141
// `.key` files on the reference machine). `.key` matches BOTH — the correct one for the token file
// itself, since it runs before the `.claude/daemon` runtime rule.
test('session and daemon control-socket keys are excluded as secrets', () => {
  const sessionKey = excludeFor('.claude/sessions/10259.1d78a4b41b072a6ab45882018ce6922232c6d996cb91d247fa18d79bfad5ac6b.key')
  expect(sessionKey?.reason).toBe('secret')
  expect(sessionKey?.restoreWith ?? '').not.toBe('')

  const daemonKey = excludeFor('.claude/daemon/control.key')
  expect(daemonKey?.reason).toBe('secret')

  // A session's ordinary identity file (`<pid>.json` — holds the /rename name, not a credential)
  // must NOT be swept up by the same rule; only `.key` files are.
  expect(excludeFor('.claude/sessions/10259.json')).toBeNull()
})

// The rest of the daemon's state (dispatch queue, roster, attach journal) is tied to pids and
// sockets on THIS machine and restores to nothing meaningful on a new one.
test('the rest of the daemon directory is excluded as runtime state', () => {
  expect(excludeFor('.claude/daemon/roster.json')?.reason).toBe('runtime')
  expect(excludeFor('.claude/daemon/attach-journal')?.reason).toBe('runtime')
})

test('ordinary data is not excluded', () => {
  expect(excludeFor('.agentistics/sessions/claude/abc.json')).toBeNull()
  expect(excludeFor('.claude/stats-cache.json')).toBeNull()
  expect(excludeFor('.claude/projects/foo/bar.jsonl')).toBeNull()
})

test('omittedSecrets lists every secret rule, each with its command', () => {
  const s = omittedSecrets()
  expect(s.length).toBeGreaterThan(0)
  expect(s.every(r => r.reason === 'secret' && (r.restoreWith ?? '') !== '')).toBe(true)
})

// The `repos` layer's content is produced during the backup (bundles, patches) and lives nowhere
// in $HOME, so it contributes no source to this walk. Pinned so the absence reads as a decision
// rather than an omission — it is `runBackup`'s `assetRoot` that carries it into the archive.
test('the repos layer contributes no $HOME source — its content is made, not found', () => {
  const withRepos = planSources({ layers: ['metrics', 'repos'], harnesses: ['claude'] })
  const without = planSources({ layers: ['metrics'], harnesses: ['claude'] })
  expect(withRepos.map(e => e.rel)).toEqual(without.map(e => e.rel))
  expect(withRepos.some(e => e.layer === 'repos')).toBe(false)
})

// The enforcement, not a convention: a credential path that stopped being excluded is a leak, and
// a leak in a tarball is discovered by whoever finds the tarball. Same shape as
// billing-detect.test.ts, which greps its own module rather than trusting a reviewer.
test('no credential filename can pass the filter — asserted over the source itself', () => {
  const src = readFileSync(join(import.meta.dir, 'backup-plan.ts'), 'utf8')
  for (const needle of ['.credentials.json', 'auth.json', 'oauth_creds.json', 'connections']) {
    expect(src).toContain(needle)
  }
  for (const probe of [
    '.claude/.credentials.json',
    '.codex/auth.json',
    '.gemini/oauth_creds.json',
    '.agentistics/connections/x',
  ]) {
    expect(excludeFor(probe)).not.toBeNull()
  }
})

test('BACKUP_LAYERS is the whole set and metrics leads it', () => {
  expect(BACKUP_LAYERS).toEqual(['metrics', 'repos', 'archive', 'raw'])
  expect(EXCLUDE_RULES.every(r => r.why.length > 0)).toBe(true)
})

// `packages/tui` may not import from `packages/server` (server -> tui is the only allowed
// direction), so `BackupLayer` is redeclared there. This is what stops the two drifting: a layer
// added here and not there would compile fine and simply never be offered by the cockpit's
// harness list or config pane — the same guard `central-runtime.test.ts` runs for
// `CentralRuntimeId`.
test('the control center\'s BackupLayer union matches BACKUP_LAYERS, member for member', () => {
  const source = readFileSync(join(import.meta.dir, '..', '..', '..', 'tui', 'src', 'control', 'types.ts'), 'utf8')
  const decl = source.match(/export type BackupLayer = ([^\n]+)/)?.[1]
  expect(decl).toBeDefined()
  const members = [...decl!.matchAll(/'([a-z]+)'/g)].map(m => m[1]!)
  expect(members.sort()).toEqual([...BACKUP_LAYERS].sort())
})

// `control/backup.ts`'s layers editor draws every row in this order — metrics leading — so the
// ORDER, not only the membership, must match. A silent reorder there would put the always-on
// metrics row somewhere a user could miss it.
test('the control center\'s BACKUP_LAYER_ORDER matches BACKUP_LAYERS, in order', () => {
  const source = readFileSync(join(import.meta.dir, '..', '..', '..', 'tui', 'src', 'control', 'backup.ts'), 'utf8')
  const decl = source.match(/export const BACKUP_LAYER_ORDER: BackupLayer\[] = \[([^\]]+)]/)?.[1]
  expect(decl).toBeDefined()
  const members = [...decl!.matchAll(/'([a-z]+)'/g)].map(m => m[1]!)
  expect(members).toEqual(BACKUP_LAYERS)
})
