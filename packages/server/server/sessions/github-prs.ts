/**
 * github-prs.ts — the pull requests of the repository a session is in.
 *
 * A session works in a repository; its pull requests are what that work becomes. Asked for: a tab
 * listing them with their state and a link.
 *
 * IT SHELLS OUT TO `gh`, AND THAT IS THE WHOLE DESIGN. The alternative is a GitHub token in this
 * product's configuration, which would make agentop something that holds a credential to somebody's
 * source control — for a read-only list. `gh` is already installed and already authenticated for
 * anyone who works with PRs, and when it is not, this says so in one sentence instead of asking for
 * a token.
 *
 * EVERY ABSENCE IS A DIFFERENT SENTENCE (`PrUnavailable`):
 *   `no-gh`      the CLI is not installed
 *   `no-auth`    it is installed and not logged in
 *   `no-repo`    this directory is not a git repository, or has no GitHub remote
 *   `failed`     it ran and did not answer — the reason is passed through untouched
 * A single "no pull requests" for all four would send a reader to fix the wrong thing, and three of
 * them are not about pull requests at all.
 *
 * IT IS A READ. No route here opens, merges, closes or comments on anything: this product runs
 * assistants that already do that when a person asks them to, and a button that merges is a
 * different feature with a different consent question.
 */

export type PrUnavailable = 'no-gh' | 'no-auth' | 'no-repo' | 'failed'

export interface PullRequest {
  number: number
  title: string
  url: string
  /** `OPEN` | `MERGED` | `CLOSED`, as GitHub words it. */
  state: string
  draft: boolean
  /** `APPROVED` | `CHANGES_REQUESTED` | `REVIEW_REQUIRED`, or absent when GitHub says nothing. */
  review?: string
  /** The head branch, so a row can be matched to the worktree a session sits in. */
  branch: string
  author?: string
  updatedAt?: string
}

export interface PrList {
  pulls: PullRequest[]
  unavailable?: PrUnavailable
  /** The message `gh` itself printed, for `failed`. Never composed here. */
  detail?: string
  /**
   * How many the read asked for — `PR_LIMIT`, travelling so the UI can SAY it.
   *
   * The list is newest-first and capped, so a repository with more than this many pull requests
   * shows a WINDOW; a panel that does not say so reads as the whole set, which is how a reader
   * concludes a PR was deleted. The number is on the wire rather than restated in the browser
   * because `packages/web` cannot import this module, and a second copy of a cap is a second
   * number to change.
   */
  limit?: number
}

/** How many pull requests one read asks for. A tab, not an archive. */
export const PR_LIMIT = 30

/** The exact JSON fields asked of `gh`. Kept beside the parser so the two cannot drift. */
export const PR_FIELDS = 'number,title,url,state,isDraft,reviewDecision,headRefName,author,updatedAt'

interface RawPr {
  number?: unknown
  title?: unknown
  url?: unknown
  state?: unknown
  isDraft?: unknown
  reviewDecision?: unknown
  headRefName?: unknown
  author?: { login?: unknown }
  updatedAt?: unknown
}

/**
 * Parse what `gh pr list --json` printed — PURE.
 *
 * A row missing a number, a url or a title is DROPPED rather than rendered with blanks: those three
 * are what makes a pull request identifiable and clickable, and a row without them is a link to
 * nowhere. An empty `reviewDecision` is GitHub saying nothing, not "no review", so it is omitted.
 */
export function parsePrList(text: string): PullRequest[] {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return [] }
  if (!Array.isArray(raw)) return []
  const out: PullRequest[] = []
  for (const r of raw as RawPr[]) {
    const number = typeof r?.number === 'number' ? r.number : 0
    const title = typeof r?.title === 'string' ? r.title : ''
    const url = typeof r?.url === 'string' ? r.url : ''
    if (number <= 0 || title === '' || url === '') continue
    const review = typeof r.reviewDecision === 'string' && r.reviewDecision !== ''
      ? r.reviewDecision
      : undefined
    const author = typeof r.author?.login === 'string' ? r.author.login : undefined
    out.push({
      number,
      title,
      url,
      state: typeof r.state === 'string' && r.state !== '' ? r.state : 'OPEN',
      draft: r.isDraft === true,
      ...(review ? { review } : {}),
      branch: typeof r.headRefName === 'string' ? r.headRefName : '',
      ...(author ? { author } : {}),
      ...(typeof r.updatedAt === 'string' ? { updatedAt: r.updatedAt } : {}),
    })
  }
  return sortPullRequests(out)
}

