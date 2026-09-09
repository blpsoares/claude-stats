/**
 * auth.ts — stateless HMAC-signed session cookie auth for Team Mode Phase 3.
 *
 * Pure helpers (signSession, verifySession, parseCookies, constantTimeEqual)
 * carry no side effects and are unit-tested in auth.test.ts.
 *
 * Handlers (handleLogin, handleLogout, handleSession, isAuthed) are thin IO
 * wrappers; the caller in index.ts spreads CORS_HEADERS over their responses.
 *
 * Security guarantees:
 *   - Session cookie: HttpOnly, SameSite=Lax, Path=/, Max-Age 7d; Secure when
 *     AGENTISTICS_TEAM_TLS=1.
 *   - Cookie value: `${expiryMs}.${HMAC_SHA256(expiryMs, secret)}`.
 *   - HMAC verified with crypto.timingSafeEqual (constant-time).
 *   - Password compared with crypto.timingSafeEqual (constant-time).
 *   - Raw password and session secret are never logged.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import { TEAM_CENTRAL, TEAM_PASSWORD, TEAM_SESSION_SECRET, TEAM_TLS, CENTRAL_USER } from './config'
import { getAccount } from './accounts'
import { CAPS, PROFILE } from './exposure'
import { chatAllowed } from './chat-gate'
import { shellAllowed } from './sessions/shell-gate'
import { readPreferences } from './preferences'
import type { Principal } from './iam-types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COOKIE_BASE = 'agentistics_session'
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000 // absolute cap
/** Sliding window: a session unused for this long is dead even inside its absolute lifetime. */
export const IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000
/** Reissue the cookie at most this often, so an active user never hits the idle wall. */
export const SESSION_REFRESH_MS = 15 * 60 * 1000
const MAX_AGE_SECONDS = SESSION_DURATION_MS / 1000

/**
 * `__Host-` requires Secure + Path=/ + no Domain. It stops a sibling subdomain (or a network
 * attacker over plain HTTP) from overwriting the session cookie — the strongest integrity
 * guarantee available for a cookie. Only usable when the cookie is Secure, so a plain-HTTP
 * local instance keeps the bare name.
 */
export function cookieName(secure: boolean): string {
  return secure ? `__Host-${COOKIE_BASE}` : COOKIE_BASE
}

function secureCookies(): boolean {
  return TEAM_TLS || CAPS.requireSecureCookies
}

/** Read the session cookie under either name — flipping TLS on must not log everyone out. */
function readSessionCookie(req: Request): string | undefined {
  const cookies = parseCookies(req.headers.get('cookie'))
  return cookies[cookieName(true)] ?? cookies[cookieName(false)]
}

// Content-Type only — callers spread CORS_HEADERS from index.ts.
const JSON_CT = { 'Content-Type': 'application/json' } as const

// ---------------------------------------------------------------------------
// PURE helpers (no side effects — safe to unit test without mocking)
// ---------------------------------------------------------------------------

/**
 * Sign a session: returns `${expiryMs}.${HMAC_SHA256(expiryMs, secret)}`.
 * The expiry timestamp is the data being signed; it is also included in the
 * cookie value so the server can verify it without any server-side state.
 */
export function signSession(expiryMs: number, secret: string): string {
  const payload = String(expiryMs)
  const mac = createHmac('sha256', secret).update(payload).digest('hex')
  return `${payload}.${mac}`
}

/**
 * Verify a session cookie value:
 *   - Parses `expiryMs.hmacHex`.
 *   - Checks expiry > nowMs.
 *   - Verifies HMAC with constant-time compare.
 * Returns false for any malformed, expired, or tampered cookie.
 */
export function verifySession(
  cookieValue: string | undefined,
  secret: string,
  nowMs: number,
): boolean {
  if (!cookieValue) return false
  const dot = cookieValue.indexOf('.')
  if (dot === -1) return false
  const expiryStr = cookieValue.slice(0, dot)
  const mac = cookieValue.slice(dot + 1)
  const expiry = parseInt(expiryStr, 10)
  if (isNaN(expiry) || expiry <= nowMs) return false
  const expected = createHmac('sha256', secret).update(expiryStr).digest('hex')
  return constantTimeEqual(mac, expected)
}

