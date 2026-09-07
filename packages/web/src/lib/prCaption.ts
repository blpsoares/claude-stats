/**
 * prCaption.ts — the one sentence over the PRs list, PURE.
 *
 * The list is the REPOSITORY'S pull requests, read by running `gh` in the session's directory —
 * so a session sees the PRs its siblings opened, and there is no filter by branch, author or
 * session. Read inside a panel titled with a session's name, that is genuinely surprising: it was
 * reported as "there are PRs here from other sessions of the repo".
 *
 * It is also a WINDOW. `github-prs.ts` reads `PR_LIMIT` newest-first, so on a busy repository the
 * older ones are simply not in the answer — and a list that does not say so reads as the whole
 * set, which is how somebody concludes a pull request was deleted.
 *
 * Two facts, and the second only when it is TRUE: below the cap the list IS complete, and calling
 * it "the 30 most recent" there would invent a window that is not there. `shown < limit` is the
 * only thing that settles it, because `gh` reports no total.
 */

export function prCaption(
  args: { shown: number; limit?: number; lang: 'pt' | 'en' },
): string {
  const { shown, limit, lang } = args
  const capped = typeof limit === 'number' && limit > 0 && shown >= limit
  if (lang === 'pt') {
    return capped
      ? `Os ${limit} pull requests mais recentes deste repositório — de todas as sessões, não só desta.`
      : 'Os pull requests deste repositório — de todas as sessões, não só desta.'
  }
  return capped
    ? `The ${limit} most recent pull requests in this repository — from every session, not only this one.`
    : 'The pull requests in this repository — from every session, not only this one.'
}
