import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus } from 'lucide-react'
import type { SessionMeta, TeamConnection, TeamConfig, ModelUsage, ShareSource, SiblingRuleFact } from '@agentistics/core'
import { readTeamConnections } from '@agentistics/core'
import type { ArchiveMode } from '../ArchiveConsentModal'
import { resolveArchiveChoice } from '../../lib/archive'
import { buildShareTargets, buildProjectTargets, hostOf, type ServerProject } from '../../lib/shareRepos'
import { useIsMobile } from '../../hooks/useIsMobile'
import { COPY } from './copy'
import { ConnectionCard } from './ConnectionCard'
import { AddCentralDrawer } from './AddCentralDrawer'
import type { ShareMode } from './sharePanelState'
import type { TeamStatusResponse, ConnectionStatusEntry } from './statusTypes'
import { nextNoticeFocus, noticeFocusSeq, type NoticeFocus } from './proposalNotices'
import type { ProposalView, KeyWarningView, PeerFingerprint } from './proposalNotices'

/** `GET /api/team/proposals` — this machine's own decrypted sealed-envelope inbox, same-origin. */
export interface ProposalsResponse {
  ok: boolean
  me?: { publicKey: string; fingerprint: string }
  connections?: {
    connId: string
    proposals?: ProposalView[]
    keyWarnings?: KeyWarningView[]
    peers?: { machineId: string; machineName: string; fingerprint: string }[]
    /** What each sibling machine last announced about its OWN rules — the standing facts behind
     *  the reverse warning in the rules picker. Optional: a central on an older build omits it,
     *  which must read as "nothing announced", never as an error. */
    siblingRules?: SiblingRuleFact[]
  }[]
}

/** The two panel-level rows of the state table (§9.5) that are NOT per-card: an `/api/preferences`
 *  load failure shows the error panel and never renders the list at all (even if a previous poll
 *  had populated it), and a genuinely empty `connections[]` — as opposed to `null`, still loading —
 *  is the dashed empty state. Pure and exported so both are asserted directly, the same way
 *  `ConnectionCard.test.tsx` asserts the per-card rows. */
export type PanelBranch = 'error' | 'loading' | 'empty' | 'list'

export function resolvePanelBranch(loadErr: string | null, connections: TeamConnection[] | null): PanelBranch {
  if (loadErr) return 'error'
  if (connections === null) return 'loading'
  if (connections.length === 0) return 'empty'
  return 'list'
}

/**
 * The rules write, as a sequence — exported so it can be asserted directly (this project has no
 * React-rendering test infrastructure; see `ConnectionCard.test.tsx`'s note).
 *
 * Review fix (Critical): the panel used to store WHAT IT SENT. The server does not persist that —
 * `resolveDeniedRepos` (`packages/server/server/team-connections.ts`) applies
 * `withUnresolvedDenied` on the zero→non-zero transition and adds `NO_REPO_KEY`, while the PATCH
 * response carries only `{ ok, queued }`. The optimistic splice therefore diverged from the truth
 * immediately (the card's own badge, fed by the server's `deniedCount`, said one more than the
 * panel listed), and the NEXT save — built from that stale draft, with `wasRestricted` now true so
 * the server honours the list as-is — silently dropped `NO_REPO_KEY`, re-opening every
 * unattributed session to that central. So: PATCH, then RE-READ preferences, exactly as the
 * add-central drawer's `onConnected` path already does.
 */
export async function applyRulesSequence(
  patch: () => Promise<Response | null>,
  reload: () => Promise<void>,
): Promise<{ ok: true; queued: boolean } | { ok: false }> {
  const res = await patch().catch(() => null)
  if (!res || !res.ok) return { ok: false }
  const body = await res.json().catch(() => ({ queued: false })) as { queued?: boolean }
  await reload()
  return { ok: true, queued: Boolean(body.queued) }
}

