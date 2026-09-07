import type { BillingReadiness, BillingSettings, CostBasis, MonthlyCommitment, SavedComparison, Filters, Lang, Theme, SessionMeta, AppData, StatsCache, HarnessId, Project } from '@agentistics/core'
import type { useDerivedStats } from '../hooks/useData'
import type { PlanBasisView } from '../hooks/usePlanBasis'
import type { A11yState } from '../hooks/useAccessibility'
import type { TagDef } from './tagMatch'
import type { ChatModelId } from './chatModels'
import type { CardId } from './cardOrder'

type DerivedStats = NonNullable<ReturnType<typeof useDerivedStats>>

export interface InfoItem {
  label: string
  source: string
  formula: string
  note?: string
}

/** The `beforeinstallprompt` event, captured in App and threaded to the Install settings page. */
export type PwaPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }

/** The logged-in IAM account (role + team memberships), threaded from App.tsx `iam.account`.
 *  Structurally matches `IamAccount` in App.tsx; kept inline here to avoid importing App into a lib. */
export interface Principal {
  id: string
  name: string
  email: string
  role: 'owner' | 'member'
  memberships: { teamId: string; role: 'manager' | 'user' }[]
  /** Forces a blocking first-login password change when true (B4-EXT). */
  mustChangePassword: boolean
}

/** Draft shape for the Preferences settings page / modal (single source of truth).
 *
 *  Chat's sound/model preferences moved to the Chat settings section (ChatSettings.tsx), which
 *  reads and writes them directly via /api/preferences — the same pattern it already used for
 *  `chatEnabled` — so they are deliberately NOT part of this draft. Carrying them here would mean
 *  Preferences' Save button could silently overwrite whatever Chat's own controls just set. */
export interface PrefsDraft {
  lang: Lang
  theme: Theme
  currency: 'USD' | 'BRL'
  cardOrder: string[]
  cardPrecision: Record<string, boolean>
}

export interface AppContext {
  // data
  data: AppData
  derived: DerivedStats
  statsCache: StatsCache

  // filters
  filters: Filters
  setFilters: React.Dispatch<React.SetStateAction<Filters>>
  /** The fleet's own "only what is running" switch — see `FiltersBar`'s `onActiveOnlyChange` doc
   *  comment. Lives here (not in `Filters`) so the Sessions workspace's mobile FiltersBar can read
   *  and write the SAME state the desktop shared header already does, computed once in App.tsx. */
  activeOnly: boolean
  setActiveOnly: (v: boolean) => void
  /** The SAME memoized values the desktop header's `FiltersBar` already gets — computed once in
   *  App.tsx from `data`/`filters`, so the mobile Sessions workspace's own `FiltersBar` can reuse
   *  them verbatim instead of re-deriving (and risking disagreeing with) the same filter options.
   *  `sessionCountByProject`/`models` are declared further down already — this only adds the two
   *  the dashboard's own context never needed. */
  availableProjects: Project[]
  availableHarnesses: HarnessId[]

  // preferences
  lang: Lang
  theme: Theme
  currency: 'USD' | 'BRL'
  setCurrency: (c: 'USD' | 'BRL') => void
  brlRate: number

  /** How this machine is actually billed — the timeline the plan cost basis is computed from.
   *  Local only; it never travels to a central, and on a central it is always empty. */
  billing: BillingSettings
  /** Saved comparisons, and which are pinned to Home. */
  comparisons: SavedComparison[]
  saveComparisons: (next: SavedComparison[]) => Promise<void>
  /** Persists the COMPLETE settings object. `writePreferencesTo` merges shallowly, so a partial
   *  save would replace the whole timeline with the fragment. */
  saveBilling: (next: BillingSettings) => Promise<void>

  /** Which basis every cost figure is expressed in. Plumbed exactly like `currency`.
   *  Always `'api'` on a central, which cannot price a fleet from one operator's timeline. */
  costBasis: CostBasis
  /** Switch the basis. Refuses `'plan'` when it cannot be computed — the control is DISABLED in
   *  that case and opens the setup prompt instead, so this is the second gate, not the only one. */
  setCostBasis: (b: CostBasis) => void
  /** The plan cost for the CURRENT filter, computed once for the whole app so every surface tells
   *  the same story. `basis === null` means the plan basis is not available. */
  planBasis: PlanBasisView
  /** Whether the plan basis may be offered at all, and what is missing when it may not. */
  billingReady: BillingReadiness
  /** Opens the billing setup prompt — what the DISABLED basis control does when pressed, so it
   *  says what it needs instead of doing nothing. */
  openBillingSetup: () => void
  /** What the registered plans commit to for the CURRENT calendar month — a fixed figure, and a
   *  different question from the filter-window plan cost. `null` when nothing is registered. */
  monthCommitment: MonthlyCommitment | null

