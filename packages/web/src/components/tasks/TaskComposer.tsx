/**
 * TaskComposer — creating a task, ONCE, wherever it is asked for.
 *
 * There are four places a task gets created: the board's "New task", the session row's three-dot
 * menu, the right-click on a session card, and the session's own Tasks tab. They are the same
 * question and they used to be two different forms — a modal wizard here, a one-line "type a name"
 * there — which is how a session filed from the menu ended up with no status, no priority and
 * nothing broken out, while one created from the board got all three.
 *
 * So the FORM is this component and the CHROME is the caller's. It renders inline (the aside's tab)
 * or inside a modal (`NewTaskWizard`), and it always asks the same two questions:
 *
 *  1. **WHAT** — the title, the description, the column it starts in, how urgent, and the pieces you
 *     already know it breaks into. A task written as one line and broken up later is a task whose
 *     earliest sessions are filed under nothing.
 *  2. **WHERE THE WORK HAPPENS** — a task with no session carries no cost, no rounds and no
 *     harness; it is a note. Link the sessions already running, start a new one, or neither, said
 *     out loud with what it costs.
 *
 * When it is opened FROM a session (`session`), that session is pre-linked and stated as such —
 * the answer to step 2 is already known, and asking again would be asking a question the caller
 * just answered.
 */

import { useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Link2, ListPlus, Plus, Terminal, X } from 'lucide-react'
import { PRIORITY_ORDER, type TaskPriorityId } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useFleet } from '../../lib/fleet'
import {
  COLUMN_ORDER, PRIORITY, SESSION_STATE, STATUS, button, field, harnessColor, microLabel, pill,
  surface, type BoardStatus,
} from './board'
import { ChipSelect, statusOptions } from './ChipSelect'
import { addSubtask, attachSession, createTask, editTask, markTask } from '../../lib/tasks'

const LIVE = new Set(['working', 'waiting', 'waiting-approval'])

export interface TaskComposerProps {
  /** The session this is being created FROM. Pre-linked, and stated rather than asked about. */
  session?: { id: string; title: string; harness?: string }
  /** Called with the new task's id once everything is written. */
  onDone: (taskId: string, title: string) => void | Promise<void>
  /** Absent inline: there is nothing to close. */
  onCancel?: () => void
  /** Opens the session wizard for the new task. Absent where a session cannot be started. */
  onCreateSession?: (taskId: string, title: string) => void
  /** Inline in a panel rather than in a dialog — no step rail, tighter spacing. */
  inline?: boolean
}

