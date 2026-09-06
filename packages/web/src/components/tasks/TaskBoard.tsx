/**
 * TaskBoard — the two ways to look at the deliveries: a BOARD and a TABLE.
 *
 * Board is the default because the first question is "what is in flight", which is a shape, not a
 * list. Table is there because the second question is "which config was cheapest", which is a
 * comparison, and comparisons want columns.
 *
 * Neither computes anything: every figure arrives already decided from `/api/tasks`.
 */

import { useMemo } from 'react'
import { MessageSquare, Paperclip, Terminal } from 'lucide-react'
import {
  COLUMN_ORDER, NA, STATUS, cardStyle, fmtInt, fmtTokens, fmtUSD, harnessColor, microLabel,
  numeric, pill, surface, type BoardStatus,
} from './board'
import type { TaskListRow } from '../../lib/tasks'

/** Subtask progress, as Monday draws it: a thin bar with the count beside it. */
function Progress({ done, total }: { done: number; total: number }) {
  if (total === 0) return null
  const pct = Math.round((done / total) * 100)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--bg-elevated)' }}>
        <div style={{
          width: `${pct}%`, height: '100%', borderRadius: 2,
          background: done === total ? 'var(--accent-green)' : 'var(--anthropic-orange)',
        }} />
      </div>
      <span style={{ ...microLabel, fontSize: 10 }}>{done}/{total}</span>
    </div>
  )
}

function Facts({ row }: { row: TaskListRow }) {
  const r = row.rollup
  const money = r.mixedCurrency || (r.credits !== null && r.costUSD === null)
    ? `${r.credits!.premiumRequests} req`
    : fmtUSD(r.costUSD)
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
      <span style={{ minWidth: 0 }}>
        <span style={{ ...microLabel, display: 'block' }}>Cost</span>
        <span style={{ ...numeric, display: 'block', color: r.costUSD === null && r.credits === null ? 'var(--text-tertiary)' : 'var(--anthropic-orange)' }}>
          {money}
        </span>
      </span>
      <span>
        <span style={{ ...microLabel, display: 'block' }}>Rounds</span>
        <span style={{ ...numeric, display: 'block' }}>{fmtInt(r.rounds)}</span>
      </span>
      <span>
        <span style={{ ...microLabel, display: 'block' }}>Sessions</span>
        <span style={{ ...numeric, display: 'block' }}>{r.sessionsUsed}</span>
      </span>
      <span>
        <span style={{ ...microLabel, display: 'block' }}>Tokens</span>
        <span style={{ ...numeric, display: 'block' }}>{fmtTokens(r.tokens)}</span>
      </span>
    </div>
  )
}

