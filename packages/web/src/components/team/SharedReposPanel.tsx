import React, { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Loader2, Check, ChevronDown, ChevronRight } from 'lucide-react'
import type { SessionMeta, ModelUsage, ShareSource, SiblingRuleFact } from '@agentistics/core'
import { NO_REPO_KEY, fmtCost } from '@agentistics/core'
import type { ShareTarget, ProjectTarget } from '../../lib/shareRepos'
import { plural } from '../../lib/shareRepos'
import { blendedCostPerToken } from '../../hooks/useData'
import { Section, ConfirmModal } from '../../pages/settings/primitives'
import Drawer from '../../pages/settings/Drawer'
import { drawerBtn } from './ConnectionCardParts'
import { buildRestrictionTable, type RestrictionRow } from './restrictionTable'
import { restrictionMiniTable, MaximizedRestrictions } from './RestrictionMiniTable'
import { PAGE_SIZE_OPTIONS } from './tablePaging'
import { useIsMobile } from '../../hooks/useIsMobile'
import { COPY, PLURAL_COPY, interpolate } from './copy'
import type { CardState } from './cardState'
import type { ConnectionStatusEntry } from './statusTypes'
import { SharingRulesPicker } from './SharingRulesPicker'
import {
  buildInitialDraft, canEditRepos, computeApplyImpact, diffDraft, hasProvenPrehistory,
  isDirty, normalizeDenied, resolveApplyBanner, resolveConfirmVariant,
  shareAllDraft, blockAllDraft, statsCopyVars, synthesizeMissingDenied, toggleTarget,
  type ApplyPhase,
} from './repoPanelState'
import {
  resolveInitialTab, sourcesToRepoKeys, sourcesToProjectPaths, buildSourcesFromDraft,
  computeSharedSummary, isEmptyAllowlist, modeChanged, resolveModeConfirmVariant,
  toggleProjectTarget, shareAllProjectsDraft, blockAllProjectsDraft,
  resolveSubmittedRules, partiallyDeniedRepoKeys, isProjectLocked,
  type PickerTab, type ShareMode, type ModeConfirmVariant,
} from './sharePanelState'

/**
 * SharedReposPanel.tsx — the per-central sharing-rules editor (Task 11, extended by Plan 4 Tasks
 * 6–7 into the two-tab Projects/Repositories picker plus the denylist/allowlist mode selector).
 * A layout over `repoPanelState.ts` / `sharePanelState.ts`'s pure decisions: this file owns
 * rendering, local edit-mode state and the ONE `PATCH /api/team/connections/:id` round-trip;
 * every substantive decision (grouping, search, the draft diff, the impact numbers, the confirm
 * variant, row/project locking, the shared summary, the mode switch) lives in those two modules
 * and is unit-tested there.
 */

