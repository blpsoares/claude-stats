/**
 * redact.ts — strip credentials out of free text before it leaves the machine.
 *
 * WHY THIS EXISTS: `SessionMeta.first_prompt` (and `title`) are the only free text a member
 * pushes to a central. The privacy contract says members push "computed metrics, never chat" —
 * and that is true of the transcript, but a first prompt IS chat. Pasting
 * `MONGO_URL=mongodb+srv://user:pass@host` as the opening message of a session is enough for a
 * production credential to land, in plaintext, in the central's database, where it is then
 * replicated, backed up, and rendered in a dashboard. That is not hypothetical: it is how this
 * module came to be written.
 *
 * DESIGN CONSTRAINT — precision matters more than reach. `first_prompt` is what labels a session
 * in every list in the product. A redactor that also eats `input_tokens=123` or "the token count
 * was 1500" turns every label into noise, and the first thing anyone does with a noisy redactor
 * is disable it. So every generic rule below is guarded by a value-shape test: a secret is long,
 * mixed-character, and not a plain number or an obvious placeholder. When in doubt, this module
 * leaves the text ALONE — it is a safety net for the accidental paste, never a guarantee.
 *
 * It cannot promise to catch everything, and nothing here replaces rotating a leaked credential.
 *
 * Pure and dependency-free, so it runs identically on the member (before the push) and on the
 * central (on ingest, which is what protects against members still running older code).
 */

import type { SharedTask, SharedTaskRecord } from './sharedTask'

export const REDACTION = '[REDACTED]'

/** Obvious non-secrets people type where a secret would go. Never redacted. */
const PLACEHOLDER = /^(\*+|x+|\.+|-+|<[^>]*>|\{[^}]*\}|\$\{?[A-Z_][A-Z0-9_]*\}?|your[-_]?\w*|todo|changeme|none|null|nil|empty|redacted|\[redacted\])$/i

/**
 * Does this value LOOK like a credential rather than prose or a number?
 * Requires real length and at least two character classes — the shape a random secret has and
 * `1500`, `30`, `****` or `<your-key-here>` do not.
 */
