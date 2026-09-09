/**
 * SessionFiling — the ONE dialog that answers "where does this session belong", end to end.
 *
 * It replaces a picker that could only ever name a DELIVERY, and it exists because of two things
 * that were wrong at once:
 *
 *  - **A delivery does not take sessions.** The delivery is the unit of delivery; the subtask is
 *    the unit of work, and a session does work. So filing is a delivery AND a subtask, always, and
 *    a dialog that asked only the first half left the second to a control on another screen.
 *  - **A session that is already filed was shown a list of OTHER deliveries.** Opening the filing
 *    control on filed work should show THAT work — where it sits, what else is in it, and the way
 *    out — not a search field over everything else, with the current one as a row among strangers.
 *
 * So there are two faces, decided by one fact:
 *
 *  - FILED: the delivery itself. Its name, its status, its subtasks with this session's own marked,
 *    and the verbs. Moving between subtasks is one click, here. Changing DELIVERY is a deliberate
 *    second gesture, because it is a different question and it is rarely the one being asked.
 *  - UNFILED: pick the delivery, then the subtask — two steps in one dialog, with "create" on both,
 *    so filing new work never means visiting the board.
 */

import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Check, CornerDownRight, ExternalLink, Plus, Search, Unlink, X } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { overlayPadding } from '../../lib/mobileOverlay'
import { useDismissOverlay } from '../../lib/dismissOverlay'
import {
  addSubtask, attachSession, createTask, detachSession, useTaskDetail, useTaskList,
  type Subtask, type TaskListRow,
} from '../../lib/tasks'
import { BlockedSubtaskResolve } from './BlockedSubtaskResolve'
import { STATUS, button, field, microLabel, pill, surface, type BoardStatus } from './board'
import { boardCopy, statusLabel, type Lang } from './copy'
import { BetaTag } from '../BetaTag'

export interface SessionFilingProps {
  session: { id: string; title: string; harness?: string; task?: string }
  lang: Lang
  onClose: () => void
  /** The filing changed — the caller re-reads whatever it draws. */
  onChanged: () => void | Promise<void>
  /** Open the delivery's own page. Absent where there is nowhere to navigate. */
  onOpenTask?: (taskId: string) => void
}

