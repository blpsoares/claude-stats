/**
 * TaskTable — the board as a GRID you operate, in the shape monday.com established.
 *
 * The anatomy it reproduces, and why each piece is there:
 *
 *  - **Groups**: a coloured bar, a collapsible header and a count. The grouping is the STATUS by
 *    default, because that is the question the board answers first; the column set is shared by
 *    every group, so a row keeps its meaning when it moves between them.
 *  - **Rows**: a checkbox on the left, a chevron when there are subtasks, and typed cells.
 *  - **Subitems**: expand INSIDE the row, with their own column set. Monday's rule, and the right
 *    one: a subtask is a smaller piece of the same work, not a second task — it has no attempts and
 *    no rollup of its own, because cost is measured per SESSION and rolls up to the task. Giving it
 *    a second, smaller rollup would either double-count the same sessions or invent a split nobody
 *    recorded.
 *  - **Batch actions**: selecting rows raises a bar at the foot saying how many, with the verbs that
 *    can act on many at once.
 *  - **`+` in the header**: choose which columns are shown. The defaults are the ones that answer
 *    the three questions the product exists for — what it cost, in how many rounds, across how many
 *    sessions — so the table is useful before anyone configures anything.
 *  - **`+ Add` row** at the foot of each group: type a title, press Enter.
 *
 * It computes NOTHING. Every figure arrives already decided from `/api/tasks`.
 */

import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowDown, ArrowUp, Bot, ChevronDown, ChevronRight, Columns3, MessageSquare, Paperclip, Plus,
  Rows3, Terminal, Trash2, X,
} from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import {
  COLUMN_ORDER, NA, PRIORITY, STATUS, button, claimLeft, field, fmtInt, fmtTokens, fmtUSD,
  harnessColor, microLabel, numeric, pill, surface, type BoardStatus, type ColumnId,
} from './board'
import {
  DEFAULT_SORT, nextSort, PRIORITY_ORDER, sortRows,
  type SortKey, type SortSpec, type TaskPriorityId,
} from '@agentistics/core'
import { readBoardPrefs, writeBoardPrefs } from './boardPrefs'
import { SessionPicker } from './SessionPicker'
import type { Subtask, TaskClaim, TaskDetail, TaskListRow, TaskStatus } from '../../lib/tasks'

/** The words the "sorted by" note uses. Kept beside `COLUMNS`, whose labels they mirror. */
const SORT_LABEL: Record<string, string> = {
  manual: 'the board order', priority: 'priority', title: 'title', status: 'status',
  created: 'created', updated: 'updated', due: 'due date', assignee: 'owner', cost: 'cost',
  tokens: 'tokens', rounds: 'rounds', sessions: 'sessions', attempts: 'attempts',
  comments: 'comments', subtasks: 'subtasks', harnesses: 'harnesses',
}

// ---------------------------------------------------------------------------- columns

export type { ColumnId }

export interface ColumnDef {
  id: ColumnId
  label: string
  /** Right-aligned, tabular. Every measured number is one; a chip column is not. */
  numeric?: boolean
  width: number
  /**
   * Which `SortKey` this column sorts by — absent means the column is not sortable, and its header
   * then carries no affordance at all rather than a control that does nothing.
   */
  sort?: SortKey
}

/**
 * The default set answers the three questions the product exists for before anyone configures
 * anything. The rest are one click away in the `+` menu.
 */
export const COLUMNS: ColumnDef[] = [
  { id: 'status', label: 'Status', width: 116, sort: 'status' },
  { id: 'priority', label: 'Priority', width: 96, sort: 'priority' },
  { id: 'assignee', label: 'Owner', width: 110, sort: 'assignee' },
  { id: 'claim', label: 'Working on it', width: 132 },
  { id: 'due', label: 'Due', width: 96, sort: 'due' },
  { id: 'sessions', label: 'Sessions', numeric: true, width: 84, sort: 'sessions' },
  { id: 'rounds', label: 'Rounds', numeric: true, width: 76, sort: 'rounds' },
  { id: 'cost', label: 'Cost', numeric: true, width: 88, sort: 'cost' },
  { id: 'tokens', label: 'Tokens', numeric: true, width: 84, sort: 'tokens' },
  { id: 'harnesses', label: 'Harnesses', width: 150, sort: 'harnesses' },
  { id: 'subtasks', label: 'Subtasks', numeric: true, width: 84, sort: 'subtasks' },
  { id: 'attempts', label: 'Attempts', numeric: true, width: 84, sort: 'attempts' },
  { id: 'comments', label: 'Comments', numeric: true, width: 92, sort: 'comments' },
  { id: 'files', label: 'Files', numeric: true, width: 68 },
  { id: 'links', label: 'Links', numeric: true, width: 68 },
  { id: 'blockedBy', label: 'Blocked by', numeric: true, width: 92 },
  { id: 'created', label: 'Created', width: 104, sort: 'created' },
  { id: 'updated', label: 'Updated', width: 104, sort: 'updated' },
]

