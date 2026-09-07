import { join } from 'path'
import { randomBytes } from 'node:crypto'
import { loadEnvConfig } from './env-config'

loadEnvConfig()

export const HOME_DIR = process.env.HOME ?? process.env.USERPROFILE ?? ''
// A "self-contributing" central (TEAM_CENTRAL + AGENTISTICS_CENTRAL_USER set) reads the
// host's ~/.claude that docker-compose mounts read-only at /host-claude, so the machine
// running the central also shows its own usage. Explicit CLAUDE_DIR always wins.
const _selfContributingCentral =
  process.env.AGENTISTICS_TEAM_CENTRAL === '1' && !!(process.env.AGENTISTICS_CENTRAL_USER || '')
export const CLAUDE_DIR = process.env.CLAUDE_DIR ?? (_selfContributingCentral ? '/host-claude' : join(HOME_DIR, '.claude'))
export const PROJECTS_DIR = join(CLAUDE_DIR, 'projects')
export const SESSION_META_DIR = join(CLAUDE_DIR, 'usage-data', 'session-meta')
export const STATS_CACHE_FILE = join(CLAUDE_DIR, 'stats-cache.json')
// Billing-signal sources, read by `billing-detect.ts` to PROPOSE how this machine is billed.
// That module extracts a fixed whitelist of non-secret fields and never touches the tokens,
// email address or account uuids these same files also hold — see its header.
//
// Note these are NOT shared with `mcp-list.ts`, which reads the literal `HOME_DIR` copies of
// `settings.json` / `.claude.json` rather than the (overridable, possibly container-mounted)
// CLAUDE_DIR ones. That difference is real, not an oversight: MCP administration acts on the
// user's own home config, while billing detection describes whichever Claude install this server
// is actually reporting on. Collapsing the two would silently retarget one of them.
export const CLAUDE_SETTINGS_FILE = process.env.CLAUDE_SETTINGS_FILE ?? join(CLAUDE_DIR, 'settings.json')
export const CLAUDE_SETTINGS_LOCAL_FILE = process.env.CLAUDE_SETTINGS_LOCAL_FILE ?? join(CLAUDE_DIR, 'settings.local.json')
export const CLAUDE_CREDENTIALS_FILE = process.env.CLAUDE_CREDENTIALS_FILE ?? join(CLAUDE_DIR, '.credentials.json')
// `~/.claude.json` is a SIBLING of the .claude directory, not a child, so it cannot be derived
// from CLAUDE_DIR — a container mounting the host dir at /host-claude would resolve it to
// `/.claude.json`. Defaults to the home copy and takes an explicit override instead.
export const CLAUDE_JSON_FILE =process.env.CLAUDE_JSON_FILE ?? join(HOME_DIR, '.claude.json')
export const PORT = parseInt(process.env.PORT ?? '47291', 10)
// The web dashboard is served on WEB_PORT (PORT + 1 by default → 47292). In binary mode the
// server binds BOTH: PORT (47291) is always the api + mcp endpoint, WEB_PORT (47292) is what you
// open. They share one request handler, so the SPA's same-origin `/api/*` calls just work.
export const WEB_PORT = parseInt(process.env.WEB_PORT ?? String(PORT + 1), 10)

