/**
 * TasksPage — the deliveries, and what each configuration of one cost.
 *
 * This is the ONE screen the spec sanctions as new (docs/superpowers/specs/
 * 2026-09-05-task-measurement-design.md §8): comparing attempts side by side has no home in the
 * fleet's own list, because the rows being compared are not sessions — they are configurations.
 *
 * It computes NOTHING. Every figure arrives already decided from `/api/tasks`, which resolves it
 * through the same `task-rollup.ts` the CLI prints. What this file owns is the honesty of the
 * rendering: a `null` is `N/A` and never `0`, a partial cost says how much of the attempt it
 * covers, and an attempt holding both dollars and Copilot credits shows two columns and no total.
 */

import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, CheckCircle2, ClipboardList, XCircle } from 'lucide-react'
import { useIsMobile } from '../hooks/useIsMobile'
import {
  markTask, useTaskDetail, useTaskList,
  type AttemptRollup, type AttemptView, type TasksError,
} from '../lib/tasks'

const NA = 'N/A'

const fmtInt = (n: number | null) => (n === null ? NA : n.toLocaleString())
const fmtUSD = (n: number | null) => (n === null ? NA : `$${n.toFixed(2)}`)

const card: React.CSSProperties = {
  border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-card)', padding: 16,
}

/** The empty state is chosen by WHY the list is empty — three facts, three sentences. */
function EmptyNotice({ error }: { error: TasksError }) {
  const text = error === 'refused'
    ? 'The task board is a local store, and this instance does not host one.'
    : error === 'down'
      ? 'The server did not answer. Nothing is claimed about your tasks either way.'
      : 'No deliveries yet. Start one with:  agentop session batch --task "…" --attempt "…" --session "…"'
  return (
    <div style={{ ...card, color: 'var(--text-secondary)', display: 'flex', gap: 10, alignItems: 'center' }}>
      <ClipboardList size={18} />
      <span style={{ fontSize: 13 }}>{text}</span>
    </div>
  )
}

/**
 * One metric. A `null` renders `N/A` in the muted colour — never a `0`, which reads as a
 * measurement and is the failure this whole feature is built against.
 */
function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const absent = value === NA
  return (
    <div style={{ minWidth: 96 }}>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 600, color: absent ? 'var(--text-secondary)' : 'var(--text)' }}>
        {value}
      </div>
      {hint && <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{hint}</div>}
    </div>
  )
}

/** The caveats a rollup carries, in words. Rendered wherever the numbers are. */
function Caveats({ r }: { r: AttemptRollup }) {
  const lines: string[] = []
  if (r.sessionsLinked < r.sessionsUsed) {
    lines.push(`cost covers ${r.sessionsLinked} of ${r.sessionsUsed} sessions`
      + ` — ${r.provenance.none} with no conversation link`)
  }
  if (r.costMeasuredSessions > 0 && r.costEstimatedSessions > 0) {
    lines.push(`${r.costMeasuredSessions} measured, ${r.costEstimatedSessions} estimated`)
  }
  if (r.mixedCurrency) {
    lines.push('this attempt mixes dollars and Copilot credits — there is no single total')
  }
  if (lines.length === 0) return null
  return (
    <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
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
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <Metric label="Cost" value={money} hint={r.credits !== null ? 'Copilot credits' : undefined} />
        <Metric label="Rounds" value={fmtInt(r.rounds)} />
        <Metric label="Sessions" value={String(r.sessionsUsed)} />
        <Metric label="Tokens" value={fmtInt(r.tokens)} />
        <Metric label="Active" value={r.activeMinutes === null ? NA : `${r.activeMinutes} min`} />
      </div>
      <Caveats r={r} />
    </>
  )
}

function statusPill(status: string) {
  const color = status === 'delivered' ? 'var(--accent-green, #22c55e)'
    : status === 'abandoned' ? 'var(--text-secondary)'
      : 'var(--anthropic-orange)'
  return (
    <span style={{
      fontSize: 11, padding: '2px 8px', borderRadius: 999, border: `1px solid ${color}`,
      color, textTransform: 'uppercase', letterSpacing: 0.4,
    }}>{status}</span>
  )
}

