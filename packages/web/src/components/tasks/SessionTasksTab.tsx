/**
 * SessionTasksTab — what this session is FILED UNDER, and the form to file it somewhere new.
 *
 * The session workspace could tell you a session belonged to a task (a badge on the row) and gave
 * you nowhere to act on it: unfiling meant hunting through a menu, and creating a task from the
 * session you were sitting in meant leaving it for the board. So the tab is both — the task's own
 * numbers, the way out, and the SAME composer the board's "New task" opens, with this session
 * already linked.
 *
 * It shows the task's rollup rather than repeating the session's: the point of filing a session is
 * that the TASK becomes measurable, and the tab is where you see that it worked.
 */

import { useMemo, useState } from 'react'
import { ExternalLink, Link2, Plus, Unlink } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import {
  NA, STATUS, button, fmtInt, fmtUSD, microLabel, numeric, pill, surface, type BoardStatus,
} from './board'
import { TaskProgressBar } from './TaskProgressBar'
import { boardCopy } from './copy'
import { TaskComposer } from './TaskComposer'
import { attachSession, detachSession, useTaskDetail, useTaskList } from '../../lib/tasks'
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

  const link = async (taskId: string) => {
    setBusy(true)
    await attachSession(taskId, p.session.id)
    setBusy(false)
    await refresh()
  }

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
          <div style={{ ...surface, padding: 12, display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={microLabel}>{pt ? 'Esta sessão está em' : 'This session is filed under'}</span>
              <span style={{ flex: 1 }} />
              {current && (
                <span style={pill(STATUS[current.task.status as BoardStatus]?.color)}>
                  {STATUS[current.task.status as BoardStatus]?.label ?? current.task.status}
                </span>
              )}
            </div>
            <div style={{ fontSize: 13.5, fontWeight: 650, color: 'var(--text-primary)' }}>
              {p.session.task}
            </div>

            {current && (
              <>
                <TaskProgressBar
                  done={current.counts.subtasksDone}
                  total={current.counts.subtasks}
                />
                {/* The TASK's numbers, not this session's. Filing a session is what makes the task
                    measurable, and this is where you see that it worked. */}
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {([
                    [pt ? 'Custo' : 'Cost', fmtUSD(current.rollup.costUSD)],
                    [pt ? 'Rodadas' : 'Rounds', fmtInt(current.rollup.rounds)],
                    [pt ? 'Sessões' : 'Sessions', String(current.rollup.sessionsUsed)],
                  ] as const).map(([label, value]) => (
                    <span key={label}>
                      <span style={{ ...microLabel, display: 'block' }}>{label}</span>
                      <span style={{
                        ...numeric, display: 'block',
                        color: value === NA ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                      }}>{value}</span>
                    </span>
                  ))}
                </div>
              </>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {current && p.onOpenTask && (
                <button
                  style={button(isMobile)} disabled={busy}
                  onClick={() => p.onOpenTask?.(current.task.id)}
                >
                  <ExternalLink size={13} /> {pt ? 'Abrir a tarefa' : 'Open the task'}
                </button>
              )}
              <button style={button(isMobile)} disabled={busy} onClick={() => setPicking(true)}>
                <Link2 size={13} /> {pt ? 'Trocar' : 'Change'}
              </button>
              <button
                style={{ ...button(isMobile), color: 'var(--accent-red)' }}
                disabled={busy}
                onClick={() => void unlink()}
              >
                <Unlink size={13} /> {pt ? 'Desvincular' : 'Unfile'}
              </button>
            </div>
          </div>
        )
        : (
          <div style={{ ...surface, padding: 12, display: 'grid', gap: 9 }}>
            <span style={microLabel}>{pt ? 'Sem tarefa' : 'Not filed under a task'}</span>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
              {pt
                ? 'Uma sessão fora de uma tarefa continua sendo medida — o que não existe é o custo POR entrega. Vincule esta a uma tarefa, ou crie uma aqui mesmo.'
                : 'A session outside a task is still measured — what does not exist is the cost PER delivery. File this one under a task, or create one right here.'}
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
