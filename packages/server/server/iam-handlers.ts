/**
 * iam-handlers.ts — thin IO route handlers for IAM bootstrap (Phase 2).
 * Mirrors auth.ts: each returns a Response with JSON content-type; the caller in
 * index.ts spreads CORS_HEADERS. Bootstrap is public only while no owner exists —
 * handleBootstrap re-checks hasAnyOwner() and refuses once set up.
 */
import { randomBytes } from 'node:crypto'
import { hasAnyOwner, countOwners, createAccount, findAccountByEmail, updateAccount, getAccount, listAccounts, deleteAccount, bumpSessionVersion } from './accounts'
import { hashPassword, verifyPassword } from './passwords'
import { validateOwnerInput, verifyBootstrapToken, consumeBootstrapToken } from './bootstrap'
import { listTeams, createTeam, createOrgTeam, getTeam, deleteTeam } from './teams'
import { backfillTokenTeamIds, listMachines, mintMachineToken, mintMachine, machineUserFor, revokeToken, rotateToken, setMachineTeams, setMachineTeamsAndExclusions, setMachineLabel, setMachineOwners, detachTeamFromAllMachines, detachAccountFromAllMachines } from './team-tokens'
import { getCentralConfig } from './central-config'
import { packConnectToken, machineSessionsAllowed, canGrantMachineSessions, machineSessionAccounts, resolveSessionGrant } from '@agentistics/core'
import { backfillRepoTeamIds } from './team-repos'
import { deleteUserPrefs } from './user-prefs-store'
import {
  makePrincipalSessionCookieHeader,
  getPrincipal,
  getPrincipalSession,
  signMfaChallenge,
  verifyMfaChallenge,
  MFA_CHALLENGE_TTL_MS,
} from './auth'
import { TEAM_SESSION_SECRET, TEAM_ORG } from './config'
import { CAPS } from './exposure'
import { generateSecret, otpauthUri, verifyTotp, generateRecoveryCodes, hashRecoveryCode, totpSkewSteps, TOTP_STEP_SECONDS } from './totp'
import { getMfa, isMfaEnabled, enableMfa, disableMfa, consumeRecoveryCode } from './mfa-store'
import { publicAccount, accountVisibleTo, canCreateAccount, canDeleteAccount, teamVisibleTo, canManageMachineTeam, canManageMachine, machineOwnedBy, authorizeAccountPatch, mfaDisableAllowed } from './iam-view'
import type { AccountDoc, Membership, Role } from './iam-types'
import { normalizeEmail } from './iam-types'
import { limiter, RULES, tooManyRequests } from './rate-limit'
import { validatePasswordPolicy } from './password-policy'
import { writeAudit } from './audit'
import { readJsonLimited, LIMITS } from './limits'
import { signStepUp, stepUpRequiresCode, proveStepUp, STEPUP_TTL_MS } from './stepup'

const JSON_CT = { 'Content-Type': 'application/json' } as const

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_CT })
}

/** GET /api/iam/status — tells the SPA whether first-owner setup is still needed. */
export async function handleIamStatus(): Promise<Response> {
  let needsBootstrap = false
  try {
    needsBootstrap = !(await hasAnyOwner())
  } catch {
    needsBootstrap = false // DB unreachable → don't advertise a setup screen
  }
  return json({ central: true, needsBootstrap })
}

/**
 * POST /api/iam/bootstrap
 * Body: { token, name, email, password, confirm }
 * Creates the first owner (if none exists), creates the organisation's (empty) team, backfills
 * teamId, consumes the token, and logs the caller in (principal session cookie).
 */
export async function handleBootstrap(req: Request, hooks: { ip?: string } = {}): Promise<Response> {
  const ip = hooks.ip ?? 'unknown'
  if (await hasAnyOwner()) return json({ ok: false, error: 'already set up' }, 409)

  const parsedBody = await readJsonLimited<unknown>(req, LIMITS.bodyBytes)
  if (!parsedBody.ok) {
    return json({ ok: false, error: parsedBody.error }, parsedBody.error === 'too_large' ? 413 : 400)
  }
  const body: unknown = parsedBody.value

  const v = validateOwnerInput(body as Record<string, unknown>)
  if (!v.ok) return json({ ok: false, error: v.error }, 400)

  if (!(await verifyBootstrapToken(v.value.token))) {
    return json({ ok: false, error: 'invalid setup token' }, 401)
  }

  const passwordHash = await hashPassword(v.value.password)
  const account = await createAccount({
    name: v.value.name,
    email: v.value.email,
    passwordHash,
    role: 'owner',
    memberships: [],
  })

  // No Default team is seeded — machines/accounts start with no team (loose) and are assigned to
  // real teams explicitly. Backfills only normalize legacy shapes.
  //
  // The organisation does get ONE team, named after TEAM_ORG and EMPTY — not even the owner just
  // created joins it. It is a starting point the account form pre-selects, never a team anyone is
  // put in; see org-team.ts for why the difference is the whole point. Nothing is created for the
  // `default` placeholder org, and nothing is created if this central already has a team.
  const orgTeam = await createOrgTeam(TEAM_ORG, account._id)
  if (orgTeam) {
    void writeAudit({
      action: 'team.create',
      actorId: account._id,
      targetId: orgTeam._id,
      ip,
      meta: { name: orgTeam.name, source: 'bootstrap-org' },
    })
  }

  await backfillTokenTeamIds()
  await backfillRepoTeamIds()
  await consumeBootstrapToken(new Date())

  const cookie = makePrincipalSessionCookieHeader(account._id, account.sessionVersion)
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...JSON_CT, 'Set-Cookie': cookie },
  })
}

/**
 * POST /api/iam/login  Body: { email, password }
 * Generic 401 on unknown email OR wrong password (no user enumeration).
 */
export async function handleIamLogin(
  req: Request,
  hooks: { onSuccess?: () => void; ip?: string } = {},
): Promise<Response> {
  const ip = hooks.ip ?? 'unknown'
  const parsedBody = await readJsonLimited<unknown>(req, LIMITS.bodyBytes)
  if (!parsedBody.ok) {
    return json({ ok: false, error: parsedBody.error }, parsedBody.error === 'too_large' ? 413 : 400)
  }
  const body: unknown = parsedBody.value
  const b = body as Record<string, unknown>
  const email = typeof b.email === 'string' ? b.email : ''
  const password = typeof b.password === 'string' ? b.password : ''

  // Per-account soft backoff, on top of the per-IP limit applied in index.ts: an attacker
  // guessing one mailbox is slowed even when they rotate source addresses. Checked BEFORE the
  // argon2 verify so a locked account costs no CPU (that verify is the expensive part, and an
  // unauthenticated caller must never be able to spend it freely).
  const acctKey = `acct:${normalizeEmail(email)}`
  const acctVerdict = limiter.blocked(acctKey)
  if (!acctVerdict.allowed) return tooManyRequests(acctVerdict.retryAfterSec)

  const account = await findAccountByEmail(email)
  const ok = account ? await verifyPassword(password, account.passwordHash) : false
  if (!account || !ok) {
    limiter.fail(acctKey, RULES.login)
    // The e-mail is recorded (it is not a secret and an incident review needs it); the password
    // never is — buildAuditEvent drops it even if a caller passes it.
    void writeAudit({ action: 'login.failure', ip, targetId: account?._id, meta: { email: normalizeEmail(email) } })
    return json({ ok: false, error: 'invalid credentials' }, 401)
  }
  limiter.reset(acctKey)
  hooks.onSuccess?.()

  // Second factor, when enrolled: the password alone issues NO cookie. The caller gets a
  // short-lived, HMAC-signed challenge that grants nothing by itself and must be exchanged
  // for a session at /api/iam/login/mfa.
  if (await isMfaEnabled(account._id)) {
    const challenge = signMfaChallenge(
      account._id,
      account.sessionVersion,
      TEAM_SESSION_SECRET,
      Date.now() + MFA_CHALLENGE_TTL_MS,
    )
    void writeAudit({ action: 'login.mfa_challenge', ip, actorId: account._id })
    return json({ ok: false, mfaRequired: true, challenge }, 200)
  }

  await updateAccount(account._id, { lastLoginAt: new Date() })
  void writeAudit({ action: 'login.success', ip, actorId: account._id })
  const cookie = makePrincipalSessionCookieHeader(account._id, account.sessionVersion)
  return new Response(JSON.stringify({ ok: true, mustChangePassword: account.mustChangePassword ?? false }), { status: 200, headers: { ...JSON_CT, 'Set-Cookie': cookie } })
}

