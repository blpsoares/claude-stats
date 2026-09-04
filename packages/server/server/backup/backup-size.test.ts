import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  addBytes, emptySizes, formatBytes, harnessTotal, layerTotal, plannedTotal, retainedTotal,
} from './backup-size'

test('an empty accounting has every layer at zero, and no layer is missing', () => {
  const s = emptySizes()
  expect(layerTotal(s, 'metrics')).toBe(0)
  expect(layerTotal(s, 'repos')).toBe(0)
  expect(layerTotal(s, 'archive')).toBe(0)
  expect(layerTotal(s, 'raw')).toBe(0)
})

test('bytes accumulate per layer and per harness', () => {
  const s = emptySizes()
  addBytes(s, 'metrics', 'claude', 3_400_000)
  addBytes(s, 'metrics', 'codex', 60_000)
  addBytes(s, 'raw', 'claude', 953_000_000)
  expect(layerTotal(s, 'metrics')).toBe(3_460_000)
  expect(s.metrics.byHarness.claude).toBe(3_400_000)
  expect(s.metrics.files).toBe(2)
  expect(harnessTotal(s, 'claude')).toBe(3_400_000 + 953_000_000)
})

test('cross-harness bytes count toward the layer but toward no harness', () => {
  const s = emptySizes()
  addBytes(s, 'metrics', null, 24_000)
  expect(layerTotal(s, 'metrics')).toBe(24_000)
  expect(harnessTotal(s, 'claude')).toBe(0)
})

test('the planned total counts only the layers being written', () => {
  const s = emptySizes()
  addBytes(s, 'metrics', 'claude', 100)
  addBytes(s, 'raw', 'claude', 900)
  expect(plannedTotal(s, ['metrics'])).toBe(100)
  expect(plannedTotal(s, ['metrics', 'raw'])).toBe(1000)
})

test('retention is accounted as one total across every kept backup', () => {
  expect(retainedTotal([
    { archiveBytes: 4_100_000 } as never,
    { archiveBytes: 4_050_000 } as never,
  ])).toBe(8_150_000)
  expect(retainedTotal([])).toBe(0)
})

test('formatBytes is readable and never lies about the unit', () => {
  expect(formatBytes(0)).toBe('0 B')
  expect(formatBytes(999)).toBe('999 B')
  expect(formatBytes(1024)).toBe('1.0 KB')
  expect(formatBytes(3_400_000)).toBe('3.2 MB')
  expect(formatBytes(2_400_000_000)).toBe('2.2 GB')
})

// The structural enforcement of the spec's rule 2. A compressed size cannot be predicted, only
// measured after the file exists — so this module must have no field, and no arithmetic, for one.
// An estimate that reads like a measurement is the same defect as a confident 0 for a metric
// nobody can produce.
test('this module never predicts a compressed size — asserted over its own source', () => {
  const src = readFileSync(join(import.meta.dir, 'backup-size.ts'), 'utf8')
  const body = src.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n')
  for (const forbidden of ['ratio', 'estimate', 'compressed', 'predict']) {
    expect(body.toLowerCase()).not.toContain(forbidden)
  }
})