export interface SharedReposPanelProps {
  connId: string
  /** The connection's stored typed rules — `sources`/`shareMode` REPLACE the legacy `deniedRepos`
   *  this panel used to read directly (Plan 4). `shareMode` absent reads as `'denylist'`, same as
   *  every other reader in this codebase. */
  sources: ShareSource[] | undefined
  shareMode: ShareMode | undefined
  cardState: CardState
  status: ConnectionStatusEntry | undefined
  shareTargets: ShareTarget[]
  /** The project projection (Task 5), fed by the SAME unfiltered project list the repo tab's
   *  `shareTargets` comes from — see `ConnectionsPanel`'s shared memo. */
  projectTargets: ProjectTarget[]
  /** Unfiltered — needed both for the impact estimate's token sums and for the confirm modal's
   *  "proven prehistory" check. */
  sessions: SessionMeta[]
  modelUsage: Record<string, ModelUsage>
  /** Machine-wide — whether OTel metrics export is currently configured (mirrors the top-level
   *  `otelExportEnabled` on `GET /api/team/status`, computed from `OTEL_EXPORTER_OTLP_ENDPOINT`). */
  otelEnabled: boolean
  lang: 'pt' | 'en'
  /** What each sibling machine last announced about its OWN rules, from this machine's sealed
   *  envelope inbox. The reverse warning's only sound evidence — see `siblingWarnings.ts`. */
  siblingRules?: SiblingRuleFact[]
  /** The ONE write this panel performs. Resolves to whether the server queued a resync (something
   *  actually changed) so the panel knows whether to wait for `status.resync` at all. Throws (or
   *  resolves false) on failure — the caller decides what "failed" means for its own transport. */
  onApply: (connId: string, mode: ShareMode, sources: ShareSource[]) => Promise<{ ok: true; queued: boolean } | { ok: false }>
  /** The apply phase is a CONTROLLED prop, owned by `ConnectionCard` — see `resolveWritesDisabled`
   *  (Important 2). This panel lives inside the card's `{expanded && …}`, so anything it owns dies
   *  when the card is collapsed; the write guard that covers the whole apply (the PATCH round-trip
   *  AND the wait for the server's resync to first become visible on a poll) must outlive that. */
  phase: ApplyPhase
  onPhase: (phase: ApplyPhase) => void
  /** Fix 6 (Plan 4 Task 1): whether this panel's edit view is open, CONTROLLED by `ConnectionCard`
   *  — same reasoning as `phase`/`onPhase` above. The card stays mounted while collapsed and needs
   *  this to hide its Disconnect / Sync now actions for the whole time an edit is in progress. */
  editing: boolean
  onEditingChange: (editing: boolean) => void
}

