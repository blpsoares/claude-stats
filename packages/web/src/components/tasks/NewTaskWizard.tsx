/**
 * NewTaskWizard — two questions, in the order that decides whether the task will ever be
 * measurable.
 *
 *  1. **WHAT** — the title, the description, the column it starts in, and the pieces you already
 *     know it breaks into. Typing the subtasks here is not decoration: a task written as one line
 *     and broken up later is a task whose earliest sessions are filed under nothing.
 *  2. **WHERE** — the work itself. A task with no session carries no cost, no rounds and no
 *     harness; it is a note. So the step offers, in order:
 *       - **Link the sessions already running.** The repository and the project are then READ from
 *         them rather than typed — the machine holds those facts, and asking a person for a fact it
 *         already has is how a field gets left blank. Several at once, because one task routinely
 *         spans a worktree per attempt, which is the whole point of measuring attempts.
 *       - **Start one.** Falls through to the session wizard that already exists — a second "new
 *         session" form would be a second set of spawn rules, the duplication this repo is built
 *         against.
 *       - **Neither, for now.** Explicitly offered rather than implied by skipping, and the screen
 *         SAYS what it costs.
 *
 * It is a DIALOG, not a block on the page: it asks a question with an answer, and the board behind
 * it must not scroll away underneath a half-filled form.
 */

import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, Check, Link2, ListPlus, Plus, Terminal, X } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useFleet } from '../../lib/fleet'
import {
  COLUMN_ORDER, SESSION_STATE, STATUS, button, field, harnessColor, microLabel, pill, surface,
  type BoardStatus,
} from './board'
import { addSubtask, attachSession, createTask, markTask } from '../../lib/tasks'

export interface NewTaskWizardProps {
  onDone: (taskId: string) => void | Promise<void>
  onClose: () => void
  /** Opens the existing session wizard. The task is created first and handed over. */
  onCreateSession: (taskId: string, title: string) => void
}

const LIVE = new Set(['working', 'waiting', 'waiting-approval'])

export function NewTaskWizard({ onDone, onClose, onCreateSession }: NewTaskWizardProps) {
  const isMobile = useIsMobile()
  const { fleet } = useFleet('en')
  const [step, setStep] = useState<1 | 2>(1)
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [status, setStatus] = useState<BoardStatus>('todo')
  const [subs, setSubs] = useState<string[]>([])
  const [subDraft, setSubDraft] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  /**
   * Only sessions that are ALIVE. A `lost` or finished row can be filed under a task from the board
   * later; offering it here, under "link a running session", would answer a different question from
   * the one asked.
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
    // the column and the pieces are applied to the record it returns rather than invented into its
    // signature. Sequential on purpose — every one of these read-modify-writes the same store.
    if (status !== 'todo') await markTask(task.id, status)
    for (const s of subs) await addSubtask(task.id, s)
    // The repo and project are inherited server-side from the session — see `attachSession`.
    for (const id of picked) await attachSession(task.id, id)
    setBusy(false)
    if (then === 'session') { onCreateSession(task.id, task.title); return }
    await onDone(task.id)
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

  return createPortal(
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 998 }} />
      <div style={{
        position: 'fixed', zIndex: 999, ...surface, background: 'var(--bg-elevated)',
        boxShadow: 'var(--shadow-elevated)',
        // Full screen on a phone: a centred fixed-width dialog is pushed off-screen by iOS Safari
        // the moment the page behind it overflows horizontally.
        ...(isMobile
          ? { inset: 0, width: '100%', height: '100%', borderRadius: 0, overflowY: 'auto' }
          : { inset: 0, margin: 'auto', width: 'min(520px, 92vw)', maxHeight: '82vh' }),
        padding: 16, display: 'grid', gridTemplateRows: 'auto auto 1fr auto', gap: 13,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={microLabel}>New task</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {stepDot(1, 'What')}
          <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          {stepDot(2, 'Where the work happens')}
        </div>

        <div style={{ display: 'grid', gap: 12, alignContent: 'start', overflowY: 'auto', minHeight: 0 }}>
          {step === 1 && (
            <>
              <input
                autoFocus style={field(isMobile)} value={title} placeholder="Title"
                onChange={e => setTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && ready) setStep(2) }}
              />
              <textarea
                style={{ ...field(isMobile), minHeight: 74, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }}
                value={detail} placeholder="What has to be true when this is done? (optional)"
                onChange={e => setDetail(e.target.value)}
              />

              <div style={{ display: 'grid', gap: 6 }}>
                <span style={microLabel}>Starts in</span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {COLUMN_ORDER.map(st => {
                    const c = STATUS[st]
                    const on = status === st
                    return (
                      <button
                        key={st} onClick={() => setStatus(st)}
                        style={{
                          padding: '4px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
                          minHeight: isMobile ? 40 : 26,
                          background: on ? c.dim : 'transparent',
                          color: on ? c.color : 'var(--text-tertiary)',
                          border: `1px solid ${on ? c.color : 'var(--border)'}`,
                        }}
                      >{c.label}</button>
                    )
                  })}
                </div>
              </div>

              <div style={{ display: 'grid', gap: 6 }}>
                <span style={microLabel}>Break it up (optional)</span>
                {subs.map((t, i) => (
                  <div key={i} style={{ ...row, border: '1px solid var(--border)' }}>
                    <ListPlus size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t}
                    </span>
                    <button
                      onClick={() => setSubs(v => v.filter((_, j) => j !== i))}
                      style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}
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
              <div style={{ display: 'grid', gap: 4 }}>
                <span style={microLabel}>Link the sessions already running</span>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                  Their repository and project come with them — you do not have to type either. Pick
                  several when one task is being attempted more than one way; that comparison is what
                  the board measures.
                </span>
              </div>
              {live.length === 0 && (
                <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '4px 2px' }}>
                  Nothing is running right now. You can file finished conversations under this task
                  from the board at any time.
                </div>
              )}
              <div style={{ display: 'grid', gap: 3 }}>
                {live.map(s => {
                  const st = SESSION_STATE[s.state]
                  const on = picked.has(s.id)
                  return (
                    <button
                      key={s.id}
                      onClick={() => setPicked(p => {
                        const next = new Set(p)
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
                // Said rather than implied: an unattached task is a note until something is filed
                // under it, and every metric on it reads N/A. Better to know now than at the board.
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                  A task with no session has no cost, no rounds and no harness — it will read N/A
                  until you file work under it.
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {step === 2 && (
            <button style={button(isMobile)} onClick={() => setStep(1)}>
              <ArrowLeft size={14} /> Back
            </button>
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
                  <button style={button(isMobile, 'primary')} disabled={!ready || busy} onClick={() => void make('session')}>
                    <Plus size={14} /> Create and start a session
                  </button>
                </>
              )
          )}
        </div>
      </div>
    </>,
    document.body,
  )
}
