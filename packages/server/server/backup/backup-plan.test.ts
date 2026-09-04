import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { BACKUP_LAYERS, EXCLUDE_RULES, excludeFor, omittedSecrets, planSources } from './backup-plan'

test('metrics is always planned, whatever the caller asked for', () => {
  const s = planSources({ layers: ['raw'], harnesses: ['claude'] })
  expect(s.some(e => e.layer === 'metrics')).toBe(true)
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
  expect(rels).toContain('.agentistics/preferences.json')
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

test('regenerable and runtime files are excluded', () => {
  expect(excludeFor('.agentistics/cache.db')?.reason).toBe('regenerable')
  expect(excludeFor('.agentistics/cache.db-wal')?.reason).toBe('regenerable')
  expect(excludeFor('.agentistics/agentop-server.log')?.reason).toBe('regenerable')
  expect(excludeFor('.claude/shell-snapshots/x.sh')?.reason).toBe('regenerable')
  expect(excludeFor('.agentistics/managed-sessions.json')?.reason).toBe('runtime')
  expect(excludeFor('.agentistics/managed-sessions.json.corrupt-123')?.reason).toBe('regenerable')
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
