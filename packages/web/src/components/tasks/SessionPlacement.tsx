/**
 * SessionPlacement — WHERE inside a delivery this session sits, and the one gesture that moves it.
 *
 * A delivery with subtasks is the normal shape of real work: the parent holds the discovery, each
 * subtask holds an execution, and the sessions belong to whichever piece actually produced them.
 * Filing could only ever name the delivery, so a session that plainly belonged to one subtask had
 * nowhere to go and every subtask's cost was unanswerable.
 *
 * **A session is filed under the delivery OR under one of its subtasks — never both.** That is the
 * rule this control renders: the rows are RADIO rows, exactly one is marked, and picking another is
 * a MOVE. The server's `task-attach.ts` is where the rule actually lives; this only ever states a
 * target and redraws what came back, so the two cannot disagree about what "filed" means.
 *
 * The delivery's own total does not change when a session moves into one of its subtasks — the
 * subtask belongs to the delivery, so the work is still its. What changes is which line of the
 * breakdown carries it, which is the whole reason to move it.
 */

import { useState } from 'react'
import { CornerDownRight, Plus } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { addSubtask, attachSession, type Subtask, type TaskSessionRow } from '../../lib/tasks'
import { button, field, microLabel, surface } from './board'
import type { Lang } from './copy'

export interface SessionPlacementProps {
  /** The delivery this session is filed under. */
  taskId: string
  taskTitle: string
  sessionId: string
  subtasks: readonly Subtask[]
  /** This session's row on the delivery, which is what says where it currently sits. */
  row?: TaskSessionRow
  lang: Lang
  /** The move landed — the caller re-reads the delivery so every figure follows. */
  onChanged: () => void | Promise<void>
}

export function SessionPlacement(p: SessionPlacementProps) {
  const isMobile = useIsMobile()
  const pt = p.lang === 'pt'
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  const here = p.row?.subtaskId ?? null

  const move = async (subtaskId?: string) => {
    setBusy(true)
    await attachSession(p.taskId, p.sessionId, subtaskId)
    setBusy(false)
    await p.onChanged()
  }

  /**
   * Create a subtask and file this session under it, in one gesture.
   *
   * The id is not returned by the create, so it is found by TITLE on the re-read. A title that
   * matches nothing leaves the session where it was rather than filing it somewhere arbitrary —
   * the subtask is still created, and the row above it is one click away.
   */
  const createAndMove = async () => {
    const title = draft.trim()
    if (!title) return
    setBusy(true)
    const ok = await addSubtask(p.taskId, title)
    if (ok) {
      const res = await fetch(`/api/tasks/${encodeURIComponent(p.taskId)}`)
      const body = ok && res.ok ? await res.json() as { task: { subtasks: Subtask[] } } : null
      const made = body?.task.subtasks.filter(s => s.title === title).slice(-1)[0]
      if (made) await attachSession(p.taskId, p.sessionId, made.id)
    }
    setBusy(false)
    setDraft('')
    setAdding(false)
    await p.onChanged()
  }

  const row = (selected: boolean, label: string, onPick: () => void, indent: boolean) => (
    <button
      key={label}
      onClick={onPick}
      disabled={busy || selected}
      aria-pressed={selected}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
        minHeight: isMobile ? 44 : 30, padding: isMobile ? '8px 10px' : '5px 8px',
        paddingLeft: indent ? (isMobile ? 26 : 22) : undefined,
        borderRadius: 7, font: 'inherit', fontSize: 12.5,
        border: `1px solid ${selected ? 'var(--anthropic-orange)' : 'transparent'}`,
        background: selected ? 'var(--anthropic-orange-dim)' : 'transparent',
        color: selected ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
        cursor: selected || busy ? 'default' : 'pointer',
      }}
    >
      {/* The mark is a RADIO and not a tick: exactly one of these is true, and a row of ticks would
          read as a set you can add to. */}
      <span style={{
        width: 12, height: 12, borderRadius: 6, flexShrink: 0,
        border: `1px solid ${selected ? 'var(--anthropic-orange)' : 'var(--border)'}`,
        background: selected
          ? 'radial-gradient(circle, var(--anthropic-orange) 0 3px, transparent 4px)'
          : 'transparent',
      }} />
      {indent && <CornerDownRight size={11} style={{ opacity: 0.6, flexShrink: 0 }} />}
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </button>
  )

  return (
    <div style={{ ...surface, padding: 12, display: 'grid', gap: 8 }}>
      <span style={microLabel}>{pt ? 'Filiada a' : 'Filed under'}</span>

      <div style={{ display: 'grid', gap: 2 }}>
        {row(here === null, p.taskTitle, () => void move(), false)}
        {p.subtasks.map(st => row(here === st.id, st.title, () => void move(st.id), true))}
      </div>

      <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
        {pt
          ? 'Uma sessão fica na entrega OU numa subtarefa dela, nunca nas duas — escolher outra move a sessão. O custo da entrega não muda: a subtarefa pertence a ela.'
          : 'A session sits on the delivery OR on one of its subtasks, never both — picking another MOVES it. The delivery’s cost does not change: the subtask belongs to it.'}
      </p>

      {adding
        ? (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <input
              autoFocus={!isMobile}
              style={{ ...field(isMobile), flex: '1 1 160px' }}
              value={draft}
              placeholder={pt ? 'O que esta parte entrega…' : 'What this part delivers…'}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void createAndMove() }}
            />
            <button style={button(isMobile, 'primary')} disabled={busy || !draft.trim()} onClick={() => void createAndMove()}>
              {pt ? 'Criar e mover' : 'Create and move'}
            </button>
            <button style={button(isMobile)} disabled={busy} onClick={() => { setAdding(false); setDraft('') }}>
              {pt ? 'Cancelar' : 'Cancel'}
            </button>
          </div>
        )
        : (
          <button
            style={{ ...button(isMobile), alignSelf: 'start', height: isMobile ? 44 : 26 }}
            disabled={busy}
            onClick={() => setAdding(true)}
          >
            <Plus size={13} /> {pt ? 'Nova subtarefa para esta sessão' : 'New subtask for this session'}
          </button>
        )}
    </div>
  )
}
