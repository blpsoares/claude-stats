import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, EyeOff, Loader2, Check, Bell } from 'lucide-react'
import type { SessionMeta, TeamConnection, ModelUsage, ShareSource, SiblingRuleFact } from '@agentistics/core'
import type { ArchiveMode } from '../ArchiveConsentModal'
import type { ShareTarget, ProjectTarget } from '../../lib/shareRepos'
import type { ShareMode } from './sharePanelState'
import { hostOf, plural } from '../../lib/shareRepos'
import { StatusDot, ConfirmModal } from '../../pages/settings/primitives'
import { useIsMobile } from '../../hooks/useIsMobile'
import { COPY, PLURAL_COPY, interpolate } from './copy'
import { withheldMarkStyle } from './withheldStyle'
import { ConnectionIdentity, type ProbedIdentity } from './ConnectionIdentity'
import { resolveCardIdentity } from './cardIdentity'
import type { ConnectionStatusEntry } from './statusTypes'
import {
  isBrokenEndpoint, resolveCardState, resolveRulePill, showsApplyQueuedBanner, resolveWritesDisabled,
  showsElsewhereWarning, elsewhereLine, resolveCardStatusStyle,
} from './cardState'
import { resolveCardActionsHidden, type ApplyPhase } from './repoPanelState'
import {
  DisconnectButton, mobileBtn, StatusLine, ResyncStrip, RepoPanelSlot,
  StatusInfoButton, StatusInfoPanel, toneBorderColor,
} from './ConnectionCardParts'
import { PeersSection } from './PeersSection'
import { RemoteSessionsBlock } from './RemoteSessionsBlock'
import { NoticesModal } from './NoticesModal'
import { noticeSummary, type ProposalView, type KeyWarningView, type PeerFingerprint } from './proposalNotices'

export interface ConnectionCardProps {
  conn: TeamConnection
  status: ConnectionStatusEntry | undefined
  archiveMode: ArchiveMode | null
  /** Computed once in ConnectionsPanel from the unfiltered session/project lists — the repository
   *  picker (Task 11) consumes this same array instead of recomputing it per card. */
  shareTargets: ShareTarget[]
  /** The project projection (Plan 4 Task 5), computed once from the same unfiltered lists. */
  projectTargets: ProjectTarget[]
  /** Unfiltered — threaded through to the repository picker for its impact estimate and its
   *  "proven prehistory" check. */
  sessions: SessionMeta[]
  modelUsage: Record<string, ModelUsage>
  /** Machine-wide (never per-connection) — whether OTel metrics export is currently configured,
   *  from the top-level `otelExportEnabled` on `GET /api/team/status`. */
  otelEnabled: boolean
  /** True when another connection on this panel resolves to the same host — promotes the user
   *  name into the primary label (`acme:48080 · lucas`), the only thing that tells them apart. */
  duplicateHost: boolean
  lang: 'pt' | 'en'
  onDisconnect: (id: string) => Promise<void>
  onSyncNow: (id: string) => Promise<void>
  onApplyRules: (id: string, mode: ShareMode, sources: ShareSource[]) => Promise<{ ok: true; queued: boolean } | { ok: false }>
  /** Sealed-envelope proposals received from this account's other machines, and the alarm raised
   *  when a peer's published key stopped matching the pinned one. Both default to empty, so a
   *  central too old for the mailbox simply renders nothing. */
  proposals?: ProposalView[]
  keyWarnings?: KeyWarningView[]
  /** Pinned peers with fingerprints, and this machine's own — the documented out-of-band check. */
  peers?: PeerFingerprint[]
  /** What each sibling machine last announced about its OWN rules. Read by the rules picker to
   *  warn BEFORE this machine starts sharing something a sibling deliberately withholds. */
  siblingRules?: SiblingRuleFact[]
  selfFingerprint?: string
  onDismissProposal?: (connId: string, body: { proposalId?: string; keyWarningMachineId?: string }) => Promise<void>
  /** Write the remote-session consent switches. Same PATCH the rules use, and the panel owns it
   *  for the same reason `onApplyRules` does: the card renders, the panel talks to the server. */
  onSetRemoteConsent?: (connId: string, body: { allowRemoteSessions: boolean; allowRemoteScreens: boolean }) => Promise<void>
  /** Arrived here from the bell (`notificationLink`): open this card AND its notices modal, so a
   *  notification about a decision reaches that decision in one click.
   *
   *  A SEQUENCE, not a boolean (`noticeFocusSeq`): `0` is "never asked", and every later request —
   *  including a second one for this same card — is a strictly greater number. A boolean latched
   *  true after the first deep link, and every bell click after that opened nothing. */
  focusNoticesSeq?: number
}

