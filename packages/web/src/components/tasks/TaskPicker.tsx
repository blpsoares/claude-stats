/**
 * TaskPicker — "file this new session under a subtask", asked once, before it exists.
 *
 * It used to stop at the DELIVERY: pick a task, and the session that got created carried the
 * delivery's title as a free-text label with no subtask at all — the wizard's own version of the
 * rule every other filing surface (`SessionFiling`, the subtask table) now enforces. Reported
 * directly: the picker still only offered deliveries, and the dialog itself read as too small to
 * work in.
 *
 * So this is now the SAME two-step shape `SessionFiling`'s unfiled face uses — pick a delivery,
 * then one of its subtasks, with "create" offered at both steps — returning the exact ids a spawn
 * needs to attach the session once it exists. **It never enforces `blockedBy` itself**: this
 * session has not been created yet, so there is nothing yet to refuse filing, and the rule lives in
 * exactly one place (`task-attach.ts`'s `planAttach`, reached through `attachSession`) — the CALLER
 * finds out the subtask is blocked the moment it actually tries to file the session it just spawned,
 * which is the true first attempt, and opens `BlockedSubtaskResolve` there.
 */

import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Check, CornerDownRight, Plus, Search, X } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { addSubtask, createTask, useTaskDetail, useTaskList, type Subtask, type TaskListRow } from '../../lib/tasks'
import { STATUS, button, field, microLabel, pill, surface, type BoardStatus } from './board'
import { boardCopy, statusLabel, type Lang } from './copy'
import { BetaTag } from '../BetaTag'
import { overlayPadding } from '../../lib/mobileOverlay'

export interface TaskPickerPick {
  taskId: string
  subtaskId: string
  taskTitle: string
  subtaskTitle: string
}

export interface TaskPickerProps {
  lang: Lang
  title?: string
  onPick: (pick: TaskPickerPick) => void | Promise<void>
  onClose: () => void
}

