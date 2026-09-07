import { useEffect } from 'react'
import { refreshNotifications } from '../lib/notifications'
import { subscribeEvent } from '../lib/eventStream'

/**
 * Loads the notification history from the server on mount, then subscribes to the SSE
 * `notification` events and re-reads it whenever one arrives.
 *
 * The client does NOT write what it receives here: `broadcastNotification` already persisted the
 * notification server-side before emitting it, so re-posting it from every open tab would be a
 * duplicate write and would mint ids the other devices don't share. Reading back keeps one row
 * per event, with the server's id, dismissible from any device.
 *
 * The SSE frame's `data` is deliberately IGNORED — it carries no notification body (see
 * `sse.ts` `broadcastNotification`): `/api/events` is an unauthenticated broadcast with no
 * principal attached, so shipping `code`/`meta`/`subject` on it would hand every open tab the
 * full notification regardless of the role/team scoping `GET /api/notifications` applies. The
 * event's mere arrival is the whole signal; this always re-fetches the already-scoped endpoint.
 *
 * Localization still happens at RENDER time (resolveNotification) from the stored `code` + `meta`,
 * so the text follows the language toggle even for notifications received long ago.
 */
export function useNotificationStream(_lang: 'pt' | 'en'): void {
  useEffect(() => {
    void refreshNotifications()
    // Share the one `/api/events` socket (see lib/eventStream.ts) instead of opening a second one:
    // a duplicate broadcast socket is a per-origin connection slot a live terminal could have had.
    return subscribeEvent('notification', () => { void refreshNotifications() })
  }, [])
}