// ---------------------------------------------------------------------------
// Principal-carrying session (IAM) — additive; coexists with the legacy
// password session above until Phase 2 switches login over to accounts.
// Cookie value: `${expiryMs}.${accountId}.${sessionVersion}.${HMAC(payload)}`.
// ---------------------------------------------------------------------------

export interface PrincipalCookie {
  accountId: string
  sessionVersion: number
  issuedAtMs: number
}

/** Sign a principal session. The signed payload is `expiryMs.accountId.sessionVersion.issuedAt`. */
export function signPrincipalSession(
  expiryMs: number,
  accountId: string,
  sessionVersion: number,
  secret: string,
  issuedAtMs: number,
): string {
  const payload = `${expiryMs}.${accountId}.${sessionVersion}.${issuedAtMs}`
  const mac = createHmac('sha256', secret).update(payload).digest('hex')
  return `${payload}.${mac}`
}

/**
 * Verify a principal session cookie:
 *   - splits off the trailing `.mac`, verifies HMAC over the payload (constant-time),
 *   - parses `expiryMs.accountId.sessionVersion`, checks expiry > nowMs.
 * Returns { accountId, sessionVersion } or null for any malformed/expired/tampered cookie.
 */
export function verifyPrincipalSession(
  cookieValue: string | undefined,
  secret: string,
  nowMs: number,
): PrincipalCookie | null {
  if (!cookieValue) return null
  const lastDot = cookieValue.lastIndexOf('.')
  if (lastDot === -1) return null
  const payload = cookieValue.slice(0, lastDot)
  const mac = cookieValue.slice(lastDot + 1)
  const expected = createHmac('sha256', secret).update(payload).digest('hex')
  if (!constantTimeEqual(mac, expected)) return null
  const parts = payload.split('.')
  if (parts.length !== 4) return null
  const expiry = parseInt(parts[0]!, 10)
  const accountId = parts[1]!
  const sessionVersion = parseInt(parts[2]!, 10)
  const issuedAtMs = parseInt(parts[3]!, 10)
  if (isNaN(expiry) || expiry <= nowMs) return null
  if (!accountId || isNaN(sessionVersion) || isNaN(issuedAtMs)) return null
  // Idle timeout: a cookie last reissued more than IDLE_TIMEOUT_MS ago is dead even though
  // its absolute expiry is still days away. Active use refreshes it (see SESSION_REFRESH_MS).
  if (nowMs - issuedAtMs > IDLE_TIMEOUT_MS) return null
  return { accountId, sessionVersion, issuedAtMs }
}

// ---------------------------------------------------------------------------
// MFA challenge — the short-lived token handed out between "password accepted" and
// "second factor accepted". It is NOT a session: it grants nothing on its own, and it is
// domain-separated from session cookies so one can never be replayed as the other.
// ---------------------------------------------------------------------------

/** How long the user has to type the code before restarting the login. */
export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000
const MFA_DOMAIN = 'mfa-challenge'

export function signMfaChallenge(
  accountId: string,
  sessionVersion: number,
  secret: string,
  expiryMs: number,
): string {
  const payload = `${expiryMs}.${accountId}.${sessionVersion}`
  const mac = createHmac('sha256', secret).update(`${MFA_DOMAIN}.${payload}`).digest('hex')
  return `${payload}.${mac}`
}

export function verifyMfaChallenge(
  value: string | undefined,
  secret: string,
  nowMs: number,
): { accountId: string; sessionVersion: number } | null {
  if (!value) return null
  const lastDot = value.lastIndexOf('.')
  if (lastDot === -1) return null
  const payload = value.slice(0, lastDot)
  const mac = value.slice(lastDot + 1)
  const expected = createHmac('sha256', secret).update(`${MFA_DOMAIN}.${payload}`).digest('hex')
  if (!constantTimeEqual(mac, expected)) return null
  const parts = payload.split('.')
  if (parts.length !== 3) return null
  const expiry = parseInt(parts[0]!, 10)
  const accountId = parts[1]!
  const sessionVersion = parseInt(parts[2]!, 10)
  if (isNaN(expiry) || expiry <= nowMs) return null
  if (!accountId || isNaN(sessionVersion)) return null
  return { accountId, sessionVersion }
}