export function SharedReposPanel({
  connId, sources, shareMode, cardState, status, shareTargets, projectTargets, sessions, modelUsage,
  otelEnabled, lang, siblingRules, onApply, phase, onPhase, editing, onEditingChange,
}: SharedReposPanelProps) {
  const isMobile = useIsMobile()
  const noRepoLabel = COPY.noRepoTitle[lang]

  const storedMode: ShareMode = shareMode === 'allowlist' ? 'allowlist' : 'denylist'
  const storedRepoKeysArr = sourcesToRepoKeys(sources)
  const storedProjectPathsArr = sourcesToProjectPaths(sources)
  const targets = synthesizeMissingDenied(shareTargets, storedRepoKeysArr, noRepoLabel)
  const storedRepoKeys = normalizeDenied(storedRepoKeysArr)
  const storedProjectPaths = new Set(storedProjectPathsArr)

  const [draft, setDraft] = useState<Set<string> | null>(null)
  const [projectDraft, setProjectDraft] = useState<Set<string> | null>(null)
  const [modeDraft, setModeDraft] = useState<ShareMode | null>(null)
  const [tab, setTab] = useState<PickerTab>(resolveInitialTab())
  const [search, setSearch] = useState('')
  const [showStale, setShowStale] = useState(false)
  const [showAllMobile, setShowAllMobile] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [showEmptyAllowlistWarning, setShowEmptyAllowlistWarning] = useState(false)

  function startEdit() {
    // The stored `sources` mean "blocked" under denylist but "allowed" under allowlist — the
    // draft's Set is always the mode-invariant "switch is OFF" shape (see the doc comment on
    // `resolveSubmittedRepoKeys`), so seeding it from an allowlist's stored keys needs the SAME
    // conversion the submit path uses — `resolveSubmittedRules`, both directions, one function.
    // It is its own inverse (denylist: identity; allowlist: a repository is submitted only when
    // no project under it is denied, and that same rule read backwards keeps a PARTLY-allowed
    // repository switched ON with exactly its denied projects OFF). Without it, re-opening an
    // already-saved allowlist showed its ALLOWED repo in the "Blocked" group, and toggling from
    // there would have inverted it.
    const seed = resolveSubmittedRules(storedMode, targets, projectTargets, storedRepoKeys, storedProjectPaths)
    setDraft(buildInitialDraft(targets, [...seed.repoKeys]))
    setProjectDraft(new Set(seed.projectPaths))
    setModeDraft(storedMode)
    setSearch('')
    setShowEmptyAllowlistWarning(false)
    onEditingChange(true)
  }
  function cancelEdit() {
    setDraft(null)
    setProjectDraft(null)
    setModeDraft(null)
    setShowEmptyAllowlistWarning(false)
    onEditingChange(false)
  }

  // --- the hidden-restrictions table ---------------------------------------------------------
  // Page and size live HERE, not in the table, because the same table is rendered twice (inline in
  // the card and maximized full-screen) and the two must not each keep their own idea of where the
  // user is. `resolvePaging` clamps both on every render, so a page left pointing past the end
  // after a rule is lifted corrects itself instead of rendering an empty table.
  const [tablePage, setTablePage] = useState(0)
  const [tableSize, setTableSize] = useState(PAGE_SIZE_OPTIONS.inline[0]!)
  const [maximized, setMaximized] = useState(false)
  // Focus must return to the control that opened the overlay, or a keyboard user is dropped at the
  // top of the document with no idea where they were.
  const maximizeOrigin = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!maximized) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMaximized() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function openMaximized() {
    maximizeOrigin.current = document.activeElement as HTMLElement | null
    // The two modes offer different sizes, so entering with an inline size would leave the
    // maximized view on a value it does not list. `resolvePaging` snaps it; seeding it here means
    // the select shows the right value on the very first frame.
    setTableSize(PAGE_SIZE_OPTIONS.maximized[0]!)
    setTablePage(0)
    setMaximized(true)
  }
  function closeMaximized() {
    setMaximized(false)
    setTableSize(PAGE_SIZE_OPTIONS.inline[0]!)
    setTablePage(0)
    maximizeOrigin.current?.focus?.()
  }

  const tableProps = {
    page: tablePage,
    size: tableSize,
    onPage: setTablePage,
    onSize: (n: number) => { setTableSize(n); setTablePage(0) },
    onMaximize: openMaximized,
  }

  const draftDenied = draft ?? storedRepoKeys
  const projectDraftDenied = projectDraft ?? storedProjectPaths
  const effectiveMode = modeDraft ?? storedMode

  const diff = diffDraft(draftDenied, storedRepoKeys)
  const projectDiff = diffDraft(projectDraftDenied, storedProjectPaths)
  const modeHasChanged = modeChanged(storedMode, effectiveMode)
  const dirty = isDirty(diff) || isDirty(projectDiff) || modeHasChanged

  const rate = blendedCostPerToken(modelUsage)
  // Repo-dimension only — a project-only rule (no matching repo rule) is not reflected in this
  // estimate. Documented simplification: the number is already presented with a leading "~".
  const impact = computeApplyImpact(sessions, targets, diff, rate)
  const hasProven = hasProvenPrehistory(sessions, diff, status?.boundary ?? null)
  const variant = resolveConfirmVariant(hasProven, status?.boundary ?? null)
  const stats = statsCopyVars(status?.boundary ?? null, status?.prehistorySessions ?? null, lang)
  const modeVariant = resolveModeConfirmVariant(storedMode, effectiveMode)

  // The picker's own draft sets always mean "this switch is OFF" (mode-invariant — see the doc
  // comment on `resolveSubmittedRepoKeys`), but the WIRE shape is not: `allowlist` stores the
  // OPPOSITE of what a denylist would. These are the sets actually submitted, computed ONCE per
  // render and shared by the empty-allowlist check and the submit call so they can never disagree.
  const submitted = resolveSubmittedRules(effectiveMode, targets, projectTargets, draftDenied, projectDraftDenied)
  const { projectRows, repoKeys: submittedRepoKeys, projectPaths: submittedProjectPaths } = submitted
  // Repositories that are, at most, PARTLY shared — at least one project under them is switched
  // OFF. Rendered as such in the Repositories tab so the two tabs never disagree: under allowlist
  // such a repository is deliberately NOT submitted as a repo source (its allowed paths travel
  // individually), which a plain ON switch would misreport.
  const partialRepoKeys = partiallyDeniedRepoKeys(projectRows)

  async function confirmApply() {
    setConfirmOpen(false)
    const newSources = buildSourcesFromDraft(submittedRepoKeys, submittedProjectPaths)
    const outcome = await onApply(connId, effectiveMode, newSources).catch(() => ({ ok: false as const }))
    if (!outcome.ok) { onPhase('error'); return }
    onEditingChange(false)
    setDraft(null)
    setProjectDraft(null)
    setModeDraft(null)
    onPhase(outcome.queued ? 'waiting' : 'done')
  }

  function attemptSave() {
    if (isEmptyAllowlist(effectiveMode, submittedRepoKeys, submittedProjectPaths)) {
      setShowEmptyAllowlistWarning(true)
      return
    }
    setShowEmptyAllowlistWarning(false)
    if (dirty) setConfirmOpen(true)
  }

  const banner = resolveApplyBanner(phase, status)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Section
        title={COPY.sharedRepos[lang]}
        // The editor is the DRAWER below — the same right-side panel the add-central wizard uses,
        // with the same picker, the same reverse-warning badges and the same caveat. The section
        // therefore never enters its own inline edit mode: one picker, one behaviour, one place to
        // fix a bug. `editChildren` stays required by `Section`'s contract and is never rendered.
        editing={false}
        onEdit={startEdit}
        onCancel={cancelEdit}
        onSave={attemptSave}
        canEdit={canEditRepos(cardState, phase)}
        labels={{ edit: COPY.editRules[lang], save: COPY.saveRules[lang], cancel: COPY.cancel[lang] }}
        editChildren={null}
      >
        <ReadView
          targets={targets}
          projectTargets={projectTargets}
          sources={sources ?? []}
          siblingRules={siblingRules}
          storedDenied={storedRepoKeys}
          storedProjectPaths={storedProjectPaths}
          mode={storedMode}
          sessions={sessions}
          status={status}
          lang={lang}
          otelEnabled={otelEnabled}
          isMobile={isMobile}
          table={tableProps}
        />
      </Section>

      {maximized && (
        <MaximizedRestrictions
          rows={buildRestrictionTable({
            self: { shareMode: storedMode, sources: sources ?? [] },
            selfLabel: COPY.peersSelf[lang],
            siblings: siblingRules ?? [],
            localProjects: projectTargets.map(pt => pt.path),
            scope: 'selfRestricted',
          }).rows}
          labelOf={row => hiddenRowLabel(row, targets, projectTargets, lang)}
          lang={lang}
          isMobile={isMobile}
          page={tablePage}
          size={tableSize}
          onPage={setTablePage}
          onSize={(n: number) => { setTableSize(n); setTablePage(0) }}
          onClose={closeMaximized}
        />
      )}

      <Drawer
        open={editing}
        title={COPY.sharedRepos[lang]}
        onClose={cancelEdit}
        dirty={dirty}
        lang={lang}
        footer={
          <>
            <button type="button" onClick={cancelEdit} style={drawerBtn(isMobile, 'secondary')}>
              {COPY.cancel[lang]}
            </button>
            <button type="button" onClick={attemptSave} style={drawerBtn(isMobile, 'primary')}>
              <Check size={14} /> {COPY.saveRules[lang]}
            </button>
          </>
        }
      >
        {editing && (
          <SharingRulesPicker
            mode={effectiveMode}
            onModeChange={setModeDraft}
            tab={tab}
            onTabChange={setTab}
            lang={lang}
            isMobile={isMobile}
            targets={targets}
            projectTargets={projectTargets}
            draftDenied={draftDenied}
            projectDraftDenied={projectDraftDenied}
            diff={diff}
            projectDiff={projectDiff}
            partialRepoKeys={partialRepoKeys}
            search={search}
            onSearch={setSearch}
            showStale={showStale}
            onToggleStale={() => setShowStale(v => !v)}
            showAllMobile={showAllMobile}
            onShowAllMobile={() => setShowAllMobile(true)}
            impactSessions={impact.sessions}
            impactCost={impact.costUSD}
            showEmptyAllowlistWarning={showEmptyAllowlistWarning}
            siblingRules={siblingRules}
            onToggleRow={(target, nextShared) => setDraft(toggleTarget(draftDenied, target, nextShared))}
            onShareAll={() => setDraft(shareAllDraft(targets))}
            onBlockAll={() => setDraft(blockAllDraft(targets))}
            onToggleProjectRow={(target, nextShared) => {
              setProjectDraft(toggleProjectTarget(projectDraftDenied, target, nextShared, isProjectLocked(target, draftDenied)))
            }}
            onShareAllProjects={() => setProjectDraft(shareAllProjectsDraft(projectTargets))}
            onBlockAllProjects={() => setProjectDraft(blockAllProjectsDraft(projectTargets))}
          />
        )}
      </Drawer>

      {banner && <ApplyBanner banner={banner} status={status} lang={lang} />}

      <ConfirmModal
        open={confirmOpen}
        title={COPY.applyConfirmTitle[lang]}
        message={buildConfirmMessage(variant, stats, impact, modeVariant, lang)}
        confirmLabel={COPY.applyConfirmBtn[lang]}
        cancelLabel={COPY.cancel[lang]}
        onConfirm={() => { onPhase('submitting'); void confirmApply() }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  )
}

