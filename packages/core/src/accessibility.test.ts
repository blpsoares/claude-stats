import { describe, test, expect } from 'bun:test'
import {
  sanitizeAccessibilityPrefs,
  DEFAULT_ACCESSIBILITY_PREFS,
  ZOOM_MIN,
  ZOOM_MAX,
  LENS_MIN_PX,
} from './accessibility'

describe('sanitizeAccessibilityPrefs', () => {
  test('junk input yields the defaults', () => {
    expect(sanitizeAccessibilityPrefs(null)).toEqual(DEFAULT_ACCESSIBILITY_PREFS)
    expect(sanitizeAccessibilityPrefs('nope')).toEqual(DEFAULT_ACCESSIBILITY_PREFS)
    expect(sanitizeAccessibilityPrefs(42)).toEqual(DEFAULT_ACCESSIBILITY_PREFS)
    expect(sanitizeAccessibilityPrefs({})).toEqual(DEFAULT_ACCESSIBILITY_PREFS)
  })

  test('enabled is true only for the literal boolean', () => {
    expect(sanitizeAccessibilityPrefs({ enabled: true }).enabled).toBe(true)
    expect(sanitizeAccessibilityPrefs({ enabled: 'true' }).enabled).toBe(false)
    expect(sanitizeAccessibilityPrefs({ enabled: 1 }).enabled).toBe(false)
  })

  test('zoom and size are clamped, not rejected', () => {
    const out = sanitizeAccessibilityPrefs({
      lensesByPage: { '/costs': [{ id: 'a', x: 10, y: 20, zoom: 999, width: 1, height: 1 }] },
    })
    const lens = out.lensesByPage['/costs']![0]!
    expect(lens.zoom).toBe(ZOOM_MAX)
    expect(lens.width).toBe(LENS_MIN_PX)
    expect(lens.height).toBe(LENS_MIN_PX)
  })

  test('a zoom below the floor is raised to it', () => {
    const out = sanitizeAccessibilityPrefs({
      lensesByPage: { '/': [{ id: 'a', x: 0, y: 0, zoom: 0.1 }] },
    })
    expect(out.lensesByPage['/']![0]!.zoom).toBe(ZOOM_MIN)
  })

  test('an unknown shape falls back to rect, and a circle mirrors width into height', () => {
    const out = sanitizeAccessibilityPrefs({
      lensesByPage: {
        '/': [
          { id: 'a', x: 0, y: 0, shape: 'triangle' },
          { id: 'b', x: 0, y: 0, shape: 'circle', width: 200, height: 999 },
        ],
      },
    })
    expect(out.lensesByPage['/']![0]!.shape).toBe('rect')
    const circle = out.lensesByPage['/']![1]!
    expect(circle.shape).toBe('circle')
    expect(circle.width).toBe(200)
    expect(circle.height).toBe(circle.width)
  })

  test('duplicate and missing ids are re-minted deterministically', () => {
    const out = sanitizeAccessibilityPrefs({
      lensesByPage: {
        '/': [
          { id: 'dup', x: 0, y: 0 },
          { id: 'dup', x: 0, y: 0 },
          { x: 0, y: 0 },
        ],
      },
    })
    const ids = out.lensesByPage['/']!.map(l => l.id)
    expect(new Set(ids).size).toBe(3)
    expect(ids[0]).toBe('dup')
  })

  test('page keys that are not paths, and non-array pages, are dropped', () => {
    const out = sanitizeAccessibilityPrefs({
      lensesByPage: { costs: [{ id: 'a', x: 0, y: 0 }], '/ok': [{ id: 'b', x: 0, y: 0 }], '/bad': 'x' },
    })
    expect(Object.keys(out.lensesByPage)).toEqual(['/ok'])
  })

  test('an empty page is dropped rather than stored empty', () => {
    const out = sanitizeAccessibilityPrefs({ lensesByPage: { '/costs': [] } })
    expect(out.lensesByPage).toEqual({})
  })

  test('it is idempotent', () => {
    const messy = {
      enabled: true,
      followLens: { shape: 'circle', width: 300, zoom: 6 },
      lensesByPage: { '/costs': [{ id: 'dup', x: 5, y: 5, zoom: 99 }, { id: 'dup', x: 1, y: 1 }] },
    }
    const once = sanitizeAccessibilityPrefs(messy)
    expect(sanitizeAccessibilityPrefs(once)).toEqual(once)
  })

  test('Finding 1: garbage array items are skipped, not turned into default lenses', () => {
    // A page of only non-object entries should yield no page key at all
    const out1 = sanitizeAccessibilityPrefs({
      lensesByPage: { '/costs': ['garbage', 42, null, undefined, true] },
    })
    expect(out1.lensesByPage).toEqual({})

    // A page mixing one real lens with garbage entries should yield exactly that one lens
    const out2 = sanitizeAccessibilityPrefs({
      lensesByPage: {
        '/mixed': [
          'garbage',
          { id: 'lens-real', x: 10, y: 20 },
          42,
          null,
          undefined,
          true,
        ],
      },
    })
    expect(out2.lensesByPage['/mixed']).toBeDefined()
    expect(out2.lensesByPage['/mixed']!.length).toBe(1)
    expect(out2.lensesByPage['/mixed']![0]!.id).toBe('lens-real')
  })

  test('Finding 2: explicit ids are reserved before auto-minting new ones', () => {
    // The case from the finding: [anonymous, anonymous, explicit 'lens-2']
    // should keep the explicit 'lens-2' and give the anonymous entries different ids
    const out = sanitizeAccessibilityPrefs({
      lensesByPage: {
        '/test': [
          { x: 0, y: 0 }, // anonymous
          { x: 1, y: 1 }, // anonymous
          { id: 'lens-2', x: 2, y: 2 }, // explicit
        ],
      },
    })
    const lenses = out.lensesByPage['/test']!
    expect(lenses.length).toBe(3)

    // All three ids should be distinct
    const ids = lenses.map(l => l.id)
    expect(new Set(ids).size).toBe(3)

    // Find each lens by its position (which is preserved through sanitization)
    const lens0 = lenses.find(l => l.x === 0 && l.y === 0)!
    const lens1 = lenses.find(l => l.x === 1 && l.y === 1)!
    const lens2 = lenses.find(l => l.x === 2 && l.y === 2)!

    // The explicit 'lens-2' must be assigned to the entry that declared it
    expect(lens2.id).toBe('lens-2')

    // The anonymous entries must get different ids, not 'lens-2'
    expect(lens0.id).not.toBe('lens-2')
    expect(lens1.id).not.toBe('lens-2')
    expect(lens0.id).not.toBe(lens1.id)

    // The anonymous ids should be from the minted sequence
    expect(['lens-1', 'lens-3']).toContain(lens0.id)
    expect(['lens-1', 'lens-3']).toContain(lens1.id)
  })

  test('idempotency still holds with explicit ids and garbage entries', () => {
    const messy = {
      lensesByPage: {
        '/test': [
          'garbage',
          { x: 0, y: 0 },
          { id: 'custom-id', x: 1, y: 1 },
          42,
        ],
      },
    }
    const once = sanitizeAccessibilityPrefs(messy)
    expect(sanitizeAccessibilityPrefs(once)).toEqual(once)
  })

  // --- globalLenses ---------------------------------------------------------------------------

  test('an absent globalLenses reads as an empty list', () => {
    // Every stored document that exists today has no `globalLenses` key at all. A wrong
    // implementation that defaults it to something other than `[]` (e.g. copying `lensesByPage`'s
    // union, or leaving it `undefined`) would still pass a bare `toEqual(DEFAULT_ACCESSIBILITY_PREFS)`
    // check alone, so this asserts the field directly and on a document that has OTHER content too
    // (an implementation that only special-cases the fully-empty `{}` input would fail this one).
    const out = sanitizeAccessibilityPrefs({ enabled: true, lensesByPage: { '/costs': [{ id: 'a', x: 0, y: 0 }] } })
    expect(out.globalLenses).toEqual([])
    expect('globalLenses' in out).toBe(true)
  })

  test('globalLenses is sanitized with the same rules as a page: clamped, non-objects dropped, ids re-minted', () => {
    const out = sanitizeAccessibilityPrefs({
      globalLenses: [
        'garbage',
        { id: 'dup', x: 0, y: 0, zoom: 999, width: 1 },
        { id: 'dup', x: 0, y: 0 },
        42,
      ],
    })
    // A wrong implementation that just does `Array.isArray(o.globalLenses) ? o.globalLenses : []`
    // (no sanitization at all) would keep 4 entries including the string/number junk and the
    // out-of-range zoom/width — this fails on every count below.
    expect(out.globalLenses.length).toBe(2)
    const first = out.globalLenses[0]!
    expect(first.zoom).toBe(ZOOM_MAX)
    expect(first.width).toBe(LENS_MIN_PX)
    const ids = out.globalLenses.map(l => l.id)
    expect(new Set(ids).size).toBe(2)
    expect(ids[0]).toBe('dup')
  })

  test('a global lens and a page lens sharing an explicit id do not collide — the page one is re-minted', () => {
    // This is the property the whole feature depends on: `useAccessibility`'s `lenses` is
    // `pageLenses ∪ globalLenses`, so if both sanitized to id 'lens-1' independently, the page
    // that lens sits on would render two DIFFERENT lenses answering to the same id — `.find(l =>
    // l.id === id)` would always resolve the first one, silently misdirecting every mutation and
    // the keyboard cycle aimed at the second. A wrong implementation that sanitizes
    // `lensesByPage` and `globalLenses` in two independent calls (each with its own empty `taken`
    // set) would still pass every other test in this file and fail only this one.
    const out = sanitizeAccessibilityPrefs({
      globalLenses: [{ id: 'lens-1', x: 0, y: 0, zoom: 4 }],
      lensesByPage: { '/costs': [{ id: 'lens-1', x: 10, y: 10, zoom: 8 }] },
    })
    const globalOne = out.globalLenses[0]!
    const pageOne = out.lensesByPage['/costs']![0]!
    // The global bucket is sanitized first and keeps its explicit id...
    expect(globalOne.id).toBe('lens-1')
    expect(globalOne.zoom).toBe(4)
    // ...so the page lens, which asked for the same id, must have been re-minted to something else.
    expect(pageOne.id).not.toBe('lens-1')
    expect(pageOne.zoom).toBe(8)
  })

  test('two DIFFERENT pages may still share an id with each other — only the global bucket is exclusive', () => {
    // Existing, deliberate behaviour (see useAccessibility.ts's page-change effect): a lens id is
    // scoped to its own page, and the same 'lens-1' on two different pages is fine because they
    // are never rendered together. Cross-bucket exclusivity must not overreach into cross-PAGE
    // exclusivity — a wrong implementation that made ids globally unique across every page would
    // still be "safe" but would contradict this already-documented invariant.
    const out = sanitizeAccessibilityPrefs({
      lensesByPage: {
        '/a': [{ id: 'lens-1', x: 0, y: 0 }],
        '/b': [{ id: 'lens-1', x: 0, y: 0 }],
      },
    })
    expect(out.lensesByPage['/a']![0]!.id).toBe('lens-1')
    expect(out.lensesByPage['/b']![0]!.id).toBe('lens-1')
  })

  test('idempotency holds with both buckets populated and colliding explicit ids', () => {
    const messy = {
      globalLenses: [{ id: 'lens-1', x: 0, y: 0 }],
      lensesByPage: {
        '/costs': [{ id: 'lens-1', x: 5, y: 5 }, { id: 'dup', x: 1, y: 1 }, { id: 'dup', x: 2, y: 2 }],
      },
    }
    const once = sanitizeAccessibilityPrefs(messy)
    expect(sanitizeAccessibilityPrefs(once)).toEqual(once)
  })
})
