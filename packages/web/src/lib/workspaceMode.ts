/**
 * workspaceMode.ts — which of the two applications the sidebar is showing.
 *
 * The dashboard and the session cockpit are not two pages, they are two workspaces: the aside keeps
 * its shell — width, header, footer, identity — and swaps its BODY. One sidebar component with two
 * bodies, never two sidebars, because a second implementation of the same chrome is a second thing
 * to drift.
 *
 * THE MODE IS DERIVED FROM THE URL, never held beside it. A `useState` mode plus a router is two
 * answers to one question, and they disagree the first time someone reloads the page, opens a link,
 * or presses back. Deriving it means F5 keeps you where you were and a session link can be sent to
 * somebody — which is the whole reason `Sessions` stops being a nav item and becomes a mode: a mode
 * you cannot link to is a mode you cannot share.
 */

/** The two workspaces. `dashboard` is everything the app was; `sessions` is the fleet cockpit. */
export type WorkspaceMode = 'dashboard' | 'sessions'

export const WORKSPACE_MODES: readonly WorkspaceMode[] = ['dashboard', 'sessions'] as const

/** The route prefix that IS the sessions workspace. Everything else is the dashboard. */
export const SESSIONS_ROOT = '/sessions'

/**
 * Which workspace this path belongs to.
 *
 * Matched on the segment boundary, not on a bare prefix: a future `/sessions-report` is a dashboard
 * page whose path happens to start with the same seven characters, and `startsWith` would silently
 * swallow it into the other workspace.
 */
export function modeOfPath(pathname: string): WorkspaceMode {
  if (pathname === SESSIONS_ROOT || pathname.startsWith(SESSIONS_ROOT + '/')) return 'sessions'
  return 'dashboard'
}

/**
 * Where the switch should navigate.
 *
 * Leaving `sessions` returns to the dashboard page you were last on rather than to `/`: the switch
 * is a way back to what you were doing, and dumping everyone on Home makes it a way to lose your
 * place. `back` is only honoured when it really is a dashboard path — a stored `/sessions/...`
 * would make the switch a no-op that looks broken.
 */
export function pathForMode(mode: WorkspaceMode, back?: string | null): string {
  if (mode === 'sessions') return SESSIONS_ROOT
  const candidate = (back ?? '').trim()
  if (candidate.startsWith('/') && modeOfPath(candidate) === 'dashboard') return candidate
  return '/'
}

/** The switch's own words. EN default, PT alongside, like every other surface here. */
export function modeLabel(mode: WorkspaceMode, lang: 'pt' | 'en'): string {
  if (mode === 'sessions') return lang === 'pt' ? 'Sessões' : 'Sessions'
  return lang === 'pt' ? 'Painel' : 'Dashboard'
}
