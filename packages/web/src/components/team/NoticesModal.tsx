import { useEffect, useMemo, useState } from 'react'
import { X, AlertTriangle, Check } from 'lucide-react'
import type { ShareSource, TeamConnection, SiblingRuleFact } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import { COPY, interpolate } from './copy'
import { mobileBtn } from './ConnectionCardParts'
import type { ShareMode } from './sharePanelState'
import { buildRestrictionTable, type RestrictionRow, type RestrictionMachine } from './restrictionTable'
import {
  describeSources, proposalAge, proposalPlan, type ProposalView, type KeyWarningView,
} from './proposalNotices'
import { OVERLAY_TOP } from '../../lib/mobileOverlay'

/**
 * NoticesModal — everything another machine of this account is waiting on a decision about.
 *
 * IT IS A TABLE OF WHAT IS NOT SHARED, AND WHERE. It used to be one prose card per proposal, each
 * restating the same three sentences about one sibling's entire rule set — so two announcements
 * from one machine were two walls of near-identical text, and "is this repository hidden
 * everywhere?" had to be answered by intersecting them by hand. The rows are now the restricted
 * repositories and projects, and each row names the machines that withhold it, this one included.
 * `restrictionTable.ts` is the arithmetic; this file only draws it.
 *
 * PROPOSE, NEVER APPLY, AND NEVER WIDEN — unchanged. Apply is now reachable per ROW (a restriction
 * a sibling has and this machine does not is exactly the thing worth acting on) and per MACHINE
 * ("apply all" of one sibling's announcement). Both send `plan.merged`, the narrowing-only merge
 * from `planProposalApply`, never the sibling's raw snapshot; the warning that names what applying
 * VERBATIM would have opened survives, as do the staleness callout and the standing honesty
 * guards — nothing changed here until a button is pressed, and this machine knows only what its
 * siblings announced to it.
 */
export interface NoticesModalProps {
  open: boolean
  onClose: () => void
  conn: TeamConnection
  proposals: ProposalView[]
  keyWarnings: KeyWarningView[]
  /** The standing facts: what each sibling last announced about its OWN rules. The table's rows. */
  siblingRules?: SiblingRuleFact[]
  /** This machine's known project paths — what makes a project row actionable here. */
  localProjects?: string[]
  lang: 'pt' | 'en'
  disabled: boolean
  onApply: (id: string, mode: ShareMode, sources: ShareSource[]) => Promise<{ ok: true; queued: boolean } | { ok: false }>
  onDismiss: (connId: string, body: { proposalId?: string; keyWarningMachineId?: string }) => Promise<void>
}

function machineNames(list: readonly RestrictionMachine[]): string {
  return list.map(m => m.machineName).join(', ')
}