/**
 * The confirm message MUST state the impact — "the only number the user actually cares about"
 * (the brief) — because the edit view's own `applyImpact` line sits behind the modal's blur the
 * moment it opens; a user confirming without it would be committing a hard-to-reverse action
 * (Important 1 review fix) blind to what it removes. `ConfirmModal.message` is a plain string
 * (not JSX), so every applicable sentence is joined into one paragraph.
 *
 * Plan 4 Task 7: a mode switch gets its OWN sentence, stating the consequence in the DIRECTION
 * being chosen — appended last, since it is the biggest single change this confirm can ever
 * describe.
 */
export function buildConfirmMessage(
  variant: 'generic' | 'proven',
  stats: { boundary: string; n: number } | null,
  impact: { sessions: number; costUSD: number },
  modeVariant: ModeConfirmVariant,
  lang: 'pt' | 'en',
): string {
  const parts = [COPY.applyConfirmBody[lang]]
  if (stats) {
    parts.push(interpolate(COPY.applyConfirmStats[lang], { boundary: stats.boundary, n: stats.n }))
    if (variant === 'proven') parts.push(interpolate(COPY.applyConfirmStatsProven[lang], { boundary: stats.boundary }))
  }
  if (impact.sessions > 0) {
    parts.push(interpolate(COPY.applyImpact[lang], { sessions: impact.sessions, cost: fmtCost(impact.costUSD) }))
  }
  if (modeVariant === 'toAllowlist') parts.push(COPY.modeConfirmToAllowlist[lang])
  if (modeVariant === 'toDenylist') parts.push(COPY.modeConfirmToDenylist[lang])
  return parts.join(' ')
}

