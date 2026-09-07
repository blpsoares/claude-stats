/**
 * a11y-prefs.ts — the ONE place that decides where a person's accessibility settings live.
 *
 * `/api/preferences` could not be reused: it reads and writes `~/.agentistics/preferences.json`,
 * which is per MACHINE. On a central that file belongs to the container and is shared by every
 * signed-in user, so one person's magnifiers would appear on everyone's screen. An accessibility
 * configuration is the most personal setting this product has.
 *
 * The resolution is PURE and the frontend never sees it: one endpoint, one call, and the mode is
 * the server's problem — the same shape as `central-runtime.ts`.
 */
import type { AccessibilityPrefs } from '@agentistics/core'
import { sanitizeAccessibilityPrefs } from '@agentistics/core'

export type A11yStore =
  | { kind: 'machine' }
  | { kind: 'account'; accountId: string }
  /** Defensive fallback for the narrow window where a session resolves but the account does not.
   *  This is not a login mode anyone is meant to be in — it fails safe by serving read-only
   *  defaults and refusing writes, rather than ever touching the machine file. */
  | { kind: 'anonymous' }

export function resolveA11yStore(central: boolean, accountId: string | null): A11yStore {
  if (!central) return { kind: 'machine' }
  if (accountId && accountId.trim()) return { kind: 'account', accountId }
  // Deliberately NOT the machine file. Falling back to it on a central is exactly the bug this
  // module exists to prevent, and it would stay invisible until two people compared screens.
  return { kind: 'anonymous' }
}

/**
 * A PUT carries the whole object and REPLACES what is stored. It must not deep-merge per page:
 * treating an absent key as "unchanged" would make deleting the last lens of a page impossible.
 *
 * The replace-vs-merge guarantee itself lives in the route handler: it must write
 * applyA11yPut(body) as the whole stored document, never spread it over the document
 * it just read.
 */
export function applyA11yPut(incoming: unknown): AccessibilityPrefs {
  return sanitizeAccessibilityPrefs(incoming)
}
