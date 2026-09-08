# Accessibility magnifiers — design

Date: 2026-09-03
Status: approved (design), not yet implemented
Scope: `packages/web`, `packages/core`, `packages/server` — the web dashboard only, in BOTH
machine and central mode. Nothing in the TUI, the VS Code extension or the CLI changes.

## 1. What this is for

A low-vision user needs to read this dashboard. The browser's own zoom scales the whole page,
which reflows a data-dense layout into something worse; an OS magnifier covers the screen and
loses the surrounding context. What actually works for them is a **lens**: a small window that
sits over one region and magnifies only that region, while the rest of the page stays where it
was, at the size it was.

This change delivers:

- **Placed lenses** — any number of them, positioned and sized by the user, each with its own
  zoom, each belonging to ONE page. Leaving a page and coming back finds them where they were.
- **Pinning** — a lens the user is done adjusting becomes glass: its controls disappear and it
  stops receiving pointer events entirely, so it can sit over a table without being in the way.
- **A follow lens** — `Ctrl+Shift+Z` toggles a single lens that tracks the cursor on every page.
- **An Accessibility settings tab** — the master switch, the follow lens's shape/size/zoom/border,
  the defaults for new lenses, and an inventory of every saved lens.

There is **no cap on the number of lenses**. The user asked for one and then withdrew it, on the
grounds that lenses are per page: a cap that felt generous on one page is a wall on another.
The cost of many lenses is handled by the scheduler in §4, not by a limit.

**Border colour is always the site orange (`var(--anthropic-orange)`) and is not configurable.**
Thickness and shape are. This is a stated product decision, and the settings tab says so in a
sentence rather than leaving a missing colour picker to be read as an oversight.

## 2. Non-goals

Named so the boundary is explicit, not to be quietly picked up later:

- No OS-level or browser-level zoom control.
- No screen-reader integration beyond the `aria-live` region in §6.
- No contrast, font-size or colour-blindness settings. The tab is called Accessibility and is
  expected to grow; this change delivers the magnifiers and nothing else.
- No magnification of a second browser tab or of anything outside this document.

## 3. Where the lenses live in the document

A single container `<div id="ag-magnifiers">` is appended to `document.body` as a **sibling of
`#root`**, and every lens is rendered into it with `createPortal`.

This is load-bearing, not tidiness. The mirror (§4) clones `#root`. If the lens layer were inside
`#root`, every lens would clone every other lens, including itself — an infinite tunnel, and a
clone cost that grows with each frame. Being outside `#root` is what makes the recursion
structurally impossible rather than something to be guarded against.

The container is created on demand when the feature is switched on and removed when it is switched
off. With the master switch off there is no container, no observer and no lens: **the cost of the
feature when unused is zero**, which is why it is a switch and not a preference that merely hides
things.

## 4. The mirror — how a lens sees what is under it

### 4.1 Structure

Each lens is three nested elements:

```
lens        position:fixed, orange border, overflow:hidden
            border-radius: 50% (circle) or the configured radius (rectangle)
  stage     width:100vw height:100vh, transform-origin: 0 0
            transform: scale(z) applied so the source region lands centred in the lens
    clone   cloneNode(true) of #root — inert, aria-hidden, pointer-events:none
```

The **source region** is the area of the viewport the lens magnifies: it is centred on the lens's
own centre and measures the lens's *interior* size — `(width - 2*borderWidth) / zoom` by
`(height - 2*borderWidth) / zoom`, since `box-sizing: border-box` is what the lens actually shows
through — the region beneath itself, which is what makes it read as a physical lens laid on
the screen.

The stage is an ordinary in-flow child of the (bordered) lens frame, so its own untransformed
origin sits at the frame's content-box origin, not the viewport origin. Within the stage, a page
coordinate P sits at the same stage-local coordinate P, since the stage carries a clone of the
whole page. One consequence is deliberate and useful: because the stage carries a
`transform`, it becomes the containing block for `position: fixed` descendants of the clone, so
the cloned sticky header and sidebar lay out against the stage — that is, in the same place they
occupy on screen. **This is reasoned, not yet observed in a browser, and is the first thing to
verify during implementation** (see §10).

### 4.2 What `cloneNode` gets for free, and what it does not

Free: the element tree, attributes, inline styles (which is how most of this app paints), and text.
Global CSS in `index.css` applies to the clone because it lives in the same document, and the
custom properties defined on `:root` reach it by inheritance.

