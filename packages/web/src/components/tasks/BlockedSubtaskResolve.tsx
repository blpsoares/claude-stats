/**
 * BlockedSubtaskResolve — "this subtask is still blocked; did you finish the blocker and forget to
 * mark it?"
 *
 * Asked for directly: filing a session under a blocked subtask is refused server-side
 * (`task-attach.ts`'s `planAttach`, `reason: 'blocked'`), and a bare refusal teaches nothing — the
 * common case on a board several people and agents drive is exactly this: the work got done, the
 * card never got moved. So the refusal opens THIS, rather than a dead end.
 *
 * THREE STEPS, and the middle one repeats per blocker that still has a session running:
 *
 *  1. Say which subtask(s) are still open, and ask whether they are actually finished.
 *     "No" cancels outright — the attach stays refused, and rightly so.
 *  2. For each unmet blocker that has a session GENUINELY LIVE in the fleet (not merely
 *     un-ended in the store — a `lost` row is not "open" in the sense this question means),
 *     name it, say when it last spoke and what it is doing, and ask whether to end it. Skipped
 *     entirely when no blocker has one.
 *  3. Mark every confirmed blocker `done` and hand back to the caller, which retries the attach
 *     that was refused a moment ago — now it succeeds, because the thing that was blocking it no
 *     longer is.
 *
 * ORDER: sessions first, subtasks last. Ending a session and then failing to mark the subtask done
 * would leave the work stopped AND still reading as blocked — the worse of the two possible
 * failures, since nothing about it looks wrong from the board.
 */

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Check, X } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { overlayPadding } from '../../lib/mobileOverlay'
import { useFleet, type FleetRow } from '../../lib/fleet'
import { messageTime } from '../../lib/messageTime'
import { patchSubtask, type Subtask, type TaskSessionRow } from '../../lib/tasks'
import { button, pill, surface, SESSION_STATE } from './board'
import { BetaTag } from '../BetaTag'

export interface BlockedSubtaskResolveProps {
  taskId: string
  /** The subtask whose attach was refused — named so the question reads as an answer to it. */
  blockedSubtaskTitle: string
  /** The unmet blocker ids `task-attach.ts` named. */
  blockedBy: string[]
  /** The delivery's own subtasks — resolves the ids above to titles and status. */
  subtasks: readonly Subtask[]
  /** The delivery's own sessions — finds each blocker's, if any. */
  sessions: readonly TaskSessionRow[]
  lang: 'pt' | 'en'
  /** The refused attach is retried by the CALLER — this component decides nothing about it. */
  onResolved: () => void | Promise<void>
  onCancel: () => void
}

/** LIVE, in the sense this question means: the fleet still holds it and it has not finished. */
const LIVE_STATES = new Set(['working', 'waiting', 'waiting-approval'])

type OpenSession = { blocker: Subtask; row: FleetRow }