  // chat preferences — live values consumed by the chat widget (TtyChat). Set from the Chat
  // settings section (ChatSettings.tsx), which persists them itself via PUT /api/preferences and
  // calls these setters so the live widget picks up the change without a reload — the same thing
  // `savePreferences` used to do for them when they still lived in the Preferences draft.
  chatModel: ChatModelId | null
  setChatModel: (m: ChatModelId) => void
  chatSoundEnabled: boolean
  setChatSoundEnabled: (v: boolean) => void
  chatSoundId: string
  setChatSoundId: (id: string) => void

  /** Persists a full preferences draft: applies it to global state + PUTs /api/preferences.
   *  Reuses the same logic the old Settings modal ran on Save. */
  savePreferences: (draft: PrefsDraft) => void

  // PWA install (captured in App from the beforeinstallprompt event)
  pwaPrompt: PwaPrompt | null
  onPwaInstalled: () => void

  // live-update settings (applied immediately — threaded to the Live settings page)
  liveUpdates: boolean
  setLiveUpdates: (v: boolean) => void
  updateInterval: number
  setUpdateInterval: (v: number) => void
  riskyMode: boolean
  setRiskyMode: (v: boolean) => void
  highlightUpdates: boolean
  setHighlightUpdates: (v: boolean) => void

  // budget
  monthlyBudgetUSD: number | null
  updateBudget: (v: number | null) => void

  // derived totals
  totalInputTokens: number
  totalOutputTokens: number

  // modal setters
  setExpandedChart: (id: string | null) => void
  setSelectedSession: (s: SessionMeta | null) => void
  setInfoModalIndex: (i: number | null) => void

  // info items for KPI cards
  infoItems: InfoItem[]

  // card order for home page (managed via preferences)
  cardOrder: CardId[]
  setCardOrder: React.Dispatch<React.SetStateAction<CardId[]>>

  // per-card full precision toggle
  cardPrecision: Record<string, boolean>
  setCardPrecision: (id: string, v: boolean) => void

  // filter bar data (needed to render FiltersBar outside the header, e.g. in CustomPage)
  sessionCountByProject: Record<string, number>
  models: string[]
  modelGroups: { harness: HarnessId; models: string[] }[]
  modelsInProject: Set<string> | null
  /** Distinct users present in the data (team mode). Empty in Solo mode. */
  users: string[]
  /** Harnesses present in the data. Empty in Solo mode (Claude-only). */
  harnesses: HarnessId[]
  /** True when this instance is running as a team-mode central (aggregator). */
  isCentral: boolean
  /** The logged-in IAM account (role + memberships). Undefined when IAM is not active. */
  me?: Principal
  /** Central-only: available teams for filter. Empty when not a central or no teams. */
  teams: { id: string; name: string }[]
  /** Central-only: available machines for filter. Empty when not a central or no machines. */
  machines: { id: string; name: string; user: string; teamId?: string; teamIds?: string[] }[]

  /** Local host-power capabilities the server still grants (`server/exposure.ts`'s `CAPS`, as
   *  reported by `/api/team/session`). Undefined while `teamSession` has not loaded yet — treat
   *  the same as "granted", the same reading `App.tsx` already uses for an older server. */
  capabilities?: {
    localShell?: boolean
    localChat?: boolean
    localTranscripts?: boolean
    mcpAdmin?: boolean
  }

  /** The tag definitions `useDerivedStats` resolves a tag filter against.
   *
   *  Exposed because a page that derives a SECOND scope (the compare page's B side) must pass the
   *  same array to its own `useDerivedStats` call. Omitting it takes the `tags: TagDef[] = []`
   *  default, whose fresh array identity kills the memo on every render — a full dashboard
   *  recompute per keystroke, and two sides that can tear apart mid-edit. */
  tags: TagDef[]

  /** Task 13 — the hidden-repo badge: canonical repo key (or `NO_REPO_KEY`) → the labels of every
   *  connection currently hiding it (`lib/shareRepos.ts`'s `buildDeniedRepoLabels`). OPTIONAL
   *  (never a plain default) because `AppContext` is consumed by every page in the app — a new
   *  required field would break every existing consumer/mock at once. Absent/undefined must be
   *  treated exactly like an empty map (no hidden-repo badges), never as "not yet loaded" vs.
   *  "definitely nothing hidden" — there is no meaningful distinction a badge needs to draw here. */
  deniedRepoLabels?: Map<string, string[]>
  /** Re-reads the connection list and rebuilds `deniedRepoLabels`. Called by `ConnectionsPanel`
   *  after every write (connect / rules apply / rename / disconnect) so the hidden-repo badge can
   *  never keep claiming "Hidden from N centrals" after the rule is gone. OPTIONAL for the same
   *  reason `deniedRepoLabels` is — every page consumes `AppContext`. */
  refreshDeniedRepoLabels?: () => void

  /** Magnifier lenses — the accessibility feature. Always present; `prefs.enabled` is the switch. */
  a11y: A11yState
}
