/**
 * LensMenu.tsx — one lens's own menu. A popover at the pointer on desktop, a bottom sheet on
 * mobile: a popover positioned at a thumb is a popover under the thumb.
 */
import React from 'react'
import type { MagnifierLens } from '@agentistics/core'
import { ZOOM_MAX, ZOOM_MIN, LENS_MIN_PX, BORDER_MIN_PX, BORDER_MAX_PX } from '@agentistics/core'
import { SIZE_SLIDER_MAX_PX, ZOOM_SLIDER_STEP, fmtZoom } from '../../lib/magnifier'
import type { A11yText } from './i18n'

interface Props {
  lens: MagnifierLens
  x: number
  y: number
  text: A11yText
  isMobile: boolean
  /** True while `lens` lives in `globalLenses` rather than the current page's own bucket. */
  global: boolean
  onChange(patch: Partial<MagnifierLens>): void
  onSetGlobal(global: boolean): void
  onRemove(): void
  onDuplicate(): void
  onClose(): void
}

export function LensMenu({ lens, x, y, text, isMobile, global, onChange, onSetGlobal, onRemove, onDuplicate, onClose }: Props) {
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
  // 250px was tuned to the English labels. "Espessura da borda" (border thickness) is the widest
  // PT row label — at that width the flex slider had nowhere left to shrink to (see `slider`
  // below) and its readout was pushed past the panel's right edge. 280px is enough headroom for
  // the longer language rather than the shorter one.
  const SHELL_WIDTH = 280
  const shell: React.CSSProperties = isMobile
    ? { position: 'fixed', left: 0, right: 0, bottom: 0, borderRadius: '14px 14px 0 0' }
    : {
        position: 'fixed',
        left: Math.max(8, Math.min(x, window.innerWidth - (SHELL_WIDTH + 18))),
        top: Math.max(8, Math.min(y, window.innerHeight - 360)),
        width: SHELL_WIDTH, borderRadius: 12,
        // The shell's own width must include its padding, or the padding adds on top of the
        // declared width and the panel is wider than it claims to be.
        boxSizing: 'border-box',
      }

  // Mobile only — the ≥44px touch-target rule. Desktop sizing is untouched: the track itself
  // stays thin, but the element's own box (what a touch actually hits) grows to fit.
  // `minWidth: 0` is the actual overflow fix: a flex item's default `min-width` is `auto`, which
  // floors it at its intrinsic content size — a `<input type=range>` refuses to shrink below
  // that floor — so with a long label eating most of the row's width the slider pushed the
  // `readout` span past the panel's right edge instead of yielding any of its own space.
  const slider: React.CSSProperties = { flex: 1, minWidth: 0, height: isMobile ? 44 : undefined }
  // The readout (`2.7×`) is the other flex child in the same row — same fix, so a long label
  // can never push IT past the edge either, only shrink the slider first (it has no `flex`, so
  // it already yields last).
  const readout: React.CSSProperties = { minWidth: 36, textAlign: 'right', flexShrink: 0 }

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
      <div role="dialog" aria-label={text.headerTitle} style={{
        ...shell, zIndex: 2147483200, padding: 10, pointerEvents: 'auto',
        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
      }}>
        <div style={row}>
          <span>{text.zoom}</span>
          <input type="range" min={ZOOM_MIN} max={ZOOM_MAX} step={ZOOM_SLIDER_STEP} value={lens.zoom}
            onChange={e => onChange({ zoom: Number(e.target.value) })} style={slider} />
          <strong style={readout}>{fmtZoom(lens.zoom)}×</strong>
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
          <input type="range" min={LENS_MIN_PX} max={SIZE_SLIDER_MAX_PX} step={10} value={lens.width}
            onChange={e => onChange({ width: Number(e.target.value) })} style={slider} />
        </div>
        {lens.shape === 'rect' && (
          <div style={row}>
            <span>{text.height}</span>
            <input type="range" min={LENS_MIN_PX} max={SIZE_SLIDER_MAX_PX} step={10} value={lens.height}
              onChange={e => onChange({ height: Number(e.target.value) })} style={slider} />
          </div>
        )}
        <div style={row}>
          <span>{text.borderWidth}</span>
          <input type="range" min={BORDER_MIN_PX} max={BORDER_MAX_PX} step={1} value={lens.borderWidth}
            onChange={e => onChange({ borderWidth: Number(e.target.value) })} style={slider} />
        </div>
        <div style={{ height: 1, background: 'var(--border)', margin: '6px 0' }} />
        <button style={action} onClick={() => { onSetGlobal(!global); onClose() }}>
          {global ? text.keepOnThisPageOnly : text.keepOnEveryPage}
        </button>
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