/**
 * Minimal cookie header parser. Splits on `;` and on the first `=`.
 * Handles cookie values containing `=` (e.g. base64).
 */
export function parseCookies(header: string | null): Record<string, string> {
  const result: Record<string, string> = {}
  if (!header) return result
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key) result[key] = value
  }
  return result
}

/**
 * Constant-time string comparison.
 * Both inputs are reduced to a fixed-length HMAC-SHA256 digest before
 * comparison so that length differences cannot leak via timing side-channels.
 * `timingSafeEqual` then compares the two 32-byte digests in constant time.
 */
const EQ_KEY = 'agentistics-constant-length-equalization'
export function constantTimeEqual(a: string, b: string): boolean {
  const da = createHmac('sha256', EQ_KEY).update(a).digest()
  const db = createHmac('sha256', EQ_KEY).update(b).digest()
  return timingSafeEqual(da, db)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeCookieHeader(value: string, maxAge: number): string {
  const secure = secureCookies()
  // SameSite=Strict: the dashboard is never legitimately entered by a cross-site POST, and
  // Strict is what the OWASP cheat sheet recommends for an internal tool / admin panel.
  const flags = [`${cookieName(secure)}=${value}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAge}`]
  if (secure) flags.push('Secure')
  return flags.join('; ')
}

// ---------------------------------------------------------------------------
// Route handlers (IO — each returns a Response; caller spreads CORS_HEADERS)
// ---------------------------------------------------------------------------

/**
 * POST /api/team/login
 * Body: { password: string }
 * On match → Set-Cookie + { ok: true }
 * On mismatch → 200 { ok: false, error: 'invalid password' }
 *   (200 so the login form doesn't trigger browser error interceptors)
 */
export async function handleLogin(req: Request): Promise<Response> {
  if (!TEAM_PASSWORD) {
    // No password configured → login is a no-op; behave as authed.
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: JSON_CT })
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid JSON' }), {
      status: 400,
      headers: JSON_CT,
    })
  }
  const password =
    typeof (body as Record<string, unknown>)?.password === 'string'
      ? ((body as Record<string, unknown>).password as string)
      : ''

  // Constant-time comparison — never branch on the raw match result early.
  if (!constantTimeEqual(password, TEAM_PASSWORD)) {
    return new Response(JSON.stringify({ ok: false, error: 'invalid password' }), {
      status: 200,
      headers: JSON_CT,
    })
  }

  const expiryMs = Date.now() + SESSION_DURATION_MS
  const cookieValue = signSession(expiryMs, TEAM_SESSION_SECRET)
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      ...JSON_CT,
      'Set-Cookie': makeCookieHeader(cookieValue, MAX_AGE_SECONDS),
    },
  })
}

/**
 * POST /api/team/logout
 * Clears the session cookie by setting Max-Age=0.
 */
export function handleLogout(_req: Request): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      ...JSON_CT,
      'Set-Cookie': makeCookieHeader('', 0),
    },
  })
}

/**
 * GET /api/team/session
 * Returns { authed, required, central, aggregatorOnly }.
 * `required` = a password is configured (tells the web whether to show the login screen).
 * `aggregatorOnly` = a central with NO local harness data (no CENTRAL_USER) — a pure
 * aggregator. The web uses it to hide local-only UI (archive consent gate, Nay chat).
 * Public — never behind the gate.
 */
