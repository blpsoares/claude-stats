# Accessibility Magnifiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a low-vision user any number of per-page magnifier lenses plus a cursor-following lens in the web dashboard, configured from a new Accessibility settings tab, working identically in machine and central mode.

**Architecture:** Lenses render into `#ag-magnifiers`, a sibling of `#root`, so the DOM mirror inside each lens (a live `cloneNode` of `#root`) can never contain another lens. All arithmetic — sanitising, geometry, clamping, the keyboard reducer, the sync scheduler — lives in pure modules with unit tests; the only DOM-touching module is `magnifierMirror.ts`. Persistence goes through one server resolution that picks `preferences.json` on a machine and a per-account Mongo document on a central, so the frontend makes one call and never learns which mode it is in.

**Tech Stack:** TypeScript (strict), React 19, Vite, Bun test, MongoDB (central only), lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-09-03-accessibility-magnifiers-design.md` — read it before Task 1.

## Global Constraints

- **Everything in this repository is in English**: code, comments, commit messages, PR titles. UI strings are EN + PT pairs (`lang === 'pt' ? … : …`), following the existing components.
- **Lens border colour is always `var(--anthropic-orange)`** in every state and both themes. There is no colour setting. The settings tab states this in one sentence.
- **There is no cap on the number of lenses.** Cost is bounded by the scheduler, never by a limit.
- **`packages/server/*` must never be imported from `packages/web/src/`.** Shared types go in `@agentistics/core`.
- **Dates in Mongo are BSON `Date`, ISO strings on the wire.** Any new stored timestamp is added to `DATE_FIELDS` and `DATE_MIGRATION_VERSION` is bumped.
- **Mobile ships in the same change** (`useIsMobile()`, 768px breakpoint): touch targets ≥ 44px on mobile only, settings inputs ≥ 16px, and `document.documentElement.scrollWidth <= window.innerWidth` must hold at 390px.
- **New `/api` routes are authenticated by default.** Do NOT add them to `AUTH_PUBLIC`; do not touch `authz-gate.test.ts`.
- **Never use browser automation (Playwright / browser MCP) to verify.** It hangs in this environment. Browser verification steps are written as instructions for the human to perform; report what they say, never assume the result.
- **Every task ends with `bun tsc --noEmit` and `bun test` passing**, then a commit.
- Commit trailer for every commit:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```

## Working directory

All paths are relative to the worktree `/home/mithrandir/agentistics/.claude/worktrees/a11y-magnifiers`, branch `feat/accessibility-magnifiers` (based on `origin/dev`). Do not work in the main checkout — other sessions run against it.

---

## File Structure

**Created**

| file | responsibility |
|---|---|
| `packages/core/src/accessibility.ts` | shared types, defaults, `sanitizeAccessibilityPrefs` (pure) |
| `packages/core/src/accessibility.test.ts` | its tests |
| `packages/web/src/lib/magnifier.ts` | page key, lens geometry, clamping, keyboard reducer (pure) |
| `packages/web/src/lib/magnifier.test.ts` | its tests |
| `packages/web/src/lib/mirrorSchedule.ts` | which lenses sync this frame, and the backoff (pure) |
| `packages/web/src/lib/mirrorSchedule.test.ts` | its tests |
| `packages/web/src/lib/magnifierMirror.ts` | the DOM mirror engine — the only DOM-touching module |
| `packages/web/src/components/a11y/Lens.tsx` | one lens: frame, mirror host, controls, drag/resize |
| `packages/web/src/components/a11y/LensMenu.tsx` | one lens's context menu (bottom sheet on mobile) |
| `packages/web/src/components/a11y/MagnifierButton.tsx` | the header icon and its general menu |
| `packages/web/src/components/a11y/MagnifierLayer.tsx` | the portal, the page's lenses, the follow lens, the live region |
| `packages/web/src/components/a11y/i18n.ts` | EN/PT strings for the whole feature |
| `packages/web/src/hooks/useAccessibility.ts` | load/save prefs, expose state and actions |
| `packages/web/src/pages/settings/AccessibilitySettings.tsx` | the settings tab |
| `packages/server/server/a11y-prefs.ts` | pure store resolution + the PUT semantics |
| `packages/server/server/a11y-prefs.test.ts` | its tests |
| `packages/server/server/a11y-routes.ts` | `GET`/`PUT /api/accessibility` |
| `packages/server/server/user-prefs-store.ts` | the central's `userPrefs` collection |

**Modified**

| file | change |
|---|---|
| `packages/core/src/index.ts` | re-export `./accessibility` |
| `packages/server/server/preferences.ts` | `accessibility?: AccessibilityPrefs` on `Preferences` |
| `packages/server/server/mongo-dates.ts` | `userPrefs.updatedAt` in `DATE_FIELDS`; version 2 → 3 |
| `packages/server/server/index.ts` | mount the two routes |
| `packages/server/server/iam-handlers.ts` | delete `userPrefs` when an account is deleted |
| `packages/web/src/lib/settingsSections.ts` | new `accessibility` section |
| `packages/web/src/AppRouter.tsx` | new settings route |
| `packages/web/src/lib/app-context.ts` | `a11y` on `AppContext` |
| `packages/web/src/App.tsx` | mount `MagnifierLayer`; header buttons (mobile + desktop + fallback row) |

---

## Task 1: Shared accessibility types and sanitiser

**Files:**
- Create: `packages/core/src/accessibility.ts`
- Create: `packages/core/src/accessibility.test.ts`
- Modify: `packages/core/src/index.ts` (append to the `export *` block at the end)

**Interfaces:**
- Consumes: nothing.
- Produces: `LensShape`, `LensStyle`, `MagnifierLens`, `AccessibilityPrefs`, `DEFAULT_LENS_STYLE`, `DEFAULT_ACCESSIBILITY_PREFS`, `sanitizeAccessibilityPrefs(input: unknown): AccessibilityPrefs`, and the constants `ZOOM_MIN`, `ZOOM_MAX`, `LENS_MIN_PX`, `LENS_MAX_PX`, `BORDER_MIN_PX`, `BORDER_MAX_PX`, `CORNER_MAX_PX`. Every later task imports these from `@agentistics/core`.

- [ ] **Step 1: Prepare the worktree**

The worktree has no `node_modules`, and `tsc` fails without the generated type stub.

```bash
cd /home/mithrandir/agentistics/.claude/worktrees/a11y-magnifiers
bun install
bun run packages/server/scripts/ensure-type-stub.ts
bun tsc --noEmit
```

Expected: `bun install` completes and `bun tsc --noEmit` prints nothing (exit 0). If `tsc` reports errors about `embedded-dist.generated.ts`, the stub step did not run — re-run it.

- [ ] **Step 2: Write the failing test**

Create `packages/core/src/accessibility.test.ts`:

```ts
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
    const lens = out.lensesByPage['/costs'][0]
    expect(lens.zoom).toBe(ZOOM_MAX)
    expect(lens.width).toBe(LENS_MIN_PX)
    expect(lens.height).toBe(LENS_MIN_PX)
  })

  test('a zoom below the floor is raised to it', () => {
    const out = sanitizeAccessibilityPrefs({
      lensesByPage: { '/': [{ id: 'a', x: 0, y: 0, zoom: 0.1 }] },
    })
    expect(out.lensesByPage['/'][0].zoom).toBe(ZOOM_MIN)
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
    expect(out.lensesByPage['/'][0].shape).toBe('rect')
    const circle = out.lensesByPage['/'][1]
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
    const ids = out.lensesByPage['/'].map(l => l.id)
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
})
```

- [ ] **Step 3: Run it and watch it fail**

```bash
bun test packages/core/src/accessibility.test.ts
```

Expected: FAIL — `Cannot find module './accessibility'`.

- [ ] **Step 4: Write the implementation**

Create `packages/core/src/accessibility.ts`:

```ts
/**
 * accessibility.ts — the magnifier lenses' shared vocabulary.
 *
 * PURE and TOTAL. `sanitizeAccessibilityPrefs` is called on BOTH sides of the wire: the server
 * before it stores, the browser before it renders. A hand-edited `preferences.json` or a stale
 * client must never be able to blank the dashboard or draw a lens with a NaN transform, so every
 * number is clamped rather than rejected and every unknown shape falls back.
 *
 * Border COLOUR is deliberately absent: a lens is always the site orange, in every state and both
 * themes. Thickness and shape are the user's; the colour is the product's.
 */

export type LensShape = 'circle' | 'rect'

/** The look of a lens, shared by placed lenses and by the cursor-following one. */
export interface LensStyle {
  shape: LensShape
  /** px. For a circle this is the DIAMETER and `height` is kept equal to it. */
  width: number
  height: number
  /** How many times magnified. */
  zoom: number
  borderWidth: number
  /** px, rectangles only; ignored while `shape === 'circle'`. */
  cornerRadius: number
}

/** A lens the user placed on one page. Coordinates are viewport px — a lens is position:fixed. */
export interface MagnifierLens extends LensStyle {
  id: string
  x: number
  y: number
  /** Pinned = glass: controls hidden and pointer events pass straight through. */
  pinned: boolean
}

export interface AccessibilityPrefs {
  /** The master switch. Off means no lens layer and no observer at all — the cost is zero. */
  enabled: boolean
  followLens: LensStyle
  newLensDefaults: LensStyle
  /** Keyed by EXACT pathname (query and hash ignored) — see `pageKey` in the web package. */
  lensesByPage: Record<string, MagnifierLens[]>
}

export const ZOOM_MIN = 1.5
export const ZOOM_MAX = 20
export const LENS_MIN_PX = 60
export const LENS_MAX_PX = 2000
export const BORDER_MIN_PX = 1
export const BORDER_MAX_PX = 12
export const CORNER_MAX_PX = 200

export const DEFAULT_LENS_STYLE: LensStyle = {
  shape: 'rect',
  width: 360,
  height: 240,
  zoom: 2.5,
  borderWidth: 3,
  cornerRadius: 12,
}