function TaskList() {
  const { rows, error } = useTaskList()
  const navigate = useNavigate()

  if (rows === null) return <div style={{ color: 'var(--text-secondary)', padding: 16 }}>Loading…</div>
  if (rows.length === 0) return <div style={{ padding: 16 }}><EmptyNotice error={error} /></div>

  return (
    <div style={{ padding: 16, display: 'grid', gap: 12 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Deliveries</h1>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
        What each piece of work cost, in how many rounds and across how many sessions.
      </p>
      {rows.map(row => (
        <button
          key={row.task.id}
          onClick={() => navigate(`/tasks/${encodeURIComponent(row.task.id)}`)}
          style={{ ...card, textAlign: 'left', cursor: 'pointer', color: 'var(--text)', width: '100%' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{row.task.title}</span>
            {statusPill(row.task.status)}
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              {row.attempts} attempt{row.attempts === 1 ? '' : 's'}
            </span>
          </div>
          <Rollup r={row.rollup} />
        </button>
      ))}
    </div>
  )
}

function AttemptCard({ a }: { a: AttemptView }) {
  const cfg = a.config
    ? [a.config.harness, a.config.model, a.config.effort, a.config.method].filter(Boolean).join(' · ')
    : ''
  return (
    <div style={{ ...card, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{a.label}</span>
        {statusPill(a.status)}
      </div>
      {cfg && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>{cfg}</div>}
      <Rollup r={a.rollup} />
    </div>
  )
}

function TaskDetailView({ id }: { id: string }) {
  const { detail, error, reload } = useTaskDetail(id)
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const [busy, setBusy] = useState(false)

  if (error === 'missing') {
    return <div style={{ padding: 16 }}><EmptyNotice error={null} /></div>
  }
  if (error) return <div style={{ padding: 16 }}><EmptyNotice error={error} /></div>
  if (!detail) return <div style={{ color: 'var(--text-secondary)', padding: 16 }}>Loading…</div>

  const mark = async (status: 'delivered' | 'abandoned') => {
    setBusy(true)
    await markTask(detail.task.id, status)
    await reload()
    setBusy(false)
  }

  const btn: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px',
    // 44px is the MOBILE number — applying it on desktop turns a button row into a toolbar.
    height: isMobile ? 44 : 32,
    borderRadius: 8, border: '1px solid var(--border)', background: 'transparent',
    color: 'var(--text)', cursor: busy ? 'wait' : 'pointer', fontSize: 13,
  }

  return (
    <div style={{ padding: 16, display: 'grid', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button onClick={() => navigate('/tasks')} style={{ ...btn, padding: '0 10px' }}>
          <ArrowLeft size={15} /> Back
        </button>
        <h1 style={{ fontSize: 20, margin: 0 }}>{detail.task.title}</h1>
        {statusPill(detail.task.status)}
      </div>

      <div style={card}>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
          The whole delivery
        </div>
        <Rollup r={detail.rollup} />
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button style={btn} disabled={busy} onClick={() => void mark('delivered')}>
          <CheckCircle2 size={15} /> Mark delivered
        </button>
        <button style={btn} disabled={busy} onClick={() => void mark('abandoned')}>
          <XCircle size={15} /> Mark abandoned
        </button>
      </div>

      <div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
          Attempts — the same work, one row per configuration
        </div>
        <div style={{
          display: 'grid', gap: 12,
          // One column on a phone; the comparison is a scroll rather than four unreadable columns.
          gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(280px, 1fr))',
        }}>
          {detail.attempts.map(a => <AttemptCard key={a.id ?? 'loose'} a={a} />)}
        </div>
      </div>

      <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>
        These are cost, rounds and time. Whether the work is any good is not measured here.
      </p>
    </div>
  )
}

export default function TasksPage() {
  const { id } = useParams<{ id: string }>()
  return id ? <TaskDetailView id={id} /> : <TaskList />
}
