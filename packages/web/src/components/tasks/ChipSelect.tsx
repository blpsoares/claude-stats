/**
 * ChipSelect — a value that is a COLOURED WORD, chosen from a short closed list.
 *
 * Status and priority are set from six places (the rail, a table cell, a card, the batch bar, the
 * create wizard, the blocked dialog) and every one of them used to draw its own control: a grid of
 * chips here, a row of buttons there, a bespoke dropdown in the table. Three shapes for one act, and
 * the grids cost four rows of vertical space to say a single word.
 *
 * It is one component now, and it is a SELECT everywhere — you read the current value in one row and
 * change it in one click, which is the same number of clicks a grid costs once you have found the
 * right chip in it.
 *
 * The panel is FIXED and lives in a portal. A dropdown inside a table opens into the table's own
 * scroll box and is cut off by it — which is exactly what the status cell did, showing two of seven
 * options with the rest clipped below the row. `position: fixed` means no ancestor's overflow can
 * clip it; the position is measured from the trigger and clamped to the viewport, and it flips
 * ABOVE the trigger when the room below is not enough, because a panel that opens off the bottom of
 * the screen is a panel nobody can use.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { surface } from './board'

export interface ChipOption {
  value: string
  label: string
  color: string
  dim: string
}

export interface ChipSelectProps {
  value: string
  options: readonly ChipOption[]
  onPick: (v: string) => void
  disabled?: boolean
  /** Tight cells (a table row) get less padding; a rail or a form gets the roomier one. */
  compact?: boolean
  /** Fill the column it sits in. Off for the batch bar, where it sits among other buttons. */
  block?: boolean
  title?: string
}

/** Room a seven-option panel needs. Measured, not guessed: 7 rows + padding at the mobile height. */
const PANEL_MAX = 340

export function ChipSelect({
  value, options, onPick, disabled, compact, block = true, title,
}: ChipSelectProps) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<{ left: number; top?: number; bottom?: number; width: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const current = options.find(o => o.value === value) ?? options[options.length - 1]

  // A panel anchored to a trigger in normal flow must not chase it: close instead. Same rule the
  // settings popovers follow — a panel that has drifted away from its control is worse than one
  // that shut.
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  if (!current) return null

  const toggle = () => {
    if (disabled) return
    if (open) { setOpen(false); return }
    const r = trigger.current?.getBoundingClientRect()
    if (!r) return
    const height = Math.min(PANEL_MAX, options.length * (isMobile ? 48 : 30) + 16)
    const below = window.innerHeight - r.bottom
    const width = Math.max(r.width, 150)
    setAt({
      left: Math.min(Math.max(8, r.left), window.innerWidth - width - 8),
      width,
      // Flip up when there is not room below and there IS above — the case a table's last row hits.
      ...(below < height && r.top > below
        ? { bottom: window.innerHeight - r.top + 4 }
        : { top: r.bottom + 4 }),
    })
    setOpen(true)
  }

  return (
    <>
      <button className="ag-tap"
        ref={trigger}
        onClick={e => { e.stopPropagation(); toggle() }}
        disabled={disabled}
        title={title}
        style={{
          width: block ? '100%' : undefined, boxSizing: 'border-box',
          cursor: disabled ? 'default' : 'pointer',
          display: 'flex', alignItems: 'center', gap: 6,
          justifyContent: block ? 'space-between' : 'center',
          padding: compact ? '3px 8px' : isMobile ? '10px 11px' : '6px 10px',
          borderRadius: compact ? 5 : 7,
          border: `1px solid ${current.color}`, background: current.dim, color: current.color,
          fontSize: compact ? 11 : 12, fontWeight: 600, whiteSpace: 'nowrap',
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{current.label}</span>
        {!disabled && <ChevronDown size={compact ? 10 : 12} style={{ flexShrink: 0, opacity: 0.75 }} />}
      </button>
      {open && at && createPortal(
        <>
          <div
            onClick={e => { e.stopPropagation(); setOpen(false) }}
            style={{ position: 'fixed', inset: 0, zIndex: 1199 }}
          />
          <div style={{
            position: 'fixed', left: at.left, width: at.width, zIndex: 1200,
            ...(at.bottom !== undefined ? { bottom: at.bottom } : { top: at.top }),
            ...surface, background: 'var(--bg-elevated)', padding: 4, display: 'grid', gap: 2,
            boxShadow: 'var(--shadow-elevated)', maxHeight: PANEL_MAX, overflowY: 'auto',
          }}>
            {options.map(o => (
              <button
                // A MENU ROW pays its 44px in PAINT. `.ag-tap` is for controls whose smallness is
                // their meaning; these sit in a `gap: 2` list, where a projected box covers the row
                // above and its bottom band selects the row below.
                key={o.value}
                onClick={e => {
                  e.stopPropagation()
                  setOpen(false)
                  if (o.value !== value) onPick(o.value)
                }}
                style={{
                  border: `1px solid ${o.value === value ? o.color : 'transparent'}`,
                  cursor: 'pointer', textAlign: 'left', padding: '6px 9px', borderRadius: 5,
                  minHeight: isMobile ? 44 : undefined,
                  background: o.value === value ? o.dim : 'transparent',
                  color: o.color, fontSize: 11.5, fontWeight: 600,
                }}
              >{o.label}</button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  )
}

/** The status options, in board order — so every select offers them in the same sequence. */
export function statusOptions(
  STATUS: Record<string, { label: string; color: string; dim: string }>,
  order: readonly string[],
): ChipOption[] {
  return order.map(id => ({
    value: id, label: STATUS[id]!.label, color: STATUS[id]!.color, dim: STATUS[id]!.dim,
  }))
}
