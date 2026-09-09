/**
 * TasksPage — the board.
 *
 * Two shapes, because there are two questions. BOARD answers "what is in flight" (a shape, not a
 * list). TABLE answers "which configuration was cheapest" (a comparison, and comparisons want
 * columns). The detail is a Jira-style split: the work on the left, the facts on the right.
 *
 * It computes NOTHING. Every figure arrives already decided from `/api/tasks`, resolved through the
 * same `task-rollup.ts` / `task-stats.ts` the CLI prints — a dashboard and a terminal must never
 * disagree about what a delivery cost.
 *
 * What this file owns is the honesty of the rendering: a `null` is `N/A` and never `0`, a partial
 * cost says how much of the attempt it covers, an attempt holding both dollars and Copilot credits
 * shows both and no total, and an open task shows no duration — "still running" is not "took N h".
 */

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useOutletContext, useParams } from 'react-router-dom'
import {
  ArrowLeft, BarChart3, Bot, ClipboardList, ExternalLink, FileText, Link2,
  Filter, LayoutGrid, MessageSquare, Pencil, Plus, Rows3, Search, Trash2, X, XCircle,
} from 'lucide-react'
import { PRIORITY_ORDER, type SortSpec, type TaskPriorityId } from '@agentistics/core'
import { ChevronDown } from 'lucide-react'
import { useIsMobile } from '../hooks/useIsMobile'
import type { AppContext } from '../lib/app-context'
import { useFleet } from '../lib/fleet'
import { sessionPath } from '../lib/sessionRoute'
import {
  bodyWithAttachments, looksLikeImage, parseCommentBody,
  type CommentAttachment, type CommentPart,
} from '../lib/commentBody'
import { BoardView } from '../components/tasks/TaskBoard'
import { TaskTable } from '../components/tasks/TaskTable'
import { SubtaskTable } from '../components/tasks/SubtaskTable'
import {
  readBoardPrefs, writeBoardPrefs, type BoardView as ViewId, type LaneKey,
} from '../components/tasks/boardPrefs'
import { BoardArrange } from '../components/tasks/BoardArrange'
import { DeliveryDetail } from '../components/tasks/DeliveryDetail'
import { useMoney } from '../components/tasks/money'
import { RailSection } from '../components/tasks/RailSection'
import { ConfirmModal, Select } from './settings/primitives'
import { DatePicker } from '../components/DatePicker'
import { AgentsView } from '../components/tasks/AgentsView'
import { BlockedDialog } from '../components/tasks/BlockedDialog'
import { TaskProgressBar } from '../components/tasks/TaskProgressBar'
import { BetaTag } from '../components/BetaTag'
import { StatusChip } from '../components/tasks/StatusChip'
import { boardCopy, statusLabel, type Lang } from '../components/tasks/copy'
import { TaskFiles } from '../components/tasks/TaskFiles'
import { BoardOverviewView } from '../components/tasks/BoardOverviewView'
import { NewTaskWizard } from '../components/tasks/NewTaskWizard'
import { NewSessionModal } from '../components/sessions/NewSessionModal'
import {
  COLUMN_ORDER, NA, PRIORITY, SESSION_STATE, STATUS, button, claimLeft, field, fmtInt, fmtTokens,
  harnessColor, microLabel, numeric, pill, surface, type BoardStatus,
} from '../components/tasks/board'
import {
  addComment, addLink, addSubtask, createTask, deleteFile, deleteTask, editComment, fileUrl,
  attachSession, detachSession, fmtDuration, markTask, patchSubtask, removeComment, removeLink,
  removeSubtask,
  claimTask, editTask, moveTask, setBlockedBy, uploadFile, useNextTasks, useTaskActivity,
  useTaskDetail, useTaskList,
  type AttemptRollup, type AttemptView, type TaskDetail, type TaskFieldPatch, type TaskFile,
  type TaskListRow, type TaskRecord, type TasksError, type TaskStatus,
} from '../lib/tasks'

function EmptyNotice({ error }: { error: TasksError }) {
  const text = error === 'refused'
    ? 'The task board is a local store, and this instance does not host one.'
    : error === 'down'
      ? 'The server did not answer. Nothing is claimed about your tasks either way.'
      : 'No deliveries yet. Create one above, or file sessions under one with agentop session batch.'
  return (
    <div style={{ ...surface, padding: 16, color: 'var(--text-tertiary)', display: 'flex', gap: 10, alignItems: 'center', fontSize: 12.5 }}>
      <ClipboardList size={16} /> {text}
    </div>
  )
}


// ------------------------------------------------------------------------------- list