function looksSecret(value: string): boolean {
  const v = value.trim().replace(/^["']|["']$/g, '')
  if (v.length < 12) return false
  if (PLACEHOLDER.test(v)) return false
  if (/^\d+$/.test(v)) return false          // 1500, 47291
  if (/\s/.test(v)) return false             // prose, not a token
  const classes = [/[a-z]/.test(v), /[A-Z]/.test(v), /\d/.test(v), /[^A-Za-z0-9]/.test(v)]
    .filter(Boolean).length
  return classes >= 2
}

/** Replace with the marker only when the captured value really looks like a secret. */
function guarded(whole: string, prefix: string, value: string): string {
  return looksSecret(value) ? `${prefix}${REDACTION}` : whole
}

// --- High-confidence provider tokens (self-identifying prefixes/shapes) ---------------------
// These carry their own namespace, so matching them is unambiguous — no value guard needed.
const STRONG: RegExp[] = [
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bsk-ant-[A-Za-z0-9\-_]{16,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9\-_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[A-Za-z0-9\-_]{35}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9\-_]{8,}\.eyJ[A-Za-z0-9\-_]{8,}\.[A-Za-z0-9\-_]{8,}/g, // JWT
  // OUR OWN connect token — `act1_<base64url endpoint>.<hex secret>`, from `packConnectToken`.
  //
  // This list carried GitHub's, Anthropic's, OpenAI's, Slack's, Google's, AWS's and a JWT before it
  // carried agentistics'. The gap was found the way these are: a real one, pasted as a session's
  // opening message, sitting in plaintext in `first_prompt` in the local store — the exact field
  // this module exists to protect, and the one that travels to a central.
  //
  // Unguarded like its neighbours, because `act1_` is a namespace this product mints: nothing else
  // produces it, so there is no prose to protect from a false positive.
  /\bact1_[A-Za-z0-9\-_]+\.[A-Za-z0-9]{16,}/g,
]

/**
 * NOT in the list above, deliberately: the BARE secret half, 64 hex characters (96 for a repo/CI
 * token — see `mintToken`).
 *
 * It carries no namespace, and 64 hex is exactly the shape of a SHA-256 — which this product prints
 * constantly and legitimately, `hashToken`'s own output included. A rule for it would redact any
 * session label that merely quotes a hash, and the first thing anyone does with a noisy redactor is
 * switch it off. A bare secret pasted WITH context is already covered: `ASSIGNMENT` catches
 * `token=<hex>` and `BEARER` catches `Bearer <hex>`. Pasted entirely alone it is indistinguishable
 * from a hash, and this module's stated rule is to leave text alone when in doubt.
 */

/**
 * The password inside a `scheme://user:password@host` URI.
 *
 * Keeps the scheme, the username and the host: those make the text still say WHICH system the
 * session was about, which is the entire value of a session label. Only the password dies.
 */
const URI_CREDENTIAL = /\b([a-z][a-z0-9+.\-]*:\/\/[^\s:/@"']+:)([^\s@"']+)@/gi

/**
 * `KEY=value` / `key: value` for names that mean "this is a secret".
 *
 * The leading `[A-Za-z0-9_]*[_-]` is load-bearing: `\b` does NOT match between `AWS_` and
 * `SECRET`, because `_` is a word character — so an anchored version silently missed
 * `AWS_SECRET_ACCESS_KEY`, the single most famous secret env var there is.
 */
const ASSIGNMENT = /(^|[^A-Za-z0-9_])((?:[A-Za-z0-9]+[_-])*(?:pass(?:word|wd)?|pwd|secret|token|auth|credentials?|api[_-]?key|access[_-]?key|private[_-]?key)[a-z0-9_-]*\s*[:=]\s*)(["']?[^\s"',;]+["']?)/gi

/** `Authorization: Bearer <token>` and bare `Bearer <token>`. */
const BEARER = /\b(Bearer\s+)([A-Za-z0-9\-._~+/]{12,}=*)/g

/**
 * Redact credentials from free text. Pure; returns the input unchanged when nothing matches
 * (same string identity is not guaranteed, but equality is).
 */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string' || text === '') return ''
  let out = text

  for (const re of STRONG) out = out.replace(re, REDACTION)

  out = out.replace(URI_CREDENTIAL, (whole, prefix: string, pw: string) =>
    // A URI password is a secret by position — a short one is still a password. The only thing
    // excluded is an obvious placeholder, so `://user:<pass>@host` in a doc snippet survives.
    PLACEHOLDER.test(pw) ? whole : `${prefix}${REDACTION}@`)

  // `lead` is the delimiter before the key name; it is captured (not just consumed) because
  // dropping it glued the previous word onto the key — "run with PASSWORD=x" → "run withPASSWORD=".
  out = out.replace(ASSIGNMENT, (whole, lead: string, prefix: string, value: string) =>
    guarded(whole, `${lead}${prefix}`, value))
  out = out.replace(BEARER, (whole, prefix: string, value: string) => guarded(whole, prefix, value))

  return out
}

/** True when `redactSecrets` would change this text. Useful for logging/telemetry counts. */
export function containsSecret(text: string): boolean {
  return typeof text === 'string' && text !== '' && redactSecrets(text) !== text
}

/**
 * Redact the free-text fields of one session. Pure — returns a new object only when something
 * actually changed, so an unchanged session keeps its identity and callers can cheaply detect
 * "nothing was scrubbed".
 *
 * `first_prompt` and `title` are the ONLY free text in a SessionMeta; every other field is a
 * count, an id, a path or a timestamp. If a future field carries user prose, add it here.
 */
export function redactSessionText<
  T extends { first_prompt?: string; title?: string; user_label?: string; user_note?: string },
>(session: T): T {
  // Every field here is free text a person typed or pasted, and every one of them travels. Adding a
  // new one to `SessionMeta` without adding it here is how a credential reaches a central through
  // the one field nobody thought of — which is exactly why this is a list and not two lines.
  const fp = session.first_prompt ? redactSecrets(session.first_prompt) : session.first_prompt
  const ti = session.title ? redactSecrets(session.title) : session.title
  const ul = session.user_label ? redactSecrets(session.user_label) : session.user_label
  const un = session.user_note ? redactSecrets(session.user_note) : session.user_note
  if (
    fp === session.first_prompt && ti === session.title
    && ul === session.user_label && un === session.user_note
  ) return session
  return {
    ...session,
    ...(fp !== undefined ? { first_prompt: fp } : {}),
    ...(ti !== undefined ? { title: ti } : {}),
    ...(ul !== undefined ? { user_label: ul } : {}),
    ...(un !== undefined ? { user_note: un } : {}),
  }
}

/**
 * The same scrub, applied to a delivery.
 *
 * A board carries MORE free text than a session does — a title, a description somebody wrote out,
 * every comment body, the subtasks, the reason a card is blocked, the names of the files attached
 * to it — and all of it is text a person typed while working, which is exactly the text a
 * credential gets pasted into. So the list below is the whole of what travels, and a field added
 * to `SharedTask` without an entry here is how a secret reaches a central through the one field
 * nobody thought of. Same reasoning as `redactSessionText`, applied to a bigger document.
 *
 * Called at BOTH boundaries: on the member before the push, and again on the central at ingest —
 * a central cannot assume its members run current code, and in a mixed-version fleet the machine
 * on the old build is exactly the one that leaks.
 *
 * Pure. Returns a new document only when something changed, like `redactSessionText`.
 */
export function redactSharedTask(shared: SharedTask): SharedTask {
  const t = shared.task
  const task: SharedTaskRecord = {
    ...t,
    title: redactSecrets(t.title),
    ...(t.detail !== undefined ? { detail: redactSecrets(t.detail) } : {}),
    ...(t.assignee !== undefined ? { assignee: redactSecrets(t.assignee) } : {}),
    ...(t.blockedReason !== undefined ? { blockedReason: redactSecrets(t.blockedReason) } : {}),
    ...(t.labels !== undefined ? { labels: t.labels.map(redactSecrets) } : {}),
  }
  const comments = shared.comments.map(c => ({
    ...c, author: redactSecrets(c.author), body: redactSecrets(c.body),
  }))
  const subtasks = shared.subtasks.map(s => ({
    ...s,
    title: redactSecrets(s.title),
    ...(s.assignee !== undefined ? { assignee: redactSecrets(s.assignee) } : {}),
    ...(s.notes !== undefined ? { notes: redactSecrets(s.notes) } : {}),
  }))
  // A file's NAME is text somebody chose, and a pasted screenshot can be named anything at all.
  const files = shared.files.map(f => ({
    ...f,
    name: redactSecrets(f.name),
    ...(f.kind !== undefined ? { kind: redactSecrets(f.kind) } : {}),
    ...(f.author !== undefined ? { author: redactSecrets(f.author) } : {}),
  }))
  return { ...shared, task, comments, subtasks, files }
}
