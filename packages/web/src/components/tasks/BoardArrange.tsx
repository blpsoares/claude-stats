/**
 * BoardArrange — the kanban's own controls: what the cards are ordered BY, what the rows are, and
 * how many cards a column should hold.
 *
 * They sit above the board rather than inside a settings dialog because all three change what is on
 * screen right now, and a control whose effect you cannot see while you press it is one people
 * press twice.
 *
 * The SORT is the table's sort — one field, written by both. A board that ranks its cards one way
 * in the grid and another in the columns is two boards.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDownUp, Columns3, LayoutList, Rows3, X } from 'lucide-react'
import { PRIORITY_ORDER, type SortKey, type SortSpec } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import {
  COLUMN_ORDER, STATUS, button, field, microLabel, pill, surface, type BoardStatus,
} from './board'
import { PickerMenu } from './PickerMenu'
import { LANE_KEYS, type LaneKey } from './boardPrefs'

/**
 * The orders a KANBAN offers, which are deliberately fewer than the table's.
 *
 * A column of cards is read top to bottom; a key nobody can see on the card (attempts, comments)
 * would order it by something invisible, and the reader would conclude the board was shuffled.
 */
const BOARD_SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'manual', label: 'Hand order' },
  { key: 'priority', label: 'Priority' },
  { key: 'due', label: 'Due date' },
  { key: 'updated', label: 'Last touched' },
  { key: 'created', label: 'Newest' },
  { key: 'cost', label: 'Cost' },
  { key: 'rounds', label: 'Rounds' },
  { key: 'title', label: 'Title' },
]

const LANE_LABEL: Record<LaneKey, string> = {
  none: 'No swimlanes',
  repo: 'Repository',
  assignee: 'Owner',
  harness: 'Harness',
  priority: 'Priority',
}

export interface BoardArrangeProps {
  sort: SortSpec
  onSort: (s: SortSpec) => void
  lanes: LaneKey
  onLanes: (l: LaneKey) => void
  wip: Record<string, number>
  onWip: (w: Record<string, number>) => void
  /** Which columns the board draws, in order. The same stored set the table's groups use. */
  columns: readonly BoardStatus[]
  onColumns: (next: BoardStatus[]) => void
  /** How many cards sit in each status, so a HIDDEN column still says what it holds. */
  counts: Record<string, number>
}