Not free, and therefore reconciled by an explicit pass after each clone:

| lost | recovered by |
|---|---|
| `scrollTop` / `scrollLeft` of scrollable containers | walk live and cloned trees in parallel, copy both values |
| `value` / `checked` of form controls (properties, not attributes) | same parallel walk |
| `<canvas>` pixels | `ctx.drawImage(liveCanvas, 0, 0)`, in `try/catch` |

The clone is additionally stripped of `id` and `name` attributes (duplicate ids in one document are
a real hazard for anything calling `getElementById`), and marked `inert` + `aria-hidden="true"` +
`pointer-events: none` so it is invisible to assistive technology, to focus, and to the mouse.
Screen readers must hear the page once, not once per lens.

**The canvas copy is best effort and the product says so.** The session terminal is xterm, which
may render through WebGL; a WebGL canvas without `preserveDrawingBuffer` yields nothing to
`drawImage`, and a tainted canvas throws. Where the pixels cannot be copied the lens shows that
region empty. The Accessibility tab states this limitation in plain words. An empty region a user
was warned about is recoverable; a lens that silently shows stale pixels from the last successful
copy is not, so **a failed canvas copy clears the cloned canvas rather than leaving the previous
frame**.

### 4.3 Scheduling — bounded cost, no lens cap

A `MutationObserver` on `#root` (`subtree`, `childList`, `attributes`, `characterData`) marks
lenses dirty. Resynchronisation is coalesced into `requestAnimationFrame` and bounded by three
rules:

1. **At most `MIRROR_LENSES_PER_FRAME` (2) lenses are re-cloned per frame**, round-robin. Twenty
   lenses therefore cost ten frames of catching up, never one frame of ten clones.
2. **A lens whose rectangle is off-screen is skipped entirely.**
3. **A minimum interval between syncs of the same lens** (`MIRROR_MIN_INTERVAL_MS`, 100 ms), and a
   **500 ms heartbeat** that syncs regardless, to catch what a `MutationObserver` cannot see:
   canvas painting, CSS animation, and internal scrolling.

The sync duration is measured. If a cycle exceeds `MIRROR_BUDGET_MS`, the minimum interval backs
off (doubling, capped at `MIRROR_MAX_INTERVAL_MS`) and recovers as cycles come back under budget.
The current interval is shown in the settings tab's performance block, so a user on a slow machine
can see why their lenses feel less immediate instead of concluding the feature is broken.

Scroll and resize of the window re-run the parallel walk (scroll positions) but do **not** force a
re-clone: the DOM has not changed, only its scroll offsets.

### 4.4 A rejected alternative, recorded

Tab screen capture (`getDisplayMedia` + a `<canvas>` crop per lens) would be perfectly faithful,
would include the terminal, and would cost the same for one lens or twenty. It was rejected on
three counts: it requires a permission grant and shows a persistent sharing indicator; it requires
a secure context, which excludes a central reached over plain HTTP on a LAN; and — decisively —
**the capture includes the lenses themselves**, so each lens renders a recursive image of its own
frame. Only Element Capture (`RestrictionTarget`, Chrome 132+) escapes that, which would make the
feature Chrome-only. It is written down here so the idea is not re-proposed as an obvious win.

## 5. Persistence

### 5.1 Why not `/api/preferences`

`/api/preferences` reads and writes `~/.agentistics/preferences.json`, which is **per machine**. On
a central that file belongs to the container and is shared by every signed-in user, so one person's
magnifiers would appear on everyone's screen. An accessibility configuration is the most personal
setting this product has; it cannot be stored machine-wide.

### 5.2 One resolution, two destinations

| mode | store | key |
|---|---|---|
| machine (solo / member) | `~/.agentistics/preferences.json`, new field `accessibility` | the machine |
| central | Mongo, new collection `userPrefs` | `_id` = `accountId` from `getPrincipal(req)` |

New authenticated routes `GET /api/accessibility` and `PUT /api/accessibility`. They are
authenticated by the default rule (they are NOT added to `AUTH_PUBLIC`, so `authz-gate.test.ts`
needs no change). They touch no host power beyond the preferences file that `/api/preferences`
already writes, so they are not registered in `capability-guard.ts`.

The pure module `packages/server/server/a11y-prefs.ts` decides which destination applies and holds
the merge. The frontend makes one call and never learns which mode it is in — the same shape as
`central-runtime.ts`: the resolution lives in one place, and the caller receives an already-decided
answer.