export const DEFAULT_ACCESSIBILITY_PREFS: AccessibilityPrefs = {
  enabled: false,
  followLens: { ...DEFAULT_LENS_STYLE, shape: 'circle', width: 260, height: 260 },
  newLensDefaults: { ...DEFAULT_LENS_STYLE },
  lensesByPage: {},
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function sanitizeStyle(input: unknown, fallback: LensStyle): LensStyle {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const shape: LensShape = o.shape === 'circle' ? 'circle' : o.shape === 'rect' ? 'rect' : fallback.shape
  const width = num(o.width, fallback.width, LENS_MIN_PX, LENS_MAX_PX)
  return {
    shape,
    width,
    // A circle has one dimension. Keeping height equal to width means no later reader has to
    // remember which of the two is "the real one".
    height: shape === 'circle' ? width : num(o.height, fallback.height, LENS_MIN_PX, LENS_MAX_PX),
    zoom: num(o.zoom, fallback.zoom, ZOOM_MIN, ZOOM_MAX),
    borderWidth: num(o.borderWidth, fallback.borderWidth, BORDER_MIN_PX, BORDER_MAX_PX),
    cornerRadius: num(o.cornerRadius, fallback.cornerRadius, 0, CORNER_MAX_PX),
  }
}

/** Deterministic, so sanitising twice yields the same ids — which is what makes it idempotent. */
function mintLensId(taken: Set<string>): string {
  let n = 1
  while (taken.has(`lens-${n}`)) n++
  return `lens-${n}`
}

export function sanitizeAccessibilityPrefs(input: unknown): AccessibilityPrefs {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const newLensDefaults = sanitizeStyle(o.newLensDefaults, DEFAULT_ACCESSIBILITY_PREFS.newLensDefaults)
  const followLens = sanitizeStyle(o.followLens, DEFAULT_ACCESSIBILITY_PREFS.followLens)

  const rawPages =
    o.lensesByPage && typeof o.lensesByPage === 'object'
      ? (o.lensesByPage as Record<string, unknown>)
      : {}

  const lensesByPage: Record<string, MagnifierLens[]> = {}
  for (const [page, raw] of Object.entries(rawPages)) {
    // A page key is a pathname. Anything else is not addressable and would strand its lenses.
    if (!page.startsWith('/')) continue
    if (!Array.isArray(raw)) continue
    const taken = new Set<string>()
    const lenses: MagnifierLens[] = []
    for (const item of raw) {
      const io = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
      const style = sanitizeStyle(io, newLensDefaults)
      let id = typeof io.id === 'string' && io.id.trim() !== '' ? io.id.trim() : ''
      if (id === '' || taken.has(id)) id = mintLensId(taken)
      taken.add(id)
      lenses.push({
        ...style,
        id,
        // Position is NOT clamped here: the viewport is a browser fact and this module runs on the
        // server too. `clampLens` in the web package does that, on every render.
        x: num(io.x, 0, -LENS_MAX_PX, 100000),
        y: num(io.y, 0, -LENS_MAX_PX, 100000),
        pinned: io.pinned === true,
      })
    }
    // An empty page is not a page. Keeping the key would grow the document forever as pages are
    // visited and cleared.
    if (lenses.length > 0) lensesByPage[page] = lenses
  }

  return { enabled: o.enabled === true, followLens, newLensDefaults, lensesByPage }
}
```

- [ ] **Step 5: Export it from the barrel**

Append one line to the end of `packages/core/src/index.ts`:

```ts
export * from './accessibility'
```

- [ ] **Step 6: Run the tests and the type check**

```bash
bun test packages/core/src/accessibility.test.ts
bun tsc --noEmit
```

Expected: 9 tests pass; `tsc` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/accessibility.ts packages/core/src/accessibility.test.ts packages/core/src/index.ts
git commit -m "feat(core): the magnifier lens vocabulary, sanitised on both sides of the wire

sanitizeAccessibilityPrefs is total: a hand-edited preferences.json or a stale client cannot
produce a NaN transform, because every number is clamped rather than rejected. Id minting is
deterministic, which is what makes sanitising twice a no-op.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Lens geometry, clamping and the keyboard reducer

**Files:**
- Create: `packages/web/src/lib/magnifier.ts`
- Create: `packages/web/src/lib/magnifier.test.ts`

**Interfaces:**
- Consumes: `MagnifierLens`, `LensStyle`, `ZOOM_MIN`, `ZOOM_MAX`, `LENS_MIN_PX`, `LENS_MAX_PX` from `@agentistics/core`.
- Produces: `Rect`, `Viewport`, `KeyMods`, `LensKeyResult`, `pageKey(pathname)`, `sourceRect(lens)`, `stageTransform(lens)`, `clampLens(lens, viewport)`, `applyLensKey(lens, key, mods)`, `newLens(style, viewport, takenIds)`, and the constants `MOVE_STEP_PX`, `MOVE_FINE_PX`, `RESIZE_STEP_PX`, `ZOOM_STEP`.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/lib/magnifier.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import type { MagnifierLens } from '@agentistics/core'
import { ZOOM_MAX, ZOOM_MIN, LENS_MIN_PX } from '@agentistics/core'
import {
  pageKey,
  sourceRect,
  stageTransform,
  clampLens,
  applyLensKey,
  newLens,
  MOVE_STEP_PX,
  MOVE_FINE_PX,
  RESIZE_STEP_PX,
  ZOOM_STEP,
} from './magnifier'

const lens = (over: Partial<MagnifierLens> = {}): MagnifierLens => ({
  id: 'a', x: 100, y: 100, width: 400, height: 300, zoom: 4,
  shape: 'rect', borderWidth: 3, cornerRadius: 12, pinned: false,
  ...over,
})

const NO_MODS = { shift: false, alt: false, ctrl: false, meta: false }

describe('pageKey', () => {
  test('drops query and hash', () => {
    expect(pageKey('/costs?range=30d')).toBe('/costs')
    expect(pageKey('/costs#top')).toBe('/costs')
    expect(pageKey('/costs?a=1#top')).toBe('/costs')
  })
  test('normalises a trailing slash but keeps the root', () => {
    expect(pageKey('/costs/')).toBe('/costs')
    expect(pageKey('/')).toBe('/')
    expect(pageKey('')).toBe('/')
  })
  test('keeps distinct dynamic routes distinct', () => {
    expect(pageKey('/repo/github.com/org/api')).not.toBe(pageKey('/repo/github.com/org/web'))
  })
})

describe('sourceRect', () => {
  test('is the region under the lens, shrunk by the zoom and centred on the lens', () => {
    expect(sourceRect(lens())).toEqual({ x: 250, y: 212.5, width: 100, height: 75 })
  })
  test('at 1.5x it is larger than at 10x, centred on the same point', () => {
    const low = sourceRect(lens({ zoom: 1.5 }))
    const high = sourceRect(lens({ zoom: 10 }))
    expect(low.width).toBeGreaterThan(high.width)
    expect(low.x + low.width / 2).toBeCloseTo(high.x + high.width / 2)
  })
})

describe('stageTransform', () => {
  test('scales by the zoom and translates the source origin to zero', () => {
    expect(stageTransform(lens())).toEqual({ scale: 4, tx: -250, ty: -212.5 })
  })
})

describe('clampLens', () => {
  const vp = { width: 1000, height: 800 }
  test('keeps a lens fully on screen', () => {
    expect(clampLens(lens({ x: 5000, y: 5000 }), vp)).toMatchObject({ x: 600, y: 500 })
    expect(clampLens(lens({ x: -999, y: -999 }), vp)).toMatchObject({ x: 0, y: 0 })
  })
  test('clamps zoom to the bounds', () => {
    expect(clampLens(lens({ zoom: 999 }), vp).zoom).toBe(ZOOM_MAX)
    expect(clampLens(lens({ zoom: 0 }), vp).zoom).toBe(ZOOM_MIN)
  })
  test('never lets a lens be smaller than the floor or wider than the viewport', () => {
    expect(clampLens(lens({ width: 1 }), vp).width).toBe(LENS_MIN_PX)
    expect(clampLens(lens({ width: 9999 }), vp).width).toBe(1000)
  })
  test('a circle keeps one dimension and fits the shorter viewport side', () => {
    const c = clampLens(lens({ shape: 'circle', width: 9999, height: 10 }), vp)
    expect(c.width).toBe(c.height)
    expect(c.width).toBe(800)
  })
})

describe('applyLensKey', () => {
  test('arrows move by the coarse step, alt by the fine one', () => {
    expect(applyLensKey(lens(), 'ArrowRight', NO_MODS)).toMatchObject({ x: 100 + MOVE_STEP_PX })
    expect(applyLensKey(lens(), 'ArrowUp', { ...NO_MODS, alt: true })).toMatchObject({ y: 100 - MOVE_FINE_PX })
  })
  test('shift+arrows resize instead of moving', () => {
    expect(applyLensKey(lens(), 'ArrowRight', { ...NO_MODS, shift: true })).toMatchObject({
      x: 100, width: 400 + RESIZE_STEP_PX,
    })
    expect(applyLensKey(lens(), 'ArrowDown', { ...NO_MODS, shift: true })).toMatchObject({
      height: 300 + RESIZE_STEP_PX,
    })
  })
  test('a circle resizes on every arrow, because it has one dimension', () => {
    const grown = applyLensKey(lens({ shape: 'circle', height: 400 }), 'ArrowUp', { ...NO_MODS, shift: true })
    expect(grown).toMatchObject({ width: 400 + RESIZE_STEP_PX, height: 400 + RESIZE_STEP_PX })
  })
  test('plus and minus step the zoom', () => {
    expect(applyLensKey(lens(), '+', NO_MODS)).toMatchObject({ zoom: 4 + ZOOM_STEP })
    expect(applyLensKey(lens(), '-', NO_MODS)).toMatchObject({ zoom: 4 - ZOOM_STEP })
    expect(applyLensKey(lens(), '=', NO_MODS)).toMatchObject({ zoom: 4 + ZOOM_STEP })
  })
  test('P toggles pinned, in either direction', () => {
    expect(applyLensKey(lens(), 'p', NO_MODS)).toMatchObject({ pinned: true })
    expect(applyLensKey(lens({ pinned: true }), 'P', NO_MODS)).toMatchObject({ pinned: false })
  })
  test('Delete removes and Escape deselects', () => {
    expect(applyLensKey(lens(), 'Delete', NO_MODS)).toBe('remove')
    expect(applyLensKey(lens(), 'Backspace', NO_MODS)).toBe('remove')
    expect(applyLensKey(lens(), 'Escape', NO_MODS)).toBe('deselect')
  })
  test('an unrelated key falls through to the page', () => {
    expect(applyLensKey(lens(), 'a', NO_MODS)).toBeNull()
    expect(applyLensKey(lens(), 'Tab', NO_MODS)).toBeNull()
  })
  test('a ctrl or meta chord is never ours — the app keeps its own shortcuts', () => {
    expect(applyLensKey(lens(), 'ArrowRight', { ...NO_MODS, ctrl: true })).toBeNull()
    expect(applyLensKey(lens(), 'p', { ...NO_MODS, meta: true })).toBeNull()
  })
})

describe('newLens', () => {
  test('lands centred in the viewport with an id nobody else holds', () => {
    const style = { shape: 'rect' as const, width: 400, height: 300, zoom: 3, borderWidth: 3, cornerRadius: 12 }
    const made = newLens(style, { width: 1000, height: 800 }, new Set(['lens-1']))
    expect(made.id).toBe('lens-2')
    expect(made.x).toBe(300)
    expect(made.y).toBe(250)
    expect(made.pinned).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test packages/web/src/lib/magnifier.test.ts
```

Expected: FAIL — `Cannot find module './magnifier'`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/lib/magnifier.ts`:

```ts
/**
 * magnifier.ts — every number a lens needs, and nothing that touches the DOM.
 *
 * The lens is `position: fixed`, so all coordinates here are VIEWPORT pixels. The mirror inside a
 * lens is a viewport-sized stage carrying a transform; `stageTransform` is the only place that
 * transform is decided, so the renderer cannot disagree with the geometry the keyboard edits.
 */
import type { LensStyle, MagnifierLens } from '@agentistics/core'
import { LENS_MAX_PX, LENS_MIN_PX, ZOOM_MAX, ZOOM_MIN } from '@agentistics/core'

export interface Rect { x: number; y: number; width: number; height: number }
export interface Viewport { width: number; height: number }
export interface KeyMods { shift: boolean; alt: boolean; ctrl: boolean; meta: boolean }
export type LensKeyResult = MagnifierLens | 'remove' | 'deselect' | null

export const MOVE_STEP_PX = 10
export const MOVE_FINE_PX = 1
export const RESIZE_STEP_PX = 10
export const ZOOM_STEP = 0.5

/**
 * A lens belongs to one EXACT pathname. Query and hash are dropped on purpose: applying a filter
 * is not arriving at a different page, and a lens that vanished when a date preset changed would
 * read as a bug.
 */
export function pageKey(pathname: string): string {
  const p = pathname.split('?')[0].split('#')[0]
  if (p === '' || p === '/') return '/'
  return p.endsWith('/') ? p.slice(0, -1) : p
}

/** The viewport region a lens magnifies: centred on the lens, shrunk by the zoom. */
export function sourceRect(lens: LensStyle & { x: number; y: number }): Rect {
  const width = lens.width / lens.zoom
  const height = lens.height / lens.zoom
  return {
    x: lens.x + lens.width / 2 - width / 2,
    y: lens.y + lens.height / 2 - height / 2,
    width,
    height,
  }
}

/**
 * What the stage's `transform` must be. The stage is viewport-sized with `transform-origin: 0 0`,
 * so `scale(s) translate(tx, ty)` maps viewport point p to `s * (p + t)`; putting the source
 * origin at zero means `t = -source.origin`.
 */
export function stageTransform(lens: LensStyle & { x: number; y: number }): { scale: number; tx: number; ty: number } {
  const s = sourceRect(lens)
  return { scale: lens.zoom, tx: -s.x, ty: -s.y }
}

/**
 * Keeps a lens usable: on screen, within the size floor/ceiling, within the zoom bounds. Applied
 * after EVERY edit — drag, resize, keypress, window resize — because a lens parked outside the
 * viewport is one no gesture can reach again.
 */
export function clampLens(lens: MagnifierLens, vp: Viewport): MagnifierLens {
  const maxW = Math.max(LENS_MIN_PX, Math.min(LENS_MAX_PX, vp.width))
  const maxH = Math.max(LENS_MIN_PX, Math.min(LENS_MAX_PX, vp.height))

  let width: number
  let height: number
  if (lens.shape === 'circle') {
    const d = Math.min(Math.max(lens.width, LENS_MIN_PX), Math.min(maxW, maxH))
    width = d
    height = d
  } else {
    width = Math.min(Math.max(lens.width, LENS_MIN_PX), maxW)
    height = Math.min(Math.max(lens.height, LENS_MIN_PX), maxH)
  }

  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, lens.zoom))
  const x = Math.min(Math.max(lens.x, 0), Math.max(0, vp.width - width))
  const y = Math.min(Math.max(lens.y, 0), Math.max(0, vp.height - height))
  return { ...lens, width, height, zoom, x, y }
}

/**
 * The keyboard reducer. Returns `null` when the key was not ours — the caller MUST then let the
 * event through, or the dashboard stops responding to its own shortcuts. Clamping is the caller's
 * job (it owns the viewport).
 */
export function applyLensKey(lens: MagnifierLens, key: string, mods: KeyMods): LensKeyResult {
  // A ctrl/meta chord belongs to the browser or to the app, never to a lens.
  if (mods.ctrl || mods.meta) return null

  const arrows: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  }
  const dir = arrows[key]
  if (dir) {
    const [dx, dy] = dir
    if (mods.shift) {
      if (lens.shape === 'circle') {
        // One dimension, so every arrow has to act on it: right/up grow, left/down shrink.
        const delta = (dx !== 0 ? dx : -dy) * RESIZE_STEP_PX
        return { ...lens, width: lens.width + delta, height: lens.height + delta }
      }
      return {
        ...lens,
        width: lens.width + dx * RESIZE_STEP_PX,
        height: lens.height + dy * RESIZE_STEP_PX,
      }
    }
    const step = mods.alt ? MOVE_FINE_PX : MOVE_STEP_PX
    return { ...lens, x: lens.x + dx * step, y: lens.y + dy * step }
  }

  if (key === '+' || key === '=') return { ...lens, zoom: lens.zoom + ZOOM_STEP }
  if (key === '-' || key === '_') return { ...lens, zoom: lens.zoom - ZOOM_STEP }
  if (key === 'p' || key === 'P') return { ...lens, pinned: !lens.pinned }
  if (key === 'Delete' || key === 'Backspace') return 'remove'
  if (key === 'Escape') return 'deselect'
  return null
}

/** A new lens, centred in the viewport, with an id no sibling holds. */
export function newLens(style: LensStyle, vp: Viewport, taken: Set<string>): MagnifierLens {
  let n = 1
  while (taken.has(`lens-${n}`)) n++
  return {
    ...style,
    id: `lens-${n}`,
    x: Math.round(vp.width / 2 - style.width / 2),
    y: Math.round(vp.height / 2 - style.height / 2),
    pinned: false,
  }
}
```

- [ ] **Step 4: Run the tests and the type check**

```bash
bun test packages/web/src/lib/magnifier.test.ts
bun tsc --noEmit
```

Expected: all tests pass; `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/magnifier.ts packages/web/src/lib/magnifier.test.ts
git commit -m "feat(web): lens geometry, clamping and the keyboard reducer, all pure

stageTransform is the ONE place the mirror's transform is decided, so the renderer cannot
disagree with the geometry the keyboard edits. applyLensKey returns null for a key that is not
ours — a reducer that swallowed everything would take the dashboard's own shortcuts with it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: The mirror scheduler

**Files:**
- Create: `packages/web/src/lib/mirrorSchedule.ts`
- Create: `packages/web/src/lib/mirrorSchedule.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MirrorLensState`, `MirrorScheduleConfig`, `MIRROR_DEFAULTS`, `MIRROR_BUDGET_MS`, `MIRROR_MAX_INTERVAL_MS`, `pickLensesToSync(lenses, nowMs, cfg)`, `nextMinInterval(cycleMs, current)`.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/lib/mirrorSchedule.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import {
  pickLensesToSync,
  nextMinInterval,
  MIRROR_DEFAULTS,
  MIRROR_BUDGET_MS,
  MIRROR_MAX_INTERVAL_MS,
  type MirrorLensState,
} from './mirrorSchedule'

const state = (over: Partial<MirrorLensState> & { id: string }): MirrorLensState => ({
  dirty: false, onScreen: true, lastSyncMs: 0, ...over,
})

describe('pickLensesToSync', () => {
  test('never picks more than maxPerFrame, so twenty lenses cost ten frames, not one', () => {
    const many = Array.from({ length: 20 }, (_, i) => state({ id: `l${i}`, dirty: true, lastSyncMs: 0 }))
    expect(pickLensesToSync(many, 1000, MIRROR_DEFAULTS)).toHaveLength(MIRROR_DEFAULTS.maxPerFrame)
  })

  test('picks the least recently synced first — that is the round robin', () => {
    const lenses = [
      state({ id: 'new', dirty: true, lastSyncMs: 900 }),
      state({ id: 'old', dirty: true, lastSyncMs: 100 }),
      state({ id: 'mid', dirty: true, lastSyncMs: 500 }),
    ]
    expect(pickLensesToSync(lenses, 2000, MIRROR_DEFAULTS)).toEqual(['old', 'mid'])
  })

  test('an off-screen lens is never synced, however dirty', () => {
    const lenses = [state({ id: 'hidden', dirty: true, onScreen: false, lastSyncMs: 0 })]
    expect(pickLensesToSync(lenses, 10_000, MIRROR_DEFAULTS)).toEqual([])
  })

  test('a dirty lens waits out the minimum interval', () => {
    const lenses = [state({ id: 'a', dirty: true, lastSyncMs: 1000 })]
    expect(pickLensesToSync(lenses, 1000 + MIRROR_DEFAULTS.minIntervalMs - 1, MIRROR_DEFAULTS)).toEqual([])
    expect(pickLensesToSync(lenses, 1000 + MIRROR_DEFAULTS.minIntervalMs, MIRROR_DEFAULTS)).toEqual(['a'])
  })

  test('a clean lens still syncs on the heartbeat — canvas paint moves no DOM', () => {
    const lenses = [state({ id: 'a', dirty: false, lastSyncMs: 0 })]
    expect(pickLensesToSync(lenses, MIRROR_DEFAULTS.heartbeatMs - 1, MIRROR_DEFAULTS)).toEqual([])
    expect(pickLensesToSync(lenses, MIRROR_DEFAULTS.heartbeatMs, MIRROR_DEFAULTS)).toEqual(['a'])
  })
})

