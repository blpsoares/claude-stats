/**
 * projectKind.ts — PURE: what KIND of place a session-start candidate is, and how many of each to
 * offer.
 *
 * The wizard's "where" search offers three different kinds of thing in one list and said so only
 * with an icon. Reported as exactly that: no clear division between what is a git repository and
 * what is a project.
 *
 * ## The three kinds, most specific first
 *
 * - `repo` — the directory IS a git repository. Either the store recorded a remote for it, or the
 *   home walk found a `.git`. This is the strongest thing that can be known about a directory.
 * - `project` — no git, but sessions have RUN here. It is a place someone works.
 * - `folder` — neither: a directory the walk found, a path typed in full, a cwd with no history.
 *
 * They are MUTUALLY EXCLUSIVE, and that is the point of the report. A repository you have worked in
 * is a repository — putting it under both tabs would make the two tabs answer the same question and
 * leave "what is a repo and what is a project" exactly as unclear as it was.
 *
 * ## Why the limit is PER KIND
 *
 * The search returns its best N overall, and on a real machine that is dominated by plain folders:
 * measured, `portif` returned twenty rows of which FIFTEEN were folders with no git and no history,
 * and three were the repositories the person was looking for. A global cap applied after ranking
 * means a directory named like the one you want can push the one you want off the list entirely —
 * "the search does not bring the right items", which is how it was reported.
 *
 * Per-kind is also what makes the tabs honest: a tab can only be empty because there is nothing of
 * that kind matching, never because a different kind used up the budget.
 */

/** The three kinds. `PROJECT_KIND_ORDER` is the order they are offered in. */
export type ProjectKind = 'repo' | 'project' | 'folder'

export const PROJECT_KIND_ORDER: ProjectKind[] = ['repo', 'project', 'folder']

/**
 * What a candidate carries that decides its kind.
 *
 * `remote` is `''` when nothing recorded one — which is NOT the same as "not a repository", because
 * the home walk finds a `.git` without ever reading its remote. That is why `source` is read too.
 */
export interface ProjectKindInput {
  /** `cwd` | `history` | `repo` | `folder` | `typed`, as `project-search.ts` defines them. */
  source: string
  /** Normalised remote, or the short `org/repo`, or `''` when none is known. */
  remote?: string | undefined
}

export function projectKind(c: ProjectKindInput): ProjectKind {
  // A remote is proof. `source: 'repo'` is the walk saying it saw a `.git` and never looked further
  // — also proof, and the only evidence a freshly cloned repository has.
  if ((c.remote ?? '') !== '' || c.source === 'repo') return 'repo'
  // Sessions have run here. Not a repository, but a place someone works.
  if (c.source === 'history') return 'project'
  return 'folder'
}

/**
 * Keep at most `perKind` of each kind, in the order they were ranked.
 *
 * The input must ALREADY be ranked — this only caps, and never reorders. That split is deliberate:
 * ranking is `searchCandidates`' job and it is the part that had to stay untouched, because the
 * ordering rules there are the ones that make the list usable at all.
 *
 * `perKind <= 0` keeps nothing, rather than everything: a caller that means "no limit" says so by
 * not calling this.
 */
export function takePerKind<T>(
  ranked: readonly T[], kindOf: (item: T) => ProjectKind, perKind: number,
): T[] {
  if (perKind <= 0) return []
  const seen: Record<ProjectKind, number> = { repo: 0, project: 0, folder: 0 }
  const out: T[] = []
  for (const item of ranked) {
    const k = kindOf(item)
    if (seen[k] >= perKind) continue
    seen[k] += 1
    out.push(item)
  }
  return out
}

/**
 * How many of each kind MATCHED — the number the tabs must carry.
 *
 * Counted BEFORE `takePerKind`, and that is the whole reason it exists: the wizard's tabs read
 * `Repositories 12 · Projects 12 · Folders 12` on a machine with twenty repositories, because they
 * were counting the rows they had been given and the cap is 12. A cap presented as a count is a
 * number that can never be anything but the cap — it says nothing, and it says it confidently.
 *
 * Same `kindOf` the cap is applied with, so a row can never be counted under one kind and budgeted
 * under another.
 */
export function countPerKind<T>(
  ranked: readonly T[], kindOf: (item: T) => ProjectKind,
): Record<ProjectKind, number> {
  const out: Record<ProjectKind, number> = { repo: 0, project: 0, folder: 0 }
  for (const item of ranked) out[kindOf(item)] += 1
  return out
}

/** How many of each kind the wizard offers. Enough to scroll, few enough to read. */
export const PROJECTS_PER_KIND = 12
