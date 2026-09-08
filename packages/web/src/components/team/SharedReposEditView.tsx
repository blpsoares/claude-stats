import type { CSSProperties, ReactNode } from 'react'
import { ChevronDown, ChevronRight, Search, GitBranch, Folder } from 'lucide-react'
import type { ShareTarget, ProjectTarget } from '../../lib/shareRepos'
import { plural } from '../../lib/shareRepos'
import { RowSwitch } from '../../pages/settings/primitives'
import { COPY, PLURAL_COPY, interpolate } from './copy'
import { WithheldBadge } from './SiblingWithheldBadge'
import type { WithholdingMachine } from './siblingWarnings'
import { relTime } from './cardState'
import {
  buildRows, groupRows, keepVisibleKeys, diffDraft, type EffectiveRow,
} from './repoPanelState'
import {
  groupProjectRows, buildProjectRows, type EffectiveProjectRow, type PickerTab, type ShareMode,
} from './sharePanelState'
import { fmtCost } from '@agentistics/core'

/**
 * SharedReposEditView.tsx — the edit-mode body of `SharedReposPanel.tsx` (Task 11), extended by
 * Plan 4 Tasks 6–7 with the Projects tab and the mode selector. Split out for the same reason
 * `ConnectionCardParts.tsx` split out of `ConnectionCard.tsx` (Task 10): the parent component owns
 * the state machine (drafts, search, tab, mode, apply phase), this file is pure layout over
 * `repoPanelState.ts` / `sharePanelState.ts`'s grouping/diff/impact — no decisions of its own
 * beyond the mobile row cap.
 */

// --- Task 7: the mode selector -----------------------------------------------------------------

/** Two mutually-exclusive options, not a checkbox — "share everything except…" (default) and
 *  "share only…" are opposite readings of the same list, never both at once. */
export function ModeSelector({ mode, onChange, lang, isMobile }: {
  mode: ShareMode
  onChange: (mode: ShareMode) => void
  lang: 'pt' | 'en'
  isMobile: boolean
}) {
  const options: { value: ShareMode; label: string; sub: string }[] = [
    { value: 'denylist', label: COPY.modeExceptLabel[lang], sub: COPY.modeExceptSub[lang] },
    { value: 'allowlist', label: COPY.modeOnlyLabel[lang], sub: COPY.modeOnlySub[lang] },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {options.map(opt => {
        const active = mode === opt.value
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            style={{
              display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left',
              padding: isMobile ? '10px 12px' : '8px 12px', minHeight: isMobile ? 44 : undefined,
              borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
              border: `1px solid ${active ? 'var(--anthropic-orange)' : 'var(--border)'}`,
              background: active ? 'var(--anthropic-orange-dim)' : 'transparent',
            }}
          >
            <span style={{ fontSize: 12.5, fontWeight: 700, color: active ? 'var(--anthropic-orange)' : 'var(--text-primary)' }}>
              {opt.label}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{opt.sub}</span>
          </button>
        )
      })}
    </div>
  )
}

// --- Task 6: the two-tab bar ---------------------------------------------------------------------

export function PickerTabs({ tab, onChange, lang, isMobile }: {
  tab: PickerTab
  onChange: (tab: PickerTab) => void
  lang: 'pt' | 'en'
  isMobile: boolean
}) {
  const tabs: { value: PickerTab; label: string; icon: ReactNode }[] = [
    { value: 'projects', label: COPY.tabProjects[lang], icon: <Folder size={13} /> },
    { value: 'repos', label: COPY.tabRepos[lang], icon: <GitBranch size={13} /> },
  ]
  return (
    <div style={{ display: 'flex', gap: 6, borderBottom: '1px solid var(--border)' }}>
      {tabs.map(t => {
        const active = tab === t.value
        return (
          <button
            key={t.value}
            type="button"
            onClick={() => onChange(t.value)}
            aria-current={active}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'inherit',
              padding: isMobile ? '10px 10px' : '6px 10px', minHeight: isMobile ? 44 : undefined,
              border: 'none', borderBottom: `2px solid ${active ? 'var(--anthropic-orange)' : 'transparent'}`,
              background: 'transparent', cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
              color: active ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
            }}
          >
            {t.icon}{t.label}
          </button>
        )
      })}
    </div>
  )
}