`userPrefs` is a collection of its own rather than a field on `AccountDoc`, because `AccountDoc` is
listed by the governance panels and mapped to `PublicAccount`; UI preferences have no business
travelling with an identity record. Its `updatedAt` is added to `DATE_FIELDS` in `mongo-dates.ts`
and `DATE_MIGRATION_VERSION` is bumped, per the repository's date rule. Deleting an account also
deletes its `userPrefs` document.

### 5.3 The merge

A `PUT` carries the complete `AccessibilityPrefs` object. The server sanitises it (§7) and replaces
the stored document. It does **not** deep-merge per page: removing the last lens of a page must
actually remove it, and a merge that treats an absent key as "unchanged" makes deletion
impossible.

### 5.4 The page key

A lens belongs to `location.pathname`, **exactly**, with query string and hash ignored. Applying a
filter does not move a lens; `/repo/github.com/org/api` and `/repo/github.com/org/web` hold
independent sets. The pure `pageKey(pathname)` is the only place this is decided.

## 6. Interaction

### 6.1 The header button

Rendered only when the master switch is on.

- **Desktop** — in the action cluster of the filters row in the sticky header.
- **Mobile** — beside the notification bell in the top bar.
- **`/custom`** — that route renders no filters row on desktop, so the header carries a slim row
  holding just this button. The button must be reachable from every page; a page where the only
  way to control the lenses is missing is a page where a pinned lens is permanent.

Actions:

- **Left click** — create a lens at the centre of the viewport, already selected and editable,
  using the defaults from the settings tab.
- **Right click** — the general menu: the lenses of *this* page (each with its zoom and pinned
  state, each with unpin / select / remove), unpin all, pin all, remove all on this page, toggle
  the follow lens, and open the Accessibility tab.

**With a mouse, the general menu is the only way back to a pinned lens** — that is what makes
pinning safe. By keyboard there is a second way in, described in §6.4; it has to exist, because a
pinned lens takes no pointer events and a keyboard user has no pointer to reach it with anyway.

### 6.2 A lens, unpinned

Orange border of the configured thickness. A control strip carries: drag handle, zoom − / +, shape
toggle, pin, remove. A resize handle sits at the bottom-right corner. Dragging anywhere on the
frame moves it; the magnified content itself is inert.

Right-clicking the lens opens its own menu: exact zoom, shape, size, border thickness, duplicate,
pin, remove.

### 6.3 A lens, pinned

Controls vanish. The whole lens becomes `pointer-events: none` — clicks, hovers and scrolls pass
straight through to the page beneath. Only the orange frame remains, so the user can still see
where it is. It is reachable again in exactly two ways: the header's general menu, and keyboard selection
(§6.4). Selecting a pinned lens by keyboard puts it in a **revealed** state — its controls come
back and it is outlined — without unpinning it; `P` then unpins, and `Esc` deselects and returns it
to glass. Revealing is a view state and is never persisted.

### 6.4 Keyboard

The options presented during design contained a contradiction (`shift`+arrows was described both as
fine movement and as resize). Resolved here, and this table is the single source of truth:

| key | action |
|---|---|
| `←` `↑` `→` `↓` | move 10 px |
| `alt` + arrows | move 1 px |
| `shift` + arrows | resize |
| `+` / `−` | zoom in / out |
| `P` | pin / unpin |
| `Delete` / `Backspace` | remove |
| `Tab` / `shift+Tab` | next / previous lens on this page, **pinned ones included** |
| `Esc` | deselect — `Tab` returns to the page |
| `Ctrl+Shift+M` | select the first lens on this page (enter keyboard control with no mouse) |

Rules that keep this from breaking the app:

- Keys act **only while a lens is selected**, and **only when focus is not** in an `input`,
  `textarea`, `contenteditable`, or the terminal.
- `Tab` is intercepted only while a lens is selected. `Esc` gives it back. A permanently hijacked
  `Tab` would make the dashboard unusable by keyboard, which is the opposite of this feature's
  purpose.
- `Ctrl+Shift+M` was not requested. It is included because without it "full keyboard control"
  still requires an opening mouse click, which defeats it.

A selected lens is marked by a pulsing orange border, or — under `prefers-reduced-motion` — a
static thicker border.

### 6.5 The announcement region

