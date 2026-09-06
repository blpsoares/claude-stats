/**
 * capability-guard.ts — maps a request path to the local capability it needs, and turns a
 * revoked capability into a 403.
 *
 * Kept separate from index.ts so the mapping is unit-testable and so a newly added local-power
 * route is a one-line registration instead of a scattered `if`.
 *
 * SECURITY: these routes execute shell commands, spawn coding-assistant CLIs, read the host's
 * raw conversation transcripts, or rewrite ~/.claude.json. They must be unreachable on an
 * internet-exposed instance regardless of who is authenticated — a `member` account is not a
 * reason to hand out a shell. A route that is NOT registered here is assumed harmless, so a
 * missed registration is a vulnerability, not an oversight.
 */
import { CAPS, type Capabilities } from './exposure'

/** Exact path → capability. Detail sub-paths are handled by the prefix table below. */
const EXACT: ReadonlyMap<string, keyof Capabilities> = new Map<string, keyof Capabilities>([
  ['/api/exec', 'localShell'],
  ['/api/chat-tty', 'localChat'],
  ['/api/chat-harnesses', 'localChat'],
  ['/api/projects-list', 'localTranscripts'],
  // Returns this machine's decrypted sibling messages — a peer's FULL source list, plus its own
  // key fingerprints. Strictly more sensitive than /api/team/status, which deliberately exposes
  // only counts, so it is host-local data and must be unreachable on an exposed instance.
  ['/api/team/proposals', 'localTranscripts'],
  // Reads ~/.claude.json, ~/.claude/settings*.json and ~/.claude/.credentials.json to propose how
  // this machine is billed. It extracts only non-secret fields, but the ANSWER is still host
  // configuration and the files are the most sensitive this product touches, so it rides the same
  // capability as the transcript routes rather than getting one of its own: there is no
  // deployment that should read a transcript but not this.
  ['/api/billing/detect', 'localTranscripts'],
  ['/api/hardware-resources', 'localProcesses'],
  // The session fleet is registered as a PREFIX below, not name by name — see the note there.
])

/** Prefix (no trailing slash) → capability. Matches `<prefix>` and `<prefix>/…` only. */
const PREFIXES: ReadonlyArray<readonly [string, keyof Capabilities]> = [
  ['/api/claude-sessions', 'localTranscripts'],
  ['/api/codex-sessions', 'localTranscripts'],
  ['/api/gemini-sessions', 'localTranscripts'],
  ['/api/copilot-sessions', 'localTranscripts'],
  ['/api/nay-sessions', 'localTranscripts'],
  // The session fleet, and everything under it. `/api/fleet` alone captures each live session's
  // SCREEN — a coding assistant's terminal, transcript and all — `/api/fleet/act` types into it,
  // answers a permission prompt for it or kills it, `/api/fleet/stream` streams that screen
  // continuously, `/api/fleet/attach` hands out the command that enters it, and `/api/fleet/new`
  // starts a fresh assistant in a directory the caller names. That is shell access with extra
  // steps, so it rides `localShell` rather than the softer `localChat`: there is no deployment that
  // should expose someone's keyboard to the internet and a shell is the honest name for it.
  //
  // A PREFIX and not five names: a route that is not registered here is assumed harmless, so the
  // next fleet route someone adds must be guarded by having been added AT ALL, never by having
  // remembered a second table.
  ['/api/fleet', 'localShell'],
  // Reading and WRITING this machine's MCP server configuration. `/api/mcp/servers` reports what is
  // configured and what is running; `/api/mcp/install` and `/api/mcp/remove` run `claude mcp` to
  // change it. A PREFIX for the same reason `/api/fleet` is one: the next route here is guarded by
  // having been added at all, never by having remembered a second table. It cannot collide with the
  // older `/api/mcp-list` / `/api/mcp-action`, which are exact entries above — a prefix matches
  // `<prefix>` and `<prefix>/…` only.
  // It replaced `/api/mcp-list` + `/api/mcp-action`, which had no client and read two files that
  // hold no MCP servers at all (`~/.claude/settings.json` and `<project>/.claude/settings.json`) —
  // a second lister giving a different, wrong answer is the drift this codebase is built against.
  ['/api/mcp', 'mcpAdmin'],
]

export function routeCapability(pathname: string): keyof Capabilities | null {
  const exact = EXACT.get(pathname)
  if (exact) return exact
  for (const [prefix, cap] of PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return cap
  }
  return null
}

/**
 * A ready 403 when the capability is off, or null when the call may proceed.
 * The caller spreads CORS_HEADERS over the response.
 */
export function capabilityDenied(
  cap: keyof Capabilities,
  caps: Capabilities = CAPS,
): Response | null {
  if (caps[cap]) return null
  return new Response(JSON.stringify({ error: 'capability_disabled', capability: cap }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  })
}