const MOBILE_ROW_CAP = 12

export function bulkBtnStyle(isMobile: boolean): CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    // The chip consumers carry `.ag-tap`, which is where the 44px finger target lives; the two
    // FULL-WIDTH consumers ask for `minHeight: 44` themselves, because a full-width action is the
    // case that class excludes and should be 44px of paint.
    padding: isMobile ? '6px 12px' : '5px 10px',
    borderRadius: 7, border: '1px solid var(--border)', background: 'transparent',
    color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  }
}

export function EditView({
  targets, draftDenied, diff, search, onSearch, showStale, onToggleStale, showAllMobile, onShowAllMobile,
  isMobile, lang, mode, partialRepoKeys, impactSessions, impactCost, withheldBy, onToggleRow,
  onShareAll, onBlockAll,
}: {
  targets: ShareTarget[]
  draftDenied: Set<string>
  /** The current draft mode — a PARTLY-shared repository means something stricter under an
   *  allowlist (it does not travel as a repository at all), so the row says so in that mode. */
  mode: ShareMode
  /** Repo keys with at least one project switched OFF in the other tab (`partiallyDeniedRepoKeys`).
   *  A row that is itself denied ignores this — it renders in the Blocked group either way. */
  partialRepoKeys: ReadonlySet<string>
  diff: ReturnType<typeof diffDraft>
  search: string
  onSearch: (v: string) => void
  showStale: boolean
  onToggleStale: () => void
  showAllMobile: boolean
  onShowAllMobile: () => void
  isMobile: boolean
  lang: 'pt' | 'en'
  impactSessions: number
  impactCost: number
  /** Row key → the sibling machines that withhold it (`siblingWarnings.ts`). Absent key = nothing
   *  announced about that row, which is NOT the same as "nobody restricts it". */
  withheldBy?: ReadonlyMap<string, WithholdingMachine[]>
  onToggleRow: (target: ShareTarget, nextShared: boolean) => void
  onShareAll: () => void
  onBlockAll: () => void
}) {
  const rows = buildRows(targets, draftDenied)
  const grouped = groupRows(rows, search, keepVisibleKeys(diff))
  const sharedNow = rows.filter(r => r.target.sessions > 0 && !r.denied).length
  const totalNow = rows.filter(r => r.target.sessions > 0).length

  let blocked = grouped.blocked
  let shared = grouped.shared
  if (isMobile && !showAllMobile) {
    const cap = MOBILE_ROW_CAP
    blocked = grouped.blocked.slice(0, cap)
    shared = grouped.shared.slice(0, Math.max(0, cap - blocked.length))
  }
  const shownCount = blocked.length + shared.length
  const totalLiveCount = grouped.blocked.length + grouped.shared.length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="ag-tap" onClick={onShareAll} style={bulkBtnStyle(isMobile)}>{COPY.shareAll[lang]}</button>
        <button type="button" className="ag-tap" onClick={onBlockAll} style={bulkBtnStyle(isMobile)}>{COPY.blockAll[lang]}</button>
        <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginLeft: 'auto' }}>
          {interpolate(plural(PLURAL_COPY.nShared[lang], sharedNow), { n: sharedNow, total: totalNow })}
        </span>
      </div>

      <div style={{ position: 'relative' }}>
        <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }} />
        <input
          value={search}
          onChange={e => onSearch(e.target.value)}
          placeholder={COPY.searchRepos[lang]}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '7px 10px 7px 28px',
            background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7,
            fontSize: 13, color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit',
          }}
        />
      </div>

      <div style={{
        display: 'flex', flexDirection: 'column', gap: 10,
        ...pickerListStyle(isMobile),
      }}>
        {blocked.length > 0 && <RowGroup label={interpolate(COPY.groupBlocked[lang], { n: grouped.blocked.length })} rows={blocked} lang={lang} mode={mode} partialRepoKeys={partialRepoKeys} withheldBy={withheldBy} onToggleRow={onToggleRow} />}
        {shared.length > 0 && <RowGroup label={interpolate(COPY.groupShared[lang], { n: grouped.shared.length })} rows={shared} lang={lang} mode={mode} partialRepoKeys={partialRepoKeys} withheldBy={withheldBy} onToggleRow={onToggleRow} />}
      </div>

      {isMobile && !showAllMobile && shownCount < totalLiveCount && (
        <button type="button" onClick={onShowAllMobile} style={{ ...bulkBtnStyle(true), width: '100%', minHeight: 44 }}>
          {interpolate(COPY.showAllRepos[lang], { n: totalLiveCount })}
        </button>
      )}

      {grouped.stale.length > 0 && (
        <div>
          <button type="button" onClick={onToggleStale} style={{
            display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'none', border: 'none',
            padding: '4px 0', color: 'var(--text-tertiary)', fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit',
          }}>
            {showStale ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {interpolate(plural(PLURAL_COPY.staleGroup[lang], grouped.stale.length), { n: grouped.stale.length })}
          </button>
          {showStale && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{COPY.staleHint[lang]}</span>
              {grouped.stale.map(r => (
                <div key={r.target.key} style={{ fontSize: 12, color: 'var(--text-secondary)', opacity: 0.7 }}>{r.target.name}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {impactSessions > 0 && (
        <div style={{
          padding: '8px 12px', borderRadius: 7, fontSize: 11.5, color: 'var(--text-secondary)',
          background: 'var(--bg-secondary)',
        }}>
          {interpolate(COPY.applyImpact[lang], { sessions: impactSessions, cost: fmtCost(impactCost) })}
        </div>
      )}
    </div>
  )
}

/**
 * The scrolling region the row list lives in.
 *
 * It used to be `maxHeight: 360` on desktop — a constant, inside a drawer panel that is
 * `height: 100%`. The list therefore stopped at 360px no matter how tall the drawer was: the row
 * at the boundary was cut through the middle of its text and the space BELOW the cut stayed empty,
 * so the cut read as the end of the list rather than as more content. Two nested scrollers (the
 * panel and this box) made it worse, because the outer one absorbed the drag.
 *
 * Now it is relative to the viewport and it can shrink: `minHeight: 0` is what lets a flex child
 * scroll instead of pushing its parent open, and `scrollbarGutter: 'stable'` keeps the track
 * reserved so a partially visible row always sits next to a visible scrollbar.
 *
 * Mobile gets NO box at all. The row cap (`MOBILE_ROW_CAP`) plus "show all" already bound the list
 * there, and a nested scroller inside a full-screen drawer is a region a thumb cannot reliably
 * grab — the drawer's own body scrolls instead.
 */
export function pickerListStyle(isMobile: boolean): {
  maxHeight?: string
  overflowY?: 'auto'
  minHeight?: number
  scrollbarGutter?: 'stable'
} {
  if (isMobile) return {}
  return { maxHeight: 'min(48vh, 520px)', overflowY: 'auto', minHeight: 0, scrollbarGutter: 'stable' }
}

/**
 * The hairline between two rows of a group.
 *
 * A row is a name, a sessions/last-active line and sometimes a warning — three lines with no
 * boundary between them and the next row, so the eye could not tell where one item ended. The rule
 * goes on the TOP of every row but the first, so a group never ends in a rule pointing at nothing,
 * and a one-row group draws none at all.
 *
 * `--border-subtle` on purpose: the group headings (BLOCKED / SHARED) are what divide the list into
 * sections, and a rule as strong as those would compete with them instead of subdividing them.
 */
export function rowDivider(index: number, total: number): { borderTop?: string; paddingTop?: number } {
  if (index === 0 || total <= 1) return {}
  return { borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }
}

/** The row's full identity, kept reachable after the host pill was dropped from the face of it.
 *  `name` is `org/repo`, which two different hosts can both carry — the title is where that stays
 *  distinguishable. The no-repository bucket has no key worth showing. */
export function rowTitle(t: { kind: string; key: string; name: string }): string {
  return t.kind === 'none' ? t.name : t.key
}

function RowGroup({ label, rows, lang, mode, partialRepoKeys, withheldBy, onToggleRow }: {
  label: string
  rows: EffectiveRow[]
  lang: 'pt' | 'en'
  mode: ShareMode
  partialRepoKeys: ReadonlySet<string>
  withheldBy?: ReadonlyMap<string, WithholdingMachine[]>
  onToggleRow: (target: ShareTarget, nextShared: boolean) => void
}) {
  const pt = lang === 'pt'
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '0.05em', textTransform: 'uppercase', margin: '2px 0 2px' }}>
        {label}
      </div>
      {rows.map((r, i) => {
        const t = r.target
        const partial = !r.denied && partialRepoKeys.has(t.key)
        // A locked row in the unattributed bucket gets its OWN sentence: `mixedRepoWarn` describes
        // a folder holding more than one repository, which is not why this one is locked.
        const sub = r.locked && t.kind === 'none'
          ? COPY.lockedNoRepoWarn[lang]
          : r.locked
            ? COPY.mixedRepoWarn[lang]
          : partial
            ? (mode === 'allowlist' ? COPY.repoPartialAllowSub[lang] : COPY.repoPartialSub[lang])
            : t.kind === 'none'
              ? COPY.noRepoSub[lang]
              : `${interpolate(plural(PLURAL_COPY.sessionsN[lang], t.sessions), { n: t.sessions })}${t.lastActive ? ` · ${interpolate(COPY.lastActiveT[lang], { t: relTime(t.lastActive, pt) })}` : ''}`
        return (
          // `flexWrap: 'wrap'` — the row div is a block-level flex container (width = its parent's,
          // not shrink-to-fit), and `RowSwitch`'s button already claims the full row via its own
          // `width: '100%'`. Without wrap, a host badge next to a very long repo name (the >=60
          // char remote the mobile gate exercises) has nowhere to go but past the row's right edge —
          // `overflow-x: clip` on `#root` then hides it entirely rather than causing a real
          // horizontal scrollbar, so the badge silently vanishes instead of wrapping onto its own
          // line beneath the switch.
          <div
            key={t.key}
            title={rowTitle(t)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
              ...rowDivider(i, rows.length),
            }}
          >
            <RowSwitch
              on={!r.denied}
              onToggle={() => onToggleRow(t, r.denied)}
              label={t.name}
              sub={sub}
              icon={<GitBranch size={13} />}
              disabled={r.locked}
              dimmed={r.denied}
            />
            <WithheldBadge machines={withheldBy?.get(t.key)} lang={lang} dimension="repo" />
          </div>
        )
      })}
    </div>
  )
}

// --- Task 6: the Projects tab body — same shape as EditView above, over the project dimension ---

export function ProjectEditView({
  targets, draftDenied, draftRepoKeys, diff, search, onSearch, showStale, onToggleStale, showAllMobile, onShowAllMobile,
  isMobile, lang, withheldBy, onToggleRow, onShareAll, onBlockAll,
}: {
  targets: ProjectTarget[]
  draftDenied: Set<string>
  /** The REPO tab's live draft — a project locks the instant its repo is in this set (Task 6),
   *  never from `targets`' own `.locked` (which is baked from the STORED rules at build time). */
  draftRepoKeys: ReadonlySet<string>
  diff: ReturnType<typeof diffDraft>
  search: string
  onSearch: (v: string) => void
  showStale: boolean
  onToggleStale: () => void
  showAllMobile: boolean
  onShowAllMobile: () => void
  isMobile: boolean
  lang: 'pt' | 'en'
  /** Row key → the sibling machines that withhold it. Same contract as `EditView`'s. */
  withheldBy?: ReadonlyMap<string, WithholdingMachine[]>
  onToggleRow: (target: ProjectTarget, nextShared: boolean) => void
  onShareAll: () => void
  onBlockAll: () => void
}) {
  const rows = buildProjectRows(targets, draftDenied, draftRepoKeys)
  const grouped = groupProjectRows(rows, search, keepVisibleKeys(diff))
  const sharedNow = rows.filter(r => r.target.sessions > 0 && !r.denied).length
  const totalNow = rows.filter(r => r.target.sessions > 0).length

  let blocked = grouped.blocked
  let shared = grouped.shared
  if (isMobile && !showAllMobile) {
    const cap = MOBILE_ROW_CAP
    blocked = grouped.blocked.slice(0, cap)
    shared = grouped.shared.slice(0, Math.max(0, cap - blocked.length))
  }
  const shownCount = blocked.length + shared.length
  const totalLiveCount = grouped.blocked.length + grouped.shared.length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className="ag-tap" onClick={onShareAll} style={bulkBtnStyle(isMobile)}>{COPY.shareAll[lang]}</button>
        <button type="button" className="ag-tap" onClick={onBlockAll} style={bulkBtnStyle(isMobile)}>{COPY.blockAll[lang]}</button>
        <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginLeft: 'auto' }}>
          {interpolate(plural(PLURAL_COPY.nShared[lang], sharedNow), { n: sharedNow, total: totalNow })}
        </span>
      </div>

      <div style={{ position: 'relative' }}>
        <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }} />
        <input
          value={search}
          onChange={e => onSearch(e.target.value)}
          placeholder={COPY.searchProjects[lang]}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '7px 10px 7px 28px',
            background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7,
            fontSize: 13, color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit',
          }}
        />
      </div>

      <div style={{
        display: 'flex', flexDirection: 'column', gap: 10,
        ...pickerListStyle(isMobile),
      }}>
        {blocked.length > 0 && <ProjectRowGroup label={interpolate(COPY.groupBlocked[lang], { n: grouped.blocked.length })} rows={blocked} lang={lang} withheldBy={withheldBy} onToggleRow={onToggleRow} />}
        {shared.length > 0 && <ProjectRowGroup label={interpolate(COPY.groupShared[lang], { n: grouped.shared.length })} rows={shared} lang={lang} withheldBy={withheldBy} onToggleRow={onToggleRow} />}
      </div>

      {isMobile && !showAllMobile && shownCount < totalLiveCount && (
        <button type="button" onClick={onShowAllMobile} style={{ ...bulkBtnStyle(true), width: '100%', minHeight: 44 }}>
          {interpolate(COPY.showAllRepos[lang], { n: totalLiveCount })}
        </button>
      )}

      {grouped.stale.length > 0 && (
        <div>
          <button type="button" onClick={onToggleStale} style={{
            display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'none', border: 'none',
            padding: '4px 0', color: 'var(--text-tertiary)', fontSize: 11.5, cursor: 'pointer', fontFamily: 'inherit',
          }}>
            {showStale ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {interpolate(plural(PLURAL_COPY.staleGroup[lang], grouped.stale.length), { n: grouped.stale.length })}
          </button>
          {showStale && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{COPY.staleHint[lang]}</span>
              {grouped.stale.map(r => (
                <div key={r.target.key} style={{ fontSize: 12, color: 'var(--text-secondary)', opacity: 0.7 }}>{r.target.name}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ProjectRowGroup({ label, rows, lang, withheldBy, onToggleRow }: {
  label: string
  rows: EffectiveProjectRow[]
  lang: 'pt' | 'en'
  withheldBy?: ReadonlyMap<string, WithholdingMachine[]>
  onToggleRow: (target: ProjectTarget, nextShared: boolean) => void
}) {
  const pt = lang === 'pt'
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '0.05em', textTransform: 'uppercase', margin: '2px 0 2px' }}>
        {label}
      </div>
      {rows.map((r, i) => {
        const t = r.target
        // `repoKey` is '' for a project in the unattributed bucket, and those rows became lockable
        // when the bucket itself did — so `lockedByRepo` would render "Blocked by repository "
        // with a dangling empty name. That bucket has its own sentence, which says why it cannot
        // be split rather than naming a repository that does not exist.
        const sub = r.locked
          ? (t.repoKey
              ? interpolate(COPY.lockedByRepo[lang], { repo: t.repoKey })
              : COPY.lockedNoRepoWarn[lang])
          : `${interpolate(plural(PLURAL_COPY.sessionsN[lang], t.sessions), { n: t.sessions })}${t.lastActive ? ` · ${interpolate(COPY.lastActiveT[lang], { t: relTime(t.lastActive, pt) })}` : ''}`
        return (
          <div
            key={t.key}
            title={t.key}
            style={{
              display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
              ...rowDivider(i, rows.length),
            }}
          >
            <RowSwitch
              on={!r.denied}
              onToggle={() => onToggleRow(t, r.denied)}
              label={t.name}
              sub={sub}
              icon={<Folder size={13} />}
              disabled={r.locked}
              dimmed={r.denied}
            />
            <WithheldBadge machines={withheldBy?.get(t.key)} lang={lang} dimension="project" />
          </div>
        )
      })}
    </div>
  )
}
