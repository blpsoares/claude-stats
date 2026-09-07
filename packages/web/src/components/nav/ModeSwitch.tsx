/**
 * ModeSwitch — the segmented control at the top of the aside, and the only way between the two
 * workspaces.
 *
 * PINNED on purpose: it sits above the scrolling body and never moves with it. The sessions list
 * below can run to hundreds of rows, and a switch that scrolls out of view strands somebody in a
 * workspace with no visible way back — the one failure this control cannot be allowed to have.
 *
 * It navigates rather than setting state, because `workspaceMode.ts` derives the mode from the URL.
 * See that module for why: a mode held beside the router is a second answer that disagrees the
 * first time anyone reloads or presses back.
 */

import { useNavigate, useLocation } from 'react-router-dom'
import { LayoutDashboard, MessagesSquare } from 'lucide-react'
import {
  WORKSPACE_MODES, modeLabel, modeOfPath, pathForMode, type WorkspaceMode,
} from '../../lib/workspaceMode'

const ICON: Record<WorkspaceMode, React.ReactNode> = {
  dashboard: <LayoutDashboard size={15} />,
  sessions: <MessagesSquare size={15} />,
}

export interface ModeSwitchProps {
  lang: 'pt' | 'en'
  /** Icons only, for the collapsed aside. The flyout renders the full control. */
  collapsed?: boolean
  /**
   * How many sessions are waiting on a person.
   *
   * Carried on the switch because it must be readable from the OTHER workspace — the whole point of
   * a badge here is that you are looking at the dashboard when a session starts needing you. It is
   * the same count the terminal cockpit puts in its header, and for the same reason.
   */
  attention?: number
  /**
   * Called after the switch navigates.
   *
   * It exists for the phone, where this control is rendered INSIDE the "More" sheet: switching
   * workspace is a navigation, and a sheet still covering the page you just asked for is a sheet
   * you have to dismiss before you can see what you chose. Every other control in that sheet
   * already closes it; this one was the exception because it is a shared component that knows
   * nothing about the sheet — so the sheet tells it what to do rather than the component guessing.
   * The desktop aside passes nothing and nothing changes there.
   */
  onNavigate?: () => void
}

export function ModeSwitch({ lang, collapsed = false, attention = 0, onNavigate }: ModeSwitchProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const active = modeOfPath(location.pathname)

  // Where "back to the dashboard" goes. Remembered on the way out rather than recomputed: once you
  // are inside the sessions workspace the router no longer knows where you came from.
  const back = typeof sessionStorage !== 'undefined'
    ? sessionStorage.getItem('agentistics-dashboard-path')
    : null
  if (active === 'dashboard' && typeof sessionStorage !== 'undefined') {
    try { sessionStorage.setItem('agentistics-dashboard-path', location.pathname) } catch { /* private mode */ }
  }

  return (
    <div
      role="tablist"
      aria-label={lang === 'pt' ? 'Área de trabalho' : 'Workspace'}
      style={{
        // `minWidth: 0` on BOTH the strip and its buttons. A flex item defaults to
        // `min-width: auto`, which refuses to shrink below its content — so icon + label + badge
        // pushed the second segment straight out through the aside's right edge. Reported as
        // "o botao de sessions ta passando pra fora"; it is the default, not the styling.
        // COLLAPSED IT STACKS. The rail leaves about 36px of inner width, and two segments side
        // by side there is not a tight fit, it is an impossible one — the icons piled on top of
        // each other. A segmented control that cannot fit its segments becomes a list of them.
        display: 'flex', flexDirection: collapsed ? 'column' : 'row',
        gap: 3, padding: 3, borderRadius: 10, minWidth: 0, width: '100%',
        boxSizing: 'border-box',
        background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
      }}
    >
      {WORKSPACE_MODES.map(mode => {
        const on = mode === active
        const label = modeLabel(mode, lang)
        const badge = mode === 'sessions' && attention > 0
        return (
          <button
            key={mode}
            role="tab"
            aria-selected={on}
            aria-label={collapsed ? label : undefined}
            title={collapsed ? label : undefined}
            onClick={() => { navigate(pathForMode(mode, back)); onNavigate?.() }}
            style={{
              flex: '1 1 0', minWidth: 0, boxSizing: 'border-box',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              position: 'relative',
              // 36px is the desktop figure. The mobile form of this control is rendered by
              // MobileBottomNav, which carries the 44px touch target its own rows use.
              minHeight: 34, padding: collapsed ? '0' : '0 8px',
              borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 12.5, fontWeight: on ? 700 : 500, whiteSpace: 'nowrap',
              background: on ? 'var(--bg-surface)' : 'transparent',
              boxShadow: on ? 'var(--ag-shadow-seg)' : 'none',
              color: on ? 'var(--text-primary)' : 'var(--text-tertiary)',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            <span style={{ display: 'flex', flexShrink: 0 }}>{ICON[mode]}</span>
            {!collapsed && (
              // The label is the one part allowed to give way. It truncates rather than pushing the
              // badge out of the aside — a count nobody can see is worse than a clipped word.
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
            )}
            {badge && (
              <span
                aria-label={lang === 'pt' ? `${attention} aguardando você` : `${attention} waiting on you`}
                style={{
                  // On the icon when collapsed, beside the word when not — either way it is a dot
                  // with a number, never a colour alone: a count said only in colour is a count
                  // nobody can read.
                  position: collapsed ? 'absolute' : 'static',
                  top: collapsed ? 2 : undefined, right: collapsed ? 2 : undefined,
                  flexShrink: 0,
                  minWidth: 16, height: 16, padding: '0 4px', borderRadius: 8,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  background: 'var(--anthropic-orange)', color: '#fff',
                  fontSize: 10, fontWeight: 700, lineHeight: 1,
                }}
              >
                {attention}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
