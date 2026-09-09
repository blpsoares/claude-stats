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
import { SessionFiling } from '../tasks/SessionFiling'
import { StopSessionConfirm } from '../tasks/StopSessionConfirm'
import { boardCopy } from '../tasks/copy'
import { BetaTag } from '../BetaTag'
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
  /**
   * SURFACE CONTROLS THAT SHARE THIS MENU, drawn above the row's own verbs.
   *
   * On a phone the session bar had six controls and no room left for the TITLE — the one thing on
   * it that says which session you are looking at. Reported as exactly that. They come in here
   * rather than into a second popover beside this one, because two menus on a 390px bar is the
   * accumulation being complained about, rearranged.
   *
   * They are the CALLER's: this component knows the row's verbs and nothing about filters, panels
   * or metrics. Each carries its own `onSelect`, and the menu closes after it.
   */
  extra?: {
    id: string
    label: string
    icon?: React.ReactNode
    /** A count or a figure the row would otherwise have shown on the bar (`1`, `59%`). */
    badge?: string
    /** Marks the one that is currently showing, so the menu says where you are. */
    on?: boolean
    onSelect: () => void
  }[]
  /**
   * A CONTROL, not a row — drawn above `extra` and above the verbs.
   *
   * Some of what came off the bar is not a list item. The view switch is a SEGMENTED CONTROL: its
   * two halves are alternatives to each other, and that is the whole of what it says. Listed as two
   * rows they read as two independent things you could pick, which is not the same statement — so
   * it comes in as itself and this menu only places it.
   *
   * It is a function of `close` because the caller owns what its control does, and a menu that
   * stays open after you have used it is a menu you then have to dismiss.
   */
  extraTop?: (close: () => void) => React.ReactNode
}

/** The verbs that take a line of text before they can run. */
/**
 * Verbs that ask for a line of text before they run.
 *
 * `task` is NOT one of them any more. It used to open a bare field, which meant filing a session
 * under existing work required remembering the name and typing it identically — and a name typed
 * one character differently is a second task with the metrics split between them. It now opens the
 * same `TaskPicker` the board and the aside use: search, pick, or create.
 */
const TEXT_VERBS = new Set<string>(['rename', 'note'])

/** Shown in the menu, in this order. `prompt` and `approve` have their own places in the chat. */
// `openTask` and `finishTask` are GONE from this menu and from the fleet's verbs: they asked about
// a delivery at a moment nobody was thinking about one. The question moved to the stop confirmation
// — see `StopSessionConfirm` — which is when somebody actually knows the answer.
const MENU_ORDER: string[] = ['rename', 'note', 'task', 'resume', 'kill']

/** The verbs that belong to the delivery board rather than to the session itself. */
const TASK_VERBS = new Set<string>(['task'])

export function SessionActions({
  row, lang, act, onGone, onOpened, extra = [], extraTop,
}: SessionActionsProps) {
  /** Open when the `task` verb was picked — see `TEXT_VERBS`. */
  const [linking, setLinking] = useState(false)
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
    // Filing under a task is a CHOICE from what exists, not a line of text — see `TEXT_VERBS`.
    if (v.action === 'task') { setOpen(false); setLinking(true); return }
    if (TEXT_VERBS.has(v.action)) {
      // Seeded with what the row already has, so renaming is an edit rather than a retype.
      setDraft(v.action === 'rename' ? row.title : (row.note ?? ''))
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
          width: 32, height: 32, borderRadius: 9, cursor: 'pointer', flexShrink: 0,
          border: '1px solid var(--border-subtle)', background: 'transparent',
          color: 'var(--text-secondary)',
        }}
      >
        <MoreHorizontal size={16} />
      </button>

      {linking && (
        <SessionFiling
          session={{
            id: row.id, title: row.title,
            ...(row.harness ? { harness: row.harness } : {}),
            ...(row.task ? { task: row.task } : {}),
          }}
          lang={lang}
          onChanged={() => setNotice(boardCopy(lang).filed)}
          onClose={() => setLinking(false)}
        />
      )}

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
            {/* THE SURFACE'S OWN CONTROLS, first: they are what the bar gave up to make room for the
                title, and burying them under the row's verbs would make the trade a bad one. A rule
                separates them because they act on THIS SCREEN while the verbs act on the SESSION. */}
            {!asking && !confirming && extraTop && (
              <div style={{ padding: '2px 2px 6px' }}>{extraTop(() => setOpen(false))}</div>
            )}

            {!asking && !confirming && extra.length > 0 && (
              <div style={{
                display: 'flex', flexDirection: 'column',
                marginBottom: 4, paddingBottom: 4, borderBottom: '1px solid var(--border-subtle)',
              }}>
                {extra.map(x => (
                  <button
                    key={x.id}
                    onClick={() => { setOpen(false); x.onSelect() }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
                      // 44px: this menu is opened with a thumb, and the rule this repo holds every
                      // other mobile target to.
                      minHeight: 44, padding: '6px 10px', borderRadius: 8,
                      border: 'none', background: 'transparent',
                      color: x.on ? 'var(--anthropic-orange)' : 'var(--text-primary)',
                      cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5,
                      fontWeight: x.on ? 650 : 400,
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                  >
                    {x.icon && <span style={{ display: 'flex', flexShrink: 0 }}>{x.icon}</span>}
                    <span style={{ minWidth: 0, flex: 1 }}>{x.label}</span>
                    {/* The figure the bar used to print. It is why some of these are worth opening
                        at all — a metrics row saying nothing is one nobody presses. */}
                    {x.badge && (
                      <span style={{
                        flexShrink: 0, fontSize: 11, fontWeight: 600,
                        color: x.on ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                      }}>{x.badge}</span>
                    )}
                  </button>
                ))}
              </div>
            )}

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
              <StopSessionConfirm
                title={row.title}
                {...(row.task ? { task: row.task } : {})}
                lang={lang}
                busy={busy}
                onStop={() => run('kill')}
                onCancel={() => setConfirming(false)}
                onNotice={setNotice}
                styles={{ danger: { ...primaryBtn, background: 'var(--accent-red)' }, plain: ghostBtn }}
              />
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
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {v.label}
                      {/* The task verbs are the delivery board reaching into this menu. Marked
                          here too: a reader who only ever opens this menu never sees the board's
                          own header, and a caveat shown on four surfaces of six is worse than
                          none — they conclude the unmarked two are the finished part. */}
                      {TASK_VERBS.has(v.action) && <BetaTag what={pt ? 'As tarefas' : 'Tasks'} />}
                    </span>
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