/**
 * POST /api/iam/login/mfa  Body: { challenge, code }
 * Exchanges a password-stage challenge for a session by proving the second factor.
 * `code` is either a 6-digit TOTP or one of the account's single-use recovery codes.
 */
export async function handleIamLoginMfa(req: Request): Promise<Response> {
  const parsedBody = await readJsonLimited<unknown>(req, LIMITS.bodyBytes)
  if (!parsedBody.ok) {
    return json({ ok: false, error: parsedBody.error }, parsedBody.error === 'too_large' ? 413 : 400)
  }
  const body: unknown = parsedBody.value
  const b = body as Record<string, unknown>
  const challenge = typeof b.challenge === 'string' ? b.challenge : ''
  const code = typeof b.code === 'string' ? b.code : ''

  const parsed = verifyMfaChallenge(challenge, TEAM_SESSION_SECRET, Date.now())
  if (!parsed) return json({ ok: false, error: 'challenge expired' }, 401)

  // Rate-limit the second factor on its own key: six digits is a small space, so an
  // unbounded challenge would reduce 2FA to a brute-forceable formality.
  const mfaKey = `mfa:${parsed.accountId}`
  const verdict = limiter.blocked(mfaKey)
  if (!verdict.allowed) return tooManyRequests(verdict.retryAfterSec)

  const account = await getAccount(parsed.accountId)
  if (!account || account.sessionVersion !== parsed.sessionVersion) {
    return json({ ok: false, error: 'challenge expired' }, 401)
  }
  const mfa = await getMfa(parsed.accountId)
  if (!mfa) return json({ ok: false, error: 'challenge expired' }, 401)

  let usedRecovery = false
  let ok = verifyTotp(mfa.secret, code, Math.floor(Date.now() / 1000))
  if (!ok) {
    ok = await consumeRecoveryCode(parsed.accountId, hashRecoveryCode(code))
    usedRecovery = ok
  }
  if (!ok) {
    limiter.fail(mfaKey, RULES.login)
    void writeAudit({ action: 'login.mfa_failure', ip: 'unknown', actorId: parsed.accountId })
    return json({ ok: false, error: 'invalid code' }, 401)
  }
  limiter.reset(mfaKey)
  if (usedRecovery) void writeAudit({ action: 'mfa.recovery_used', ip: 'unknown', actorId: parsed.accountId })
  void writeAudit({ action: 'login.success', ip: 'unknown', actorId: parsed.accountId, meta: { secondFactor: usedRecovery ? 'recovery' : 'totp' } })

  await updateAccount(account._id, { lastLoginAt: new Date() })
  const cookie = makePrincipalSessionCookieHeader(account._id, account.sessionVersion)
  return new Response(
    JSON.stringify({
      ok: true,
      mustChangePassword: account.mustChangePassword ?? false,
      usedRecovery,
      recoveryCodesLeft: usedRecovery ? Math.max(0, mfa.recoveryHashes.length - 1) : mfa.recoveryHashes.length,
    }),
    { status: 200, headers: { ...JSON_CT, 'Set-Cookie': cookie } },
  )
}

/**
 * POST /api/iam/stepup  Body: { password?, code? }
 * Re-authenticates the CURRENT session and returns a short-lived grant for destructive
 * operations (see stepup.ts). Which credential is demanded is decided by `proveStepUp`: the
 * second factor alone once enrolled (a live authenticator code or a single-use recovery code),
 * the password otherwise.
 *
 * The refusal names the factor it wanted (`mfaRequired`). That is not an oracle — the caller is
 * already authenticated as this account and can read the same fact from GET /api/iam/mfa — and
 * without it the dialog asks an enrolled user for their password, refuses it, and closes.
 */
export async function handleStepUp(req: Request, ip = 'unknown'): Promise<Response> {
  const session = await getPrincipalSession(req)
  if (!session) return json({ ok: false, error: 'unauthorized' }, 401)
  const account = await getAccount(session.principal.accountId)
  if (!account) return json({ ok: false, error: 'unauthorized' }, 401)

  const parsedBody = await readJsonLimited<unknown>(req, LIMITS.bodyBytes)
  if (!parsedBody.ok) {
    return json({ ok: false, error: parsedBody.error }, parsedBody.error === 'too_large' ? 413 : 400)
  }
  const b = parsedBody.value as Record<string, unknown>
  const password = typeof b.password === 'string' ? b.password : ''
  const code = typeof b.code === 'string' ? b.code : ''

  // Same rate-limit treatment as login: this endpoint verifies a credential, so it is a
  // guessing oracle if left unbounded — and the argon2 verify below is expensive.
  const key = `stepup:${account._id}`
  const verdict = limiter.blocked(key)
  if (!verdict.allowed) return tooManyRequests(verdict.retryAfterSec)

  const mfa = await getMfa(account._id)
  // Once a second factor is enrolled, step-up MUST be proven with it — for a manager and an
  // owner equally (stepUpRequiresCode takes no role parameter at all). A stolen cookie plus a
  // stolen password must not be enough to step up an MFA-enrolled account.
  const proof = await proveStepUp({ password, code }, !!mfa, {
    verifyPassword: pw => verifyPassword(pw, account.passwordHash),
    verifyTotp: c => !!mfa && verifyTotp(mfa.secret, c, Math.floor(Date.now() / 1000)),
    consumeRecoveryCode: c => consumeRecoveryCode(account._id, hashRecoveryCode(c)),
  })
  if (!proof.ok) {
    limiter.fail(key, RULES.login)
    void writeAudit({ action: 'stepup.failure', ip, actorId: account._id })
    return json({ ok: false, error: 'invalid credentials', mfaRequired: stepUpRequiresCode(!!mfa) }, 401)
  }
  limiter.reset(key)
  // A spent recovery code is a fact an incident review needs: it is the moment an account stopped
  // being protected by the authenticator that is supposed to hold it.
  if (proof.factor === 'recovery') void writeAudit({ action: 'mfa.recovery_used', ip, actorId: account._id })
  void writeAudit({ action: 'stepup.granted', ip, actorId: account._id, meta: { factor: proof.factor } })

  const token = signStepUp(
    account._id,
    session.sessionVersion,
    TEAM_SESSION_SECRET,
    Date.now() + STEPUP_TTL_MS,
  )
  return json({ ok: true, token, expiresInSec: STEPUP_TTL_MS / 1000 })
}

/**
 * Proves the second factor of an ALREADY-ENROLLED account: a live authenticator code, or one of
 * the single-use recovery codes. Same pair login accepts, and for the same reason — a lost phone
 * must not be the end of the account. `proveStepUp` holds the rule; this only supplies the
 * verifiers.
 */
async function proveSecondFactor(accountId: string, secret: string, code: string): Promise<{ ok: boolean; usedRecovery: boolean }> {
  const proof = await proveStepUp({ code }, true, {
    verifyPassword: async () => false, // unreachable: enrolled accounts never take a password here
    verifyTotp: c => verifyTotp(secret, c, Math.floor(Date.now() / 1000)),
    consumeRecoveryCode: c => consumeRecoveryCode(accountId, hashRecoveryCode(c)),
  })
  return { ok: proof.ok, usedRecovery: proof.factor === 'recovery' }
}

