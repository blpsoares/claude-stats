/**
 * SessionsRail — the sessions workspace, in a 64px column.
 *
 * The aside used to withhold this body when collapsed, and `App.tsx` recorded why: "a 64px rail
 * cannot show a session's title, and a list of unlabelled dots is a list nobody can read." So it
 * fell through to the DASHBOARD's nav — Home, Costs, Tools — which is the one thing the sessions
 * workspace certainly is not.
 *
 * The objection is answered rather than overruled: the glyph never carries the fact alone. The
 * mark says which assistant, the dot says whether it is RUNNING or wants somebody, and the
 * TOOLTIP carries
 * exactly what the open row carries, by rendering the same `SessionFacts`.
 *
 * Hover-only is acceptable HERE AND ONLY HERE: `SideNav` is not rendered below the mobile
 * breakpoint, so there is no touch reader being asked to hover. It opens on keyboard focus too.
 */

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { HarnessMark } from '../sessions/HarnessMark'
import { SessionFacts } from '../sessions/SessionFacts'
import { sessionPath } from '../../lib/sessionRoute'

/**
 * The dot a state earns, or null for one that earns none.
 *
 * Only the ACTIVE states are marked. A dot on every row is a rail with no contrast left, and the
 * point of the marker is that the handful of sessions doing something stand out from the history
 * under them — the same reasoning `STATE_WASH` records for the open list.
 */
function stateDot(state: string): string | null {
  if (state === 'waiting' || state === 'waiting-approval') return 'var(--anthropic-orange)'
  if (state === 'working') return '#22c55e'
  return null
}

/** How many marks the rail draws before it says how many more there are. */
const RAIL_MAX = 12

export function SessionsRail({ rows, selectedId }: {
  rows: readonly ControlSession[]
  selectedId?: string
}) {
  const navigate = useNavigate()
  const [tip, setTip] = useState<{ top: number; left: number; session: ControlSession } | null>(null)
  const shown = rows.slice(0, RAIL_MAX)
  const more = rows.length - shown.length

  return (
    <nav className="ag-noscroll" style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
      overflowY: 'auto', overflowX: 'hidden', flex: 1, paddingTop: 4,
    }}>
      {shown.map(s => (
        <button
          key={s.id}
          onClick={() => navigate(sessionPath(s.id))}
          aria-label={s.title}
          onMouseEnter={e => {
            const r = e.currentTarget.getBoundingClientRect()
            setTip({ top: r.top, left: r.right + 10, session: s })
          }}
          onFocus={e => {
            const r = e.currentTarget.getBoundingClientRect()
            setTip({ top: r.top, left: r.right + 10, session: s })
          }}
          onMouseLeave={() => setTip(null)}
          onBlur={() => setTip(null)}
          style={{
            position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 40, height: 40, borderRadius: 10, border: 'none', cursor: 'pointer',
            background: s.id === selectedId ? 'var(--bg-elevated)' : 'transparent',
            boxShadow: s.id === selectedId ? 'inset 0 0 0 1px var(--border)' : undefined,
          }}
        >
          <HarnessMark harness={s.harness} size={22} />
          {/* THREE STATES, TWO COLOURS, AND ABSENCE IS THE THIRD.
              The dot used to appear only for a row that WANTS somebody, which left a session that
              is WORKING looking exactly like one that finished hours ago — reported after turning
              "active only" off, where the twelve marks on the rail carry three needing a person
              and nine that could be anything. Running is the fact the rail exists to show.

              Orange for needs-you, green for working, nothing for a row that is neither. The
              green is `COLORS.running`'s own token rather than `--accent-green`, for the reason
              the cockpit records: the success green reads as teal and sits within a hair of the
              codex harness colour, which is the one thing a mark-and-dot pair must not do.

              It never carries the message alone — that is why the tooltip exists and why it
              renders the row's whole card. In a 64px rail there is no room for the word, so the
              rule becomes: the dot is the HINT, the tooltip is the FACT. */}
          {stateDot(s.state) && (
            <span aria-hidden style={{
              position: 'absolute', top: 4, right: 4, width: 7, height: 7, borderRadius: 4,
              background: stateDot(s.state)!, boxShadow: '0 0 0 2px var(--bg-surface)',
            }} />
          )}
        </button>
      ))}
      {more > 0 && (
        <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', paddingTop: 2 }}>+{more}</span>
      )}
      {tip && createPortal(
        <div role="tooltip" style={{
          position: 'fixed', top: Math.min(tip.top, window.innerHeight - 140), left: tip.left,
          width: 260, zIndex: 500, pointerEvents: 'none',
          background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10,
          padding: '9px 11px', boxShadow: 'var(--ag-shadow-pop)',
        }}>
          <SessionFacts session={tip.session} />
        </div>,
        document.body,
      )}
    </nav>
  )
}
