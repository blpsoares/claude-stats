/**
 * SubtaskTable — the subtasks, as the SAME grid the table view expands inside a row.
 *
 * One component drawn in two places, deliberately: a subtask that shows five columns on the board
 * and a checkbox on the detail page is two different records as far as the reader is concerned, and
 * the one with fewer columns teaches people the fields do not exist.
 *
 * What a subtask does NOT carry is cost, rounds or tokens. Those are measured per SESSION and roll
 * up to the task; a second, smaller rollup here would either count the same sessions twice or
 * invent a split nobody recorded. It carries a SESSION instead — which piece of work is being done
 * where — and that is the honest half.
 */

import { useState } from 'react'
import { Plus, Terminal, Trash2, X } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { COLUMN_ORDER, STATUS, field, microLabel, pill, surface, type BoardStatus } from './board'
import { SessionPicker } from './SessionPicker'
import { DatePicker } from '../DatePicker'
import { TaskProgressBar } from './TaskProgressBar'
import type { Subtask, TaskStatus } from '../../lib/tasks'

function StatusPick({ value, onPick }: { value: TaskStatus; onPick: (s: TaskStatus) => void }) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const s = STATUS[value as BoardStatus] ?? STATUS.todo
  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          border: `1px solid ${s.color}`, cursor: 'pointer', padding: '3px 9px', borderRadius: 5,
          background: s.dim, color: s.color, fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap',
          minHeight: isMobile ? 44 : undefined,
        }}
      >{s.label}</button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 30 }} />
          <div style={{
            position: 'absolute', top: '100%', left: 0, zIndex: 31, marginTop: 4, minWidth: 128,
            ...surface, background: 'var(--bg-elevated)', padding: 4, display: 'grid', gap: 2,
            boxShadow: 'var(--shadow-elevated)',
          }}>
            {COLUMN_ORDER.map(st => {
              const c = STATUS[st]
              return (
                <button
                  key={st} onClick={() => { setOpen(false); onPick(st) }}
                  style={{
                    border: 'none', cursor: 'pointer', textAlign: 'left', padding: '5px 9px',
                    borderRadius: 5, background: c.dim, color: c.color, fontSize: 10.5, fontWeight: 600,
                    minHeight: isMobile ? 44 : undefined,
                  }}
                >{c.label}</button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

const cell: React.CSSProperties = { padding: '7px 9px', borderTop: '1px solid var(--border)' }
const bare: React.CSSProperties = {
  width: '100%', background: 'transparent', border: 'none', outline: 'none',
  color: 'var(--text-secondary)', fontSize: 12, fontFamily: 'inherit',
}

export interface SubtaskTableProps {
  subtasks: Subtask[]
  sessionTitleOf?: (sessionId: string) => string | undefined
  onAdd: (title: string) => void | Promise<void>
  onPatch: (id: string, patch: Partial<Subtask>) => void | Promise<void>
  onRemove: (id: string) => void | Promise<void>
}

export function SubtaskTable(p: SubtaskTableProps) {
  const isMobile = useIsMobile()
  const [draft, setDraft] = useState('')
  const [linking, setLinking] = useState<string | null>(null)

  const done = p.subtasks.filter(t => t.done).length

  return (
    <div style={{ ...surface, overflowX: 'auto' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 9, padding: '9px 10px',
        borderBottom: '1px solid var(--border)',
      }}>
        <span style={microLabel}>Subtasks</span>
        {/* The shared bar — it rounds DOWN, so this one cannot say 100% while the grid below it
            still shows an open row. That disagreement is exactly what one component prevents. */}
        <div style={{ flex: 1, maxWidth: 220 }}>
          <TaskProgressBar done={done} total={p.subtasks.length} />
        </div>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 620 }}>
        <thead>
          <tr>
            {(['Subtask', 'Status', 'Owner', 'Start', 'Due', 'Session', ''] as const).map((h, i) => (
              <th key={i} style={{ ...microLabel, textAlign: 'left', padding: '6px 9px', fontWeight: 600 }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {p.subtasks.length === 0 && (
            <tr>
              <td colSpan={7} style={{ ...cell, fontSize: 12, color: 'var(--text-tertiary)' }}>
                Nothing broken out yet. A subtask carries its own status, owner, dates and session —
                cost stays on the task, where the sessions are.
              </td>
            </tr>
          )}
          {p.subtasks.map(t => (
            <tr key={t.id}>
              <td style={{ ...cell, minWidth: 180 }}>
                <input
                  defaultValue={t.title}
                  onBlur={e => { if (e.target.value.trim() !== t.title) void p.onPatch(t.id, { title: e.target.value }) }}
                  style={{
                    ...bare,
                    color: t.done ? 'var(--text-tertiary)' : 'var(--text-primary)',
                    textDecoration: t.done ? 'line-through' : 'none',
                    fontSize: 12.5,
                  }}
                />
              </td>
              <td style={cell}>
                <StatusPick value={t.status} onPick={s => void p.onPatch(t.id, { status: s })} />
              </td>
              <td style={cell}>
                <input
                  defaultValue={t.assignee ?? ''} placeholder="—"
                  onBlur={e => { if (e.target.value !== (t.assignee ?? '')) void p.onPatch(t.id, { assignee: e.target.value }) }}
                  style={bare}
                />
              </td>
              {/* The dashboard's own picker, not `<input type="date">`: one calendar in the app,
                  and a control that fits the column instead of overflowing it. The label is empty
                  because the column heading above already says which date this is. */}
              <td style={cell}>
                <DatePicker
                  value={t.startDate ?? ''} label="" placeholder="—" lang="en"
                  onChange={v => void p.onPatch(t.id, { startDate: v })}
                />
              </td>
              <td style={cell}>
                <DatePicker
                  value={t.dueDate ?? ''} label="" placeholder="—" lang="en"
                  min={t.startDate || undefined}
                  onChange={v => void p.onPatch(t.id, { dueDate: v })}
                />
              </td>
              <td style={cell}>
                {t.sessionId ? (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <span style={pill()}>
                      {p.sessionTitleOf?.(t.sessionId) ?? t.sessionId.slice(0, 8)}
                    </span>
                    <button
                      onClick={() => void p.onPatch(t.id, { sessionId: '' })} title="Unlink"
                      style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}
                    ><X size={11} /></button>
                  </span>
                ) : (
                  <button
                    onClick={() => setLinking(t.id)}
                    style={{
                      background: 'none', border: 'none', color: 'var(--text-tertiary)',
                      cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4,
                      fontSize: 11.5,
                    }}
                  ><Terminal size={12} /> link</button>
                )}
              </td>
              <td style={{ ...cell, textAlign: 'right' }}>
                <button
                  onClick={() => void p.onRemove(t.id)} title="Remove"
                  style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'inline-flex' }}
                ><Trash2 size={12} /></button>
              </td>
            </tr>
          ))}
          <tr>
            <td colSpan={7} style={{ ...cell }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, width: '100%' }}>
                <Plus size={12} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                <input
                  value={draft} placeholder="Add a subtask, then Enter"
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && draft.trim()) { void p.onAdd(draft.trim()); setDraft('') }
                  }}
                  style={{ ...bare, maxWidth: 340, minHeight: isMobile ? 34 : 20 }}
                />
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      {linking && (
        <SessionPicker
          multiple={false}
          onPick={ids => { const first = ids[0]; if (first) void p.onPatch(linking, { sessionId: first }) }}
          onClose={() => setLinking(null)}
        />
      )}
    </div>
  )
}