/**
 * MFA enrolment, all authenticated and all acting on the CALLER's own account:
 *   GET    /api/iam/mfa        → { enabled }
 *   POST   /api/iam/mfa/start  → { secret, otpauthUri }  (generated, not yet active)
 *   POST   /api/iam/mfa/enable { secret, code } → { recoveryCodes } shown exactly once
 *   DELETE /api/iam/mfa        { code } → disables (refused outright for an owner — see
 *                                          `mfaDisableAllowed`)
 */
export async function handleMfa(req: Request, pathname: string, ip = 'unknown'): Promise<Response> {
  const principal = await getPrincipal(req)
  if (!principal) return json({ error: 'unauthorized' }, 401)
  const account = await getAccount(principal.accountId)
  if (!account) return json({ error: 'unauthorized' }, 401)

  if (pathname === '/api/iam/mfa' && req.method === 'GET') {
    return json({ enabled: await isMfaEnabled(account._id) })
  }

  if (pathname === '/api/iam/mfa/start' && req.method === 'POST') {
    const secret = generateSecret()
    return json({ secret, otpauthUri: otpauthUri(secret, account.email, 'Agentistics') })
  }

  if (pathname === '/api/iam/mfa/enable' && req.method === 'POST') {
    let body: unknown
    try { body = await req.json() } catch { return json({ error: 'invalid JSON' }, 400) }
    const b = body as Record<string, unknown>
    const secret = typeof b.secret === 'string' ? b.secret : ''
    const code = typeof b.code === 'string' ? b.code : ''
    // Verifying the code before storing proves the authenticator is really in sync — enrolling
    // an unverified secret locks the account out of its own second factor.
    const nowSec = Math.floor(Date.now() / 1000)
    if (!secret || !verifyTotp(secret, code, nowSec)) {
      // Still refused — but say WHICH failure it is. A code that is right for a different
      // moment means the two clocks disagree, which no amount of retyping fixes.
      const skew = secret ? totpSkewSteps(secret, code, nowSec) : null
      if (skew !== null) {
        return json({ error: 'clock_skew', skewSeconds: skew * TOTP_STEP_SECONDS }, 400)
      }
      return json({ error: 'invalid code' }, 400)
    }
    const recoveryCodes = generateRecoveryCodes()
    await enableMfa(account._id, secret, recoveryCodes.map(hashRecoveryCode))
    void writeAudit({ action: 'mfa.enable', ip, actorId: account._id })
    // Every session that authenticated with the password alone is now under-authenticated.
    await bumpSessionVersion(account._id)
    const cookie = makePrincipalSessionCookieHeader(account._id, account.sessionVersion + 1)
    return new Response(JSON.stringify({ ok: true, recoveryCodes }), {
      status: 200,
      headers: { ...JSON_CT, 'Set-Cookie': cookie },
    })
  }

  // A fresh set of recovery codes, proven with a live code from the authenticator.
  //
  // They used to be issued once, at enrolment, and never again: lose the sheet and the only
  // net under a lost phone was gone, silently. With MFA now mandatory for owners and recovery
  // leaning on it, that gap closes the way back in.
  if (pathname === '/api/iam/mfa/recovery-codes' && req.method === 'POST') {
    let body: unknown
    try { body = await req.json() } catch { body = {} }
    const code = typeof (body as Record<string, unknown>).code === 'string'
      ? ((body as Record<string, unknown>).code as string)
      : ''
    const mfa = await getMfa(account._id)
    if (!mfa) return json({ error: 'mfa not enabled' }, 400)
    const nowSec = Math.floor(Date.now() / 1000)
    const proof = await proveSecondFactor(account._id, mfa.secret, code)
    if (!proof.ok) {
      const skew = totpSkewSteps(mfa.secret, code, nowSec)
      if (skew !== null) return json({ error: 'clock_skew', skewSeconds: skew * TOTP_STEP_SECONDS }, 401)
      return json({ error: 'invalid code' }, 401)
    }
    if (proof.usedRecovery) void writeAudit({ action: 'mfa.recovery_used', ip, actorId: account._id })
    const recoveryCodes = generateRecoveryCodes()
    await enableMfa(account._id, mfa.secret, recoveryCodes.map(hashRecoveryCode))
    void writeAudit({ action: 'mfa.recovery_regenerated', ip, actorId: account._id })
    return json({ ok: true, recoveryCodes })
  }

  if (pathname === '/api/iam/mfa' && req.method === 'DELETE') {
    // Mandatory for owners, full stop: refused before any code is even looked at, so a valid
    // TOTP code or a spent recovery code is not a way around it either. The UI already hides
    // the button (`MfaSetup`'s `canDisable`) — this is the route that actually enforces it, per
    // "the route is the control; the UI is a convenience." A non-owner is unaffected.
    if (!mfaDisableAllowed(account.role)) {
      void writeAudit({ action: 'mfa.disable_refused', ip, actorId: account._id })
      return json({ error: 'mfa is mandatory for owner accounts and cannot be disabled' }, 403)
    }
    let body: unknown
    try { body = await req.json() } catch { body = {} }
    const code = typeof (body as Record<string, unknown>).code === 'string'
      ? ((body as Record<string, unknown>).code as string)
      : ''
    const mfa = await getMfa(account._id)
    if (!mfa) return json({ ok: true })
    const nowSec = Math.floor(Date.now() / 1000)
    // A recovery code is accepted here too — it is precisely the "my authenticator is gone" case,
    // and demanding the missing device to disable the missing device is a closed loop.
    const proof = await proveSecondFactor(account._id, mfa.secret, code)
    if (!proof.ok) {
      const skew = totpSkewSteps(mfa.secret, code, nowSec)
      if (skew !== null) return json({ error: 'clock_skew', skewSeconds: skew * TOTP_STEP_SECONDS }, 401)
      return json({ error: 'invalid code' }, 401)
    }
    if (proof.usedRecovery) void writeAudit({ action: 'mfa.recovery_used', ip, actorId: account._id })
    await disableMfa(account._id)
    void writeAudit({ action: 'mfa.disable', ip, actorId: account._id })
    return json({ ok: true })
  }

  return json({ error: 'not found' }, 404)
}

/**
 * GET /api/iam/me → { authed, account? }. Drives the logged-in-user display + the SPA gate.
 */
export async function handleIamMe(req: Request): Promise<Response> {
  const principal = await getPrincipal(req)
  if (!principal) return json({ authed: false })
  const account = await getAccount(principal.accountId)
  if (!account) return json({ authed: false })
  // Whether this caller still owes an enrolment. The gate in index.ts already refuses their
  // requests; without saying so HERE the SPA only sees 403s and renders "failed to load", which
  // is how a mandatory second factor reads as a broken dashboard.
  const mfaEnrollmentRequired =
    CAPS.requireMfaForOwner &&
    account.role === 'owner' &&
    !(await isMfaEnabled(account._id).catch(() => true))
  return json({ authed: true, account: publicAccount(account), mfaEnrollmentRequired })
}

/**
 * POST /api/iam/recover — the "forgot my password" path for an OWNER.
 * Body: { email, code, newPassword }
 *
 * The account proves itself with its SECOND FACTOR — a live authenticator code, or one of the
 * single-use recovery codes — and sets a new password in the same step. No e-mail is sent
 * because a self-hosted central has no mail server; the proof is something the owner already
 * holds.
 *
 * The trade this makes is deliberate and worth naming: for an owner, possession of the
 * authenticator (or the recovery sheet) now equals the account, where before it was worthless
 * without the password. That is why the second factor is MANDATORY for owners, why every other
 * owner is notified when it happens, why it is audited, and why every session dies with the old
 * password — prevention is not available at this moment, so what is left is making it loud.
 *
 * Members do NOT get this path: they may have no second factor at all, and an owner (or a
 * manager of their team) can already reset them. Extending it to any MFA-enrolled account is a
 * one-line change if that is ever wanted.
 *
 * Answers are deliberately identical for "no such account", "not an owner", "no MFA" and "wrong
 * code": this endpoint is public, and each distinction would be a free oracle.
 */