One `aria-live="polite"` region inside the lens layer. Every keyboard action and every menu action
writes one sentence into it, in the active language:

> `Lens 2, zoom 4×, 320 by 240, pinned.`

### 6.6 The follow lens

`Ctrl+Shift+Z` toggles it. It exists on every page, tracks the cursor, hides when the pointer
leaves the window and reappears when it returns, and is **always** `pointer-events: none` — a lens
under the cursor that intercepted clicks would make the page unusable.

**Its on/off state is not persisted**: every page load starts with it off. It is adjusted **only**
in the settings tab (shape, size, zoom, border thickness, corner radius) — it has no on-screen
controls at all, by request.

`Ctrl+Shift+Z` is the browser's redo shortcut, so **the binding is ignored while focus is in an
editable field**.

## 7. Modules

### `packages/core/src/accessibility.ts` — pure

Shared because the server validates what the browser sends.

```ts
export type LensShape = 'circle' | 'rect'

export interface LensStyle {
  shape: LensShape
  width: number          // px; for a circle this is the diameter and height is ignored
  height: number         // px
  zoom: number           // 1.5 .. 20
  borderWidth: number    // px, 1 .. 12
  cornerRadius: number   // px, rect only
}

export interface MagnifierLens extends LensStyle {
  id: string
  x: number              // px from the viewport's left edge
  y: number              // px from the viewport's top edge
  pinned: boolean
}

export interface AccessibilityPrefs {
  enabled: boolean
  followLens: LensStyle
  newLensDefaults: LensStyle
  /** Keyed by exact pathname. */
  lensesByPage: Record<string, MagnifierLens[]>
}

export const DEFAULT_ACCESSIBILITY_PREFS: AccessibilityPrefs
export function sanitizeAccessibilityPrefs(input: unknown): AccessibilityPrefs
```

`sanitizeAccessibilityPrefs` is **total**: any input, including a hand-edited
`preferences.json` or a malformed `PUT`, yields a valid object. Out-of-range numbers are clamped,
unknown shapes fall back to `rect`, non-object pages are dropped, and duplicate lens ids are
re-minted. It is idempotent.

### `packages/web/src/lib/magnifier.ts` — pure

- `pageKey(pathname: string): string` — ignores query and hash.
- `sourceRect(lens): Rect` — the viewport region a lens magnifies.
- `stageTransform(lens): { scale: number; tx: number; ty: number }` — what the stage's
  `transform` must be for that region to land centred in the lens.
- `clampLens(lens, viewport): MagnifierLens` — keeps a lens on screen and within the size and
  zoom bounds. Applied on every drag, resize, keyboard move and window resize, so a lens can
  never be parked outside the viewport where nothing can reach it.
- `applyLensKey(lens, key, mods): MagnifierLens | 'remove' | 'deselect' | null` — the keyboard
  reducer from §6.4. `null` means the key was not ours and must fall through to the page.

Constants, stated here so two call sites cannot disagree about a step size:

| constant | value |
|---|---|
| `MOVE_STEP_PX` / `MOVE_FINE_PX` | 10 / 1 |
| `RESIZE_STEP_PX` | 10 |
| `ZOOM_STEP` | 0.5 |
| `ZOOM_MIN` / `ZOOM_MAX` | 1.5 / 20 |
| `LENS_MIN_PX` / `LENS_MAX_PX` | 60 / 2000 (clamped to the viewport as well) |
| `BORDER_MIN_PX` / `BORDER_MAX_PX` | 1 / 12 |

### `packages/web/src/lib/magnifierMirror.ts` — the only DOM-touching part

`createMirror(stage: HTMLElement)` → `{ sync(), destroy() }`, plus the shared scheduler that
enforces §4.3. Clone, strip, parallel walk, canvas copy, budget measurement.

### `packages/web/src/components/a11y/`

`MagnifierLayer.tsx` (the portal, the lens list for the current route, the follow lens, the
announcement region), `Lens.tsx`, `LensMenu.tsx`, `MagnifierButton.tsx`.

### `packages/web/src/hooks/useAccessibility.ts`

Loads once from `GET /api/accessibility`, exposes state and actions through `AppContext`, and
debounces `PUT`s (a drag must not be one request per pointer move).

### `packages/web/src/pages/settings/AccessibilitySettings.tsx`

