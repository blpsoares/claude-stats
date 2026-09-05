# Accessibility magnifiers

Lenses a low-vision user places over the dashboard: small windows that magnify one region while the
rest of the page stays where it is, at the size it was. Browser zoom reflows a data-dense layout
into something worse, and an OS magnifier covers the screen and loses the surrounding context —
this keeps both.

Design record: [`docs/superpowers/specs/2026-09-03-accessibility-magnifiers-design.md`](superpowers/specs/2026-09-03-accessibility-magnifiers-design.md).

## What it gives the user

- **Placed lenses**, any number of them, each with its own size, shape and zoom, each belonging to
  ONE page (keyed by exact pathname). Leaving and returning finds them where they were.
- **Pinning** — a lens the user is done adjusting loses its controls and can no longer be moved or
  resized. It stays interactive.
- **A cursor-following lens** on `Ctrl+Shift+Z`, configured only in Settings → Accessibility.
- **Full keyboard control**, every action announced through an `aria-live` region. This is not a
  convenience: someone who cannot see a 26px handle cannot aim at one either.
- **Interaction through the lens** — click, wheel and hover reach the magnified item.
- **Zoom from 0.55× to 20×**. Below 1× it reduces, which is how you see more context at once.

There is deliberately **no cap on the number of lenses**. The cost is bounded by the scheduler
(below), never by a limit.

## The rules that hold the whole thing together

**The lens layer is a SIBLING of `#root`.** Each lens mirrors `#root`; a layer inside it would
clone itself, forever. This makes the recursion structurally impossible rather than something to be
guarded against. Never move the container into the React tree.

**The mirror is a picture, not a live page.** `magnifierMirror.ts` clones `#root` into each lens,
`inert` + `aria-hidden` + `pointer-events: none`, with `id`/`name` stripped. A second live copy
would duplicate ids, focus and side effects, and a screen reader would hear the page twice.
`cloneNode` does not carry scroll positions, form state or canvas pixels, so a reconciliation pass
copies all three by walking the live and cloned trees in step.

**A canvas that cannot be copied is CLEARED, never left stale.** WebGL without
`preserveDrawingBuffer` yields nothing and a tainted canvas throws. An empty region the settings
screen warned about is recoverable; a stale one that looks live is not.

**The clone is offset by `-scroll`, and stays `position: relative`.** That offset is what makes
stage-local coordinates equal viewport coordinates, which every piece of geometry assumes.
`relative` is load-bearing: unlike `absolute`/`fixed`/`transform` it does NOT become a containing
block for `position: fixed` descendants, so the cloned sidebar and modals still resolve against the
lens's stage and land where they belong.

**A `position: sticky` element is moved with `transform`, never with `position`.** Sticky is IN
FLOW. Changing it to `fixed`/`absolute` removes it from flow and everything around it collapses —
that shipped once and corrupted the mirror on every page, because the app header is sticky
everywhere. A transform is paint-only and cannot affect layout. Only stickies whose scroller is the
WINDOW are moved at all; one inside an `overflow: auto` panel already reproduces correctly and is
left alone.

**And that transform is re-derived from a MEASUREMENT on every scroll, never extrapolated**
(`stickyOffset`). A sticky copy inside the clone never engages — it has no scrolling ancestor — so
it paints at `flow − scroll` and the correction is `live − (flow − scroll)`, where `live` is where
the browser is painting the real element right now. Taking the last sync's correction and adding
the scroll delta instead holds the copy still on screen, which is right while the element is STUCK
and wrong for the whole time it is not: an unstuck sticky flows with the page, so its copy has to
flow too, and it instead froze where the last sync left it until the next one landed. Measuring
costs one `getBoundingClientRect` per window-scrolled sticky per frame, shared across every lens by
one cache `applyScroll` passes down — otherwise each lens's write to its own clone invalidates
layout before the next one reads, and the cost becomes one forced layout per lens.

**Left click, wheel and hover go to the PAGE. Right click goes to the LENS.** That single sentence
is what makes the interaction learnable, and it is why a pinned lens is still reachable: right
click opens its menu in every pin state, which is where unpin and remove live.

**A pinned lens is revealed by the KEYBOARD and never by the pointer** (`lensInteractive`). Every
pointer path selects, so reveal-on-selection meant that reaching a pinned lens's menu — the one way
a mouse reaches unpin — handed its drag handle and control strip straight back, and the next drag
moved a lens the user had pinned precisely so it would stop moving. `Tab` and `Ctrl+Shift+M` still
cycle pinned lenses and still reveal them: keyboard is the only way they are reachable at all, and
a selection someone had to press a key to make is not one they make while aiming at something else.
So the reveal follows the SOURCE of the selection, never the selection.

