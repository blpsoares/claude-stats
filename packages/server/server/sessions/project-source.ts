/**
 * project-source.ts — where the wizard's candidates come from.
 *
 * THREE sources, merged, in descending order of how much we know about them:
 *
 *  1. **History** — the local consolidate store. Places you have actually worked, so they can be
 *     ranked by recency and carry their repository.
 *  2. **The home directory, walked** — because any folder should be startable. Limiting the wizard
 *     to places with history made it useless for the most ordinary case there is: a repository
 *     cloned five minutes ago.
 *  3. **A path typed in full** — the escape hatch for anywhere else on the machine, including
 *     outside `$HOME`.
 *
 * All three are read from disk directly rather than through the API, for the same reason
 * `conversations.ts` is: the control center must work with the server stopped, which is exactly the
 * state a user is in when they open it to start something.
 */

import { homedir } from 'node:os'
import { PROJECTS_PER_KIND, projectKind, takePerKind } from '@agentistics/core'
import { loadConsolidated } from '../consolidate'
import { isDirectory, scanDirectories } from './dir-scan'
import {
  buildCandidates, searchCandidates, withFixedCandidates, type ProjectCandidate,
} from './project-search'

/** Long enough that reopening the wizard is instant, short enough that a repo cloned a minute ago
 *  shows up without restarting the control center. */
const CACHE_TTL_MS = 60_000

let cache: { at: number; candidates: ProjectCandidate[] } | null = null

async function allCandidates(): Promise<ProjectCandidate[]> {
  const now = Date.now()
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.candidates

  const [history, scanned] = await Promise.all([
    loadConsolidated()
      .then(m => buildCandidates([...m.values()]))
      // A store that cannot be read is a wizard with no history, never one that fails to open.
      .catch(() => [] as ProjectCandidate[]),
    scanDirectories().catch(() => []),
  ])

  // History WINS on a path both know about: it carries the repository and the recency, and the walk
  // knows only that the directory exists. `withFixedCandidates` keeps the richer entry and lets the
  // other one say why it is there — here the walk says nothing history has not already said better.
  const walked: ProjectCandidate[] = scanned.map(d => ({
    path: d.path,
    name: d.name,
    remote: '',
    lastSeenMs: 0,
    sessions: 0,
    source: d.repo ? 'repo' : 'folder',
  }))

  const byPath = new Map<string, ProjectCandidate>()
  for (const c of walked) byPath.set(c.path, c)
  for (const c of history) byPath.set(c.path, c)

  const candidates = [...byPath.values()]
  cache = { at: now, candidates }
  return candidates
}

/** Drop the index, so a directory created seconds ago is findable without waiting out the TTL. */
export function forgetProjects(): void {
  cache = null
}

/**
 * The places worth offering for `query`, best first.
 *
 * `cwd` is always a candidate, with or without history — starting where you already are is the
 * single most common thing anyone wants, and routing that through a search would bury it.
 */
export async function findProjects(
  query: string, cwd: string, perKind = PROJECTS_PER_KIND,
): Promise<ProjectCandidate[]> {
  const known = await allCandidates()

  const fixed: ProjectCandidate[] = [{
    path: cwd,
    name: baseName(cwd),
    remote: '',
    lastSeenMs: 0,
    sessions: 0,
    source: 'cwd',
  }]

  // A typed path that exists but is nowhere in the index — outside `$HOME`, or deeper than the walk
  // goes. Checked only when it LOOKS like a path, so an ordinary word never costs a stat.
  const typed = query.trim()
  if (typed.startsWith('/') || typed.startsWith('~')) {
    const path = typed.startsWith('~') ? typed.replace(/^~/, homedir()) : typed
    if (!known.some(c => c.path === path) && await isDirectory(path)) {
      fixed.push({ path, name: baseName(path), remote: '', lastSeenMs: 0, sessions: 0, source: 'typed' })
    }
  }

  /**
   * RANKED IN FULL, then capped PER KIND — never a global cap after ranking.
   *
   * Measured on a real machine: `portif` ranked twenty rows of which fifteen were plain folders
   * with no git and no history, and the three repositories the person was looking for were what
   * the cap was spending its budget on. A directory named like the one you want must not be able
   * to push the one you want off the list. See `takePerKind`.
   */
  const ranked = searchCandidates(withFixedCandidates(known, fixed), query, Number.MAX_SAFE_INTEGER)
  return takePerKind(ranked, c => projectKind(c), perKind)
}

function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] ?? path
}
