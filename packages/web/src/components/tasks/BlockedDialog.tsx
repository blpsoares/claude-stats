/**
 * BlockedDialog — the question `blocked` asks before it will be recorded.
 *
 * `blocked` is the one status that names a problem somebody has to go and solve. A board of blocked
 * cards that do not say what they are waiting on is a board nobody can unblock: the fact lives only
 * in the head of whoever moved it, who by then has moved on. The orchestration queue reports these
 * as withheld, and without a reason that report is "you cannot have this" with no way forward.
 *
 * Two ways to answer, because there are two kinds of blocked:
 *  - **Another task** — a dependency the board already knows about, which is the answer that lets
 *    the card unblock ITSELF when that task closes.
 *  - **A sentence** — waiting on a person, an API key, a deploy, a decision. Not everything that
 *    blocks work is on the board, and forcing it to be would make people invent placeholder tasks.
 *
 * Either is enough, which is exactly what the server enforces — this dialog is the same rule asked
 * politely, not a second one. It never blocks the OTHER statuses.
 */

import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Search, X } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { overlayPadding } from '../../lib/mobileOverlay'
import { STATUS, button, field, microLabel, pill, surface, type BoardStatus } from './board'
import type { TaskListRow } from '../../lib/tasks'

export interface BlockedDialogProps {
  /** The tasks being blocked. More than one when it comes from the batch bar. */
  titles: string[]
  /** Everything else on the board, to pick a blocker from. */
  rows: TaskListRow[]
  /** Ids already blocking these — pre-selected, so an existing dependency answers the question. */
  already?: readonly string[]
  onCancel: () => void
  onConfirm: (o: { reason: string; blockedBy: string[] }) => void
}

export function BlockedDialog(p: BlockedDialogProps) {
  const isMobile = useIsMobile()
  const [reason, setReason] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set(p.already ?? []))
  const [q, setQ] = useState('')

  const candidates = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return p.rows
      // A closed task cannot block anything — offering one is offering an answer that is already
      // false, and `openBlockers` on the server would ignore it anyway.
      .filter(r => r.task.status !== 'done' && r.task.status !== 'abandoned')
      .filter(r => !p.titles.includes(r.task.title))
      .filter(r => !needle || r.task.title.toLowerCase().includes(needle))
      .slice(0, 40)
  }, [p.rows, p.titles, q])

  const armed = reason.trim().length > 0 || picked.size > 0

  return createPortal(
    <div
      onClick={p.onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 2000, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)',
        // The shared rule, not a bare 0: a full-screen mobile overlay that pads with zero puts its
        // own close button under the status bar, where taps do not reach it.
        padding: overlayPadding(isMobile, 16),
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          ...surface, background: 'var(--bg-card)', boxShadow: '0 12px 48px rgba(0,0,0,0.5)',
          display: 'grid', gap: 13, padding: 20,
          ...(isMobile
            ? { width: '100%', height: '100%', borderRadius: 0, overflowY: 'auto', alignContent: 'start' }
            : { width: '100%', maxWidth: 460, maxHeight: '80vh', borderRadius: 12, overflowY: 'auto' }),
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            display: 'inline-flex', padding: 8, borderRadius: 9,
            background: 'var(--accent-red-dim)', color: 'var(--accent-red)',
          }}><AlertTriangle size={17} /></span>
          <span style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>
            {p.titles.length === 1 ? 'What is it waiting on?' : `What are these ${p.titles.length} waiting on?`}
          </span>
          <button
            onClick={p.onCancel}
            aria-label="Close"
            style={{
              background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              // The glyph stays 16px; the PADDING is the thumb's target.
              ...(isMobile ? { minWidth: 44, minHeight: 44 } : {}),
            }}
          ><X size={16} /></button>
        </div>

        <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          {p.titles.length === 1
            ? <>Moving <strong style={{ color: 'var(--text-primary)' }}>{p.titles[0]}</strong> to <span style={pill(STATUS.blocked.color)}>Blocked</span>.</>
            : <>Moving {p.titles.length} tasks to <span style={pill(STATUS.blocked.color)}>Blocked</span>.</>}
          {' '}Name a task it is waiting on, or say what in a sentence. Either is enough — the point
          is that somebody reading the board later knows what to go and unblock.
        </p>

        <div style={{ display: 'grid', gap: 6 }}>
          <span style={{ ...microLabel, fontSize: 9 }}>Waiting on — in your words</span>
          <textarea
            autoFocus={!isMobile}
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="e.g. waiting on the API key from ops"
            style={{ ...field(isMobile), minHeight: 68, resize: 'vertical', lineHeight: 1.5 }}
          />
        </div>

        <div style={{ display: 'grid', gap: 6 }}>
          <span style={{ ...microLabel, fontSize: 9 }}>…or a task that has to finish first</span>
          <div style={{ position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 9, top: isMobile ? 15 : 9, color: 'var(--text-tertiary)' }} />
            <input
              value={q} onChange={e => setQ(e.target.value)} placeholder="Search the board"
              style={{ ...field(isMobile), paddingLeft: 29 }}
            />
          </div>
          <div style={{ display: 'grid', gap: 3, maxHeight: 190, overflowY: 'auto' }}>
            {candidates.length === 0 && (
              <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '4px 2px' }}>
                Nothing open to point at. A sentence above is the answer then.
              </span>
            )}
            {candidates.map(r => {
              const on = picked.has(r.task.id)
              const st = STATUS[r.task.status as BoardStatus]
              return (
                <button
                  key={r.task.id}
                  onClick={() => setPicked(s => {
                    const next = new Set(s)
                    next.has(r.task.id) ? next.delete(r.task.id) : next.add(r.task.id)
                    return next
                  })}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', width: '100%',
                    padding: '7px 9px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                    border: `1px solid ${on ? 'var(--anthropic-orange)' : 'transparent'}`,
                    background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
                    color: 'var(--text-primary)', fontSize: 12.5,
                    minHeight: isMobile ? 44 : 32,
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.task.title}
                  </span>
                  {st && <span style={pill(st.color)}>{st.label}</span>}
                </button>
              )
            })}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button style={button(isMobile)} onClick={p.onCancel}>Cancel</button>
          <button
            style={{
              ...button(isMobile, armed ? 'primary' : 'ghost'),
              ...(armed ? {} : { opacity: 0.55 }),
            }}
            disabled={!armed}
            // Disabled rather than refused-after-the-fact: the server enforces the same rule, and
            // meeting it as an error after pressing a button is how a rule reads as a bug.
            title={armed ? 'Record the block' : 'Say what it is waiting on, or pick a task'}
            onClick={() => p.onConfirm({ reason: reason.trim(), blockedBy: [...picked] })}
          >Mark blocked</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
