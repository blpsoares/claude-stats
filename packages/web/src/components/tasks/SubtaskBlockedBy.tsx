/**
 * SubtaskBlockedBy — which SIBLING subtasks must be `done` before this one can take a session.
 *
 * The task-level `BlockedBy` (in `DeliveryDetail.tsx`) answers the same question one level up: pick
 * from every OTHER delivery. This one is scoped to the subtasks of THIS delivery, because that is
 * the only relationship `task-attach.ts`'s `planAttach` actually enforces — a subtask may only be
 * blocked by a sibling, never by a subtask of another delivery (the server sanitizes this away on
 * write; the picker simply never offers it).
 *
 * It is a POPOVER rather than an always-open block, unlike the task-level one: this sits inside a
 * table cell, where a person is scanning many rows, and a control that stays collapsed until asked
 * for is what keeps the row a row. The trigger is a small badge that says NOTHING when there are no
 * blockers (a control for a fact that is not there yet is noise on every row) and the count once
 * there are — never the word "Blocked" again, which is the STATUS pill sitting right beside it.
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Ban, Plus, XCircle } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { Select } from '../../pages/settings/primitives'
import { STATUS, microLabel, pill, surface, type BoardStatus } from './board'
import { statusLabel, type Lang } from './copy'
import type { Subtask } from '../../lib/tasks'

export interface SubtaskBlockedByProps {
  subtaskId: string
  blockedBy: string[]
  /** The DELIVERY's other subtasks — the only pool a blocker may come from. */
  siblings: readonly Subtask[]
  lang: Lang
  onChange: (ids: string[]) => void | Promise<void>
}

export function SubtaskBlockedBy(p: SubtaskBlockedByProps) {
  const isMobile = useIsMobile()
  const pt = p.lang === 'pt'
  const [open, setOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  const blockers = p.blockedBy
    .map(id => p.siblings.find(s => s.id === id))
    .filter((s): s is Subtask => s !== undefined)
  const openBlockers = blockers.filter(b => !b.done)

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (triggerRef.current?.contains(t)) return
      if (boxRef.current && !boxRef.current.contains(t)) { setOpen(false); setPicking(false) }
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); setPicking(false) } }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  const toggle = () => {
    if (open) { setOpen(false); setPicking(false); return }
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setAt({ left: Math.min(r.left, window.innerWidth - 260 - 8), top: r.bottom + 6 })
    setOpen(true)
  }

  const set = async (ids: string[]) => { await p.onChange(ids) }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={toggle}
        title={pt ? 'Bloqueado por' : 'Blocked by'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 3,
          border: `1px solid ${openBlockers.length > 0 ? 'var(--accent-red)' : 'var(--border)'}`,
          background: openBlockers.length > 0 ? 'var(--accent-red-dim)' : 'transparent',
          color: openBlockers.length > 0 ? 'var(--accent-red)' : 'var(--text-tertiary)',
          borderRadius: 5, padding: '3px 6px', cursor: 'pointer', fontSize: 10,
          minHeight: isMobile ? 28 : undefined,
        }}
      >
        <Ban size={11} />
        {blockers.length > 0 && blockers.length}
      </button>

      {open && at && createPortal(
        <div
          ref={boxRef}
          style={{
            position: 'fixed', left: at.left, top: at.top, width: 260, zIndex: 60,
            ...surface, background: 'var(--bg-elevated)', padding: 10, display: 'grid', gap: 8,
            boxShadow: 'var(--shadow-elevated)',
          }}
        >
          <span style={microLabel}>{pt ? 'Bloqueado por' : 'Blocked by'}</span>

          {blockers.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              {pt ? 'Nada bloqueia esta subtarefa.' : 'Nothing is blocking this subtask.'}
            </div>
          )}
          {blockers.map(b => (
            <div key={b.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{
                fontSize: 11.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                textDecoration: b.done ? 'line-through' : 'none',
                color: b.done ? 'var(--text-tertiary)' : 'var(--text-secondary)',
              }}>{b.title}</span>
              <span style={pill(STATUS[b.status as BoardStatus]?.color)}>
                {statusLabel(b.status, p.lang)}
              </span>
              <button
                onClick={() => void set(p.blockedBy.filter(x => x !== b.id))}
                style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}
                title={pt ? 'Remover' : 'Remove'}
              ><XCircle size={12} /></button>
            </div>
          ))}

          {picking
            ? (
              <Select
                value=""
                placeholder={pt ? 'Escolher uma subtarefa…' : 'Pick a subtask…'}
                searchPlaceholder={pt ? 'Buscar…' : 'Search…'}
                options={p.siblings
                  .filter(s => s.id !== p.subtaskId && !p.blockedBy.includes(s.id))
                  .map(s => ({ value: s.id, label: s.title, hint: statusLabel(s.status, p.lang) }))}
                onChange={v => { if (v) void set([...p.blockedBy, v]); setPicking(false) }}
              />
            )
            : (
              <button
                onClick={() => setPicking(true)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5, justifySelf: 'start',
                  background: 'none', border: '1px dashed var(--border)', borderRadius: 6,
                  padding: '5px 8px', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11.5,
                  minHeight: isMobile ? 34 : undefined,
                }}
              ><Plus size={12} /> {pt ? 'Adicionar bloqueio' : 'Add blocker'}</button>
            )}
        </div>,
        document.body,
      )}
    </>
  )
}