/**
 * Fix 1 (Plan 4 Task 1): the read view used to put the HIDDEN chips directly under
 * `COPY.sharedRepos` — two polarities stacked in one box. The hidden block carries its own
 * explicit label with a count (`hiddenBlockTitle`), and the shared count is separate plain text
 * below it — never inside the same visual block.
 *
 * Plan 4 Task 6/7: the summary line now comes from `computeSharedSummary` (session-level, both
 * dimensions, both modes) so it is the exact number both tabs agree on. In allowlist mode the
 * chips invert to what IS listed — shared-positive, never a "hidden" chip for an allowlist, which
 * would read backwards (everything not listed is what's hidden, and that set is usually huge).
 */
/**
 * Fix (product owner live test, second half): the hidden entries used to be red outlined chips —
 * one undifferentiated blob in which a repository and a project looked the same, and which never
 * answered the question he actually asked: **where else is this restriction applied?**
 *
 * They are now ROWS built by `buildRestrictionTable` — the SAME builder the notices modal uses,
 * asked its narrower `scope: 'selfRestricted'` question. One builder, two surfaces: the two views
 * disagreeing about what is hidden would be worse than either.
 *
 * The colour is gone with the chips. Everything in this block is here because the user chose it,
 * and colour must mark what needs attention, not decorate a list of deliberate choices. A row with
 * no sibling information says so IN WORDS — an empty cell would read as "nowhere else", which is a
 * claim this machine cannot make (see `siblingWithholdBestEffort`, folded into the caveats below).
 */
