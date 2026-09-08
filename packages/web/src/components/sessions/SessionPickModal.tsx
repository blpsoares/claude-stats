/**
 * SessionPickModal — tick some sessions, then do one thing to all of them.
 *
 * ONE component for two features, because they differ only in where the ticks start and what the
 * button promises — see `lib/sessionPick.ts`, which holds that arithmetic and is tested apart from
 * any DOM. Two modals would be two places for the header checkbox, the count, the search and the
 * empty state to drift, and this is a screen that starts assistants or writes into them: the
 * number on the button is the last thing anybody checks.
 *
 * It is built from `formBits` and wears the new-session wizard's own shell, tab strip and field.
 * A dialog that invents its own chrome reads as a different product from the one beside it.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { RotateCcw, Search, Send, X } from 'lucide-react'
import {
  PICK_TABS, filterPickRows, initialPick, pickAllState, pickConfirmLabel, pickEmpty, pickTabHint,
  pickTabLabel, pickedRows, togglePick, togglePickAll,
  type PickRow, type PickTab,
} from '../../lib/sessionPick'
import { useIsMobile } from '../../hooks/useIsMobile'
import { overlayPadding } from '../../lib/mobileOverlay'
import { Field, Muted, TabStrip, inputStyle } from './formBits'

/**
 * A MIRROR of the server's `MAX_BROADCAST`, kept so the client does not offer what will be refused
 * — the same reason the input channel keeps a copy of the key allowlist. The server stays the
 * authority: it refuses regardless, and its refusal is what the user is shown.
 */
const MAX_BROADCAST = 12

export type PickModalRow = PickRow

interface Props {
  kind: 'reopen' | 'send'
  rows: readonly PickModalRow[]
  lang: 'pt' | 'en'
  busy?: boolean
  onClose: () => void
  /** `text` is present only for `send`. */
  onConfirm: (ids: string[], text: string) => void
}