export function SessionFiling(p: SessionFilingProps) {
  const isMobile = useIsMobile()
  const copy = boardCopy(p.lang)
  const pt = p.lang === 'pt'
  const dismiss = useDismissOverlay(p.onClose)
  const { rows, reload } = useTaskList()

  /**
   * The delivery this session is filed under, matched by NAME — what the fleet row carries. The id
   * lives on the server's record, not on the wire, so this is the honest join this side can make.
   */
  const filed = useMemo(
    () => (p.session.task ? (rows ?? []).find(r => r.task.title === p.session.task) : undefined),
    [rows, p.session.task],
  )

  /** The delivery being LOOKED AT: the one it is filed under, or the one just picked. */
  const [chosen, setChosen] = useState<TaskListRow | null>(null)
  /** True while the reader deliberately asked to change delivery on already-filed work. */
  const [moving, setMoving] = useState(false)
  const target = moving ? chosen : (filed ?? chosen)

  const { detail, reload: reloadDetail } = useTaskDetail(target?.task.id)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  /** Set when the server refuses an attach because the subtask is still blocked. */
  const [blocked, setBlocked] = useState<{ taskId: string; subtaskId: string; blockedBy: string[] } | null>(null)

  const refresh = async () => { await reload(); await reloadDetail(); await p.onChanged() }

  const here = detail?.sessions.find(s => s.id === p.session.id)?.subtaskId ?? null

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const all = rows ?? []
    return needle ? all.filter(r => r.task.title.toLowerCase().includes(needle)) : all
  }, [rows, q])

  const fileInto = async (taskId: string, subtaskId: string) => {
    setBusy(true)
    const result = await attachSession(taskId, p.session.id, subtaskId)
    setBusy(false)
    if (!result.ok && result.reason === 'blocked') {
      // The dialog it opens is HANDED the answer, never asked to guess it — the ids `planAttach`
      // named are exactly what it needs.
      setBlocked({ taskId, subtaskId, blockedBy: result.blockedBy ?? [] })
      return
    }
    setMoving(false)
    await refresh()
  }

  /** Create a subtask in the delivery being looked at and file this session into it. */
  const createAndFile = async () => {
    const title = draft.trim()
    if (!title || !target) return
    setBusy(true)
    const ok = await addSubtask(target.task.id, title)
    if (ok) {
      const res = await fetch(`/api/tasks/${encodeURIComponent(target.task.id)}`)
      const body = res.ok ? await res.json() as { task: { subtasks: Subtask[] } } : null
      const made = body?.task.subtasks.filter(s => s.title === title).slice(-1)[0]
      // A subtask that cannot be found again is still CREATED — the session simply stays where it
      // was, and the row above is one click away. Filing into a guess would be worse.
      if (made) await attachSession(target.task.id, p.session.id, made.id)
    }
    setBusy(false); setDraft(''); setAdding(false); setMoving(false)
    await refresh()
  }

  const newDelivery = async () => {
    const title = q.trim()
    if (!title) return
    setBusy(true)
    const made = await createTask(title)
    setBusy(false)
    if (!made) return
    await reload()
    // Straight to step two: a delivery with no subtask cannot hold this session yet, and saying so
    // is the whole point of the rule.
    setChosen({ task: made } as TaskListRow)
    setQ('')
    setAdding(true)
  }

  const head = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      {(moving || (chosen && !filed)) && (
        <button
          onClick={() => { setChosen(null); setMoving(false) }}
          title={pt ? 'Voltar' : 'Back'}
          style={{ ...button(isMobile), height: isMobile ? 44 : 26, padding: '0 8px' }}
        ><ArrowLeft size={13} /></button>
      )}
      <span style={microLabel}>
        {target && !moving ? copy.delivery : copy.fileUnder}
      </span>
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

  /** One row of the subtask list — a radio, because exactly one of them is true. */
  const subtaskRow = (st: Subtask) => {
    const on = here === st.id
    return (
      <button
        key={st.id}
        onClick={() => void fileInto(target!.task.id, st.id)}
        disabled={busy || on}
        aria-pressed={on}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
          minHeight: isMobile ? 44 : 32, padding: isMobile ? '8px 10px' : '6px 9px',
          borderRadius: 7, font: 'inherit', fontSize: 12.5,
          border: `1px solid ${on ? 'var(--anthropic-orange)' : 'transparent'}`,
          background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
          color: on ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
          cursor: on || busy ? 'default' : 'pointer',
        }}
      >
        <span style={{
          width: 12, height: 12, borderRadius: 6, flexShrink: 0,
          border: `1px solid ${on ? 'var(--anthropic-orange)' : 'var(--border)'}`,
          background: on ? 'radial-gradient(circle, var(--anthropic-orange) 0 3px, transparent 4px)' : 'transparent',
        }} />
        <CornerDownRight size={11} style={{ opacity: 0.6, flexShrink: 0 }} />
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {st.title}
        </span>
        <span style={{ marginLeft: 'auto', ...microLabel, fontSize: 9.5 }}>
          {statusLabel(st.status, p.lang)}
        </span>
      </button>
    )
  }

  const body = target
    ? (
      // ── THE DELIVERY ITSELF ────────────────────────────────────────────────────────────────
      <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 650, color: 'var(--text-primary)', minWidth: 0 }}>
            {target.task.title}
          </span>
          <span style={{
            ...pill(STATUS[(target.task.status as BoardStatus)]?.color),
            background: STATUS[(target.task.status as BoardStatus)]?.dim,
          }}>
            {statusLabel(target.task.status, p.lang)}
          </span>
        </div>

        <span style={{ ...microLabel, fontSize: 9 }}>
          {pt ? 'Subtarefas — a sessão fica em UMA delas' : 'Subtasks — the session sits in ONE of them'}
        </span>

        {(detail?.subtasks.length ?? 0) === 0 && !adding && (
          <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
            {pt
              ? 'Esta entrega ainda não tem subtarefas, e uma sessão só se filia a uma subtarefa — o custo da entrega é o das partes dela. Crie a primeira aqui.'
              : 'This delivery has no subtasks yet, and a session is only ever filed under one — a delivery’s cost is the cost of its parts. Create the first one here.'}
          </p>
        )}

        <div style={{ display: 'grid', gap: 2, maxHeight: 260, overflowY: 'auto' }}>
          {(detail?.subtasks ?? []).map(subtaskRow)}
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
                onKeyDown={e => { if (e.key === 'Enter') void createAndFile() }}
              />
              <button style={button(isMobile, 'primary')} disabled={busy || !draft.trim()} onClick={() => void createAndFile()}>
                {pt ? 'Criar e filiar' : 'Create and file'}
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

        {/* The verbs, and only the ones that act on THIS delivery. */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          {p.onOpenTask && (
            <button style={button(isMobile)} onClick={() => { p.onOpenTask?.(target.task.id); p.onClose() }}>
              <ExternalLink size={13} /> {pt ? 'Abrir a entrega' : 'Open the delivery'}
            </button>
          )}
          {filed && !moving && (
            <button style={button(isMobile)} disabled={busy} onClick={() => { setMoving(true); setChosen(null) }}>
              {pt ? 'Trocar de entrega' : 'Move to another delivery'}
            </button>
          )}
          {filed && (
            <button
              style={{ ...button(isMobile), color: 'var(--accent-red)' }}
              disabled={busy}
              onClick={async () => {
                setBusy(true); await detachSession(p.session.id, p.session.id); setBusy(false)
                await refresh(); p.onClose()
              }}
            >
              <Unlink size={13} /> {pt ? 'Desfiliar' : 'Unfile'}
            </button>
          )}
        </div>
      </div>
    )
    : (
      // ── PICK THE DELIVERY ──────────────────────────────────────────────────────────────────
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
            >
              {filed?.task.id === r.task.id && <Check size={12} style={{ color: 'var(--anthropic-orange)' }} />}
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
      </div>
    )

  // Replaces the filing dialog outright rather than stacking on top of it — a person answering
  // "did you already finish that" should not also be looking at the subtask list underneath, and
  // two fixed overlays would double the scrim.
  if (blocked) {
    return (
      <BlockedSubtaskResolve
        taskId={blocked.taskId}
        blockedSubtaskTitle={detail?.subtasks.find(s => s.id === blocked.subtaskId)?.title ?? ''}
        blockedBy={blocked.blockedBy}
        subtasks={detail?.subtasks ?? []}
        sessions={detail?.sessions ?? []}
        lang={p.lang}
        onCancel={() => setBlocked(null)}
        onResolved={async () => {
          const { taskId, subtaskId } = blocked
          setBlocked(null)
          await fileInto(taskId, subtaskId)
        }}
      />
    )
  }

  return createPortal(
    <div
      {...dismiss}
      style={{
        position: 'fixed', inset: 0, zIndex: 999, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.45)', padding: overlayPadding(isMobile, 16),
      }}
    >
      <div style={{
        ...surface, background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-elevated)',
        padding: 14, display: 'grid', gap: 12, alignContent: 'start',
        ...(isMobile
          ? { width: '100%', height: '100%', borderRadius: 0, overflowY: 'auto' }
          : { width: 'min(460px, 92vw)', maxHeight: '82vh', overflowY: 'auto' }),
      }}>
        {head}
        {body}
      </div>
    </div>,
    document.body,
  )
}