export function TaskComposer(p: TaskComposerProps) {
  const isMobile = useIsMobile()
  const { fleet } = useFleet('en')
  const [step, setStep] = useState<1 | 2>(1)
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [status, setStatus] = useState<BoardStatus>('todo')
  const [priority, setPriority] = useState<TaskPriorityId>('none')
  const [subs, setSubs] = useState<string[]>([])
  const [subDraft, setSubDraft] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set(p.session ? [p.session.id] : []))
  const [busy, setBusy] = useState(false)

  /**
   * Only sessions that are ALIVE. A finished or `lost` row can be filed under a task from the board
   * later; offering it here, under "link a running session", answers a different question.
   */
  const live = useMemo(
    () => (fleet.sessions ?? []).filter(s => LIVE.has(s.state)),
    [fleet.sessions],
  )

  const ready = title.trim().length > 0

  const make = async (then: 'done' | 'session') => {
    if (!ready || busy) return
    setBusy(true)
    const task = await createTask(title.trim(), detail.trim() || undefined)
    if (!task) { setBusy(false); return }
    // Created first, then shaped: `createTask` takes a title and a description and nothing else, so
    // the rest is applied to the record it returns rather than invented into its signature.
    // Sequential on purpose — every one of these read-modify-writes the same store.
    if (status !== 'todo') await markTask(task.id, status)
    if (priority !== 'none') await editTask(task.id, { priority })
    for (const s of subs) await addSubtask(task.id, s)
    // The repo and project are inherited server-side from the session — see `attachSession`.
    for (const id of picked) await attachSession(task.id, id)
    setBusy(false)
    if (then === 'session' && p.onCreateSession) { p.onCreateSession(task.id, task.title); return }
    await p.onDone(task.id, task.title)
  }

  const row: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
    padding: '8px 10px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
    background: 'transparent', color: 'var(--text-primary)', fontSize: 12.5,
    minHeight: isMobile ? 44 : 32,
  }

  const stepDot = (n: 1 | 2, label: string) => (
    <button
      onClick={() => { if (n === 1 || ready) setStep(n) }}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none',
        padding: 0, cursor: n === 1 || ready ? 'pointer' : 'default',
        color: step === n ? 'var(--text-primary)' : 'var(--text-tertiary)',
        fontSize: 11.5, fontWeight: step === n ? 650 : 500,
        minHeight: isMobile ? 44 : 24,
      }}
    >
      <span style={{
        width: 18, height: 18, borderRadius: 9, display: 'inline-flex',
        alignItems: 'center', justifyContent: 'center', fontSize: 10,
        background: step === n ? 'var(--anthropic-orange)' : 'var(--bg-elevated)',
        color: step === n ? '#fff' : 'var(--text-tertiary)',
        border: `1px solid ${step === n ? 'var(--anthropic-orange)' : 'var(--border)'}`,
      }}>{n}</span>
      {label}
    </button>
  )

  return (
    <div style={{ display: 'grid', gap: p.inline ? 11 : 13, alignContent: 'start', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {stepDot(1, 'What')}
        <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        {stepDot(2, p.session ? 'Session' : 'Where the work happens')}
      </div>

      {step === 1 && (
        <>
          <input
            autoFocus={!isMobile} style={field(isMobile)} value={title} placeholder="Title"
            onChange={e => setTitle(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && ready) setStep(2) }}
          />
          <textarea
            style={{ ...field(isMobile), minHeight: 68, resize: 'vertical', lineHeight: 1.6 }}
            value={detail} placeholder="What has to be true when this is done? (optional)"
            onChange={e => setDetail(e.target.value)}
          />

          {/* Two SELECTS, not two grids of chips — the same control the board and the rail use. */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 130px', display: 'grid', gap: 5, minWidth: 0 }}>
              <span style={{ ...microLabel, fontSize: 9 }}>Starts in</span>
              <ChipSelect
                value={status}
                options={statusOptions(STATUS, COLUMN_ORDER)}
                onPick={v => setStatus(v as BoardStatus)}
              />
            </div>
            <div style={{ flex: '1 1 130px', display: 'grid', gap: 5, minWidth: 0 }}>
              <span style={{ ...microLabel, fontSize: 9 }}>Priority</span>
              <ChipSelect
                value={priority}
                options={PRIORITY_ORDER.map(id => ({
                  value: id, label: PRIORITY[id]!.label,
                  color: PRIORITY[id]!.color, dim: PRIORITY[id]!.dim,
                }))}
                onPick={v => setPriority(v as TaskPriorityId)}
              />
            </div>
          </div>

          <div style={{ display: 'grid', gap: 6 }}>
            <span style={{ ...microLabel, fontSize: 9 }}>Break it up (optional)</span>
            {subs.map((t, i) => (
              <div key={i} style={{ ...row, border: '1px solid var(--border)' }}>
                <ListPlus size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t}
                </span>
                <button
                  onClick={() => setSubs(v => v.filter((_, j) => j !== i))}
                  aria-label="Remove"
                  style={{
                    background: 'none', border: 'none', color: 'var(--text-tertiary)',
                    cursor: 'pointer', display: 'flex', alignItems: 'center',
                    ...(isMobile ? { minWidth: 44, minHeight: 44, justifyContent: 'center' } : {}),
                  }}
                ><X size={12} /></button>
              </div>
            ))}
            <input
              style={field(isMobile)} value={subDraft} placeholder="A piece of it, then Enter"
              onChange={e => setSubDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && subDraft.trim()) {
                  setSubs(v => [...v, subDraft.trim()]); setSubDraft('')
                }
              }}
            />
          </div>
        </>
      )}

      {step === 2 && (
        <>
          {p.session && (
            // Stated, not asked: the caller opened this FROM a session, and asking which session
            // would be asking a question they just answered. It can still be unticked below.
            <div style={{
              ...surface, background: 'var(--anthropic-orange-dim)',
              border: '1px solid var(--anthropic-orange)', padding: '9px 11px',
              display: 'flex', alignItems: 'center', gap: 8, fontSize: 12,
            }}>
              <Terminal size={13} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.session.title}
              </span>
              <span style={{ ...microLabel, fontSize: 10 }}>
                {picked.has(p.session.id) ? 'will be filed here' : 'not linked'}
              </span>
            </div>
          )}

          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ ...microLabel, fontSize: 9 }}>Link the sessions already running</span>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
              Their repository and project come with them. Pick several when one task is being
              attempted more than one way — that comparison is what the board measures.
            </span>
          </div>
          {live.length === 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
              Nothing is running right now. You can file finished conversations under this task from
              the board at any time.
            </div>
          )}
          <div style={{ display: 'grid', gap: 3, maxHeight: 210, overflowY: 'auto' }}>
            {live.map(s => {
              const st = SESSION_STATE[s.state]
              const on = picked.has(s.id)
              return (
                <button
                  key={s.id}
                  onClick={() => setPicked(v => {
                    const next = new Set(v)
                    next.has(s.id) ? next.delete(s.id) : next.add(s.id)
                    return next
                  })}
                  style={{
                    ...row,
                    border: `1px solid ${on ? 'var(--anthropic-orange)' : 'var(--border)'}`,
                    background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
                  }}
                >
                  {on
                    ? <Check size={13} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />
                    : <Terminal size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />}
                  <span style={{ flex: 1, minWidth: 0, display: 'grid' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.title}
                    </span>
                    <span style={{ ...microLabel, textTransform: 'none', letterSpacing: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.cwd.split('/').slice(-2).join('/')}
                    </span>
                  </span>
                  <span style={pill(harnessColor(s.harness))}>{s.harness}</span>
                  {st && <span style={pill(st.color)}>{st.label}</span>}
                </button>
              )
            })}
          </div>

          {picked.size === 0 && (
            // Said rather than implied: an unattached task is a note until something is filed under
            // it, and every metric on it reads N/A.
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
              A task with no session has no cost, no rounds and no harness — it will read N/A until
              you file work under it.
            </div>
          )}
        </>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {step === 2 && (
          <button style={button(isMobile)} onClick={() => setStep(1)}>
            <ArrowLeft size={14} /> Back
          </button>
        )}
        {p.onCancel && step === 1 && (
          <button style={button(isMobile)} onClick={p.onCancel}>Cancel</button>
        )}
        <span style={{ flex: 1 }} />
        {step === 1 && (
          <button style={button(isMobile, 'primary')} disabled={!ready} onClick={() => setStep(2)}>
            Next <ArrowRight size={14} />
          </button>
        )}
        {step === 2 && (
          picked.size > 0
            ? (
              <button style={button(isMobile, 'primary')} disabled={!ready || busy} onClick={() => void make('done')}>
                <Link2 size={14} /> Create and link {picked.size}
              </button>
            )
            : (
              <>
                <button style={button(isMobile)} disabled={!ready || busy} onClick={() => void make('done')}>
                  Create empty
                </button>
                {p.onCreateSession && (
                  <button style={button(isMobile, 'primary')} disabled={!ready || busy} onClick={() => void make('session')}>
                    <Plus size={14} /> Create and start a session
                  </button>
                )}
              </>
            )
        )}
      </div>
    </div>
  )
}