export function SessionPickModal({ kind, rows, lang, busy, onClose, onConfirm }: Props) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const needsText = kind === 'send'
  const [picked, setPicked] = useState<Set<string>>(() => initialPick(rows, kind === 'reopen' ? 'all' : 'none'))
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  // Reopen has no tabs: every row in it fell, so none of them is running and "Active" would always
  // be empty. A tab that can only ever be empty is a control that teaches the wrong thing.
  const [tab, setTab] = useState<PickTab>('active')

  // The fleet polls every five seconds. A row that ended while this was open must not stay ticked,
  // and one that arrived must not be silently ticked into a verb the user never saw.
  useEffect(() => {
    setPicked(prev => {
      const takeable = new Set(rows.filter(r => r.enabled !== false).map(r => r.id))
      const next = new Set([...prev].filter(id => takeable.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [rows])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const shown = useMemo(
    () => (needsText ? filterPickRows(rows, tab, query) : filterPickRows(rows, 'all', query)),
    [rows, tab, query, needsText],
  )
  // The header box and the button count the WHOLE selection, never the filtered view: a search that
  // silently shrank what the button was about to do would be the worst kind of quiet.
  const allState = pickAllState(shown, picked)
  const chosen = useMemo(() => pickedRows(rows, picked), [rows, picked])
  const overCap = needsText && chosen.length > MAX_BROADCAST
  const confirm = pickConfirmLabel(chosen.length, kind, pt)
  const ready = confirm.enabled && !busy && !overCap && (!needsText || text.trim().length > 0)

  const t = {
    title: kind === 'reopen'
      ? (pt ? 'Reabrir o que caiu' : 'Reopen what fell')
      : (pt ? 'Enviar prompt em massa' : 'Send a prompt to several sessions'),
    lead: kind === 'reopen'
      ? (pt
        ? 'Estas sessões estavam abertas quando a máquina parou. Vêm todas marcadas — desmarque as que não quiser de volta.'
        : 'These sessions were open when the machine stopped. They all start ticked — untick any you do not want back.')
      : (pt
        ? 'O mesmo prompt vai para cada sessão marcada, uma de cada vez. Nenhuma vem marcada: escolha uma a uma.'
        : 'The same prompt goes to each ticked session, one at a time. None start ticked: pick them yourself.'),
    sessions: pt ? 'Sessões' : 'Sessions',
    prompt: pt ? 'Prompt' : 'Prompt',
    all: pt ? 'Marcar todas' : 'Tick all',
    none: pt ? 'Desmarcar todas' : 'Untick all',
    searchSessions: pt ? 'Buscar por título ou pasta…' : 'Search by title or folder…',
    placeholder: pt ? 'O prompt que cada sessão vai receber…' : 'The prompt each session will receive…',
    cancel: pt ? 'Cancelar' : 'Cancel',
    cap: pt
      ? `No máximo ${MAX_BROADCAST} de uma vez — ${chosen.length} marcadas.`
      : `At most ${MAX_BROADCAST} at a time — ${chosen.length} ticked.`,
    chosenNote: pt
      ? `${chosen.length} marcada${chosen.length === 1 ? '' : 's'} no total`
      : `${chosen.length} ticked in total`,
  }

  const tap = isMobile ? 44 : 30

  return (
    <div
      onClick={() => { if (!busy) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 620,
        background: 'var(--ag-scrim)', backdropFilter: 'blur(3px)',
        display: 'flex', alignItems: isMobile ? 'stretch' : 'center', justifyContent: 'center',
        // The status bar is not padding we may spend — see `overlayPadding`.
        padding: overlayPadding(isMobile, 20),
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t.title}
        style={{
          background: 'var(--bg-surface)',
          border: isMobile ? 'none' : '1px solid var(--border)',
          borderRadius: isMobile ? 0 : 16,
          width: '100%', maxWidth: isMobile ? '100%' : 560,
          height: isMobile ? '100%' : undefined, maxHeight: isMobile ? '100%' : '86vh',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <header style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '16px 20px', borderBottom: '1px solid var(--border)',
        }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>
            {t.title}
          </h2>
          <button
            onClick={onClose}
            aria-label={t.cancel}
            style={{
              display: 'flex', width: tap, height: tap, alignItems: 'center', justifyContent: 'center',
              borderRadius: 8, border: 'none', background: 'transparent',
              color: 'var(--text-tertiary)', cursor: 'pointer',
            }}
          >
            <X size={16} />
          </button>
        </header>

        <div style={{
          flex: 1, minHeight: 0, overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 16, padding: '16px 20px',
        }}>
          <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-secondary)' }}>
            {t.lead}
          </p>

          <Field label={t.sessions}>
            <div style={{ position: 'relative' }}>
              <Search size={13} style={{
                position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
                color: 'var(--text-tertiary)', pointerEvents: 'none',
              }} />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t.searchSessions}
                // 16px on mobile or iOS Safari zooms the viewport and breaks the sticky header.
                style={{ ...inputStyle, ...(isMobile ? { fontSize: 16 } : {}) }}
              />
            </div>

            {needsText && (
              <>
                <TabStrip
                  tabs={PICK_TABS}
                  value={tab}
                  onPick={setTab}
                  label={id => pickTabLabel(id, pt)}
                  count={id => filterPickRows(rows, id, query).length}
                />
                <p style={{ margin: '0 0 2px', fontSize: 10.5, lineHeight: 1.45, color: 'var(--text-tertiary)' }}>
                  {pickTabHint(tab, pt)}
                </p>
              </>
            )}

            {shown.length > 0 && (
              <label style={{
                display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                minHeight: isMobile ? 44 : undefined,
              }}>
                <input
                  type="checkbox"
                  checked={allState === 'all'}
                  ref={el => { if (el) el.indeterminate = allState === 'some' }}
                  onChange={() => setPicked(togglePickAll(shown, picked))}
                  style={{ width: 15, height: 15, accentColor: 'var(--anthropic-orange)', cursor: 'pointer' }}
                />
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {allState === 'all' ? t.none : t.all}
                </span>
                {/* The total, because the header box acts on the FILTERED view and the button counts
                    the whole selection — without this the two numbers look like a bug. */}
                {chosen.length > 0 && (
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {t.chosenNote}
                  </span>
                )}
              </label>
            )}

            <div style={{
              maxHeight: isMobile ? undefined : 220, overflowY: 'auto',
              display: 'flex', flexDirection: 'column', gap: 4,
              border: '1px solid var(--border-subtle)', borderRadius: 10, padding: 6,
            }}>
              {shown.length === 0 ? (
                <Muted text={pickEmpty(needsText ? tab : 'all', query, rows.length > 0, pt)} />
              ) : shown.map(row => {
                const off = row.enabled === false
                const on = picked.has(row.id)
                return (
                  <label
                    key={row.id}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 9,
                      cursor: off ? 'default' : 'pointer', opacity: off ? 0.55 : 1,
                      padding: '9px 10px', borderRadius: 8,
                      minHeight: isMobile ? 44 : undefined,
                      border: `1px solid ${on ? 'var(--anthropic-orange)' : 'var(--border-subtle)'}`,
                      background: on ? 'var(--bg-elevated)' : 'transparent',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={off}
                      onChange={() => setPicked(togglePick(picked, row.id))}
                      style={{
                        width: 15, height: 15, marginTop: 2, flexShrink: 0,
                        accentColor: 'var(--anthropic-orange)', cursor: off ? 'default' : 'pointer',
                      }}
                    />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{
                        display: 'block', fontSize: 12.5, color: 'var(--text-primary)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {row.title}
                      </span>
                      {row.detail && (
                        <span style={{
                          display: 'block', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {row.detail}
                        </span>
                      )}
                      {/* WHY it cannot be picked. A disabled row that says nothing is
                          indistinguishable from a broken one. */}
                      {off && row.reason && (
                        <span style={{ display: 'block', fontSize: 11, color: 'var(--text-tertiary)', marginTop: 3, fontStyle: 'italic' }}>
                          {row.reason}
                        </span>
                      )}
                    </span>
                  </label>
                )
              })}
            </div>
          </Field>

          {needsText && (
            <Field label={t.prompt}>
              <textarea
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder={t.placeholder}
                rows={3}
                style={{
                  ...inputStyle, paddingLeft: 12, resize: 'vertical', lineHeight: 1.5,
                  ...(isMobile ? { fontSize: 16 } : {}),
                }}
              />
              {overCap && (
                <span role="status" style={{ fontSize: 11.5, color: 'var(--accent-red)' }}>{t.cap}</span>
              )}
            </Field>
          )}
        </div>

        <footer style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
          padding: '14px 20px', borderTop: '1px solid var(--border)',
        }}>
          <button
            onClick={onClose}
            style={{
              minHeight: isMobile ? 44 : 34, padding: '0 14px', borderRadius: 9, cursor: 'pointer',
              border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12.5,
            }}
          >
            {t.cancel}
          </button>
          <button
            onClick={() => ready && onConfirm(chosen.map(r => r.id), text.trim())}
            disabled={!ready}
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              minHeight: isMobile ? 44 : 34, padding: '0 14px', borderRadius: 9,
              cursor: ready ? 'pointer' : 'default', opacity: ready ? 1 : 0.45,
              border: '1px solid var(--anthropic-orange)',
              background: ready ? 'var(--bg-elevated)' : 'transparent',
              color: 'var(--anthropic-orange)',
              fontFamily: 'inherit', fontSize: 12.5, fontWeight: 650,
            }}
          >
            {kind === 'reopen' ? <RotateCcw size={13} /> : <Send size={13} />}
            {confirm.label}
          </button>
        </footer>
      </div>
    </div>
  )
}