function TaskList() {
  // The SAME filters the rest of the dashboard edits. The board is not a separate world: the date
  // range and the harness / project / repo chips scope which SESSIONS count toward each task, which
  // is what makes "what did this cost me last week" answerable.
  const { filters, lang } = useOutletContext<AppContext>()
  const { rows, overview, excluded, error, reload } = useTaskList(filters)
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  // Metrics FIRST. The kanban answers "which column is full"; this answers "what is it costing me",
  // which is the question the product exists for.
  // Restored, not re-decided: opening a task navigates away and unmounts this list, so a view that
  // resets itself on every back-press is a view nobody can stay in.
  const stored = useMemo(readBoardPrefs, [])
  const [view, setViewState] = useState<ViewId>(stored.view)
  const setView = (v: ViewId) => { setViewState(v); writeBoardPrefs({ view: v }) }
  // The kanban's arrangement, persisted with everything else the board remembers. The SORT is
  // shared with the table on purpose: a board that ranks its cards one way in the grid and another
  // in the columns is two boards, and the reader has to hold both.
  const [sort, setSortState] = useState<SortSpec>(stored.sort)
  const setSort = (v: SortSpec) => { setSortState(v); writeBoardPrefs({ sort: v }) }
  const [lanes, setLanesState] = useState<LaneKey>(stored.lanes)
  const setLanes = (v: LaneKey) => { setLanesState(v); writeBoardPrefs({ lanes: v }) }
  const [wip, setWipState] = useState<Record<string, number>>(stored.wip)
  // The visible columns, shared with the table's group chooser — `boardPrefs.groups`.
  const [boardColumns, setBoardColumnsState] = useState<BoardStatus[]>(stored.groups ?? [...COLUMN_ORDER])
  const setBoardColumns = (v: BoardStatus[]) => { setBoardColumnsState(v); writeBoardPrefs({ groups: v }) }
  /**
   * The tasks on their way to `blocked`, waiting on the dialog's answer.
   *
   * Every path that can set a status funnels through `toStatus` below — the rail, the table cell,
   * the batch bar, a drop into the Blocked column — so the question is asked ONCE, in one place,
   * rather than four times with four chances to forget one.
   */
  const [blocking, setBlocking] = useState<string[] | null>(null)
  const setWip = (v: Record<string, number>) => { setWipState(v); writeBoardPrefs({ wip: v }) }
  const { fleet } = useFleet('en')
  // The orchestration view's three reads. They poll on their own cadence — the queue changes when
  // an agent claims something, which is not when `/api/tasks` changes.
  const { next, reload: reloadNext } = useNextTasks()
  const { events, reload: reloadEvents } = useTaskActivity(undefined, 60)
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  /** The task whose session wizard is up — see `onCreateSession`. */
  const [starting, setStarting] = useState<{ taskId: string; title: string } | null>(null)
  /** Details fetched for the rows the table has expanded — subtasks live there. */
  const [details, setDetails] = useState<Map<string, TaskDetail>>(new Map())

  /** The ONE way a status is set from this page. `blocked` asks its question first. */
  const toStatus = async (ids: string[], status: TaskStatus) => {
    if (status === 'blocked') { setBlocking(ids); return }
    for (const id of ids) await markTask(id, status)
    await reload()
  }

  const refreshDetail = async (id: string) => {
    const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`)
    if (!res.ok) return
    const body = await res.json() as { task: TaskDetail }
    setDetails(m => new Map(m).set(id, body.task))
    await reload()
  }

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle || !rows) return rows ?? []
    return rows.filter(r =>
      r.task.title.toLowerCase().includes(needle)
      || (r.task.detail ?? '').toLowerCase().includes(needle))
  }, [rows, q])


  const seg = (active: boolean): React.CSSProperties => ({
    ...button(isMobile),
    height: isMobile ? 44 : 30,
    border: 'none',
    background: active ? 'var(--bg-elevated)' : 'transparent',
    color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
  })

  return (
    <div style={{
      padding: isMobile ? 12 : 18,
      paddingBottom: isMobile ? 'calc(var(--mobile-nav-h) + 24px)' : 18,
      display: 'grid', gap: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h1 style={{ fontSize: 19, margin: 0, fontWeight: 650, display: 'flex', alignItems: 'center', gap: 8 }}>
            Deliveries
            <BetaTag what="The delivery board" />
          </h1>
          <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--text-tertiary)' }}>
            What each piece of work cost, in how many rounds and across how many sessions.
          </p>
        </div>
        <div style={{ ...surface, display: 'flex', padding: 3, gap: 2 }}>
          <button style={seg(view === 'overview')} onClick={() => setView('overview')}>
            <BarChart3 size={14} /> Metrics
          </button>
          <button style={seg(view === 'board')} onClick={() => setView('board')}>
            <LayoutGrid size={14} /> Board
          </button>
          <button style={seg(view === 'agents')} onClick={() => setView('agents')}>
            <Bot size={13} /> Agents
          </button>
          <button style={seg(view === 'table')} onClick={() => setView('table')}>
            <Rows3 size={14} /> Table
          </button>
        </div>
        <button style={button(isMobile, 'primary')} onClick={() => setOpen(v => !v)}>
          <Plus size={15} /> New task
        </button>
      </div>

      {open && (
        <NewTaskWizard
          onClose={() => setOpen(false)}
          onDone={async taskId => {
            setOpen(false)
            await reload()
            navigate(`/tasks/${encodeURIComponent(taskId)}`)
          }}
          onCreateSession={(taskId, taskTitle) => {
            // The session wizard that already exists, pre-filled with the task — a second spawn
            // form would be a second set of spawn rules.
            setOpen(false)
            setStarting({ taskId, title: taskTitle })
          }}
        />
      )}

      {starting && (
        <NewSessionModal
          lang={lang}
          initialTask={starting.title}
          onClose={() => setStarting(null)}
          onStarted={async () => {
            const to = starting.taskId
            setStarting(null)
            await reload()
            navigate(`/tasks/${encodeURIComponent(to)}`)
          }}
        />
      )}

      {view !== 'overview' && (
      <div style={{ position: 'relative', maxWidth: 380 }}>
        <Search size={14} style={{ position: 'absolute', left: 11, top: isMobile ? 15 : 10, color: 'var(--text-tertiary)' }} />
        <input
          style={{ ...field(isMobile), paddingLeft: 32 }} value={q} placeholder="Search"
          onChange={e => setQ(e.target.value)}
        />
      </div>
      )}

      {rows === null && <div style={{ color: 'var(--text-tertiary)', fontSize: 12.5 }}>Loading…</div>}

      {excluded > 0 && (
        // Said, never swallowed: a rollup that silently shrank is the same defect as a confident
        // zero — the figure is smaller and nothing on screen explains why.
        <div style={{
          ...surface, padding: '8px 12px', fontSize: 11.5, color: 'var(--text-tertiary)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Filter size={13} />
          Scoped by the filters above — {excluded} session{excluded === 1 ? '' : 's'} left out of
          these numbers.
        </div>
      )}

      {view === 'overview' && overview && <BoardOverviewView o={overview} />}

      {view === 'agents' && (
        <AgentsView
          next={next}
          rows={shown}
          events={events}
          sessions={fleet.sessions}
          nowMs={nowMs}
          onOpen={id => navigate(`/tasks/${encodeURIComponent(id)}`)}
          onRelease={async id => {
            await claimTask(id, { by: 'you', release: true, force: true })
            await Promise.all([reload(), reloadNext(), reloadEvents()])
          }}
        />
      )}

      {view !== 'overview' && rows !== null && shown.length === 0 && (
        <EmptyNotice error={rows.length > 0 ? null : error} />
      )}
      {view === 'board' && shown.length > 0 && (
        <>
          <BoardArrange
            sort={sort} onSort={setSort}
            lanes={lanes} onLanes={setLanes}
            wip={wip} onWip={setWip}
            // The board and the table share ONE set of visible columns: they are the same seven
            // statuses, and letting each remember its own would mean hiding `abandoned` twice.
            columns={boardColumns}
            onColumns={setBoardColumns}
            counts={Object.fromEntries(COLUMN_ORDER.map(st => [
              st, shown.filter(r => r.task.status === st).length,
            ]))}
          />
          <BoardView
          lang={lang}
            rows={shown}
            sort={sort}
            lanes={lanes}
            wip={wip}
            columns={boardColumns}
            sessions={fleet.sessions}
            onOpen={id => navigate(`/tasks/${encodeURIComponent(id)}`)}
            onStatus={(id, status) => void toStatus([id], status)}
            onMove={async (id, index) => { await moveTask(id, index); await reload() }}
          />
        </>
      )}
      {view === 'table' && (
        <TaskTable
          rows={shown}
          lang={lang}
          details={details}
          onOpen={id => navigate(`/tasks/${encodeURIComponent(id)}`)}
          onStatus={(ref, status) => void toStatus([ref], status)}
          onPriority={async (ref, priority) => { await editTask(ref, { priority }); await reload() }}
          onCreate={async (title, status) => {
            const made = await createTask(title)
            // Created straight into the group it was typed in — the "+ Add" row of a status column
            // is a statement about where the work stands, not just where the row goes.
            if (made && status !== 'todo') await markTask(made.id, status)
            await reload()
          }}
          onExpand={async id => {
            if (details.has(id)) return
            const res = await fetch(`/api/tasks/${encodeURIComponent(id)}`)
            if (!res.ok) return
            const body = await res.json() as { task: TaskDetail }
            setDetails(m => new Map(m).set(id, body.task))
          }}
          onAddSubtask={async (ref, title) => { await addSubtask(ref, title); await refreshDetail(ref) }}
          onPatchSubtask={async (ref, sid, patch) => { await patchSubtask(ref, sid, patch); await refreshDetail(ref) }}
          onRemoveSubtask={async (ref, sid) => { await removeSubtask(ref, sid); await refreshDetail(ref) }}
          onBatchStatus={(ids, status) => void toStatus(ids, status)}
          onBatchDelete={async ids => {
            for (const id of ids) await deleteTask(id)
            await reload()
          }}
          // Filing is per SUBTASK now, so the list's verb names both and the picker lives inside
          // the expanded row — there is no delivery-level "link a session" left to open.
          onLinkSession={async (ref, subtaskId, sessionId) => {
            await attachSession(ref, sessionId, subtaskId)
            await refreshDetail(ref)
            await reload()
          }}
          onUnfileSession={async (ref, sessionId) => {
            await detachSession(ref, sessionId)
            await refreshDetail(ref)
            await reload()
          }}
          onOpenSession={sid => navigate(sessionPath(sid))}
        />
      )}

      {blocking && rows && (
        <BlockedDialog
          titles={blocking.map(id => rows.find(r => r.task.id === id)?.task.title ?? id)}
          rows={rows}
          already={blocking.length === 1
            ? rows.find(r => r.task.id === blocking[0])?.task.blockedBy ?? []
            : []}
          onCancel={() => setBlocking(null)}
          onConfirm={async ({ reason, blockedBy }) => {
            const ids = blocking
            setBlocking(null)
            for (const id of ids) await markTask(id, 'blocked', { reason, blockedBy })
            await reload()
          }}
        />
      )}

    </div>
  )
}

// ----------------------------------------------------------------------------- detail


function TaskDetailView({ id }: { id: string }) {
  const { filters, lang } = useOutletContext<AppContext>()
  const { detail, error, reload } = useTaskDetail(id, filters)
  const navigate = useNavigate()
  const isMobile = useIsMobile()

  if (error === 'missing') return <div style={{ padding: 18 }}><EmptyNotice error={null} /></div>
  if (error) return <div style={{ padding: 18 }}><EmptyNotice error={error} /></div>
  if (!detail) return <div style={{ padding: 18, color: 'var(--text-tertiary)', fontSize: 12.5 }}>Loading…</div>

  const s = STATUS[detail.task.status as BoardStatus] ?? STATUS.todo

  return (
    <div style={{
      padding: isMobile ? 12 : 18,
      // The mobile bottom nav is FIXED, so the last thing on the page sits underneath it and cannot
      // be tapped — measured: "Delete task" was intercepted by `nav.mobile-bottom-nav` at every
      // scroll position. `--mobile-nav-h` is the token that already knows how tall that chrome is,
      // safe-area inset included.
      paddingBottom: isMobile ? 'calc(var(--mobile-nav-h) + 24px)' : 18,
      display: 'grid', gap: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button onClick={() => navigate('/tasks')} style={{ ...button(isMobile), padding: '0 9px' }}>
          <ArrowLeft size={14} />
        </button>
        <div style={{ flex: 1, minWidth: 150, display: 'grid', gap: 6 }}>
          <h1 style={{ fontSize: 19, margin: 0, fontWeight: 650, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{detail.task.title}</span>
            {/* A task page is reachable from a link with no nav on screen — the caveat has to
                travel with the page, not only with the way in. */}
            <BetaTag what="The delivery board" />
          </h1>
          {/* The headline number for a broken-up task: how much of it is closed. Same arithmetic
              and same rounding as the card and the table — one bar, four places. */}
          <div style={{ maxWidth: 320 }}>
            <TaskProgressBar
              done={detail.subtasks.filter(t => t.done).length}
              total={detail.subtasks.length}
              height={5}
            />
          </div>
        </div>
        <span style={{
          padding: '3px 11px', borderRadius: 6, fontSize: 11,
          background: s.dim, color: s.color, border: `1px solid ${s.color}`,
        }}>{statusLabel(detail.task.status, lang)}</span>
      </div>

      <DeliveryDetail
        id={id}
        detail={detail}
        lang={lang}
        reload={reload}
        onDeleted={() => navigate('/tasks')}
      />

      <p style={{ margin: 0, fontSize: 11, color: 'var(--text-tertiary)' }}>
        These are cost, rounds and time. Whether the work is any good is not measured here.
      </p>

    </div>
  )
}

export default function TasksPage() {
  const { id } = useParams<{ id: string }>()
  return id ? <TaskDetailView id={id} /> : <TaskList />
}
