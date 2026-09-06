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

import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft, BarChart3, CheckCircle2, ClipboardList, Download, ExternalLink, FileText, Link2,
  LayoutGrid, MessageSquare, Paperclip, Pencil, Plus, Rows3, Search, Trash2, XCircle,
} from 'lucide-react'
import { useIsMobile } from '../hooks/useIsMobile'
import { useFleet } from '../lib/fleet'
import { sessionPath } from '../lib/sessionRoute'
import { BoardView, TableView } from '../components/tasks/TaskBoard'
import { BoardOverviewView } from '../components/tasks/BoardOverviewView'
import { NewTaskWizard } from '../components/tasks/NewTaskWizard'
import { NewSessionModal } from '../components/sessions/NewSessionModal'
import {
  COLUMN_ORDER, NA, SESSION_STATE, STATUS, button, field, fmtBytes, fmtInt, fmtTokens, fmtUSD,
  harnessColor, microLabel, numeric, pill, surface, type BoardStatus,
} from '../components/tasks/board'
import {
  addComment, addLink, addSubtask, createTask, deleteFile, deleteTask, editComment, fileUrl,
  fmtDuration, markTask, removeComment, removeLink,
  setBlockedBy, setSubtaskDone, uploadFile, useTaskDetail, useTaskList,
  type AttemptRollup, type AttemptView, type TaskDetail, type TaskListRow, type TasksError,
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

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  const absent = value === NA
  return (
    <div style={{ minWidth: 76 }}>
      <div style={microLabel}>{label}</div>
      <div style={{
        fontSize: 17, fontWeight: 650, fontVariantNumeric: 'tabular-nums',
        color: absent ? 'var(--text-tertiary)' : accent ? 'var(--anthropic-orange)' : 'var(--text-primary)',
      }}>{value}</div>
    </div>
  )
}

function Caveats({ r }: { r: AttemptRollup }) {
  const lines: string[] = []
  if (r.sessionsLinked < r.sessionsUsed) {
    lines.push(`cost covers ${r.sessionsLinked} of ${r.sessionsUsed} sessions — ${r.provenance.none} with no conversation link`)
  }
  if (r.costMeasuredSessions > 0 && r.costEstimatedSessions > 0) {
    lines.push(`${r.costMeasuredSessions} measured, ${r.costEstimatedSessions} estimated`)
  }
  if (r.mixedCurrency) lines.push('mixes dollars and Copilot credits — there is no single total')
  if (lines.length === 0) return null
  return (
    <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
      {lines.map(l => <div key={l}>{l}</div>)}
    </div>
  )
}

function Rollup({ r }: { r: AttemptRollup }) {
  const money = r.mixedCurrency || (r.credits !== null && r.costUSD === null)
    ? `${r.credits!.premiumRequests} req`
    : fmtUSD(r.costUSD)
  return (
    <>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
        <Stat label="Cost" value={money} accent />
        <Stat label="Rounds" value={fmtInt(r.rounds)} />
        <Stat label="Sessions" value={String(r.sessionsUsed)} />
        <Stat label="Tokens" value={fmtTokens(r.tokens)} />
        <Stat label="Active" value={r.activeMinutes === null ? NA : `${r.activeMinutes}m`} />
      </div>
      <Caveats r={r} />
    </>
  )
}

// ------------------------------------------------------------------------------- list

function TaskList() {
  const { rows, overview, error, reload } = useTaskList()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  // Metrics FIRST. The kanban answers "which column is full"; this answers "what is it costing me",
  // which is the question the product exists for.
  const [view, setView] = useState<'overview' | 'board' | 'table'>('overview')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  /** The task whose session wizard is up — see `onCreateSession`. */
  const [starting, setStarting] = useState<{ taskId: string; title: string } | null>(null)

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
    <div style={{ padding: isMobile ? 12 : 18, display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h1 style={{ fontSize: 19, margin: 0, fontWeight: 650 }}>Deliveries</h1>
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
          lang="en"
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

      {view === 'overview' && overview && <BoardOverviewView o={overview} />}

      {view !== 'overview' && rows !== null && shown.length === 0 && (
        <EmptyNotice error={rows.length > 0 ? null : error} />
      )}
      {view === 'board' && shown.length > 0 && (
        <BoardView rows={shown} onOpen={id => navigate(`/tasks/${encodeURIComponent(id)}`)} />
      )}
      {view === 'table' && shown.length > 0 && (
        <TableView rows={shown} onOpen={id => navigate(`/tasks/${encodeURIComponent(id)}`)} />
      )}
    </div>
  )
}

// ----------------------------------------------------------------------------- detail

function Bar({ label, value, of, color }: { label: string; value: number | null; of: number; color: string }) {
  const pct = value === null || of === 0 ? 0 : Math.round((value / of) * 100)
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ ...numeric, fontSize: 11.5, flexShrink: 0 }}>{fmtTokens(value)}</span>
      </div>
      <div style={{ height: 5, borderRadius: 3, background: 'var(--bg-elevated)' }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: color }} />
      </div>
    </div>
  )
}