export function BoardArrange(p: BoardArrangeProps) {
  const isMobile = useIsMobile()
  const [menu, setMenu] = useState<'sort' | 'lanes' | 'wip' | null>(null)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const bar = useRef<HTMLDivElement>(null)

  /**
   * The panels are FIXED and live in a portal, and they open to the RIGHT of their button.
   *
   * Both halves were wrong before. `position: absolute` put them in the page's own stacking
   * context, so the sidebar — which is fixed and higher — drew straight over them; and `right: 0`
   * hung them off the button's right edge, so they opened LEFTWARD, across the nav and off the
   * screen. `fixed` + a portal means no ancestor's overflow or z-index can clip them, and
   * left-aligning to the trigger opens them into the board, which is where the space is.
   *
   * They close on scroll rather than chasing the button: a panel that drifts away from the control
   * it belongs to is worse than one that closed. Same rule the settings popovers follow.
   */
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  const openAt = (which: 'sort' | 'lanes' | 'wip') => (e: React.MouseEvent<HTMLButtonElement>) => {
    if (menu === which) { setMenu(null); return }
    const r = e.currentTarget.getBoundingClientRect()
    const width = which === 'wip' ? 260 : 230
    setAt({
      // Clamped to the viewport, so a button near the right edge does not open a panel half off it.
      left: Math.min(r.left, window.innerWidth - width - 12),
      top: r.bottom + 6,
    })
    setMenu(which)
  }

  const panel = (which: 'sort' | 'lanes' | 'wip', width: number, body: React.ReactNode) =>
    menu === which && at
      ? createPortal(
        <>
          <div onClick={() => setMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 1199 }} />
          <div style={{
            position: 'fixed', left: at.left, top: at.top, width, zIndex: 1200,
            ...surface, background: 'var(--bg-elevated)', padding: 8, display: 'grid', gap: 3,
            boxShadow: 'var(--shadow-elevated)', maxHeight: 340, overflowY: 'auto',
          }}>{body}</div>
        </>,
        document.body,
      )
      : null
  const row = (on: boolean): React.CSSProperties => ({
    display: 'flex', gap: 8, alignItems: 'center', textAlign: 'left', width: '100%',
    padding: '6px 8px', borderRadius: 5, cursor: 'pointer', fontSize: 12,
    border: `1px solid ${on ? 'var(--anthropic-orange)' : 'transparent'}`,
    background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
    color: on ? 'var(--text-primary)' : 'var(--text-secondary)',
    minHeight: isMobile ? 44 : 28,
  })
  const trigger = { ...button(isMobile), height: isMobile ? 44 : 28 }
  const limited = Object.keys(p.wip).length

  return (
    <div ref={bar} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      {/*
       * WHICH COLUMNS, and in what order.
       *
       * Seven fixed columns are wider than any screen, so the board scrolled sideways and the last
       * two were simply off the edge with nothing offering to hide them — the arrangement existed
       * for the table and not for the board it was more needed on. Reorderable too: a pipeline that
       * runs backlog → done is a sequence, and a team that reviews before it blocks should be able
       * to say so.
       */}
      <PickerMenu
        title="Columns on the board"
        triggerStyle={trigger}
        items={COLUMN_ORDER.map(st => ({
          value: st,
          label: STATUS[st].label,
          color: STATUS[st].color,
          hint: String(p.counts[st] ?? 0),
        }))}
        value={p.columns}
        onChange={next => p.onColumns(next as BoardStatus[])}
        orderable
        note="Drag a ticked column, or use ▲▼, to reorder the pipeline. A hidden column's tasks are still there."
      >
        <Columns3 size={13} /> Columns · {p.columns.length}
      </PickerMenu>

      <div>
        <button style={trigger} onClick={openAt('sort')}>
          <ArrowDownUp size={13} />
          {BOARD_SORTS.find(s => s.key === p.sort.key)?.label ?? 'Order'}
          {p.sort.key !== 'manual' && <span>{p.sort.dir === 'asc' ? '↑' : '↓'}</span>}
        </button>
        {panel('sort', 230, (
          <>
              <div style={{ ...microLabel, marginBottom: 3 }}>Order cards by</div>
              {BOARD_SORTS.map(s => (
                <button
                  key={s.key}
                  onClick={() => {
                    // Pressing the ACTIVE key flips the direction — the second half of the same
                    // gesture, so nobody has to find a separate up/down control.
                    p.onSort(p.sort.key === s.key
                      ? { key: s.key, dir: p.sort.dir === 'asc' ? 'desc' : 'asc' }
                      : { key: s.key, dir: 'asc' })
                  }}
                  style={row(p.sort.key === s.key)}
                >
                  <span style={{ flex: 1 }}>{s.label}</span>
                  {p.sort.key === s.key && <span>{p.sort.dir === 'asc' ? '↑' : '↓'}</span>}
                </button>
              ))}
              <div style={{
                ...microLabel, textTransform: 'none', letterSpacing: 0, padding: '4px 8px',
                lineHeight: 1.5,
              }}>
                A card nothing could price sorts last whichever way the arrow points.
              </div>
          </>
        ))}
      </div>

      <div>
        <button style={trigger} onClick={openAt('lanes')}>
          <Rows3 size={13} /> {LANE_LABEL[p.lanes]}
        </button>
        {panel('lanes', 230, (
          <>
              <div style={{ ...microLabel, marginBottom: 3 }}>Swimlanes</div>
              {LANE_KEYS.map(k => (
                <button key={k} onClick={() => { setMenu(null); p.onLanes(k) }} style={row(p.lanes === k)}>
                  {LANE_LABEL[k]}
                </button>
              ))}
              <div style={{
                ...microLabel, textTransform: 'none', letterSpacing: 0, padding: '4px 8px',
                lineHeight: 1.5,
              }}>
                A lane per value, each holding the whole pipeline — which repository, which agent,
                which harness is doing what.
              </div>
          </>
        ))}
      </div>

      <div>
        <button style={trigger} onClick={openAt('wip')}>
          <LayoutList size={13} /> WIP{limited > 0 ? ` · ${limited}` : ''}
        </button>
        {panel('wip', 260, (
          <>
              <div style={{ ...microLabel, marginBottom: 3 }}>Cards per column</div>
              {COLUMN_ORDER.map(st => {
                const c = STATUS[st]
                const v = p.wip[st]
                return (
                  <label key={st} style={{ ...row(v !== undefined), cursor: 'default' }}>
                    <span style={{ flex: 1, color: c.color }}>{c.label}</span>
                    <input
                      type="number" min={1} inputMode="numeric"
                      value={v ?? ''}
                      placeholder="—"
                      onChange={e => {
                        const n = Number(e.target.value)
                        const next = { ...p.wip }
                        // An empty box means NO limit, which is not the same as a limit of zero:
                        // zero would put every column over its limit the moment anything landed.
                        if (!Number.isFinite(n) || n <= 0) delete next[st]
                        else next[st] = Math.floor(n)
                        p.onWip(next)
                      }}
                      style={{ ...field(isMobile), width: 72, padding: '4px 8px' }}
                    />
                  </label>
                )
              })}
              <div style={{
                ...microLabel, textTransform: 'none', letterSpacing: 0, padding: '4px 8px',
                lineHeight: 1.5,
              }}>
                A limit WARNS, it never blocks a drop. It is an agreement you make with yourself —
                a board that refuses work teaches people to route around it.
              </div>
          </>
        ))}
      </div>

      {p.lanes === 'priority' && (
        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center' }}>
          {PRIORITY_ORDER.map(id => <span key={id} style={pill()}>{id}</span>)}
        </span>
      )}

      <span style={{ flex: 1 }} />
      {(p.sort.key !== 'manual' || p.lanes !== 'none' || limited > 0
        || p.columns.length !== COLUMN_ORDER.length) && (
        <button
          onClick={() => {
            p.onSort({ key: 'manual', dir: 'asc' })
            p.onLanes('none')
            p.onWip({})
            p.onColumns([...COLUMN_ORDER])
          }}
          style={{ ...trigger, color: 'var(--text-tertiary)' }}
          title="Back to the plain board"
        ><X size={12} /> Reset</button>
      )}
    </div>
  )
}
