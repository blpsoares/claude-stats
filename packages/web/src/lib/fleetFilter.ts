/**
 * fleetFilter.ts — PURE. Applying the dashboard's global filters to the LIVE fleet.
 *
 * The filters were built to scope METRICS — a date range, a set of projects, a set of models. A
 * fleet is not metrics: it is what is running now. So only the dimensions that mean something about
 * a live session are applied, and the rest are ignored ON PURPOSE:
 *
 * - `dateRange` / `customStart` / `customEnd` — a live session is happening now, and "last 7 days"
 *   would silently hide a session that started eight days ago and is still working.
 * - `users` / `teams` / `machines` / `presence` — every row here is on THIS machine by definition;
 *   the fleet route is refused on a central.
 * - `tags` — a tag resolves to a set of stored sessions server-side, and a live row is not in that
 *   set until its metrics are written.
 *
 * What IS applied: harness, project, repository, model — each a fact the row carries itself.
 *
 * `activeOnly` is the fleet's OWN dimension and lives here rather than in `Filters`, because the
 * dashboard has no use for it: it is a statement about what a session is doing right now.
 *
 * `withheld` is returned alongside, because a filter that narrows silently is one people conclude
 * is broken when the list looks short — and on this surface a hidden row can be a session waiting
 * for a person.
 */

import type { Filters } from '@agentistics/core'
import { repoShortName } from '@agentistics/core'
import { ACTIVE_STATES, type ControlSession } from '@agentistics/tui/control/session-fleet'

const ACTIVE = new Set<string>(ACTIVE_STATES)

export interface FleetFilterResult {
  rows: ControlSession[]
  /** How many rows the filters removed, so the surface can say what lifting them would show. */
  withheld: number
  /** True when any filter is doing something — the switch that says "you are not seeing all of it". */
  narrowed: boolean
}

export interface FleetFilterInput {
  rows: readonly ControlSession[]
  filters: Filters
  /** Keep only what is running. The fleet's own dimension; see the header. */
  activeOnly: boolean
}

export function filterFleet({ rows, filters, activeOnly }: FleetFilterInput): FleetFilterResult {
  const harnesses = new Set<string>(filters.harnesses ?? (filters.harness ? [filters.harness] : []))
  const projects = new Set(filters.projects ?? [])
  const repos = new Set(filters.repos ?? [])
  const models = new Set(filters.models ?? [])

  const kept = rows.filter(r => {
    if (activeOnly && !ACTIVE.has(r.state)) return false
    if (harnesses.size > 0 && !harnesses.has(r.harness)) return false
    // The project filter names PATHS; a row carries its own project name and its group. Matched
    // against both, because the dashboard's chips are built from stored session paths while the
    // fleet's rows are named by the directory they were spawned in.
    if (projects.size > 0 && !matchesProject(r, projects)) return false
    if (repos.size > 0 && !matchesRepo(r, repos)) return false
    // A row with no model recorded is not "some other model" — it is unknown, and a model filter
    // cannot say anything about it either way, so it is withheld like any non-match.
    if (models.size > 0 && !(r.model !== undefined && models.has(r.model))) return false
    return true
  })

  return {
    rows: kept,
    withheld: rows.length - kept.length,
    narrowed: activeOnly || harnesses.size > 0 || projects.size > 0 || repos.size > 0 || models.size > 0,
  }
}

/**
 * A row matches a repository filter by EITHER key shape.
 *
 * The two sides speak different vocabularies and always did: the dashboard's chips are canonical
 * remote keys (`github.com/blpsoares/agentistics`, from `normalizeGitRemote`), while a fleet row
 * carries the SHORT name the cockpit prints (`blpsoares/agentistics`). `repos.has(r.repo)` could
 * therefore never be true, so filtering the session list by repository returned an empty list every
 * single time — reported as "filtering by repo isn't working", and it was not working at all.
 *
 * Matched in both directions rather than by rewriting one side: the canonical key is what every
 * stored session and every other filter is keyed on and must not be weakened, and the fleet's short
 * name is what the row can produce without a git call. `repoShortName` is the existing conversion
 * between them — there is no second normalisation invented here.
 */
function matchesRepo(r: ControlSession, repos: ReadonlySet<string>): boolean {
  if (r.repo === undefined || r.repo === '') return false
  if (repos.has(r.repo)) return true
  for (const key of repos) if (repoShortName(key) === r.repo) return true
  return false
}

/** A row matches a project filter by its own name, its group, or the tail of its path. */
function matchesProject(r: ControlSession, projects: ReadonlySet<string>): boolean {
  if (r.project !== '' && projects.has(r.project)) return true
  if (r.projectGroup !== undefined && projects.has(r.projectGroup)) return true
  // The dashboard's chips are full paths; a row's `cwd` is one. Exact, never a prefix — a prefix
  // test would let a filter on `$HOME` match every session on the machine.
  if (projects.has(r.cwd)) return true
  return false
}

/**
 * The dimensions that are SET and that this fleet cannot answer, in one sentence.
 *
 * The module's header records why each is ignored, and none of that changes. What changes is that
 * it is now SAID: a filter that appears to apply and does not is indistinguishable from one that
 * is broken, and every ignored dimension here was reported as exactly that at least once.
 *
 * `dateRange: 'all'` is not a filter, so it raises nothing.
 */