export async function handleRecover(req: Request, ip = 'unknown'): Promise<Response> {
  const parsedBody = await readJsonLimited<unknown>(req, LIMITS.bodyBytes)
  if (!parsedBody.ok) {
    return json({ ok: false, error: parsedBody.error }, parsedBody.error === 'too_large' ? 413 : 400)
  }
  const b = parsedBody.value as Record<string, unknown>
  const email = typeof b.email === 'string' ? b.email : ''
  const code = typeof b.code === 'string' ? b.code.trim() : ''
  const newPassword = typeof b.newPassword === 'string' ? b.newPassword : ''

  const deny = () => json({ ok: false, error: 'invalid email or code' }, 401)

  // Per-account backoff before any work: the codes are 40 bits each, which is ample WITH a
  // limiter in front and weak without one.
  const key = `recover:${normalizeEmail(email)}`
  const verdict = limiter.blocked(key)
  if (!verdict.allowed) return tooManyRequests(verdict.retryAfterSec)

  const account = await findAccountByEmail(email)
  const mfa = account ? await getMfa(account._id) : null
  if (!account || account.role !== 'owner' || !mfa) {
    limiter.fail(key, RULES.login)
    void writeAudit({ action: 'password.recover_failure', ip, meta: { email: normalizeEmail(email) } })
    return deny()
  }

  // The password is checked BEFORE the code is burned: a rejected password must not cost the
  // caller one of the ten codes they may be down to.
  const policy = validatePasswordPolicy(newPassword, { email: account.email, name: account.name })
  if (!policy.ok) return json({ ok: false, error: policy.error }, 400)

  const nowSec = Math.floor(Date.now() / 1000)
  let usedRecovery = false
  if (!verifyTotp(mfa.secret, code, nowSec)) {
    usedRecovery = await consumeRecoveryCode(account._id, hashRecoveryCode(code))
    if (!usedRecovery) {
      limiter.fail(key, RULES.login)
      // Same refusal, but say WHICH failure when the clock is the problem — otherwise a drifted
      // server reads as "my recovery codes don't work either".
      const skew = totpSkewSteps(mfa.secret, code, nowSec)
      void writeAudit({ action: 'password.recover_failure', ip, actorId: account._id })
      if (skew !== null) return json({ ok: false, error: 'clock_skew', skewSeconds: skew * TOTP_STEP_SECONDS }, 401)
      return deny()
    }
  }
  limiter.reset(key)

  await updateAccount(account._id, {
    passwordHash: await hashPassword(newPassword),
    // They chose this password themselves; forcing another change at the next login would be
    // ceremony, not security.
    mustChangePassword: false,
  })
  await bumpSessionVersion(account._id)
  void writeAudit({
    action: 'password.recover',
    ip,
    actorId: account._id,
    meta: { secondFactor: usedRecovery ? 'recovery' : 'totp' },
  })

  // Loud on purpose: if this was not you, the notification is the only chance to notice.
  try {
    const { broadcastNotification } = await import('./sse')
    broadcastNotification({
      type: 'warning',
      code: 'iam.password_recovered',
      meta: { email: account.email, factor: usedRecovery ? 'recovery' : 'totp' },
      // The account itself (so the affected person notices), the owner, and a manager of one of
      // its teams — the same reach `accountVisibleTo` already grants over that account elsewhere.
      // Previously this reached every account on the central.
      subject: { kind: 'account', id: account._id },
    })
  } catch { /* the reset stands even if nobody could be told */ }

  const left = usedRecovery ? Math.max(0, mfa.recoveryHashes.length - 1) : mfa.recoveryHashes.length
  return json({ ok: true, usedRecovery, recoveryCodesLeft: left })
}

/**
 * POST /api/iam/reset-request — PUBLIC. Body: { email, reason? }
 *
 * A member who cannot sign in asks the people who can already reset them. It grants nothing and
 * changes nothing: it writes a row and rings a bell. The reset itself stays where it was, behind
 * the account PATCH and its step-up.
 *
 * Always answers `{ ok: true }`. An honest 404 here would tell an anonymous caller which
 * e-mails have accounts, and the whole point of the endpoint is that anyone can reach it.
 */
export async function handleResetRequest(req: Request, ip = 'unknown'): Promise<Response> {
  const parsedBody = await readJsonLimited<unknown>(req, LIMITS.bodyBytes)
  if (!parsedBody.ok) {
    return json({ ok: false, error: parsedBody.error }, parsedBody.error === 'too_large' ? 413 : 400)
  }
  const b = parsedBody.value as Record<string, unknown>
  const email = typeof b.email === 'string' ? b.email : ''

  const key = `reset-req:${normalizeEmail(email)}`
  const verdict = limiter.blocked(key)
  if (!verdict.allowed) return tooManyRequests(verdict.retryAfterSec)

  const account = await findAccountByEmail(email)
  if (!account) {
    // Costs the caller an attempt, so the endpoint cannot be walked through an address list at
    // speed, and says nothing about the outcome.
    limiter.fail(key, RULES.login)
    void writeAudit({ action: 'password.reset_requested', ip, meta: { email: normalizeEmail(email), known: false } })
    return json({ ok: true })
  }

  const { openResetRequest, normalizeReason } = await import('./reset-requests')
  const reason = normalizeReason(b.reason)
  const isNew = await openResetRequest({
    accountId: account._id,
    email: account.email,
    name: account.name,
    reason,
    now: new Date(),
  })
  void writeAudit({ action: 'password.reset_requested', ip, targetId: account._id, meta: { known: true, duplicate: !isNew } })

  if (isNew) {
    try {
      const { broadcastNotification } = await import('./sse')
      // Deliberately anonymous IN THE PAYLOAD — no email/name/reason travels here, those live
      // behind the authenticated queue. The SUBJECT is the requesting account, so delivery is
      // scoped by the same `accountVisibleTo` reach used elsewhere for this account: the owner,
      // a manager of one of its teams, or the account itself. A plain user no longer learns that
      // SOME colleague, somewhere, forgot their password. (The queue below is scoped by the
      // stricter `canDeleteAccount` — who may actually ACT on the request — which is a narrower
      // question than "who may hear that one exists".)
      broadcastNotification({
        type: 'info', code: 'iam.reset_requested', subject: { kind: 'account', id: account._id },
      })
    } catch { /* the row is what matters; the bell is a courtesy */ }
  }
  return json({ ok: true })
}

/**
 * GET /api/iam/reset-requests — the open queue, scoped to what the caller could act on.
 * DELETE /api/iam/reset-requests?id=… — dismiss one without resetting anything.
 *
 * Scope is `canDeleteAccount`, the same authority that already governs resetting somebody's
 * password: an owner sees all of them, a manager sees the user-members of the teams they manage.
 * A request nobody may act on is not shown to anybody — it waits for an owner.
 */
export async function handleResetRequests(req: Request, url: URL): Promise<Response> {
  const principal = await getPrincipal(req)
  if (!principal) return json({ error: 'unauthorized' }, 401)
  const { listOpenResetRequests, closeResetRequests, getResetRequest } = await import('./reset-requests')

  if (req.method === 'GET') {
    const open = await listOpenResetRequests()
    const visible = []
    for (const r of open) {
      const target = await getAccount(r.accountId)
      if (target && canDeleteAccount(principal, target)) {
        visible.push({
          id: r._id,
          accountId: r.accountId,
          email: r.email,
          name: r.name,
          reason: r.reason,
          createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
          status: r.status,
        })
      }
    }
    return json({ requests: visible })
  }

  if (req.method === 'DELETE') {
    const id = url.searchParams.get('id') ?? ''
    const doc = await getResetRequest(id)
    if (!doc) return json({ error: 'not found' }, 404)
    const target = await getAccount(doc.accountId)
    if (!target || !canDeleteAccount(principal, target)) return json({ error: 'forbidden' }, 403)
    await closeResetRequests(doc.accountId, principal.accountId, 'dismissed', new Date())
    return json({ ok: true })
  }

  return json({ error: 'not found' }, 404)
}

