import { describe, expect, it } from 'bun:test'
import { planDeliveryEvidence } from './task-evidence'

const commit = (sha: string, message: string, atMs: number) => ({ sha, message, atMs })

describe('planDeliveryEvidence', () => {
  it('keeps only commits inside the attempt window', () => {
    const e = planDeliveryEvidence({
      startedMs: 1_000,
      deliveredMs: 3_000,
      commits: [commit('a', 'early', 500), commit('b', 'during', 2_000), commit('c', 'late', 4_000)],
    })
    expect(e.commits.map(c => c.sha)).toEqual(['b'])
  })

  it('extracts PR references from both forms git actually carries', () => {
    const e = planDeliveryEvidence({
      startedMs: 0,
      deliveredMs: 10,
      commits: [commit('a', 'feat: thing (#287)', 5), commit('b', 'fix: other\n\nCloses #42', 6)],
    })
    expect(e.pullRequests).toEqual([287, 42])
  })

  it('does not read a number that is not a PR reference', () => {
    // "fix 42 things" and "v2" are not references. A fabricated PR link in a delivery record sends
    // someone to a page about something else, which is worse than no link.
    const e = planDeliveryEvidence({
      startedMs: 0,
      deliveredMs: 10,
      commits: [commit('a', 'bump to v2 and fix 42 things, see #99', 5)],
    })
    expect(e.pullRequests).toEqual([])
  })

  it('dedupes a PR named by several commits', () => {
    const e = planDeliveryEvidence({
      startedMs: 0,
      deliveredMs: 10,
      commits: [commit('a', 'feat: x (#7)', 1), commit('b', 'fixup (#7)', 2)],
    })
    expect(e.pullRequests).toEqual([7])
  })

  it('reads every commit, not only the first — the module-level regexes keep no state', () => {
    // /g regexes carry lastIndex. Reusing one across subjects without resetting silently skips
    // matches in everything after the first.
    const e = planDeliveryEvidence({
      startedMs: 0,
      deliveredMs: 10,
      commits: [commit('a', 'one (#1)', 1), commit('b', 'two (#2)', 2), commit('c', 'three (#3)', 3)],
    })
    expect(e.pullRequests).toEqual([1, 2, 3])
  })

  it('orders commits oldest first, whatever order they arrived in', () => {
    const e = planDeliveryEvidence({
      startedMs: 0,
      deliveredMs: 10,
      commits: [commit('c', 'third', 3), commit('a', 'first', 1), commit('b', 'second', 2)],
    })
    expect(e.commits.map(c => c.sha)).toEqual(['a', 'b', 'c'])
  })

  it('reports an empty evidence set rather than refusing the delivery', () => {
    // Work that produces no commit is still delivered. The marker is the person's; the evidence is
    // whatever there is.
    const e = planDeliveryEvidence({ startedMs: 0, deliveredMs: 10, commits: [] })
    expect(e.commits).toEqual([])
    expect(e.pullRequests).toEqual([])
    expect(e.empty).toBe(true)
  })

  it('is not empty when a commit landed but named no PR', () => {
    const e = planDeliveryEvidence({
      startedMs: 0, deliveredMs: 10, commits: [commit('a', 'wip', 5)],
    })
    expect(e.empty).toBe(false)
  })
})
