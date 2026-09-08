/**
 * SessionPicker — "which session belongs to this task", asked from the table's session column.
 *
 * The mirror of `TaskPicker`. Two toggles because the honest answer depends on what you are doing:
 * **Active** is the default (you are usually filing work that is happening right now), and **All**
 * reaches the finished and `lost` rows, which is what you want when you are recording after the
 * fact — a delivery is often filed once it is done.
 *
 * It reads the SAME 5s refcounted fleet poll every other surface uses, so the list here and the
 * list in the sessions workspace cannot disagree by a poll interval.
 */

import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Search, Terminal, X } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useFleet } from '../../lib/fleet'
import { SESSION_STATE, button, field, harnessColor, microLabel, pill, surface } from './board'

const LIVE = new Set(['working', 'waiting', 'waiting-approval'])

/**
 * A page, not the whole fleet.
 *
 * Measured on this machine: 328 rows in one poll. A picker that renders all of them is a scroll
 * nobody reads to the end of, and it makes the search feel like the only way in — which is fine
 * when you know the name and useless when you are browsing.
 */
const PAGE = 12

export interface SessionPickerProps {
  /** Sessions already filed under this task — shown as picked. */
  attached?: readonly string[]
  /** Several at once. The caller decides what to do with each. */
  multiple?: boolean
  onPick: (sessionIds: string[]) => void | Promise<void>
  onClose: () => void
}

export function SessionPicker({
  attached = [], multiple = true, onPick, onClose,
}: SessionPickerProps) {
  const isMobile = useIsMobile()
  const { fleet, loading } = useFleet('en')
  const [q, setQ] = useState('')
  const [scope, setScope] = useState<'active' | 'all'>('active')
  const [page, setPage] = useState(0)
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const matched = useMemo(() => {
    const all = fleet.sessions ?? []
    const needle = q.trim().toLowerCase()
    return all
      .filter(s => (scope === 'active' ? LIVE.has(s.state) : true))
      .filter(s => !needle
        || s.title.toLowerCase().includes(needle)
        || s.cwd.toLowerCase().includes(needle)
        || s.harness.toLowerCase().includes(needle))
      // Live first, then the rest — the thing you are most likely filing is the thing running.
      .sort((a, b) => Number(LIVE.has(b.state)) - Number(LIVE.has(a.state)))
  }, [fleet.sessions, q, scope])

  const pages = Math.max(1, Math.ceil(matched.length / PAGE))
  // Clamped on every render: narrowing the search while on page 5 must not leave an empty view with
  // no way back — the same rule `resolvePaging` follows elsewhere in this app.
  const current = Math.min(page, pages - 1)
  const rows = matched.slice(current * PAGE, current * PAGE + PAGE)

  const toggle = (id: string) => {
    if (!multiple) { void onPick([id]); onClose(); return }
    const next = new Set(picked)
    next.has(id) ? next.delete(id) : next.add(id)
    setPicked(next)
  }

  const seg = (active: boolean): React.CSSProperties => ({
    ...button(isMobile), height: isMobile ? 36 : 26, border: 'none', fontSize: 11.5,
    background: active ? 'var(--bg-elevated)' : 'transparent',
    color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
  })

  return createPortal(
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 998 }} />
      <div style={{
        position: 'fixed', inset: 0, margin: 'auto', width: 'min(460px, 92vw)', maxHeight: '72vh',
        zIndex: 999, ...surface, background: 'var(--bg-elevated)', padding: 12,
        display: 'grid', gridTemplateRows: 'auto auto auto 1fr', gap: 9,
        boxShadow: 'var(--shadow-elevated)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={microLabel}>Link a session</span>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', display: 'flex' }}>
            <X size={15} />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ ...surface, display: 'flex', padding: 3, gap: 2 }}>
            <button style={seg(scope === 'active')} onClick={() => { setScope('active'); setPage(0) }}>
              Active
            </button>
            <button style={seg(scope === 'all')} onClick={() => { setScope('all'); setPage(0) }}>
              All, incl. offline
            </button>
          </div>
          <span style={{ ...microLabel, fontSize: 10.5 }}>
            {matched.length} match{matched.length === 1 ? '' : 'es'}
          </span>
        </div>

        <div style={{ position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: isMobile ? 15 : 10, color: 'var(--text-tertiary)' }} />
          <input
            autoFocus style={{ ...field(isMobile), paddingLeft: 31 }} value={q}
            placeholder="Search by name, folder or harness"
            onChange={e => { setQ(e.target.value); setPage(0) }}
          />
        </div>

        <div style={{ overflowY: 'auto', display: 'grid', gap: 3, alignContent: 'start' }}>
          {loading && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>Loading…</div>}
          {!loading && rows.length === 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '6px 2px' }}>
              {scope === 'active'
                // Two different facts, two sentences: nothing running, versus nothing at all.
                ? 'Nothing is running. Switch to All to reach finished conversations.'
                : 'No session matches that.'}
            </div>
          )}
          {rows.map(s => {
            const st = SESSION_STATE[s.state]
            const already = attached.includes(s.id)
            const on = picked.has(s.id) || already
            return (
              <button
                key={s.id}
                onClick={() => toggle(s.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                  padding: '7px 9px', borderRadius: 'var(--radius-sm)',
                  border: `1px solid ${on ? 'var(--anthropic-orange)' : 'transparent'}`,
                  background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
                  color: 'var(--text-primary)', cursor: 'pointer',
                  minHeight: isMobile ? 44 : 32, fontSize: 12.5,
                }}
                onMouseEnter={e => { if (!on) e.currentTarget.style.background = 'var(--bg-card-hover)' }}
                onMouseLeave={e => { if (!on) e.currentTarget.style.background = 'transparent' }}
              >
                <Terminal size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, display: 'grid' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.title}
                  </span>
                  <span style={{ ...microLabel, textTransform: 'none', letterSpacing: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.cwd.split('/').slice(-2).join('/')}
                  </span>
                </span>
                {already && <span style={pill('var(--accent-green)')}>filed</span>}
                <span style={pill(harnessColor(s.harness))}>{s.harness}</span>
                {st && <span style={pill(st.color)}>{st.label}</span>}
              </button>
            )
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {pages > 1 && (
            <>
              <button
                style={{ ...button(isMobile), height: isMobile ? 36 : 26 }}
                disabled={current === 0} onClick={() => setPage(current - 1)}
              >Prev</button>
              <span style={{ ...microLabel, fontSize: 10.5 }}>{current + 1} / {pages}</span>
              <button
                style={{ ...button(isMobile), height: isMobile ? 36 : 26 }}
                disabled={current >= pages - 1} onClick={() => setPage(current + 1)}
              >Next</button>
            </>
          )}
          <span style={{ flex: 1 }} />
          {multiple && (
            <button
              style={{
                ...button(isMobile, picked.size > 0 ? 'primary' : 'ghost'),
                height: isMobile ? 40 : 28,
              }}
              disabled={picked.size === 0}
              onClick={() => { void onPick([...picked]); onClose() }}
            >Link {picked.size > 0 ? picked.size : ''}</button>
          )}
        </div>
      </div>
    </>,
    document.body,
  )
}
