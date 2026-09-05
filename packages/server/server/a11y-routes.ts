/**
 * a11y-routes.ts — GET/PUT /api/accessibility.
 *
 * Authenticated by the default rule: these paths are NOT in AUTH_PUBLIC. They touch no host power
 * beyond the preferences file `/api/preferences` already writes, so they are not registered in
 * capability-guard.ts either.
 *
 * CORS headers are PASSED IN rather than imported: `index.ts` builds them per request from the
 * caller's origin, so there is no module-level constant to reach for.
 */
import { DEFAULT_ACCESSIBILITY_PREFS, sanitizeAccessibilityPrefs } from '@agentistics/core'
import { getPrincipal } from './auth'
import { TEAM_CENTRAL } from './config'
import { PROFILE } from './exposure'
import { readPreferences, writePreferences } from './preferences'
import { readUserAccessibility, writeUserAccessibility } from './user-prefs-store'
import { applyA11yPut, resolveA11yStore } from './a11y-prefs'
import { readJsonLimited } from './limits'
import { safeError } from './errors'

/** A lens document is small; a body larger than this is not one. */
const MAX_BODY_BYTES = 64 * 1024

export async function handleAccessibility(
  req: Request,
  cors: Record<string, string>,
): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    })

  try {
    const principal = await getPrincipal(req)
    const store = resolveA11yStore(TEAM_CENTRAL, principal?.accountId ?? null)

    if (req.method === 'GET') {
      if (store.kind === 'machine') {
        return json(sanitizeAccessibilityPrefs((await readPreferences()).accessibility))
      }
      if (store.kind === 'account') {
        return json(sanitizeAccessibilityPrefs(await readUserAccessibility(store.accountId)))
      }
      // Anonymous on a central: readable defaults. "You have none" is honest; handing back the
      // machine's file would be handing back somebody else's.
      return json(DEFAULT_ACCESSIBILITY_PREFS)
    }

    if (req.method === 'PUT') {
      if (store.kind === 'anonymous') {
        return json({ error: 'sign in with an account to save accessibility settings' }, 409)
      }
      const read = await readJsonLimited<unknown>(req, MAX_BODY_BYTES)
      if (!read.ok) return json({ error: read.error }, read.error === 'too_large' ? 413 : 400)
      const prefs = applyA11yPut(read.value)
      if (store.kind === 'machine') {
        // A shallow merge over the stored document — nothing else in preferences.json is touched.
        await writePreferences({ accessibility: prefs })
      } else {
        await writeUserAccessibility(store.accountId, prefs)
      }
      return json(prefs)
    }

    return json({ error: 'method not allowed' }, 405)
  } catch (err) {
    const safe = safeError(err, { verbose: PROFILE === 'local' })
    console.error(safe.logLine)
    return json(safe.body, 500)
  }
}
