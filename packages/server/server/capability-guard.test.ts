/**
 * capability-guard.test.ts — the route→capability mapping and the 403 it produces.
 * Pure: every case passes an explicit Capabilities object, never the runtime singleton.
 */
import { describe, expect, it, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { routeCapability, capabilityDenied } from './capability-guard'
import { capabilitiesFor } from './exposure'

const publicCaps = capabilitiesFor('public', {
  central: true,
  exposure: 'public',
  allowLocalShell: true,
  tls: true,
})
const localCaps = capabilitiesFor('local', {
  central: false,
  exposure: undefined,
  allowLocalShell: false,
  tls: false,
})

describe('routeCapability', () => {
  it('maps the shell route', () => {
    expect(routeCapability('/api/exec')).toBe('localShell')
  })

  it('maps the session fleet routes to localShell', () => {
    // Reading the fleet CAPTURES each live session's screen and acting on it types keystrokes into
    // a terminal on this host. That is shell access under another name, so it must be unreachable
    // on an exposed profile whoever is authenticated.
    expect(routeCapability('/api/fleet')).toBe('localShell')
    expect(routeCapability('/api/fleet/act')).toBe('localShell')
    // The live terminal channel streams a session's SCREEN. It is a read, but a read of a coding
    // assistant's terminal, so it must be as unreachable on an exposed profile as the fleet itself.
    expect(routeCapability('/api/fleet/stream')).toBe('localShell')
    // The attach ticket hands out the command that ENTERS a session, and `new` starts a fresh
    // assistant in a directory the caller names — the most powerful call on the whole route table.
    expect(routeCapability('/api/fleet/attach')).toBe('localShell')
    expect(routeCapability('/api/fleet/new')).toBe('localShell')
    expect(routeCapability('/api/fleet/skills')).toBe('localShell')
    // The live terminal WRITE channel (WS) types key-by-key into a session, control keys included —
    // strictly more power than the line prompt, so it rides localShell too (A5: refused off `local`).
    expect(routeCapability('/api/fleet/input')).toBe('localShell')
    // The artifacts panel's one route READS A FILE OFF THE DISK for a page. Its own two gates
    // (membership in what the session touched, then containment in the session's cwd) decide WHICH
    // file; this decides whether the question may be asked at all on an exposed profile.
    expect(routeCapability('/api/fleet/file')).toBe('localShell')
  })

  it('guards a fleet route nobody has written yet', () => {
    // The registration is a PREFIX on purpose: an unregistered route is assumed harmless, so the
    // next fleet route must be guarded by having been added at all, never by someone having
    // remembered a second table. This assertion is what keeps that true.
    expect(routeCapability('/api/fleet/anything-added-later')).toBe('localShell')
    // …without swallowing a neighbour that merely starts with the same letters.
    expect(routeCapability('/api/fleetwide')).toBeNull()
  })

  it('maps the local chat routes', () => {
    expect(routeCapability('/api/chat-tty')).toBe('localChat')
    expect(routeCapability('/api/chat-harnesses')).toBe('localChat')
  })

  it('maps every host transcript reader, including detail sub-paths', () => {
    expect(routeCapability('/api/claude-sessions')).toBe('localTranscripts')
    expect(routeCapability('/api/claude-sessions/abc-123')).toBe('localTranscripts')
    expect(routeCapability('/api/codex-sessions/x')).toBe('localTranscripts')
    expect(routeCapability('/api/gemini-sessions')).toBe('localTranscripts')
    expect(routeCapability('/api/copilot-sessions/y')).toBe('localTranscripts')
    expect(routeCapability('/api/nay-sessions')).toBe('localTranscripts')
    expect(routeCapability('/api/projects-list')).toBe('localTranscripts')
    expect(routeCapability('/api/team/proposals')).toBe('localTranscripts')
    // Billing detection reads ~/.claude.json and the settings files. It extracts only non-secret
    // fields, but the answer is still host configuration read out of the most sensitive files this
    // product touches — there is no deployment that should read a transcript but not this.
    expect(routeCapability('/api/billing/detect')).toBe('localTranscripts')
  })

  it('does not guard a near-miss billing path', () => {
    // EXACT is exact: a typo in the registration must fail loudly here rather than silently
    // leaving a host-reading route unguarded.
    expect(routeCapability('/api/billing/detection')).toBeNull()
    expect(routeCapability('/api/billing')).toBeNull()
  })

  it('maps the mcp admin routes', () => {
    // `/api/mcp-list` and `/api/mcp-action` are GONE: they had no client and read two files that
    // hold no MCP servers at all, so their entries went with them rather than guarding nothing.
    expect(routeCapability('/api/mcp-action')).toBeNull()
    expect(routeCapability('/api/mcp-list')).toBeNull()
    // The MCP PANEL rides a prefix, so the next route under it is guarded by having been added at
    // all — the same reason `/api/fleet` is a prefix. Both writes run `claude mcp` on this host.
    expect(routeCapability('/api/mcp')).toBe('mcpAdmin')
    expect(routeCapability('/api/mcp/servers')).toBe('mcpAdmin')
    expect(routeCapability('/api/mcp/install')).toBe('mcpAdmin')
    expect(routeCapability('/api/mcp/remove')).toBe('mcpAdmin')
    expect(routeCapability('/api/mcp/anything-added-later')).toBe('mcpAdmin')
    // …and it may not swallow a neighbour that merely starts with the same letters.
    expect(routeCapability('/api/mcpanything')).toBeNull()
  })

  it('returns null for ordinary metric routes', () => {
    expect(routeCapability('/api/data')).toBeNull()
    expect(routeCapability('/api/tags/abc')).toBeNull()
    expect(routeCapability('/api/health')).toBeNull()
  })

  it('the RELAYED machine fleet is unguarded ON PURPOSE, not by omission', () => {
    // The guard maps a path to the LOCAL capability it needs, and this one needs none: it spawns
    // nothing, reads no transcript and touches no dotfile — the fleet comes from the machine over
    // the reverse channel. It must not ride `localShell` like /api/fleet does, or it would be
    // dead on every central (localShell is false on lan and public), which is every deployment
    // where it means anything. Its own three gates are in machine-fleet-route.ts.
    expect(routeCapability('/api/team/machine-fleet')).toBeNull()
    // And it must not accidentally inherit /api/fleet's entry through some prefix rule.
    expect(routeCapability('/api/fleet')).toBe('localShell')
  })

  it('does not match a route that merely starts with the same characters', () => {
    expect(routeCapability('/api/execute-order-66')).toBeNull()
    expect(routeCapability('/api/claude-sessions-export')).toBeNull()
  })
})

describe('capabilityDenied', () => {
  it('returns null when the capability is granted', () => {
    expect(capabilityDenied('localShell', localCaps)).toBeNull()
    expect(capabilityDenied('localTranscripts', localCaps)).toBeNull()
  })

  it('returns a 403 with a stable code when the capability is revoked', async () => {
    const res = capabilityDenied('localShell', publicCaps)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    expect(await res!.json()).toEqual({ error: 'capability_disabled', capability: 'localShell' })
  })

  it('revokes the transcript readers on a public profile even with the opt-in flag set', () => {
    expect(capabilityDenied('localTranscripts', publicCaps)).not.toBeNull()
    expect(capabilityDenied('mcpAdmin', publicCaps)).not.toBeNull()
  })
})

test('/api/live-sessions is deliberately NOT blanket-guarded, and the reason is load-bearing', () => {
  // The route has two halves. Its LOCAL half reads /proc and IS gated — by `CAPS.localProcesses`,
  // inside the handler (`readLocalLiveSnapshot` in index.ts). Its other half, on a central, is the
  // members' own self-reported snapshots: not this host's state, and the whole reason the panel
  // exists there. Registering the path here would return 403 for both and take the central's
  // "Open now" down with the /proc read. If this ever becomes a single-purpose host route,
  // register it — until then the guard must stay silent about it on purpose.
  expect(routeCapability('/api/live-sessions')).toBeNull()
  const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf-8')
  expect(src).toContain('CAPS.localProcesses')
  // The gate must be the ONLY way into the /proc reader, or it is trivially bypassed by the next
  // route that wants a live snapshot. One import site = one place the capability is checked.
  expect(src.match(/import\('\.\/live-sessions'\)/g)?.length).toBe(1)
  const helper = src.slice(src.indexOf('async function readLocalLiveSnapshot'))
  expect(helper.indexOf('CAPS.localProcesses')).toBeLessThan(helper.indexOf("import('./live-sessions')"))
})
