/**
 * TaskPicker — "file this under a task", asked once and reused everywhere.
 *
 * It is ONE component because the question is one question: the row menu, the right-click on a
 * card, the three-dot menu and the create-task wizard all ask it, and four implementations of a
 * picker is four places for the list, the search and the create-new to drift apart.
 *
 * It always offers CREATE as well as pick. A picker that can only choose from what exists makes
 * "file this under something new" a two-screen errand, which is how a filing gesture goes unused —
 * and unfiled sessions are exactly what makes the whole measurement short.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Plus, Search, X } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { STATUS, button, field, microLabel, pill, surface, type BoardStatus } from './board'
import { createTask, useTaskList, type TaskListRow } from '../../lib/tasks'

export interface TaskPickerProps {
  /** Where to anchor. Absent centres it — which is what a mobile sheet wants anyway. */
  at?: { x: number; y: number }
  title?: string
  /** Called with the chosen (or newly created) task id. */
  onPick: (taskId: string, task: TaskListRow['task']) => void | Promise<void>
  onClose: () => void
}

export function TaskPicker({ at, title, onPick, onClose }: TaskPickerProps) {
  const isMobile = useIsMobile()
  const { rows, reload } = useTaskList()
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Closes on the PRESS, not on a release that may land somewhere else — the rule
    // `SessionRowMenu` already follows.
    const down = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key)
    }
  }, [onClose])

  const needle = q.trim().toLowerCase()
  const shown = useMemo(() => {
    const all = rows ?? []
    if (!needle) return all.slice(0, 40)
    return all.filter(r => r.task.title.toLowerCase().includes(needle)).slice(0, 40)
  }, [rows, needle])

  // An exact title match means "create" would return the existing task, so the row is not offered:
  // two ways to reach one record, one of them labelled "new", is how a duplicate gets expected.
  const exact = (rows ?? []).some(r => r.task.title.toLowerCase() === needle)

  const create = async () => {
    if (!needle || busy) return
    setBusy(true)
    const made = await createTask(q.trim())
    setBusy(false)
    if (!made) return
    await reload()
    await onPick(made.id, made)
    onClose()
  }

  const box: React.CSSProperties = isMobile || !at
    ? {
      position: 'fixed', inset: 0, margin: 'auto', width: 'min(420px, 92vw)', maxHeight: '70vh',
    }
    : {
      position: 'fixed',
      // Flipped when it would leave the viewport, like the row menu.
      left: Math.min(at.x, window.innerWidth - 340),
      top: Math.min(at.y, window.innerHeight - 380),
      width: 320, maxHeight: 360,
    }

  return createPortal(
    <>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 998 }} />
      <div
        ref={boxRef}
        style={{
          ...surface, ...box, zIndex: 999, padding: 12, display: 'grid', gap: 9,
          gridTemplateRows: 'auto auto 1fr', boxShadow: 'var(--shadow-elevated)',
          background: 'var(--bg-elevated)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={microLabel}>{title ?? 'File under a task'}</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}>
            <X size={15} />
          </button>
        </div>

        <div style={{ position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: isMobile ? 15 : 10, color: 'var(--text-tertiary)' }} />
          <input
            autoFocus style={{ ...field(isMobile), paddingLeft: 31 }} value={q}
            placeholder="Search tasks, or type a new name"
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !exact && needle) void create() }}
          />
        </div>

        <div style={{ overflowY: 'auto', display: 'grid', gap: 4, alignContent: 'start' }}>
          {needle && !exact && (
            <button
              onClick={() => void create()} disabled={busy}
              style={{
                ...button(isMobile), justifyContent: 'flex-start', width: '100%',
                color: 'var(--anthropic-orange)', borderStyle: 'dashed',
              }}
            >
              <Plus size={14} /> Create “{q.trim()}”
            </button>
          )}
          {shown.length === 0 && !needle && (
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '6px 2px' }}>
              No tasks yet — type a name to create the first one.
            </div>
          )}
          {shown.map(r => {
            const s = STATUS[r.task.status as BoardStatus] ?? STATUS.todo
            return (
              <button
                key={r.task.id}
                onClick={() => { void onPick(r.task.id, r.task); onClose() }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                  padding: '7px 9px', borderRadius: 'var(--radius-sm)', border: '1px solid transparent',
                  background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer',
                  minHeight: isMobile ? 44 : 30, fontSize: 12.5,
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-card-hover)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.task.title}
                </span>
                <span style={pill(s.color)}>{s.label}</span>
              </button>
            )
          })}
          {exact && (
            <div style={{ ...microLabel, textTransform: 'none', letterSpacing: 0, padding: '4px 2px' }}>
              <Check size={11} style={{ verticalAlign: -1 }} /> That task already exists — pick it above.
            </div>
          )}
        </div>
      </div>
    </>,
    document.body,
  )
}