/**
 * POST /api/iam/change-password  Body: { currentPassword?, newPassword }
 * Self-service password change. currentPassword is required UNLESS the account is flagged
 * mustChangePassword (forced first-login change). Bumps sessionVersion to invalidate old
 * sessions, then re-issues the caller's principal cookie with the bumped version so they
 * stay logged in.
 */
export async function handleChangePassword(req: Request): Promise<Response> {
  const principal = await getPrincipal(req)
  if (!principal) return json({ error: 'unauthorized' }, 401)
  let body: unknown
  try { body = await req.json() } catch { return json({ error: 'invalid JSON' }, 400) }
  const b = body as Record<string, unknown>
  const current = typeof b.currentPassword === 'string' ? b.currentPassword : ''
  const next = typeof b.newPassword === 'string' ? b.newPassword : ''
  const account = await getAccount(principal.accountId)
  if (!account) return json({ error: 'account not found' }, 404)
  const policy = validatePasswordPolicy(next, { email: account.email, name: account.name })
  if (!policy.ok) return json({ error: policy.error }, 400)
  // require currentPassword unless this is a forced first-login change
  if (!account.mustChangePassword) {
    if (!(await verifyPassword(current, account.passwordHash))) return json({ error: 'current password is incorrect' }, 401)
  }
  void writeAudit({ action: 'password.change', ip: 'unknown', actorId: account._id })
  const passwordHash = await hashPassword(next)
  await updateAccount(account._id, { passwordHash, mustChangePassword: false })
  await bumpSessionVersion(account._id) // invalidate old sessions
  // Re-issue with the bumped version (stored version is now account.sessionVersion + 1)
  // so the caller stays logged in.
  const cookie = makePrincipalSessionCookieHeader(account._id, account.sessionVersion + 1)
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...JSON_CT, 'Set-Cookie': cookie } })
}

/** Parse an unknown value into a Membership[] (drops malformed entries). */
function parseMemberships(v: unknown): Membership[] {
  if (!Array.isArray(v)) return []
  const out: Membership[] = []
  for (const m of v) {
    const r = (m as Record<string, unknown>)?.role
    const t = (m as Record<string, unknown>)?.teamId
    if (typeof t === 'string' && (r === 'manager' || r === 'user')) out.push({ teamId: t, role: r })
  }
  return out
}

/** Machine-link requests from create body: `machines: [{name, teamId?}]` (+ single `machine:{name}`
 *  alias). Drops entries without a non-empty name. Each becomes its own minted machine token. */
function parseMachineRequests(machines: unknown, single: unknown): { name: string; teamId?: string }[] {
  const out: { name: string; teamId?: string }[] = []
  if (Array.isArray(machines)) {
    for (const m of machines) {
      const name = typeof (m as Record<string, unknown>)?.name === 'string' ? ((m as Record<string, unknown>).name as string).trim() : ''
      const teamId = typeof (m as Record<string, unknown>)?.teamId === 'string' ? ((m as Record<string, unknown>).teamId as string) : undefined
      if (name) out.push({ name, ...(teamId ? { teamId } : {}) })
    }
  }
  const singleName = typeof (single as Record<string, unknown> | undefined)?.name === 'string'
    ? ((single as Record<string, unknown>).name as string).trim() : ''
  if (singleName) out.push({ name: singleName })
  return out
}

/**
 * /api/iam/accounts — GET list (scoped), POST create, DELETE remove. Self-guarding.
 */
export async function handleAccounts(req: Request, ip = 'unknown'): Promise<Response> {
  const principal = await getPrincipal(req)
  if (!principal) return json({ error: 'unauthorized' }, 401)

  if (req.method === 'GET') {
    const all = await listAccounts()
    return json({ accounts: all.filter(a => accountVisibleTo(principal, a)).map(publicAccount) })
  }

  if (req.method === 'POST') {
    let body: unknown
    try { body = await req.json() } catch { return json({ error: 'invalid JSON' }, 400) }
    const b = body as Record<string, unknown>
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    const email = typeof b.email === 'string' ? b.email.trim() : ''
    const password = typeof b.password === 'string' ? b.password : ''
    const role: Role = b.role === 'owner' ? 'owner' : 'member'
    const memberships = parseMemberships(b.memberships)
    const mustChangePassword = typeof b.mustChangePassword === 'boolean' ? b.mustChangePassword : true
    // Machines to link at creation: accept `machines: [{name, teamId?}]` (multiple, each mints its
    // own token) plus a single `machine: {name}` alias for back-compat.
    const machineReqs = parseMachineRequests(b.machines, b.machine)
    if (!name) return json({ error: 'name is required' }, 400)
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'valid email is required' }, 400)
    const policy = validatePasswordPolicy(password, { email, name })
    if (!policy.ok) return json({ error: policy.error }, 400)
    // Only an owner may create another owner (global, no team scope). A member account follows the
    // scoped canCreateAccount rule (owner→any; manager→user-role memberships in teams they manage).
    if (role === 'owner') {
      if (principal.role !== 'owner') return json({ error: 'forbidden' }, 403)
    } else if (!canCreateAccount(principal, memberships)) {
      return json({ error: 'forbidden' }, 403)
    }
    if (await findAccountByEmail(email)) return json({ error: 'email already exists' }, 409)
    const passwordHash = await hashPassword(password)
    const account = role === 'owner'
      ? await createAccount({ name, email, passwordHash, role: 'owner', memberships: [], createdBy: principal.accountId, mustChangePassword })
      : await createAccount({ name, email, passwordHash, role: 'member', memberships, createdBy: principal.accountId, mustChangePassword })
    // Link the requested machines — one token per machine, each gated by team scope.
    const fallbackTeam = account.memberships[0]?.teamId || 'default'
    const centralUrl = (await getCentralConfig()).publicUrl
    const machineTokens: { name: string; token: string }[] = []
    for (const m of machineReqs) {
      const teamId = (m.teamId && account.memberships.some(x => x.teamId === m.teamId)) ? m.teamId : fallbackTeam
      if (!canManageMachineTeam(principal, teamId)) continue // out-of-scope machine link is skipped
      const { token } = await mintMachineToken({ accountId: account._id, user: account.name, machineName: m.name, teamId })
      machineTokens.push({ name: m.name, token: packConnectToken(token, centralUrl) })
    }
    const firstToken = machineTokens[0]?.token
    void writeAudit({
      action: 'account.create',
      ip,
      actorId: principal.accountId,
      targetId: account._id,
      meta: { role: account.role, email: account.email },
    })
    return json({
      account: publicAccount(account),
      ...(firstToken ? { machineTokens, machineToken: firstToken } : {}),
    }, 201)
  }

  if (req.method === 'PATCH') {
    let body: unknown
    try { body = await req.json() } catch { return json({ error: 'invalid JSON' }, 400) }
    const b = body as Record<string, unknown>
    const id = typeof b.id === 'string' ? b.id : ''
    if (!id) return json({ error: 'id is required' }, 400)
    const target = await getAccount(id)
    if (!target) return json({ error: 'not found' }, 404)

    const memberships = b.memberships !== undefined ? parseMemberships(b.memberships) : undefined
    const resetPassword = b.resetPassword === true

    // Single gate for both the account-info edit and the admin password reset — see
    // authorizeAccountPatch's doc comment for the exact scope (self / owner / manager rules).
    // It never sees a `role` field at all, so escalating a target's global role through this
    // endpoint is not merely refused, it is inexpressible.
    const authz = authorizeAccountPatch(principal, target, { name: typeof b.name === 'string' ? b.name : undefined, memberships, resetPassword })
    if (!authz.ok) return json({ error: authz.error }, 403)

    // An admin resetting SOMEONE ELSE's password is rate-limited per ACTOR (soft backoff, same
    // shape as the login/stepup limiters) — this is a guessable-adjacent, high-impact action, and
    // the generic per-IP ceiling in index.ts is not enough to bound how many accounts one
    // compromised manager session could reset in a burst.
    if (resetPassword) {
      const resetKey = `admin-reset:${principal.accountId}`
      const verdict = limiter.check(resetKey, RULES.login, Date.now())
      if (!verdict.allowed) return tooManyRequests(verdict.retryAfterSec)
    }

    const patch: Partial<Pick<AccountDoc, 'name' | 'memberships' | 'passwordHash' | 'mustChangePassword'>> = {}

    if (b.name !== undefined) {
      const name = typeof b.name === 'string' ? b.name.trim() : ''
      if (!name) return json({ error: 'name cannot be empty' }, 400)
      patch.name = name
    }

    if (memberships !== undefined) {
      patch.memberships = memberships
    }

    let tempPassword: string | undefined
    if (resetPassword) {
      tempPassword = randomBytes(12).toString('hex') // 24 hex chars
      patch.passwordHash = await hashPassword(tempPassword)
      patch.mustChangePassword = true
    }

    if (Object.keys(patch).length === 0) return json({ error: 'nothing to update' }, 400)
    await updateAccount(target._id, patch)
    // A password reset invalidates the target's existing sessions (forces re-login → first change).
    if (resetPassword) {
      await bumpSessionVersion(target._id)
      // The queue must not disagree with reality: whoever just reset this account answered
      // whatever request was open for it, whether or not they came in through the list.
      const { closeResetRequests } = await import('./reset-requests')
      await closeResetRequests(target._id, principal.accountId, 'done', new Date()).catch(() => 0)
      void writeAudit({ action: 'password.reset_admin', ip, actorId: principal.accountId, targetId: target._id })
    } else {
      void writeAudit({
        action: 'account.update',
        ip,
        actorId: principal.accountId,
        targetId: target._id,
        meta: { fields: Object.keys(patch) },
      })
    }

    const updated = await getAccount(target._id)
    return json({
      ok: true,
      account: publicAccount(updated ?? target),
      ...(tempPassword ? { tempPassword } : {}),
    })
  }

  if (req.method === 'DELETE') {
    let body: unknown
    try { body = await req.json() } catch { return json({ error: 'invalid JSON' }, 400) }
    const id = typeof (body as Record<string, unknown>)?.id === 'string' ? (body as Record<string, unknown>).id as string : ''
    if (!id) return json({ error: 'id is required' }, 400)
    if (id === principal.accountId) return json({ error: 'cannot delete yourself' }, 400)
    const target = await getAccount(id)
    if (!target) return json({ error: 'not found' }, 404)
    if (!canDeleteAccount(principal, target)) return json({ error: 'forbidden' }, 403)
    // Last-owner protection: never leave the instance with zero owners.
    if (target.role === 'owner' && (await countOwners()) <= 1) {
      return json({ error: 'cannot delete the last owner' }, 400)
    }
    await deleteAccount(id)
    // Detach the deleted account from any machines it owned — the machines survive, they just lose
    // the dead owner relation (no orphaned accountId left dangling).
    await detachAccountFromAllMachines(id).catch(() => {})
    // Their UI preferences have no owner left. Best effort: a failure here must not fail a delete
    // that already happened.
    await deleteUserPrefs(id).catch(() => {})
    void writeAudit({ action: 'account.delete', ip, actorId: principal.accountId, targetId: id })
    return json({ ok: true })
  }

  return json({ error: 'method not allowed' }, 405)
}

