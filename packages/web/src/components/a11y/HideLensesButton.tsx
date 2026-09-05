/**
 * HideLensesButton.tsx — sits beside `MagnifierButton`, everywhere that button appears.
 *
 * Toggles `a11y.lensesHidden`: click hides every PLACED lens on the current page, click again
 * brings them all back exactly as they were. It touches no lens's position, size, zoom or pinned
 * state, and it is a separate control from the general menu's "Remove all on this page" — hiding
 * is meant to be indistinguishable from that only in one direction (the page looks the same
 * either way), never in the other (nothing here is destructive).
 *
 * The cursor-following lens is deliberately UNAFFECTED — see `MagnifierLayer.tsx`'s render of it
 * for why: it is not one of the lenses "parked" on this page, it already has its own on/off
 * shortcut (Ctrl+Shift+Z), and it is transient by construction (never persisted, gone on reload).
 * This button is about the lenses a person placed and is keeping around.
 *
 * Rendered only when it can do something: the feature must be enabled AND the current page must
 * actually have a placed lens. `a11y.lenses` already reflects the current page regardless of
 * `lensesHidden` (hiding never mutates that list), so this condition stays correct in both states
 * — including the hidden state itself, where this button is the ONLY way back and must keep
 * rendering.
 */
import React from 'react'
import { Eye, EyeOff } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import { useIsMobile } from '../../hooks/useIsMobile'
import { a11yText } from './i18n'

export function HideLensesButton({ ctx }: { ctx: AppContext }) {
  const { a11y, lang } = ctx
  const text = a11yText(lang)
  const isMobile = useIsMobile()

  if (!a11y.prefs.enabled || a11y.lenses.length === 0) return null

  const hidden = a11y.lensesHidden
  const label = hidden ? text.showLenses : text.hideLenses

  return (
    <button
      onClick={() => a11y.toggleLensesHidden()}
      title={label}
      aria-label={label}
      aria-pressed={hidden}
      style={{
        // Same sizing rule as MagnifierButton's own trigger — one 44px touch target on mobile,
        // one compact 32px control on desktop.
        width: isMobile ? 44 : 32, height: isMobile ? 44 : 32,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 8, border: '1px solid var(--border)', background: 'transparent',
        color: 'var(--anthropic-orange)', cursor: 'pointer', flexShrink: 0,
      }}
    >
      {hidden ? <EyeOff size={isMobile ? 18 : 14} /> : <Eye size={isMobile ? 18 : 14} />}
    </button>
  )
}