/**
 * The order the list is read in — PURE, and by STATUS before anything else.
 *
 * `gh` returns them by recency, which mixes a PR merged last week into the middle of the ones still
 * open. The panel is a view of work in flight, so what is still moving comes first and what is
 * settled sinks: OPEN, then DRAFT, then MERGED, then CLOSED.
 *
 * DRAFT is its own rank rather than part of OPEN. It is open in GitHub's data and it is not asking
 * anybody for anything yet, which is the distinction the reader cares about — a draft sitting above
 * a PR waiting on review would put the one nobody is blocked on first.
 *
 * The review decision is deliberately NOT a second sort key. It is on the row as a badge, and a
 * list ordered by two things at once is a list whose order nobody can predict; the reader asked for
 * status. Within a rank the newest number leads, which is what `gh` already implies and what a
 * person means by "the latest one".
 *
 * A state this reader has no rank for sorts with MERGED rather than first or last: it is somebody
 * else's vocabulary, and an unknown word is not evidence that the PR is urgent OR abandoned.
 */
const PR_RANK: Record<string, number> = { OPEN: 0, MERGED: 2, CLOSED: 3 }
const PR_RANK_UNKNOWN = 2

export function prRank(pr: Pick<PullRequest, 'state' | 'draft'>): number {
  const state = pr.state.toUpperCase()
  if (state === 'OPEN') return pr.draft ? 1 : 0
  return PR_RANK[state] ?? PR_RANK_UNKNOWN
}

export function sortPullRequests(pulls: readonly PullRequest[]): PullRequest[] {
  return [...pulls].sort((a, b) => prRank(a) - prRank(b) || b.number - a.number)
}

/**
 * Which absence a failed `gh` run represents — PURE.
 *
 * Read off what `gh` actually prints. The strings are matched loosely because they are somebody
 * else's wording and it changes; an unrecognised failure is `failed` WITH the output attached,
 * which is strictly more useful than a guess at which of the three it was.
 */
export function classifyPrFailure(code: number, stderr: string): PrUnavailable {
  const e = stderr.toLowerCase()
  if (code === 127 || e.includes('command not found') || e.includes('not found: gh')) return 'no-gh'
  if (e.includes('gh auth login') || e.includes('authentication') || e.includes('not logged')) return 'no-auth'
  if (e.includes('not a git repository') || e.includes('no git remote') || e.includes('could not determine')) {
    return 'no-repo'
  }
  return 'failed'
}


/**
 * Run `gh` in a session's directory and read back its pull requests.
 *
 * The IMPURE half, deliberately thin: everything it decides is one of the two pure functions above.
 * `PR_LIMIT` because this is a tab, not an archive, and the list is newest-first — the cap travels
 * back on `PrList.limit` so the panel can say which window it is showing.
 *
 * The cwd is the SESSION'S, so the repository is whichever one that session is working in — asking
 * from the server's own directory would answer about agentop on a machine using it for something
 * else.
 */
export async function readPullRequests(cwd: string): Promise<PrList> {
  if (!cwd) return { pulls: [], unavailable: 'no-repo' }
  try {
    const proc = Bun.spawn(
      ['gh', 'pr', 'list', '--limit', String(PR_LIMIT), '--state', 'all', '--json', PR_FIELDS],
      { cwd, stdout: 'pipe', stderr: 'pipe' },
    )
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    if (code !== 0) {
      const kind = classifyPrFailure(code, err)
      return {
        pulls: [],
        unavailable: kind,
        ...(kind === 'failed' && err.trim() ? { detail: err.trim().split('\n').slice(0, 2).join(' ') } : {}),
      }
    }
    return { pulls: parsePrList(out), limit: PR_LIMIT }
  } catch (e) {
    // `gh` missing entirely lands here on some platforms rather than as an exit code.
    return { pulls: [], unavailable: classifyPrFailure(127, e instanceof Error ? e.message : '') }
  }
}
