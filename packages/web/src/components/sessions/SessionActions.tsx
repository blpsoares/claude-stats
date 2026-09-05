/**
 * SessionActions — the verbs for one session, in the panel's header.
 *
 * IT DECIDES NOTHING. Every verb, its label, whether it is enabled and why not all arrive already
 * decided on the fleet row, resolved by the same `sessionActions` the terminal cockpit resolves
 * every keypress against. A browser-side re-derivation would be a second set of rules, and it goes
 * wrong in the expensive direction — offering `approve` on a numbered dialog belonging to a harness
 * with no verified way to pick, where the keystroke takes whichever row happens to be highlighted.
 *
 * A DISABLED VERB IS SHOWN, NOT REMOVED. That is the cockpit's call and the reasoning carries: with
 * a fleet agentop did not start, a menu that drops from eight verbs to three reads as a broken
 * feature, and absence says nothing about WHY. So it is dimmed, unclickable, and carries the row's
 * own sentence when the row has one.
 *
 * `kill` ASKS FIRST. It is the one verb here that destroys work, and the confirmation is inline
 * rather than a modal so the row it acts on stays on screen while the question is being answered.
 */

import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal, X } from 'lucide-react'
import type { FleetActionId, FleetRow, FleetVerb } from '../../lib/fleet'

export interface SessionActionsProps {
  row: FleetRow
  lang: 'pt' | 'en'
  act: (req: { id: string; action: FleetActionId; text?: string; choice?: number })
    => Promise<{ ok: boolean; message: string; id?: string }>
  /** Called after a verb that removes the row, so the panel can step away from it. */
  onGone?: () => void
  /**
   * An action created a session and this is where it is. Absent on a surface with nowhere to go —
   * the action still runs, it simply does not navigate.
   */
  onOpened?: (id: string) => void
}

/** The verbs that take a line of text before they can run. */
const TEXT_VERBS = new Set<string>(['rename', 'note', 'task'])

/** Shown in the menu, in this order. `prompt` and `approve` have their own places in the chat. */
const MENU_ORDER: string[] = ['rename', 'note', 'task', 'openTask', 'finishTask', 'resume', 'kill']

