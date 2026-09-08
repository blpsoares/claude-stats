/**
 * ToggleSwitch — the one on/off pill in this product.
 *
 * Lifted out of a closure inside `PreferencesModal` (App.tsx), where it was defined per render and
 * reachable by nothing else. It is the switch people already know from the Live toggle in the
 * header, so anything that means "on or off" uses THIS one rather than growing a second shape —
 * two switches that look different for the same idea is how a settings screen stops reading as one
 * product.
 *
 * The pill stays ORANGE when on. That is deliberate and not the surrounding block's business: the
 * accent says "this control is engaged", while whatever the switch governs is free to colour ITSELF
 * green, red or nothing at all. A switch that changed colour with its consequence would need a
 * different meaning per caller.
 */

export interface ToggleSwitchProps {
  on: boolean
  onToggle: () => void
  disabled?: boolean
  /** What this switch controls, for a screen reader — the visible label sits beside it. */
  label?: string
  /** 44px on mobile. The caller decides, because 44 on desktop turns a settings row into a slab. */
  tap?: number
}

export function ToggleSwitch({ on, onToggle, disabled = false, label, tap }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      {...(label ? { 'aria-label': label } : {})}
      disabled={disabled}
      onClick={onToggle}
      style={{
        position: 'relative', width: 32, height: 18, borderRadius: 9,
        border: 'none', background: on ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
        cursor: disabled ? 'default' : 'pointer', padding: 0,
        transition: 'background 0.2s', flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
        // A tap target is grown with a transparent box around the pill rather than by scaling the
        // pill itself: a 44px switch reads as a button, and the shape is what people recognise.
        ...(tap ? { outline: 'none', boxSizing: 'content-box', padding: `${Math.max(0, (tap - 18) / 2)}px ${Math.max(0, (tap - 32) / 2)}px`, background: 'transparent' } : {}),
      }}
    >
      <span style={{
        display: 'block', position: 'relative',
        width: 32, height: 18, borderRadius: 9,
        background: on ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
        transition: 'background 0.2s',
      }}>
        <span style={{
          position: 'absolute', top: 3, left: on ? 17 : 3,
          width: 12, height: 12, borderRadius: '50%', background: '#fff',
          transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
        }} />
      </span>
    </button>
  )
}
