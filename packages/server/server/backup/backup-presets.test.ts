/**
 * backup-presets.test.ts — the named shapes a backup can take.
 */
import { test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { BACKUP_PRESETS, presetFor, RECOMMENDED_PRESET } from './backup-presets'

test('there is exactly one RECOMMENDED preset, and it is a real one', () => {
  // Asked for directly: "acho que a galera fica mais segura de usar o recomendado". A default
  // nobody endorses is a default everybody second-guesses — and the layers are not a preference,
  // they decide whether a restore brings a machine back or brings back half of one.
  const recommended = BACKUP_PRESETS.filter(p => p.recommended)
  expect(recommended.length).toBe(1)
  expect(recommended[0]!.id).toBe(RECOMMENDED_PRESET)
})

test('the recommended shape is metrics + repos — everything a restore needs, and nothing that is gigabytes', () => {
  // `metrics` alone restores the dashboard and loses the map of where every repository was.
  // `repos` adds that map plus the unpushed work, for a few hundred KB of bundles.
  // `archive` and `raw` are the transcripts: 2.4 GB on the machine this was written for, and not
  // needed to bring a machine back.
  const p = presetFor(RECOMMENDED_PRESET)!
  expect(p.layers).toEqual(['metrics', 'repos'])
})

test('every preset includes metrics — a backup without it restores nothing', () => {
  for (const p of BACKUP_PRESETS) expect(p.layers).toContain('metrics')
})

test('presetFor matches a LAYER SET, so a hand-picked set that equals a preset shows as that preset', () => {
  // Order must not decide it: someone ticking `repos` then `metrics` chose the recommended shape
  // and should see it named, not "custom".
  expect(presetFor(['repos', 'metrics'])?.id).toBe('recommended')
  expect(presetFor(['metrics'])?.id).toBe('minimal')
  expect(presetFor(['metrics', 'repos', 'archive', 'raw'])?.id).toBe('everything')
})

test('a set matching no preset is null — never silently reported as one', () => {
  expect(presetFor(['metrics', 'raw'])).toBe(null)
  expect(presetFor([])).toBe(null)
})

test('presetFor takes an id too, so a caller can ask for one by name', () => {
  expect(presetFor('minimal')?.layers).toEqual(['metrics'])
  expect(presetFor('nope')).toBe(null)
})

test('the web mirror of this table matches it, member for member', () => {
  // The web bundle may not import from `packages/server`, so the list is duplicated there. A
  // duplicate that drifts is worse than none: the button would say "Recommended" and set something
  // this module does not recommend. Cross-checked over the SOURCE, the shape
  // `notifications`/`schedule` already use for the same problem.
  const web = readFileSync(
    join(import.meta.dir, '../../../web/src/pages/settings/BackupSettings.tsx'), 'utf-8',
  )
  const block = /const BACKUP_PRESETS[^=]*=\s*\[([\s\S]*?)\n\]/.exec(web)?.[1]
  expect(block).toBeTruthy()

  for (const p of BACKUP_PRESETS) {
    // Each id present, with exactly the same layers, in the same order.
    const layers = p.layers.map(l => `'${l}'`).join(', ')
    expect(block).toContain(`id: '${p.id}', layers: [${layers}]`)
  }
  // And exactly one marked recommended, on the same id.
  expect((block!.match(/recommended: true/g) ?? []).length).toBe(1)
  expect(block).toContain(`id: '${RECOMMENDED_PRESET}'`)
})
