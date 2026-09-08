/**
 * TaskBoard — the two ways to look at the deliveries: a BOARD and a TABLE.
 *
 * Board is the default because the first question is "what is in flight", which is a shape, not a
 * list. Table is there because the second question is "which config was cheapest", which is a
 * comparison, and comparisons want columns.
 *
 * Neither computes anything: every figure arrives already decided from `/api/tasks`.
 */

import { useEffect, useMemo, useState } from 'react'
import { Bot, CalendarClock, MessageSquare, Paperclip, Terminal } from 'lucide-react'
import { sortRows, type SortSpec } from '@agentistics/core'
import {
  COLUMN_ORDER, PRIORITY, SESSION_STATE, STATUS, cardStyle, claimLeft, fmtInt, fmtTokens, fmtUSD,
  harnessColor, microLabel, numeric, pill, surface, type BoardStatus,
} from './board'
import type { LaneKey } from './boardPrefs'
import { TaskProgressBar } from './TaskProgressBar'
import { statusLabel } from './copy'
import type { TaskListRow } from '../../lib/tasks'

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

function Card({ row, onOpen, live, nowMs }: {
  row: TaskListRow
  onOpen: () => void
  live: readonly { id: string; state: string; harness: string; title: string }[]
  nowMs: number
}) {
  const s = STATUS[row.task.status as BoardStatus] ?? STATUS.todo
  const counts = row.counts
  const priority = row.task.priority && row.task.priority !== 'none'
    ? PRIORITY[row.task.priority]
    : undefined
  const dueMs = row.task.dueDate ? Date.parse(`${row.task.dueDate}T23:59:59`) : NaN
  const closed = row.task.status === 'done' || row.task.status === 'abandoned'
  const late = !closed && Number.isFinite(dueMs) && dueMs < nowMs
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
        {(priority || row.task.assignee || row.task.dueDate) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {priority && (
              <span style={{
                padding: '1px 7px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                background: priority.dim, color: priority.color,
                border: `1px solid ${priority.color}`,
              }}>{priority.label}</span>
            )}
            {row.task.assignee && <span style={pill()}>{row.task.assignee}</span>}
            {row.task.dueDate && (
              <span
                style={{
                  ...microLabel, textTransform: 'none', letterSpacing: 0, fontSize: 10.5,
                  display: 'inline-flex', alignItems: 'center', gap: 3,
                  color: late ? 'var(--accent-red)' : 'var(--text-tertiary)',
                  fontWeight: late ? 700 : 400,
                }}
                title={late ? 'past its due date' : 'due'}
              ><CalendarClock size={10} /> {row.task.dueDate}</span>
            )}
          </div>
        )}
        <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{row.task.title}</div>
        {row.task.detail && (
          <div style={{
            fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.45,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          }}>{row.task.detail}</div>
        )}

        {counts && <TaskProgressBar done={counts.subtasksDone} total={counts.subtasks} />}

        <Agents row={row} live={live} nowMs={nowMs} />

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

/**
 * Who is ON this card right now, and who holds it.
 *
 * Two different facts and they are drawn differently on purpose: a CLAIM is a statement somebody
 * made ("this is mine until 14:20"), a live SESSION is something observed on the machine this
 * second. A card can carry either, both, or neither, and conflating them would let "an agent said
 * it would" read as "an agent is".
 */
function Agents({ row, live, nowMs }: {
  row: TaskListRow
  live: readonly { id: string; state: string; harness: string; title: string }[]
  nowMs: number
}) {
  const claim = row.task.claim
  const lease = claim ? claimLeft(claim.expiresAt, nowMs) : null
  if (!claim && live.length === 0) return null
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      {claim && (
        <span
          style={pill(lease!.expired ? 'var(--text-tertiary)' : 'var(--accent-green)')}
          title={lease!.expired
            ? `${claim.by} claimed this, and the lease has run out — it is available again`
            : `${claim.by} is on it · ${lease!.text}`}
        >
          <Bot size={10} /> {claim.by}{lease!.expired ? ' · lapsed' : ''}
        </span>
      )}
      {live.map(s => {
        const st = SESSION_STATE[s.state]
        return (
          <span key={s.id} style={pill(st?.color)} title={`${s.title} · ${s.harness}`}>
            {/* The dot is the fleet's own signal for "this one wants a person". */}
            {s.state === 'waiting-approval' && (
              <span style={{
                width: 6, height: 6, borderRadius: 3, background: 'var(--anthropic-orange)',
              }} />
            )}
            {st?.label ?? s.state}
          </span>
        )
      })}
    </div>
  )
}

