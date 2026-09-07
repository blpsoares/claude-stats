/**
 * remoteSessionsState.ts — PURE: what the connection card's remote-sessions block says.
 *
 * The two switches themselves are interpreted in exactly one place, `resolveRemoteConsent`
 * (`@agentistics/core`), and the server sends this route their RESOLVED values. This module decides
 * only what the card can honestly SAY about them, which is a separate question with its own trap:
 * the switch is a LOCAL preference, so flipping it always succeeds, while the central only learns
 * about it over the reverse channel. A card that reported "the central may no longer manage this
 * machine" the instant the toggle moved would be stating something about the central that had not
 * happened yet.
 */

import type { ConnectionStatusEntry } from './statusTypes'

/** How far this machine has opened up to this central. Ordered, and each step strictly contains
 *  the one before it — there is no shape where screens travel and the fleet does not. */
export type RemoteConsentLevel = 'off' | 'sessions' | 'screens'

export interface RemotePanelView {
  level: RemoteConsentLevel
  /** Whether the SCREEN switch may be operated at all. It is meaningless without the fleet
   *  switch, and offering it there would be a control whose only outcome is being ignored. */
  screensAvailable: boolean
  /**
   * True when this machine cannot currently be reaching the central, so a consent it has just
   * changed has not been announced yet.
   *
   * Decided ONLY from a connection the server already reports as failing (`errKind`). It is
   * deliberately not inferred from `lastSuccessAt`, which measures the metrics PUSH and not the
   * reverse channel the announcement rides: a member on the central's own cadence can be perfectly
   * connected and simply not have pushed recently, and calling that "not announced" would put a
   * warning on the screen of every healthy machine.
   */
  announcementPending: boolean
}

/**
 * Read one connection's status entry into the block's state.
 *
 * An ABSENT entry (the poll has not answered, or an older server build that does not send these
 * fields) resolves to `off` — never to "unknown, so presumably fine". Same rule the consent itself
 * follows: not being told is not an agreement.
 */
export function remotePanelView(entry: ConnectionStatusEntry | undefined): RemotePanelView {
  const sessions = entry?.remoteSessions === true
  const screens = sessions && entry?.remoteScreens === true
  return {
    level: screens ? 'screens' : sessions ? 'sessions' : 'off',
    screensAvailable: sessions,
    announcementPending: sessions && entry?.errKind != null,
  }
}

/** The body to PATCH for one click on either switch. Written as a whole pair rather than one
 *  field, so the request states the intended END STATE and cannot be read as a partial edit. */
export function consentPatchFor(view: RemotePanelView, toggled: 'sessions' | 'screens'): {
  allowRemoteSessions: boolean
  allowRemoteScreens: boolean
} {
  if (toggled === 'sessions') {
    const next = view.level === 'off'
    // Turning the fleet off takes the screens with it — the server enforces this too, and for the
    // reason recorded there: a screen grant left stored under a switched-off fleet comes back the
    // moment the fleet is switched on again, which is a grant nobody re-made.
    return { allowRemoteSessions: next, allowRemoteScreens: next ? view.level === 'screens' : false }
  }
  return { allowRemoteSessions: true, allowRemoteScreens: view.level !== 'screens' }
}
