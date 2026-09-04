import { test, expect } from 'bun:test'
import { parseBackupArgs, readBackupPrefs } from '../cli-backup'

test('bare `agentop backup` runs with the default layers and every harness', () => {
  const a = parseBackupArgs([])
  expect(a.kind).toBe('run')
  if (a.kind !== 'run') return
  expect(a.layers).toEqual(['metrics', 'repos'])
  expect(a.harnesses.length).toBeGreaterThan(0)
})

test('layers are opt-in and additive', () => {
  const a = parseBackupArgs(['--with-archive', '--with-raw'])
  if (a.kind !== 'run') throw new Error('expected run')
  expect(a.layers).toEqual(['metrics', 'repos', 'archive', 'raw'])
})

test('a harness selection narrows, and an unknown harness is a usage error', () => {
  const a = parseBackupArgs(['--harness', 'claude,codex'])
  if (a.kind !== 'run') throw new Error('expected run')
  expect(a.harnesses).toEqual(['claude', 'codex'])

  const bad = parseBackupArgs(['--harness', 'gpt'])
  expect(bad.kind).toBe('error')
})

test('`--plan` asks for the plan and nothing else', () => {
  const a = parseBackupArgs(['--plan'])
  if (a.kind !== 'run') throw new Error('expected run')
  expect(a.planOnly).toBe(true)
})

test('--max-bundle takes megabytes, and refuses anything that is not a positive number', () => {
  const a = parseBackupArgs(['--max-bundle', '50'])
  if (a.kind !== 'run') throw new Error('expected run')
  expect(a.maxBundleBytes).toBe(50 * 1024 * 1024)
  expect(parseBackupArgs(['--max-bundle', 'big']).kind).toBe('error')
  expect(parseBackupArgs(['--max-bundle', '0']).kind).toBe('error')
})

// A preference that is read and never consulted is worse than no preference: the user sets it,
// nothing changes, and they are left guessing which of the two they got wrong.
test('a --with flag marks the layers explicit; without one they come from configuration', () => {
  const bare = parseBackupArgs([])
  if (bare.kind !== 'run') throw new Error('expected run')
  expect(bare.layersFromFlags).toBe(false)

  const flagged = parseBackupArgs(['--with-raw'])
  if (flagged.kind !== 'run') throw new Error('expected run')
  expect(flagged.layersFromFlags).toBe(true)
  expect(flagged.layers).toContain('raw')

  // A non-layer flag does not make the layers explicit.
  const other = parseBackupArgs(['--plan'])
  if (other.kind !== 'run') throw new Error('expected run')
  expect(other.layersFromFlags).toBe(false)
})

test('the schedule subcommand takes only the known ids', () => {
  expect(parseBackupArgs(['schedule', 'daily']).kind).toBe('schedule')
  expect(parseBackupArgs(['schedule', 'hourly']).kind).toBe('error')
})

test('an absent backup preference block yields safe defaults, not a crash', () => {
  const p = readBackupPrefs({})
  expect(p.schedule).toBe('off')
  expect(p.keep).toBeGreaterThan(0)
  expect(p.layers).toEqual(['metrics', 'repos'])
})

// A schedule that carried `raw` would be 2.4 GB per run. The default must not be able to become
// that by accident, so a stored preference is clamped on READ, the way sessionPollMs is.
test('a stored schedule that names `raw` is honoured, but the default never does', () => {
  expect(readBackupPrefs({ backup: { scheduleLayers: ['metrics', 'raw'] } } as never).scheduleLayers)
    .toEqual(['metrics', 'raw'])
  expect(readBackupPrefs({}).scheduleLayers).toEqual(['metrics', 'repos'])
})
