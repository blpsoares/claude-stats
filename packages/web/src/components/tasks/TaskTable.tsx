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
  Rows3, SquareArrowOutUpRight, Trash2, X,
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
import { ConfirmModal } from '../../pages/settings/primitives'
import { SessionPicker } from './SessionPicker'
import { DatePicker } from '../DatePicker'
import { ChipSelect, statusOptions } from './ChipSelect'
import { StatusChip } from './StatusChip'
import { boardCopy, statusLabel, type Lang } from './copy'
import { subtaskSessions } from './SubtaskSessions'
import { PickerMenu } from './PickerMenu'
import { TaskProgressBar } from './TaskProgressBar'
import type {
  Subtask, TaskClaim, TaskDetail, TaskListRow, TaskSessionRow, TaskStatus,
} from '../../lib/tasks'

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
  { id: 'progress', label: 'Progress', width: 132, sort: 'subtasks' },
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
  ['status', 'priority', 'progress', 'claim', 'sessions', 'rounds', 'cost', 'tokens', 'harnesses']

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

function Num({ v, accent }: { v: number | null | undefined; accent?: boolean }) {
  const absent = v === null || v === undefined
  return (
    <span style={{
      ...numeric, fontSize: 12,
      color: absent ? 'var(--text-tertiary)' : accent ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
    }}>{absent ? NA : v.toLocaleString()}</span>
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
  lang: 'pt' | 'en',
): React.ReactNode {
  const r = row.rollup
  switch (col) {
    // The SAME control the delivery's own screen and the card draw — see `StatusChip`. The table
    // used to build its own option list here and the rail built another one, in another component,
    // with English labels either way.
    case 'status': return (
      <StatusChip
        compact
        value={row.task.status}
        lang={lang}
        onPick={v => onStatus(v as TaskStatus)}
      />
    )
    case 'priority': return (
      <ChipSelect
        compact
        value={row.task.priority ?? 'none'}
        options={PRIORITY_ORDER.map(id => ({
          value: id, label: PRIORITY[id]!.label, color: PRIORITY[id]!.color, dim: PRIORITY[id]!.dim,
        }))}
        onPick={v => onPriority(v as TaskPriorityId)}
      />
    )
    case 'assignee': return row.task.assignee
      ? <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{row.task.assignee}</span>
      : <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>
    case 'due': return row.task.dueDate
      ? <DueCell date={row.task.dueDate} closed={row.task.status === 'done' || row.task.status === 'abandoned'} nowMs={nowMs} />
      : <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>
    case 'claim': return <ClaimCell claim={row.task.claim} nowMs={nowMs} />
    case 'progress': return row.counts.subtasks === 0
      // Nothing to be a fraction of. An empty bar here would say "0% done" about a task nobody
      // broke up, which is a claim about the work rather than about the board.
      ? <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>—</span>
      : <TaskProgressBar done={row.counts.subtasksDone} total={row.counts.subtasks} />
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
export const subtaskColumns = (lang: Lang): string[] => {
  const c = boardCopy(lang)
  return [c.subtasks, 'Status', c.owner, c.start, c.due, c.sessions, '']
}

function SubtaskRows({
  subtasks, indent, cols, sessions, lang, onPatch, onRemove, onLinkSession, onUnfile, onOpenSession,
}: {
  subtasks: Subtask[]
  indent: number
  /** How many task columns the group's table has — the filler cell has to close the row exactly. */
  cols: number
  /** The DELIVERY's sessions. Each subtask draws the ones filed under IT — see `SubtaskSessions`. */
  sessions: readonly TaskSessionRow[]
  lang: Lang
  onPatch: (id: string, patch: Partial<Subtask>) => void
  onRemove: (id: string) => void
  onLinkSession: (subtaskId: string) => void
  onUnfile: (sessionId: string) => void
  onOpenSession?: (sessionId: string) => void
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
            <ChipSelect
              compact
              value={t.status}
              options={statusOptions(STATUS, COLUMN_ORDER)}
              onPick={v => onPatch(t.id, { status: v as TaskStatus })}
            />
          </td>
          <td style={{ padding: cellPad }}>
            <input
              value={t.assignee ?? ''} placeholder="—"
              onChange={e => onPatch(t.id, { assignee: e.target.value })}
              style={bare}
            />
          </td>
          {/* See `SubtaskTable`: one date picker in this app, and it fits its column. */}
          <td style={{ padding: cellPad }}>
            <DatePicker
              value={t.startDate ?? ''} label="" placeholder="—" lang="en"
              onChange={v => onPatch(t.id, { startDate: v })}
            />
          </td>
          <td style={{ padding: cellPad }}>
            <DatePicker
              value={t.dueDate ?? ''} label="" placeholder="—" lang="en"
              min={t.startDate || undefined}
              onChange={v => onPatch(t.id, { dueDate: v })}
            />
          </td>
          <td style={{ padding: cellPad }}>
            {subtaskSessions({
              subtaskId: t.id,
              sessions,
              lang,
              mobile: isMobile,
              onLink: onLinkSession,
              onUnfile,
              onOpen: onOpenSession,
            })}
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
  /** The reader's language. Absent = English, for a caller that has not been threaded yet. */
  lang?: 'pt' | 'en'
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
  /**
   * File a session under a SUBTASK. A delivery takes no sessions directly — the delivery is the
   * unit of delivery, the subtask the unit of work — so this verb names both, always.
   */
  onLinkSession: (ref: string, subtaskId: string, sessionId: string) => void | Promise<void>
  /** Take a session out of wherever it is filed. */
  onUnfileSession: (ref: string, sessionId: string) => void | Promise<void>
  /** Open a session's own screen. Absent renders each reference as a label. */
  onOpenSession?: (sessionId: string) => void
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
  // The board's own dialog, never `window.confirm` — see the note on the detail page's delete.
  const [confirmBatch, setConfirmBatch] = useState(false)

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

  // In the CHOSEN order, not the canonical one — see the chooser's note.
  const visible = groupsShown
    .map(st => groups.find(g => g.status === st))
    .filter((g): g is typeof groups[number] => g !== undefined)

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {/* The chooser bar. Groups first: it decides what is on the screen at all, and the columns
          only decide what each row says. Both are the app's own multi-select popover — fixed, in a
          portal, clamped — because a menu that opens inside a scrolling table is clipped by it. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
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
        <PickerMenu
          title="Show groups"
          triggerStyle={{ ...button(isMobile), height: isMobile ? 44 : 28 }}
          items={groups.map(g => ({
            value: g.status,
            // The SAME word the chip in every row of this group prints — one vocabulary, one
            // language. The heading used to read the English constant while the cell beside it
            // was translated.
            label: statusLabel(g.status, p.lang ?? 'en'),
            color: STATUS[g.status].color,
            // The count of a HIDDEN group too — "hidden" must not read as "empty".
            hint: String(g.rows.length),
          }))}
          value={groupsShown}
          // The picked ORDER is kept, not re-canonicalised: the board and the table share this
          // field, and the board draws its columns in it — forcing `COLUMN_ORDER` here would undo
          // a reorder made one screen away.
          onChange={next => setGroups(next as BoardStatus[])}
          // ORDERABLE, exactly like the columns beside it. The order was always honoured (`visible`
          // walks `groupsShown`, not `COLUMN_ORDER`) and the only way to change it was to untick
          // every group and tick them back in the order you wanted — a sequence with no control.
          orderable
          note="Drag a ticked group, or use ▲▼, to reorder the bands. A hidden group's tasks are still there."
        >
          <Rows3 size={13} /> Groups
        </PickerMenu>
        <PickerMenu
          title="Columns"
          width={270}
          orderable
          triggerStyle={{ ...button(isMobile), height: isMobile ? 44 : 28 }}
          items={COLUMNS.map(c => ({ value: c.id, label: c.label }))}
          value={shown}
          onChange={next => setColumns(next as ColumnId[])}
          note="Drag a ticked column, or use ▲▼, to reorder it — the table follows this order."
        >
          <Columns3 size={13} /> Columns
        </PickerMenu>
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
              {/* The reader's word, not the constant — the picker one control away already said
                  `Em andamento` over the very band this heading called `In progress`. */}
              <span style={{ fontSize: 12.5, fontWeight: 700, color: s.color }}>
                {statusLabel(g.status, p.lang ?? 'en')}
              </span>
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
                            style={{ borderTop: '1px solid var(--border)' }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-card-hover)' }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                          >
                            <td style={{ padding: cellPad }}>
                              <input
                                type="checkbox" checked={selected.has(row.task.id)}
                                onChange={() => toggleIn(selected, row.task.id, setSelected)}
                                style={{
                                  width: isMobile ? 20 : 14, height: isMobile ? 20 : 14,
                                  accentColor: 'var(--anthropic-orange)',
                                }}
                              />
                            </td>
                            {/*
                              * The NAME opens the subitems; a button opens the task.
                              *
                              * The row used to navigate away on any click, which made the title the
                              * one thing you could not press to look INSIDE the row — and made
                              * every stray click on a cell leave the board. Monday's rule, and the
                              * right one: the name belongs to the row, the arrow leaves it.
                              */}
                            <td style={{ padding: cellPad }}>
                              <button
                                onClick={() => {
                                  toggleIn(expanded, row.task.id, setExpanded)
                                  if (!open) p.onExpand(row.task.id)
                                }}
                                title={open ? 'Hide the subtasks' : 'Show the subtasks'}
                                style={{
                                  display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0,
                                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                                  textAlign: 'left', width: '100%',
                                  ...tap(isMobile),
                                }}
                              >
                                <span style={{ color: 'var(--text-tertiary)', display: 'inline-flex', flexShrink: 0 }}>
                                  {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                                </span>
                                <span style={{
                                  fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)',
                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                }}>
                                  {row.task.title}
                                </span>
                              </button>
                            </td>
                            {cols.map(c => (
                              <td
                                key={c.id}
                                style={{ padding: cellPad, textAlign: c.numeric ? 'right' : 'left' }}
                              >
                                {cellFor(
                                  c.id, row,
                                  st => p.onStatus(row.task.id, st),
                                  pr => p.onPriority?.(row.task.id, pr),
                                  nowMs,
                                  p.lang ?? 'en',
                                )}
                              </td>
                            ))}
                            <td style={{ padding: cellPad, textAlign: 'right', whiteSpace: 'nowrap' }}>
                              <button
                                onClick={() => p.onOpen(row.task.id)} title="Open this task"
                                style={{
                                  background: 'none', border: 'none', color: 'var(--text-tertiary)',
                                  cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
                                  ...tap(isMobile),
                                }}
                              ><SquareArrowOutUpRight size={13} /></button>
                            </td>
                          </tr>

                          {open && (
                            <>
                              <tr style={{ background: 'var(--bg-surface)' }}>
                                <td style={{ padding: '5px 10px' }} />
                                {subtaskColumns(p.lang ?? 'en').map((h, i) => (
                                  <td key={i} style={{ ...microLabel, padding: '5px 10px', paddingLeft: i === 0 ? 34 : 10 }}>
                                    {h}
                                  </td>
                                ))}
                                {cols.length > 5 && <td colSpan={cols.length - 5} />}
                              </tr>
                              <SubtaskRows
                                subtasks={subs} indent={34} cols={cols.length}
                                sessions={detail?.sessions ?? []}
                                lang={p.lang ?? 'en'}
                                onPatch={(id, patch) => p.onPatchSubtask(row.task.id, id, patch)}
                                onRemove={id => p.onRemoveSubtask(row.task.id, id)}
                                onLinkSession={sub => setLinkingSub({ task: row.task.id, sub })}
                                onUnfile={sid => p.onUnfileSession(row.task.id, sid)}
                                onOpenSession={p.onOpenSession}
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

      <ConfirmModal
        open={confirmBatch}
        title={`Delete ${selected.size} task${selected.size === 1 ? '' : 's'}?`}
        message="Their comments, subtasks, files and links go with them. The SESSIONS filed under them are kept — deleting a board entry never deletes work."
        confirmLabel={`Delete ${selected.size}`}
        cancelLabel="Keep them"
        // Typing the count is the guard against a muscle-memory delete of a whole selection: the
        // one gesture on this board that can take many rows at once.
        requireText={selected.size > 1 ? String(selected.size) : undefined}
        requireTextHint={selected.size > 1 ? `Type ${selected.size} to confirm` : undefined}
        onCancel={() => setConfirmBatch(false)}
        onConfirm={() => {
          setConfirmBatch(false)
          p.onBatchDelete([...selected])
          setSelected(new Set())
        }}
      />

      {linkingSub && (
        <SessionPicker
          // A subtask holds any number of sessions, so the picker is MULTIPLE and the attaches are
          // sequential — each one read-modify-writes the same store.
          onPick={async ids => {
            for (const id of ids) await p.onLinkSession(linkingSub.task, linkingSub.sub, id)
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
          {/* One SELECT, not seven buttons: the bar is the same act as the row's status cell, and
              two shapes for one act is two things to learn. `__none__` is the resting label — the
              control has no current value, it only sets one. */}
          <span style={{ minWidth: 150 }}>
            <ChipSelect
              value="__none__"
              options={[
                { value: '__none__', label: 'Move to…', color: 'var(--text-secondary)', dim: 'var(--bg-elevated)' },
                ...statusOptions(STATUS, COLUMN_ORDER),
              ]}
              onPick={v => {
                if (v === '__none__') return
                p.onBatchStatus([...selected], v as TaskStatus)
                setSelected(new Set())
              }}
            />
          </span>
          <button
            onClick={() => setConfirmBatch(true)}
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