// ---------------------------------------------------------------------------
// Archive mirror — Claude Code silently deletes session transcripts older than
// `cleanupPeriodDays` (default 30) on every startup. We mirror the raw source
// files into AGENTISTICS_ARCHIVE_DIR so the full lifecycle is never lost.
// Reads union live + archive (live always wins); set AGENTISTICS_ARCHIVE=0 to disable.
// ---------------------------------------------------------------------------
export const ARCHIVE_ENABLED = process.env.AGENTISTICS_ARCHIVE !== '0'
// The app's own writable data dir. In Docker (machine + self-contributing central) this is
// the read-WRITE ~/.agentistics mount, whereas CLAUDE_DIR is the host ~/.claude mounted
// read-only — so anything the app must persist (preferences, consolidate store, sync state)
// belongs here, never under CLAUDE_DIR.
// The location an install with no `AGENTISTICS_DIR` uses. Exported because it is the ONLY
// directory a pre-`~/.agentistics` legacy file may seed: see `legacyPreferencesSource` in
// preferences.ts.
export const DEFAULT_AGENTISTICS_DATA_DIR = join(HOME_DIR, '.agentistics')
export const AGENTISTICS_DATA_DIR = process.env.AGENTISTICS_DIR ?? DEFAULT_AGENTISTICS_DATA_DIR
// EVERY path below is derived from AGENTISTICS_DATA_DIR, never from HOME_DIR directly. They used
// to be built from the home directory, so `AGENTISTICS_DIR` relocated preferences and the
// connection state while the consolidate store, the archive and the workflow runs silently stayed
// in the default location. An instance pointed at its own data dir — a second instance on one
// host, a container with its own volume, a test rig — then READ AND PUSHED the sessions of
// whatever profile it happened to run under, attributed to itself. Found by an end-to-end run in
// which three isolated machines each pushed the same 108 sessions belonging to none of them.
// Defaults are unchanged: with AGENTISTICS_DIR unset this is still ~/.agentistics/<...>.
export const ARCHIVE_DIR = process.env.AGENTISTICS_ARCHIVE_DIR ?? join(AGENTISTICS_DATA_DIR, 'archive')
export const ARCHIVE_PROJECTS_DIR = join(ARCHIVE_DIR, 'projects')
export const ARCHIVE_SESSION_META_DIR = join(ARCHIVE_DIR, 'usage-data', 'session-meta')
export const ARCHIVE_STATS_DIR = join(ARCHIVE_DIR, 'stats-cache')
// Consolidated per-session metrics (mode 'consolidate'): <data dir>/sessions/<id>.json
export const CONSOLIDATED_DIR = join(AGENTISTICS_DATA_DIR, 'sessions')
// Persisted workflow runs (survive Claude's transcript cleanup): <data dir>/workflows/<runId>.json
export const WORKFLOWS_STORE_DIR = join(AGENTISTICS_DATA_DIR, 'workflows')
// Session-manager registry: the sessions `agentop session` started, with their labels and notes.
// Deliberately NOT inside CONSOLIDATED_DIR — `loadConsolidated` reads every flat *.json at that
// root as a legacy Claude session, so a registry file there would be parsed as session metrics.
export const MANAGED_SESSIONS_FILE = join(AGENTISTICS_DATA_DIR, 'managed-sessions.json')

// Derived-value cache for JSONL parses: <data dir>/cache.db (SQLite).
// DERIVED STATE ONLY — every row is recomputable from the file it names, so deleting
// this file may only ever cost one slow build. Never store anything here that is not
// also on disk somewhere else.
export const PARSE_CACHE_FILE = process.env.AGENTISTICS_PARSE_CACHE_FILE ?? join(AGENTISTICS_DATA_DIR, 'cache.db')
/** Repository statistics, keyed on the commit they were derived from. Its own file rather than a
 *  table in `cache.db`: the two are gc'd on different clocks, and a corrupt parse cache must not
 *  cost the git walks as well — each degrades to a no-op independently. */
export const GIT_STATS_CACHE_FILE = process.env.AGENTISTICS_GIT_STATS_CACHE_FILE ?? join(AGENTISTICS_DATA_DIR, 'git-stats.db')

/** One server per PORT. Keyed on the port rather than the machine because a local server and a
 *  central are two legitimate processes on one host — what must never happen twice is two servers
 *  answering for the same address while both scan every repository on disk. */
export const serverLockFile = (port: number): string => join(AGENTISTICS_DATA_DIR, `server-${port}.lock`)
export const PARSE_CACHE_ENABLED = process.env.AGENTISTICS_PARSE_CACHE !== '0'

// ---------------------------------------------------------------------------
// Team mode (Phase 1: folder union). When AGENTISTICS_TEAM=1 the server unions
// per-user consolidated SessionMeta JSONs from TEAM_DIR/<user>/sessions/*.json
// and tags each session with its owning user. Off by default (Solo behavior).
// ---------------------------------------------------------------------------
export const TEAM_MODE = process.env.AGENTISTICS_TEAM === '1'
export const TEAM_DIR = process.env.AGENTISTICS_TEAM_DIR ?? join(AGENTISTICS_DATA_DIR, 'team')