Plus the new `accessibility` entry in `lib/settingsSections.ts`, group `personal`, placed
immediately after `preferences`, visible in **both** machine and central mode (it is the one
personal setting that is not mode-specific).

### `packages/server/server/a11y-prefs.ts` — pure resolution + the two IO adapters

`resolveA11yStore(mode, principal)` decides the destination and is what the tests pin. The Mongo
and file adapters are thin.

## 8. The settings tab

1. **Master switch.** Off by default. Off means no container, no observer, no lens.
2. **Follow lens (`Ctrl+Shift+Z`)** — shape, size, zoom, border thickness, corner radius.
3. **Defaults for new lenses** — the same fields, applied when a lens is created from the header.
4. **Saved lenses** — a table by page: path, how many, their zooms, with "go to that page" and
   "remove all there". This is the answer to *"I put lenses somewhere and cannot remember where"*.
5. **Performance and limits** — the current mirror interval, and the plain statement that
   `<canvas>` / WebGL content (the session terminal) may not be copyable and will appear empty.

Each block carries a live preview showing a lens rendered with the current values. One sentence
states that the border is always the site orange and is not configurable.

## 9. Mobile

Ships in the same change, per the repository rule that a UI change is not done at 1440px:

- Header button beside the bell in the mobile top bar; entry in the "More" sheet as well.
- Lens controls have ≥ 44px touch targets **on mobile only** (the desktop strip stays compact).
- The lens context menu becomes a bottom sheet.
- Drag and resize use Pointer Events, so mouse and touch are one code path.
- Every settings input computes to ≥ 16px, using the global guard rather than an inline size.
- `document.documentElement.scrollWidth <= window.innerWidth` verified at 390px with lenses placed.

## 10. Risks, written down rather than discovered later

1. **`position: fixed` inside the clone.** The stage's `transform` should make the stage the
   containing block, putting the cloned header and sidebar in the right place. Reasoned, not yet
   observed. **Verify first**, before building anything on top of it. If it does not hold, the
   fallback is to strip `position: fixed` from cloned nodes and place them absolutely at their
   measured viewport rects during the parallel walk.
2. **Canvas / WebGL.** The terminal may simply not copy. Behaviour is defined (§4.2: clear, do not
   leave a stale frame) and stated in the UI; it is not a blocker.
3. **Clone cost on a heavy page.** Bounded by §4.3, and observable in the settings tab. If real
   measurement shows the full-`#root` clone is too heavy, the next step — deliberately *not* built
   speculatively — is to clone the nearest ancestor that fully contains the source region instead
   of all of `#root`.
4. **Duplicated ids and focus.** Handled by stripping `id`/`name` and marking the clone `inert`;
   worth an explicit check that focus order and screen-reader output are unchanged with lenses on.

## 11. Tests

No filesystem mocking — the functions under test are pure.

- `packages/core/src/accessibility.test.ts` — `sanitizeAccessibilityPrefs` against malformed JSON,
  out-of-range zoom and size, unknown shape, duplicate ids, missing keys; defaults; idempotence.
- `packages/web/src/lib/magnifier.test.ts` — `pageKey` ignoring query and hash; `sourceRect` and
  `stageTransform` against known geometry; `clampLens` at every edge and bound; `applyLensKey` key
  by key, including limits and the `null` fall-through.
- `packages/server/server/a11y-prefs.test.ts` — `resolveA11yStore` for machine and central, and
  that a `PUT` replaces rather than deep-merges (so the last lens of a page can be deleted).

## 12. Acceptance

- With the master switch on, a magnifier icon is present in the header on every route, including
  `/custom`, on desktop and on mobile.
- A lens created on `/costs`, positioned, zoomed and pinned survives navigating to `/projects`
  (which shows no lenses) and returning to `/costs`, and survives a page reload.
- A pinned lens passes every click and hover through to the page beneath it.
- A pinned lens can be unpinned from the header's right-click menu with a mouse, and by selecting
  it with `Tab` and pressing `P` from the keyboard — and by no other route.
- Every lens action listed in §6.4 works from the keyboard alone and is announced.
- `Ctrl+Shift+Z` toggles a cursor-following lens on every page; it starts off after a reload and
  does nothing while focus is in a text field.
- Lens borders are `var(--anthropic-orange)` in every state, in both themes.
- On a central, two different signed-in accounts have independent lenses.
- `bun tsc --noEmit` and `bun test` pass; the page does not scroll horizontally at 390px.