/**
 * /api/iam/teams — GET list (scoped), POST create (owner), DELETE remove (owner, not default).
 */
export async function handleTeams(req: Request): Promise<Response> {
  const principal = await getPrincipal(req)
  if (!principal) return json({ error: 'unauthorized' }, 401)

  if (req.method === 'GET') {
    const all = await listTeams()
    return json({ teams: all.filter(t => teamVisibleTo(principal, t._id)) })
  }

  if (req.method === 'POST') {
    if (principal.role !== 'owner') return json({ error: 'forbidden' }, 403)
    let body: unknown
    try { body = await req.json() } catch { return json({ error: 'invalid JSON' }, 400) }
    const name = typeof (body as Record<string, unknown>)?.name === 'string' ? ((body as Record<string, unknown>).name as string).trim() : ''
    if (!name) return json({ error: 'name is required' }, 400)
    const team = await createTeam(name, principal.accountId)
    return json({ team }, 201)
  }

  if (req.method === 'DELETE') {
    if (principal.role !== 'owner') return json({ error: 'forbidden' }, 403)
    let body: unknown
    try { body = await req.json() } catch { return json({ error: 'invalid JSON' }, 400) }
    const id = typeof (body as Record<string, unknown>)?.id === 'string' ? (body as Record<string, unknown>).id as string : ''
    if (!id) return json({ error: 'id is required' }, 400)
    if (!(await getTeam(id))) return json({ error: 'not found' }, 404)
    await deleteTeam(id)
    // Detach the deleted team from any machines in it (no orphaned teamId left showing as a raw _id)
    // and from any account memberships that referenced it.
    await detachTeamFromAllMachines(id).catch(() => {})
    try {
      const accounts = await listAccounts()
      for (const a of accounts) {
        if (a.memberships.some(m => m.teamId === id)) {
          await updateAccount(a._id, { memberships: a.memberships.filter(m => m.teamId !== id) })
        }
      }
    } catch { /* best-effort */ }
    return json({ ok: true })
  }

  return json({ error: 'method not allowed' }, 405)
}

/**
 * /api/iam/machines — GET list (scoped), POST add-to-account (gated). Self-guarding.
 * Owner sees/manages all; a manager only their team's machines.
 */
