/**
 * StopSessionConfirm — stopping a session, and the one question worth asking while doing it.
 *
 * The session row used to carry two standing verbs about a DELIVERY: "open the whole task" and
 * "finish task". Both asked about a piece of work at a moment nobody was thinking about one — they
 * sat in the menu forever, were pressed by accident and explained nothing — and "finish" in
 * particular was a switch you had to remember to flip, so deliveries stayed open long after their
 * last session ended.
 *
 * Stopping a session IS the moment somebody knows. So the confirmation asks, once, and only when
 * there is something to ask about.
 *
 * **WHAT IT OFFERS TO FINISH IS THE PART, NOT THE DELIVERY.** A session is filed under a SUBTASK,
 * which is the unit of work — it is the thing this session actually did, and it is the only thing
 * one session can honestly close. A delivery is finished when its parts are, so the delivery is
 * marked delivered ONLY when this was the last open one, and the button SAYS SO before it is
 * pressed: a stop that silently closed a whole delivery because it happened to be the last part is
 * a surprise, and the same act announced beforehand is a decision.
 *
 * A session filed under a delivery whose part cannot be resolved — an older record, a subtask
 * deleted underneath it — keeps the plain confirmation. Offering to finish something this dialog
 * cannot name is the confident guess this codebase refuses everywhere else.
 *
 * ORDER IS LOAD-BEARING: the work is marked FIRST and the session is stopped only if that worked.
 * Stopping first would take away the row this control lives on — `onStop` typically unmounts it —
 * and a mark that then failed would have nowhere to report. A failed mark therefore leaves the
 * session RUNNING and says so: nothing destructive has happened, and "End the session only" is one
 * button away.
 */

import { useMemo } from 'react'
import { AlertTriangle, Check, X } from 'lucide-react'
import { markTask, patchSubtask, useTaskDetail, useTaskList } from '../../lib/tasks'
import { boardCopy, type Lang } from './copy'

export interface StopSessionConfirmProps {
  /** The session, named — a confirmation that does not say what it acts on is one people misread. */
  title: string
  /** The session's id, which is how its PART is found among the delivery's own rows. */
  sessionId: string
  /** The delivery it is filed under, by name — what the fleet row carries. Absent = nothing to ask. */
  task?: string
  lang: Lang
  busy: boolean
  /** Actually stop it. */
  onStop: () => void | Promise<void>
  onCancel: () => void
  /** Say something the caller renders — used only when the work could not be marked. */
  onNotice: (text: string) => void
  /** `stack` for a popover column, `row` for the panel's inline strip. */
  layout?: 'stack' | 'row'
  styles: {
    danger: React.CSSProperties
    plain: React.CSSProperties
  }
}

export function StopSessionConfirm(p: StopSessionConfirmProps) {
  const copy = boardCopy(p.lang)
  const pt = p.lang === 'pt'
  const stacked = (p.layout ?? 'stack') === 'stack'

  /**
   * The delivery, matched by NAME — the id lives on the server's session record, not on the wire,
   * so this is the honest join this side can make. Same rule `SessionFiling` follows.
   */
  const { rows } = useTaskList()
  const filed = useMemo(
    () => (p.task ? (rows ?? []).find(r => r.task.title === p.task) : undefined),
    [rows, p.task],
  )
  const { detail } = useTaskDetail(filed?.task.id)

  /** The PART this session did, and whether finishing it finishes the delivery. */
  const part = useMemo(() => {
    if (!detail) return undefined
    const id = detail.sessions.find(r => r.id === p.sessionId)?.subtaskId
    if (!id) return undefined
    const sub = detail.subtasks.find(t => t.id === id)
    if (!sub || sub.done) return undefined
    // "The last open one" counts the OTHER parts, so a delivery of one part still qualifies.
    const others = detail.subtasks.filter(t => t.id !== sub.id && !t.done)
    return { id: sub.id, title: sub.title, last: others.length === 0 }
  }, [detail, p.sessionId])

  const end = async (finish: boolean) => {
    if (finish && part && filed) {
      const ok = await patchSubtask(filed.task.id, part.id, { status: 'done' })
      if (!ok) { p.onNotice(copy.couldNotMarkDelivered); return }
      // The delivery follows its parts, and only when there are none left open. Its failure is
      // reported and does NOT hold up the stop: the part is already closed, and leaving the
      // session running over a delivery status would be the wrong thing to protect.
      if (part.last) {
        const closed = await markTask(filed.task.id, 'done')
        if (!closed) p.onNotice(copy.couldNotMarkDelivered)
      }
    }
    await p.onStop()
  }

  return (
    <div style={{
      display: 'flex', gap: stacked ? 10 : 8, alignItems: stacked ? 'stretch' : 'center',
      flexDirection: stacked ? 'column' : 'row', flexWrap: stacked ? 'nowrap' : 'wrap',
      ...(stacked ? { padding: 8 } : {}),
    }}>
      <span style={{
        display: 'inline-flex', alignItems: 'flex-start', gap: 6,
        fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-primary)',
      }}>
        <AlertTriangle size={13} style={{ color: 'var(--accent-red)', flexShrink: 0, marginTop: 2 }} />
        <span>
          {copy.endSession} {copy.endSessionWhat}
          {part && (
            <>
              <br />
              <span style={{ color: 'var(--text-tertiary)' }}>
                {copy.partQuestion} <strong style={{ color: 'var(--text-secondary)' }}>{part.title}</strong>
                {part.last && ` — ${copy.lastPart}`}
              </span>
            </>
          )}
        </span>
      </span>

      <div style={{
        display: 'flex', gap: 6, flexWrap: 'wrap',
        justifyContent: stacked ? 'flex-end' : 'flex-start',
      }}>
        <button onClick={p.onCancel} style={p.styles.plain}>
          <X size={13} /> {pt ? 'Cancelar' : 'Cancel'}
        </button>
        {/* Two ways out when there IS a part, and the destructive colour goes on the one that only
            stops — marking work done is not the dangerous half. */}
        <button disabled={p.busy} onClick={() => void end(false)} style={p.styles.danger}>
          <X size={13} /> {part ? copy.endOnly : (pt ? 'Encerrar' : 'End')}
        </button>
        {part && (
          <button disabled={p.busy} onClick={() => void end(true)} style={p.styles.plain}>
            <Check size={13} /> {part.last ? copy.endAndDeliver : copy.endAndFinishPart}
          </button>
        )}
      </div>
    </div>
  )
}
