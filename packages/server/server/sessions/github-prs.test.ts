import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, test } from 'bun:test'
import { classifyPrFailure, parsePrList, prRank, sortPullRequests, type PullRequest } from './github-prs'

test('a real `gh pr list --json` payload parses', () => {
  const text = JSON.stringify([{
    number: 304, title: 'feat(tui): pinning a row no longer arms a mass kill',
    url: 'https://github.com/o/r/pull/304', state: 'OPEN', isDraft: false,
    reviewDecision: '', headRefName: 'feat/pin', author: { login: 'scion' },
    updatedAt: '2026-09-05T10:00:00Z',
  }])
  expect(parsePrList(text)).toEqual([{
    number: 304, title: 'feat(tui): pinning a row no longer arms a mass kill',
    url: 'https://github.com/o/r/pull/304', state: 'OPEN', draft: false,
    branch: 'feat/pin', author: 'scion', updatedAt: '2026-09-05T10:00:00Z',
  }])
})

test('an empty reviewDecision is GitHub saying NOTHING, not "no review"', () => {
  const [pr] = parsePrList(JSON.stringify([
    { number: 1, title: 't', url: 'u', reviewDecision: '' },
  ]))
  expect(pr!.review).toBeUndefined()
  const [ok] = parsePrList(JSON.stringify([
    { number: 1, title: 't', url: 'u', reviewDecision: 'APPROVED' },
  ]))
  expect(ok!.review).toBe('APPROVED')
})

test('a row that cannot be identified or clicked is DROPPED, never blank', () => {
  const rows = parsePrList(JSON.stringify([
    { number: 0, title: 't', url: 'u' },
    { number: 2, title: '', url: 'u' },
    { number: 3, title: 't', url: '' },
    { number: 4, title: 't', url: 'u' },
  ]))
  expect(rows.map(r => r.number)).toEqual([4])
})

test('junk is an empty list, never a throw', () => {
  expect(parsePrList('not json')).toEqual([])
  expect(parsePrList('{"not":"an array"}')).toEqual([])
  expect(parsePrList('')).toEqual([])
})

test('each absence is told apart, and an unknown one keeps its output', () => {
  expect(classifyPrFailure(127, 'gh: command not found')).toBe('no-gh')
  expect(classifyPrFailure(1, 'To get started with GitHub CLI, please run: gh auth login')).toBe('no-auth')
  expect(classifyPrFailure(1, 'fatal: not a git repository')).toBe('no-repo')
  // Not guessed at — the caller passes the output through, which beats a wrong label.
  expect(classifyPrFailure(1, 'HTTP 503 upstream is unavailable')).toBe('failed')
})

describe('every field of PrList reaches the wire', () => {
  /**
   * `readFleetPullRequests` builds its reply FIELD BY FIELD rather than spreading `PrList`. That is
   * right — it is the boundary between a module's shape and what a browser is handed — but it means
   * a new field is on the wire only once it is named there, and nothing else notices when it is not.
   *
   * That happened: `limit` was added to `PrList`, added to the browser's own type and to the
   * caption, and forgotten in that one object. The caption then said the same sentence for four
   * pull requests and for thirty — the exact claim it exists to make, never made.
   *
   * A grep, in the shape `tokens.lint.test.ts` uses over the product source, because the honest
   * alternative would be an integration test that shells out to `gh` against a live repository.
   */
  const prs = readFileSync(join(import.meta.dir, 'github-prs.ts'), 'utf-8')
  const web = readFileSync(join(import.meta.dir, 'fleet-web.ts'), 'utf-8')
  const reply = web.slice(web.indexOf('export async function readFleetPullRequests'))
    .slice(0, web.slice(web.indexOf('export async function readFleetPullRequests')).indexOf('\n}\n') + 3)

  const fields = [...prs.slice(prs.indexOf('export interface PrList'))
    .slice(0, prs.slice(prs.indexOf('export interface PrList')).indexOf('\n}'))
    .matchAll(/^\s{2}(\w+)\??:/gm)].map(m => m[1]!)

  it('names every one of them', () => {
    expect(fields.length).toBeGreaterThan(1)
    for (const f of fields) expect(reply).toContain(`${f}:`)
  })
})

describe('sortPullRequests — what is still moving comes first', () => {
  const pr = (number: number, state: string, draft = false): PullRequest =>
    ({ number, title: `PR ${number}`, url: `u${number}`, state, draft, branch: 'b' })

  it('orders by STATUS: open, draft, merged, closed', () => {
    // `gh` returns them by recency, which mixes a PR merged last week into the middle of the ones
    // still open.
    const out = sortPullRequests([
      pr(1, 'MERGED'), pr(2, 'CLOSED'), pr(3, 'OPEN', true), pr(4, 'OPEN'),
    ])
    expect(out.map(p => p.number)).toEqual([4, 3, 1, 2])
  })

  it('keeps a DRAFT below the open PRs that are actually asking for something', () => {
    const out = sortPullRequests([pr(9, 'OPEN', true), pr(1, 'OPEN')])
    expect(out.map(p => p.number)).toEqual([1, 9])
  })

  it('leads with the newest number inside one status', () => {
    const out = sortPullRequests([pr(3, 'OPEN'), pr(11, 'OPEN'), pr(7, 'OPEN')])
    expect(out.map(p => p.number)).toEqual([11, 7, 3])
  })

  it('files a state it has no rank for with MERGED, never first or last', () => {
    // Somebody else's vocabulary: an unknown word is not evidence that the PR is urgent OR
    // abandoned.
    expect(prRank({ state: 'SOMETHING_NEW', draft: false })).toBe(prRank({ state: 'MERGED', draft: false }))
  })

  it('reads the state case-insensitively — it is GitHub that decides the casing', () => {
    expect(prRank({ state: 'open', draft: false })).toBe(0)
  })

  it('does not mutate what it was given', () => {
    const input = [pr(1, 'MERGED'), pr(2, 'OPEN')]
    sortPullRequests(input)
    expect(input.map(p => p.number)).toEqual([1, 2])
  })
})
