/**
 * SessionTasksTab — the DELIVERY this session belongs to, whole, beside the conversation.
 *
 * It used to be a summary card: the delivery's name, its rollup, and three buttons. Everything that
 * makes a delivery worth opening — its description, its parts, the sessions filed under each, the
 * comments and their attachments, the pull requests, what is blocking it, its status, its claim —
 * was on a page you had to leave the session to reach, and half of it could not be reached from
 * here at all.
 *
 * So this tab now renders `DeliveryDetail`, the very component `/tasks/:id` renders, in its `dense`
 * one-column shape. **It is not a mirror that has to be kept in sync — it is the same component
 * over the same `/api/tasks`**, which is what makes "change it here and it changes on the board"
 * true by construction rather than by maintenance.
 *
 * What stays local is the FILING: which delivery this session belongs to is a question about the
 * SESSION, and it is the one thing this tab answers that the page does not.
 */

import { useMemo, useState } from 'react'
import { ExternalLink, Link2, Plus, Unlink } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { button, microLabel, pill, surface } from './board'
import { boardCopy } from './copy'
import { TaskComposer } from './TaskComposer'
import { detachSession, useTaskDetail, useTaskList } from '../../lib/tasks'
import { DeliveryDetail } from './DeliveryDetail'
import { SessionFiling } from './SessionFiling'
import { BetaTag } from '../BetaTag'

export interface SessionTasksTabProps {
  session: { id: string; title: string; harness?: string; task?: string }
  lang: 'pt' | 'en'
  /** Open a task's own page. Absent where there is nowhere to navigate. */
  onOpenTask?: (taskId: string) => void
  /** The fleet changed — the caller re-reads it, so the badge on the row agrees with this tab. */
  onChanged?: () => void
}