export function ConnectionCard({
  conn, status, archiveMode, shareTargets, projectTargets, sessions, modelUsage, otelEnabled, duplicateHost, lang,
  onDisconnect, onSyncNow, onApplyRules,
  proposals = [], keyWarnings = [], peers = [], siblingRules = [], selfFingerprint = '', onDismissProposal,
  onSetRemoteConsent,
  focusNoticesSeq = 0,
}: ConnectionCardProps) {
  const isMobile = useIsMobile()
  const [expanded, setExpanded] = useState(false)
  const [identity, setIdentity] = useState<ProbedIdentity | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  // The repository picker's apply phase lives HERE, not in the picker (Important 2): the picker
  // renders inside `{expanded && …}`, so collapsing the card unmounted it and reset the guard to
  // "not busy" — fail-open — in the middle of the very apply it protects. Disconnect and Sync now
  // must stay disabled for the WHOLE apply, not just the PATCH round-trip: the gap between the
  // PATCH returning and the server's resync first becoming visible to this card's poll is exactly
  // when a second write would race the server's own forget/push sequence. The phase-advancing
  // effects below live here for the same reason — the card polls status whether it is expanded or
  // not, so an apply started and then collapsed still resolves.
  const [applyPhase, setApplyPhase] = useState<ApplyPhase>('idle')
  // Fix 6 (Plan 4 Task 1): whether the repo panel's edit view is open, lifted here for the same
  // reason `applyPhase` is — the panel unmounts on collapse, so the card (which stays mounted)
  // owns it, and hides Disconnect / Sync now for as long as it is true.
  const [repoEditing, setRepoEditing] = useState(false)
  const [noticesOpen, setNoticesOpen] = useState(false)
  // The status "i" is a per-card disclosure, closed by default: quiet is the default, and a panel
  // that opened itself would be the alarm the border deliberately is not.
  const [infoOpen, setInfoOpen] = useState(false)
  // Runs when the deep link names THIS card, and runs AGAIN each time it names it again — which
  // is why the prop is a sequence. Not a one-shot ref: the panel clears the query as soon as it
  // reads it, so a fresh `focusNoticesSeq` is itself the event.
  useEffect(() => {
    if (!focusNoticesSeq) return
    setExpanded(true)
    setNoticesOpen(true)
  }, [focusNoticesSeq])

  const resyncSeenRef = useRef(false)
  const statusRef = useRef(status)
  useEffect(() => { statusRef.current = status }, [status])

  // Watches every poll tick while waiting: a live resync always wins, and once one has been SEEN
  // its later clearing is what promotes the banner to 'done' — never the mere absence of one.
  useEffect(() => {
    if (applyPhase !== 'waiting') return
    if (status?.resync != null) { resyncSeenRef.current = true; return }
    if (resyncSeenRef.current) setApplyPhase('done')
  }, [status, applyPhase])

  // A grace window for the case nothing ever needed reconciling (no resync ever appears) — an
  // unreachable central (`pendingRules`) is NOT that case, and must keep showing `queued`, never a
  // false `done`. Runs ONCE per entering 'waiting', independent of the poll cadence.
  useEffect(() => {
    if (applyPhase !== 'waiting') return
    resyncSeenRef.current = false
    const t = setTimeout(() => {
      if (resyncSeenRef.current) return
      if (statusRef.current?.pendingRules) return
      setApplyPhase('done')
    }, 6000)
    return () => clearTimeout(t)
  }, [applyPhase])

  useEffect(() => {
    if (applyPhase !== 'done') return
    const t = setTimeout(() => setApplyPhase('idle'), 6000)
    return () => clearTimeout(t)
  }, [applyPhase])

  const state = resolveCardState(status)
  const brokenEndpoint = isBrokenEndpoint(conn.endpoint)
  const host = hostOf(conn.endpoint)

  // Which name goes where is decided in ONE pure place — see `cardIdentity.ts`. The old inline
  // ternary here preferred `conn.label`, a local nickname, over `identity.machineName`, the name
  // the CENTRAL assigned this machine: the machine appeared to have renamed itself.
  //
  // The org comes from the probe when the card has been expanded, else from the status poll — the
  // same value, and the poll is what lets a COLLAPSED card carry the org name too.
  const org = identity?.org || status?.org
  const names = resolveCardIdentity({
    machineName: identity?.machineName,
    label: conn.label,
    org,
    host,
    user: conn.user,
    duplicateHost,
  })
  // The typing target of the disconnect confirmation: the PLAIN name (never the `name · user`
  // disambiguation `names.central` may carry) — it has to be typeable on a phone, and it must be
  // the name the card is actually titled with, or the dialog asks for a word that is not on screen.
  const centralLabel = names.centralSource === 'org' ? (org ?? '').trim() : (conn.label ?? host)

  async function handleSyncNow() {
    if (syncing) return
    setSyncing(true)
    try { await onSyncNow(conn.id) } finally { setSyncing(false) }
  }

  async function handleDisconnect() {
    setDisconnecting(true)
    try { await onDisconnect(conn.id) } finally { setDisconnecting(false); setConfirmOpen(false) }
  }

  // A connection whose endpoint cannot be parsed offers Disconnect only — nothing else here may
  // ever call `new URL()` on it. `hostOf` already guarantees this never throws. Its frame is the
  // same discreet fault border every other fault gets: the card already states the problem in
  // words, so the frame does not need to shout it too.
  if (brokenEndpoint) {
    return (
      <div style={{
        border: `1px solid ${toneBorderColor('error')}`, borderRadius: 10, padding: 14,
        display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg-card)',
      }}>
        <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>{centralLabel}</div>
        <div style={{ fontSize: 12, color: 'var(--accent-red)' }}>{COPY.brokenConn[lang]}</div>
        <DisconnectButton lang={lang} onClick={() => setConfirmOpen(true)} disabled={disconnecting} isMobile={isMobile} />
        <ConfirmModal
          open={confirmOpen}
          title={interpolate(COPY.disconnectTitle[lang], { central: centralLabel })}
          message={COPY.disconnectBody[lang]}
          confirmLabel={COPY.disconnectBtn[lang]}
          cancelLabel={COPY.cancel[lang]}
          onConfirm={() => { void handleDisconnect() }}
          onCancel={() => setConfirmOpen(false)}
          requireText={centralLabel}
          requireTextHint={interpolate(COPY.disconnectHint[lang], { central: centralLabel })}
        />
      </div>
    )
  }

  // Polarity follows the connection's MODE — see `resolveRulePill`. Same shared-positive
  // discipline the expanded read view already follows.
  const rulePill = resolveRulePill(status)
  const disableWrites = resolveWritesDisabled(state, syncing, disconnecting, applyPhase)
  // The notices affordance: a decision another machine is waiting on must be reachable from the
  // COLLAPSED card, not buried three sections into the expanded one. Its count is the whole state,
  // and a changed key colours it as an alarm rather than a decision.
  const notices = noticeSummary(proposals, keyWarnings)
  // The dot is the channel; a fault adds a discreet border in that SAME severity plus the "i" that
  // says what the status is. Decided once, in `cardState.ts` — never from an `if` on a state name.
  const statusStyle = resolveCardStatusStyle(state)

  return (
    <div style={{
      border: `1px solid ${toneBorderColor(statusStyle.border)}`,
      borderRadius: 10, background: 'var(--bg-card)', overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, flex: '1 1 auto', minWidth: 0, minHeight: 56,
          padding: '10px 14px', border: 'none', background: 'transparent', cursor: 'pointer',
          textAlign: 'left', fontFamily: 'inherit', flexWrap: 'wrap',
        }}
      >
        {state === 'resyncing'
          ? <Loader2 size={10} style={{ color: 'var(--anthropic-orange)', animation: 'spin 1s linear infinite', flexShrink: 0 }} />
          : <StatusDot state={statusStyle.dot} />}
        <div style={{ minWidth: 0, flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {/* The card's subject is the CONNECTION, so its title is the central: the local nickname
             if one was ever set (CLI `--label`, or an older config), else the endpoint host. The
             nickname names THAT CENTRAL and nothing else. */}
          <span style={{
            display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {names.central}
          </span>
          {/* Machine and account are different things and are labelled as such. The machine's name
             is READ-ONLY here — it is assigned by the central (`whoami`) and this machine may
             neither write it nor mask it. It can be long ("Alienware 2 (teste da segunda
             central)"), so it wraps inside its own box; the page body never scrolls sideways. */}
          <div style={{
            display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 10, rowGap: 2,
            fontSize: 11.5, color: 'var(--text-tertiary)', minWidth: 0,
          }}>
            <span
              style={{ minWidth: 0, overflowWrap: 'anywhere' }}
              title={names.machineSource === 'central' ? COPY.machineNameByCentral[lang] : COPY.machineNamePending[lang]}
            >
              {COPY.cardMachine[lang]}{' '}
              <strong style={{
                fontWeight: 600,
                color: names.machineSource === 'central' ? 'var(--text-secondary)' : 'var(--text-tertiary)',
              }}>
                {names.machine}
              </strong>
            </span>
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
              {COPY.cardUser[lang]}{' '}
              <strong style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{names.user || '—'}</strong>
            </span>
          </div>
        </div>
        {rulePill && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 999,
            background: rulePill.tone === 'allow'
              ? 'color-mix(in srgb, var(--accent-green) 15%, transparent)'
              : withheldMarkStyle().background,
            color: rulePill.tone === 'allow' ? 'var(--accent-green)' : withheldMarkStyle().color,
            fontSize: 11, fontWeight: 700, flexShrink: 0,
          }}>
            {rulePill.tone === 'allow' ? <Check size={11} /> : <EyeOff size={11} />}
            {interpolate(
              plural(rulePill.tone === 'allow' ? PLURAL_COPY.allowedPill[lang] : PLURAL_COPY.blockedPill[lang], rulePill.count),
              { n: rulePill.count },
            )}
          </span>
        )}
        {/* The caret needs its OWN colour: the wrapping button is `background: transparent` and
            sets none, so an uncoloured icon inherited nothing and fell through to the browser
            default — black, and invisible on the dark card. It takes the PRIMARY text token, not
            the accent: a disclosure arrow is structure, and the accent on this card is already
            spent on the notices button and the things that should actually be clicked. */}
        {expanded
          ? <ChevronDown size={20} style={{ flexShrink: 0, color: 'var(--text-primary)' }} />
          : <ChevronRight size={20} style={{ flexShrink: 0, color: 'var(--text-primary)' }} />}
      </button>
      {statusStyle.info && (
        <StatusInfoButton
          open={infoOpen}
          lang={lang}
          isMobile={isMobile}
          onToggle={() => setInfoOpen(v => !v)}
        />
      )}
      {notices.total > 0 && onDismissProposal && (
        <button
          type="button"
          onClick={() => setNoticesOpen(true)}
          title={COPY.noticesBtn[lang]}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
            flexShrink: 0, marginRight: 12,
            minHeight: isMobile ? 44 : 30, padding: isMobile ? '0 12px' : '0 10px',
            borderRadius: 999, fontFamily: 'inherit', fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
            border: `1px solid ${notices.tone === 'alarm' ? 'var(--accent-red)' : 'var(--anthropic-orange)'}`,
            background: 'transparent',
            color: notices.tone === 'alarm' ? 'var(--accent-red)' : 'var(--anthropic-orange)',
          }}
        >
          <Bell size={12} />
          {COPY.noticesBtn[lang]} {notices.total}
        </button>
      )}
      </div>

      {statusStyle.info && infoOpen && (
        <StatusInfoPanel state={state} central={names.central} endpoint={conn.endpoint} lang={lang} />
      )}

      {expanded && (
        <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <StatusLine state={state} status={status} lang={lang} />

          {showsApplyQueuedBanner(state, status?.pendingRules) && (
            <div style={{
              padding: '8px 12px', borderRadius: 7, fontSize: 11.5, color: 'var(--anthropic-orange)',
              background: 'color-mix(in srgb, var(--anthropic-orange) 10%, transparent)',
            }}>
              {COPY.applyQueued[lang]}
            </div>
          )}

          {showsElsewhereWarning(status?.elsewhere) && (
            <div
              role="status"
              style={{
                padding: '10px 12px', borderRadius: 7, fontSize: 11.5, lineHeight: 1.5,
                color: 'var(--anthropic-orange)',
                background: 'color-mix(in srgb, var(--anthropic-orange) 10%, transparent)',
                display: 'flex', flexDirection: 'column', gap: 6,
              }}
            >
              <strong style={{ fontSize: 12 }}>{COPY.elsewhereTitle[lang]}</strong>
              <span style={{ color: 'var(--text-secondary)' }}>{COPY.elsewhereBody[lang]}</span>
              <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {(status?.elsewhere ?? []).map(e => (
                  // `overflowWrap` and not `nowrap`: a repo key plus two machine names overflows a
                  // 390px card, and the page body must never scroll horizontally.
                  <li key={e.repo} style={{ overflowWrap: 'anywhere' }}>
                    {elsewhereLine(e, COPY.elsewhereNoRepo[lang])}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {state === 'resyncing' && status?.resync && <ResyncStrip resync={status.resync} lang={lang} />}

          <ConnectionIdentity
            connId={conn.id}
            endpoint={conn.endpoint}
            expanded={expanded}
            lang={lang}
            onResolved={setIdentity}
          />

          <PeersSection peers={peers} selfFingerprint={selfFingerprint} lang={lang} />

          <RepoPanelSlot
            connId={conn.id}
            sources={conn.sources}
            shareMode={conn.shareMode}
            state={state}
            status={status}
            archiveMode={archiveMode}
            shareTargets={shareTargets}
            projectTargets={projectTargets}
            sessions={sessions}
            modelUsage={modelUsage}
            otelEnabled={otelEnabled}
            lang={lang}
            siblingRules={siblingRules}
            onApplyRules={onApplyRules}
            phase={applyPhase}
            onPhase={setApplyPhase}
            editing={repoEditing}
            onEditingChange={setRepoEditing}
          />

          {onSetRemoteConsent && !repoEditing && (
            <RemoteSessionsBlock
              connId={conn.id}
              status={status}
              lang={lang}
              // Same guard the card's other writes take: a rules apply or a disconnect in flight
              // is exactly when a second write races the server's own forget/push sequence.
              disabled={disableWrites}
              onPatch={onSetRemoteConsent}
            />
          )}

          {/* Fix 6 (Plan 4 Task 1): hidden — not merely disabled — for the whole time the repo
             panel's edit view is open. Both are unrelated to the edit in progress, and Disconnect
             is destructive: it must not sit next to an in-progress, unsaved rules edit. */}
          {!resolveCardActionsHidden(repoEditing) && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', flexDirection: isMobile ? 'column' : 'row' }}>
              <button
                type="button"
                onClick={() => { void handleSyncNow() }}
                disabled={disableWrites}
                style={mobileBtn(disableWrites, false, isMobile)}
              >
                {syncing ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : null}
                {COPY.syncNow[lang]}
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={disableWrites}
                style={mobileBtn(disableWrites, true, isMobile)}
              >
                {COPY.disconnect[lang]}
              </button>
            </div>
          )}
        </div>
      )}

      {onDismissProposal && (
        <NoticesModal
          open={noticesOpen}
          onClose={() => setNoticesOpen(false)}
          conn={conn}
          proposals={proposals}
          keyWarnings={keyWarnings}
          // The standing FACTS are the table's rows, and this machine's own project paths are what
          // make a project row actionable here (a rule must name the exact local path).
          siblingRules={siblingRules}
          localProjects={projectTargets.map(p => p.path)}
          lang={lang}
          disabled={disableWrites}
          onApply={onApplyRules}
          onDismiss={onDismissProposal}
        />
      )}
      <ConfirmModal
        open={confirmOpen}
        title={interpolate(COPY.disconnectTitle[lang], { central: centralLabel })}
        message={COPY.disconnectBody[lang]}
        confirmLabel={COPY.disconnectBtn[lang]}
        cancelLabel={COPY.cancel[lang]}
        onConfirm={() => { void handleDisconnect() }}
        onCancel={() => setConfirmOpen(false)}
        requireText={centralLabel}
        requireTextHint={interpolate(COPY.disconnectHint[lang], { central: centralLabel })}
      />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