export async function handleMachines(req: Request, ip = 'unknown'): Promise<Response> {
  const principal = await getPrincipal(req)
  if (!principal) return json({ error: 'unauthorized' }, 401)
  if (req.method === 'GET') {
    const all = await listMachines()
    // Owner sees all; anyone else sees machines in teams they manage PLUS their own account's
    // machines (so a user can view/manage the machines linked to them).
    // Enrich with owner account info — ONLY for accounts the caller may actually see, so a manager
    // never learns an owner account's name/email via a default-team machine.
    const accounts = await listAccounts()
    const accountMap = new Map<string, AccountDoc>()
    for (const a of accounts) accountMap.set(a._id, a)
    // A machine's teams include its owner accounts' teams, so a manager sees the machines of the
    // people in the team they manage — not only machines someone separately stamped with the team.
    const accountTeams: Record<string, string[]> = {}
    for (const a of accounts) accountTeams[a._id] = a.memberships.map(m => m.teamId)

    const visible = principal.role === 'owner' ? all : all.filter(m => canManageMachine(principal, m))

    // Enrich with presence keyed by MACHINE id (memberId) — never by `user`. Two machines can
    // share (or both lack) a `user`, most sharply for two ownerless machines, which both carry
    // `user: ''`; the person-level `computePresence()` intentionally folds several machines under
    // one key, which is exactly what this row-per-machine list must not do.
    const presence = await import('./team-presence').then(m => m.computeMachinePresence()).catch(() => ({} as Record<string, { online: boolean; latencyMs: number | null }>))

    // What each machine has agreed this central may do with its sessions. Read only for the
    // machine's OWN accounts (`machineOwnedBy`, deliberately narrower than the `canManageMachine`
    // that decided visibility above): administering a machine belongs to whoever runs the
    // instance, reaching into its live sessions belongs to its user. Every other caller — the
    // instance owner included — sees the field absent, which is the same shape as a machine that
    // has not spoken, so nothing downstream has to special-case being told nothing.
    const { machineConsent } = await import('./machine-consent')

    const enriched = visible.map(m => {
      // Resolve every owner account the caller may actually see (no cross-scope name/email leak).
      const owners = m.accountIds
        .map(id => accountMap.get(id))
        .filter((a): a is AccountDoc => !!a && accountVisibleTo(principal, a))
        .map(a => ({ id: a._id, name: a.name, email: a.email }))
      return {
        ...m,
        owners,
        // Back-compat: primary owner's name/email for any caller still reading the flat fields.
        ...(owners[0] ? { accountName: owners[0].name, accountEmail: owners[0].email } : {}),
        online: presence[m.id]?.online ?? false,
        latencyMs: presence[m.id]?.latencyMs ?? null,
        // `null` (has not said) and `{sessions:false}` (says no) are DIFFERENT facts and both
        // travel — one sends the owner to check whether the machine is running, the other to the
        // switch. Absent means the caller may not ask.
        // The SESSION gate, deliberately narrower than `machineOwnedBy`: linking an account is
        // administration, reaching into the machine's terminals is a grant the owner makes on
        // purpose. See `@agentistics/core/machineSessions`.
        ...(machineSessionsAllowed(principal, m) ? { remoteConsent: machineConsent(m.id) } : {}),
        // The grant list itself, so the owner's drawer can draw a switch per linked account. Only
        // the person who may CHANGE it is told what it currently is.
        ...(canGrantMachineSessions(principal, m) ? { sessionAccountIds: machineSessionAccounts(m) } : {}),
      }
    })

    return json({ machines: enriched })
  }
  if (req.method === 'POST') {
    let body: unknown
    try { body = await req.json() } catch { return json({ error: 'invalid JSON' }, 400) }
    const b = body as Record<string, unknown>
    // Set a machine's owner ACCOUNTS (scoped): { ownerId, accountIds: string[] } (a single
    // { accountId } is also accepted). A machine may be owned/managed by several accounts. Every
    // account in the new set must be visible to the caller, and the caller must manage the machine.
    const ownerId = typeof b.ownerId === 'string' ? b.ownerId : ''
    if (ownerId) {
      const accountIds = Array.isArray(b.accountIds)
        ? b.accountIds.filter((x): x is string => typeof x === 'string')
        : (typeof b.accountId === 'string' ? [b.accountId] : [])
      const machine = (await listMachines()).find(m => m.id === ownerId)
      if (!machine) return json({ error: 'machine not found' }, 404)
      if (!canManageMachine(principal, machine)) return json({ error: 'forbidden' }, 403)
      // Validate every target account exists + is visible to the caller (no assigning to
      // out-of-scope accounts). An empty list is allowed (clears ownership) only for an owner.
      if (accountIds.length === 0 && principal.role !== 'owner') return json({ error: 'accountIds is required' }, 400)
      for (const id of accountIds) {
        const acct = await getAccount(id)
        if (!acct) return json({ error: 'account not found' }, 404)
        if (!accountVisibleTo(principal, acct)) return json({ error: 'forbidden' }, 403)
      }
      // The machine's display identity follows its (first) owner account, so a re-assigned machine
      // stops showing the previous — possibly deleted — account's name.
      // The SESSION grant, when the body carries one. Only the machine's OWNER may decide it —
      // not an instance owner, who administers the installation and is deliberately not given the
      // ability to hand out other people's terminals. A body that asks for it without the right is
      // REFUSED rather than silently ignored: a switch that reports success and changes nothing is
      // worse than one that says no.
      let grant: string[] | undefined
      if (Array.isArray(b.sessionAccountIds)) {
        if (!canGrantMachineSessions(principal, machine)) {
          return json({ error: 'only the machine owner may grant session management' }, 403)
        }
        grant = resolveSessionGrant(accountIds, b.sessionAccountIds.filter((x): x is string => typeof x === 'string'))
      }
      const nextUser = accountIds[0] ? (await getAccount(accountIds[0]))?.name : undefined
      await setMachineOwners(ownerId, accountIds, nextUser, grant)
      // Tell the machine over the reverse WebSocket so a solo/member instance refreshes the
      // "Connected as" panel instead of showing the old account until its next handshake.
      try {
        const actor = (await getAccount(principal.accountId))?.name ?? 'an admin'
        const { notifyMember } = await import('./team-agent')
        notifyMember(machine.id, { type: 'reassigned', account: nextUser ?? null, actor })
      } catch { /* best-effort — the identity still reflects via whoami */ }
      void writeAudit({ action: 'machine.update', ip, actorId: principal.accountId, targetId: ownerId, meta: { field: 'owners' } })
      return json({ ok: true })
    }
    // Rename a machine (scoped): { renameId, name }. Updates the token label; the new name
    // reflects on the machine at its next whoami handshake. Owner / team-manager / the machine's
    // own account may rename.
    const renameId = typeof b.renameId === 'string' ? b.renameId : ''
    if (renameId) {
      const newName = typeof b.name === 'string' ? b.name.trim() : ''
      if (!newName) return json({ error: 'name is required' }, 400)
      const machine = (await listMachines()).find(m => m.id === renameId)
      if (!machine) return json({ error: 'machine not found' }, 404)
      if (!canManageMachine(principal, machine)) return json({ error: 'forbidden' }, 403)
      await setMachineLabel(renameId, newName)
      // Notify the machine over the reverse WebSocket (best-effort) with the new name + who did it.
      try {
        const actor = (await getAccount(principal.accountId))?.name ?? 'an admin'
        const { notifyMember } = await import('./team-agent')
        notifyMember(machine.id, { type: 'renamed', name: newName, actor })
      } catch { /* best-effort — the name still reflects via whoami */ }
      void writeAudit({ action: 'machine.update', ip, actorId: principal.accountId, targetId: renameId, meta: { field: 'name' } })
      return json({ ok: true })
    }
    // Rotate a machine's token (scoped): { rotateId } → new plaintext token once. Lets an admin OR
    // the machine's owner recover a lost token (the shown-once token can't be re-displayed).
    const rotateId = typeof b.rotateId === 'string' ? b.rotateId : ''
    if (rotateId) {
      const machine = (await listMachines()).find(m => m.id === rotateId)
      if (!machine) return json({ error: 'machine not found' }, 404)
      if (!canManageMachine(principal, machine)) return json({ error: 'forbidden' }, 403)
      const rotated = await rotateToken(rotateId)
      // `null` also covers "another rotation of this machine won the race" (rotate-claim.ts) — from
      // here the two are the same fact: this id no longer names a machine. Reported as 409 rather
      // than 404 so the caller can say "it was just rotated, reload" instead of "no such machine".
      if (rotated === null) return json({ error: 'machine_rotated_or_missing' }, 409)
      // The audit says what MOVED and what was lost: `envelopesDropped` is undelivered sealed mail
      // that no id can open again (the recipient is inside the seal), so it is destroyed by the
      // rotation, not migrated by it. An audit that only recorded the happy half would be a
      // record of a promise, not of what happened.
      void writeAudit({
        action: 'token.rotate', ip, actorId: principal.accountId, targetId: rotateId,
        meta: {
          sessions: rotated.sessions, statsMoved: rotated.statsMoved, workflows: rotated.workflows,
          tags: rotated.tags, keyMoved: rotated.keyMoved, envelopesDropped: rotated.envelopesDropped,
        },
      })
      return json({ token: packConnectToken(rotated.token, (await getCentralConfig()).publicUrl) }, 200)
    }
    // Reassign a machine to another team (scoped): { reassignId, teamId }. Must manage BOTH the
    // machine's current team and the target team. Used by the Teams page to attach a machine.
    // Change a machine's TEAMS (a machine can be in several). Forms:
    //   { reassignId, addTeamId }        → attach one team
    //   { reassignId, removeTeamId }     → detach one team (empty set → loose)
    //   { reassignId, teamIds: [...] }   → replace the whole set (single `teamId` accepted as alias)
    const reassignId = typeof b.reassignId === 'string' ? b.reassignId : ''
    if (reassignId) {
      const machine = (await listMachines()).find(m => m.id === reassignId)
      if (!machine) return json({ error: 'machine not found' }, 404)
      // You must ALREADY manage the machine to change its teams — otherwise a manager could seize a
      // machine they only observed the id of (via a shared/Default team) by attaching it to a team
      // they manage, then rotate/revoke/re-own it. Owner bypasses.
      if (!canManageMachine(principal, machine)) return json({ error: 'forbidden' }, 403)
      const current = machine.teamIds && machine.teamIds.length ? machine.teamIds : (machine.teamId ? [machine.teamId] : [])
      const currentExcluded = machine.excludedTeamIds ?? []
      const inherited = machine.inheritedTeamIds ?? []
      const addTeamId = typeof b.addTeamId === 'string' && b.addTeamId ? b.addTeamId : ''
      const removeTeamId = typeof b.removeTeamId === 'string' && b.removeTeamId ? b.removeTeamId : ''
      let next: string[]
      let nextExcluded: string[] = currentExcluded
      if (addTeamId) {
        if (!(await getTeam(addTeamId))) return json({ error: 'team not found' }, 404)
        if (!canManageMachineTeam(principal, addTeamId)) return json({ error: 'forbidden' }, 403)
        // Re-checking a previously unchecked team just clears the exclusion: the machine goes back
        // to inheriting it from its owner account instead of gaining a redundant direct link.
        nextExcluded = currentExcluded.filter(t => t !== addTeamId)
        const inheritsIt = inherited.includes(addTeamId) || currentExcluded.includes(addTeamId)
        next = inheritsIt ? current : [...new Set([...current, addTeamId])]
      } else if (removeTeamId) {
        // Detach: must manage the team being removed (owner always).
        if (!canManageMachineTeam(principal, removeTeamId)) return json({ error: 'forbidden' }, 403)
        // Dropping it from `teamIds` is NOT enough when the membership is inherited from an owner
        // account — it would come straight back on the next read. The stored exclusion is the
        // record of the removal, and it covers the explicit case too, so one path handles both.
        next = current.filter(t => t !== removeTeamId)
        nextExcluded = [...new Set([...currentExcluded, removeTeamId])]
      } else {
        // Replace the whole set. A non-owner must manage EVERY team involved (old ∪ new) — no Default
        // exemption — so a replace can't drop or add teams outside their scope.
        const raw = Array.isArray(b.teamIds) ? b.teamIds.filter((x): x is string => typeof x === 'string' && !!x)
          : (typeof b.teamId === 'string' && b.teamId ? [b.teamId] : [])
        next = [...new Set(raw)]
        for (const t of next) if (!(await getTeam(t))) return json({ error: 'team not found' }, 404)
        if (principal.role !== 'owner') {
          const involved = [...new Set([...current, ...next])]
          const ok = involved.every(t => canManageMachineTeam(principal, t))
          if (!ok) return json({ error: 'forbidden' }, 403)
        }
        // A full replace states the whole intent, so anything the machine WOULD inherit but was
        // not listed becomes an exclusion, and anything listed stops being excluded.
        nextExcluded = [
          ...currentExcluded.filter(t => !next.includes(t)),
          ...inherited.filter(t => !next.includes(t)),
        ]
      }
      await setMachineTeamsAndExclusions(reassignId, next, [...new Set(nextExcluded)])
      void writeAudit({ action: 'machine.update', ip, actorId: principal.accountId, targetId: reassignId, meta: { field: 'teams' } })
      return json({ ok: true })
    }
    // Mint a new machine: { name, accountIds?: string[], teamId?: string }.
    // Flexible linkage: name required; accountIds (0+) optional; teamId optional.
    // Owners may create any combination (incl. fully loose). Non-owners must provide a teamId they
    // manage (else 403) — prevents managers creating machines outside their scope.
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name) return json({ error: 'name is required' }, 400)
    // accountIds: accept either an array OR a single accountId alias → array (may be empty).
    const accountIds = Array.isArray(b.accountIds)
      ? b.accountIds.filter((x): x is string => typeof x === 'string')
      : (typeof b.accountId === 'string' ? [b.accountId] : [])
    // teamIds: accept an array OR a single teamId alias; empty = loose (no team). No DEFAULT fallback.
    const teamIds = [...new Set(
      (Array.isArray(b.teamIds) ? b.teamIds.filter((x): x is string => typeof x === 'string' && !!x)
        : (typeof b.teamId === 'string' && b.teamId ? [b.teamId] : [])),
    )]
    // Validate every account exists + is visible to the caller (no assigning to out-of-scope accounts).
    for (const id of accountIds) {
      const acct = await getAccount(id)
      if (!acct) return json({ error: 'account not found' }, 404)
      if (!accountVisibleTo(principal, acct)) return json({ error: 'forbidden' }, 403)
    }
    // Validate each team exists.
    for (const t of teamIds) if (!(await getTeam(t))) return json({ error: 'team not found' }, 404)
    // Scope rule: owner may create any combination. A non-owner (manager) MUST provide at least one
    // team AND must manage EVERY team assigned — so they can't create a machine outside their scope.
    if (principal.role !== 'owner') {
      if (teamIds.length === 0 || !teamIds.every(t => canManageMachineTeam(principal, t))) {
        return json({ error: 'select teams you manage' }, 403)
      }
    }
    // user: the first owner account's name, or '' when the machine has no owner. A machine is
    // not a person — falling back to the machine's own name here is what made an ownerless
    // machine surface as a "member" in the user-scoped dimension (filters, MembersPage's "by
    // member" view, presence): every session gets tagged with this `user`, and `distinctUsers`
    // / `filterByUsers` (@agentistics/core) already treat an empty `user` as "no owner" and
    // exclude it from that dimension — the machine dimension (`listMachines`, `machineStatsCaches`)
    // is unaffected and keeps naming it by `machineName`.
    const user = accountIds.length > 0 && accountIds[0]
      ? machineUserFor((await getAccount(accountIds[0]))?.name)
      : machineUserFor(undefined)
    const { token } = await mintMachine({ machineName: name, user, accountIds, teamIds })
    void writeAudit({ action: 'token.mint', ip, actorId: principal.accountId, meta: { name } })
    return json({ token: packConnectToken(token, (await getCentralConfig()).publicUrl) }, 201)
  }
  if (req.method === 'DELETE') {
    // Revoke a machine (scoped): { id }. Cascades to the member's sessions/stats/workflows.
    let body: unknown
    try { body = await req.json() } catch { return json({ error: 'invalid JSON' }, 400) }
    const id = typeof (body as Record<string, unknown>)?.id === 'string' ? (body as Record<string, unknown>).id as string : ''
    if (!id) return json({ error: 'id is required' }, 400)
    const machine = (await listMachines()).find(m => m.id === id)
    if (!machine) return json({ error: 'machine not found' }, 404)
    if (!canManageMachine(principal, machine)) return json({ error: 'forbidden' }, 403)
    const deleted = await revokeToken(id)
    // Cascade cleanup (best-effort) — mirrors handleRevokeToken so the member disappears too.
    try {
      const { getTeamCollection } = await import('./mongo')
      const col = await getTeamCollection()
      await col.deleteMany({ memberId: id })
      const { deleteMemberStats } = await import('./team-stats')
      await deleteMemberStats(id)
      const { deleteMemberWorkflows } = await import('./team-workflows')
      await deleteMemberWorkflows(id)
    } catch { /* best-effort; token already revoked */ }
    void writeAudit({ action: 'token.revoke', ip, actorId: principal.accountId, targetId: id })
    return json({ ok: deleted })
  }
  return json({ error: 'method not allowed' }, 405)
}