// ---------------------------------------------------------------------------
// Phase 2 — central aggregator. When AGENTISTICS_TEAM_CENTRAL=1 the instance
// sources team sessions from MongoDB (not the folder) and accepts pushed
// sessions on POST /api/team/ingest. MONGO_URL/MONGO_DB point at the store;
// TEAM_ORG namespaces docs; TEAM_INGEST_TOKEN (optional) gates ingestion.
// ---------------------------------------------------------------------------
export const TEAM_CENTRAL = process.env.AGENTISTICS_TEAM_CENTRAL === '1'
// Ingest-only hardening: when set on a central, the instance serves ONLY
// `POST /api/team/ingest` (+ its OPTIONS preflight) and returns 404 for everything else —
// the dashboard, login, /api/data, static assets, all of it. Intended for a public-facing
// central (for cloud GitHub Actions runners to push to) that shares its MongoDB with a
// SEPARATE, private admin/dashboard instance. Exposing an ingest-only instance is low-risk:
// there is nothing to read, only a token-gated write endpoint.
export const INGEST_ONLY = process.env.AGENTISTICS_INGEST_ONLY === '1'
// ---------------------------------------------------------------------------
// GitHub Actions OIDC (keyless CI auth). A runner presents a short-lived,
// GitHub-signed JWT instead of a static secret; the central verifies it against
// GitHub's public JWKS and checks the `repository` claim against the registered
// repos. Enabled only when an AUDIENCE is configured (forces a deliberate, secure
// config — the workflow must request that same audience). Issuer defaults to GitHub.
// ---------------------------------------------------------------------------
export const OIDC_ISSUER = process.env.AGENTISTICS_OIDC_ISSUER ?? 'https://token.actions.githubusercontent.com'
export const OIDC_AUDIENCE = process.env.AGENTISTICS_OIDC_AUDIENCE || undefined
// Trim surrounding whitespace: a stray space in `MONGO_URL= mongodb+srv://…` (easy to leave
// in an env file) otherwise reaches the driver as an invalid connection string.
export const MONGO_URL = (process.env.MONGO_URL ?? 'mongodb://localhost:27017').trim()
export const MONGO_DB = (process.env.MONGO_DB ?? 'agentistics').trim()
export const TEAM_ORG = process.env.AGENTISTICS_TEAM_ORG ?? 'default'
export const TEAM_INGEST_TOKEN = process.env.AGENTISTICS_TEAM_INGEST_TOKEN || undefined
// Self-contribution: when set on a central, the central machine's own local sessions
// (read from the mounted host ~/.claude) are attributed to this user, so one instance
// can be both the central AND a contributing member. Unset = isolated central.
export const CENTRAL_USER = process.env.AGENTISTICS_CENTRAL_USER || undefined