export function hiddenRowLabel(
  row: RestrictionRow, targets: ShareTarget[], projectTargets: ProjectTarget[], lang: 'pt' | 'en',
): string {
  if (row.kind === 'none') return COPY.noRepoTitle[lang]
  if (row.kind === 'project') return projectTargets.find(p => p.key === row.value)?.name ?? row.value
  return targets.find(t => t.key === row.value)?.name ?? row.value
}

export function ReadView({ targets, projectTargets, sources, siblingRules, storedDenied, storedProjectPaths, mode, sessions, status, lang, otelEnabled, isMobile = false, table }: {
  targets: ShareTarget[]
  projectTargets: ProjectTarget[]
  /** The connection's stored rules VERBATIM — the same value the notices modal feeds
   *  `buildRestrictionTable`, so the two surfaces cannot disagree about what is hidden. */
  sources: ShareSource[]
  /** What each sibling machine last announced about its OWN rules — the "where else" column's
   *  only sound source (`envelope-inbox.ts`), and the reason the table is best-effort. */
  siblingRules?: SiblingRuleFact[]
  storedDenied: Set<string>
  storedProjectPaths: Set<string>
  mode: ShareMode
  sessions: SessionMeta[]
  status: ConnectionStatusEntry | undefined
  lang: 'pt' | 'en'
  otelEnabled: boolean
  isMobile?: boolean
  /** Paging state for the hidden-restrictions table. OPTIONAL, and the whole reason this component
   *  stays hook-free: the state lives in `SharedReposPanel`, which also drives the maximized view,
   *  so both renderings of the table read one source of truth. Absent = first page, smallest size,
   *  no maximize affordance — which is exactly what a test calling `ReadView` directly wants. */
  table?: {
    page: number
    size: number
    onPage: (p: number) => void
    onSize: (n: number) => void
    onMaximize: () => void
  }
}) {
  const stats = statsCopyVars(status?.boundary ?? null, status?.prehistorySessions ?? null, lang)
  const summary = computeSharedSummary(sessions, projectTargets, mode, storedDenied, storedProjectPaths)
  const hasAnyRule = storedDenied.size > 0 || storedProjectPaths.size > 0

  const repoChips = [...storedDenied].map(key => {
    const t = targets.find(x => x.key === key)
    const label = key === NO_REPO_KEY ? COPY.noRepoTitle[lang] : (t ? t.name : key)
    return { key, label, title: key === NO_REPO_KEY ? COPY.noRepoSub[lang] : key }
  })
  const projectChips = [...storedProjectPaths].map(path => {
    const t = projectTargets.find(x => x.key === path)
    return { key: path, label: t ? t.name : path, title: path }
  })
  const chips = [...repoChips, ...projectChips].sort((a, b) => a.label.localeCompare(b.label))

  // The denylist read view's rows, from the SAME builder the notices modal uses — asked its
  // narrower question (`scope: 'selfRestricted'`: what THIS machine hides from THIS central), so a
  // sibling's own restriction is never listed here as something this machine is withholding.
  const hiddenRows = buildRestrictionTable({
    self: { shareMode: mode, sources },
    selfLabel: COPY.peersSelf[lang],
    siblings: siblingRules ?? [],
    localProjects: projectTargets.map(p => p.path),
    scope: 'selfRestricted',
  }).rows

  if (mode === 'allowlist') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {chips.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent-green)', letterSpacing: '0.02em' }}>
              {interpolate(COPY.allowedBlockTitle[lang], { n: chips.length })}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {chips.map(c => (
                <span key={c.key} title={c.title} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%', padding: '2px 8px', borderRadius: 999,
                  background: 'color-mix(in srgb, var(--accent-green) 15%, transparent)',
                  color: 'var(--accent-green)', fontSize: 11, fontWeight: 600,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}><Check size={10} style={{ flexShrink: 0 }} />{c.label}</span>
              ))}
            </div>
          </div>
        )}
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
          {interpolate(plural(PLURAL_COPY.nShared[lang], summary.sharedCount), { n: summary.sharedCount, total: summary.totalLive })}
        </div>
        {chips.length === 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--anthropic-orange)' }}>{COPY.emptyAllowlistWarning[lang]}</div>
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {hiddenRows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', letterSpacing: '0.02em' }}>
            {interpolate(COPY.hiddenBlockTitle[lang], { n: hiddenRows.length })}
          </div>
          {/* A real table — the block is titled with a question ("what is hidden from this
             central") that stacked rows could not answer at a glance. The renderer degrades to
             stacked CARDS on a phone and keeps its own horizontal scroll box on desktop, so the
             page body never scrolls sideways. */}
          {restrictionMiniTable({
            rows: hiddenRows,
            labelOf: row => hiddenRowLabel(row, targets, projectTargets, lang),
            lang,
            mode: 'inline',
            isMobile,
            page: table?.page ?? 0,
            size: table?.size ?? PAGE_SIZE_OPTIONS.inline[0]!,
            onPage: table?.onPage ?? (() => {}),
            onSize: table?.onSize ?? (() => {}),
            ...(table ? { onMaximize: table.onMaximize } : {}),
          })}
        </div>
      )}
      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
        {!hasAnyRule
          ? COPY.sharingAll[lang]
          : interpolate(plural(PLURAL_COPY.nShared[lang], summary.sharedCount), { n: summary.sharedCount, total: summary.totalLive })}
      </div>
      <Caveats lang={lang}>
        <div>{COPY.newRepoNote[lang]}</div>
        {/* Qualifies the "restricted on" column directly above: this machine knows only what its
           siblings announced to it, and only since the encrypted channel existed. */}
        {hiddenRows.length > 0 && <div>{COPY.siblingWithholdBestEffort[lang]}</div>}
        {hasAnyRule && stats && (
          <div>{interpolate(COPY.statsNote[lang], { boundary: stats.boundary, n: stats.n })}</div>
        )}
        {hasAnyRule && <div>{COPY.ciNote[lang]}</div>}
      </Caveats>
      {/* Stays OUT of the disclosure: it is a live warning about this machine's configuration, and
         a warning nobody opens is a warning nobody reads. */}
      {hasAnyRule && otelEnabled && (
        <div style={{ fontSize: 11, color: 'var(--anthropic-orange)' }}>{COPY.otelWarn[lang]}</div>
      )}
    </div>
  )
}

