/**
 * MachineFleetPanel.tsx — one machine's session fleet, relayed to its owning account, and the
 * screenless verbs performed on it.
 *
 * It is a PANEL and not a drawer because it now has two hosts: the machine's row in Settings
 * (`MachineFleetDrawer`, which is this plus the drawer chrome) and the SESSIONS page of a central,
 * where managing a machine's sessions is what a person actually came for. A second implementation
 * of the list would be a second set of rules about what a relayed row may show and which verbs it
 * may offer — the duplication this repo keeps paying to remove.
 *
 * The verbs come from the MACHINE, already decided and already worded: it narrows its own
 * `sessionActions` to what may be driven remotely (`machineActions.ts`) before the row is even
 * built, so a button that appears here is one the machine has agreed to. `approve` and `prompt`
 * are absent by construction — they cannot be offered without the session's screen, and the
 * screen does not travel; the panel says that in words rather than showing a disabled button
 * that implies it is coming back.
 *
 * A verb that takes TEXT asks for it first. A rename or a note is the user's own words about
 * their own work, so it is typed here and sent once — never a blank submit.
 *
 * Every sentence comes from the pure `machineFleetPanelView`, which keeps the four refusals and the
 * one real "no sessions" apart. Nothing here may render an empty list for a fleet nobody managed to
 * read — the same N/A-versus-a-confident-0 rule the dashboard applies to harness capabilities.
 *
 * The screen and the conversation are ABSENT by construction, not hidden: the row that crosses the
 * wire is built by an allowlist (`reduceMachineFleetRow`), so there is nothing to leave out here.
 */