export function TaskPicker(p: TaskPickerProps) {
  const isMobile = useIsMobile()
  const copy = boardCopy(p.lang)
  const pt = p.lang === 'pt'
  const { rows, reload } = useTaskList()

  const [chosen, setChosen] = useState<TaskListRow | null>(null)
  const { detail, reload: reloadDetail } = useTaskDetail(chosen?.task.id)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)

  const needle = q.trim().toLowerCase()
  const shown = useMemo(() => {
    const all = rows ?? []
    return needle ? all.filter(r => r.task.title.toLowerCase().includes(needle)) : all
  }, [rows, needle])
  const exact = (rows ?? []).some(r => r.task.title.toLowerCase() === needle)

  const pickSubtask = async (st: Subtask) => {
    if (!chosen) return
    await p.onPick({
      taskId: chosen.task.id, subtaskId: st.id, taskTitle: chosen.task.title, subtaskTitle: st.title,
    })
    p.onClose()
  }

  const createAndPick = async () => {
    const title = draft.trim()
    if (!title || !chosen) return
    setBusy(true)
    const ok = await addSubtask(chosen.task.id, title)
    if (ok) {
      const res = await fetch(`/api/tasks/${encodeURIComponent(chosen.task.id)}`)
      const body = res.ok ? await res.json() as { task: { subtasks: Subtask[] } } : null
      const made = body?.task.subtasks.filter(s => s.title === title).slice(-1)[0]
      if (made) { setBusy(false); await pickSubtask(made); return }
    }
    setBusy(false); setDraft(''); setAdding(false)
    await reloadDetail()
  }

  const newDelivery = async () => {
    const title = q.trim()
    if (!title) return
    setBusy(true)
    const made = await createTask(title)
    setBusy(false)
    if (!made) return
    await reload()
    setChosen({ task: made } as TaskListRow)
    setQ('')
    setAdding(true)
  }

  const head = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      {chosen && (
        <button
          onClick={() => setChosen(null)}
          title={pt ? 'Voltar' : 'Back'}
          style={{ ...button(isMobile), height: isMobile ? 44 : 26, padding: '0 8px' }}
        ><ArrowLeft size={13} /></button>
      )}
      <span style={microLabel}>{chosen ? copy.delivery : (p.title ?? copy.fileUnder)}</span>
      <BetaTag what={copy.deliveries} />
      <span style={{ flex: 1 }} />
      <button
        onClick={p.onClose}
        aria-label={pt ? 'Fechar' : 'Close'}
        className="ag-tap-icon"
        style={{
          background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer',
          display: 'flex', width: 22, height: 22, alignItems: 'center', justifyContent: 'center',
        }}
      ><X size={16} /></button>
    </div>
  )

  const body = chosen
    ? (
      <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 650, color: 'var(--text-primary)', minWidth: 0 }}>
            {chosen.task.title}
          </span>
          <span style={{
            ...pill(STATUS[(chosen.task.status as BoardStatus)]?.color),
            background: STATUS[(chosen.task.status as BoardStatus)]?.dim,
          }}>
            {statusLabel(chosen.task.status, p.lang)}
          </span>
        </div>

        <span style={{ ...microLabel, fontSize: 9 }}>
          {pt
            ? 'Subtarefas — a sessão vai ficar em UMA delas'
            : 'Subtasks — the session will sit in ONE of them'}
        </span>

        {(detail?.subtasks.length ?? 0) === 0 && !adding && (
          <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
            {pt
              ? 'Esta entrega ainda não tem subtarefas, e uma sessão só se filia a uma subtarefa — crie a primeira aqui.'
              : 'This delivery has no subtasks yet, and a session is only ever filed under one — create the first one here.'}
          </p>
        )}

        <div style={{ display: 'grid', gap: 2, maxHeight: 260, overflowY: 'auto' }}>
          {(detail?.subtasks ?? []).map(st => (
            <button
              key={st.id}
              onClick={() => void pickSubtask(st)}
              disabled={busy}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                minHeight: isMobile ? 44 : 32, padding: isMobile ? '8px 10px' : '6px 9px',
                borderRadius: 7, font: 'inherit', fontSize: 12.5,
                border: '1px solid transparent', background: 'transparent',
                color: 'var(--text-secondary)', cursor: busy ? 'default' : 'pointer',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-card-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <CornerDownRight size={11} style={{ opacity: 0.6, flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {st.title}
              </span>
              <span style={{ ...microLabel, fontSize: 9.5 }}>{statusLabel(st.status, p.lang)}</span>
            </button>
          ))}
        </div>

        {adding
          ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <input
                autoFocus={!isMobile}
                style={{ ...field(isMobile), flex: '1 1 170px' }}
                value={draft}
                placeholder={pt ? 'O que esta parte entrega…' : 'What this part delivers…'}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void createAndPick() }}
              />
              <button style={button(isMobile, 'primary')} disabled={busy || !draft.trim()} onClick={() => void createAndPick()}>
                {pt ? 'Criar e escolher' : 'Create and pick'}
              </button>
              <button style={button(isMobile)} disabled={busy} onClick={() => { setAdding(false); setDraft('') }}>
                {pt ? 'Cancelar' : 'Cancel'}
              </button>
            </div>
          )
          : (
            <button style={{ ...button(isMobile), alignSelf: 'start' }} disabled={busy} onClick={() => setAdding(true)}>
              <Plus size={13} /> {pt ? 'Nova subtarefa' : 'New subtask'}
            </button>
          )}
      </div>
    )
    : (
      <div style={{ display: 'grid', gap: 8, minWidth: 0 }}>
        <div style={{ position: 'relative' }}>
          <Search size={13} style={{ position: 'absolute', left: 10, top: isMobile ? 15 : 9, color: 'var(--text-tertiary)' }} />
          <input
            autoFocus={!isMobile}
            style={{ ...field(isMobile), paddingLeft: 30 }}
            value={q}
            placeholder={copy.searchOrCreate}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && q.trim() && shown.length === 0) void newDelivery() }}
          />
        </div>
        {q.trim() && !shown.some(r => r.task.title === q.trim()) && (
          <button style={{ ...button(isMobile), justifyContent: 'flex-start' }} disabled={busy} onClick={() => void newDelivery()}>
            <Plus size={13} /> {pt ? `Criar “${q.trim()}”` : `Create “${q.trim()}”`}
          </button>
        )}
        <div style={{ display: 'grid', gap: 2, maxHeight: 320, overflowY: 'auto' }}>
          {shown.map(r => (
            <button
              key={r.task.id}
              onClick={() => { setChosen(r); setQ('') }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                minHeight: isMobile ? 44 : 32, padding: isMobile ? '8px 10px' : '6px 9px',
                borderRadius: 7, border: '1px solid transparent', background: 'transparent',
                color: 'var(--text-secondary)', font: 'inherit', fontSize: 12.5, cursor: 'pointer',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-card-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.task.title}
              </span>
              <span style={{
                marginLeft: 'auto',
                ...pill(STATUS[(r.task.status as BoardStatus)]?.color),
                background: STATUS[(r.task.status as BoardStatus)]?.dim,
              }}>
                {statusLabel(r.task.status, p.lang)}
              </span>
            </button>
          ))}
        </div>
        {exact && (
          <div style={{ ...microLabel, textTransform: 'none', letterSpacing: 0, padding: '4px 2px' }}>
            <Check size={11} style={{ verticalAlign: -1 }} /> {pt ? 'Essa entrega já existe — escolha acima.' : 'That delivery already exists — pick it above.'}
          </div>
        )}
      </div>
    )

  return createPortal(
    <div
      role="dialog" aria-modal="true"
      onClick={e => { if (e.target === e.currentTarget) p.onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 999, display: 'flex',
        alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.45)',
        padding: overlayPadding(isMobile, 16),
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          ...surface, background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-elevated)',
          padding: 16, display: 'grid', gap: 12, alignContent: 'start',
          // WIDER, on purpose: this used to be 320-420px, which is fine for a list of titles alone
          // and cramped the moment a subtask row also carries a status pill — reported as "ta
          // minusculo esse componente em largura". A dialog, not a small anchored flyout: it now
          // opens centred at a size that holds both steps comfortably.
          ...(isMobile
            ? { width: '100%', height: '100%', borderRadius: 0, overflowY: 'auto' }
            : { width: 'min(560px, 92vw)', maxHeight: '80vh', overflowY: 'auto' }),
        }}
      >
        {head}
        {body}
      </div>
    </div>,
    document.body,
  )
}
