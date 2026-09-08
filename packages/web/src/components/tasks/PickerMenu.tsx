/**
 * PickerMenu — the board's multi-select, in the shape the rest of the app draws one.
 *
 * Three lists needed the same control and had three implementations: which column groups the table
 * shows, which columns each row shows, and which groups the KANBAN shows (that one did not exist at
 * all, which is why the board was seven columns wide and cut off with no way to narrow it).
 *
 * It follows the settings screens' popover contract — `position: fixed` in a portal, measured from
 * the trigger, clamped to the viewport, closing on scroll — because a menu that opens inside a
 * scrolling table gets clipped by it, and one anchored `right: 0` opens leftward across the nav.
 *
 * It also REORDERS: the columns of a table are a sequence, not a set, and the only honest way to
 * say "cost before tokens" is to drag one above the other. Dragging is offered on the ticked rows
 * only — an unticked row has no position to hold.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, GripVertical } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { microLabel, surface } from './board'

export interface PickerItem {
  value: string
  label: string
  /** A count or a hint, right-aligned. A HIDDEN group still says how much is in it. */
  hint?: string
  color?: string
}

export interface PickerMenuProps {
  /** The trigger's contents. */
  children: React.ReactNode
  title: string
  /** Everything offerable, in the order it should be listed when nothing is ordered. */
  items: readonly PickerItem[]
  /** What is ticked, IN ORDER when the list is orderable. */
  value: readonly string[]
  onChange: (next: string[]) => void
  /** Drag the ticked rows to reorder. Off for a set (which groups show), on for a sequence. */
  orderable?: boolean
  /** One sentence under the list, saying what the choice means. */
  note?: string
  width?: number
  triggerStyle?: React.CSSProperties
}

export function PickerMenu(p: PickerMenuProps) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const [drag, setDrag] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const width = p.width ?? 250

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

  // Ticked first and IN THEIR ORDER, then the rest. The list then reads as what the table looks
  // like, which is the only way a drag-to-reorder makes sense at a glance.
  const ordered = p.orderable
    ? [
      ...p.value
        .map(v => p.items.find(i => i.value === v))
        .filter((i): i is PickerItem => i !== undefined),
      ...p.items.filter(i => !p.value.includes(i.value)),
    ]
    : p.items

  const toggle = (v: string) => {
    p.onChange(p.value.includes(v) ? p.value.filter(x => x !== v) : [...p.value, v])
  }

  const move = (from: string, to: string) => {
    if (from === to) return
    const next = p.value.filter(v => v !== from)
    const at_ = next.indexOf(to)
    // Dropped on an UNTICKED row: the drag was over nothing, so the order is left alone rather than
    // appending the card somewhere nobody pointed at.
    if (at_ === -1) return
    next.splice(at_, 0, from)
    p.onChange(next)
  }

  return (
    <>
      <button
        ref={trigger}
        style={p.triggerStyle}
        onClick={() => {
          if (open) { setOpen(false); return }
          const r = trigger.current?.getBoundingClientRect()
          if (!r) return
          setAt({
            left: Math.min(Math.max(8, r.left), window.innerWidth - width - 8),
            top: r.bottom + 6,
          })
          setOpen(true)
        }}
      >{p.children}</button>
      {open && at && createPortal(
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 1199 }} />
          <div style={{
            position: 'fixed', left: at.left, top: at.top, width, zIndex: 1200,
            ...surface, background: 'var(--bg-elevated)', padding: 8, display: 'grid', gap: 2,
            boxShadow: 'var(--shadow-elevated)', maxHeight: 380, overflowY: 'auto',
          }}>
            <div style={{ ...microLabel, marginBottom: 3 }}>{p.title}</div>
            {ordered.map(item => {
              const on = p.value.includes(item.value)
              return (
                <div
                  key={item.value}
                  draggable={p.orderable === true && on}
                  onDragStart={() => setDrag(item.value)}
                  onDragEnd={() => setDrag(null)}
                  onDragOver={e => { if (drag && on) e.preventDefault() }}
                  onDrop={e => {
                    e.preventDefault()
                    if (drag) move(drag, item.value)
                    setDrag(null)
                  }}
                  onClick={() => toggle(item.value)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                    padding: '6px 8px', borderRadius: 6, fontSize: 12,
                    minHeight: isMobile ? 44 : 28,
                    background: on ? 'var(--bg-card-hover)' : 'transparent',
                    color: on ? 'var(--text-primary)' : 'var(--text-tertiary)',
                    opacity: drag === item.value ? 0.45 : 1,
                  }}
                >
                  {p.orderable && (
                    <GripVertical
                      size={12}
                      style={{
                        flexShrink: 0,
                        // Only a ticked row can be dragged, and only a ticked row shows the grip —
                        // a handle that does nothing is worse than none.
                        color: on ? 'var(--text-tertiary)' : 'transparent',
                        cursor: on ? 'grab' : 'default',
                      }}
                    />
                  )}
                  <span style={{
                    width: 14, height: 14, borderRadius: 4, flexShrink: 0,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    border: `1px solid ${on ? 'var(--anthropic-orange)' : 'var(--border)'}`,
                    background: on ? 'var(--anthropic-orange)' : 'transparent',
                    color: '#fff',
                  }}>{on && <Check size={10} />}</span>
                  <span style={{
                    flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap', color: item.color ?? undefined,
                  }}>{item.label}</span>
                  {item.hint !== undefined && (
                    <span style={{ ...microLabel, fontSize: 10.5, flexShrink: 0 }}>{item.hint}</span>
                  )}
                </div>
              )
            })}
            {p.note && (
              <div style={{
                ...microLabel, textTransform: 'none', letterSpacing: 0, padding: '4px 8px',
                lineHeight: 1.5,
              }}>{p.note}</div>
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  )
}
