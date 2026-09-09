/**
 * StopSessionConfirm — stopping a session, and the one question worth asking while doing it.
 *
 * The session row used to carry two standing verbs about the delivery: "open the whole task" and
 * "finish task". Both asked about a piece of work at a moment nobody was thinking about one — they
 * sat in the menu forever, were pressed by accident and explained nothing — and "finish" in
 * particular was a switch you had to remember to flip, so deliveries stayed open long after their
 * last session ended.
 *
 * Stopping a session IS the moment somebody knows. So the confirmation asks, once, and only when
 * there is something to ask about: a session filed under a delivery offers two ways to end, and one
 * filed under nothing keeps the plain confirmation it always had.
 *
 * ORDER IS LOAD-BEARING: the delivery is marked FIRST and the session is stopped only if that
 * worked. Stopping first would take away the row this control lives on — `onStop` typically
 * unmounts it — and a mark that then failed would have nowhere to report. A failed mark therefore
 * leaves the session RUNNING and says so: nothing destructive has happened, and "End the session
 * only" is one button away.
 */

import { AlertTriangle, Check, X } from 'lucide-react'
import { markTask } from '../../lib/tasks'
import { boardCopy, type Lang } from './copy'

export interface StopSessionConfirmProps {
  /** The session, named — a confirmation that does not say what it acts on is one people misread. */
  title: string
  /** The delivery it is filed under. Absent = nothing to ask about. */
  task?: string
  lang: Lang
  busy: boolean
  /** Actually stop it. */
  onStop: () => void | Promise<void>
  onCancel: () => void
  /** Say something the caller renders — used only when the delivery could not be marked. */
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
  const stacked = (p.layout ?? 'stack') === 'stack'

  const end = async (deliver: boolean) => {
    if (deliver && p.task) {
      const ok = await markTask(p.task, 'done')
      if (!ok) { p.onNotice(copy.couldNotMarkDelivered); return }
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
          {p.task && (
            <>
              <br />
              <span style={{ color: 'var(--text-tertiary)' }}>
                {copy.deliveredQuestion} — <strong style={{ color: 'var(--text-secondary)' }}>{p.task}</strong>
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
          <X size={13} /> {p.lang === 'pt' ? 'Cancelar' : 'Cancel'}
        </button>
        {/* Two ways out when there IS a delivery, and the destructive colour goes on the one that
            only stops — marking work delivered is not the dangerous half. */}
        <button disabled={p.busy} onClick={() => void end(false)} style={p.styles.danger}>
          <X size={13} /> {p.task ? copy.endOnly : (p.lang === 'pt' ? 'Encerrar' : 'End')}
        </button>
        {p.task && (
          <button disabled={p.busy} onClick={() => void end(true)} style={p.styles.plain}>
            <Check size={13} /> {copy.endAndDeliver}
          </button>
        )}
      </div>
    </div>
  )
}
