/**
 * TaskSharing — the one switch that decides whether a delivery's text leaves this machine.
 *
 * It is a switch and a SENTENCE, never a switch alone: what travels (a title, a description,
 * comments, file names) is not guessable from the word "share", and what does not travel (the
 * files, the numbers) is exactly what a person would otherwise assume does. The wording is the
 * pure `sharingCopy`, so the same sentence can be tested and cannot drift between languages.
 *
 * Absent reads as NOT shared — a board carries text somebody wrote for themselves, and a default
 * that travels publishes what nobody offered.
 */

import { useEffect, useState } from 'react'
import { Share2 } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { sharingCopy, type SharingMode } from '../../lib/taskSharing'
import { editTask } from '../../lib/tasks'
import { microLabel } from './board'

interface TeamStatus {
  mode?: string
  connections?: unknown[]
}

export function TaskSharing({ id, shared, lang, onChanged }: {
  id: string
  shared: boolean | undefined
  lang: 'pt' | 'en'
  onChanged: () => void | Promise<void>
}) {
  const isMobile = useIsMobile()
  const [mode, setMode] = useState<SharingMode>('unknown')
  const [connections, setConnections] = useState(0)
  const [busy, setBusy] = useState(false)

  // Asked once, not polled: this panel is open while somebody reads it, and a machine does not
  // connect to a central while they do.
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await fetch('/api/team/status')
        if (!r.ok) return
        const st = await r.json() as TeamStatus
        if (!alive) return
        setMode((st.mode === 'member' || st.mode === 'central' || st.mode === 'solo') ? st.mode : 'unknown')
        setConnections(Array.isArray(st.connections) ? st.connections.length : 0)
      } catch { /* the sentence falls back to the honest "no central" case */ }
    })()
    return () => { alive = false }
  }, [])

  const on = shared === true
  const copy = sharingCopy({ shared: on, mode, connections, lang })

  const toggle = async () => {
    setBusy(true)
    await editTask(id, { shared: !on, actor: 'you' })
    setBusy(false)
    await onChanged()
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <button
        onClick={() => void toggle()}
        disabled={busy}
        aria-pressed={on}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%',
          // 44px is the MOBILE number — on desktop it would turn a row into a toolbar.
          minHeight: isMobile ? 44 : 32,
          padding: isMobile ? '8px 10px' : '6px 8px',
          background: 'transparent', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)', cursor: busy ? 'default' : 'pointer',
          color: 'var(--text-primary)', font: 'inherit', fontSize: 12.5, textAlign: 'left',
        }}
      >
        <Share2 size={14} style={{ color: on ? 'var(--anthropic-orange)' : 'var(--text-tertiary)', flexShrink: 0 }} />
        <span style={{ flex: 1 }}>{copy.label}</span>
        {/* The state is a word as well as a position — a track alone is colour alone. */}
        <span style={{ ...microLabel, fontSize: 10, color: on ? 'var(--anthropic-orange)' : 'var(--text-tertiary)' }}>
          {on ? (lang === 'pt' ? 'sim' : 'on') : (lang === 'pt' ? 'não' : 'off')}
        </span>
        <span style={{
          width: 32, height: 18, borderRadius: 9, flexShrink: 0, position: 'relative',
          background: on ? 'var(--anthropic-orange)' : 'var(--bg-elevated)',
          border: '1px solid var(--border)',
        }}>
          <span style={{
            position: 'absolute', top: 2, left: on ? 15 : 2, width: 12, height: 12, borderRadius: 6,
            background: on ? '#1a1008' : 'var(--text-tertiary)', transition: 'left 0.15s',
          }} />
        </span>
      </button>
      <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>{copy.body}</p>
      {copy.sessions && (
        <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>{copy.sessions}</p>
      )}
    </div>
  )
}