/** The standing caveats, one row folded. The text is unchanged — precision was never the problem;
 *  four tertiary lines stacked under the thing they qualify was. */
function Caveats({ lang, children }: { lang: 'pt' | 'en'; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const isMobile = useIsMobile()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <button className="ag-tap"
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 5, alignSelf: 'flex-start', padding: 0,
          border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
          fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'left',
        }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {COPY.caveatsToggle[lang]}
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 17, fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          {children}
        </div>
      )}
    </div>
  )
}

function ApplyBanner({ banner, status, lang }: { banner: 'progress' | 'done' | 'error' | 'queued'; status: ConnectionStatusEntry | undefined; lang: 'pt' | 'en' }) {
  if (banner === 'progress') {
    // No resync visible yet means the first post-apply poll has not landed — a neutral "applying"
    // sentence, never the green success one (Important 1).
    const text = !status?.resync
      ? COPY.applyingWait[lang]
      : status.resync.phase === 'forget'
        ? interpolate(COPY.applyingForget[lang], { done: status.resync.done, total: status.resync.total })
        : COPY.applyingPush[lang]
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11.5, color: 'var(--text-tertiary)' }}>
        <span><Loader2 size={11} style={{ verticalAlign: '-1px', animation: 'spin 1s linear infinite', marginRight: 4 }} />{text}</span>
        <span>{COPY.applyingSafeToLeave[lang]}</span>
      </div>
    )
  }
  if (banner === 'done') {
    return <div style={{ fontSize: 11.5, color: 'var(--accent-green)' }}>{COPY.applyOk[lang]}</div>
  }
  if (banner === 'error') {
    return <div style={{ fontSize: 11.5, color: 'var(--accent-red)' }}>{COPY.applyErr[lang]}</div>
  }
  return <div style={{ fontSize: 11.5, color: 'var(--anthropic-orange)' }}>{COPY.applyQueued[lang]}</div>
}