function AttemptCard({ a }: { a: AttemptView }) {
  const cfg = a.config
    ? [a.config.model, a.config.effort, a.config.method].filter(Boolean).join(' · ')
    : ''
  return (
    <div style={{ ...surface, padding: 13, minWidth: 0, display: 'grid', gap: 9 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{a.label}</span>
        {a.config && <span style={pill(harnessColor(a.config.harness))}>{a.config.harness}</span>}
        <span style={pill()}>{a.status}</span>
      </div>
      {cfg && <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{cfg}</div>}
      <Rollup r={a.rollup} />
    </div>
  )
}

/** Links out — a PR, an issue, a doc. Only http(s) reaches here; the server refuses the rest. */
function LinksPanel({ id, task, onChanged }: {
  id: string
  task: TaskListRow['task']
  onChanged: () => Promise<void> | void
}) {
  const isMobile = useIsMobile()
  const [url, setUrl] = useState('')
  const links = task.links ?? []
  const add = async () => {
    if (!url.trim()) return
    // A GitHub PR/issue URL names its own kind — nobody should have to say it twice.
    const kind = /\/pull\/\d+/.test(url) ? 'pr' : /\/issues\/\d+/.test(url) ? 'issue' : undefined
    await addLink(id, url.trim(), undefined, kind)
    setUrl('')
    await onChanged()
  }
  return (
    <div style={{ ...surface, padding: 14, display: 'grid', gap: 9 }}>
      <div style={microLabel}>Links</div>
      {links.length === 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>No PR or document linked.</div>
      )}
      {links.map(l => (
        <div key={l.id} style={{ display: 'flex', gap: 7, alignItems: 'center', minHeight: isMobile ? 34 : 22 }}>
          <Link2 size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
          <a
            href={l.url} target="_blank" rel="noreferrer"
            style={{
              fontSize: 11.5, color: 'var(--anthropic-orange)', textDecoration: 'none',
              flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >{l.label ?? l.url.replace(/^https?:\/\//, '')}</a>
          {l.kind && <span style={pill()}>{l.kind}</span>}
          <button
            onClick={() => void removeLink(id, l.id).then(onChanged)}
            style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}
            title="Remove"
          ><XCircle size={13} /></button>
        </div>
      ))}
      <input
        style={field(isMobile)} value={url} placeholder="Paste a PR or doc URL, then Enter"
        onChange={e => setUrl(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') void add() }}
      />
    </div>
  )
}

/**
 * The blockers, Jira's "is blocked by".
 *
 * A blocker that is already closed is struck through rather than removed: the record of what held
 * the work up is part of the delivery's story, and silently dropping it rewrites that story.
 */
function BlockedBy({ id, task, onChanged }: {
  id: string
  task: TaskListRow['task']
  onChanged: () => Promise<void> | void
}) {
  const isMobile = useIsMobile()
  const { rows } = useTaskList()
  const [picking, setPicking] = useState(false)
  const blockers = (task.blockedBy ?? [])
    .map(bid => rows?.find(r => r.task.id === bid))
    .filter((r): r is TaskListRow => r !== undefined)
  const openBlockers = blockers.filter(b => b.task.status !== 'done' && b.task.status !== 'abandoned')

  const set = async (ids: string[]) => { await setBlockedBy(id, ids); await onChanged() }

  return (
    <div style={{ ...surface, padding: 14, display: 'grid', gap: 9 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={microLabel}>Blocked by</span>
        {openBlockers.length > 0 && (
          <span style={pill('var(--accent-red)')}>{openBlockers.length} open</span>
        )}
      </div>
      {blockers.length === 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>Nothing is blocking this.</div>
      )}
      {blockers.map(b => {
        const closed = b.task.status === 'done' || b.task.status === 'abandoned'
        return (
          <div key={b.task.id} style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: isMobile ? 34 : 22 }}>
            <span style={{
              fontSize: 11.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textDecoration: closed ? 'line-through' : 'none',
              color: closed ? 'var(--text-tertiary)' : 'var(--text-secondary)',
            }}>{b.task.title}</span>
            <span style={pill(STATUS[b.task.status as BoardStatus]?.color)}>
              {STATUS[b.task.status as BoardStatus]?.label ?? b.task.status}
            </span>
            <button
              onClick={() => void set((task.blockedBy ?? []).filter(x => x !== b.task.id))}
              style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}
              title="Remove"
            ><XCircle size={13} /></button>
          </div>
        )
      })}
      {picking
        ? (
          <select
            autoFocus style={field(isMobile)} defaultValue=""
            onChange={e => {
              const v = e.target.value
              if (v) void set([...(task.blockedBy ?? []), v])
              setPicking(false)
            }}
          >
            <option value="">Pick a task…</option>
            {(rows ?? [])
              // A task never blocks itself, and one already listed is not offered twice.
              .filter(r => r.task.id !== id && !(task.blockedBy ?? []).includes(r.task.id))
              .map(r => <option key={r.task.id} value={r.task.id}>{r.task.title}</option>)}
          </select>
        )
        : (
          <button style={{ ...button(isMobile), justifySelf: 'start' }} onClick={() => setPicking(true)}>
            <Plus size={13} /> Add blocker
          </button>
        )}
    </div>
  )
}

/**
 * The task's sessions, joined against the LIVE fleet.
 *
 * The join happens here rather than on the server because the fleet is a 5s refcounted poll every
 * surface already shares: asking the task route to embed it would give the board a second, slower
 * copy of the same truth, and the two would disagree by a poll interval — which people report as
 * flicker. A row the fleet does not carry keeps its stored facts and says the state is unknown,
 * rather than claiming it finished.
 */
function SessionsTab({ detail }: { detail: TaskDetail }) {
  const { fleet } = useFleet('en')
  const live = useMemo(
    () => new Map((fleet.sessions ?? []).map(r => [r.id, r])),
    [fleet.sessions],
  )
  if (detail.sessions.length === 0) {
    return (
      <div style={{ ...surface, padding: 14, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
        No session is filed under this task yet.
      </div>
    )
  }
  return (
    <div style={{ ...surface, overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 680 }}>
        <thead>
          <tr>{['Session', 'State', 'Harness', 'Where', 'Rounds', 'Tokens', 'Cost', ''].map((h, i) => (
            <th key={i} style={{ ...microLabel, textAlign: 'left', padding: '8px 10px', fontWeight: 600 }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {detail.sessions.map(row => {
            const l = live.get(row.id)
            const st = l ? SESSION_STATE[l.state] : undefined
            return (
              <tr key={row.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '8px 10px', fontSize: 12.5, color: 'var(--text-primary)' }}>
                  {l?.title ?? row.label ?? row.id}
                </td>
                <td style={{ padding: '8px 10px' }}>
                  {st
                    ? <span style={pill(st.color)}>{st.label}</span>
                    // The fleet does not carry it: that is "we cannot see it now", not "it finished".
                    : <span style={pill()}>{row.endedAt ? 'finished' : 'not in fleet'}</span>}
                </td>
                <td style={{ padding: '8px 10px' }}><span style={pill(harnessColor(row.harness))}>{row.harness}</span></td>
                <td style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-tertiary)' }}>
                  {row.cwd.split('/').slice(-2).join('/')}
                </td>
                <td style={{ padding: '8px 10px', ...numeric }}>{fmtInt(row.rounds)}</td>
                <td style={{ padding: '8px 10px', ...numeric }}>{fmtTokens(row.tokens)}</td>
                <td style={{ padding: '8px 10px', ...numeric }}>{fmtUSD(row.costUSD)}</td>
                <td style={{ padding: '8px 10px' }}>
                  <a
                    href={sessionPath(row.id)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5,
                      color: 'var(--anthropic-orange)', textDecoration: 'none', whiteSpace: 'nowrap',
                    }}
                  >Open <ExternalLink size={12} /></a>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The comment thread.
 *
 * A comment can be corrected and it can be withdrawn — a board where a wrong note is permanent is
 * one people stop writing on. The EDIT changes the body only: `author` and `createdAt` are the
 * record of who said it and when, and rewriting either would turn a correction into a forgery.
 */
function CommentsTab({ id, detail, onChanged }: {
  id: string
  detail: TaskDetail
  onChanged: () => Promise<void> | void
}) {
  const isMobile = useIsMobile()
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); await fn(); await onChanged(); setBusy(false)
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {detail.comments.length === 0 && (
        <div style={{ ...surface, padding: 14, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          Nothing said yet. Assistants can write here too, over the API.
        </div>
      )}
      {detail.comments.map(c => {
        const mine = editing?.id === c.id
        return (
          <div key={c.id} style={{ ...surface, padding: 13 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <span style={pill('var(--accent-blue)')}>{c.author}</span>
              <span style={{ ...microLabel, textTransform: 'none', letterSpacing: 0 }}>
                {new Date(c.createdAt).toLocaleString()}
              </span>
              <span style={{ flex: 1 }} />
              {!mine && (
                <>
                  <button
                    onClick={() => setEditing({ id: c.id, body: c.body })} disabled={busy}
                    title="Edit"
                    style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}
                  ><Pencil size={13} /></button>
                  <button
                    onClick={() => { if (confirm('Delete this comment?')) void run(() => removeComment(id, c.id)) }}
                    disabled={busy} title="Delete"
                    style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}
                  ><Trash2 size={13} /></button>
                </>
              )}
            </div>
            {mine
              ? (
                <div style={{ display: 'grid', gap: 8 }}>
                  <textarea
                    autoFocus
                    style={{ ...field(isMobile), minHeight: 72, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }}
                    value={editing.body}
                    onChange={e => setEditing({ id: c.id, body: e.target.value })}
                  />
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      style={button(isMobile, 'primary')} disabled={busy || !editing.body.trim()}
                      onClick={() => void run(async () => {
                        await editComment(id, c.id, editing.body)
                        setEditing(null)
                      })}
                    >Save</button>
                    <button style={button(isMobile)} onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div>
              )
              : (
                <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', lineHeight: 1.6, color: 'var(--text-secondary)' }}>
                  {c.body}
                </div>
              )}
          </div>
        )
      })}

      <div style={{ ...surface, padding: 13, display: 'grid', gap: 9 }}>
        <textarea
          style={{ ...field(isMobile), minHeight: 76, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }}
          value={draft} placeholder="Write a comment — an assistant can too, over the API"
          onChange={e => setDraft(e.target.value)}
        />
        <button
          style={{ ...button(isMobile, 'primary'), justifySelf: 'start' }} disabled={busy || !draft.trim()}
          onClick={() => void run(async () => { await addComment(id, 'you', draft); setDraft('') })}
        >
          <MessageSquare size={14} /> Comment
        </button>
      </div>
    </div>
  )
}

type Tab = 'overview' | 'sessions' | 'comments' | 'subtasks' | 'files'

function TaskDetailView({ id }: { id: string }) {
  const { detail, error, reload } = useTaskDetail(id)
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const [tab, setTab] = useState<Tab>('overview')
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')

  if (error === 'missing') return <div style={{ padding: 18 }}><EmptyNotice error={null} /></div>
  if (error) return <div style={{ padding: 18 }}><EmptyNotice error={error} /></div>
  if (!detail) return <div style={{ padding: 18, color: 'var(--text-tertiary)', fontSize: 12.5 }}>Loading…</div>

  const run = async (fn: () => Promise<unknown>) => { setBusy(true); await fn(); await reload(); setBusy(false) }
  const s = STATUS[detail.task.status as BoardStatus] ?? STATUS.todo
  const stats = detail.stats
  const duration = fmtDuration(stats.deliveryMs)
  const topTokens = Math.max(...stats.models.map(m => m.tokens ?? 0), ...stats.harnesses.map(h => h.tokens ?? 0), 1)

  const TABS: Array<[Tab, string, number]> = [
    ['overview', 'Overview', 0],
    ['sessions', 'Sessions', detail.sessions.length],
    ['comments', 'Comments', detail.comments.length],
    ['subtasks', 'Subtasks', detail.subtasks.length],
    ['files', 'Files', detail.files.length],
  ]

  return (
    <div style={{ padding: isMobile ? 12 : 18, display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button onClick={() => navigate('/tasks')} style={{ ...button(isMobile), padding: '0 9px' }}>
          <ArrowLeft size={14} />
        </button>
        <h1 style={{ fontSize: 19, margin: 0, fontWeight: 650, flex: 1, minWidth: 150 }}>{detail.task.title}</h1>
        <span style={{
          padding: '3px 11px', borderRadius: 6, fontSize: 11,
          background: s.dim, color: s.color, border: `1px solid ${s.color}`,
        }}>{s.label}</span>
      </div>

      <div style={{
        display: 'grid', gap: 14,
        // Jira's split: the work on the left, the facts on the right. One column on a phone.
        gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 1fr) 280px',
        alignItems: 'start',
      }}>
        <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
          {detail.task.detail && (
            <div style={{ ...surface, padding: 14, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              {detail.task.detail}
            </div>
          )}

          <div style={{ display: 'flex', gap: 2, overflowX: 'auto', borderBottom: '1px solid var(--border)' }}>
            {TABS.map(([key, label, count]) => (
              <button
                key={key} onClick={() => setTab(key)}
                style={{
                  height: isMobile ? 44 : 34, padding: '0 12px', border: 'none', background: 'transparent',
                  color: tab === key ? 'var(--text-primary)' : 'var(--text-tertiary)',
                  borderBottom: `2px solid ${tab === key ? 'var(--anthropic-orange)' : 'transparent'}`,
                  cursor: 'pointer', fontSize: 12.5, fontWeight: tab === key ? 600 : 500, whiteSpace: 'nowrap',
                }}
              >
                {label}{count > 0 ? ` ${count}` : ''}
              </button>
            ))}
          </div>

          {tab === 'overview' && (
            <>
              <div style={{ ...surface, padding: 14 }}>
                <div style={{ ...microLabel, marginBottom: 9 }}>The whole delivery</div>
                <Rollup r={detail.rollup} />
              </div>
              <div style={{ display: 'grid', gap: 12, gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(230px, 1fr))' }}>
                <div style={{ ...surface, padding: 14, display: 'grid', gap: 9 }}>
                  <div style={microLabel}>Models</div>
                  {stats.models.length === 0
                    ? <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>No session reported a model.</div>
                    : stats.models.map(m => <Bar key={m.key} label={m.key} value={m.tokens} of={topTokens} color="var(--anthropic-orange)" />)}
                </div>
                <div style={{ ...surface, padding: 14, display: 'grid', gap: 9 }}>
                  <div style={microLabel}>Harnesses</div>
                  {stats.harnesses.map(h => (
                    <Bar key={h.key} label={h.key} value={h.tokens} of={topTokens} color={harnessColor(h.key)} />
                  ))}
                </div>
              </div>
              <div>
                <div style={{ ...microLabel, marginBottom: 8 }}>Attempts — one card per configuration</div>
                <div style={{ display: 'grid', gap: 12, gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(260px, 1fr))' }}>
                  {detail.attempts.map(a => <AttemptCard key={a.id ?? 'loose'} a={a} />)}
                </div>
              </div>
            </>
          )}

          {tab === 'sessions' && <SessionsTab detail={detail} />}

          {tab === 'comments' && <CommentsTab id={id} detail={detail} onChanged={reload} />}

          {tab === 'subtasks' && (
            <div style={{ ...surface, padding: 13, display: 'grid', gap: 8 }}>
              {detail.subtasks.map(t => (
                <label key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer', minHeight: isMobile ? 44 : 26 }}>
                  <input type="checkbox" checked={t.done} style={{ width: 16, height: 16, accentColor: 'var(--anthropic-orange)' }}
                    onChange={() => void run(() => setSubtaskDone(id, t.id, !t.done))} />
                  <span style={{
                    fontSize: 12.5,
                    textDecoration: t.done ? 'line-through' : 'none',
                    color: t.done ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                  }}>{t.title}</span>
                </label>
              ))}
              <input
                style={field(isMobile)} placeholder="Add a subtask and press Enter"
                onKeyDown={e => {
                  const v = (e.target as HTMLInputElement).value
                  if (e.key === 'Enter' && v.trim()) {
                    void run(() => addSubtask(id, v))
                    ;(e.target as HTMLInputElement).value = ''
                  }
                }}
              />
            </div>
          )}

          {tab === 'files' && (
            <div style={{ ...surface, padding: 13, display: 'grid', gap: 9 }}>
              {detail.files.length === 0 && (
                <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
                  No files yet. Specs, plans and notes an assistant writes belong here.
                </div>
              )}
              {detail.files.map(f => (
                <div key={f.id} style={{ display: 'flex', gap: 10, alignItems: 'center', minHeight: isMobile ? 44 : 26 }}>
                  <FileText size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                  <span style={{ fontSize: 12.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  {f.author && <span style={pill('var(--accent-blue)')}>{f.author}</span>}
                  <span style={{ ...numeric, fontSize: 11.5 }}>{fmtBytes(f.size)}</span>
                  <a href={fileUrl(f.id)} style={{ color: 'var(--text-tertiary)', display: 'flex' }} title="Download"><Download size={14} /></a>
                  <button onClick={() => void run(() => deleteFile(f.id))} disabled={busy}
                    style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }} title="Remove">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <label style={{ ...button(isMobile), justifySelf: 'start', cursor: 'pointer' }}>
                <Paperclip size={14} /> Attach a file
                <input type="file" style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) void run(() => uploadFile(id, f, 'you')) }} />
              </label>
            </div>
          )}
        </div>

        {/* The facts column — Jira's right rail. */}
        <aside style={{ display: 'grid', gap: 12, minWidth: 0 }}>
          <div style={{ ...surface, padding: 14, display: 'grid', gap: 12 }}>
            <div style={{ ...microLabel }}>Details</div>
            <div style={{ display: 'grid', gap: 10 }}>
              <Stat label="Delivery time" value={duration ?? NA} />
              {duration === null && (
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: -8 }}>still open</div>
              )}
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                <Stat label="Agent runs" value={fmtInt(stats.agentRuns)} />
                <Stat label="Commits" value={fmtInt(stats.commits)} />
              </div>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                <Stat label="Files" value={fmtInt(stats.filesModified)} />
                <Stat label="Errors" value={fmtInt(stats.toolErrors)} />
              </div>
              <Stat
                label="Lines"
                value={stats.linesAdded === null && stats.linesRemoved === null
                  ? NA : `+${stats.linesAdded ?? 0} / −${stats.linesRemoved ?? 0}`}
              />
            </div>
            {stats.tokens && (
              <div style={{ display: 'grid', gap: 6, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                <div style={microLabel}>Tokens</div>
                {([['Input', stats.tokens.input], ['Output', stats.tokens.output],
                   ['Cache read', stats.tokens.cacheRead], ['Cache write', stats.tokens.cacheWrite]] as const)
                  .map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}>
                      <span style={{ color: 'var(--text-tertiary)' }}>{k}</span>
                      <span style={numeric}>{v.toLocaleString()}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>

          <div style={{ ...surface, padding: 14, display: 'grid', gap: 9 }}>
            <div style={microLabel}>Status</div>
            {/* Every status is one click. Only `done` stamps a delivery — see `markTask`. */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {COLUMN_ORDER.map(st => {
                const on = detail.task.status === st
                const c = STATUS[st]
                return (
                  <button
                    key={st} disabled={busy || on}
                    onClick={() => void run(() => markTask(id, st))}
                    style={{
                      padding: '4px 10px', borderRadius: 6, fontSize: 11, cursor: on ? 'default' : 'pointer',
                      background: on ? c.dim : 'transparent',
                      color: on ? c.color : 'var(--text-tertiary)',
                      border: `1px solid ${on ? c.color : 'var(--border)'}`,
                      minHeight: isMobile ? 34 : 26,
                    }}
                  >{c.label}</button>
                )
              })}
            </div>
          </div>

          <LinksPanel id={id} task={detail.task} onChanged={reload} />

          <BlockedBy id={id} task={detail.task} onChanged={reload} />

          <div style={{ ...surface, padding: 14, display: 'grid', gap: 8 }}>
            <div style={microLabel}>Actions</div>
            <button style={button(isMobile)} disabled={busy} onClick={() => void run(() => markTask(id, 'done'))}>
              <CheckCircle2 size={14} /> Mark delivered
            </button>
            <button style={button(isMobile)} disabled={busy} onClick={() => void run(() => markTask(id, 'abandoned'))}>
              <XCircle size={14} /> Mark abandoned
            </button>
            <button
              style={{ ...button(isMobile), color: 'var(--accent-red)' }} disabled={busy}
              onClick={() => { if (confirm('Delete this task? Its sessions are kept.')) void run(async () => { await deleteTask(id); navigate('/tasks') }) }}
            >
              <Trash2 size={14} /> Delete task
            </button>
          </div>
        </aside>
      </div>

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