**Interaction is forwarded by coordinate, not by making the clone live.** The point acted on inside
a lens is mapped back through the exact inverse of the rendering geometry (`lensPointToPage`) and
the event is dispatched at the real page point. The probe that finds the target must make the WHOLE
magnifier layer transparent to hit-testing first — with two lenses stacked, hiding only the top one
hands the click to the one beneath.

**Two lenses, two source rules** (`sourceRect`'s `anchor`):
- `'pan'` for a **placed** lens — the region pans proportionally to the lens's position in the
  viewport. Its position is a parking spot, and panning is what makes the page's outer band
  reachable at all: a centred region plus a lens clamped on screen leaves a dead band at every edge
  (~150px at 4×). At the viewport's centre it agrees exactly with the old centred rule, so nothing
  moves in normal use.
- `'cursor'` for the **follow** lens — centred on the pointer, and **not clamped**. Its position IS
  the pointer, and a pointer must show what is under it or aiming becomes impossible; with this, a
  plain pass-through click lands on the element the user is looking at. The clamp that used to slide
  the region back inside the viewport is gone: this lens is never kept on screen (no `clampLens`),
  so near an edge half its frame hangs off, and sliding the region while the frame stayed put pushed
  the page's outer band into the half nobody can see — the same dead band `'pan'` exists to remove,
  arriving by a different route. Unclamped, the edge is reached by putting the pointer on it. The
  cost is that part of the lens then shows the blank beyond the page, which is what is actually
  there.

**Cost is bounded per frame, not per lens count** (`mirrorSchedule.ts`, pure and tested): at most
two lenses re-clone per frame, least-recently-synced first, off-screen lenses never, and the
interval backs off when a measured cycle overruns its budget. Twenty lenses cost ten frames of
catching up rather than one frame of twenty clones.

## Where the settings live

`/api/accessibility` (GET/PUT, authenticated by the default rule, not in `AUTH_PUBLIC`) resolves to
one of two stores — `a11y-prefs.ts` is the only place that decides which:

| mode | store | key |
|---|---|---|
| machine (solo / member) | `~/.agentistics/preferences.json`, field `accessibility` | the machine |
| central | Mongo collection `userPrefs` | `_id` = the signed-in `accountId` |

`/api/preferences` could not be reused: it is **per machine**, and on a central that file belongs to
the container and is shared by every signed-in user. One person's magnifiers would appear on
everyone's screen. A central session that resolves without an account reads defaults and is refused
on write — it must never fall back to the machine file.

**A PUT replaces the whole `accessibility` value**, so deleting the last lens of a page actually
deletes it. That rests on `writePreferences` staying a shallow merge across preference KEYS (which
must not wipe language, theme, layouts or connections) — pinned by `a11y-persistence.test.ts`.

**Saving is armed only by a genuinely successful load.** On a central the route answers 401 until a
principal session exists, and the hook mounts before login; treating that 401 as an empty document
armed a save that then replaced the account's stored lenses with defaults. The load re-runs when
the signed-in identity changes.

## Known limitations

- **Canvas / WebGL content may not mirror.** The session terminal is the case that matters. Stated
  in the settings screen rather than left to be discovered.
- **A sticky's FLOW position is only as fresh as the last full sync.** Its correction is measured
  every frame, so both phases and the crossing between them are right immediately; what still waits
  on a re-clone is the element having MOVED or RESIZED in the layout.
- **No DOM test environment.** The pure modules are unit-tested; the mirror's effects and the
  forwarded interaction can only be verified in a browser.

## Where the code is

| file | responsibility |
|---|---|
| `packages/core/src/accessibility.ts` | shared types, defaults, `sanitizeAccessibilityPrefs` (pure, total, idempotent) |
| `packages/web/src/lib/magnifier.ts` | page key, geometry, clamping, keyboard reducer, `lensControls`, `lensPointToPage` (pure) |
| `packages/web/src/lib/mirrorSchedule.ts` | how much mirroring one frame may do (pure) |
| `packages/web/src/lib/magnifierMirror.ts` | the DOM mirror — the only DOM-touching module |
| `packages/web/src/components/a11y/` | the lens, the layer, the menus, the header buttons, EN/PT strings |
| `packages/web/src/hooks/useAccessibility.ts` | the state, loaded from and saved to `/api/accessibility` |
| `packages/web/src/pages/settings/AccessibilitySettings.tsx` | the settings tab |
| `packages/server/server/a11y-prefs.ts` | the one resolution of where settings live (pure) |
| `packages/server/server/a11y-routes.ts` / `user-prefs-store.ts` | the routes and the central's per-account store |
