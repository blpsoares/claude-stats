import { test, expect, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPreferencesFrom, writePreferencesTo, type Preferences } from './preferences'
import type { AccessibilityPrefs } from '@agentistics/core'

// `PUT /api/accessibility` must REPLACE the stored `accessibility` value wholesale — never merge
// it. If it merged, deleting the last lens of a page would be impossible: an absent page key would
// read as "unchanged" and the lens would come back. Today that guarantee holds only because
// `writePreferencesTo`'s merge is a SHALLOW, top-level key merge (`{ ...current, ...prefs }`) —
// nothing asserts that. If someone later deep-merges `accessibility` for some other field's
// benefit, this feature silently breaks and every other test still passes. These two assertions
// pull in opposite directions on purpose and belong together: (1) a page's lenses really can be
// deleted (proves the merge is NOT deep), and (2) an unrelated preference key set on the same
// write survives an accessibility-only write afterwards (proves the top-level merge is NOT
// dropped either — a write here must not wipe the user's language, theme, layouts or connections).

let dir: string | null = null

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = null
})

async function tmpPrimary(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'agentistics-a11y-'))
  return join(dir, 'preferences.json')
}

test('an accessibility-only write REPLACES lensesByPage — a page can be emptied, not merged away', async () => {
  const primary = await tmpPrimary()

  const withLenses: AccessibilityPrefs = {
    enabled: true,
    followLens: { shape: 'circle', width: 260, height: 260, zoom: 2.5, borderWidth: 3, cornerRadius: 12 },
    newLensDefaults: { shape: 'rect', width: 360, height: 240, zoom: 2.5, borderWidth: 3, cornerRadius: 12 },
    lensesByPage: {
      '/costs': [
        { id: 'a', x: 10, y: 20, shape: 'rect', width: 360, height: 240, zoom: 2.5, borderWidth: 3, cornerRadius: 12, pinned: false },
        { id: 'b', x: 30, y: 40, shape: 'circle', width: 260, height: 260, zoom: 3, borderWidth: 3, cornerRadius: 12, pinned: true },
      ],
    },
    globalLenses: [],
  }

  await writePreferencesTo(primary, null, { accessibility: withLenses })
  const afterFirst = await readPreferencesFrom(primary, null)
  expect(afterFirst.accessibility?.lensesByPage['/costs']).toHaveLength(2)

  // Delete the last lens of the page: `accessibility` is written again with an EMPTY
  // `lensesByPage`. If `writePreferencesTo` ever deep-merged the `accessibility` key, the old
  // `/costs` entry would survive under the new (empty) object and this assertion would fail —
  // that is the whole point of this test.
  const cleared: AccessibilityPrefs = { ...withLenses, lensesByPage: {} }
  await writePreferencesTo(primary, null, { accessibility: cleared })
  const afterSecond = await readPreferencesFrom(primary, null)
  expect(afterSecond.accessibility?.lensesByPage['/costs']).toBeUndefined()
  expect(afterSecond.accessibility?.lensesByPage).toEqual({})
})

test('an accessibility-only write leaves unrelated preference keys untouched', async () => {
  const primary = await tmpPrimary()

  // `lang` is a real, cheap field set on the FIRST write, alongside a real accessibility value.
  const initial: Preferences = {
    lang: 'pt',
    accessibility: {
      enabled: true,
      followLens: { shape: 'circle', width: 260, height: 260, zoom: 2.5, borderWidth: 3, cornerRadius: 12 },
      newLensDefaults: { shape: 'rect', width: 360, height: 240, zoom: 2.5, borderWidth: 3, cornerRadius: 12 },
      lensesByPage: { '/costs': [{ id: 'a', x: 0, y: 0, shape: 'rect', width: 360, height: 240, zoom: 2.5, borderWidth: 3, cornerRadius: 12, pinned: false }] },
      globalLenses: [],
    },
  }
  await writePreferencesTo(primary, null, initial)
  expect((await readPreferencesFrom(primary, null)).lang).toBe('pt')

  // A SECOND write touches ONLY `accessibility` (as the real PUT /api/accessibility handler does)
  // — `lang` is not part of this payload at all. If the top-level shallow merge were ever lost,
  // this write would wipe `lang` (and every other preference) along with it.
  await writePreferencesTo(primary, null, {
    accessibility: {
      enabled: false,
      followLens: { shape: 'circle', width: 260, height: 260, zoom: 2.5, borderWidth: 3, cornerRadius: 12 },
      newLensDefaults: { shape: 'rect', width: 360, height: 240, zoom: 2.5, borderWidth: 3, cornerRadius: 12 },
      lensesByPage: {},
      globalLenses: [],
    },
  })

  const final = await readPreferencesFrom(primary, null)
  expect(final.lang).toBe('pt')
  expect(final.accessibility?.enabled).toBe(false)
})
