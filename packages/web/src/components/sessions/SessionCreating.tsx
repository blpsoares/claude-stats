/**
 * SessionCreating — the few seconds between pressing Start and reading the session.
 *
 * It replaces what used to happen there, which was the FLEET OVERVIEW: the modal closed, the row
 * did not exist in this browser's fleet yet, and `SessionsPage` fell through to its "nothing
 * selected" branch — so creating a session flashed the metrics screen at you and then jumped to the
 * session a poll later. Reported exactly that way. The overview was never wrong about anything; it
 * was answering a question nobody had asked.
 *
 * NOTHING HERE IS WAITED FOR. The page unmounts this the moment the session can be drawn, mid-step
 * and mid-sweep if that is where it is. `creationProgress.ts` carries the same rule in its own
 * header and is why the bar cannot reach 100 on a timer: full-and-orange is what `ready` buys, and
 * `ready` is a fact about the fleet rather than a countdown.
 *
 * The bar is `transform: scaleX` on a ready-made track, not an animated `width`: width is laid out
 * every frame, transform is composited, and this runs while the machine is busy spawning a process.
 */

import { useEffect, useRef, useState } from 'react'
import { CREATION_STEPS, creationStepText, creationView } from '../../lib/creationProgress'

export interface SessionCreatingProps {
  lang: 'pt' | 'en'
  /** The assistant being started, so the step about it can name it. */
  harness?: string
  /** What the person called it, when they named it — shown instead of a generic title. */
  label?: string
  /**
   * The session can be drawn NOW.
   *
   * Flipping this is what fills the bar and turns it orange. The caller hands over on the very next
   * frame, so this state is real and is never held for.
   */
  ready: boolean
}

export function SessionCreating({ lang, harness, label, ready }: SessionCreatingProps) {
  const pt = lang === 'pt'
  const startedAt = useRef(Date.now())
  const [now, setNow] = useState(() => Date.now())

  /**
   * One rAF loop while the work is going, stopped the moment it is not.
   *
   * `requestAnimationFrame` rather than an interval: the browser pauses it when the tab is hidden,
   * which is the correct behaviour for something that only exists to be looked at, and it cannot
   * queue up a backlog of ticks the way a 60ms interval does on a machine that is busy launching a
   * harness — which is exactly the machine this runs on.
   */
  useEffect(() => {
    if (ready) return
    let raf = 0
    const tick = () => { setNow(Date.now()); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [ready])

  const view = creationView(now - startedAt.current, ready)
  const step = creationStepText(view.index, lang, harness)

  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy={!ready}
      style={{
        flex: 1, minHeight: 0, display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 15, fontWeight: 650, color: 'var(--text-primary)' }}>
            {label || (pt ? 'Preparando sua sessão' : 'Getting your session ready')}
          </span>
          {/* The step, not a spinner's worth of nothing. `aria-live` above announces each one, and
              the fixed height keeps the block from jumping as the sentences change length. */}
          <span style={{
            fontSize: 12.5, lineHeight: '18px', minHeight: 18,
            color: 'var(--text-secondary)',
          }}>
            {ready ? (pt ? 'Pronto — abrindo' : 'Ready — opening') : step}
          </span>
        </div>

        <div style={{
          position: 'relative', height: 6, borderRadius: 999, overflow: 'hidden',
          background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
        }}>
          <div style={{
            position: 'absolute', inset: 0, transformOrigin: 'left center',
            transform: `scaleX(${view.percent / 100})`,
            // Snappy while it climbs; the jump to full on `ready` gets its own, quicker curve so
            // the finish reads as an arrival rather than as one more increment.
            transition: ready ? 'transform 160ms ease-out, background 160ms ease-out' : 'transform 320ms ease-out',
            background: view.complete ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
          }} />
        </div>

        {/* The steps as ticks, so the sentence above has somewhere to sit in a sequence. Purely
            positional — nothing here is clickable and nothing reports a duration, because none of
            these has one anybody could promise. */}
        <div style={{ display: 'flex', gap: 4 }} aria-hidden>
          {CREATION_STEPS.map((s, i) => (
            <span key={s.id} style={{
              flex: 1, height: 2, borderRadius: 999,
              transition: 'background 220ms ease-out',
              // Only tokens this stylesheet actually defines — a `var()` naming one that does not
              // exist falls back silently and the tick just looks wrong to whoever added it next.
              background: view.complete
                ? 'var(--anthropic-orange)'
                : i <= view.index ? 'var(--text-tertiary)' : 'var(--border-subtle)',
              // The step being worked on is the solid one; the ones behind it are dimmed rather
              // than recoloured, so the row reads as a position and not as five states.
              opacity: view.complete || i === view.index ? 1 : i < view.index ? 0.7 : 0.5,
            }} />
          ))}
        </div>
      </div>
    </div>
  )
}
