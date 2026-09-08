import { describe, expect, it } from 'bun:test'
import { planFirstSightingClaims } from './task-attribution'
import type { ClaimCandidate, ClaimRow } from './task-attribution'

const row = (id: string, over: Partial<ClaimRow> = {}): ClaimRow => ({
  id, harness: 'codex', cwd: '/repo/a', spawnedMs: 1_000, ...over,
})

const cand = (sessionId: string, over: Partial<ClaimCandidate> = {}): ClaimCandidate => ({
  sessionId, harness: 'codex', cwd: '/repo/a', startedMs: 2_000, ...over,
})

describe('planFirstSightingClaims', () => {
  it('claims the one conversation that appeared after the spawn, in the spawn directory', () => {
    const plan = planFirstSightingClaims({ rows: [row('r1')], candidates: [cand('c1')], claimed: new Set() })
    expect(plan.claims).toEqual([{ rowId: 'r1', sessionId: 'c1' }])
    expect(plan.refused).toEqual([])
  })

  it('REFUSES when two candidates fit — it does not pick the closer one', () => {
    // Choosing by proximity is a guess wearing a measurement's clothes. Two conversations in the
    // window means the evidence does not identify one, and a wrong cost is invisible.
    const plan = planFirstSightingClaims({
      rows: [row('r1')],
      candidates: [cand('c1'), cand('c2', { startedMs: 2_500 })],
      claimed: new Set(),
    })
    expect(plan.claims).toEqual([])
    expect(plan.refused).toEqual([{ rowId: 'r1', reason: 'ambiguous-candidates' }])
  })

  it('REFUSES both rows when two of one harness were spawned in one directory', () => {
    // `agentop session batch` starting several sessions of one harness in one repository is exactly
    // this case. Coming out empty is correct; coming out swapped is the bug this cannot survive.
    const plan = planFirstSightingClaims({
      rows: [row('r1'), row('r2')], candidates: [cand('c1')], claimed: new Set(),
    })
    expect(plan.claims).toEqual([])
    expect(plan.refused.map(r => r.reason)).toEqual(['ambiguous-rows', 'ambiguous-rows'])
  })

  it('ignores a conversation that started BEFORE the spawn', () => {
    const plan = planFirstSightingClaims({
      rows: [row('r1', { spawnedMs: 5_000 })],
      candidates: [cand('c1', { startedMs: 1_000 })],
      claimed: new Set(),
    })
    expect(plan.claims).toEqual([])
  })

  it('ignores a conversation of another harness, and one in another directory', () => {
    const plan = planFirstSightingClaims({
      rows: [row('r1')],
      candidates: [cand('c1', { harness: 'kimi' }), cand('c2', { cwd: '/repo/b' })],
      claimed: new Set(),
    })
    expect(plan.claims).toEqual([])
  })

  it('never re-claims a conversation another row already holds', () => {
    const plan = planFirstSightingClaims({
      rows: [row('r1')], candidates: [cand('c1')], claimed: new Set(['c1']),
    })
    expect(plan.claims).toEqual([])
  })

  it('leaves a row that already has a link alone — a claim is never revised', () => {
    // Re-deriving a link later is how a row silently changes what it measured.
    const plan = planFirstSightingClaims({
      rows: [row('r1', { conversationId: 'already' })], candidates: [cand('c1')], claimed: new Set(),
    })
    expect(plan.claims).toEqual([])
    expect(plan.refused).toEqual([])
  })

  it('a row that already has a link does not make its NEIGHBOUR ambiguous', () => {
    // Two rows in one directory, one of them already linked: the remaining one is the only
    // unclaimed row there, so the evidence does identify it. Counting the settled row as a rival
    // would make every second session of a directory permanently unlinkable.
    const plan = planFirstSightingClaims({
      rows: [row('r1', { conversationId: 'already' }), row('r2')],
      candidates: [cand('c1')],
      claimed: new Set(['already']),
    })
    expect(plan.claims).toEqual([{ rowId: 'r2', sessionId: 'c1' }])
  })

  it('claims independently for rows in different directories', () => {
    const plan = planFirstSightingClaims({
      rows: [row('r1'), row('r2', { cwd: '/repo/b' })],
      candidates: [cand('c1'), cand('c2', { cwd: '/repo/b' })],
      claimed: new Set(),
    })
    expect(plan.claims).toEqual([
      { rowId: 'r1', sessionId: 'c1' },
      { rowId: 'r2', sessionId: 'c2' },
    ])
  })

  it('does not hand ONE conversation to two rows in different directories', () => {
    // The candidate belongs to /repo/a; the row in /repo/b must not take it. Directory equality is
    // exact for the same reason `sessionAtCwd` is: a prefix test would let a session in $HOME claim
    // every conversation on the machine.
    const plan = planFirstSightingClaims({
      rows: [row('r1'), row('r2', { cwd: '/repo/b' })],
      candidates: [cand('c1')],
      claimed: new Set(),
    })
    expect(plan.claims).toEqual([{ rowId: 'r1', sessionId: 'c1' }])
  })

  it('refuses nothing and claims nothing on an empty fleet', () => {
    expect(planFirstSightingClaims({ rows: [], candidates: [], claimed: new Set() }))
      .toEqual({ claims: [], refused: [] })
  })
})
