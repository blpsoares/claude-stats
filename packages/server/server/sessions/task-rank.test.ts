import { describe, expect, it } from 'bun:test'
import { initialRanks, MAX_RANK_LENGTH, needsRebalance, planMove, rankBetween } from './task-rank'

describe('rankBetween', () => {
  it('sorts strictly between its two neighbours', () => {
    const mid = rankBetween('a', 'b')!
    expect(mid > 'a').toBe(true)
    expect(mid < 'b').toBe(true)
  })

  it('opens the list at either end', () => {
    const first = rankBetween(null, 'b')!
    expect(first < 'b').toBe(true)
    const last = rankBetween('y', null)!
    expect(last > 'y').toBe(true)
  })

  it('answers on an empty list', () => {
    expect(rankBetween(null, null)).toBe('m')
  })

  it('finds room between ADJACENT characters by growing the string', () => {
    // 'a' and 'b' have no character between them, so the answer has to be longer.
    const mid = rankBetween('aa', 'ab')!
    expect(mid > 'aa').toBe(true)
    expect(mid < 'ab').toBe(true)
    expect(mid.length).toBeGreaterThan(2)
  })

  it('survives a hundred inserts into the SAME gap', () => {
    // The pathological case for this scheme, and the one that must stay correct: repeatedly
    // dropping a card immediately after the first.
    let lo = 'a'
    const hi = 'b'
    for (let i = 0; i < 100; i++) {
      const next = rankBetween(lo, hi)
      expect(next).not.toBeNull()
      expect(next! > lo).toBe(true)
      expect(next! < hi).toBe(true)
      lo = next!
    }
  })

  it('REFUSES neighbours that are equal or out of order rather than guessing', () => {
    // A caller that lost track of its neighbours must not be handed a rank that lands elsewhere.
    expect(rankBetween('m', 'm')).toBeNull()
    expect(rankBetween('z', 'a')).toBeNull()
  })
})

describe('initialRanks', () => {
  it('is ascending and unique', () => {
    for (const n of [1, 5, 36, 120]) {
      const rs = initialRanks(n)
      expect(rs).toHaveLength(n)
      expect(new Set(rs).size).toBe(n)
      expect([...rs].sort()).toEqual(rs)
    }
  })

  it('leaves room between neighbours for a drop', () => {
    const rs = initialRanks(10)
    expect(rankBetween(rs[3]!, rs[4]!)).not.toBeNull()
  })

  it('is empty for an empty column', () => {
    expect(initialRanks(0)).toEqual([])
  })
})

describe('needsRebalance', () => {
  it('is false for ordinary ranks and true once one has grown', () => {
    expect(needsRebalance(['a', 'b', undefined])).toBe(false)
    expect(needsRebalance(['a'.repeat(MAX_RANK_LENGTH + 1)])).toBe(true)
  })
})

describe('planMove', () => {
  const col = [
    { id: 'a', rank: '1' }, { id: 'b', rank: '2' }, { id: 'c', rank: '3' },
  ]

  it('writes ONE row for an ordinary drop', () => {
    const w = planMove(col, 'c', 1)
    expect(w).toHaveLength(1)
    expect(w[0]!.id).toBe('c')
    expect(w[0]!.rank > '1').toBe(true)
    expect(w[0]!.rank < '2').toBe(true)
  })

  it('places at the head and at the tail', () => {
    expect(planMove(col, 'c', 0)[0]!.rank < '1').toBe(true)
    expect(planMove(col, 'a', 99)[0]!.rank > '3').toBe(true)
  })

  it('REBALANCES rather than failing when the neighbours cannot be split', () => {
    // Two cards carrying the same rank: `rankBetween` refuses, and the column is rewritten whole
    // rather than leaving the dropped card where it was.
    const clashing = [{ id: 'a', rank: 'm' }, { id: 'b', rank: 'm' }, { id: 'c', rank: 'z' }]
    const w = planMove(clashing, 'c', 1)
    expect(w).toHaveLength(3)
    expect([...w.map(x => x.rank)].sort()).toEqual(w.map(x => x.rank))
    expect(w[1]!.id).toBe('c')
  })

  it('orders a column that has never been ranked', () => {
    const fresh = [{ id: 'a' }, { id: 'b' }]
    const w = planMove(fresh, 'b', 0)
    expect(w.length).toBeGreaterThan(0)
  })
})