export function SessionTasksTab(p: SessionTasksTabProps) {
  const isMobile = useIsMobile()
  const pt = p.lang === 'pt'
  const { rows, reload } = useTaskList()
  const [composing, setComposing] = useState(false)
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)

  /**
   * The task this session is filed under, matched by NAME.
   *
   * That is what the fleet row carries — the id lives on the session record the server holds, not
   * on the wire — so this is the honest join the browser can make. A session filed under nothing
   * simply matches nothing.
   */
  const current = useMemo(
    () => (p.session.task ? (rows ?? []).find(r => r.task.title === p.session.task) : undefined),
    [rows, p.session.task],
  )

  /**
   * The delivery's own detail, which is where its SUBTASKS and this session's placement live. Only
   * fetched once the session is filed under something — `useTaskDetail` is given no ref otherwise
   * and asks nothing.
   */
  const { detail, reload: reloadDetail } = useTaskDetail(current?.task.id)

  const refresh = async () => { await reload(); await reloadDetail(); p.onChanged?.() }

  /**
   * The PART this session sits in, by name.
   *
   * Read off the delivery's own session rows rather than from anything the fleet carries: the
   * fleet knows the delivery (that is the badge on the row) and nothing about which subtask, and
   * inventing one from the first subtask would name a part nobody chose.
   */
  const here = useMemo(() => {
    const sub = detail?.sessions.find(r => r.id === p.session.id)?.subtaskId
    return sub ? detail?.subtasks.find(t => t.id === sub)?.title : undefined
  }, [detail, p.session.id])

  const unlink = async () => {
    setBusy(true)
    await detachSession(p.session.id, p.session.id)
    setBusy(false)
    await refresh()
  }

  return (
    <div style={{ display: 'grid', gap: 12, padding: 10, alignContent: 'start' }}>
      {/* The caveat rides the FEATURE, not the page: this panel is the board reaching into the
          session workspace, and a reader here never passes the Deliveries header. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={microLabel}>{pt ? 'Entregas' : 'Deliveries'}</span>
        <BetaTag what={pt ? 'A vinculação de tarefas' : 'Filing sessions under tasks'} />
      </div>
      {p.session.task
        ? (
          <>
            {/* The filing bar — the one question that is about the SESSION rather than about the
                delivery, kept above the delivery itself so the two are never confused. */}
            <div style={{ ...surface, padding: 10, display: 'grid', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={microLabel}>{pt ? 'Esta sessão está em' : 'This session is filed under'}</span>
                <span style={{ flex: 1 }} />
                {here && (
                  <span style={{ ...pill(), fontSize: 10 }}>
                    {pt ? 'na parte' : 'in'} {here}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {current && p.onOpenTask && (
                  <button
                    style={{ ...button(isMobile), height: isMobile ? 44 : 26 }} disabled={busy}
                    onClick={() => p.onOpenTask?.(current.task.id)}
                  >
                    <ExternalLink size={13} /> {pt ? 'Abrir no board' : 'Open on the board'}
                  </button>
                )}
                <button
                  style={{ ...button(isMobile), height: isMobile ? 44 : 26 }}
                  disabled={busy} onClick={() => setPicking(true)}
                >
                  <Link2 size={13} /> {pt ? 'Trocar' : 'Change'}
                </button>
                <button
                  style={{ ...button(isMobile), height: isMobile ? 44 : 26, color: 'var(--accent-red)' }}
                  disabled={busy}
                  onClick={() => void unlink()}
                >
                  <Unlink size={13} /> {pt ? 'Desvincular' : 'Unfile'}
                </button>
              </div>
            </div>

            {/* THE DELIVERY ITSELF — the same component the board's own page draws. */}
            {detail
              ? (
                <DeliveryDetail
                  id={detail.task.id}
                  detail={detail}
                  lang={p.lang}
                  reload={refresh}
                  dense
                />
              )
              : (
                <div style={{ ...surface, padding: 12, fontSize: 12, color: 'var(--text-tertiary)' }}>
                  {pt ? 'Carregando a entrega…' : 'Loading the delivery…'}
                </div>
              )}
          </>
        )
        : (
          <div style={{ ...surface, padding: 12, display: 'grid', gap: 9 }}>
            <span style={microLabel}>{pt ? 'Sem entrega' : 'Not filed under a delivery'}</span>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
              {pt
                ? 'Uma sessão fora de uma entrega continua sendo medida — o que não existe é o custo POR entrega. Filie esta a uma subtarefa, ou crie a entrega aqui mesmo.'
                : 'A session outside a delivery is still measured — what does not exist is the cost PER delivery. File this one under a subtask, or create the delivery right here.'}
            </span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button style={button(isMobile)} disabled={busy} onClick={() => setPicking(true)}>
                <Link2 size={13} /> {boardCopy(p.lang).fileUnder}
              </button>
            </div>
          </div>
        )}

      {/* The composer, INLINE — the same form the board opens in a dialog, with this session
          pre-linked. Creating a task from the session you are sitting in should not mean leaving
          it. */}
      <div style={{ ...surface, padding: 12, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={microLabel}>{pt ? 'Nova tarefa para esta sessão' : 'New task for this session'}</span>
          <span style={{ flex: 1 }} />
          {!composing && (
            <button style={{ ...button(isMobile), height: isMobile ? 44 : 26 }} onClick={() => setComposing(true)}>
              <Plus size={13} /> {pt ? 'Criar' : 'Create'}
            </button>
          )}
        </div>
        {composing && (
          <TaskComposer
            inline
            session={{
              id: p.session.id,
              title: p.session.title,
              ...(p.session.harness ? { harness: p.session.harness } : {}),
            }}
            onCancel={() => setComposing(false)}
            onDone={async () => { setComposing(false); await refresh() }}
          />
        )}
      </div>

      {picking && (
        <SessionFiling
          session={p.session}
          lang={p.lang}
          onChanged={refresh}
          {...(p.onOpenTask ? { onOpenTask: p.onOpenTask } : {})}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  )
}