export const DEFAULT_COLUMNS: ColumnId[] =
  ['status', 'priority', 'claim', 'sessions', 'rounds', 'cost', 'tokens', 'harnesses', 'subtasks']

// ------------------------------------------------------------------------------- cells

const cellPad = '7px 10px'

/**
 * A phone's thumb over a table cell.
 *
 * The glyph stays the size the table needs; the PADDING is what makes it 44px, so a dense row is
 * still dense and still tappable. Growing the icon instead would make the table unreadable to buy
 * the same hit area.
 */
const tap = (mobile: boolean): React.CSSProperties =>
  mobile ? { minHeight: 44, minWidth: 44, justifyContent: 'center' } : {}

function StatusCell({ value, onPick, compact }: {
  value: TaskStatus
  onPick: (s: TaskStatus) => void
  compact?: boolean
}) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const s = STATUS[value as BoardStatus] ?? STATUS.todo
  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(v => !v) }}
        style={{
          // Monday's status CELL: a solid block of colour that fills its cell, not a word.
          width: '100%', border: 'none', cursor: 'pointer',
          padding: compact ? '3px 8px' : '5px 9px', borderRadius: 5,
          background: s.dim, color: s.color, fontSize: 11, fontWeight: 600,
          outline: `1px solid ${s.color}`,
          // The status is the cell people CHANGE from the table; on a phone it owes a thumb 44px.
          minHeight: isMobile ? 44 : undefined,
        }}
      >{s.label}</button>
      {open && (
        <>
          <div onClick={e => { e.stopPropagation(); setOpen(false) }}
               style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
          <div style={{
            position: 'absolute', top: '100%', left: 0, zIndex: 31, marginTop: 4, minWidth: 132,
            ...surface, background: 'var(--bg-elevated)', padding: 4, display: 'grid', gap: 2,
            boxShadow: 'var(--shadow-elevated)',
          }}>
            {COLUMN_ORDER.map(st => {
              const c = STATUS[st]
              return (
                <button
                  key={st}
                  onClick={e => { e.stopPropagation(); setOpen(false); onPick(st) }}
                  style={{
                    border: 'none', cursor: 'pointer', textAlign: 'left', padding: '5px 9px',
                    borderRadius: 5, background: c.dim, color: c.color, fontSize: 11, fontWeight: 600,
                    minHeight: isMobile ? 44 : undefined,
                  }}
                >{c.label}</button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function Num({ v, accent }: { v: number | null | undefined; accent?: boolean }) {
  const absent = v === null || v === undefined
  return (
    <span style={{
      ...numeric, fontSize: 12,
      color: absent ? 'var(--text-tertiary)' : accent ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
    }}>{absent ? NA : v.toLocaleString()}</span>
  )
}

function PriorityCell({ value, onPick }: { value: string; onPick: (p: TaskPriorityId) => void }) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const p = PRIORITY[value] ?? PRIORITY.none!
  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(v => !v) }}
        style={{
          border: `1px solid ${value === 'none' ? 'var(--border)' : p.color}`,
          background: p.dim, color: p.color, cursor: 'pointer',
          padding: '3px 9px', borderRadius: 5, fontSize: 10.5, fontWeight: 600,
          minHeight: isMobile ? 44 : undefined, width: '100%',
        }}
      >{p.label}</button>
      {open && (
        <>
          <div onClick={e => { e.stopPropagation(); setOpen(false) }}
               style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
          <div style={{
            position: 'absolute', top: '100%', left: 0, zIndex: 31, marginTop: 4, minWidth: 120,
            ...surface, background: 'var(--bg-elevated)', padding: 4, display: 'grid', gap: 2,
            boxShadow: 'var(--shadow-elevated)',
          }}>
            {PRIORITY_ORDER.map(id => {
              const c = PRIORITY[id]!
              return (
                <button
                  key={id}
                  onClick={e => { e.stopPropagation(); setOpen(false); onPick(id) }}
                  style={{
                    border: 'none', cursor: 'pointer', textAlign: 'left', padding: '5px 9px',
                    borderRadius: 5, background: c.dim, color: c.color, fontSize: 10.5,
                    fontWeight: 600, minHeight: isMobile ? 44 : undefined,
                  }}
                >{c.label}</button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * A due date, and whether it has passed.
 *
 * A CLOSED task never reads as late: the work is finished, and colouring a delivered row red says
 * something false about a thing nobody can act on any more.
 */
function DueCell({ date, closed, nowMs }: { date: string; closed: boolean; nowMs: number }) {
  const due = Date.parse(`${date}T23:59:59`)
  const late = !closed && Number.isFinite(due) && due < nowMs
  return (
    <span style={{
      fontSize: 11.5, fontWeight: late ? 600 : 400,
      color: late ? 'var(--accent-red)' : 'var(--text-secondary)',
    }}>{date}</span>
  )
}

/**
 * Who has the task RIGHT NOW.
 *
 * An expired lease is said out loud ("lease expired") rather than blanked: the task is available
 * again, and a cell that simply stopped naming a holder would read as one nobody ever took.
 */
function ClaimCell({ claim, nowMs }: { claim?: TaskClaim; nowMs: number }) {
  if (!claim) return <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>
  const left = claimLeft(claim.expiresAt, nowMs)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
      <span style={pill(left.expired ? 'var(--text-tertiary)' : 'var(--accent-green)')}>
        <Bot size={10} /> {claim.by}
      </span>
      <span style={{ fontSize: 10, color: left.expired ? 'var(--text-tertiary)' : 'var(--text-secondary)' }}>
        {left.text}
      </span>
    </span>
  )
}

function cellFor(
  col: ColumnId,
  row: TaskListRow,
  onStatus: (s: TaskStatus) => void,
  onPriority: (p: TaskPriorityId) => void,
  nowMs: number,
): React.ReactNode {
  const r = row.rollup
  switch (col) {
    case 'status': return <StatusCell value={row.task.status} onPick={onStatus} />
    case 'priority': return <PriorityCell value={row.task.priority ?? 'none'} onPick={onPriority} />
    case 'assignee': return row.task.assignee
      ? <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{row.task.assignee}</span>
      : <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>
    case 'due': return row.task.dueDate
      ? <DueCell date={row.task.dueDate} closed={row.task.status === 'done' || row.task.status === 'abandoned'} nowMs={nowMs} />
      : <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>
    case 'claim': return <ClaimCell claim={row.task.claim} nowMs={nowMs} />
    case 'updated': return (
      <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        {new Date(row.task.updatedAt).toLocaleDateString()}
      </span>
    )
    case 'sessions': return (
      <span>
        <Num v={r.sessionsUsed} />
        {r.sessionsLinked < r.sessionsUsed && (
          <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}> ({r.sessionsLinked} priced)</span>
        )}
      </span>
    )
    case 'rounds': return <Num v={r.rounds} />
    case 'cost': return r.mixedCurrency || (r.credits !== null && r.costUSD === null)
      ? <span style={{ ...numeric, fontSize: 12 }}>{r.credits!.premiumRequests} req</span>
      : <span style={{ ...numeric, fontSize: 12, color: r.costUSD === null ? 'var(--text-tertiary)' : 'var(--anthropic-orange)' }}>{fmtUSD(r.costUSD)}</span>
    case 'tokens': return <span style={{ ...numeric, fontSize: 12, color: r.tokens === null ? 'var(--text-tertiary)' : undefined }}>{fmtTokens(r.tokens)}</span>
    case 'harnesses': return (
      <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
        {row.harnesses.length === 0
          ? <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{NA}</span>
          : row.harnesses.map(h => <span key={h} style={pill(harnessColor(h))}>{h}</span>)}
      </span>
    )
    case 'subtasks': return row.counts.subtasks === 0
      ? <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>
      : <span style={{ ...numeric, fontSize: 12 }}>{row.counts.subtasksDone}/{row.counts.subtasks}</span>
    case 'attempts': return <Num v={row.attempts} />
    case 'comments': return row.counts.comments === 0
      ? <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>
      : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, ...numeric, fontSize: 12 }}>
          <MessageSquare size={11} />{row.counts.comments}
        </span>
    case 'files': return row.counts.files === 0
      ? <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>
      : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, ...numeric, fontSize: 12 }}>
          <Paperclip size={11} />{row.counts.files}
        </span>
    case 'links': return <Num v={row.task.links?.length ?? 0} />
    case 'blockedBy': {
      const n = row.task.blockedBy?.length ?? 0
      return n === 0
        ? <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>
        : <span style={pill('var(--accent-red)')}>{n}</span>
    }
    case 'created': return (
      <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        {new Date(row.task.createdAt).toLocaleDateString()}
      </span>
    )
  }
}

// ------------------------------------------------------------------------------ subrow

/**
 * The subitem columns, and they are the SAME ones `SubtaskTable` draws on the detail page.
 *
 * A subtask that carries an owner, two dates and a session in one place and a title with a checkbox
 * in the other is two different records as far as the reader is concerned — and the shorter one
 * teaches people the fields do not exist. One list of columns, stated here and mirrored there.
 */
export const SUBTASK_COLUMNS = ['Subtask', 'Status', 'Owner', 'Start', 'Due', 'Session', ''] as const

function SubtaskRows({ subtasks, indent, cols, sessionLabelOf, onPatch, onRemove, onLinkSession }: {
  subtasks: Subtask[]
  indent: number
  /** How many task columns the group's table has — the filler cell has to close the row exactly. */
  cols: number
  sessionLabelOf?: (sessionId: string) => string | undefined
  onPatch: (id: string, patch: Partial<Subtask>) => void
  onRemove: (id: string) => void
  onLinkSession: (subtaskId: string) => void
}) {
  const isMobile = useIsMobile()
  const bare: React.CSSProperties = {
    width: '100%', background: 'transparent', border: 'none', outline: 'none',
    color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'inherit',
    minHeight: isMobile ? 44 : undefined,
  }
  // 1 (checkbox) + 6 named cells + filler + 1 (remove) must equal cols + 3.
  const filler = Math.max(0, cols - 5)
  return (
    <>
      {subtasks.map(t => (
        <tr key={t.id} style={{ background: 'var(--bg-surface)' }}>
          <td style={{ padding: cellPad }} />
          <td style={{ padding: cellPad, paddingLeft: indent }}>
            <input
              value={t.title}
              onChange={e => onPatch(t.id, { title: e.target.value })}
              style={{
                ...bare,
                color: t.done ? 'var(--text-tertiary)' : 'var(--text-secondary)', fontSize: 12.5,
                textDecoration: t.done ? 'line-through' : 'none',
              }}
            />
          </td>
          <td style={{ padding: cellPad }}>
            <StatusCell compact value={t.status} onPick={s => onPatch(t.id, { status: s })} />
          </td>
          <td style={{ padding: cellPad }}>
            <input
              value={t.assignee ?? ''} placeholder="—"
              onChange={e => onPatch(t.id, { assignee: e.target.value })}
              style={bare}
            />
          </td>
          <td style={{ padding: cellPad }}>
            <input
              type="date" value={t.startDate ?? ''}
              onChange={e => onPatch(t.id, { startDate: e.target.value })}
              style={{
                ...bare, colorScheme: 'dark',
                color: t.startDate ? 'var(--text-secondary)' : 'var(--text-tertiary)',
              }}
            />
          </td>
          <td style={{ padding: cellPad }}>
            <input
              type="date" value={t.dueDate ?? ''}
              onChange={e => onPatch(t.id, { dueDate: e.target.value })}
              style={{
                ...bare, colorScheme: 'dark',
                color: t.dueDate ? 'var(--text-secondary)' : 'var(--text-tertiary)',
              }}
            />
          </td>
          <td style={{ padding: cellPad }}>
            {t.sessionId ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={pill()}>{sessionLabelOf?.(t.sessionId) ?? t.sessionId.slice(0, 8)}</span>
                <button
                  onClick={() => onPatch(t.id, { sessionId: '' })} title="Unlink"
                  style={{
                    background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', ...tap(isMobile),
                  }}
                ><X size={11} /></button>
              </span>
            ) : (
              <button
                onClick={() => onLinkSession(t.id)}
                style={{
                  background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5,
                  ...tap(isMobile),
                }}
              ><Terminal size={12} /> link</button>
            )}
          </td>
          {filler > 0 && <td colSpan={filler} />}
          <td style={{ padding: cellPad, textAlign: 'right' }}>
            <button
              onClick={() => onRemove(t.id)} title="Remove"
              style={{
                background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', ...tap(isMobile),
              }}
            ><Trash2 size={12} /></button>
          </td>
        </tr>
      ))}
    </>
  )
}

// ------------------------------------------------------------------------------- table

export interface TaskTableProps {
  rows: TaskListRow[]
  /** Details already fetched for expanded rows — subtasks come from here. */
  details: Map<string, TaskDetail>
  onOpen: (id: string) => void
  onStatus: (ref: string, status: TaskStatus) => void
  onPriority?: (ref: string, priority: TaskPriorityId) => void
  onCreate: (title: string, status: TaskStatus) => void
  onExpand: (id: string) => void
  onAddSubtask: (ref: string, title: string) => void
  onPatchSubtask: (ref: string, id: string, patch: Partial<Subtask>) => void
  onRemoveSubtask: (ref: string, id: string) => void
  onBatchStatus: (ids: string[], status: TaskStatus) => void
  onBatchDelete: (ids: string[]) => void
  onLinkSession: (ref: string) => void
}

export function TaskTable(p: TaskTableProps) {
  const isMobile = useIsMobile()
  const stored = useMemo(readBoardPrefs, [])

  const [shown, setShown] = useState<ColumnId[]>(stored.columns ?? DEFAULT_COLUMNS)
  const [sort, setSortState] = useState<SortSpec>(stored.sort ?? DEFAULT_SORT)
  // One clock for every lease cell on the screen, ticking a minute at a time. A card that says
  // "3m left" forever is worse than one that says nothing, and a timer per cell would be N timers.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  const [groupsShown, setGroupsShown] = useState<BoardStatus[]>(stored.groups ?? [...COLUMN_ORDER])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(stored.collapsed))
  const [menu, setMenu] = useState<'columns' | 'groups' | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState<TaskStatus | null>(null)
  const [draft, setDraft] = useState('')
  const [subDraft, setSubDraft] = useState<Record<string, string>>({})
  /** Which subtask is being given a session — `taskId/subtaskId`, so the patch knows both. */
  const [linkingSub, setLinkingSub] = useState<{ task: string; sub: string } | null>(null)

  const cols = useMemo(
    () => COLUMNS.filter(c => shown.includes(c.id)).sort(
      (a, b) => shown.indexOf(a.id) - shown.indexOf(b.id)),
    [shown],
  )

  // Every group is BUILT, even a hidden one: the chooser needs its count to say what it is hiding.
  // Sorted INSIDE the group, never across: the grouping is the first ordering and a sort that
  // reordered the bands would silently undo the arrangement chosen a control away.
  const groups = useMemo(() => COLUMN_ORDER.map(status => ({
    status,
    rows: sortRows(p.rows.filter(r => (r.task.status as BoardStatus) === status), sort),
  })), [p.rows, sort])

  const setColumns = (next: ColumnId[]) => { setShown(next); writeBoardPrefs({ columns: next }) }
  const setSort = (next: SortSpec) => { setSortState(next); writeBoardPrefs({ sort: next }) }
  const setGroups = (next: BoardStatus[]) => { setGroupsShown(next); writeBoardPrefs({ groups: next }) }
  const foldGroup = (status: BoardStatus) => {
    const next = new Set(collapsed)
    next.has(status) ? next.delete(status) : next.add(status)
    setCollapsed(next)
    writeBoardPrefs({ collapsed: [...next] as BoardStatus[] })
  }

  const toggleIn = (set: Set<string>, id: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set)
    next.has(id) ? next.delete(id) : next.add(id)
    apply(next)
  }

  const th: React.CSSProperties = {
    ...microLabel, textAlign: 'left', padding: '7px 10px', fontWeight: 600,
    borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
  }

  const menuBox: React.CSSProperties = {
    position: 'absolute', top: 34, right: 0, zIndex: 41, width: 210,
    ...surface, background: 'var(--bg-elevated)', padding: 8, display: 'grid', gap: 3,
    boxShadow: 'var(--shadow-elevated)', maxHeight: 340, overflowY: 'auto',
  }
  const check: React.CSSProperties = {
    display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer',
    fontSize: 12, color: 'var(--text-secondary)', minHeight: isMobile ? 34 : 22,
  }

  const visible = groups.filter(g => groupsShown.includes(g.status))

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {/* The chooser bar. Groups first: it decides what is on the screen at all, and the columns
          only decide what each row says. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', position: 'relative' }}>
        <span style={{ ...microLabel, fontSize: 10.5 }}>
          {visible.length} of {groups.length} groups
        </span>
        {sort.key !== DEFAULT_SORT.key && (
          // Said in words, with the way out beside it: a sort is invisible once you have scrolled
          // past the header, and "why is this board in this order" should never need investigating.
          <button
            onClick={() => setSort(DEFAULT_SORT)}
            style={{
              ...button(isMobile), height: isMobile ? 44 : 26, fontSize: 11,
              color: 'var(--anthropic-orange)',
            }}
          >
            sorted by {SORT_LABEL[sort.key] ?? sort.key} {sort.dir === 'asc' ? '↑' : '↓'} · reset
          </button>
        )}
        <span style={{ flex: 1 }} />
        <div style={{ position: 'relative' }}>
          <button
            style={{ ...button(isMobile), height: isMobile ? 44 : 28 }}
            onClick={() => setMenu(m => (m === 'groups' ? null : 'groups'))}
          ><Rows3 size={13} /> Groups</button>
          {menu === 'groups' && (
            <>
              <div onClick={() => setMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
              <div style={menuBox}>
                <div style={{ ...microLabel, marginBottom: 3 }}>Show groups</div>
                {groups.map(g => {
                  const c = STATUS[g.status]
                  return (
                    <label key={g.status} style={check}>
                      <input
                        type="checkbox" checked={groupsShown.includes(g.status)}
                        onChange={() => setGroups(
                          groupsShown.includes(g.status)
                            ? groupsShown.filter(x => x !== g.status)
                            : [...COLUMN_ORDER].filter(x => x === g.status || groupsShown.includes(x)),
                        )}
                        style={{ width: 14, height: 14, accentColor: 'var(--anthropic-orange)' }}
                      />
                      <span style={{ color: c.color }}>{c.label}</span>
                      <span style={{ flex: 1 }} />
                      {/* The count of a HIDDEN group too — "hidden" must not read as "empty". */}
                      <span style={{ ...numeric, fontSize: 11, color: 'var(--text-tertiary)' }}>
                        {g.rows.length}
                      </span>
                    </label>
                  )
                })}
              </div>
            </>
          )}
        </div>
        <div style={{ position: 'relative' }}>
          <button
            style={{ ...button(isMobile), height: isMobile ? 44 : 28 }}
            onClick={() => setMenu(m => (m === 'columns' ? null : 'columns'))}
          ><Columns3 size={13} /> Columns</button>
          {menu === 'columns' && (
            <>
              <div onClick={() => setMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
              <div style={menuBox}>
                <div style={{ ...microLabel, marginBottom: 3 }}>Columns</div>
                {COLUMNS.map(c => (
                  <label key={c.id} style={check}>
                    <input
                      type="checkbox" checked={shown.includes(c.id)}
                      onChange={() => setColumns(
                        shown.includes(c.id) ? shown.filter(x => x !== c.id) : [...shown, c.id])}
                      style={{ width: 14, height: 14, accentColor: 'var(--anthropic-orange)' }}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {visible.length === 0 && (
        <div style={{ ...surface, padding: 16, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          Every group is hidden. Open <strong style={{ color: 'var(--text-secondary)' }}>Groups</strong> above
          to bring one back — the tasks are still there.
        </div>
      )}

      {/* One CARD per group, each folding on its own. A single table holding every status made the
          whole board one scroll and one thing to collapse; a group is what people actually work in. */}
      {visible.map(g => {
        const s = STATUS[g.status]
        const isFolded = collapsed.has(g.status)
        return (
          <div key={g.status} style={{ ...surface, overflow: 'hidden', borderLeft: `3px solid ${s.color}` }}>
            <div
              onClick={() => foldGroup(g.status)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                padding: '9px 11px', background: 'var(--bg-base)',
                minHeight: isMobile ? 44 : 32,
              }}
            >
              {isFolded ? <ChevronRight size={14} color={s.color} /> : <ChevronDown size={14} color={s.color} />}
              <span style={{ fontSize: 12.5, fontWeight: 700, color: s.color }}>{s.label}</span>
              <span style={{ ...microLabel, fontSize: 11 }}>{g.rows.length}</span>
            </div>

            {!isFolded && (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: g.rows.length === 0 ? 0 : 760 }}>
                  {/* No heading row over an EMPTY group: eight column names above nothing is eight
                      names for a table that is not there, repeated once per empty status. */}
                  {g.rows.length > 0 && (
                    <thead>
                      <tr>
                        <th style={{ ...th, width: 34 }} />
                        <th style={{ ...th, minWidth: 240 }}>
                          <button
                            onClick={() => setSort(nextSort(sort, 'title'))} title="Sort by title"
                            style={{
                              ...microLabel, fontWeight: 600, background: 'none', border: 'none',
                              cursor: 'pointer', padding: 0, display: 'inline-flex',
                              alignItems: 'center', gap: 3, minHeight: isMobile ? 44 : undefined,
                              color: sort.key === 'title' ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                            }}
                          >
                            Task
                            {sort.key === 'title' && (
                              sort.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />
                            )}
                          </button>
                        </th>
                        {cols.map(c => (
                          <th key={c.id} style={{ ...th, width: c.width, textAlign: c.numeric ? 'right' : 'left' }}>
                            {/* A column with no `sort` carries NO affordance — a header that looks
                                clickable and does nothing is worse than a plain one. */}
                            {c.sort ? (
                              <button
                                onClick={() => setSort(nextSort(sort, c.sort!))}
                                title={`Sort by ${c.label}`}
                                style={{
                                  ...microLabel, fontWeight: 600, background: 'none', border: 'none',
                                  cursor: 'pointer', padding: 0, display: 'inline-flex',
                                  alignItems: 'center', gap: 3, minHeight: isMobile ? 44 : undefined,
                                  color: sort.key === c.sort ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                                }}
                              >
                                {c.label}
                                {sort.key === c.sort && (
                                  sort.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />
                                )}
                              </button>
                            ) : c.label}
                          </th>
                        ))}
                        <th style={{ ...th, width: 40 }} />
                      </tr>
                    </thead>
                  )}
                  <tbody>
                    {g.rows.map(row => {
                      const open = expanded.has(row.task.id)
                      const detail = p.details.get(row.task.id)
                      const subs = detail?.subtasks ?? []
                      return (
                        <React.Fragment key={row.task.id}>
                          <tr
                            style={{ borderTop: '1px solid var(--border)', cursor: 'pointer' }}
                            onClick={() => p.onOpen(row.task.id)}
                            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-card-hover)' }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                          >
                            <td style={{ padding: cellPad }} onClick={e => e.stopPropagation()}>
                              <input
                                type="checkbox" checked={selected.has(row.task.id)}
                                onChange={() => toggleIn(selected, row.task.id, setSelected)}
                                style={{
                                  width: isMobile ? 20 : 14, height: isMobile ? 20 : 14,
                                  accentColor: 'var(--anthropic-orange)',
                                }}
                              />
                            </td>
                            <td style={{ padding: cellPad }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                                <button
                                  onClick={e => {
                                    e.stopPropagation()
                                    toggleIn(expanded, row.task.id, setExpanded)
                                    if (!open) p.onExpand(row.task.id)
                                  }}
                                  style={{
                                    background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex',
                                    alignItems: 'center', color: 'var(--text-tertiary)', padding: 0,
                                    ...tap(isMobile),
                                  }}
                                >{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
                                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                                  {row.task.title}
                                </span>
                              </span>
                            </td>
                            {cols.map(c => (
                              <td
                                key={c.id}
                                style={{ padding: cellPad, textAlign: c.numeric ? 'right' : 'left' }}
                                onClick={c.id === 'status' ? e => e.stopPropagation() : undefined}
                              >
                                {cellFor(
                                  c.id, row,
                                  st => p.onStatus(row.task.id, st),
                                  pr => p.onPriority?.(row.task.id, pr),
                                  nowMs,
                                )}
                              </td>
                            ))}
                            <td style={{ padding: cellPad, textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                              <button
                                onClick={() => p.onLinkSession(row.task.id)} title="Link a session"
                                style={{
                                  background: 'none', border: 'none', color: 'var(--text-tertiary)',
                                  cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
                                  ...tap(isMobile),
                                }}
                              ><Terminal size={13} /></button>
                            </td>
                          </tr>

                          {open && (
                            <>
                              <tr style={{ background: 'var(--bg-surface)' }}>
                                <td style={{ padding: '5px 10px' }} />
                                {SUBTASK_COLUMNS.map((h, i) => (
                                  <td key={i} style={{ ...microLabel, padding: '5px 10px', paddingLeft: i === 0 ? 34 : 10 }}>
                                    {h}
                                  </td>
                                ))}
                                {cols.length > 5 && <td colSpan={cols.length - 5} />}
                              </tr>
                              <SubtaskRows
                                subtasks={subs} indent={34} cols={cols.length}
                                sessionLabelOf={sid => detail?.sessions.find(r => r.id === sid)?.label}
                                onPatch={(id, patch) => p.onPatchSubtask(row.task.id, id, patch)}
                                onRemove={id => p.onRemoveSubtask(row.task.id, id)}
                                onLinkSession={sub => setLinkingSub({ task: row.task.id, sub })}
                              />
                              <tr style={{ background: 'var(--bg-surface)' }}>
                                <td style={{ padding: '5px 10px' }} />
                                <td colSpan={cols.length + 2} style={{ padding: '5px 10px', paddingLeft: 34 }}>
                                  <input
                                    value={subDraft[row.task.id] ?? ''}
                                    placeholder="+ Add subtask"
                                    onChange={e => setSubDraft({ ...subDraft, [row.task.id]: e.target.value })}
                                    onClick={e => e.stopPropagation()}
                                    onKeyDown={e => {
                                      const v = subDraft[row.task.id] ?? ''
                                      if (e.key === 'Enter' && v.trim()) {
                                        p.onAddSubtask(row.task.id, v.trim())
                                        setSubDraft({ ...subDraft, [row.task.id]: '' })
                                      }
                                    }}
                                    style={{
                                      width: '100%', maxWidth: 320, background: 'transparent', border: 'none',
                                      outline: 'none', color: 'var(--text-secondary)', fontSize: 12,
                                      fontFamily: 'inherit',
                                    }}
                                  />
                                </td>
                              </tr>
                            </>
                          )}
                        </React.Fragment>
                      )
                    })}

                    <tr style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: cellPad }} />
                      <td colSpan={cols.length + 2} style={{ padding: cellPad }}>
                        {adding === g.status ? (
                          <input
                            autoFocus value={draft} placeholder="Task name, then Enter"
                            onChange={e => setDraft(e.target.value)}
                            onBlur={() => { setAdding(null); setDraft('') }}
                            onKeyDown={e => {
                              if (e.key === 'Escape') { setAdding(null); setDraft('') }
                              if (e.key === 'Enter' && draft.trim()) {
                                p.onCreate(draft.trim(), g.status)
                                setDraft(''); setAdding(null)
                              }
                            }}
                            style={{
                              width: '100%', maxWidth: 360, background: 'transparent',
                              border: 'none', outline: 'none', color: 'var(--text-primary)',
                              fontSize: 12.5, fontFamily: 'inherit',
                            }}
                          />
                        ) : (
                          <button
                            onClick={() => { setAdding(g.status); setDraft('') }}
                            style={{
                              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                              color: 'var(--text-tertiary)', fontSize: 12,
                              display: 'inline-flex', alignItems: 'center', gap: 5,
                              minHeight: isMobile ? 44 : 20,
                            }}
                          ><Plus size={12} /> Add</button>
                        )}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}

      {linkingSub && (
        <SessionPicker
          multiple={false}
          onPick={ids => {
            const first = ids[0]
            if (first) p.onPatchSubtask(linkingSub.task, linkingSub.sub, { sessionId: first })
          }}
          onClose={() => setLinkingSub(null)}
        />
      )}

      {selected.size > 0 && (
        // Monday's batch bar: it says how many, and it carries only the verbs that make sense on
        // many rows at once. Renaming many is not one of them.
        <div style={{
          position: 'fixed', left: '50%', transform: 'translateX(-50%)',
          bottom: isMobile ? 'calc(var(--mobile-nav-h) + 12px)' : 20, zIndex: 50,
          ...surface, background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-elevated)',
          padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          maxWidth: 'min(92vw, 620px)',
        }}>
          <span style={{ ...numeric, fontSize: 13, color: 'var(--text-primary)' }}>
            {selected.size}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>selected</span>
          <span style={{ width: 1, height: 18, background: 'var(--border)' }} />
          {COLUMN_ORDER.map(st => {
            const c = STATUS[st]
            return (
              <button
                key={st}
                onClick={() => { p.onBatchStatus([...selected], st); setSelected(new Set()) }}
                style={{
                  padding: '3px 8px', borderRadius: 5, fontSize: 10.5, cursor: 'pointer',
                  background: c.dim, color: c.color, border: `1px solid ${c.color}`,
                  minHeight: isMobile ? 34 : 24,
                }}
              >{c.label}</button>
            )
          })}
          <button
            onClick={() => {
              if (confirm(`Delete ${selected.size} task(s)? Their sessions are kept.`)) {
                p.onBatchDelete([...selected]); setSelected(new Set())
              }
            }}
            style={{ ...button(isMobile), color: 'var(--accent-red)', height: isMobile ? 34 : 26 }}
          ><Trash2 size={13} /></button>
          <button
            onClick={() => setSelected(new Set())}
            style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'inline-flex' }}
          ><X size={14} /></button>
        </div>
      )}
    </div>
  )
}
