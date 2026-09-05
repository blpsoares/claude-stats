import { test, expect } from 'bun:test'
import { GITHUB_RELEASE_LIMIT_BYTES, githubFitVerdict } from './backup-github'
import type { BackupLayer } from './backup-plan'

const bytes = (over: Partial<Record<BackupLayer, number | null>> = {}): Record<BackupLayer, number | null> => ({
  metrics: 0, repos: null, archive: 0, raw: 0, ...over,
})

test('well under the cap fits, certainly — compression only shrinks further', () => {
  expect(githubFitVerdict(['metrics'], bytes({ metrics: 1_000_000 }))).toBe('fits')
})

test('at or over the cap is an honest "maybe-not", never a confident no', () => {
  expect(githubFitVerdict(['metrics', 'raw'], bytes({ metrics: 1_000, raw: GITHUB_RELEASE_LIMIT_BYTES }))).toBe('maybe-not')
  expect(githubFitVerdict(['raw'], bytes({ raw: GITHUB_RELEASE_LIMIT_BYTES - 1 }))).toBe('fits')
})

test('only the SELECTED layers are summed — an unticked heavy layer does not count against it', () => {
  expect(githubFitVerdict(['metrics'], bytes({ metrics: 100, raw: GITHUB_RELEASE_LIMIT_BYTES * 5 }))).toBe('fits')
})

test('an unmeasurable layer (repos, before a run) contributes nothing to the sum', () => {
  expect(githubFitVerdict(['metrics', 'repos'], bytes({ metrics: 100 }))).toBe('fits')
})

test('an empty layer selection trivially fits', () => {
  expect(githubFitVerdict([], bytes())).toBe('fits')
})