describe('nextMinInterval', () => {
  test('a cycle over budget doubles the interval', () => {
    expect(nextMinInterval(MIRROR_BUDGET_MS + 1, 100)).toBe(200)
  })
  test('the backoff is capped', () => {
    expect(nextMinInterval(999, MIRROR_MAX_INTERVAL_MS)).toBe(MIRROR_MAX_INTERVAL_MS)
  })
  test('a cheap cycle recovers gradually, never below the floor', () => {
    expect(nextMinInterval(1, 400)).toBe(300)
    expect(nextMinInterval(1, MIRROR_DEFAULTS.minIntervalMs)).toBe(MIRROR_DEFAULTS.minIntervalMs)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test packages/web/src/lib/mirrorSchedule.test.ts
```

Expected: FAIL — `Cannot find module './mirrorSchedule'`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/lib/mirrorSchedule.ts`:

```ts
/**
 * mirrorSchedule.ts — how much mirroring work one frame is allowed to do.
 *
 * There is no cap on the number of lenses, so the cost has to be bounded somewhere else. It is
 * bounded here: at most `maxPerFrame` lenses re-clone per frame, oldest first, off-screen lenses
 * never, and the floor between two syncs of the same lens BACKS OFF when a measured cycle blows
 * the budget. Twenty lenses therefore cost ten frames of catching up rather than one frame of
 * twenty clones.
 *
 * PURE — no timers, no DOM. The caller passes `nowMs`.
 */

export interface MirrorLensState {
  id: string
  /** Something under this lens changed since it last synced. */
  dirty: boolean
  /** False when the lens rectangle is off-screen; such a lens is skipped entirely. */
  onScreen: boolean
  lastSyncMs: number
}

export interface MirrorScheduleConfig {
  minIntervalMs: number
  heartbeatMs: number
  maxPerFrame: number
}

export const MIRROR_DEFAULTS: MirrorScheduleConfig = {
  minIntervalMs: 100,
  heartbeatMs: 500,
  maxPerFrame: 2,
}

/** Above this, one sync cycle is eating the frame and the interval backs off. */
export const MIRROR_BUDGET_MS = 8
export const MIRROR_MAX_INTERVAL_MS = 1000

export function pickLensesToSync(
  lenses: readonly MirrorLensState[],
  nowMs: number,
  cfg: MirrorScheduleConfig,
): string[] {
  return lenses
    .filter(l => {
      if (!l.onScreen) return false
      // A clean lens still needs the heartbeat: a canvas repaint and a CSS animation move no DOM,
      // so the MutationObserver never marks them dirty.
      const wait = l.dirty ? cfg.minIntervalMs : cfg.heartbeatMs
      return nowMs - l.lastSyncMs >= wait
    })
    .slice()
    .sort((a, b) => a.lastSyncMs - b.lastSyncMs)
    .slice(0, cfg.maxPerFrame)
    .map(l => l.id)
}

/** Doubling on overrun, three-quarters on recovery: fast to protect, slow to spend again. */
export function nextMinInterval(cycleMs: number, current: number): number {
  if (cycleMs > MIRROR_BUDGET_MS) return Math.min(MIRROR_MAX_INTERVAL_MS, current * 2)
  return Math.max(MIRROR_DEFAULTS.minIntervalMs, Math.round(current * 0.75))
}
```

- [ ] **Step 4: Run the tests and the type check**

```bash
bun test packages/web/src/lib/mirrorSchedule.test.ts
bun tsc --noEmit
```

Expected: all tests pass; `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/lib/mirrorSchedule.ts packages/web/src/lib/mirrorSchedule.test.ts
git commit -m "feat(web): bound the mirror's cost per frame instead of capping the lenses

The user asked for no lens limit, so the budget lives here: two clones a frame, oldest first,
off-screen never, and a floor that doubles when a measured cycle overruns. A clean lens still
syncs on the heartbeat, because a canvas repaint moves no DOM for an observer to see.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Where accessibility preferences are stored (pure resolution)

**Files:**
- Create: `packages/server/server/a11y-prefs.ts`
- Create: `packages/server/server/a11y-prefs.test.ts`

**Interfaces:**
- Consumes: `AccessibilityPrefs`, `DEFAULT_ACCESSIBILITY_PREFS`, `sanitizeAccessibilityPrefs` from `@agentistics/core`.
- Produces: `A11yStore` (`{kind:'machine'} | {kind:'account', accountId} | {kind:'anonymous'}`), `resolveA11yStore(central, accountId)`, `applyA11yPut(incoming): AccessibilityPrefs`. Task 5 imports both functions.

- [ ] **Step 1: Write the failing test**

Create `packages/server/server/a11y-prefs.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { DEFAULT_ACCESSIBILITY_PREFS, ZOOM_MAX } from '@agentistics/core'
import { resolveA11yStore, applyA11yPut } from './a11y-prefs'

describe('resolveA11yStore', () => {
  test('a machine stores in its own preferences file, signed in or not', () => {
    expect(resolveA11yStore(false, null)).toEqual({ kind: 'machine' })
    expect(resolveA11yStore(false, 'acct-1')).toEqual({ kind: 'machine' })
  })

  test('a central stores per ACCOUNT — one operator must not configure everyone', () => {
    expect(resolveA11yStore(true, 'acct-1')).toEqual({ kind: 'account', accountId: 'acct-1' })
    expect(resolveA11yStore(true, 'acct-2')).toEqual({ kind: 'account', accountId: 'acct-2' })
  })

  test('a central session with no account resolves to anonymous, never to the machine file', () => {
    expect(resolveA11yStore(true, null)).toEqual({ kind: 'anonymous' })
    expect(resolveA11yStore(true, '')).toEqual({ kind: 'anonymous' })
  })
})

describe('applyA11yPut', () => {
  test('it REPLACES rather than merges, so the last lens of a page can be deleted', () => {
    const emptied = applyA11yPut({ enabled: true, lensesByPage: {} })
    expect(emptied.lensesByPage).toEqual({})
  })

  test('it sanitises, so a stale client cannot store an impossible lens', () => {
    const out = applyA11yPut({ enabled: true, lensesByPage: { '/': [{ id: 'a', x: 0, y: 0, zoom: 1e9 }] } })
    expect(out.lensesByPage['/'][0].zoom).toBe(ZOOM_MAX)
  })

  test('junk yields the defaults instead of throwing', () => {
    expect(applyA11yPut(undefined)).toEqual(DEFAULT_ACCESSIBILITY_PREFS)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test packages/server/server/a11y-prefs.test.ts
```

Expected: FAIL — `Cannot find module './a11y-prefs'`.

- [ ] **Step 3: Write the implementation**

Create `packages/server/server/a11y-prefs.ts`:

```ts
/**
 * a11y-prefs.ts — the ONE place that decides where a person's accessibility settings live.
 *
 * `/api/preferences` could not be reused: it reads and writes `~/.agentistics/preferences.json`,
 * which is per MACHINE. On a central that file belongs to the container and is shared by every
 * signed-in user, so one person's magnifiers would appear on everyone's screen. An accessibility
 * configuration is the most personal setting this product has.
 *
 * The resolution is PURE and the frontend never sees it: one endpoint, one call, and the mode is
 * the server's problem — the same shape as `central-runtime.ts`.
 */
import type { AccessibilityPrefs } from '@agentistics/core'
import { sanitizeAccessibilityPrefs } from '@agentistics/core'

export type A11yStore =
  | { kind: 'machine' }
  | { kind: 'account'; accountId: string }
  /** A central reached with a legacy password-only session: readable, not writable. */
  | { kind: 'anonymous' }

export function resolveA11yStore(central: boolean, accountId: string | null): A11yStore {
  if (!central) return { kind: 'machine' }
  if (accountId) return { kind: 'account', accountId }
  // Deliberately NOT the machine file. Falling back to it on a central is exactly the bug this
  // module exists to prevent, and it would stay invisible until two people compared screens.
  return { kind: 'anonymous' }
}

/**
 * A PUT carries the whole object and REPLACES what is stored. It must not deep-merge per page:
 * treating an absent key as "unchanged" would make deleting the last lens of a page impossible.
 */
export function applyA11yPut(incoming: unknown): AccessibilityPrefs {
  return sanitizeAccessibilityPrefs(incoming)
}
```

- [ ] **Step 4: Run the tests and the type check**

```bash
bun test packages/server/server/a11y-prefs.test.ts
bun tsc --noEmit
```

Expected: all tests pass; `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/a11y-prefs.ts packages/server/server/a11y-prefs.test.ts
git commit -m "feat(server): decide once where accessibility settings live

/api/preferences is per MACHINE, so on a central one person's magnifiers would appear on every
signed-in screen. A central with no account resolves to 'anonymous' and never to the machine
file — that fallback is the bug this module exists to prevent.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: The two stores and the API routes

**Files:**
- Create: `packages/server/server/user-prefs-store.ts`
- Create: `packages/server/server/a11y-routes.ts`
- Modify: `packages/server/server/preferences.ts` (the `Preferences` interface)
- Modify: `packages/server/server/mongo-dates.ts` (`DATE_FIELDS`, `DATE_MIGRATION_VERSION`)
- Modify: `packages/server/server/index.ts` (mount the routes)
- Modify: `packages/server/server/iam-handlers.ts` (delete prefs with the account)

**Interfaces:**
- Consumes: `resolveA11yStore`, `applyA11yPut` (Task 4); `getMongoDb` from `./mongo`; `getPrincipal` from `./auth`; `TEAM_CENTRAL` from `./config`; `readPreferences`, `writePreferences` from `./preferences`.
- Produces: `handleAccessibility(req: Request): Promise<Response>` (mounted in `index.ts`), `readUserAccessibility`, `writeUserAccessibility`, `deleteUserPrefs`. The wire shape is the bare `AccessibilityPrefs` object in both directions.

- [ ] **Step 1: Add the field to `Preferences`**

In `packages/server/server/preferences.ts`, extend the existing type-only import from `@agentistics/core` with `AccessibilityPrefs`:

```ts
import type { AccessibilityPrefs, BillingSettings, SavedComparison, TeamConfig } from '@agentistics/core'
```

and add the field immediately after `installDismissed?: boolean`:

```ts
  /** Magnifier lenses and their settings, for a MACHINE. On a central the same object lives per
   *  account in the `userPrefs` collection instead — see a11y-prefs.ts, which owns that choice. */
  accessibility?: AccessibilityPrefs
```

- [ ] **Step 2: Create the central's per-account store**

Create `packages/server/server/user-prefs-store.ts`:

```ts
/**
 * user-prefs-store.ts — the central's per-ACCOUNT UI preferences (`userPrefs` collection).
 *
 * A collection of its own rather than a field on AccountDoc: accounts are listed by the governance
 * panels and mapped to `PublicAccount`, and UI preferences have no business travelling with an
 * identity record.
 */
import type { Collection } from 'mongodb'
import type { AccessibilityPrefs } from '@agentistics/core'
import { getMongoDb } from './mongo'

export interface UserPrefsDoc {
  /** The accountId. */
  _id: string
  accessibility?: AccessibilityPrefs
  /** BSON Date — see mongo-dates.ts. */
  updatedAt: Date
}

async function collection(): Promise<Collection<UserPrefsDoc>> {
  const db = await getMongoDb()
  return db.collection<UserPrefsDoc>('userPrefs')
}

export async function readUserAccessibility(accountId: string): Promise<AccessibilityPrefs | null> {
  const doc = await (await collection()).findOne({ _id: accountId })
  return doc?.accessibility ?? null
}

export async function writeUserAccessibility(accountId: string, prefs: AccessibilityPrefs): Promise<void> {
  await (await collection()).updateOne(
    { _id: accountId },
    { $set: { accessibility: prefs, updatedAt: new Date() } },
    { upsert: true },
  )
}

/** Called when an account is deleted — its preferences have no owner left. */
export async function deleteUserPrefs(accountId: string): Promise<void> {
  await (await collection()).deleteOne({ _id: accountId })
}
```

- [ ] **Step 3: Register the new timestamp**

In `packages/server/server/mongo-dates.ts`, add one entry to `DATE_FIELDS` after the `envelopes` line:

```ts
  { collection: 'envelopes', fields: ['createdAt'] },
  // Per-account UI preferences (accessibility). One timestamp, same rule as everything above.
  { collection: 'userPrefs', fields: ['updatedAt'] },
]
```

and bump the version, or an already-migrated deployment never re-runs for the new field:

```ts
export const DATE_MIGRATION_VERSION = 3
```

- [ ] **Step 4: The helper signatures this task uses (already verified — no need to re-check)**

- `readJsonLimited<T>(req, maxBytes)` returns `{ ok: true; value: T } | { ok: false; error: 'too_large' | 'invalid_json' }` — it does **not** return the value directly.
- `safeError(err, { verbose })` returns `{ body, logLine }`; `verbose` is `PROFILE === 'local'`, with `PROFILE` exported from `./exposure`.
- **`CORS_HEADERS` is NOT importable.** It is a per-request local in `index.ts`, built by `corsHeadersFor(...)`. The handler therefore takes it as a parameter.
- `writePreferences(prefs)` performs a shallow **merge** over the stored document (`{ ...current, ...prefs }`), so writing one field leaves language, theme, layouts and central connections untouched.
- `getMongoDb()` is the Mongo accessor, exported from `./mongo`.

- [ ] **Step 5: Write the routes**

Create `packages/server/server/a11y-routes.ts`:

```ts
/**
 * a11y-routes.ts — GET/PUT /api/accessibility.
 *
 * Authenticated by the default rule: these paths are NOT in AUTH_PUBLIC. They touch no host power
 * beyond the preferences file `/api/preferences` already writes, so they are not registered in
 * capability-guard.ts either.
 *
 * CORS headers are PASSED IN rather than imported: `index.ts` builds them per request from the
 * caller's origin, so there is no module-level constant to reach for.
 */
import { DEFAULT_ACCESSIBILITY_PREFS, sanitizeAccessibilityPrefs } from '@agentistics/core'
import { getPrincipal } from './auth'
import { TEAM_CENTRAL } from './config'
import { PROFILE } from './exposure'
import { readPreferences, writePreferences } from './preferences'
import { readUserAccessibility, writeUserAccessibility } from './user-prefs-store'
import { applyA11yPut, resolveA11yStore } from './a11y-prefs'
import { readJsonLimited } from './limits'
import { safeError } from './errors'

/** A lens document is small; a body larger than this is not one. */
const MAX_BODY_BYTES = 64 * 1024

export async function handleAccessibility(
  req: Request,
  cors: Record<string, string>,
): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })

  try {
    const principal = await getPrincipal(req)
    const store = resolveA11yStore(TEAM_CENTRAL, principal?.accountId ?? null)

    if (req.method === 'GET') {
      if (store.kind === 'machine') {
        return json(sanitizeAccessibilityPrefs((await readPreferences()).accessibility))
      }
      if (store.kind === 'account') {
        return json(sanitizeAccessibilityPrefs(await readUserAccessibility(store.accountId)))
      }
      // Anonymous on a central: readable defaults. "You have none" is honest; handing back the
      // machine's file would be handing back somebody else's.
      return json(DEFAULT_ACCESSIBILITY_PREFS)
    }

    if (req.method === 'PUT') {
      if (store.kind === 'anonymous') {
        return json({ error: 'sign in with an account to save accessibility settings' }, 409)
      }
      const read = await readJsonLimited<unknown>(req, MAX_BODY_BYTES)
      if (!read.ok) return json({ error: read.error }, read.error === 'too_large' ? 413 : 400)
      const prefs = applyA11yPut(read.value)
      if (store.kind === 'machine') {
        // A shallow merge over the stored document — nothing else in preferences.json is touched.
        await writePreferences({ accessibility: prefs })
      } else {
        await writeUserAccessibility(store.accountId, prefs)
      }
      return json(prefs)
    }

    return json({ error: 'method not allowed' }, 405)
  } catch (err) {
    const safe = safeError(err, { verbose: PROFILE === 'local' })
    console.error(safe.logLine)
    return json(safe.body, 500)
  }
}
```

- [ ] **Step 6: Mount the routes**

In `packages/server/server/index.ts`, add the import beside the other route-module imports:

```ts
import { handleAccessibility } from './a11y-routes'
```

and mount it immediately after the `/api/preferences` PUT block:

```ts
    if (url.pathname === '/api/accessibility') {
      return await handleAccessibility(req, CORS_HEADERS)
    }
```

`CORS_HEADERS` is the per-request local already in scope at that point in the handler.

- [ ] **Step 7: Delete the preferences with the account**

In `packages/server/server/iam-handlers.ts`, add the import:

```ts
import { deleteUserPrefs } from './user-prefs-store'
```

and one line right after `await detachAccountFromAllMachines(id).catch(() => {})`:

```ts
    // Their UI preferences have no owner left. Best effort: a failure here must not fail a delete
    // that already happened.
    await deleteUserPrefs(id).catch(() => {})
```

- [ ] **Step 8: Type check and run the whole suite**

```bash
bun tsc --noEmit
bun test
```

Expected: `tsc` prints nothing; tests pass. **If a failure is in a file this branch did not touch,
report it as pre-existing rather than fixing it** — other sessions run against this repository, and
a red test may not be yours.

- [ ] **Step 9: Verify the endpoint by hand**

```bash
bun run dev &
sleep 8
curl -s http://localhost:47291/api/accessibility
curl -s -X PUT http://localhost:47291/api/accessibility \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"lensesByPage":{"/costs":[{"id":"a","x":10,"y":10,"zoom":4}]}}'
curl -s http://localhost:47291/api/accessibility
kill %1
```

Expected: the first call returns the defaults with `"enabled":false`; the PUT echoes the sanitised
object; the third returns what was written, with `zoom` 4 and the lens under `/costs`. Then confirm
nothing else in the preferences file was lost:

```bash
grep -o '"lang":"[a-z]*"' ~/.agentistics/preferences.json
```

Expected: the language is still there — `writePreferences` merges, so this is a regression check,
not a discovery.

- [ ] **Step 10: Commit**

```bash
git add packages/server/server/user-prefs-store.ts packages/server/server/a11y-routes.ts \
        packages/server/server/preferences.ts packages/server/server/mongo-dates.ts \
        packages/server/server/index.ts packages/server/server/iam-handlers.ts
git commit -m "feat(server): GET/PUT /api/accessibility, machine file or per-account document

userPrefs is its own collection rather than a field on AccountDoc, which the governance panels
list and map to PublicAccount. Its updatedAt joins DATE_FIELDS and the migration version is
bumped, or it would stay a string in the database while the writing code looked correct.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: The DOM mirror engine

**Files:**
- Create: `packages/web/src/lib/magnifierMirror.ts`

**Interfaces:**
- Consumes: `pickLensesToSync`, `nextMinInterval`, `MIRROR_DEFAULTS`, `MirrorLensState`, `MirrorScheduleConfig` (Task 3).
- Produces: `MirrorHost = { syncNow(): void; destroy(): void }`, `createMirrorHost(stage: HTMLElement): MirrorHost`, `MirrorScheduler = { register(id, host, isOnScreen): void; unregister(id): void; markDirty(): void; stop(): void; currentIntervalMs(): number }`, `startMirrorScheduler(): MirrorScheduler`. Task 8 (`Lens.tsx`, `MagnifierLayer.tsx`) uses
`createMirrorHost`, `startMirrorScheduler` and `MirrorScheduler`; `markDirty()` and
`currentIntervalMs()` are part of the interface and are not called by any task in this plan — they
exist for a caller that needs to force a resync or report the current interval.

**Read the spec's §4 and §10 before starting.** Risk 1 (`position: fixed` inside the clone) is verified in Step 1, before anything is built on top of it.

- [ ] **Step 1: Verify the `position: fixed` assumption in a real browser**

This is the assumption the whole mirror rests on and it has NOT been observed. Write this scratch file:

```bash
mkdir -p /tmp/claude-1000/-home-mithrandir-agentistics/scratch
cat > /tmp/claude-1000/-home-mithrandir-agentistics/scratch/fixed-in-clone.html <<'HTML'
<!doctype html>
<style>
  body { margin: 0; height: 200vh; font: 16px system-ui; background: #111; color: #eee; }
  .bar { position: fixed; top: 0; left: 0; right: 0; height: 40px; background: #d97706; color: #fff; }
  .card { margin: 80px 40px; padding: 20px; background: #333; }
  #lens { position: fixed; top: 300px; left: 40px; width: 400px; height: 300px;
          overflow: hidden; border: 3px solid #d97706; }
  #stage { width: 100vw; height: 100vh; transform-origin: 0 0; }
</style>
<div id="root">
  <div class="bar">STICKY BAR — must appear at the TOP of the lens too</div>
  <div class="card">card content</div>
</div>
<div id="lens"><div id="stage"></div></div>
<script>
  const stage = document.getElementById('stage')
  stage.appendChild(document.getElementById('root').cloneNode(true))
  // Magnify the region at the viewport origin: lens 400x300 at 2x -> source 200x150 at (0,0).
  stage.style.transform = 'scale(2) translate(0px, 0px)'
</script>
HTML
```

Then ask the human, in these words:

> Please open `file:///tmp/claude-1000/-home-mithrandir-agentistics/scratch/fixed-in-clone.html`
> in Chrome and tell me whether the orange "STICKY BAR" appears **inside** the bordered box, near
> its top edge, at double size — or whether the box shows only the dark card with no orange bar.

Do NOT use Playwright or the browser MCP for this; they hang in this environment.

- **If the bar appears inside the box:** the assumption holds. Continue to Step 2 unchanged.
- **If it does not:** apply the spec's §10 fallback. In `reconcile()` in Step 2, for each cloned
  element whose live counterpart has `getComputedStyle(live).position === 'fixed'`, set the
  clone's `position` to `'absolute'` and its `left`/`top` to the live element's
  `getBoundingClientRect()` origin in px. Record the finding in the file's header comment, because
  the next reader will otherwise wonder why that branch exists.

- [ ] **Step 2: Write the engine**

Create `packages/web/src/lib/magnifierMirror.ts`:

```ts
/**
 * magnifierMirror.ts — the ONLY module in this feature that touches the DOM.
 *
 * Each lens owns a clone of `#root` inside a viewport-sized stage carrying the transform
 * `magnifier.ts` computes, so what the lens shows is the region of the page beneath it.
 *
 * The lens layer is a SIBLING of `#root`, so a clone of `#root` can never contain a lens. That is
 * what makes the mirror-in-a-mirror recursion structurally impossible rather than something to be
 * guarded against — do not move the layer inside `#root`.
 *
 * `cloneNode` does not carry scroll positions, form control state or canvas pixels; `reconcile`
 * copies all three by walking the live and cloned trees in step. A canvas that cannot be copied
 * (WebGL without preserveDrawingBuffer, or a tainted one) is CLEARED rather than left showing its
 * previous frame — an empty region the settings tab warned about is recoverable, a stale one that
 * looks live is not.
 */
import {
  MIRROR_DEFAULTS,
  nextMinInterval,
  pickLensesToSync,
  type MirrorLensState,
  type MirrorScheduleConfig,
} from './mirrorSchedule'

export interface MirrorHost {
  /** Re-clone and reconcile now. */
  syncNow(): void
  destroy(): void
}

export interface MirrorScheduler {
  register(id: string, host: MirrorHost, isOnScreen: () => boolean): void
  unregister(id: string): void
  /** Something in `#root` changed. */
  markDirty(): void
  stop(): void
  currentIntervalMs(): number
}

function sourceRoot(): HTMLElement | null {
  return document.getElementById('root')
}

/** Strip what must not be duplicated in a live document, and make the copy inert. */
function neutralize(clone: HTMLElement): void {
  clone.setAttribute('aria-hidden', 'true')
  clone.setAttribute('inert', '')
  clone.style.pointerEvents = 'none'
  // Duplicate ids break getElementById for anything that runs after us; duplicate names break
  // form and radio grouping. A screen reader must hear the page once, not once per lens.
  for (const el of Array.from(clone.querySelectorAll('[id], [name]'))) {
    el.removeAttribute('id')
    el.removeAttribute('name')
  }
  clone.removeAttribute('id')
}

/** Copy what cloneNode leaves behind, walking both trees in step. */
function reconcile(live: Element, copy: Element): void {
  if (live.scrollTop !== 0 || live.scrollLeft !== 0) {
    copy.scrollTop = live.scrollTop
    copy.scrollLeft = live.scrollLeft
  }

  if (live instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
    copy.value = live.value
    copy.checked = live.checked
  } else if (live instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement) {
    copy.value = live.value
  } else if (live instanceof HTMLSelectElement && copy instanceof HTMLSelectElement) {
    copy.selectedIndex = live.selectedIndex
  } else if (live instanceof HTMLCanvasElement && copy instanceof HTMLCanvasElement) {
    const ctx = copy.getContext('2d')
    if (ctx) {
      ctx.clearRect(0, 0, copy.width, copy.height)
      try {
        // Best effort. A WebGL canvas without preserveDrawingBuffer yields nothing and a tainted
        // one throws; either way the region stays EMPTY, never stale.
        ctx.drawImage(live, 0, 0)
      } catch { /* the settings tab states this limitation in words */ }
    }
  }

  const liveKids = live.children
  const copyKids = copy.children
  const n = Math.min(liveKids.length, copyKids.length)
  for (let i = 0; i < n; i++) reconcile(liveKids[i], copyKids[i])
}

export function createMirrorHost(stage: HTMLElement): MirrorHost {
  let alive = true
  return {
    syncNow() {
      if (!alive) return
      const root = sourceRoot()
      if (!root) return
      const clone = root.cloneNode(true) as HTMLElement
      neutralize(clone)
      stage.replaceChildren(clone)
      reconcile(root, clone)
    },
    destroy() {
      alive = false
      stage.replaceChildren()
    },
  }
}

interface Entry {
  host: MirrorHost
  isOnScreen: () => boolean
  dirty: boolean
  lastSyncMs: number
}

export function startMirrorScheduler(): MirrorScheduler {
  const entries = new Map<string, Entry>()
  let cfg: MirrorScheduleConfig = { ...MIRROR_DEFAULTS }
  let frame = 0
  let stopped = false

  const observer = new MutationObserver(() => {
    for (const e of entries.values()) e.dirty = true
  })
  const root = sourceRoot()
  if (root) {
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true })
  }

  const tick = () => {
    if (stopped) return
    frame = requestAnimationFrame(tick)
    if (entries.size === 0) return

    const now = performance.now()
    const states: MirrorLensState[] = []
    for (const [id, e] of entries) {
      states.push({ id, dirty: e.dirty, onScreen: e.isOnScreen(), lastSyncMs: e.lastSyncMs })
    }
    const due = pickLensesToSync(states, now, cfg)
    if (due.length === 0) return

    const started = performance.now()
    for (const id of due) {
      const e = entries.get(id)
      if (!e) continue
      e.host.syncNow()
      e.dirty = false
      e.lastSyncMs = now
    }
    cfg = { ...cfg, minIntervalMs: nextMinInterval(performance.now() - started, cfg.minIntervalMs) }
  }
  frame = requestAnimationFrame(tick)

  return {
    register(id, host, isOnScreen) {
      entries.set(id, { host, isOnScreen, dirty: true, lastSyncMs: 0 })
    },
    unregister(id) {
      entries.delete(id)
    },
    markDirty() {
      for (const e of entries.values()) e.dirty = true
    },
    stop() {
      stopped = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      entries.clear()
    },
    currentIntervalMs() {
      return cfg.minIntervalMs
    },
  }
}
```

- [ ] **Step 3: Type check**

```bash
bun tsc --noEmit
```

Expected: nothing printed. There are no unit tests for this file: it is pure DOM, and this
repository has no DOM test environment — component tests here use `renderToStaticMarkup`
(see `packages/web/src/pages/settings/primitives.test.tsx`). Its *decisions* are tested in Task 3;
its *effects* are verified in a browser at Task 8 Step 5.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/lib/magnifierMirror.ts
git commit -m "feat(web): the DOM mirror — one clone per lens, reconciled for what cloneNode drops

Scroll positions, form values and canvas pixels are copied by walking both trees in step. A
canvas that cannot be copied is CLEARED, never left showing its previous frame: an empty region
the user was warned about is recoverable, a stale one that looks live is not.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: The accessibility state hook and its context

**Files:**
- Create: `packages/web/src/components/a11y/i18n.ts`
- Create: `packages/web/src/hooks/useAccessibility.ts`
- Modify: `packages/web/src/lib/app-context.ts`
- Modify: `packages/web/src/App.tsx`

**Interfaces:**
- Consumes: `AccessibilityPrefs`, `MagnifierLens`, `LensStyle`, `DEFAULT_ACCESSIBILITY_PREFS`, `sanitizeAccessibilityPrefs` (`@agentistics/core`); `pageKey`, `clampLens`, `newLens` (Task 2).
- Produces: `A11yText`, `a11yText(lang)`, `A11yState`, `useAccessibility(): A11yState`. `AppContext` gains `a11y: A11yState`. Tasks 8–12 consume `ctx.a11y`. The full `A11yState` surface is: `prefs`, `loaded`, `page`, `lenses`, `selectedId`, `followOn`, `announcement`, `setEnabled`, `setFollowStyle`, `setNewLensDefaults`, `addLens`, `updateLens`, `duplicateLens`, `removeLens`, `removePage`, `setAllPinned`, `select`, `toggleFollow`, `announce`.

- [ ] **Step 1: Write the string table**

Create `packages/web/src/components/a11y/i18n.ts`:

```ts
/** EN/PT strings for the magnifier feature, resolved at render like the rest of the app. */
export interface A11yText {
  tab: string
  enable: string
  enableHelp: string
  headerTitle: string
  headerHint: string
  newLens: string
  lensesHere: string
  noLensesHere: string
  unpinAll: string
  pinAll: string
  removeAllHere: string
  followLens: string
  followOn: string
  followOff: string
  openSettings: string
  zoom: string
  shape: string
  circle: string
  rect: string
  width: string
  height: string
  diameter: string
  borderWidth: string
  cornerRadius: string
  pin: string
  unpin: string
  remove: string
  duplicate: string
  select: string
  newLensDefaults: string
  savedLenses: string
  page: string
  count: string
  goToPage: string
  performance: string
  canvasCaveat: string
  schedulerNote: string
  borderIsOrange: string
  keyboardTitle: string
  keyboardHelp: string[]
  removed: string
  announce(name: string, zoom: number, w: number, h: number, pinned: boolean): string
}

export function a11yText(lang: 'pt' | 'en'): A11yText {
  const pt = lang === 'pt'
  return {
    tab: pt ? 'Acessibilidade' : 'Accessibility',
    enable: pt ? 'Ativar lupas' : 'Enable magnifiers',
    enableHelp: pt
      ? 'Com isto desligado nada é criado nem observado: o custo é zero.'
      : 'With this off nothing is created and nothing is observed: the cost is zero.',
    headerTitle: pt ? 'Lupas' : 'Magnifiers',
    headerHint: pt
      ? 'Clique para criar uma lupa · botão direito para o menu'
      : 'Click to create a lens · right-click for the menu',
    newLens: pt ? 'Nova lupa' : 'New lens',
    lensesHere: pt ? 'Lupas desta página' : 'Lenses on this page',
    noLensesHere: pt ? 'Nenhuma lupa nesta página.' : 'No lenses on this page.',
    unpinAll: pt ? 'Destravar todas' : 'Unpin all',
    pinAll: pt ? 'Fixar todas' : 'Pin all',
    removeAllHere: pt ? 'Remover todas desta página' : 'Remove all on this page',
    followLens: pt ? 'Lupa que segue o cursor' : 'Cursor-following lens',
    followOn: pt ? 'Ligar (Ctrl+Shift+Z)' : 'Turn on (Ctrl+Shift+Z)',
    followOff: pt ? 'Desligar (Ctrl+Shift+Z)' : 'Turn off (Ctrl+Shift+Z)',
    openSettings: pt ? 'Configurações de acessibilidade' : 'Accessibility settings',
    zoom: pt ? 'Ampliação' : 'Zoom',
    shape: pt ? 'Formato' : 'Shape',
    circle: pt ? 'Círculo' : 'Circle',
    rect: pt ? 'Retângulo' : 'Rectangle',
    width: pt ? 'Largura' : 'Width',
    height: pt ? 'Altura' : 'Height',
    diameter: pt ? 'Diâmetro' : 'Diameter',
    borderWidth: pt ? 'Espessura da borda' : 'Border thickness',
    cornerRadius: pt ? 'Raio do canto' : 'Corner radius',
    pin: pt ? 'Fixar' : 'Pin',
    unpin: pt ? 'Destravar' : 'Unpin',
    remove: pt ? 'Remover' : 'Remove',
    duplicate: pt ? 'Duplicar' : 'Duplicate',
    select: pt ? 'Selecionar' : 'Select',
    newLensDefaults: pt ? 'Padrões para lupas novas' : 'Defaults for new lenses',
    savedLenses: pt ? 'Lupas salvas' : 'Saved lenses',
    page: pt ? 'Página' : 'Page',
    count: pt ? 'Quantas' : 'How many',
    goToPage: pt ? 'Ir para a página' : 'Go to that page',
    performance: pt ? 'Desempenho e limites' : 'Performance and limits',
    canvasCaveat: pt
      ? 'Conteúdo desenhado em <canvas> ou WebGL — o terminal de sessões — pode não ser copiável. Onde não for, a lupa mostra a área vazia em vez de mostrar uma imagem velha.'
      : 'Content drawn on a <canvas> or in WebGL — the session terminal — may not be copyable. Where it is not, the lens shows that area empty rather than showing a stale image.',
    schedulerNote: pt
      ? 'O espelho ressincroniza no máximo duas lupas por quadro e recua sozinho se um ciclo custar caro demais — por isso não há limite de lupas.'
      : 'The mirror re-syncs at most two lenses per frame and backs off on its own when a cycle costs too much — which is why there is no lens limit.',
    borderIsOrange: pt
      ? 'A borda é sempre o laranja do site. A espessura e o formato são seus; a cor é do produto.'
      : 'The border is always the site orange. Thickness and shape are yours; the colour is the product’s.',
    keyboardTitle: pt ? 'Teclado' : 'Keyboard',
    keyboardHelp: pt
      ? [
          'Ctrl+Shift+M — selecionar a primeira lupa da página',
          'Setas — mover 10 px · Alt+setas — mover 1 px',
          'Shift+setas — redimensionar',
          '+ / − — ampliação',
          'P — fixar ou destravar · Delete — remover',
          'Tab — próxima lupa (inclui as fixadas) · Esc — soltar',
          'Ctrl+Shift+Z — lupa que segue o cursor',
        ]
      : [
          'Ctrl+Shift+M — select the first lens on this page',
          'Arrows — move 10 px · Alt+arrows — move 1 px',
          'Shift+arrows — resize',
          '+ / − — zoom',
          'P — pin or unpin · Delete — remove',
          'Tab — next lens (pinned ones included) · Esc — release',
          'Ctrl+Shift+Z — cursor-following lens',
        ],
    removed: pt ? 'Lupa removida.' : 'Lens removed.',
    announce: (name, zoom, w, h, pinned) =>
      pt
        ? `${name}, ampliação ${zoom} vezes, ${Math.round(w)} por ${Math.round(h)}, ${pinned ? 'fixada' : 'solta'}.`
        : `${name}, zoom ${zoom} times, ${Math.round(w)} by ${Math.round(h)}, ${pinned ? 'pinned' : 'unpinned'}.`,
  }
}
```

- [ ] **Step 2: Write the hook**

Create `packages/web/src/hooks/useAccessibility.ts`:

```ts
/**
 * useAccessibility — the magnifier state, loaded from and saved to /api/accessibility.
 *
 * The lenses of the CURRENT page are exposed already clamped to the viewport, so no renderer has
 * to remember to clamp and none of them can disagree about where a lens may sit. Saves are
 * debounced: a drag is one pointermove after another and must not be one request after another.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type { AccessibilityPrefs, LensStyle, MagnifierLens } from '@agentistics/core'
import { DEFAULT_ACCESSIBILITY_PREFS, sanitizeAccessibilityPrefs } from '@agentistics/core'
import { clampLens, newLens, pageKey } from '../lib/magnifier'

const SAVE_DEBOUNCE_MS = 400

export interface A11yState {
  prefs: AccessibilityPrefs
  loaded: boolean
  page: string
  /** The current page's lenses, already clamped to the viewport. */
  lenses: MagnifierLens[]
  selectedId: string | null
  followOn: boolean
  announcement: string
  setEnabled(on: boolean): void
  setFollowStyle(style: LensStyle): void
  setNewLensDefaults(style: LensStyle): void
  addLens(): void
  updateLens(id: string, patch: Partial<MagnifierLens>): void
  duplicateLens(id: string): void
  removeLens(id: string): void
  removePage(page: string): void
  setAllPinned(pinned: boolean): void
  select(id: string | null): void
  toggleFollow(): void
  announce(text: string): void
}

function viewport() {
  return { width: window.innerWidth, height: window.innerHeight }
}

export function useAccessibility(): A11yState {
  const location = useLocation()
  const page = pageKey(location.pathname)

  const [prefs, setPrefs] = useState<AccessibilityPrefs>(DEFAULT_ACCESSIBILITY_PREFS)
  const [loaded, setLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [followOn, setFollowOn] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [vp, setVp] = useState(viewport)

  // Nothing is written before the restore has happened: an early save would persist the defaults
  // over settings that were still in flight.
  const loadedRef = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/accessibility')
      .then(r => (r.ok ? r.json() : null))
      .then(body => { if (!cancelled) setPrefs(sanitizeAccessibilityPrefs(body)) })
      .catch(() => { /* a failed load leaves the defaults; it must never blank the dashboard */ })
      .finally(() => {
        if (cancelled) return
        loadedRef.current = true
        setLoaded(true)
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const onResize = () => setVp(viewport())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const commit = useCallback((next: AccessibilityPrefs) => {
    setPrefs(next)
    if (!loadedRef.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      fetch('/api/accessibility', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      }).catch(() => { /* the next edit retries; a lost save is not worth a toast */ })
    }, SAVE_DEBOUNCE_MS)
  }, [])

  const rawLenses = useMemo(() => prefs.lensesByPage[page] ?? [], [prefs.lensesByPage, page])
  const lenses = useMemo(() => rawLenses.map(l => clampLens(l, vp)), [rawLenses, vp])

  const setPageLenses = useCallback((next: MagnifierLens[]) => {
    const byPage = { ...prefs.lensesByPage }
    if (next.length === 0) delete byPage[page]
    else byPage[page] = next
    commit({ ...prefs, lensesByPage: byPage })
  }, [prefs, page, commit])

  const freeId = useCallback(() => {
    const taken = new Set(rawLenses.map(l => l.id))
    let n = 1
    while (taken.has(`lens-${n}`)) n++
    return `lens-${n}`
  }, [rawLenses])

  return {
    prefs,
    loaded,
    page,
    lenses,
    selectedId,
    followOn,
    announcement,
    setEnabled: on => commit({ ...prefs, enabled: on }),
    setFollowStyle: style => commit({ ...prefs, followLens: style }),
    setNewLensDefaults: style => commit({ ...prefs, newLensDefaults: style }),
    addLens: () => {
      const made = newLens(prefs.newLensDefaults, viewport(), new Set(rawLenses.map(l => l.id)))
      setPageLenses([...rawLenses, made])
      setSelectedId(made.id)
    },
    updateLens: (id, patch) => {
      setPageLenses(rawLenses.map(l => (l.id === id ? clampLens({ ...l, ...patch }, viewport()) : l)))
    },
    duplicateLens: id => {
      const src = rawLenses.find(l => l.id === id)
      if (!src) return
      const copy = { ...src, id: freeId(), x: src.x + 24, y: src.y + 24, pinned: false }
      setPageLenses([...rawLenses, clampLens(copy, viewport())])
      setSelectedId(copy.id)
    },
    removeLens: id => {
      setPageLenses(rawLenses.filter(l => l.id !== id))
      setSelectedId(prev => (prev === id ? null : prev))
    },
    removePage: p => {
      const byPage = { ...prefs.lensesByPage }
      delete byPage[p]
      commit({ ...prefs, lensesByPage: byPage })
      if (p === page) setSelectedId(null)
    },
    setAllPinned: pinned => setPageLenses(rawLenses.map(l => ({ ...l, pinned }))),
    select: setSelectedId,
    toggleFollow: () => setFollowOn(v => !v),
    announce: setAnnouncement,
  }
}
```

- [ ] **Step 3: Put it on the context**

In `packages/web/src/lib/app-context.ts` add the import and one field on `AppContext`:

```ts
import type { A11yState } from '../hooks/useAccessibility'
```

```ts
  /** Magnifier lenses — the accessibility feature. Always present; `prefs.enabled` is the switch. */
  a11y: A11yState
```

In `packages/web/src/App.tsx`, import and call the hook beside the other hooks:

```ts
import { useAccessibility } from './hooks/useAccessibility'
```

```ts
  const a11y = useAccessibility()
```

Then find where the `AppContext` object is built for `<Outlet context={…}>`. **If it is an inline
object literal, extract it into a named `const appCtx: AppContext = { … }`** and pass that same
variable to the outlet — Task 8 needs the identical object for the magnifier layer, and two
separately built objects would drift. Add `a11y` to it.

- [ ] **Step 4: Type check and full suite**

```bash
bun tsc --noEmit
bun test
```

Expected: `tsc` prints nothing; tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/hooks/useAccessibility.ts packages/web/src/components/a11y/i18n.ts \
        packages/web/src/lib/app-context.ts packages/web/src/App.tsx
git commit -m "feat(web): accessibility state on the app context, saved with a debounce

Nothing is written before the restore has landed: an early save would persist the defaults over
settings still in flight. Lenses reach every renderer already clamped, so no surface has to
remember to clamp and none of them can disagree about where a lens may sit.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: One lens on screen

**Files:**
- Create: `packages/web/src/components/a11y/Lens.tsx`
- Create: `packages/web/src/components/a11y/MagnifierLayer.tsx`
- Modify: `packages/web/src/App.tsx` (mount the layer)

**Interfaces:**
- Consumes: `A11yState`, `A11yText` (Task 7); `stageTransform` (Task 2); `createMirrorHost`, `startMirrorScheduler`, `MirrorScheduler` (Task 6); `useIsMobile`.
- Produces: `<Lens lens selected revealed text isMobile scheduler onChange onSelect onRemove onContextMenu />` and `<MagnifierLayer ctx />`. Task 9 adds the menu, Task 10 the keyboard, Task 11 the follow lens.

- [ ] **Step 1: Write the lens component**

Create `packages/web/src/components/a11y/Lens.tsx`:

```tsx
/**
 * Lens.tsx — one magnifier.
 *
 * Three nested elements: the frame (fixed, orange border, clipped), a viewport-sized stage
 * carrying the transform, and the mirror clone inside it. It is rendered by MagnifierLayer's
 * portal, which lives OUTSIDE #root — see magnifierMirror.ts for why that is load-bearing.
 *
 * Pinned is glass: controls gone, `pointerEvents: none` on the whole frame, clicks pass through.
 */
import React, { useEffect, useRef } from 'react'
import { Pin, PinOff, Move, X, Plus, Minus } from 'lucide-react'
import type { MagnifierLens } from '@agentistics/core'
import { stageTransform } from '../../lib/magnifier'
import { createMirrorHost, type MirrorScheduler } from '../../lib/magnifierMirror'
import type { A11yText } from './i18n'

const ORANGE = 'var(--anthropic-orange)'

interface Props {
  lens: MagnifierLens
  selected: boolean
  /** True while a pinned lens is temporarily revealed by keyboard selection. */
  revealed: boolean
  text: A11yText
  isMobile: boolean
  scheduler: MirrorScheduler
  onChange(patch: Partial<MagnifierLens>): void
  onSelect(): void
  onRemove(): void
  onContextMenu(e: React.MouseEvent): void
}

export function Lens({
  lens, selected, revealed, text, isMobile, scheduler, onChange, onSelect, onRemove, onContextMenu,
}: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ mode: 'move' | 'resize'; px: number; py: number; from: MagnifierLens } | null>(null)
  // The scheduler asks "is this on screen?" every frame; reading the live lens through a ref
  // avoids re-registering the mirror on every pointermove.
  const lensRef = useRef(lens)
  lensRef.current = lens

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const host = createMirrorHost(stage)
    const onScreen = () => {
      const l = lensRef.current
      return l.x < window.innerWidth && l.y < window.innerHeight && l.x + l.width > 0 && l.y + l.height > 0
    }
    scheduler.register(lens.id, host, onScreen)
    host.syncNow()
    return () => {
      scheduler.unregister(lens.id)
      host.destroy()
    }
  }, [lens.id, scheduler])

  const t = stageTransform(lens)
  const interactive = !lens.pinned || revealed
  const control = isMobile ? 44 : 26

  const startDrag = (mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    if (!interactive) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    drag.current = { mode, px: e.clientX, py: e.clientY, from: lens }
    onSelect()
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.px
    const dy = e.clientY - d.py
    if (d.mode === 'move') onChange({ x: d.from.x + dx, y: d.from.y + dy })
    else if (d.from.shape === 'circle') onChange({ width: d.from.width + dx, height: d.from.width + dx })
    else onChange({ width: d.from.width + dx, height: d.from.height + dy })
  }

  const endDrag = () => { drag.current = null }

  const btn: React.CSSProperties = {
    width: control, height: control, display: 'flex', alignItems: 'center',
    justifyContent: 'center', borderRadius: 6, border: 'none', background: 'transparent',
    color: '#fff', cursor: 'pointer', padding: 0,
  }

  return (
    <div
      role="group"
      aria-label={`${text.headerTitle} ${lens.id}`}
      onContextMenu={interactive ? onContextMenu : undefined}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{
        position: 'fixed',
        left: lens.x,
        top: lens.y,
        width: lens.width,
        height: lens.height,
        // The colour is the product's, in every state. Only the thickness is the user's.
        border: `${lens.borderWidth}px solid ${ORANGE}`,
        borderRadius: lens.shape === 'circle' ? '50%' : lens.cornerRadius,
        overflow: 'hidden',
        background: 'var(--bg-base)',
        boxShadow: selected ? `0 0 0 3px ${ORANGE}55` : '0 6px 24px rgba(0,0,0,0.35)',
        // Pinned is glass. This is the whole point of pinning.
        pointerEvents: interactive ? 'auto' : 'none',
        zIndex: 2147483000,
        boxSizing: 'border-box',
      }}
    >
      <div
        ref={stageRef}
        aria-hidden="true"
        style={{
          width: '100vw',
          height: '100vh',
          transformOrigin: '0 0',
          transform: `scale(${t.scale}) translate(${t.tx}px, ${t.ty}px)`,
          pointerEvents: 'none',
        }}
      />

      {interactive && (
        <>
          <div
            onPointerDown={startDrag('move')}
            style={{
              position: 'absolute', top: 0, left: 0, right: 0, height: control,
              display: 'flex', alignItems: 'center', gap: 2, padding: '0 4px',
              background: 'rgba(0,0,0,0.55)', cursor: 'move', touchAction: 'none',
            }}
          >
            <Move size={14} color="#fff" />
            <span style={{ flex: 1 }} />
            <button style={btn} aria-label={`${text.zoom} −`}
              onPointerDown={e => e.stopPropagation()}
              onClick={() => onChange({ zoom: lens.zoom - 0.5 })}><Minus size={14} /></button>
            <span style={{ color: '#fff', fontSize: 11, fontWeight: 700, minWidth: 30, textAlign: 'center' }}>
              {lens.zoom}×
            </span>
            <button style={btn} aria-label={`${text.zoom} +`}
              onPointerDown={e => e.stopPropagation()}
              onClick={() => onChange({ zoom: lens.zoom + 0.5 })}><Plus size={14} /></button>
            <button style={btn} aria-label={lens.pinned ? text.unpin : text.pin}
              onPointerDown={e => e.stopPropagation()}
              onClick={() => onChange({ pinned: !lens.pinned })}>
              {lens.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
            <button style={btn} aria-label={text.remove}
              onPointerDown={e => e.stopPropagation()}
              onClick={onRemove}><X size={14} /></button>
          </div>

          <div
            onPointerDown={startDrag('resize')}
            aria-hidden="true"
            style={{
              position: 'absolute', right: 0, bottom: 0, width: control, height: control,
              background: `linear-gradient(135deg, transparent 50%, ${ORANGE} 50%)`,
              cursor: 'nwse-resize', touchAction: 'none',
            }}
          />
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Write the layer**

Create `packages/web/src/components/a11y/MagnifierLayer.tsx`:

```tsx
/**
 * MagnifierLayer.tsx — the portal that holds every lens.
 *
 * Its container is appended to document.body as a SIBLING of #root. That is load-bearing: the
 * mirror clones #root, so a layer inside it would clone itself, forever. Do not move it.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppContext } from '../../lib/app-context'
import { useIsMobile } from '../../hooks/useIsMobile'
import { startMirrorScheduler, type MirrorScheduler } from '../../lib/magnifierMirror'
import { a11yText } from './i18n'
import { Lens } from './Lens'

const CONTAINER_ID = 'ag-magnifiers'

function useLayerContainer(active: boolean): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!active) { setEl(null); return }
    const node = document.createElement('div')
    node.id = CONTAINER_ID
    // No pointer events on the layer itself — only the lenses inside it take any.
    node.style.pointerEvents = 'none'
    document.body.appendChild(node)
    setEl(node)
    return () => { node.remove(); setEl(null) }
  }, [active])
  return el
}

export function MagnifierLayer({ ctx }: { ctx: AppContext }) {
  const { a11y, lang } = ctx
  const active = a11y.prefs.enabled
  const container = useLayerContainer(active)
  const isMobile = useIsMobile()
  const text = useMemo(() => a11yText(lang), [lang])
  const [scheduler, setScheduler] = useState<MirrorScheduler | null>(null)

  useEffect(() => {
    if (!active) return
    const s = startMirrorScheduler()
    setScheduler(s)
    return () => { s.stop(); setScheduler(null) }
  }, [active])

  if (!active || !container || !scheduler) return null

  return createPortal(
    <>
      <div
        role="status"
        aria-live="polite"
        style={{ position: 'fixed', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}
      >
        {a11y.announcement}
      </div>
      {a11y.lenses.map(lens => (
        <Lens
          key={lens.id}
          lens={lens}
          selected={a11y.selectedId === lens.id}
          revealed={a11y.selectedId === lens.id}
          text={text}
          isMobile={isMobile}
          scheduler={scheduler}
          onChange={patch => a11y.updateLens(lens.id, patch)}
          onSelect={() => a11y.select(lens.id)}
          onRemove={() => a11y.removeLens(lens.id)}
          onContextMenu={e => { e.preventDefault(); a11y.select(lens.id) }}
        />
      ))}
    </>,
    container,
  )
}
```

- [ ] **Step 3: Mount the layer**

In `packages/web/src/App.tsx`, import it and render it beside the other always-mounted overlays
(search for where `NotificationToasts` is rendered):

```tsx
import { MagnifierLayer } from './components/a11y/MagnifierLayer'
```

```tsx
<MagnifierLayer ctx={appCtx} />
```

`appCtx` is the named context variable Task 7 Step 3 established. Pass that exact variable — not a
freshly built object.

- [ ] **Step 4: Type check and full suite**

```bash
bun tsc --noEmit
bun test
```

Expected: `tsc` prints nothing; tests pass.

- [ ] **Step 5: Verify in a browser — the first real look**

```bash
bun run dev
```

The settings tab does not exist yet (Task 12), so seed a lens through the API. Ask the human:

> Please open http://localhost:47292, open the browser console (F12) and paste this:
>
> ```js
> await fetch('/api/accessibility', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
>   body: JSON.stringify({ enabled: true, lensesByPage: { [location.pathname]: [
>     { id: 'lens-1', x: 200, y: 200, width: 400, height: 300, zoom: 3,
>       shape: 'rect', borderWidth: 3, cornerRadius: 12, pinned: false } ] } }) })
> ```
>
> then reload the page and tell me:
> 1. Does an orange-bordered box appear showing a magnified copy of the page underneath it?
> 2. Drag it (by the dark strip at its top) over the sticky header — does the header appear inside
>    the lens, in the right place?
> 3. Does the bottom-right corner resize it, and do the − / + buttons change the magnification?
> 4. Click the pin icon: do the controls disappear, and can you then click a button on the page
>    *through* the lens?
> 5. Scroll the page: does the lens stay put and magnify whatever passes under it?

Report exactly what they say. If the mirror is blank, or the sticky header is misplaced, apply the
§10 fallback recorded in Task 6 Step 1 before continuing.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/a11y/Lens.tsx packages/web/src/components/a11y/MagnifierLayer.tsx \
        packages/web/src/App.tsx
git commit -m "feat(web): lenses on screen — drag, resize, zoom, and pinning to glass

The layer is appended to document.body as a sibling of #root, because the mirror clones #root:
inside it, the layer would clone itself forever. Pinning sets pointerEvents none on the whole
frame, which is the entire point of pinning.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: The header button and the two menus

**Files:**
- Create: `packages/web/src/components/a11y/LensMenu.tsx`
- Create: `packages/web/src/components/a11y/MagnifierButton.tsx`
- Modify: `packages/web/src/components/a11y/MagnifierLayer.tsx` (wire the lens menu)
- Modify: `packages/web/src/App.tsx` (three placements)

**Interfaces:**
- Consumes: `A11yState` (incl. `duplicateLens`, defined in Task 7), `A11yText`, `MagnifierLens`.
- Produces: `<LensMenu lens x y text isMobile onChange onRemove onDuplicate onClose />` and `<MagnifierButton ctx />`.

- [ ] **Step 1: Write the lens context menu**

Create `packages/web/src/components/a11y/LensMenu.tsx`:

```tsx
/**
 * LensMenu.tsx — one lens's own menu. A popover at the pointer on desktop, a bottom sheet on
 * mobile: a popover positioned at a thumb is a popover under the thumb.
 */
import React from 'react'
import type { MagnifierLens } from '@agentistics/core'
import { ZOOM_MAX, ZOOM_MIN, LENS_MIN_PX, BORDER_MIN_PX, BORDER_MAX_PX } from '@agentistics/core'
import type { A11yText } from './i18n'

interface Props {
  lens: MagnifierLens
  x: number
  y: number
  text: A11yText
  isMobile: boolean
  onChange(patch: Partial<MagnifierLens>): void
  onRemove(): void
  onDuplicate(): void
  onClose(): void
}

export function LensMenu({ lens, x, y, text, isMobile, onChange, onRemove, onDuplicate, onClose }: Props) {
  const row: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
    padding: isMobile ? '10px 4px' : '5px 4px', fontSize: 13, color: 'var(--text-secondary)',
  }
  const action: React.CSSProperties = {
    display: 'block', width: '100%', textAlign: 'left',
    padding: isMobile ? '12px 8px' : '7px 8px', minHeight: isMobile ? 44 : undefined,
    borderRadius: 8, border: 'none', background: 'transparent',
    color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13, cursor: 'pointer',
  }
  const shell: React.CSSProperties = isMobile
    ? { position: 'fixed', left: 0, right: 0, bottom: 0, borderRadius: '14px 14px 0 0' }
    : {
        position: 'fixed',
        left: Math.max(8, Math.min(x, window.innerWidth - 268)),
        top: Math.max(8, Math.min(y, window.innerHeight - 360)),
        width: 250, borderRadius: 12,
      }

  const chip = (on: boolean): React.CSSProperties => ({
    padding: isMobile ? '10px 12px' : '5px 10px', minHeight: isMobile ? 44 : undefined,
    borderRadius: 7, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
    border: '1px solid ' + (on ? 'var(--anthropic-orange)' : 'var(--border)'),
    background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
    color: 'var(--text-primary)',
  })

  return (
    <>
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, zIndex: 2147483100, pointerEvents: 'auto',
        background: isMobile ? 'rgba(0,0,0,0.4)' : 'transparent',
      }} />
      <div role="menu" aria-label={text.headerTitle} style={{
        ...shell, zIndex: 2147483200, padding: 10, pointerEvents: 'auto',
        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
      }}>
        <div style={row}>
          <span>{text.zoom}</span>
          <input type="range" min={ZOOM_MIN} max={ZOOM_MAX} step={0.5} value={lens.zoom}
            onChange={e => onChange({ zoom: Number(e.target.value) })} style={{ flex: 1 }} />
          <strong style={{ minWidth: 36, textAlign: 'right' }}>{lens.zoom}×</strong>
        </div>
        <div style={row}>
          <span>{text.shape}</span>
          <span style={{ display: 'flex', gap: 6 }}>
            {(['rect', 'circle'] as const).map(s => (
              <button key={s} style={chip(lens.shape === s)} onClick={() => onChange({ shape: s })}>
                {s === 'rect' ? text.rect : text.circle}
              </button>
            ))}
          </span>
        </div>
        <div style={row}>
          <span>{lens.shape === 'circle' ? text.diameter : text.width}</span>
          <input type="range" min={LENS_MIN_PX} max={1200} step={10} value={lens.width}
            onChange={e => onChange({ width: Number(e.target.value) })} style={{ flex: 1 }} />
        </div>
        {lens.shape === 'rect' && (
          <div style={row}>
            <span>{text.height}</span>
            <input type="range" min={LENS_MIN_PX} max={1200} step={10} value={lens.height}
              onChange={e => onChange({ height: Number(e.target.value) })} style={{ flex: 1 }} />
          </div>
        )}
        <div style={row}>
          <span>{text.borderWidth}</span>
          <input type="range" min={BORDER_MIN_PX} max={BORDER_MAX_PX} step={1} value={lens.borderWidth}
            onChange={e => onChange({ borderWidth: Number(e.target.value) })} style={{ flex: 1 }} />
        </div>
        <div style={{ height: 1, background: 'var(--border)', margin: '6px 0' }} />
        <button style={action} onClick={() => { onChange({ pinned: !lens.pinned }); onClose() }}>
          {lens.pinned ? text.unpin : text.pin}
        </button>
        <button style={action} onClick={() => { onDuplicate(); onClose() }}>{text.duplicate}</button>
        <button style={{ ...action, color: 'var(--accent-red)' }} onClick={() => { onRemove(); onClose() }}>
          {text.remove}
        </button>
      </div>
    </>
  )
}
```

- [ ] **Step 2: Wire the menu into the layer**

In `MagnifierLayer.tsx`, import `LensMenu`, add the state, change the `onContextMenu` prop and
render the menu after the lens list:

```tsx
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
```

```tsx
          onContextMenu={e => {
            e.preventDefault()
            a11y.select(lens.id)
            setMenu({ id: lens.id, x: e.clientX, y: e.clientY })
          }}
```

```tsx
      {menu && (() => {
        const lens = a11y.lenses.find(l => l.id === menu.id)
        if (!lens) return null
        return (
          <LensMenu
            lens={lens} x={menu.x} y={menu.y} text={text} isMobile={isMobile}
            onChange={patch => a11y.updateLens(lens.id, patch)}
            onRemove={() => a11y.removeLens(lens.id)}
            onDuplicate={() => a11y.duplicateLens(lens.id)}
            onClose={() => setMenu(null)}
          />
        )
      })()}
```

- [ ] **Step 3: Write the header button**

Create `packages/web/src/components/a11y/MagnifierButton.tsx`:

```tsx
/**
 * MagnifierButton.tsx — the header icon.
 *
 * Left click makes a lens; right click opens the general menu, which is the only way a MOUSE can
 * reach a pinned lens again (a pinned lens takes no pointer events at all — that is what pinning
 * means). By keyboard there is a second way in; see MagnifierLayer's key handler.
 */
import React, { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import { useIsMobile } from '../../hooks/useIsMobile'
import { a11yText } from './i18n'

export function MagnifierButton({ ctx }: { ctx: AppContext }) {
  const { a11y, lang } = ctx
  const text = useMemo(() => a11yText(lang), [lang])
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  if (!a11y.prefs.enabled) return null

  const item: React.CSSProperties = {
    display: 'block', width: '100%', textAlign: 'left',
    padding: isMobile ? '12px 10px' : '7px 10px', minHeight: isMobile ? 44 : undefined,
    borderRadius: 8, border: 'none', background: 'transparent',
    color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13, cursor: 'pointer',
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => a11y.addLens()}
        onContextMenu={e => { e.preventDefault(); setOpen(v => !v) }}
        title={`${text.headerTitle} — ${text.headerHint}`}
        aria-label={text.headerTitle}
        aria-haspopup="menu"
        style={{
          width: isMobile ? 44 : 32, height: isMobile ? 44 : 32,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 8, border: '1px solid var(--border)', background: 'transparent',
          color: 'var(--anthropic-orange)', cursor: 'pointer', position: 'relative', flexShrink: 0,
        }}
      >
        <Search size={isMobile ? 18 : 14} />
        {a11y.lenses.length > 0 && (
          <span style={{
            position: 'absolute', top: -4, right: -4, minWidth: 16, height: 16, padding: '0 4px',
            borderRadius: 8, background: 'var(--anthropic-orange)', color: '#fff',
            fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>{a11y.lenses.length}</span>
        )}
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 2147483100 }} />
          <div role="menu" style={{
            position: 'absolute', right: 0, top: '100%', marginTop: 6, width: 290, zIndex: 2147483200,
            padding: 8, borderRadius: 12, background: 'var(--bg-elevated)',
            border: '1px solid var(--border)', boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
          }}>
            <button style={item} onClick={() => { a11y.addLens(); setOpen(false) }}>{text.newLens}</button>
            <div style={{ height: 1, background: 'var(--border)', margin: '6px 0' }} />
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', padding: '2px 10px 6px' }}>{text.lensesHere}</div>
            {a11y.lenses.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '0 10px 8px' }}>{text.noLensesHere}</div>
            )}
            {a11y.lenses.map(l => (
              <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 4px' }}>
                <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)' }}>
                  {l.id} · {l.zoom}×{l.pinned ? ` · ${text.pin}` : ''}
                </span>
                <button style={{ ...item, width: 'auto', padding: '6px 8px' }}
                  onClick={() => { a11y.select(l.id); setOpen(false) }}>{text.select}</button>
                {l.pinned && (
                  <button style={{ ...item, width: 'auto', padding: '6px 8px' }}
                    onClick={() => a11y.updateLens(l.id, { pinned: false })}>{text.unpin}</button>
                )}
              </div>
            ))}
            <div style={{ height: 1, background: 'var(--border)', margin: '6px 0' }} />
            <button style={item} onClick={() => { a11y.setAllPinned(false); setOpen(false) }}>{text.unpinAll}</button>
            <button style={item} onClick={() => { a11y.setAllPinned(true); setOpen(false) }}>{text.pinAll}</button>
            <button style={{ ...item, color: 'var(--accent-red)' }}
              onClick={() => { a11y.removePage(a11y.page); setOpen(false) }}>{text.removeAllHere}</button>
            <div style={{ height: 1, background: 'var(--border)', margin: '6px 0' }} />
            <button style={item} onClick={() => { a11y.toggleFollow(); setOpen(false) }}>
              {a11y.followOn ? text.followOff : text.followOn}
            </button>
            <button style={item} onClick={() => { navigate('/settings/accessibility'); setOpen(false) }}>
              {text.openSettings}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Place the button in all three header positions**

In `packages/web/src/App.tsx`:

1. Import it:
   ```tsx
   import { MagnifierButton } from './components/a11y/MagnifierButton'
   ```
2. **Mobile top bar** — inside the flex `div` holding `HealthWarnings` and `NotificationBell`
   (find it by searching for `alt="agentistics"`), as the FIRST child:
   ```tsx
   <MagnifierButton ctx={appCtx} />
   ```
3. **Desktop action cluster** — in the filters row's action `div`, immediately before the
   `{data?.healthIssues && …}` line (search for `Hardware resources`; the cluster is just above it):
   ```tsx
   <MagnifierButton ctx={appCtx} />
   ```
4. **The fallback row** — the desktop filters row is rendered only when
   `data && !isCustomPage && !inSessionsWorkspace && !isMobile`. On `/custom` and in the Sessions
   workspace the button would otherwise be missing, and **a page with no way to reach a pinned lens
   is a page where pinning is permanent**. Immediately after that block's closing `)}`, add:
   ```tsx
   {data && !isMobile && (isCustomPage || inSessionsWorkspace) && a11y.prefs.enabled && (
     <div style={{
       maxWidth: 1400, margin: '0 auto', padding: '4px 32px', width: '100%',
       boxSizing: 'border-box', display: 'flex', justifyContent: 'flex-end',
     }}>
       <MagnifierButton ctx={appCtx} />
     </div>
   )}
   ```

- [ ] **Step 5: Type check and full suite**

```bash
bun tsc --noEmit
bun test
```

Expected: `tsc` prints nothing; tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/a11y/LensMenu.tsx packages/web/src/components/a11y/MagnifierButton.tsx \
        packages/web/src/components/a11y/MagnifierLayer.tsx packages/web/src/App.tsx
git commit -m "feat(web): the header magnifier button and the two menus

The general menu is the only way a MOUSE reaches a pinned lens, so the button has to exist on
every route — including /custom and the Sessions workspace, which render no filters row. A page
without it is a page where pinning is permanent.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Keyboard control and the announcements

**Files:**
- Modify: `packages/web/src/components/a11y/MagnifierLayer.tsx`

**Interfaces:**
- Consumes: `applyLensKey`, `clampLens` (Task 2); `A11yText.announce`, `A11yText.removed` (Task 7).
- Produces: no new exports. The layer installs one `keydown` listener while the feature is on.

- [ ] **Step 1: Add the imports**

In `MagnifierLayer.tsx`:

```tsx
import { applyLensKey, clampLens } from '../../lib/magnifier'
```

- [ ] **Step 2: Add the key handler**

Insert this effect after the scheduler effect:

```tsx
  // One global keydown while the feature is on. Every guard here exists so the feature cannot take
  // the dashboard's own keyboard: a chord that is not ours falls through untouched.
  useEffect(() => {
    if (!active) return

    const editable = (target: EventTarget | null): boolean => {
      const node = target as HTMLElement | null
      if (!node || typeof node.tagName !== 'string') return false
      const tag = node.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
      if (node.isContentEditable) return true
      // The session terminal takes every key it can get.
      return typeof node.closest === 'function' && node.closest('.xterm') !== null
    }

    const onKey = (e: KeyboardEvent) => {
      // Ctrl+Shift+Z is the browser's redo. Inside a field it stays the browser's.
      if (e.ctrlKey && e.shiftKey && (e.key === 'Z' || e.key === 'z')) {
        if (editable(e.target)) return
        e.preventDefault()
        a11y.toggleFollow()
        return
      }

      // Ctrl+Shift+M — enter keyboard control with no mouse. Without it, "full keyboard control"
      // would still need an opening click.
      if (e.ctrlKey && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
        if (editable(e.target) || a11y.lenses.length === 0) return
        e.preventDefault()
        const first = a11y.lenses[0]
        a11y.select(first.id)
        a11y.announce(text.announce(first.id, first.zoom, first.width, first.height, first.pinned))
        return
      }

      if (!a11y.selectedId || editable(e.target)) return

      // Tab is intercepted ONLY while a lens is selected; Esc gives it back. A permanently
      // hijacked Tab would make the dashboard unusable by keyboard, which is the opposite of what
      // this feature is for. Pinned lenses ARE included: keyboard is how they are reached.
      if (e.key === 'Tab') {
        const idx = a11y.lenses.findIndex(l => l.id === a11y.selectedId)
        if (idx < 0) return
        e.preventDefault()
        const n = a11y.lenses.length
        const next = a11y.lenses[(idx + (e.shiftKey ? -1 : 1) + n) % n]
        a11y.select(next.id)
        a11y.announce(text.announce(next.id, next.zoom, next.width, next.height, next.pinned))
        return
      }

      const lens = a11y.lenses.find(l => l.id === a11y.selectedId)
      if (!lens) return
      const result = applyLensKey(lens, e.key, {
        shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey,
      })
      if (result === null) return
      e.preventDefault()

      if (result === 'remove') {
        a11y.removeLens(lens.id)
        a11y.announce(text.removed)
        return
      }
      if (result === 'deselect') {
        a11y.select(null)
        return
      }
      const next = clampLens(result, { width: window.innerWidth, height: window.innerHeight })
      a11y.updateLens(lens.id, next)
      a11y.announce(text.announce(next.id, next.zoom, next.width, next.height, next.pinned))
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, a11y, text])
```

- [ ] **Step 3: Type check and full suite**

```bash
bun tsc --noEmit
bun test
```

Expected: `tsc` prints nothing; tests pass.

- [ ] **Step 4: Verify in a browser**

```bash
bun run dev
```

Ask the human:

> With the magnifiers on and at least two lenses on the page, please check and tell me which of
> these do NOT work:
> 1. `Ctrl+Shift+M` selects a lens (it gains a thicker orange glow).
> 2. Arrows move it; `Alt`+arrows move it in 1px steps; `Shift`+arrows resize it.
> 3. `+` and `−` change the magnification.
> 4. `P` pins it (controls vanish) and `P` again unpins it.
> 5. `Tab` moves to the next lens **including a pinned one**, whose controls come back while it is
>    selected; pressing `P` there unpins it for good.
> 6. `Esc` releases, and `Tab` afterwards moves through the page's own links again.
> 7. Click into any text field: typing arrows, `p` and `Delete` types normally and moves no lens.
> 8. `Ctrl+Shift+Z` inside a text field still performs the browser's redo.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/a11y/MagnifierLayer.tsx
git commit -m "feat(web): keyboard control of the lenses, announced as it goes

Tab is intercepted only while a lens is selected and Esc gives it back: a permanently hijacked
Tab would make the dashboard unusable by keyboard, which is the opposite of the point.
Ctrl+Shift+Z stays the browser's redo inside a text field.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: The cursor-following lens

**Files:**
- Modify: `packages/web/src/components/a11y/MagnifierLayer.tsx`

**Interfaces:**
- Consumes: `LensStyle` (`@agentistics/core`), `stageTransform` (Task 2), `createMirrorHost` (Task 6).
- Produces: no new exports.

- [ ] **Step 1: Add the follow lens**

Add these imports to `MagnifierLayer.tsx`:

```tsx
import { useRef } from 'react'
import type { LensStyle } from '@agentistics/core'
import { stageTransform } from '../../lib/magnifier'
import { createMirrorHost } from '../../lib/magnifierMirror'
```

(merge them into the existing import lines rather than duplicating them), then add this component
at the bottom of the file:

```tsx
/**
 * The cursor-following lens. Deliberately NOT a `Lens`: it has no controls, no drag, no menu and
 * no persistence, so threading four "off" flags through that component would leave every branch of
 * it carrying a case only this one lens hits.
 *
 * Always pointerEvents:none — a lens sitting under the cursor that intercepted clicks would make
 * the page unusable. Its ON/OFF state is NOT persisted: every page load starts with it off.
 */
function FollowLens({ style, scheduler }: { style: LensStyle; scheduler: MirrorScheduler }) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const move = (e: MouseEvent) => setPos({ x: e.clientX, y: e.clientY })
    const leave = () => setPos(null)
    window.addEventListener('mousemove', move)
    document.addEventListener('mouseleave', leave)
    return () => {
      window.removeEventListener('mousemove', move)
      document.removeEventListener('mouseleave', leave)
    }
  }, [])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const host = createMirrorHost(stage)
    scheduler.register('__follow__', host, () => true)
    host.syncNow()
    return () => { scheduler.unregister('__follow__'); host.destroy() }
  }, [scheduler])

  // NEVER `return null` here. The mirror effect above resolves `stageRef.current` once, on mount;
  // unmounting the stage whenever the pointer is outside the window would mean the very first
  // render (pos === null) registers nothing and the lens stays blank forever. It is HIDDEN
  // instead, so the stage element the effect captured stays mounted for the component's life.
  const hidden = pos === null
  const at = pos ?? { x: -9999, y: -9999 }
  const placed = { ...style, x: at.x - style.width / 2, y: at.y - style.height / 2 }
  const t = stageTransform(placed)

  return (
    <div aria-hidden="true" style={{
      position: 'fixed', left: placed.x, top: placed.y, width: style.width, height: style.height,
      border: `${style.borderWidth}px solid var(--anthropic-orange)`,
      borderRadius: style.shape === 'circle' ? '50%' : style.cornerRadius,
      overflow: 'hidden', background: 'var(--bg-base)',
      boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
      pointerEvents: 'none', zIndex: 2147483050, boxSizing: 'border-box',
      visibility: hidden ? 'hidden' : 'visible',
    }}>
      <div ref={stageRef} style={{
        width: '100vw', height: '100vh', transformOrigin: '0 0',
        transform: `scale(${t.scale}) translate(${t.tx}px, ${t.ty}px)`, pointerEvents: 'none',
      }} />
    </div>
  )
}
```

**Why it hides instead of unmounting:** `createMirrorHost(stage)` captures `stageRef.current` once,
in an effect with `[scheduler]` as its only dependency. A `return null` while `pos` is null means
that effect runs against a null ref on the very first render, bails out, and never runs again — so
the follow lens would register no mirror at all and stay blank forever. Hiding keeps the stage
mounted for the component's whole life. Do not "simplify" this back to an early return.

- [ ] **Step 2: Render it**

Inside the portal, after the lens list:

```tsx
      {a11y.followOn && <FollowLens style={a11y.prefs.followLens} scheduler={scheduler} />}
```

- [ ] **Step 3: Type check and full suite**

```bash
bun tsc --noEmit
bun test
```

Expected: `tsc` prints nothing; tests pass.

- [ ] **Step 4: Verify in a browser**

```bash
bun run dev
```

Ask the human:

> With the magnifiers on, press `Ctrl+Shift+Z` with focus NOT in a text field. Please confirm:
> 1. An orange circle appears at the cursor showing a magnified view, and follows the mouse.
> 2. Clicking through it still activates what is underneath — buttons, links, filter chips.
> 3. It disappears when the mouse leaves the window and comes back — still showing content — when
>    the mouse returns.
> 4. `Ctrl+Shift+Z` again turns it off.
> 5. After a page reload it is off again.

If (3) comes back blank, the stage is being unmounted — re-read the note in Step 1.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/a11y/MagnifierLayer.tsx
git commit -m "feat(web): Ctrl+Shift+Z toggles a lens that follows the cursor

Always pointer-events none: a lens under the cursor that took clicks would make the page
unusable. Its on/off state is not persisted, by request — it is a tool for a moment, and it is
adjusted only in the settings tab.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: The Accessibility settings tab

**Files:**
- Create: `packages/web/src/pages/settings/AccessibilitySettings.tsx`
- Modify: `packages/web/src/lib/settingsSections.ts`
- Modify: `packages/web/src/AppRouter.tsx`

**Interfaces:**
- Consumes: `A11yState`, `a11yText` (Task 7); `LensStyle` and the bounds constants (Task 1).
- Produces: the default-exported `AccessibilitySettings` page and the `accessibility` section id.

- [ ] **Step 1: Register the section**

In `packages/web/src/lib/settingsSections.ts`, add `'accessibility'` to the union and one entry
immediately after `preferences`:

```ts
export type SettingsSectionId =
  | 'preferences' | 'accessibility' | 'sessions' | 'data-sources' | 'harnesses' | 'pricing' | 'billing' | 'install' | 'connection' | 'live'
  | 'chat' | 'notifications'
  | 'users' | 'teams' | 'machines' | 'repositories'
```

```ts
  { id: 'preferences', labelEn: 'Preferences', labelPt: 'Preferências', group: 'personal' },
  // Visible in BOTH modes: the magnifiers are stored per account on a central and per machine
  // otherwise, so there is no mode in which this screen has nothing to configure.
  { id: 'accessibility', labelEn: 'Accessibility', labelPt: 'Acessibilidade', group: 'personal' },
```

`visibleSettingsSections` needs no new case — its `default: return true` already shows it everywhere.

- [ ] **Step 2: Add the route**

In `packages/web/src/AppRouter.tsx`, add the lazy import beside the others:

```ts
const AccessibilitySettings = lazy(() => import('./pages/settings/AccessibilitySettings'))
```

and the route immediately after the `preferences` one:

```tsx
            <Route path="accessibility" element={<Suspense fallback={<PageFallback />}><AccessibilitySettings /></Suspense>} />
```

- [ ] **Step 3: Write the page**

Create `packages/web/src/pages/settings/AccessibilitySettings.tsx`:

```tsx
/**
 * AccessibilitySettings.tsx — the magnifiers' own screen.
 *
 * The master switch is first because it is the only control that makes the others matter, and off
 * means the feature costs nothing at all. The cursor-following lens is configured ONLY here: it
 * has no on-screen controls, by request.
 */
import React, { useMemo } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import type { LensStyle } from '@agentistics/core'
import { BORDER_MAX_PX, BORDER_MIN_PX, CORNER_MAX_PX, LENS_MIN_PX, ZOOM_MAX, ZOOM_MIN } from '@agentistics/core'
import type { AppContext } from '../../lib/app-context'
import { useIsMobile } from '../../hooks/useIsMobile'
import { a11yText, type A11yText } from '../../components/a11y/i18n'

function StyleEditor({
  style, onChange, text, isMobile,
}: { style: LensStyle; onChange(next: LensStyle): void; text: A11yText; isMobile: boolean }) {
  const row: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: isMobile ? '10px 0' : '7px 0', fontSize: 13, color: 'var(--text-secondary)',
  }
  const label: React.CSSProperties = { minWidth: isMobile ? 110 : 150, flexShrink: 0 }
  const value: React.CSSProperties = {
    minWidth: 58, textAlign: 'right', color: 'var(--text-primary)',
    fontWeight: 600, fontVariantNumeric: 'tabular-nums',
  }
  const chip = (on: boolean): React.CSSProperties => ({
    padding: isMobile ? '11px 14px' : '6px 12px', minHeight: isMobile ? 44 : undefined,
    borderRadius: 8, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
    border: '1px solid ' + (on ? 'var(--anthropic-orange)' : 'var(--border)'),
    background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
    color: 'var(--text-primary)',
  })

  return (
    <div>
      <div style={row}>
        <span style={label}>{text.shape}</span>
        <span style={{ display: 'flex', gap: 8 }}>
          {(['rect', 'circle'] as const).map(s => (
            <button key={s} style={chip(style.shape === s)}
              onClick={() => onChange({ ...style, shape: s, height: s === 'circle' ? style.width : style.height })}>
              {s === 'rect' ? text.rect : text.circle}
            </button>
          ))}
        </span>
      </div>

      <div style={row}>
        <span style={label}>{style.shape === 'circle' ? text.diameter : text.width}</span>
        <input type="range" min={LENS_MIN_PX} max={1200} step={10} value={style.width} style={{ flex: 1 }}
          onChange={e => {
            const w = Number(e.target.value)
            onChange({ ...style, width: w, height: style.shape === 'circle' ? w : style.height })
          }} />
        <span style={value}>{style.width}px</span>
      </div>

      {style.shape === 'rect' && (
        <div style={row}>
          <span style={label}>{text.height}</span>
          <input type="range" min={LENS_MIN_PX} max={1200} step={10} value={style.height} style={{ flex: 1 }}
            onChange={e => onChange({ ...style, height: Number(e.target.value) })} />
          <span style={value}>{style.height}px</span>
        </div>
      )}

      <div style={row}>
        <span style={label}>{text.zoom}</span>
        <input type="range" min={ZOOM_MIN} max={ZOOM_MAX} step={0.5} value={style.zoom} style={{ flex: 1 }}
          onChange={e => onChange({ ...style, zoom: Number(e.target.value) })} />
        <span style={value}>{style.zoom}×</span>
      </div>

      <div style={row}>
        <span style={label}>{text.borderWidth}</span>
        <input type="range" min={BORDER_MIN_PX} max={BORDER_MAX_PX} step={1} value={style.borderWidth} style={{ flex: 1 }}
          onChange={e => onChange({ ...style, borderWidth: Number(e.target.value) })} />
        <span style={value}>{style.borderWidth}px</span>
      </div>

      {style.shape === 'rect' && (
        <div style={row}>
          <span style={label}>{text.cornerRadius}</span>
          <input type="range" min={0} max={CORNER_MAX_PX} step={2} value={style.cornerRadius} style={{ flex: 1 }}
            onChange={e => onChange({ ...style, cornerRadius: Number(e.target.value) })} />
          <span style={value}>{style.cornerRadius}px</span>
        </div>
      )}

      {/* The preview uses the same border rule the real lens uses, so what is configured is what
          will appear. It shows the FRAME, not a live mirror: a mirror here would magnify the
          settings page and say nothing about the setting. */}
      <div style={{
        marginTop: 10, display: 'flex', justifyContent: 'center',
        padding: 12, background: 'var(--bg-base)', borderRadius: 10,
      }}>
        <div style={{
          width: Math.min(style.width, 220),
          height: style.shape === 'circle' ? Math.min(style.width, 220) : Math.min(style.height, 160),
          border: `${style.borderWidth}px solid var(--anthropic-orange)`,
          borderRadius: style.shape === 'circle' ? '50%' : Math.min(style.cornerRadius, 40),
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-tertiary)', fontSize: 12, boxSizing: 'border-box',
        }}>{style.zoom}×</div>
      </div>
    </div>
  )
}

export default function AccessibilitySettings() {
  const ctx = useOutletContext<AppContext>()
  const { a11y, lang } = ctx
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const text = useMemo(() => a11yText(lang), [lang])

  const card: React.CSSProperties = {
    background: 'var(--bg-surface)', border: '1px solid var(--border)',
    borderRadius: 12, padding: isMobile ? 14 : 18, marginBottom: 16,
  }
  const h: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 10 }
  const note: React.CSSProperties = { fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }
  const smallBtn: React.CSSProperties = {
    padding: isMobile ? '10px 12px' : '5px 10px', minHeight: isMobile ? 44 : undefined,
    borderRadius: 7, border: '1px solid var(--border)', background: 'transparent',
    fontFamily: 'inherit', fontSize: 12, cursor: 'pointer',
  }

  const pages = Object.entries(a11y.prefs.lensesByPage)

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div style={h}>{text.enable}</div>
            <div style={note}>{text.enableHelp}</div>
          </div>
          <button
            role="switch"
            aria-checked={a11y.prefs.enabled}
            aria-label={text.enable}
            onClick={() => a11y.setEnabled(!a11y.prefs.enabled)}
            style={{
              width: 52, minWidth: 52, height: isMobile ? 44 : 30, borderRadius: 999,
              cursor: 'pointer', border: '1px solid var(--border)', position: 'relative', flexShrink: 0,
              background: a11y.prefs.enabled ? 'var(--anthropic-orange)' : 'var(--bg-elevated)',
            }}
          >
            <span style={{
              position: 'absolute', top: '50%', transform: 'translateY(-50%)',
              left: a11y.prefs.enabled ? 26 : 4, width: 20, height: 20, borderRadius: '50%',
              background: '#fff', transition: 'left 0.15s',
            }} />
          </button>
        </div>
        <div style={{ ...note, marginTop: 12 }}>{text.borderIsOrange}</div>
      </div>

      <div style={card}>
        <div style={h}>{text.followLens} — Ctrl+Shift+Z</div>
        <StyleEditor style={a11y.prefs.followLens} onChange={a11y.setFollowStyle} text={text} isMobile={isMobile} />
      </div>

      <div style={card}>
        <div style={h}>{text.newLensDefaults}</div>
        <StyleEditor style={a11y.prefs.newLensDefaults} onChange={a11y.setNewLensDefaults} text={text} isMobile={isMobile} />
      </div>

      <div style={card}>
        <div style={h}>{text.savedLenses}</div>
        {pages.length === 0 && <div style={note}>{text.noLensesHere}</div>}
        {pages.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ color: 'var(--text-tertiary)', textAlign: 'left' }}>
                  <th style={{ padding: '6px 8px', fontWeight: 600 }}>{text.page}</th>
                  <th style={{ padding: '6px 8px', fontWeight: 600 }}>{text.count}</th>
                  <th style={{ padding: '6px 8px', fontWeight: 600 }}>{text.zoom}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pages.map(([page, lenses]) => (
                  <tr key={page} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: 8, color: 'var(--text-primary)', fontFamily: 'ui-monospace, monospace' }}>{page}</td>
                    <td style={{ padding: 8 }}>{lenses.length}</td>
                    <td style={{ padding: 8 }}>{lenses.map(l => `${l.zoom}×`).join(' · ')}</td>
                    <td style={{ padding: 8, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button style={{ ...smallBtn, color: 'var(--text-secondary)' }} onClick={() => navigate(page)}>
                        {text.goToPage}
                      </button>
                      <button style={{ ...smallBtn, marginLeft: 6, color: 'var(--accent-red)' }}
                        onClick={() => a11y.removePage(page)}>
                        {text.remove}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={card}>
        <div style={h}>{text.keyboardTitle}</div>
        <ul style={{ ...note, margin: 0, paddingLeft: 18 }}>
          {text.keyboardHelp.map(line => <li key={line} style={{ marginBottom: 3 }}>{line}</li>)}
        </ul>
      </div>

      <div style={card}>
        <div style={h}>{text.performance}</div>
        <div style={note}>{text.canvasCaveat}</div>
        <div style={{ ...note, marginTop: 8 }}>{text.schedulerNote}</div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Type check and full suite**

```bash
bun tsc --noEmit
bun test
```

Expected: `tsc` prints nothing; tests pass.

- [ ] **Step 5: Verify in a browser**

```bash
bun run dev
```

Ask the human:

> Please open http://localhost:47292/settings/accessibility and confirm:
> 1. An "Accessibility / Acessibilidade" entry appears in the settings menu, under Preferences.
> 2. Turning the master switch on makes a magnifier icon appear in the header; turning it off
>    removes the icon and every lens.
> 3. Changing the follow lens's shape, size, zoom and border updates the preview beside it, and
>    `Ctrl+Shift+Z` then shows a lens matching those settings.
> 4. Creating a lens from the header uses the "defaults for new lenses" values.
> 5. The "Saved lenses" table lists each page and its lenses; "go to that page" navigates and the
>    lenses are there; "remove" clears that page's row.
> 6. Reload the page: everything you configured is still there.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/pages/settings/AccessibilitySettings.tsx \
        packages/web/src/lib/settingsSections.ts packages/web/src/AppRouter.tsx
git commit -m "feat(web): the Accessibility settings tab

The master switch leads because it is the only control that makes the others matter. The
cursor-following lens is configured only here, by request — it has no on-screen controls. The
canvas limitation is stated in the tab rather than left to be discovered as an empty lens.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Mobile pass, full verification, and the PR

**Files:**
- Modify: `packages/web/src/App.tsx` (the "More" sheet tile)
- Modify: whichever a11y component the 390px check finds wanting.

**Interfaces:** none new.

- [ ] **Step 1: Add a tile to the mobile "More" sheet**

In `packages/web/src/App.tsx`, find the `navTiles` array used by `MobileBottomNav` and add a tile
that navigates to `/settings/accessibility`, copying the shape of a neighbouring tile exactly (same
icon size, same label pattern, same EN/PT handling). Use the `Search` icon from `lucide-react`, the
same one the header button uses — one feature, one icon.

Render the tile **only when `!a11y.prefs.enabled`**. Once the feature is on, the header button is
the way in, and two entry points to the same screen on a phone is one too many.

- [ ] **Step 2: Verify at 390px**

```bash
bun run dev
```

Ask the human:

> Please open http://localhost:47292 in Chrome, press F12, turn on device emulation and choose a
> 390px-wide device. With the magnifiers ON and two lenses placed, run this in the console and tell
> me what it prints:
>
> ```js
> document.documentElement.scrollWidth <= window.innerWidth
> ```
>
> It must print `true`. Then please confirm:
> 1. The magnifier icon is visible beside the notification bell.
> 2. The lens control icons are big enough to hit with a thumb.
> 3. Long-pressing / right-clicking a lens opens a sheet from the bottom of the screen, not a
>    popover under your finger.
> 4. On Settings → Accessibility, tapping a slider does not zoom the page in.

If the first check prints `false`, find the offending element with:

```js
Array.from(document.querySelectorAll('*')).filter(e => e.getBoundingClientRect().right > window.innerWidth)
```

and constrain it. The page body must never scroll horizontally.

- [ ] **Step 3: Run the full verification**

```bash
bun tsc --noEmit
bun test
bun run build
```

Expected: `tsc` silent, tests pass, the Vite build completes. **Report the actual output.** If
`bun test` shows a failure in a file this branch did not touch, say so explicitly rather than
fixing it — another session may be working in the shared checkout, and a red test may not be yours.

- [ ] **Step 4: Walk the spec's acceptance list**

Open `docs/superpowers/specs/2026-09-03-accessibility-magnifiers-design.md` §12 and check each
line. Ask the human to confirm anything that needs eyes. **Do not mark a line passed that was not
actually observed** — write down what was checked and what was not, and by whom.

The central-mode line ("two different signed-in accounts have independent lenses") needs a running
central. If none is available, say so plainly in the PR rather than claiming it passed: the
per-account store is the part of this change that a machine-only test cannot exercise.

- [ ] **Step 5: Commit, push and open the PR**

```bash
git status --short
git add packages/web/src/App.tsx
git commit -m "feat(web): mobile pass for the magnifiers

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/accessibility-magnifiers
```

Stage explicit paths, never `git add -A`: another session's in-progress files live in this
repository too.

Verify the push actually happened — `rtk` has been observed printing a success it did not achieve:

```bash
git ls-remote --heads origin feat/accessibility-magnifiers
```

Then open a PR against `dev` whose body carries: the acceptance results from Step 4 (including
anything not verified and why), the two stated limitations (canvas/WebGL, and whatever Task 6
Step 1 found about `position: fixed`), and a link to the spec.

---

## Self-review notes

**Spec coverage.** Every section of the spec maps to a task:

| spec | task |
|---|---|
| §3 lens layer outside `#root` | 8 (`useLayerContainer` appends to `document.body`) |
| §4.1 structure, `stageTransform` | 2, 8 |
| §4.2 reconciliation, canvas cleared not stale | 6 |
| §4.3 scheduling, backoff, no lens cap | 3, 6 |
| §4.4 rejected capture approach | none — it is a record, not work |
| §5.1–5.3 persistence and PUT semantics | 4, 5 |
| §5.4 page key | 2 |
| §6.1 header button, three placements | 9 |
| §6.2 / §6.3 lens states, pinning to glass | 8 |
| §6.4 keyboard table | 10 |
| §6.5 `aria-live` region | 8 |
| §6.6 follow lens | 11 |
| §7 module list | 1–12, one file per row |
| §8 settings tab, all five blocks | 12 |
| §9 mobile | inline in 8, 9, 12; verified in 13 |
| §10 risk 1 verified before anything depends on it | 6 step 1 |
| §10 risk 2 behaviour defined and stated in the UI | 6, 12 |
| §10 risk 3 mitigation | 3 |
| §10 risk 4 duplicate ids / focus | 6 (`neutralize`) |
| §11 tests | 1, 2, 3, 4 |
| §12 acceptance | 13 step 4 |

**Type consistency.** The names used across tasks are the ones defined: `AccessibilityPrefs`,
`LensStyle`, `MagnifierLens`, `LensShape`, `sanitizeAccessibilityPrefs`,
`DEFAULT_ACCESSIBILITY_PREFS`, `ZOOM_MIN`/`ZOOM_MAX`/`LENS_MIN_PX`/`LENS_MAX_PX`/`BORDER_MIN_PX`/
`BORDER_MAX_PX`/`CORNER_MAX_PX` (Task 1); `pageKey`, `sourceRect`, `stageTransform`, `clampLens`,
`applyLensKey`, `newLens`, `MOVE_STEP_PX`, `MOVE_FINE_PX`, `RESIZE_STEP_PX`, `ZOOM_STEP` (Task 2);
`pickLensesToSync`, `nextMinInterval`, `MIRROR_DEFAULTS`, `MIRROR_BUDGET_MS`,
`MIRROR_MAX_INTERVAL_MS`, `MirrorLensState`, `MirrorScheduleConfig` (Task 3); `resolveA11yStore`,
`applyA11yPut`, `A11yStore` (Task 4); `readUserAccessibility`, `writeUserAccessibility`,
`deleteUserPrefs`, `handleAccessibility` (Task 5); `createMirrorHost`, `startMirrorScheduler`,
`MirrorHost`, `MirrorScheduler` (Task 6); `A11yText`, `a11yText`, `A11yState`, `useAccessibility`
(Task 7). `duplicateLens` is declared on `A11yState` in Task 7 and first used in Task 9.

**Every server helper this plan calls was read before it was written into a code block** —
`readJsonLimited`'s result-object return, `safeError`'s `{ verbose }` option, `PROFILE`,
`getMongoDb`, `getPrincipal`, and the fact that `writePreferences` merges rather than replaces.
`CORS_HEADERS` turned out not to be importable at all (it is built per request in `index.ts`), which
is why `handleAccessibility` takes it as a parameter. Task 5 Step 4 records those findings instead
of asking the implementer to re-derive them.

**What is NOT covered by a test, and is verified by a person instead**: the DOM mirror's effects
(Tasks 6, 8, 11), the keyboard bindings against a real browser (Task 10), and the 390px layout
(Task 13). This repository has no DOM test environment — component tests use `renderToStaticMarkup`
— and browser automation hangs here, so those steps are written as questions for the human. An
implementer must report what the human answered and must not mark them passed unobserved.