export interface ConnectionsPanelProps {
  sessions: SessionMeta[]
  /** MUST be the unfiltered project list — see `buildShareTargets`'s own docstring: a filtered
   *  derivative would silently shrink what this machine can even offer to block. */
  projects: ServerProject[]
  /** For the repository picker's impact estimate (`blendedCostPerToken`) — the app's global model
   *  usage, same source every other blended-cost consumer in the app uses. */
  modelUsage: Record<string, ModelUsage>
  lang: 'pt' | 'en'
  /** Fired after EVERY successful `/api/preferences` re-read, i.e. after every write this panel
   *  performs (connect, rules apply, rename, disconnect). Review fix (Important 3): the app's
   *  hidden-repository badge (`AppContext.deniedRepoLabels`) is built in a mount-only effect, so
   *  without this it kept claiming "Hidden from 1 central" after the rule — or the whole
   *  connection — was gone. Wired once here rather than at the badge's two call sites. */
  onConnectionsChanged?: () => void
}

/**
 * ConnectionsPanel — the member-mode replacement for the old `TeamSettings.tsx`'s single-form
 * connect UI: a card per connected central. Owns the one `/api/preferences` load, the one
 * `/api/team/status` poller shared by every card (never one poller per card), and the
 * `shareTargets` memo Task 11's picker will consume.
 */