export function BlockedSubtaskResolve(p: BlockedSubtaskResolveProps) {
  const isMobile = useIsMobile()
  const pt = p.lang === 'pt'
  const { fleet } = useFleet(p.lang)
  const fleetRows = fleet.sessions ?? []
  const [step, setStep] = useState<'confirm' | 'session' | 'finishing'>('confirm')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Built once, on "yes" — the fleet can move under us while this dialog is open, but the question
  // it is answering must not.
  const [queue, setQueue] = useState<OpenSession[] | null>(null)
  const [lastMsg, setLastMsg] = useState<string | null>(null)

  const blockers = p.blockedBy
    .map(id => p.subtasks.find(s => s.id === id))
    .filter((s): s is Subtask => s !== undefined)

  const finishBlockers = async (ids: readonly string[]) => {
    setStep('finishing')
    const ok = await Promise.all(
      ids.map(id => patchSubtask(p.taskId, id, { status: 'done' })),
    )
    if (ok.every(Boolean)) { await p.onResolved(); return }
    setError(pt
      ? 'Não foi possível marcar todos os bloqueios como concluídos. Nada foi perdido — tente de novo.'
      : 'Could not mark every blocker done. Nothing was lost — try again.')
    setStep('confirm')
  }

  const alreadyFinished = () => {
    // Every session any blocker has, LIVE in the fleet — a `lost`/`exited`/unknown row is not
    // "open" in the sense this question means, and offering to close it would ask about a session
    // that, as far as this machine can tell right now, is not actually running.
    const found: OpenSession[] = []
    for (const blocker of blockers) {
      const rowIds = new Set(p.sessions.filter(s => s.subtaskId === blocker.id).map(s => s.id))
      for (const fr of fleetRows) {
        if (rowIds.has(fr.id) && LIVE_STATES.has(fr.state)) found.push({ blocker, row: fr })
      }
    }
    if (found.length === 0) { void finishBlockers(blockers.map(b => b.id)); return }
    setQueue(found)
    setStep('session')
    void loadLastMessage(found[0]!.row.id)
  }

  const loadLastMessage = async (sessionId: string) => {
    setLastMsg(null)
    try {
      const res = await fetch(`/api/fleet/chat?id=${encodeURIComponent(sessionId)}&lang=${p.lang}`)
      if (!res.ok) return
      const body = await res.json() as { turns?: { at?: string }[] }
      const at = [...(body.turns ?? [])].reverse().find(t => t.at)?.at
      const t = messageTime(at, p.lang)
      setLastMsg(t?.full ?? null)
    } catch { /* the question still works without it — it just says less */ }
  }

  const answerSession = async (close: boolean) => {
    const [current, ...rest] = queue ?? []
    if (!current) return
    if (close) {
      setBusy(true)
      await fetch('/api/fleet/act', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: current.row.id, action: 'kill' }),
      }).catch(() => undefined)
      setBusy(false)
    }
    if (rest.length > 0) {
      setQueue(rest)
      void loadLastMessage(rest[0]!.row.id)
      return
    }
    await finishBlockers(blockers.map(b => b.id))
  }

  const current = queue?.[0]
  const st = current ? SESSION_STATE[current.row.state] : undefined

  return createPortal(
    <div
      role="dialog" aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 999, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.5)', padding: overlayPadding(isMobile, 16),
      }}
    >
      <div style={{
        ...surface, background: 'var(--bg-elevated)', boxShadow: 'var(--shadow-elevated)',
        padding: 16, display: 'grid', gap: 12, alignContent: 'start',
        width: isMobile ? '100%' : 'min(440px, 92vw)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <AlertTriangle size={15} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />
          <span style={{ fontSize: 13.5, fontWeight: 650, color: 'var(--text-primary)', flex: 1 }}>
            {pt ? 'Subtarefa bloqueada' : 'Subtask blocked'}
          </span>
          <BetaTag what={pt ? 'A vinculação de tarefas' : 'Filing sessions under tasks'} />
        </div>

        {step === 'confirm' && (
          <>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
              {pt
                ? <>“<strong>{p.blockedSubtaskTitle}</strong>” ainda está bloqueada por:</>
                : <>“<strong>{p.blockedSubtaskTitle}</strong>” is still blocked by:</>}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {blockers.map(b => <span key={b.id} style={pill('var(--accent-red)')}>{b.title}</span>)}
            </div>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
              {pt
                ? 'Você já finalizou e esqueceu de marcar como concluída?'
                : 'Did you already finish that and forget to mark it done?'}
            </p>
            {error && <p style={{ margin: 0, fontSize: 11.5, color: 'var(--accent-red)' }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={button(isMobile)} onClick={p.onCancel}>
                <X size={13} /> {pt ? 'Cancelar' : 'Cancel'}
              </button>
              <button style={button(isMobile, 'primary')} onClick={alreadyFinished}>
                <Check size={13} /> {pt ? 'Sim, já finalizei' : 'Yes, I already finished it'}
              </button>
            </div>
          </>
        )}

        {step === 'session' && current && (
          <>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
              {pt
                ? <>Há uma sessão vinculada a “<strong>{current.blocker.title}</strong>”:</>
                : <>There is a session linked to “<strong>{current.blocker.title}</strong>”:</>}
            </p>
            <div style={{ ...surface, padding: 10, display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
                {current.row.title}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                {st && <span style={pill(st.color)}>{st.label}</span>}
                <span style={{ color: 'var(--text-tertiary)' }}>
                  {pt ? 'Última mensagem: ' : 'Last message: '}
                  {lastMsg ?? (pt ? 'lendo…' : 'reading…')}
                </span>
              </span>
            </div>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
              {pt ? 'Deseja encerrá-la?' : 'Do you want to end it?'}
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={button(isMobile)} disabled={busy} onClick={() => void answerSession(false)}>
                {pt ? 'Não' : 'No'}
              </button>
              <button
                style={{ ...button(isMobile, 'primary'), background: 'var(--accent-red)' }}
                disabled={busy} onClick={() => void answerSession(true)}
              >
                <X size={13} /> {pt ? 'Sim, encerrar' : 'Yes, end it'}
              </button>
            </div>
          </>
        )}

        {step === 'finishing' && (
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            {pt ? 'Marcando como concluída…' : 'Marking it done…'}
          </p>
        )}
      </div>
    </div>,
    document.body,
  )
}