function Card({ row, onOpen }: { row: TaskListRow; onOpen: () => void }) {
  const s = STATUS[row.task.status as BoardStatus] ?? STATUS.todo
  const counts = row.counts
  return (
    <button
      onClick={onOpen}
      style={{ ...cardStyle, position: 'relative', overflow: 'hidden' }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-card-hover)' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-card)' }}
    >
      {/* The status stripe: the same colour the column header and the table cell use. */}
      <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: s.color }} />
      <div style={{ paddingLeft: 6, display: 'grid', gap: 8 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{row.task.title}</div>
        {row.task.detail && (
          <div style={{
            fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.45,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{row.task.detail}</div>
        )}

        {counts && <Progress done={counts.subtasksDone} total={counts.subtasks} />}

        <Facts row={row} />

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {row.harnesses.map(h => (
            <span key={h} style={pill(harnessColor(h))}>{h}</span>
          ))}
          {row.attempts > 0 && (
            <span style={pill()}>{row.attempts} attempt{row.attempts === 1 ? '' : 's'}</span>
          )}
          <span style={{ flex: 1 }} />
          {counts && counts.comments > 0 && (
            <span style={{ ...microLabel, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <MessageSquare size={11} /> {counts.comments}
            </span>
          )}
          {counts && counts.files > 0 && (
            <span style={{ ...microLabel, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Paperclip size={11} /> {counts.files}
            </span>
          )}
          {row.rollup.sessionsUsed > 0 && (
            <span style={{ ...microLabel, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Terminal size={11} /> {row.rollup.sessionsUsed}
            </span>
          )}
        </div>

        {/* The one caveat that must never be implied by a missing number. */}
        {row.rollup.sessionsLinked < row.rollup.sessionsUsed && (
          <div style={{ ...microLabel, textTransform: 'none', fontSize: 10.5, letterSpacing: 0 }}>
            cost covers {row.rollup.sessionsLinked} of {row.rollup.sessionsUsed} sessions
          </div>
        )}
      </div>
    </button>
  )
}

export function BoardView({ rows, onOpen }: { rows: TaskListRow[]; onOpen: (id: string) => void }) {
  const columns = useMemo(() => COLUMN_ORDER.map(status => ({
    status,
    rows: rows.filter(r => (r.task.status as BoardStatus) === status),
  })), [rows])

  return (
    /*
     * ONE ROW, scrolled sideways. A kanban that wraps is not a kanban: the columns stop reading as
     * a pipeline the moment `in_review` sits underneath `backlog`, and the eye has to re-find the
     * order on every glance. Seven fixed columns will not fit any screen, so the BOARD scrolls —
     * inside its own container, because the page body must never scroll horizontally (the 390px
     * rule). `overscroll-behavior-x: contain` keeps that scroll from turning into a browser
     * back-swipe on a trackpad.
     */
    <div
      className="ag-noscroll"
      style={{
        display: 'flex', gap: 12, alignItems: 'flex-start',
        overflowX: 'auto', overflowY: 'hidden', overscrollBehaviorX: 'contain',
        paddingBottom: 4,
        // Bleeds to the page edges so a column can sit flush against them while scrolling, which is
        // what makes the row read as continuing rather than as a boxed widget.
        marginInline: -2, paddingInline: 2,
        scrollSnapType: 'x proximity',
      }}
    >
      {columns.map(col => {
        const s = STATUS[col.status]
        return (
          <section
            key={col.status}
            style={{
              display: 'grid', gap: 10, alignContent: 'start',
              // Fixed, not fractional: columns of different widths read as different importance,
              // and a `1fr` column collapses to nothing once seven of them share a phone.
              flex: '0 0 clamp(240px, 78vw, 288px)',
              scrollSnapAlign: 'start',
            }}
          >
            <header style={{
              ...surface, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8,
              borderTop: `2px solid ${s.color}`, position: 'sticky', top: 0, zIndex: 1,
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: s.color }}>{s.label}</span>
              <span style={{ ...microLabel, fontSize: 11 }}>{col.rows.length}</span>
            </header>
            {col.rows.length === 0
              ? (
                // Short and quiet. An empty column still has to be VISIBLE — a status that vanishes
                // when nothing is in it makes the reader learn the vocabulary to notice the gap —
                // but seven full-height "Nothing here" boxes are most of the screen.
                <div style={{
                  ...surface, padding: '10px 12px', fontSize: 11, color: 'var(--text-tertiary)',
                  borderStyle: 'dashed', textAlign: 'center',
                }}>
                  —
                </div>
              )
              : col.rows.map(r => <Card key={r.task.id} row={r} onOpen={() => onOpen(r.task.id)} />)}
          </section>
        )
      })}
    </div>
  )
}

const th: React.CSSProperties = {
  ...microLabel, textAlign: 'left', padding: '8px 10px', fontWeight: 600,
  position: 'sticky', top: 0, background: 'var(--bg-surface)', zIndex: 1,
}
const td: React.CSSProperties = {
  padding: '9px 10px', fontSize: 12.5, borderTop: '1px solid var(--border)',
  color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
}

export function TableView({ rows, onOpen }: { rows: TaskListRow[]; onOpen: (id: string) => void }) {
  return (
    // The table scrolls inside its own container — the page body never scrolls horizontally.
    <div style={{ ...surface, overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
        <thead>
          <tr>
            <th style={{ ...th, minWidth: 220 }}>Task</th>
            <th style={th}>Status</th>
            <th style={th}>Attempts</th>
            <th style={th}>Sessions</th>
            <th style={th}>Rounds</th>
            <th style={th}>Tokens</th>
            <th style={th}>Cost</th>
            <th style={th}>Harnesses</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const s = STATUS[r.task.status as BoardStatus] ?? STATUS.todo
            const money = r.rollup.mixedCurrency || (r.rollup.credits !== null && r.rollup.costUSD === null)
              ? `${r.rollup.credits!.premiumRequests} req`
              : fmtUSD(r.rollup.costUSD)
            return (
              <tr
                key={r.task.id}
                onClick={() => onOpen(r.task.id)}
                style={{ cursor: 'pointer' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-card-hover)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                <td style={{ ...td, whiteSpace: 'normal', color: 'var(--text-primary)', fontWeight: 600 }}>
                  {r.task.title}
                </td>
                <td style={td}>
                  {/* Monday's status CELL: a solid block of the status colour, not a word. */}
                  <span style={{
                    display: 'inline-block', padding: '3px 10px', borderRadius: 6, fontSize: 10.5,
                    background: s.dim, color: s.color, border: `1px solid ${s.color}`,
                  }}>{s.label}</span>
                </td>
                <td style={td}>{r.attempts}</td>
                <td style={td}>
                  {r.rollup.sessionsUsed}
                  {r.rollup.sessionsLinked < r.rollup.sessionsUsed && (
                    <span style={{ color: 'var(--text-tertiary)' }}> ({r.rollup.sessionsLinked} priced)</span>
                  )}
                </td>
                <td style={td}>{fmtInt(r.rollup.rounds)}</td>
                <td style={td}>{fmtTokens(r.rollup.tokens)}</td>
                <td style={{ ...td, color: money === NA ? 'var(--text-tertiary)' : 'var(--anthropic-orange)', fontWeight: 600 }}>
                  {money}
                </td>
                <td style={td}>
                  <span style={{ display: 'inline-flex', gap: 4 }}>
                    {r.harnesses.map(h => <span key={h} style={pill(harnessColor(h))}>{h}</span>)}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