export interface BoardViewProps {
  rows: TaskListRow[]
  /** The reader's language. Absent = English, for a caller not yet threaded. */
  lang?: 'pt' | 'en'
  onOpen: (id: string) => void
  /** A drop into another column. It is a STATUS change, and only the server writes it. */
  onStatus?: (id: string, status: BoardStatus) => void
  /** A drop within a column — the hand-arranged order. */
  onMove?: (id: string, index: number) => void
  /** The live fleet, so a card can say which session is on it. Matched by task NAME, which is what
   *  `/api/fleet` carries; a row filed under no task simply never matches. */
  sessions?: readonly { id: string; state: string; harness: string; title: string; task?: string }[]
  sort: SortSpec
  lanes: LaneKey
  /** Per-status card limits. A column over its limit SAYS so; nothing is ever blocked. */
  wip: Record<string, number>
  /** Which columns to draw, in order. Absent = the whole pipeline. */
  columns?: readonly BoardStatus[]
}

/** What a lane is called, and which rows belong to it. */
function laneOf(row: TaskListRow, key: LaneKey): string {
  switch (key) {
    case 'repo': return row.task.repo || 'no repository'
    case 'assignee': return row.task.assignee || 'unassigned'
    case 'harness': return row.harnesses[0] ?? 'no harness yet'
    case 'priority': return row.task.priority ?? 'none'
    case 'none': return ''
  }
}

