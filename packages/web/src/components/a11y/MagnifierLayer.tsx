/**
 * MagnifierLayer.tsx — the portal that holds every lens.
 *
 * Its container is appended to document.body as a SIBLING of #root. That is load-bearing: the
 * mirror clones #root, so a layer inside it would clone itself, forever. Do not move it.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AppContext } from '../../lib/app-context'
import type { LensStyle } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { applyLensKey, clampLens, MAGNIFIER_LAYER_ID, stageTransform } from '../../lib/magnifier'
import { startMirrorScheduler, createMirrorHost, type MirrorScheduler } from '../../lib/magnifierMirror'
import { a11yText } from './i18n'
import { HideLensesButton } from './HideLensesButton'
import { Lens } from './Lens'
import { LensMenu } from './LensMenu'
import { MagnifierButton } from './MagnifierButton'

/** The layer's own DOM id — a sibling of `#root` (see the file header). Lives in `lib/magnifier.ts`
 *  as `MAGNIFIER_LAYER_ID` so `Lens.tsx`'s `elementBehindLens` can name this exact container
 *  without importing this file back and creating a cycle. */
const CONTAINER_ID = MAGNIFIER_LAYER_ID

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

export function MagnifierLayer({ ctx, hasHeaderSlot }: { ctx: AppContext; hasHeaderSlot: boolean }) {
  const { a11y, lang } = ctx
  const active = a11y.prefs.enabled
  const container = useLayerContainer(active)
  const isMobile = useIsMobile()
  const text = useMemo(() => a11yText(lang), [lang])
  const [scheduler, setScheduler] = useState<MirrorScheduler | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  // Which of `a11y.lenses` live in `globalLenses` rather than the current page's own bucket — the
  // one fact `Lens`/`LensMenu` need and cannot derive on their own, since a `MagnifierLens` itself
  // carries no `global` flag (see accessibility.ts's header for why that is deliberate).
  const globalIds = useMemo(() => new Set(a11y.prefs.globalLenses.map(l => l.id)), [a11y.prefs.globalLenses])

  useEffect(() => {
    if (!active) return
    const s = startMirrorScheduler()
    setScheduler(s)
    return () => { s.stop(); setScheduler(null) }
  }, [active])

  // `a11y` is a fresh object every render (its setters close over refs), so depending on it
  // directly below would tear the interval down and rebuild it on every unrelated re-render —
  // a selection change, a drag frame — instead of once a second. A ref to the latest setter keeps
  // the effect keyed on `[active, scheduler]` alone, which only ever changes when the feature
  // toggles or the scheduler itself is (re)created.
  const setMirrorIntervalMsRef = useRef(a11y.setMirrorIntervalMs)
  setMirrorIntervalMsRef.current = a11y.setMirrorIntervalMs

  // Publishes the scheduler's current interval so the settings tab's performance card can show
  // it. It changes only under load, so polling faster than once a second is wasted work; polling
  // at all (rather than reading it once) is what makes "why do my lenses feel slower" answerable
  // while it is actually happening. `null` — never a stale number — the moment there is no
  // scheduler to ask.
  useEffect(() => {
    if (!active || !scheduler) {
      setMirrorIntervalMsRef.current(null)
      return
    }
    setMirrorIntervalMsRef.current(scheduler.currentIntervalMs())
    const id = setInterval(() => setMirrorIntervalMsRef.current(scheduler.currentIntervalMs()), 1000)
    return () => {
      clearInterval(id)
      setMirrorIntervalMsRef.current(null)
    }
  }, [active, scheduler])

  // The mirror clones `#root` at stage-local (0,0); `stageTransform` treats stage-local as
  // viewport coordinates, which only holds while the clone is offset by the current scroll (see
  // magnifierMirror.ts). One window listener, coalesced with rAF so a scroll firing many times a
  // frame costs one style rewrite per host, not one per event. Resize is different: the clone's
  // shape genuinely changed (a reflow, not just a viewport offset), so it needs a full re-clone —
  // `markDirty()` schedules that at the next sync instead of trying to patch it here.
  useEffect(() => {
    if (!active || !scheduler) return
    let raf = 0
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        scheduler.applyScroll(window.scrollX, window.scrollY)
      })
    }
    const onResize = () => { scheduler.markDirty() }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onResize, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [active, scheduler])

  // One global keydown while the feature is on. Every guard here exists so the feature cannot take
  // the dashboard's own keyboard: a chord that is not ours falls through untouched.
  useEffect(() => {
    if (!active) return

    // The announcement must never say a lens's internal id ("lens-2") — a screen reader speaks it
    // verbatim, an English token dropped into a Portuguese sentence. `lensLabel` gives the same
    // 1-based ordinal `Lens.tsx`'s own aria-label already uses.
    const ordinal = (id: string) => a11y.lenses.findIndex(l => l.id === id) + 1

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

      // While every placed lens is hidden there is nothing on screen for the keyboard to act on:
      // selecting one would arm Tab/arrow-key edits against a frame nobody can see, and every
      // announcement below reads out a change with no visible effect to confirm it by. A
      // selection made BEFORE the toggle is left exactly as it was (never cleared) — it simply
      // goes inert until lenses are shown again, the same "paused, not lost" guarantee the rest
      // of this feature makes. Ctrl+Shift+Z is handled above this guard on purpose: the follow
      // lens is not one of the lenses being hidden.
      if (a11y.lensesHidden) return

      // Ctrl+Shift+M — enter keyboard control with no mouse. Without it, "full keyboard control"
      // would still need an opening click.
      if (e.ctrlKey && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
        if (editable(e.target) || a11y.lenses.length === 0) return
        const first = a11y.lenses[0]
        if (!first) return
        e.preventDefault()
        a11y.select(first.id, 'keyboard')
        a11y.announce(text.announce(text.lensLabel(ordinal(first.id)), first.zoom, first.width, first.height, first.x, first.y, first.pinned))
        return
      }

      if (!a11y.selectedId || editable(e.target)) return

      // Tab is intercepted ONLY while a lens is selected; Esc gives it back. A permanently
      // hijacked Tab would make the dashboard unusable by keyboard, which is the opposite of what
      // this feature is for. Pinned lenses ARE included: keyboard is how they are reached.
      if (e.key === 'Tab') {
        const idx = a11y.lenses.findIndex(l => l.id === a11y.selectedId)
        if (idx < 0) return
        const n = a11y.lenses.length
        const next = a11y.lenses[(idx + (e.shiftKey ? -1 : 1) + n) % n]
        if (!next) return
        e.preventDefault()
        a11y.select(next.id, 'keyboard')
        a11y.announce(text.announce(text.lensLabel(ordinal(next.id)), next.zoom, next.width, next.height, next.x, next.y, next.pinned))
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
        a11y.announce(text.lensReleased)
        return
      }
      const next = clampLens(result, { width: window.innerWidth, height: window.innerHeight })
      a11y.updateLens(lens.id, next)
      a11y.announce(text.announce(text.lensLabel(ordinal(next.id)), next.zoom, next.width, next.height, next.x, next.y, next.pinned))
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, a11y, text])

  if (!active || !container || !scheduler) return null

  return createPortal(
    <>
      {/*
        Driven by the keydown effect above: every keyboard edit, pin, removal and selection change
        announces here, so a screen-reader user gets the same feedback a sighted one reads off the
        lens frame.
      */}
      <div
        role="status"
        aria-live="polite"
        style={{ position: 'fixed', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}
      >
        {a11y.announcement}
      </div>
      {/*
        No header slot exists to host the button (mobile inside the Sessions workspace — see
        App.tsx's `headerHostsMagnifier`). Without this, a pinned lens (pointerEvents: 'none' on
        the whole frame) is unreachable and the user is stuck, not merely inconvenienced. Anchored
        mid-right, vertically centered — clear of the workspace's own top bar (back button / tabs /
        session actions, or the filters row), its bottom nav / chat composer, and any bottom
        sheet. It floats over scrollable content rather than a control, which is the one place
        nothing else on either screen ever puts a fixed element. Not anchored near the top, so
        `--safe-top` does not apply here.
        `pointerEvents: 'auto'` is required: the portal container above is 'none'.
        The z-index MUST outrank a lens frame's `2147483000` (Lens.tsx): `newLens()` centres a new
        lens on the viewport and DEFAULT_LENS_STYLE is 360x240, so on any phone under ~472px wide
        that span overlaps this button's — and always overlaps it vertically, since both sit on
        the vertical centre. Lenses render AFTER this button in the JSX, so without a higher
        z-index the lens paints on top and swallows the tap, burying the one way back to a pinned
        lens (which itself takes no pointer events) behind the very thing that created it, on
        every later visit to the page. `2147483200` is the same tier the menus already use, so the
        ordering reads as one deliberate scale: page < lenses < the controls that manage them.
      */}
      {!hasHeaderSlot && (
        <div style={{
          position: 'fixed', right: 12, top: '50%', transform: 'translateY(-50%)',
          pointerEvents: 'auto', zIndex: 2147483200,
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <MagnifierButton ctx={ctx} />
          <HideLensesButton ctx={ctx} />
        </div>
      )}
      {/*
        Hides, never deletes: skipping the map leaves `a11y.lenses` — and every x/y/zoom/pinned
        value inside it — untouched. This also stops each hidden lens's mirror from doing any
        work: `Lens.tsx`'s effect registers with the scheduler on mount and unregisters (plus
        `host.destroy()`) on unmount, so simply not rendering it here IS the unregister — no
        separate "pause" path was needed.

        The cursor-following lens below is deliberately NOT gated by `lensesHidden` — see
        `HideLensesButton.tsx`'s header comment for why.
      */}
      {!a11y.lensesHidden && a11y.lenses.map((lens, i) => (
        <Lens
          key={lens.id}
          lens={lens}
          index={i + 1}
          selected={a11y.selectedId === lens.id}
          selectedVia={a11y.selectedVia}
          global={globalIds.has(lens.id)}
          text={text}
          isMobile={isMobile}
          scheduler={scheduler}
          onChange={patch => a11y.updateLens(lens.id, patch)}
          onSelect={() => a11y.select(lens.id)}
          onRemove={() => a11y.removeLens(lens.id)}
          onContextMenu={e => {
            e.preventDefault()
            a11y.select(lens.id)
            setMenu({ id: lens.id, x: e.clientX, y: e.clientY })
          }}
          // The visible `config` control opens the exact same menu the right-click does, at the
          // button's own position rather than wherever the pointer happens to be — a menu opening
          // somewhere other than the control that was pressed reads as a different action.
          onOpenMenu={e => {
            e.stopPropagation()
            a11y.select(lens.id)
            setMenu({ id: lens.id, x: e.clientX, y: e.clientY })
          }}
        />
      ))}
      {a11y.followOn && <FollowLens style={a11y.prefs.followLens} scheduler={scheduler} />}
      {/* No lens frame is on screen while hidden, so the menu that configures one (opened before
          the toggle was pressed) is withheld too rather than floating over nothing it points at. */}
      {!a11y.lensesHidden && menu && (() => {
        const lens = a11y.lenses.find(l => l.id === menu.id)
        if (!lens) return null
        return (
          <LensMenu
            lens={lens} x={menu.x} y={menu.y} text={text} isMobile={isMobile}
            global={globalIds.has(lens.id)}
            onChange={patch => a11y.updateLens(lens.id, patch)}
            onSetGlobal={g => a11y.setLensGlobal(lens.id, g)}
            onRemove={() => a11y.removeLens(lens.id)}
            onDuplicate={() => a11y.duplicateLens(lens.id)}
            onClose={() => setMenu(null)}
          />
        )
      })()}
    </>,
    container,
  )
}

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
  // The scheduler asks "is this on screen?" every frame via the callback registered below, but
  // that registration effect runs once (deps [scheduler]) — a closure over `pos` there would
  // freeze on the initial `null` and report "off screen" forever, even once the cursor moves onto
  // the page. Mirror `Lens.tsx`'s `lensRef` pattern: keep the live value in a ref, assigned on
  // every render, and have the callback read the ref instead of closing over `pos` directly.
  const posRef = useRef(pos)
  posRef.current = pos

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
    // Off screen (no pointer on the page yet, or the pointer just left the window) means this
    // mirror must not compete for a sync slot — see mirrorSchedule.ts's off-screen filter.
    scheduler.register('__follow__', host, () => posRef.current !== null)
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
  // 'cursor': this lens's position IS the pointer (it is always centred on it, never parked), so
  // the region must be centred on the lens rather than panned — see `SourceAnchor` in
  // magnifier.ts. Panning here is exactly the regression this anchor exists to prevent: it would
  // show, at the lens's centre, content that is not under the cursor, and since this lens is
  // `pointerEvents: 'none'` a click passes through to whatever the cursor is physically over.
  const t = stageTransform(placed, { width: window.innerWidth, height: window.innerHeight }, 'cursor')

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