// ---------------------------------------------------------------------------
// Exposure profile (see exposure.ts). AGENTISTICS_EXPOSURE=local|lan|public.
// Unset → 'lan' on a central, 'local' otherwise. An unknown value fails closed to 'public'.
// AGENTISTICS_ALLOW_LOCAL_SHELL=1 re-enables /api/exec, /api/chat-tty, the host transcript
// readers and /api/mcp-action on a 'lan' central. It is IGNORED on 'public'.
// ---------------------------------------------------------------------------
export const EXPOSURE = process.env.AGENTISTICS_EXPOSURE
export const ALLOW_LOCAL_SHELL = process.env.AGENTISTICS_ALLOW_LOCAL_SHELL === '1'
// Trust CF-Connecting-IP / X-Forwarded-For for rate limiting and audit logging. Enable ONLY when
// the app is reachable exclusively through a proxy that rewrites them (cloudflared on the same
// host + BIND_IP=127.0.0.1) — otherwise a client can pick its own rate-limit bucket.
export const TRUST_PROXY = process.env.AGENTISTICS_TRUST_PROXY === '1'
// Comma-separated browser origins allowed to call this instance cross-origin. Normally EMPTY:
// the dashboard is served by this same process, so it is same-origin. Only set it for a split
// deployment (SPA hosted elsewhere).
export const ALLOWED_ORIGINS = (process.env.AGENTISTICS_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

// ---------------------------------------------------------------------------
// Phase 3 — auth gate. When AGENTISTICS_TEAM_PASSWORD is set, the central
// dashboard requires a valid session cookie to access all /api/* routes except
// the public allowlist. TEAM_TLS=1 adds the Secure flag to the session cookie.
// ---------------------------------------------------------------------------
export const TEAM_PASSWORD = process.env.AGENTISTICS_TEAM_PASSWORD || undefined
// SECURITY: the session secret NEVER falls back to the password. It used to, which meant a
// leaked or shared password also let anyone forge a session cookie for any account, since the
// HMAC key equalled the password. Resolution order (see secret-store.ts + the boot block in
// index.ts): the env var if set and valid → a random secret persisted in Mongo (central) → a
// random per-process secret (non-central; sessions simply do not survive a restart).
export const TEAM_SESSION_SECRET_ENV = process.env.AGENTISTICS_TEAM_SESSION_SECRET || undefined
export let TEAM_SESSION_SECRET = TEAM_SESSION_SECRET_ENV ?? randomBytes(32).toString('hex')
/** Called once at boot by index.ts. `export let` gives importers a live binding. */
export function setResolvedSessionSecret(value: string): void {
  TEAM_SESSION_SECRET = value
}
export const TEAM_TLS = process.env.AGENTISTICS_TEAM_TLS === '1'

// ---------------------------------------------------------------------------
// Team uploader — tracks which sessions have already been pushed to the central.
// Override with AGENTISTICS_TEAM_SENT_FILE.
// ---------------------------------------------------------------------------
export const TEAM_SENT_FILE = process.env.AGENTISTICS_TEAM_SENT_FILE ?? join(AGENTISTICS_DATA_DIR, 'team-sent.json')
// Records the central "sync signature" (endpoint+token+instanceId) the sent-state was built
// against. When it changes — new token, new central, or a wiped central DB — the uploader
// clears the sent-state and re-pushes everything automatically.
export const TEAM_SYNC_FILE = process.env.AGENTISTICS_TEAM_SYNC_FILE ?? join(AGENTISTICS_DATA_DIR, 'team-sync.json')

// ---------------------------------------------------------------------------
// Other harnesses (Phase 1: Codex). Each adapter checks its own root.
// Override with CODEX_DIR; disable with AGENTISTICS_HARNESS_CODEX=0.
// ---------------------------------------------------------------------------
export const CODEX_DIR = process.env.CODEX_DIR ?? (_selfContributingCentral ? '/host-codex' : join(HOME_DIR, '.codex'))
export const CODEX_SESSIONS_DIR = join(CODEX_DIR, 'sessions')
// Codex's own billing signal. `auth.json` holds the OAuth tokens AND an optional API key; only
// the plan tier and the PRESENCE of a key are ever read — see `billing-detect.ts`.
export const CODEX_AUTH_FILE = process.env.CODEX_AUTH_FILE ?? join(CODEX_DIR, 'auth.json')

// ---------------------------------------------------------------------------
// Gemini CLI harness. Override with GEMINI_DIR; disable with AGENTISTICS_HARNESS_GEMINI=0.
// ---------------------------------------------------------------------------
export const GEMINI_DIR = process.env.GEMINI_DIR ?? (_selfContributingCentral ? '/host-gemini' : join(HOME_DIR, '.gemini'))

// ---------------------------------------------------------------------------
// GitHub Copilot CLI harness. Override with COPILOT_DIR; disable with
// AGENTISTICS_HARNESS_COPILOT=0.
// ---------------------------------------------------------------------------
export const COPILOT_DIR = process.env.COPILOT_DIR ?? (_selfContributingCentral ? '/host-copilot' : join(HOME_DIR, '.copilot'))

// ---------------------------------------------------------------------------
// Antigravity CLI (agy) harness. It lives INSIDE the Gemini home
// (~/.gemini/antigravity-cli) but is a distinct harness — the Gemini adapter only
// reads ~/.gemini/tmp, so the two never overlap.
// Override with ANTIGRAVITY_DIR; disable with AGENTISTICS_HARNESS_ANTIGRAVITY=0.
// ---------------------------------------------------------------------------
// Kimi Code CLI harness. Override with KIMI_DIR; disable with AGENTISTICS_HARNESS_KIMI=0.
export const KIMI_DIR = process.env.KIMI_DIR ?? join(HOME_DIR, '.kimi-code')

export const ANTIGRAVITY_DIR = process.env.ANTIGRAVITY_DIR ?? join(GEMINI_DIR, 'antigravity-cli')
export const ANTIGRAVITY_BRAIN_DIR = join(ANTIGRAVITY_DIR, 'brain')
export const ANTIGRAVITY_HISTORY_FILE = join(ANTIGRAVITY_DIR, 'history.jsonl')
/** One SQLite DB per conversation; its `gen_metadata` table holds the token/model protobufs. */
export const ANTIGRAVITY_CONVERSATIONS_DIR = join(ANTIGRAVITY_DIR, 'conversations')
/** Optional enrichment (title / parent link). Frequently exists but with zero rows. */
export const ANTIGRAVITY_SUMMARIES_DB = join(ANTIGRAVITY_DIR, 'conversation_summaries.db')

// ---------------------------------------------------------------------------
// Multi-central support. Per-connection state lives in its own directory so one
// central's sent-state can never be handed to another by a positional accident.
// ---------------------------------------------------------------------------
/** Per-connection state lives in its own directory so one central's sent-state can never be
 *  handed to another by a positional accident. `export let` (mirroring
 *  `TEAM_SESSION_SECRET`/`setResolvedSessionSecret` above) gives importers a live binding, so
 *  `__setTeamConnDirForTests` below can redirect it. */
export let TEAM_CONN_DIR = process.env.AGENTISTICS_TEAM_CONN_DIR
  ?? join(AGENTISTICS_DATA_DIR, 'connections')

/** Test-only override. `TEAM_CONN_DIR` is computed once at module load from the environment, so
 *  a test can't reliably set `AGENTISTICS_TEAM_CONN_DIR` beforehand — by the time any given test
 *  file runs, `config.ts` has typically already been imported (and evaluated) by another file
 *  earlier in the same `bun test` process. This lets team-uploader.test.ts point per-connection
 *  state files at a tmp directory instead of the developer's real `~/.agentistics/connections`.
 *  Never called from production code. */
export function __setTeamConnDirForTests(dir: string): void {
  TEAM_CONN_DIR = dir
}

const CONN_ID_RE = /^c_[a-f0-9]{12}$/

/** Connection ids arrive from HTTP bodies on the connection routes, so they are interpolated
 *  into a path only after this check — `../` would escape ~/.agentistics. */
export function safeConnId(id: string): string {
  if (typeof id !== 'string' || !CONN_ID_RE.test(id)) {
    throw new Error(`invalid connection id: ${JSON.stringify(id)}`)
  }
  return id
}

export function teamSentFile(connId: string): string {
  return join(TEAM_CONN_DIR, `team-sent-${safeConnId(connId)}.json`)
}
/** { sig } — the central-identity fingerprint. */
export function teamSyncFile(connId: string): string {
  return join(TEAM_CONN_DIR, `team-sync-${safeConnId(connId)}.json`)
}
/** { rulesHash, sharedIds[], boundary } — deliberately SEPARATE from the sent-state and the
 *  sync signature: the sig path clears the sent-state on a token rotation, and if the rules
 *  hash lived there a rotation coinciding with a rules change would erase the evidence of the
 *  change and the removal would never run. */
export function teamRulesFile(connId: string): string {
  return join(TEAM_CONN_DIR, `team-rules-${safeConnId(connId)}.json`)
}
/** { state, ids, runIds, rulesHash, startedAt } — the removal journal. */
export function teamForgetFile(connId: string): string {
  return join(TEAM_CONN_DIR, `team-forget-${safeConnId(connId)}.json`)
}

/** This machine's sealed-envelope keypair. The PRIVATE half lives here and NOWHERE else — never in
 *  preferences.json (which is served, redacted, over `GET /api/preferences`), never in an audit
 *  event, never in a log line. Written 0600. Machine-wide, not per connection: the same machine
 *  identity faces every central, which is what lets one pin work across them. */
export function envelopeKeyFile(): string {
  return join(TEAM_CONN_DIR, 'envelope-key.json')
}

/** machineId → the peer public key this machine PINNED on first sight, per connection. Per
 *  connection because a machine id is only meaningful within one central: the same id string from
 *  two different centrals is two different machines, and sharing one pin map across them would let
 *  one central's key set trigger a "changed key" refusal against another's. */
export function envelopePinsFile(connId: string): string {
  return join(TEAM_CONN_DIR, `envelope-pins-${safeConnId(connId)}.json`)
}

/** Decrypted, NOT-YET-APPLIED restriction proposals received from sibling machines, per
 *  connection. A proposal sits here until the user acts on it — see envelope-inbox.ts. */
export function envelopeInboxFile(connId: string): string {
  return join(TEAM_CONN_DIR, `envelope-inbox-${safeConnId(connId)}.json`)
}
