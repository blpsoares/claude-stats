/**
 * NewTaskWizard — creating a task asks the one question that decides whether it will ever be
 * measurable: WHERE is this work happening.
 *
 * A task with no session attached carries no cost, no rounds and no harness — it is a note. So the
 * wizard offers, in order:
 *
 *  1. **Link a live session.** The repository and the project are then READ from that session
 *     rather than typed: the machine already knows where the work is, and asking a person for a
 *     fact it holds is how a field gets left blank.
 *  2. **Start one.** Falls through to the session wizard that already exists — a second "new
 *     session" form would be a second set of spawn rules, which is the duplication this repo is
 *     built against.
 *  3. **Neither, for now.** Explicitly offered rather than implied by skipping, and the screen SAYS
 *     what it costs: an unattached task shows N/A everywhere until something is filed under it.
 */

import { useMemo, useState } from 'react'
import { Link2, Plus, Terminal, X } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useFleet } from '../../lib/fleet'
import { SESSION_STATE, button, field, harnessColor, microLabel, pill, surface } from './board'
import { attachSession, createTask } from '../../lib/tasks'

export interface NewTaskWizardProps {
  onDone: (taskId: string) => void | Promise<void>
  onClose: () => void
  /** Opens the existing session wizard. The task is created first and handed over. */
  onCreateSession: (taskId: string, title: string) => void
}

export function NewTaskWizard({ onDone, onClose, onCreateSession }: NewTaskWizardProps) {
  const isMobile = useIsMobile()
  const { fleet } = useFleet('en')
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * Only sessions that are ALIVE. A `lost` or finished row can be filed under a task from the board
   * later; offering it here, under "link a live session", would be answering a different question
   * from the one asked.
   */
  const live = useMemo(
    () => (fleet.sessions ?? []).filter(s => s.state === 'working' || s.state === 'waiting' || s.state === 'waiting-approval'),
    [fleet.sessions],
  )

  const make = async (then: 'done' | 'session' | 'attach') => {
    if (!title.trim() || busy) return
    setBusy(true)
    const task = await createTask(title.trim(), detail.trim() || undefined)
    if (!task) { setBusy(false); return }
    // The repo and project are inherited server-side from the session — see `attachSession`.
    if (then === 'attach' && picked) await attachSession(task.id, picked)
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

  return (
    <div style={{ ...surface, padding: 14, display: 'grid', gap: 12, background: 'var(--bg-elevated)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={microLabel}>New task</span>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}>
          <X size={15} />
        </button>
      </div>

      <input
        autoFocus style={field(isMobile)} value={title} placeholder="Title"
        onChange={e => setTitle(e.target.value)}
      />
      <input
        style={field(isMobile)} value={detail} placeholder="Description (optional)"
        onChange={e => setDetail(e.target.value)}
      />

      <div style={{ display: 'grid', gap: 6 }}>
        <span style={microLabel}>Link a running session?</span>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: -3 }}>
          Its repository and project come with it — you do not have to type them.
        </span>
        {live.length === 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '4px 2px' }}>
            Nothing is running right now.
          </div>
        )}
        <div style={{ display: 'grid', gap: 3, maxHeight: 190, overflowY: 'auto' }}>
          {live.map(s => {
            const st = SESSION_STATE[s.state]
            const on = picked === s.id
            return (
              <button
                key={s.id}
                onClick={() => setPicked(on ? null : s.id)}
                style={{
                  ...row,
                  border: `1px solid ${on ? 'var(--anthropic-orange)' : 'var(--border)'}`,
                  background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
                }}
              >
                <Terminal size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.title}
                </span>
                <span style={pill(harnessColor(s.harness))}>{s.harness}</span>
                {st && <span style={pill(st.color)}>{st.label}</span>}
              </button>
            )
          })}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {picked
          ? (
            <button style={button(isMobile, 'primary')} disabled={!title.trim() || busy} onClick={() => void make('attach')}>
              <Link2 size={14} /> Create and link
            </button>
          )
          : (
            <>
              <button style={button(isMobile, 'primary')} disabled={!title.trim() || busy} onClick={() => void make('session')}>
                <Plus size={14} /> Create and start a session
              </button>
              <button style={button(isMobile)} disabled={!title.trim() || busy} onClick={() => void make('done')}>
                Create empty
              </button>
            </>
          )}
      </div>

      {!picked && (
        // Said rather than implied: an unattached task is a note until something is filed under it,
        // and every metric on it reads N/A. Better to know now than to wonder at the board.
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          A task with no session has no cost, no rounds and no harness — it will read N/A until you
          file work under it.
        </div>
      )}
    </div>
  )
}