import { useEffect, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import type { MachineActionReply, MachineFleetAnswer, MachineFleetRow } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { machineFleetPanelView } from './machineFleetView'
import { OVERLAY_TOP } from '../../lib/mobileOverlay'

export function MachineFleetPanel({ open, machineId, lang, onlyRow, hideHeader }: {
  /** False keeps the panel silent: the request makes the machine build a real fleet (a tmux round
   *  trip per session), so it is never issued behind something nobody is looking at. */
  open: boolean
  machineId: string
  lang: 'en' | 'pt'
  /**
   * Render the verbs of ONE row and nothing else.
   *
   * The central's Sessions page draws the fleet with `SessionsAside` — the real list — and opens
   * this for whichever row was tapped. Without it the page showed the fleet TWICE, in two
   * different shapes, which is what "tá listando as sessões de outra forma" meant.
   */
  onlyRow?: string
  /** Withholds the "asking the machine / refresh" strip, when a host already has one. */
  hideHeader?: boolean
}) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const [answer, setAnswer] = useState<MachineFleetAnswer | null>(null)
  const [loading, setLoading] = useState(false)
  /** The verb in flight, keyed `<sessionId>:<action>` — so only the pressed button reports busy. */
  const [acting, setActing] = useState<string | null>(null)
  /** The machine's own last sentence about a verb. Kept until the next act: an outcome that
   *  vanishes on the next repaint is one the user may never have read. */
  const [outcome, setOutcome] = useState<MachineActionReply | null>(null)
  /** A verb that needs words, waiting for them. */
  const [asking, setAsking] = useState<{ row: MachineFleetRow; action: string; label: string } | null>(null)
  const [draft, setDraft] = useState('')

  async function load() {
    setLoading(true)
    try {
      const res = await fetch(`/api/team/machine-fleet?machineId=${encodeURIComponent(machineId)}`)
      setAnswer(res.ok ? ((await res.json()) as MachineFleetAnswer) : null)
    } catch {
      // `null` is its own sentence in machineFleetPanelView — never an empty list.
      setAnswer(null)
    } finally {
      setLoading(false)
    }
  }

  // Asked ONLY while the drawer is open. The request travels to another machine and makes it build
  // a real fleet (a tmux round trip per session), so it is a deliberate act, never a poll running
  // behind a closed panel.
  useEffect(() => {
    if (!open || !machineId) return
    setAnswer(null)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, machineId])

  /** Verbs whose meaning IS the text they carry. Sent blank they would clear a name or a note,
   *  which is a destructive edit nobody asked for. */
  const NEEDS_TEXT = new Set(['rename', 'note', 'task'])

  async function act(row: MachineFleetRow, action: string, text?: string) {
    if (acting) return
    setActing(`${row.id}:${action}`)
    setOutcome(null)
    try {
      const res = await fetch('/api/team/machine-fleet/act', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId, id: row.id, action, ...(text !== undefined ? { text } : {}) }),
      })
      const body = res.ok ? ((await res.json()) as { reply: MachineActionReply | null; reason?: string }) : null
      setOutcome(body?.reply ?? {
        ok: false,
        // The route's own refusal has no sentence of its own — it answers a reason code, because
        // the wording of a real refusal belongs to the machine. This is the one case where there
        // is no machine answer to show.
        message: pt ? 'A máquina não respondeu a esta ação.' : 'The machine did not answer this action.',
      })
    } catch {
      setOutcome({ ok: false, message: pt ? 'A máquina não respondeu a esta ação.' : 'The machine did not answer this action.' })
    } finally {
      setActing(null)
      // Re-read: a kill or a rename changes the very list that was just drawn.
      void load()
    }
  }

  const view = machineFleetPanelView(answer, lang)
  const allRows = answer?.reply?.rows ?? []
  const rows = onlyRow ? allRows.filter(r => r.id === onlyRow) : allRows

  // A FRAGMENT: the list and the "type the words" dialog are siblings, and the drawer used to be
  // the thing holding them together.
  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!hideHeader && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>
            {loading ? (pt ? 'Perguntando à máquina…' : 'Asking the machine…') : view.text}
          </strong>
          <button
            type="button"
            onClick={() => { void load() }}
            disabled={loading}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              minHeight: isMobile ? 44 : 28, padding: isMobile ? '0 14px' : '0 10px',
              borderRadius: 7, border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 11.5,
              cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.6 : 1,
            }}
          >
            {loading
              ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
              : <RefreshCw size={12} />}
            {pt ? 'Atualizar' : 'Refresh'}
          </button>
        </div>
        )}

        {/* The machine's own caveat, and what its sharing rules withheld. Two different facts, and
            neither is a fault — one is a limit the machine reported, the other is the user's own
            rule. Neither wears an alarm colour. */}
        {!hideHeader && view.notes.map(note => (
          <p key={note} style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
            {note}
          </p>
        ))}

        {rows.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.map(r => (
              <div
                key={r.id}
                style={{
                  display: 'flex', flexDirection: 'column', gap: 4,
                  padding: '10px 12px', borderRadius: 8,
                  border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  {/* `overflowWrap`, not nowrap: a session title plus a state word overflows a
                      390px drawer, and the page body must never scroll horizontally. */}
                  <strong style={{ fontSize: 12.5, overflowWrap: 'anywhere', minWidth: 0 }}>{r.title}</strong>
                  <span style={{
                    flexShrink: 0, padding: '1px 7px', borderRadius: 999,
                    fontSize: 10, fontWeight: 700,
                    border: `1px solid ${r.state === 'waiting-approval' || r.state === 'waiting' ? 'var(--anthropic-orange)' : 'var(--border)'}`,
                    color: r.state === 'waiting-approval' || r.state === 'waiting' ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                  }}>
                    {/* The word the MACHINE resolved, in its own language — never re-derived here. */}
                    {r.stateLabel}
                  </span>
                </div>
                {/* Built from the parts that ACTUALLY have a value. A row can legitimately arrive
                    thin — the machine's first fleet build of a cold process has not resolved its
                    harness or repo facts yet, and it fills in on the next ask — and joining fixed
                    parts printed a bare " · " that reads as a broken cell rather than as a fact
                    nobody has yet. */}
                {[r.harness, r.model, r.cwd].filter(Boolean).length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
                    {[r.harness, r.model, r.cwd].filter(Boolean).join(' · ')}
                  </div>
                )}
                {(r.task || r.note) && (
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>
                    {r.task ? `${pt ? 'Tarefa' : 'Task'}: ${r.task}` : ''}
                    {r.task && r.note ? ' · ' : ''}
                    {r.note ? `${pt ? 'Nota' : 'Note'}: ${r.note}` : ''}
                  </div>
                )}

                {(r.verbs?.length ?? 0) > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                    {r.verbs!.map(v => (
                      <button
                        key={v.action}
                        type="button"
                        // The machine's own sentence for why it is off. A refused verb that
                        // explains nothing is indistinguishable from a broken control.
                        title={v.enabled ? undefined : v.reason}
                        disabled={!v.enabled || acting !== null}
                        onClick={() => {
                          if (NEEDS_TEXT.has(v.action)) {
                            setDraft(v.action === 'rename' ? r.title : v.action === 'note' ? (r.note ?? '') : (r.task ?? ''))
                            setAsking({ row: r, action: v.action, label: v.label })
                            return
                          }
                          void act(r, v.action)
                        }}
                        style={{
                          minHeight: isMobile ? 44 : 26,
                          padding: isMobile ? '0 14px' : '0 9px',
                          borderRadius: 6, fontFamily: 'inherit', fontSize: 11,
                          border: '1px solid var(--border)', background: 'transparent',
                          // `kill` is the only destructive one here and wears the fault colour, so
                          // it cannot be pressed by muscle memory for the one beside it.
                          color: v.action === 'kill' ? 'var(--accent-red)' : 'var(--text-secondary)',
                          cursor: v.enabled && acting === null ? 'pointer' : 'default',
                          opacity: v.enabled && acting === null ? 1 : 0.5,
                        }}
                      >
                        {acting === `${r.id}:${v.action}`
                          ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
                          : v.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* The machine's own last word on a verb. Kept until the next act rather than flashing:
            an outcome that vanishes on the next repaint is one the user may never have read. */}
        {outcome && (
          <div
            role="status"
            style={{
              padding: '8px 10px', borderRadius: 7, fontSize: 11.5, lineHeight: 1.5,
              color: outcome.ok ? 'var(--accent-green)' : 'var(--anthropic-orange)',
              background: `color-mix(in srgb, ${outcome.ok ? 'var(--accent-green)' : 'var(--anthropic-orange)'} 10%, transparent)`,
              overflowWrap: 'anywhere',
            }}
          >
            {outcome.message}
          </div>
        )}

        {/* Said once, at the bottom. `approve` and `prompt` are ABSENT rather than greyed out: a
            disabled button implies the thing behind it exists and is merely off, and the screen
            genuinely does not travel. */}
        <p style={{ margin: 0, fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
          {pt
            ? 'A tela e a conversa das sessões não saem da máquina — por isso não dá para responder a um pedido de permissão daqui.'
            : 'A session’s screen and conversation never leave the machine — which is why a permission prompt cannot be answered from here.'}
        </p>
      </div>

      {/* A verb whose meaning IS its text asks for the words first. Sent blank it would CLEAR a
          name or a note, which is a destructive edit nobody pressed a button for. */}
      {asking && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.55)', padding: isMobile ? OVERLAY_TOP : 24,
        }}>
          <div style={{
            width: isMobile ? '100%' : 420, maxWidth: '100%',
            height: isMobile ? '100%' : 'auto',
            display: 'flex', flexDirection: 'column', gap: 12, justifyContent: isMobile ? 'center' : undefined,
            padding: 18, borderRadius: isMobile ? 0 : 10,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          }}>
            <strong style={{ fontSize: 13 }}>{asking.label}</strong>
            <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
              {asking.row.title}
            </span>
            <input
              autoFocus
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { setAsking(null); return }
                if (e.key === 'Enter' && draft.trim()) {
                  const a = asking
                  setAsking(null)
                  void act(a.row, a.action, draft.trim())
                }
              }}
              style={{
                // 16px is not a preference: anything smaller makes iOS Safari zoom the viewport
                // and break the sticky header behind this dialog.
                fontSize: 16, fontFamily: 'inherit', minHeight: 44,
                padding: '0 10px', borderRadius: 7,
                border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                color: 'var(--text-primary)',
              }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => setAsking(null)}
                style={{
                  minHeight: isMobile ? 44 : 30, padding: '0 14px', borderRadius: 7,
                  border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12, cursor: 'pointer',
                }}
              >
                {pt ? 'Cancelar' : 'Cancel'}
              </button>
              <button
                type="button"
                disabled={!draft.trim()}
                onClick={() => { const a = asking; setAsking(null); void act(a.row, a.action, draft.trim()) }}
                style={{
                  minHeight: isMobile ? 44 : 30, padding: '0 14px', borderRadius: 7,
                  border: '1px solid var(--anthropic-orange)', background: 'transparent',
                  color: 'var(--anthropic-orange)', fontFamily: 'inherit', fontSize: 12, fontWeight: 700,
                  cursor: draft.trim() ? 'pointer' : 'default', opacity: draft.trim() ? 1 : 0.5,
                }}
              >
                {pt ? 'Enviar' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