export function BoardView(p: BoardViewProps) {
  const { rows, onOpen } = p
  const [drag, setDrag] = useState<string | null>(null)
  const [over, setOver] = useState<{ lane: string; status: BoardStatus; index: number } | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const liveByTask = useMemo(() => {
    const m = new Map<string, NonNullable<BoardViewProps['sessions']>[number][]>()
    for (const s of p.sessions ?? []) {
      if (!s.task) continue
      const list = m.get(s.task) ?? []
      list.push(s)
      m.set(s.task, list)
    }
    return m
  }, [p.sessions])

  /** Lanes in a stable order, each holding the chosen columns. One lane when `lanes` is `none`. */
  const lanes = useMemo(() => {
    const names = p.lanes === 'none'
      ? ['']
      : [...new Set(rows.map(r => laneOf(r, p.lanes)))].sort()
    // The chosen columns, in the chosen order — falling back to the whole pipeline, so a board
    // whose preference has never been touched looks exactly as it did.
    const shown = p.columns && p.columns.length > 0 ? p.columns : COLUMN_ORDER
    return names.map(name => ({
      name,
      columns: shown.map(status => ({
        status,
        rows: sortRows(
          rows.filter(r => (r.task.status as BoardStatus) === status
            && (p.lanes === 'none' || laneOf(r, p.lanes) === name)),
          p.sort,
        ),
      })),
    }))
  }, [rows, p.lanes, p.sort, p.columns])

  const drop = (lane: string, status: BoardStatus, index: number) => {
    const id = drag
    setDrag(null); setOver(null)
    if (!id) return
    const row = rows.find(r => r.task.id === id)
    if (!row) return
    // Two different writes, and only one of them applies: a drop into another column is a STATUS
    // change (the board's whole vocabulary), and a drop inside one is a reorder. Doing both from
    // one gesture would write two facts and leave a card in a column its status does not name if
    // the second failed.
    if ((row.task.status as BoardStatus) !== status) p.onStatus?.(id, status)
    else p.onMove?.(id, index)
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {lanes.map(lane => (
        <div key={lane.name} style={{ display: 'grid', gap: 8 }}>
          {lane.name !== '' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }}>
                {lane.name}
              </span>
              <span style={{ ...microLabel, fontSize: 10.5 }}>
                {lane.columns.reduce((n, c) => n + c.rows.length, 0)}
              </span>
              <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            </div>
          )}
          <div
            className="ag-noscroll"
            style={{
              /*
               * ONE ROW, scrolled sideways. A kanban that wraps is not a kanban: the columns stop
               * reading as a pipeline the moment `in_review` sits underneath `backlog`, and the eye
               * has to re-find the order on every glance. Seven fixed columns will not fit any
               * screen, so the BOARD scrolls — inside its own container, because the page body must
               * never scroll horizontally (the 390px rule). `overscroll-behavior-x: contain` keeps
               * that scroll from turning into a browser back-swipe on a trackpad.
               */
              display: 'flex', gap: 12, alignItems: 'flex-start',
              overflowX: 'auto', overflowY: 'hidden', overscrollBehaviorX: 'contain',
              paddingBottom: 4, marginInline: -2, paddingInline: 2,
              scrollSnapType: 'x proximity',
            }}
          >
            {lane.columns.map(col => {
              const s = STATUS[col.status]
              const limit = p.wip[col.status]
              const over_ = limit !== undefined && col.rows.length > limit
              const isOverCol = over?.lane === lane.name && over.status === col.status
              return (
                <section
                  key={col.status}
                  onDragOver={e => {
                    if (!drag) return
                    e.preventDefault()
                    if (!isOverCol) setOver({ lane: lane.name, status: col.status, index: col.rows.length })
                  }}
                  onDrop={e => { e.preventDefault(); drop(lane.name, col.status, over?.index ?? col.rows.length) }}
                  style={{
                    display: 'grid', gap: 10, alignContent: 'start',
                    // Fixed, not fractional: columns of different widths read as different
                    // importance, and a `1fr` column collapses to nothing once seven of them share
                    // a phone.
                    flex: '0 0 clamp(240px, 78vw, 288px)',
                    scrollSnapAlign: 'start',
                    outline: isOverCol ? '1px dashed var(--anthropic-orange)' : 'none',
                    outlineOffset: 4, borderRadius: 'var(--radius-md)',
                  }}
                >
                  <header style={{
                    ...surface, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 8,
                    borderTop: `2px solid ${s.color}`, position: 'sticky', top: 0, zIndex: 1,
                  }}>
                    {/* The same word the table's band and every chip print. */}
                    <span style={{ fontSize: 12, fontWeight: 600, color: s.color }}>
                      {statusLabel(col.status, p.lang ?? 'en')}
                    </span>
                    <span style={{ ...microLabel, fontSize: 11 }}>
                      {col.rows.length}{limit !== undefined ? ` / ${limit}` : ''}
                    </span>
                    {over_ && (
                      // A WIP limit WARNS and never blocks: the limit is an agreement a team makes
                      // with itself, and a board that refuses a drop teaches people to work around
                      // it rather than to look at it.
                      <span
                        style={pill('var(--accent-red)')}
                        title={`${col.rows.length} in this column, over the limit of ${limit}`}
                      >over WIP</span>
                    )}
                  </header>
                  {col.rows.length === 0
                    ? (
                      // Short and quiet. An empty column still has to be VISIBLE — a status that
                      // vanishes when nothing is in it makes the reader learn the vocabulary to
                      // notice the gap — but seven full-height "Nothing here" boxes are most of the
                      // screen.
                      <div style={{
                        ...surface, padding: '10px 12px', fontSize: 11, color: 'var(--text-tertiary)',
                        borderStyle: 'dashed', textAlign: 'center',
                      }}>
                        —
                      </div>
                    )
                    : col.rows.map((r, i) => (
                      <div
                        key={r.task.id}
                        draggable
                        onDragStart={() => setDrag(r.task.id)}
                        onDragEnd={() => { setDrag(null); setOver(null) }}
                        onDragOver={e => {
                          if (!drag) return
                          e.preventDefault()
                          e.stopPropagation()
                          // Above or below the card the pointer is over — the whole of what a drop
                          // position is.
                          const box = e.currentTarget.getBoundingClientRect()
                          const after = e.clientY > box.top + box.height / 2
                          setOver({ lane: lane.name, status: col.status, index: after ? i + 1 : i })
                        }}
                        style={{
                          borderTop: isOverCol && over?.index === i
                            ? '2px solid var(--anthropic-orange)' : '2px solid transparent',
                          opacity: drag === r.task.id ? 0.45 : 1,
                        }}
                      >
                        <Card
                          row={r}
                          nowMs={nowMs}
                          live={liveByTask.get(r.task.title) ?? []}
                          onOpen={() => onOpen(r.task.id)}
                        />
                      </div>
                    ))}
                </section>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