export async function handleSession(req: Request): Promise<Response> {
  const required = Boolean(TEAM_PASSWORD)
  const authed = isAuthed(req)
  const aggregatorOnly = TEAM_CENTRAL && !CENTRAL_USER
  // Unreadable preferences are not consent: chat and the shell stay off rather than falling open.
  const prefs = await readPreferences().catch(() => ({} as { chatEnabled?: boolean; shellEnabled?: boolean }))
  return new Response(
    JSON.stringify({
      authed,
      required,
      central: TEAM_CENTRAL,
      aggregatorOnly,
      // The exposure profile and the local capabilities it grants. The web app uses these to
      // hide affordances the server would refuse anyway (see capability-guard.ts) — the flags
      // are a UI hint, never the enforcement point.
      profile: PROFILE,
      capabilities: {
        localShell: CAPS.localShell,
        localChat: CAPS.localChat,
        localTranscripts: CAPS.localTranscripts,
        mcpAdmin: CAPS.mcpAdmin,
      },
      // What the chat endpoints will ACTUALLY answer: the capability AND the user's switch.
      // Separate from `capabilities.localChat`, which stays the exposure profile's answer alone —
      // the Settings tab has to be able to say "your profile allows this, you have it off".
      chatEnabled: chatAllowed(CAPS.localChat, prefs.chatEnabled),
      // The same split, for the per-session utility SHELL: the capability AND the user's own
      // switch, separate from `capabilities.localShell` (the profile alone) so Settings can say
      // "your profile allows this, you have it off". Unreadable preferences are not consent here
      // either — `shellAllowed` reads an absent switch as OFF.
      shellEnabled: shellAllowed(CAPS.localShell, prefs.shellEnabled),
    }),
    { status: 200, headers: JSON_CT },
  )
}

/**
 * Returns true if the request carries a valid session cookie, or if no
 * password is configured (gate disabled → always authed).
 * Called by the request gate in index.ts.
 */
export function isAuthed(req: Request): boolean {
  if (!TEAM_PASSWORD) return true
  return verifySession(readSessionCookie(req), TEAM_SESSION_SECRET, Date.now())
}

/**
 * Strict session check — does NOT grant access on a passwordless central.
 * Returns true only when the request carries a valid, unexpired, HMAC-signed
 * session cookie. Use this for admin routes that must stay protected even
 * when TEAM_PASSWORD is unset (no-password deployments).
 */
export function hasValidSession(req: Request): boolean {
  return verifySession(readSessionCookie(req), TEAM_SESSION_SECRET, Date.now())
}

/**
 * Resolve the authenticated principal for a request, or null.
 * Verifies the principal cookie, loads the account, and rejects if the account's
 * sessionVersion no longer matches the cookie (revocation / password change / logout-all).
 * Role + memberships are read FRESH from the DB so permission changes take effect immediately.
 */
export async function getPrincipal(req: Request): Promise<Principal | null> {
  return (await getPrincipalSession(req))?.principal ?? null
}

/**
 * Like getPrincipal, but also reports the cookie's issue time and the account's session
 * generation — everything the gate needs to decide on a sliding refresh. Kept separate so
 * `Principal` stays a pure authorization identity (accountId + role + memberships) and every
 * authz test fixture can keep constructing one without session bookkeeping.
 */
export async function getPrincipalSession(
  req: Request,
): Promise<{ principal: Principal; issuedAtMs: number; sessionVersion: number } | null> {
  const parsed = verifyPrincipalSession(readSessionCookie(req), TEAM_SESSION_SECRET, Date.now())
  if (!parsed) return null
  const account = await getAccount(parsed.accountId)
  if (!account) return null
  if (account.sessionVersion !== parsed.sessionVersion) return null
  return {
    principal: { accountId: account._id, role: account.role, memberships: account.memberships },
    issuedAtMs: parsed.issuedAtMs,
    sessionVersion: account.sessionVersion,
  }
}

/**
 * Build a Set-Cookie header string for a freshly-issued principal session (7-day expiry).
 * Reuses the module's cookie internals so login/bootstrap flows never re-implement them.
 */
export function makePrincipalSessionCookieHeader(accountId: string, sessionVersion: number): string {
  const now = Date.now()
  const value = signPrincipalSession(now + SESSION_DURATION_MS, accountId, sessionVersion, TEAM_SESSION_SECRET, now)
  return makeCookieHeader(value, MAX_AGE_SECONDS)
}