export function NoticesModal({
  open, onClose, conn, proposals, keyWarnings, siblingRules = [], localProjects = [],
  lang, disabled, onApply, onDismiss,
}: NoticesModalProps) {
  const isMobile = useIsMobile()
  const [busy, setBusy] = useState<string | null>(null)
  const now = Date.now()

  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [open, onClose])

  const table = useMemo(() => buildRestrictionTable({
    self: { shareMode: conn.shareMode === 'allowlist' ? 'allowlist' : 'denylist', sources: conn.sources ?? [] },
    selfLabel: COPY.peersSelf[lang],
    siblings: siblingRules,
    localProjects,
  }), [conn.shareMode, conn.sources, siblingRules, localProjects, lang])

  // An announcement with nothing left to add is not a decision. The server filters these on the
  // read path; re-checked here so an older server cannot put an inert Apply button back on screen.
  const openProposals = useMemo(
    () => proposals.filter(p => !proposalPlan(conn, { shareMode: p.shareMode, sources: p.sources }).changesNothing),
    [proposals, conn],
  )

  if (!open) return null

  const applyRow = async (row: RestrictionRow) => {
    if (!row.source) return
    setBusy(row.key)
    try {
      // The ordinary rules PATCH, carrying the narrowing-only merge of a ONE-SOURCE denial — the
      // same arithmetic "apply all" runs, asked of a single row.
      const plan = proposalPlan(conn, { shareMode: 'denylist', sources: [row.source] })
      await onApply(conn.id, plan.merged.shareMode, plan.merged.sources)
    } finally { setBusy(null) }
  }

  const label = (row: RestrictionRow) => describeSources(
    [row.kind === 'none' ? { type: 'none', value: '' } : { type: row.kind, value: row.value }],
    lang,
  )

  const rowAction = (row: RestrictionRow) => {
    if (row.selfRestricts) {
      return (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--accent-green)', fontSize: 11.5, fontWeight: 700 }}>
          <Check size={12} />{COPY.rowAppliedHere[lang]}
        </span>
      )
    }
    if (!row.applicable) {
      return (
        <span title={COPY.rowNoLocalProject[lang]} style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          {COPY.rowNoLocalProject[lang]}
        </span>
      )
    }
    return (
      <button
        type="button"
        disabled={disabled || busy === row.key}
        onClick={() => { void applyRow(row) }}
        style={{ ...mobileBtn(disabled || busy === row.key, false, isMobile), width: isMobile ? '100%' : undefined }}
      >
        {COPY.proposalApply[lang]}
      </button>
    )
  }

  const restrictedCell = (row: RestrictionRow) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {row.restrictedBy.map(m => (
          <span
            key={m.machineId || 'self'}
            title={m.paths.length > 0 ? m.paths.join(', ') : undefined}
            style={{
              padding: '1px 7px', borderRadius: 999, fontSize: 11, fontWeight: 600,
              overflowWrap: 'anywhere',
              color: m.self ? 'var(--text-primary)' : 'var(--anthropic-orange)',
              background: m.self
                ? 'color-mix(in srgb, var(--text-primary) 10%, transparent)'
                : 'color-mix(in srgb, var(--anthropic-orange) 12%, transparent)',
            }}
          >
            {m.machineName || COPY.peerUnnamed[lang]}
          </span>
        ))}
      </div>
      {row.sharedBy.length > 0 && (
        <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>
          {interpolate(COPY.rowSharedOn[lang], { machines: machineNames(row.sharedBy) })}
        </span>
      )}
    </div>
  )

  const bucketCell = (row: RestrictionRow) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
        {label(row)}
      </span>
      <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>
        {row.kind === 'project' ? COPY.rowTagProject[lang] : COPY.rowTagRepo[lang]}
      </span>
    </div>
  )

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 2000, display: 'flex',
        alignItems: isMobile ? 'stretch' : 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)', padding: isMobile ? OVERLAY_TOP : 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: isMobile ? '100%' : 620, height: isMobile ? '100%' : undefined,
          maxHeight: isMobile ? '100%' : '86vh', overflowY: 'auto',
          background: 'var(--bg-card)', border: isMobile ? 'none' : '1px solid var(--border)',
          borderRadius: isMobile ? 0 : 12, boxShadow: '0 12px 48px rgba(0,0,0,0.5)',
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
          padding: '14px 16px', borderBottom: '1px solid var(--border)',
          position: 'sticky', top: 0, background: 'var(--bg-card)', zIndex: 1,
        }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>{COPY.noticesTitle[lang]}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={COPY.cancel[lang]}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: isMobile ? 44 : 30, height: isMobile ? 44 : 30, marginRight: isMobile ? -8 : 0,
              border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer',
            }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {table.rows.length === 0 && openProposals.length === 0 && keyWarnings.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{COPY.noticesEmpty[lang]}</div>
          )}

          {keyWarnings.map(w => (
            <div
              key={w.machineId}
              role="alert"
              style={{
                padding: '10px 12px', borderRadius: 7, fontSize: 11.5, lineHeight: 1.5,
                color: 'var(--accent-red)', background: 'color-mix(in srgb, var(--accent-red) 12%, transparent)',
                display: 'flex', flexDirection: 'column', gap: 8,
              }}
            >
              <strong style={{ fontSize: 12 }}>{COPY.keyChangedTitle[lang]}</strong>
              <span style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
                {interpolate(COPY.keyChangedBody[lang], { name: w.machineName || COPY.peerUnnamed[lang] })}
              </span>
              <button
                type="button"
                disabled={busy === w.machineId}
                onClick={async () => {
                  setBusy(w.machineId)
                  try { await onDismiss(conn.id, { keyWarningMachineId: w.machineId }) } finally { setBusy(null) }
                }}
                style={{ ...mobileBtn(busy === w.machineId, false, isMobile), alignSelf: isMobile ? 'stretch' : 'flex-start' }}
              >
                {COPY.keyChangedDismiss[lang]}
              </button>
            </div>
          ))}

          {/* THE TABLE — what is hidden, and from which machines. */}
          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <strong style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{COPY.restrictionsTitle[lang]}</strong>
              <span style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{COPY.restrictionsSubtitle[lang]}</span>
            </div>

            {table.rows.length === 0 ? (
              <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{COPY.restrictionsEmpty[lang]}</span>
            ) : isMobile ? (
              // A phone gets one stacked card per row: the same three facts, top to bottom. Never a
              // table squeezed sideways — the page body must not scroll horizontally at 390px.
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {table.rows.map(row => (
                  <div
                    key={row.key}
                    style={{
                      display: 'flex', flexDirection: 'column', gap: 8,
                      padding: '10px 12px', borderRadius: 8,
                      border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                    }}
                  >
                    {bucketCell(row)}
                    {restrictedCell(row)}
                    {rowAction(row)}
                  </div>
                ))}
              </div>
            ) : (
              // A wide row (a long path plus three machine names) scrolls inside its own container,
              // never the modal body.
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      {[COPY.colBucket[lang], COPY.colRestrictedOn[lang], COPY.colAction[lang]].map((h, i) => (
                        <th
                          key={h}
                          style={{
                            textAlign: 'left', padding: '6px 8px', fontSize: 10.5, fontWeight: 700,
                            textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-tertiary)',
                            borderBottom: '1px solid var(--border)',
                            width: i === 0 ? '46%' : i === 1 ? '34%' : '20%',
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.map(row => (
                      <tr key={row.key}>
                        <td style={{ padding: '8px', borderBottom: '1px solid var(--border)', verticalAlign: 'top' }}>{bucketCell(row)}</td>
                        <td style={{ padding: '8px', borderBottom: '1px solid var(--border)', verticalAlign: 'top' }}>{restrictedCell(row)}</td>
                        <td style={{ padding: '8px', borderBottom: '1px solid var(--border)', verticalAlign: 'top' }}>{rowAction(row)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {table.allowlistMachines.length > 0 && (
              <span style={{ fontSize: 11, color: 'var(--anthropic-orange)', overflowWrap: 'anywhere' }}>
                {interpolate(COPY.restrictionsAllowlistNote[lang], { machines: machineNames(table.allowlistMachines) })}
              </span>
            )}
            {table.rows.some(r => r.kind === 'project') && (
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{COPY.siblingWithholdProjectNote[lang]}</span>
            )}
            {/* The load-bearing caveat: an absent row is never proof that nobody restricts it. */}
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{COPY.siblingWithholdBestEffort[lang]}</span>
          </section>

          {/* One strip per machine with an offer still open — the whole-snapshot apply, kept
              reachable, minus the prose the table now carries. */}
          {openProposals.map(p => {
            const plan = proposalPlan(conn, { shareMode: p.shareMode, sources: p.sources })
            const age = proposalAge(p.at, now, lang)
            return (
              <div
                key={p.id}
                style={{
                  padding: '10px 12px', borderRadius: 8, fontSize: 11.5, lineHeight: 1.5,
                  border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                  display: 'flex', flexDirection: 'column', gap: 8,
                }}
              >
                <strong style={{ fontSize: 12, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
                  {interpolate(COPY.proposalStripTitle[lang], { name: p.fromMachineName || COPY.peerUnnamed[lang] })}
                </strong>
                <span style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
                  {plan.stopsSharing.length > 0 && (
                    <>{COPY.proposalWouldHide[lang]} <strong style={{ color: 'var(--accent-red)' }}>{describeSources(plan.stopsSharing, lang)}</strong>{' '}</>
                  )}
                  {plan.partlyRestricts.length > 0 && (
                    <>{COPY.proposalPartlyRestricts[lang]} <strong style={{ color: 'var(--text-primary)' }}>{describeSources(plan.partlyRestricts, lang)}</strong>{' '}</>
                  )}
                  {plan.hidesEverythingUnlisted && <>{COPY.proposalHidesUnlisted[lang]}</>}
                </span>

                {/* The cross-mode case, unmissable: what applying it VERBATIM would have opened —
                    and the promise that this button will not do it. */}
                {(plan.wouldStartSharing.length > 0 || plan.widensEverythingUnlisted) && (
                  <div
                    role="status"
                    style={{
                      display: 'flex', gap: 7, alignItems: 'flex-start', padding: '8px 10px', borderRadius: 7,
                      color: 'var(--anthropic-orange)',
                      background: 'color-mix(in srgb, var(--anthropic-orange) 12%, transparent)',
                      overflowWrap: 'anywhere',
                    }}
                  >
                    <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
                    <span>
                      {plan.wouldStartSharing.length > 0
                        ? interpolate(COPY.proposalWouldWiden[lang], { sources: describeSources(plan.wouldStartSharing, lang) })
                        : COPY.proposalWidensUnlisted[lang]}
                    </span>
                  </div>
                )}

                {age.text && (
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {interpolate(COPY.proposalAge[lang], { age: age.text })}
                  </span>
                )}
                {age.stale && (
                  <span style={{ fontSize: 11, color: 'var(--anthropic-orange)' }}>{COPY.proposalStale[lang]}</span>
                )}

                <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 8 }}>
                  <button
                    type="button"
                    disabled={disabled || busy === p.id}
                    onClick={async () => {
                      setBusy(p.id)
                      try {
                        // The NARROWING-ONLY merge, never the sibling's raw snapshot — which would
                        // lift every restriction it does not itself hold. Dismissed only once the
                        // apply succeeded.
                        const res = await onApply(conn.id, plan.merged.shareMode, plan.merged.sources)
                        if (res.ok) await onDismiss(conn.id, { proposalId: p.id })
                      } finally { setBusy(null) }
                    }}
                    style={mobileBtn(disabled || busy === p.id, false, isMobile)}
                  >
                    {COPY.proposalApplyAll[lang]}
                  </button>
                  <button
                    type="button"
                    disabled={busy === p.id}
                    onClick={async () => {
                      setBusy(p.id)
                      try { await onDismiss(conn.id, { proposalId: p.id }) } finally { setBusy(null) }
                    }}
                    style={mobileBtn(busy === p.id, false, isMobile)}
                  >
                    {COPY.proposalDismiss[lang]}
                  </button>
                </div>
              </div>
            )
          })}

          {/* Honesty guard — kept verbatim, once for the whole screen: nothing has changed here
              until a button is pressed. */}
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{COPY.proposalNotApplied[lang]}</span>
        </div>
      </div>
    </div>
  )
}