export function ignoredDimensions(filters: Filters, lang: 'en' | 'pt'): string | null {
  const pt = lang === 'pt'
  const named: string[] = []
  if (filters.dateRange && filters.dateRange !== 'all') named.push(pt ? 'o período' : 'the date range')
  if ((filters.tags?.length ?? 0) > 0) named.push(pt ? 'as tags' : 'tags')
  if ((filters.users?.length ?? 0) > 0) named.push(pt ? 'os membros' : 'members')
  if ((filters.teams?.length ?? 0) > 0) named.push(pt ? 'os times' : 'teams')
  if ((filters.machines?.length ?? 0) > 0) named.push(pt ? 'as máquinas' : 'machines')
  if (named.length === 0) return null
  const list = named.length === 1
    ? named[0]!
    : `${named.slice(0, -1).join(', ')} ${pt ? 'e' : 'and'} ${named[named.length - 1]}`
  return pt
    ? `${list.charAt(0).toUpperCase()}${list.slice(1)} não estreita uma frota viva.`
    : `${list.charAt(0).toUpperCase()}${list.slice(1)} does not narrow a live fleet.`
}

/**
 * The values this fleet can actually be filtered BY.
 *
 * The Sessions workspace used to hand its filter bar the DASHBOARD's options — every harness, repo,
 * project and model that appears anywhere in the stored metrics. But the list being filtered is the
 * FLEET: what runs on this machine now, plus the conversations it can reopen. Those are different
 * universes, and the gap is not small — on a real machine the metrics knew six harnesses while the
 * fleet held three.
 *
 * So the bar offered "antigravity", and picking it emptied the list. Nothing was broken: there
 * genuinely were no antigravity rows to keep. But a filter that offers a value it can only ever
 * answer "nothing" to is indistinguishable from one that is failing, and it was reported as exactly
 * that. An option is a promise that something might be behind it.
 *
 * Derived from the rows themselves, so the promise is always true. Repos are reported in BOTH
 * shapes for the same reason `matchesRepo` accepts both: the chip the user clicks may have come
 * from either vocabulary.
 */
/**
 * THE DIMENSIONS THE SESSIONS WORKSPACE CAN ACT ON — the `only` list its filter bar is given.
 *
 * It lives here, beside `filterFleet`, because the two must agree: a dimension this module HONOURS
 * and the menu does not OFFER is a filter nobody can reach, and a dimension the menu offers and
 * this module ignores is a control that does nothing. `fleetFilter.test.ts` cross-checks them.
 *
 * `activeOnly` was missing, and the way it failed is the argument for pinning it: the switch is
 * ALSO drawn as a chip while it is on, so it could be turned OFF from the chip's × and then never
 * turned back on — the menu entry that would have done it was gated out by this very list. A
 * one-way switch reads as the filter having broken.
 */
export const SESSION_FILTER_DIMS = ['activeOnly', 'harnesses', 'repos', 'projects', 'models'] as const

export function fleetFilterOptions(
  rows: readonly ControlSession[],
  /**
   * The fleet's own "only what is running" switch, applied BEFORE the options are collected.
   *
   * Without it the promise breaks one layer deeper, and it did: with the switch on — which is how
   * this workspace opens — the bar still offered every harness in the whole fleet, including two
   * whose rows were all `closed`. Picking one emptied the list again, for the same reason and with
   * the same "the filter is broken" reading. Measured on this machine: codex and copilot each had
   * exactly one row, both closed.
   *
   * An option has to promise what the CURRENT view can show, not what the fleet contains in the
   * abstract. Turning the switch off brings those harnesses back by itself, because the options
   * are re-derived from the rows it stops withholding.
   */
  activeOnly = false,
): {
  /** Values the CURRENT view can show — every one of them promises at least one row. */
  harnesses: string[]
  repos: string[]
  projects: string[]
  models: string[]
  /**
   * Every value the WHOLE fleet holds, `activeOnly` ignored.
   *
   * Withholding an option that promises nothing was right; letting the DIMENSION disappear with it
   * was not, and the difference was reported. On a machine with six assistants in its history and
   * one of them running, the harness filter vanished from the menu entirely — so the workspace
   * looked like it had never heard of the other five, while the Compare page listed all six with
   * real session counts two clicks away. That is the same false impression the narrowing rule
   * exists to prevent, produced by the rule itself.
   *
   * So the caller offers THESE and marks the ones the current view cannot show. The reader sees
   * their assistants exist, and the ones that would answer "nothing" say why instead of being
   * silently absent.
   */
  harnessesAll: string[]
  reposAll: string[]
  projectsAll: string[]
  modelsAll: string[]
} {
  const harnesses = new Set<string>()
  const repos = new Set<string>()
  const projects = new Set<string>()
  const models = new Set<string>()
  const harnessesAll = new Set<string>()
  const reposAll = new Set<string>()
  const projectsAll = new Set<string>()
  const modelsAll = new Set<string>()
  for (const r of rows) {
    if (r.harness) harnessesAll.add(r.harness)
    if (r.repo) reposAll.add(r.repo)
    if (r.project) projectsAll.add(r.project)
    if (r.model) modelsAll.add(r.model)
    if (activeOnly && !ACTIVE.has(r.state)) continue
    if (r.harness) harnesses.add(r.harness)
    if (r.repo) repos.add(r.repo)
    if (r.project) projects.add(r.project)
    if (r.model) models.add(r.model)
  }
  const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b))
  return {
    harnesses: sorted(harnesses), repos: sorted(repos), projects: sorted(projects), models: sorted(models),
    harnessesAll: sorted(harnessesAll), reposAll: sorted(reposAll),
    projectsAll: sorted(projectsAll), modelsAll: sorted(modelsAll),
  }
}