export function ConnectionsPanel({ sessions, projects, modelUsage, lang, onConnectionsChanged }: ConnectionsPanelProps) {
  const isMobile = useIsMobile()
  const [connections, setConnections] = useState<TeamConnection[] | null>(null)
  const [archiveMode, setArchiveMode] = useState<ArchiveMode | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [statusResp, setStatusResp] = useState<TeamStatusResponse | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  // The bell's deep link (`notificationLink`): `?conn=<id>&notices=1` opens THAT card with its
  // notices modal up. Read into state and the query dropped, so a later manual close is not undone
  // by the URL still asking for it — but stored as a SEQUENCED REQUEST (`nextNoticeFocus`), never
  // as a latched id: arriving again for the same connection has to be a new event, or the second
  // bell click changes no state anywhere and opens nothing.
  const [searchParams, setSearchParams] = useSearchParams()
  const [focus, setFocus] = useState<NoticeFocus | null>(null)
  useEffect(() => {
    const id = searchParams.get('conn')
    if (!id || searchParams.get('notices') !== '1') return
    setFocus(prev => nextNoticeFocus(prev, id))
    const next = new URLSearchParams(searchParams)
    next.delete('conn')
    next.delete('notices')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  useEffect(() => {
    let alive = true
    void reloadPreferences(alive)
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Shared by the mount effect and the add-central drawer's `onConnected` — both need the exact
   *  same `/api/preferences` read, never a hand-spliced local update of the new connection (the
   *  server is the source of truth for what actually got persisted, including a token-rotation
   *  update that reuses an existing id). */
  async function reloadPreferences(alive: boolean) {
    try {
      const r = await fetch('/api/preferences')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const prefs = await r.json() as { team?: TeamConfig; archiveMode?: ArchiveMode; archiveSessions?: boolean }
      if (!alive) return
      // Defensive migration: `readTeamConnections` tolerates a missing/malformed `connections`
      // array instead of `.map`-ing `undefined` — an old server payload must never read as
      // "zero connections" through a crash.
      setConnections(readTeamConnections(prefs))
      setArchiveMode(resolveArchiveChoice(prefs))
      setLoadErr(null)
    } catch (err) {
      if (alive) setLoadErr(err instanceof Error ? err.message : String(err))
    }
  }

  /** The ONE post-write path: re-read the server's persisted state, then tell the app that the
   *  connection list changed. Every write below goes through this — a hand-spliced local update
   *  is what Critical 1 (rules) was, and what left the hidden-repo badge stale (Important 3). */
  async function reloadAfterWrite() {
    await reloadPreferences(true)
    onConnectionsChanged?.()
  }

  // ONE poller for the whole panel — N cards must never mean N intervals hitting the route.
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await fetch('/api/team/status')
        if (!r.ok) return
        const data = (await r.json()) as TeamStatusResponse
        if (alive) setStatusResp(data)
      } catch { /* keep the last-known status; a card shows "checking" before the first response */ }
    }
    void load()
    const id = setInterval(load, 5_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  // A second, slower poller for this machine's sealed-envelope inbox. Same "one poller for the
  // whole panel" rule as the status one above: N cards must never mean N intervals.
  const [proposalsResp, setProposalsResp] = useState<ProposalsResponse | null>(null)
  const loadProposals = useCallback(async () => {
    try {
      const r = await fetch('/api/team/proposals')
      if (!r.ok) return
      setProposalsResp(await r.json() as ProposalsResponse)
    } catch { /* keep the last-known inbox */ }
  }, [])
  useEffect(() => {
    void loadProposals()
    const id = setInterval(() => { void loadProposals() }, 30_000)
    return () => clearInterval(id)
  }, [loadProposals])

  const inboxById = useMemo(() => {
    const map: Record<string, {
      proposals: ProposalView[]; keyWarnings: KeyWarningView[]; peers: PeerFingerprint[]
      siblingRules: SiblingRuleFact[]
    }> = {}
    for (const e of proposalsResp?.connections ?? []) {
      map[e.connId] = {
        proposals: e.proposals ?? [], keyWarnings: e.keyWarnings ?? [], peers: e.peers ?? [],
        siblingRules: e.siblingRules ?? [],
      }
    }
    return map
  }, [proposalsResp])

  const handleDismissProposal = useCallback(async (
    connId: string,
    body: { proposalId?: string; keyWarningMachineId?: string },
  ) => {
    try {
      await fetch('/api/team/proposals', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connId, ...body }),
      })
    } finally {
      await loadProposals()
    }
  }, [loadProposals])

  const statusById = useMemo(() => {
    const map: Record<string, ConnectionStatusEntry> = {}
    for (const e of statusResp?.connections ?? []) map[e.id] = e
    return map
  }, [statusResp])

  // Computed ONCE here from the UNFILTERED session/project lists — Task 11's picker consumes this
  // same array per card instead of rebuilding it per connection.
  const shareTargets = useMemo(
    () => buildShareTargets(sessions, projects, [], { noRepo: COPY.noRepoTitle[lang] }),
    [sessions, projects, lang],
  )
  // Plan 4 Task 5 — the project-side projection, same unfiltered lists. `[]` here is the baseline
  // (no repo denied at build time); the picker itself recomputes each project's live lock from its
  // own repo-tab draft (`SharedReposPanel`), so this baseline is purely informational.
  const projectTargets = useMemo(
    () => buildProjectTargets(sessions, projects, []),
    [sessions, projects],
  )

  // Two connections resolving to the same host promote the user name into the card's primary
  // label — see ConnectionCard's docstring.
  const duplicateHosts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const c of connections ?? []) {
      const h = hostOf(c.endpoint)
      counts.set(h, (counts.get(h) ?? 0) + 1)
    }
    return counts
  }, [connections])

  async function handleDisconnect(id: string) {
    const res = await fetch(`/api/team/connections/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (res.ok) await reloadAfterWrite()
  }

  /**
   * The ONE write the sharing-rules picker performs: `PATCH { shareMode, sources }`, then stop —
   * the server owns the forget/push sequence from here, watched via the panel's existing
   * `/api/team/status` poll (`status.resync`). Never looped, never followed by a direct call to
   * any forget endpoint. Plan 4: replaces the legacy `{ deniedRepos }` body — the server still
   * accepts that shape from an older client, but this panel writes only the typed shape now.
   */
  async function handleApplyRules(id: string, mode: ShareMode, sources: ShareSource[]): Promise<{ ok: true; queued: boolean } | { ok: false }> {
    return applyRulesSequence(
      () => fetch(`/api/team/connections/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareMode: mode, sources }),
      }),
      reloadAfterWrite,
    )
  }

  /** The remote-session consent switches. A plain PATCH plus a reload — unlike the rules apply it
   *  starts no forget/push sequence, so there is no phase for the card to wait out. */
  async function handleSetRemoteConsent(
    id: string,
    body: { allowRemoteSessions: boolean; allowRemoteScreens: boolean },
  ): Promise<void> {
    await fetch(`/api/team/connections/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => { /* the block re-reads the committed state from the next status poll */ })
    await reloadAfterWrite()
  }

  async function handleSyncNow(id: string) {
    await fetch('/api/team/push-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectionId: id }),
    }).catch(() => { /* the card's own status line reflects the outcome on the next poll */ })
  }

  const branch = resolvePanelBranch(loadErr, connections)

  if (branch === 'error') {
    return (
      <div style={{
        padding: '10px 14px', borderRadius: 8,
        background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
        fontSize: 12, color: '#ef4444',
      }}>
        {loadErr}
      </div>
    )
  }

  // `branch === 'loading'` iff `connections === null` (see `resolvePanelBranch`) — the explicit
  // `connections === null` check (redundant with `branch` at runtime) is what lets TypeScript
  // narrow `connections` to non-null for the rest of the render.
  if (branch === 'loading' || connections === null) {
    return <div style={{ minHeight: 80 }} />
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        marginBottom: 14, flexWrap: 'wrap',
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)' }}>
          {COPY.connectedCentrals[lang]} {connections.length > 0 && `(${connections.length})`}
        </div>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          title={COPY.addCentral[lang]}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            padding: isMobile ? '0 14px' : '7px 14px', minHeight: isMobile ? 44 : undefined,
            width: isMobile ? '100%' : undefined,
            borderRadius: 7, fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
            border: '1px dashed var(--anthropic-orange)', background: 'transparent', color: 'var(--anthropic-orange)',
            cursor: 'pointer',
          }}
        >
          <Plus size={13} />
          {COPY.addCentral[lang]}
        </button>
      </div>

      <AddCentralDrawer
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onConnected={() => { void reloadAfterWrite() }}
        connections={connections}
        sessions={sessions}
        projects={projects}
        modelUsage={modelUsage}
        lang={lang}
      />

      {connections.length === 0 ? (
        <div style={{
          padding: '18px 16px', borderRadius: 10, border: '1px dashed var(--border)',
          textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center',
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)' }}>{COPY.emptyTitle[lang]}</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', maxWidth: 420 }}>{COPY.emptyBody[lang]}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {connections.map(conn => (
            // One broken card cannot take the page down — see the class docstring on
            // `isBrokenEndpoint`/`hostOf`. Each card is its own render boundary in the same sense
            // (a thrown error inside one card would still need an ErrorBoundary to be fully
            // isolated; the per-card guards below are what keep a bad row from ever reaching render
            // in a state that could throw).
            <ConnectionCard
              key={conn.id}
              conn={conn}
              status={statusById[conn.id]}
              archiveMode={archiveMode}
              shareTargets={shareTargets}
              projectTargets={projectTargets}
              sessions={sessions}
              modelUsage={modelUsage}
              otelEnabled={statusResp?.otelExportEnabled ?? false}
              duplicateHost={(duplicateHosts.get(hostOf(conn.endpoint)) ?? 0) > 1}
              lang={lang}
              onDisconnect={handleDisconnect}
              onSyncNow={handleSyncNow}
              onApplyRules={handleApplyRules}
              onSetRemoteConsent={handleSetRemoteConsent}
              proposals={inboxById[conn.id]?.proposals ?? []}
              keyWarnings={inboxById[conn.id]?.keyWarnings ?? []}
              peers={inboxById[conn.id]?.peers ?? []}
              siblingRules={inboxById[conn.id]?.siblingRules ?? []}
              selfFingerprint={proposalsResp?.me?.fingerprint ?? ''}
              onDismissProposal={handleDismissProposal}
              focusNoticesSeq={noticeFocusSeq(focus, conn.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
