/**
 * task-evidence.ts — what an attempt produced, attached to the moment someone said it was done.
 *
 * The MARKER is a decision and the EVIDENCE is a measurement, and neither is derived from the
 * other. A commit is not a delivery (a branch full of them can still be abandoned) and a delivery
 * with no commit is still a delivery (a spike, a review, a piece of work that ended in a decision).
 *
 * The evidence exists because in a comparison two attempts both marked "delivered" look identical.
 * "Delivered what" is half the question being asked.
 *
 * Pure: the caller reads git and hands the commits in.
 */

export interface EvidenceCommit {
  sha: string
  message: string
  atMs: number
}

export interface DeliveryEvidence {
  commits: EvidenceCommit[]
  /** PR numbers named by those commits, deduped, in the order they were first seen. */
  pullRequests: number[]
  /** True when nothing was found. Stated, so the caller says so rather than printing an empty box. */
  empty: boolean
}

/**
 * A PR reference, and nothing else that happens to be a number.
 *
 * Only the two forms git actually carries: a trailing `(#N)` from a squash merge, and the
 * `Closes|Fixes|Resolves #N` trailers GitHub itself acts on. A bare `#N` mid-sentence is
 * deliberately NOT matched — a fabricated link in a delivery record sends someone to a page about
 * something else, which is worse than no link at all, and this record exists to be trusted.
 */
const PR_PATTERNS: readonly RegExp[] = [
  /\(#(\d+)\)/g,
  /(?:closes|fixes|resolves)\s+#(\d+)/gi,
]

export function planDeliveryEvidence(o: {
  startedMs: number
  deliveredMs: number
  commits: readonly EvidenceCommit[]
}): DeliveryEvidence {
  const commits = o.commits
    .filter(c => c.atMs >= o.startedMs && c.atMs <= o.deliveredMs)
    .sort((a, b) => a.atMs - b.atMs)

  const prs: number[] = []
  const seen = new Set<number>()
  for (const c of commits) {
    for (const pattern of PR_PATTERNS) {
      // `matchAll` needs a fresh lastIndex per subject: these are module-level /g regexes, and a
      // stale lastIndex would silently skip matches in the next commit message.
      pattern.lastIndex = 0
      for (const m of c.message.matchAll(pattern)) {
        const n = Number(m[1])
        if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue
        seen.add(n)
        prs.push(n)
      }
    }
  }

  return {
    commits: [...commits],
    pullRequests: prs,
    empty: commits.length === 0 && prs.length === 0,
  }
}
