/**
 * SessionPickModal — tick some sessions, then do one thing to all of them.
 *
 * ONE component for two features, because they differ only in where the ticks start and what the
 * button promises — see `lib/sessionPick.ts`, which holds that arithmetic and is tested apart from
 * any DOM. Two modals would be two places for the header checkbox, the count and the empty state to
 * drift, and this is a screen that starts assistants or writes into them: the number on the button
 * is the last thing anybody checks.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { X, RotateCcw, Send } from 'lucide-react'
import {
  initialPick, pickAllState, pickConfirmLabel, pickedRows, togglePick, togglePickAll,
  type PickRow,
} from '../../lib/sessionPick'
import { useIsMobile } from '../../hooks/useIsMobile'
import { overlayPadding } from '../../lib/mobileOverlay'

/**
 * A MIRROR of the server's `MAX_BROADCAST`, kept so the client does not offer what will be refused
 * — the same reason the input channel keeps a copy of the key allowlist. The server stays the
 * authority: it refuses regardless, and its refusal is what the user is shown.
 */
const MAX_BROADCAST = 12

export interface PickModalRow extends PickRow {
  /** Shown under the title — the folder, so two sessions of one repo are told apart. */
  detail?: string
}

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
  const [picked, setPicked] = useState<Set<string>>(() => initialPick(rows, kind === 'reopen' ? 'all' : 'none'))
  const [text, setText] = useState('')

  // The fleet polls every five seconds. A row that ended while this was open must not stay tickable,
  // and one that arrived must not be silently ticked into a `reopen` the user never saw.
  useEffect(() => {
    setPicked(prev => {
      const live = new Set(rows.map(r => r.id))
      const next = new Set([...prev].filter(id => live.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [rows])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const allState = pickAllState(rows, picked)
  const chosen = useMemo(() => pickedRows(rows, picked), [rows, picked])
  const needsText = kind === 'send'
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
    all: pt ? 'Marcar todas' : 'Tick all',
    none: pt ? 'Desmarcar todas' : 'Untick all',
    empty: kind === 'reopen'
      ? (pt ? 'Nada caiu. Não há o que reabrir.' : 'Nothing fell. There is nothing to reopen.')
      : (pt ? 'Nenhuma sessão rodando para receber um prompt.' : 'No running session can receive a prompt.'),
    placeholder: pt ? 'O prompt que cada sessão vai receber…' : 'The prompt each session will receive…',
    cancel: pt ? 'Cancelar' : 'Cancel',
    cap: pt
      ? `No máximo ${MAX_BROADCAST} de uma vez — ${chosen.length} marcadas.`
      : `At most ${MAX_BROADCAST} at a time — ${chosen.length} ticked.`,
  }

  const tap = isMobile ? 44 : 32

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 620, display: 'flex',
        alignItems: isMobile ? 'stretch' : 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        // The status bar is not padding we may spend — see `overlayPadding`.
        padding: overlayPadding(isMobile, 16),
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t.title}
        style={{
          width: '100%', maxWidth: isMobile ? '100%' : 520,
          height: isMobile ? '100%' : undefined, maxHeight: isMobile ? '100%' : '82vh',
          display: 'flex', flexDirection: 'column',
          background: 'var(--bg-elevated, #1a1a1a)',
          border: isMobile ? 'none' : '1px solid var(--border, var(--ag-tint-4))',
          borderRadius: isMobile ? 0 : 14,
          boxShadow: '0 24px 64px rgba(0,0,0,0.7)', overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 18px 14px', borderBottom: '1px solid var(--border-subtle, var(--ag-tint-3))',
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #e8e8e8)' }}>{t.title}</span>
          <button
            onClick={onClose}
            aria-label={t.cancel}
            style={{
              width: tap, height: tap, borderRadius: 6, background: 'transparent', border: 'none',
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-tertiary, #666)', padding: 0,
            }}
          >
            <X size={15} />
          </button>
        </div>

        <div style={{ padding: '12px 18px 0' }}>
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.55, color: 'var(--text-secondary, #aaa)' }}>{t.lead}</p>
        </div>

        {rows.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 18px 8px' }}>
            <input
              id="pick-all"
              type="checkbox"
              checked={allState === 'all'}
              ref={el => { if (el) el.indeterminate = allState === 'some' }}
              onChange={() => setPicked(togglePickAll(rows, picked))}
              style={{ width: 15, height: 15, accentColor: 'var(--anthropic-orange, #e8925a)', cursor: 'pointer' }}
            />
            <label htmlFor="pick-all" style={{ fontSize: 12, color: 'var(--text-secondary, #aaa)', cursor: 'pointer' }}>
              {allState === 'all' ? t.none : t.all}
            </label>
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 18px 8px', minHeight: 0 }}>
          {rows.length === 0 ? (
            <p style={{ margin: '10px 0', fontSize: 12, color: 'var(--text-tertiary, #666)' }}>{t.empty}</p>
          ) : rows.map(row => {
            const on = picked.has(row.id)
            return (
              <label
                key={row.id}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 9, cursor: 'pointer',
                  padding: '9px 10px', marginBottom: 5, minHeight: isMobile ? 44 : undefined,
                  borderRadius: 8, border: '1px solid var(--border-subtle, var(--ag-tint-3))',
                  background: on ? 'rgba(232,146,90,0.07)' : 'transparent',
                }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => setPicked(togglePick(picked, row.id))}
                  style={{ width: 15, height: 15, marginTop: 2, accentColor: 'var(--anthropic-orange, #e8925a)', cursor: 'pointer', flexShrink: 0 }}
                />
                <span style={{ minWidth: 0 }}>
                  <span style={{
                    display: 'block', fontSize: 12.5, color: 'var(--text-primary, #e8e8e8)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {row.title}
                  </span>
                  {row.detail && (
                    <span style={{
                      display: 'block', fontSize: 11, color: 'var(--text-tertiary, #666)', marginTop: 2,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {row.detail}
                    </span>
                  )}
                </span>
              </label>
            )
          })}
        </div>

        {needsText && rows.length > 0 && (
          <div style={{ padding: '4px 18px 0' }}>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder={t.placeholder}
              rows={3}
              style={{
                width: '100%', boxSizing: 'border-box', resize: 'vertical',
                padding: '9px 10px', borderRadius: 8,
                border: '1px solid var(--border, var(--ag-tint-4))',
                background: 'var(--ag-tint-1, transparent)', color: 'var(--text-primary, #e8e8e8)',
                // 16px on mobile or iOS Safari zooms the viewport and breaks the sticky header.
                fontSize: isMobile ? 16 : 12.5, fontFamily: 'inherit', lineHeight: 1.5,
              }}
            />
            {overCap && (
              <p role="status" style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--accent-red, #e5484d)' }}>{t.cap}</p>
            )}
          </div>
        )}

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
          padding: '12px 14px 14px', borderTop: '1px solid var(--border-subtle, var(--ag-tint-3))',
        }}>
          <button
            onClick={onClose}
            style={{
              minHeight: tap, padding: '0 14px', borderRadius: 8, cursor: 'pointer',
              border: '1px solid var(--border, var(--ag-tint-4))', background: 'transparent',
              color: 'var(--text-secondary, #aaa)', fontFamily: 'inherit', fontSize: 12.5,
            }}
          >
            {t.cancel}
          </button>
          <button
            onClick={() => ready && onConfirm(chosen.map(r => r.id), text.trim())}
            disabled={!ready}
            style={{
              display: 'flex', alignItems: 'center', gap: 7,
              minHeight: tap, padding: '0 14px', borderRadius: 8,
              cursor: ready ? 'pointer' : 'default', opacity: ready ? 1 : 0.45,
              border: '1px solid var(--anthropic-orange, #e8925a)',
              background: ready ? 'rgba(232,146,90,0.12)' : 'transparent',
              color: 'var(--anthropic-orange, #e8925a)',
              fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
            }}
          >
            {kind === 'reopen' ? <RotateCcw size={13} /> : <Send size={13} />}
            {confirm.label}
          </button>
        </div>
      </div>
    </div>
  )
}