export function SessionActions({ row, lang, act, onGone, onOpened }: SessionActionsProps) {
  const pt = lang === 'pt'
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState<FleetVerb | null>(null)
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // A different row is a different set of answers: an in-flight rename must not carry across.
  useEffect(() => {
    setOpen(false); setAsking(null); setDraft(''); setConfirming(false); setNotice(null)
  }, [row.id])

  useEffect(() => { if (asking) inputRef.current?.focus() }, [asking])

  const verbs = MENU_ORDER
    .map(a => row.verbs.find(v => v.action === a))
    .filter((v): v is FleetVerb => v !== undefined)

  async function run(action: FleetActionId, text?: string) {
    setBusy(true)
    const out = await act({ id: row.id, action, ...(text !== undefined ? { text } : {}) })
    setBusy(false)
    setNotice(out.message)
    if (!out.ok) return
    setAsking(null); setDraft(''); setConfirming(false); setOpen(false)
    if (action === 'kill') onGone?.()
    // A REOPEN LANDS SOMEWHERE. It mints a NEW row and retires the one it was asked about, so
    // staying put leaves the reader on a dead session with a success message over it — reported as
    // "the reopen did nothing". The server hands back the new id precisely so this can follow it.
    if (action === 'resume' && out.id) onOpened?.(out.id)
  }

  function pick(v: FleetVerb) {
    if (!v.enabled) return
    setNotice(null)
    if (TEXT_VERBS.has(v.action)) {
      // Seeded with what the row already has, so renaming is an edit rather than a retype.
      setDraft(v.action === 'rename' ? row.title : v.action === 'note' ? (row.note ?? '') : (row.task ?? ''))
      setAsking(v)
      return
    }
    if (v.action === 'kill') { setConfirming(true); return }
    void run(v.action as FleetActionId)
  }

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen(v => !v)}
        aria-label={pt ? 'Ações da sessão' : 'Session actions'}
        title={pt ? 'Ações da sessão' : 'Session actions'}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 32, height: 32, borderRadius: 9, cursor: 'pointer',
          border: '1px solid var(--border-subtle)', background: 'transparent',
          color: 'var(--text-secondary)',
        }}
      >
        <MoreHorizontal size={16} />
      </button>

      {open && (
        <>
          {/* Click-away. A popover that closes only on its own trigger is one people close by
              navigating away from the page. */}
          <div onClick={() => { setOpen(false); setAsking(null); setConfirming(false) }}
               style={{ position: 'fixed', inset: 0, zIndex: 20 }} />
          <div style={{
            position: 'absolute', top: '100%', right: 0, zIndex: 21, marginTop: 6,
            minWidth: 240, maxWidth: 320,
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            borderRadius: 12, padding: 5, boxShadow: 'var(--ag-shadow-menu)',
          }}>
            {asking ? (
              <form
                onSubmit={e => { e.preventDefault(); void run(asking.action as FleetActionId, draft.trim()) }}
                style={{ padding: 6, display: 'flex', flexDirection: 'column', gap: 8 }}
              >
                <label style={{
                  fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
                  letterSpacing: '0.05em', color: 'var(--text-tertiary)',
                }}>
                  {asking.label}
                </label>
                <input
                  ref={inputRef}
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') { setAsking(null); setDraft('') } }}
                  style={{
                    width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
                    border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
                    color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13, outline: 'none',
                  }}
                />
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button type="button" onClick={() => { setAsking(null); setDraft('') }} style={ghostBtn}>
                    {pt ? 'Cancelar' : 'Cancel'}
                  </button>
                  <button type="submit" disabled={busy} style={primaryBtn}>
                    {pt ? 'Salvar' : 'Save'}
                  </button>
                </div>
              </form>
            ) : confirming ? (
              <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-primary)' }}>
                  {pt
                    ? 'Encerrar esta sessão? O que ela estiver fazendo para agora.'
                    : 'End this session? Whatever it is doing stops now.'}
                </p>
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button onClick={() => setConfirming(false)} style={ghostBtn}>
                    {pt ? 'Cancelar' : 'Cancel'}
                  </button>
                  <button
                    onClick={() => void run('kill')}
                    disabled={busy}
                    style={{ ...primaryBtn, background: 'var(--accent-red)' }}
                  >
                    <X size={13} />
                    {pt ? 'Encerrar' : 'End'}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {verbs.map(v => (
                  <button
                    key={v.action}
                    onClick={() => pick(v)}
                    disabled={!v.enabled}
                    title={v.reason}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
                      width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 8,
                      border: 'none', background: 'transparent',
                      color: v.enabled
                        ? (v.action === 'kill' ? 'var(--accent-red)' : 'var(--text-primary)')
                        : 'var(--text-tertiary)',
                      cursor: v.enabled ? 'pointer' : 'default',
                      opacity: v.enabled ? 1 : 0.6,
                      fontFamily: 'inherit', fontSize: 12.5,
                    }}
                    onMouseEnter={e => { if (v.enabled) e.currentTarget.style.background = 'var(--bg-elevated)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                  >
                    <span>{v.label}</span>
                    {/* The row's OWN sentence for why it cannot take this verb. A control that
                        refuses silently is indistinguishable from one that is broken. */}
                    {!v.enabled && v.reason && (
                      <span style={{ fontSize: 10.5, lineHeight: 1.4, color: 'var(--text-tertiary)' }}>
                        {v.reason}
                      </span>
                    )}
                  </button>
                ))}
                {/* Attaching hands over a real terminal, which a browser tab does not have. The
                    command is offered instead of a button that cannot work. */}
                <div style={{
                  margin: '5px 5px 3px', paddingTop: 8, borderTop: '1px solid var(--border-subtle)',
                  display: 'flex', flexDirection: 'column', gap: 4,
                }}>
                  <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>
                    {pt ? 'Entrar por um terminal:' : 'Enter from a terminal:'}
                  </span>
                  <code
                    onClick={() => { void navigator.clipboard?.writeText(row.attachCommand) }}
                    title={pt ? 'Copiar' : 'Copy'}
                    style={{
                      display: 'block', padding: '6px 8px', borderRadius: 7, cursor: 'pointer',
                      background: 'var(--bg-base)', border: '1px solid var(--border-subtle)',
                      fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace",
                      fontSize: 10.5, color: 'var(--text-secondary)',
                      overflowX: 'auto', whiteSpace: 'pre',
                    }}
                  >
                    {row.attachCommand}
                  </code>
                </div>
              </>
            )}

            {notice && (
              <p role="status" style={{
                margin: '6px 6px 4px', fontSize: 11, lineHeight: 1.45, color: 'var(--text-tertiary)',
              }}>
                {notice}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}

const ghostBtn: React.CSSProperties = {
  padding: '6px 11px', borderRadius: 8, cursor: 'pointer',
  border: '1px solid var(--border-subtle)', background: 'transparent',
  color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12,
}

const primaryBtn: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 5,
  padding: '6px 12px', borderRadius: 8, cursor: 'pointer', border: 'none',
  background: 'var(--anthropic-orange)', color: '#fff',
  fontFamily: 'inherit', fontSize: 12, fontWeight: 650,
}
