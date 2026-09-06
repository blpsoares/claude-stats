import { describe, expect, it } from 'bun:test'
import { compareBy, DEFAULT_SORT, nextSort, sortRows, type SortableRow } from './task-sort'

const row = (over: Partial<SortableRow['task']> & { id: string }, rest: Partial<SortableRow> = {}): SortableRow => ({
  task: {
    title: 't', status: 'todo', createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', ...over,
  },
  ...rest,
})

describe('sortRows', () => {
  it('puts an unmeasurable row LAST in both directions', () => {
    // A task nobody could price is not the cheapest task.
    const rows = [
      row({ id: 'none' }, { rollup: { costUSD: null, tokens: null, rounds: null, sessionsUsed: 0 } }),
      row({ id: 'cheap' }, { rollup: { costUSD: 1, tokens: 1, rounds: 1, sessionsUsed: 1 } }),
      row({ id: 'dear' }, { rollup: { costUSD: 9, tokens: 9, rounds: 9, sessionsUsed: 1 } }),
    ]
    expect(sortRows(rows, { key: 'cost', dir: 'asc' }).map(r => r.task.id)).toEqual(['cheap', 'dear', 'none'])
    expect(sortRows(rows, { key: 'cost', dir: 'desc' }).map(r => r.task.id)).toEqual(['dear', 'cheap', 'none'])
  })

  it('orders priority most-urgent-first when ascending', () => {
    const rows = [row({ id: 'l', priority: 'low' }), row({ id: 'u', priority: 'urgent' }), row({ id: 'n' })]
    expect(sortRows(rows, { key: 'priority', dir: 'asc' }).map(r => r.task.id)).toEqual(['u', 'l', 'n'])
  })

  it('is TOTAL: equal values fall back to rank, then creation, then id', () => {
    const rows = [
      row({ id: 'b', createdAt: '2026-01-02T00:00:00.000Z' }),
      row({ id: 'a', createdAt: '2026-01-02T00:00:00.000Z' }),
      row({ id: 'c', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]
    const once = sortRows(rows, { key: 'status', dir: 'asc' }).map(r => r.task.id)
    const twice = sortRows([...rows].reverse(), { key: 'status', dir: 'asc' }).map(r => r.task.id)
    expect(once).toEqual(['c', 'a', 'b'])
    // Same answer whatever order the input arrived in — a board that reshuffles on a re-render is
    // one people stop trusting to have shown them everything.
    expect(twice).toEqual(once)
  })

  it('manual order is the rank, and an unranked card follows the ranked ones', () => {
    const rows = [
      row({ id: 'no-rank', createdAt: '2026-01-01T00:00:00.000Z' }),
      row({ id: 'second', rank: 'b' }),
      row({ id: 'first', rank: 'a' }),
    ]
    expect(sortRows(rows, DEFAULT_SORT).map(r => r.task.id)).toEqual(['first', 'second', 'no-rank'])
  })

  it('sorts titles case-insensitively', () => {
    const rows = [row({ id: 'b', title: 'beta' }), row({ id: 'a', title: 'Alpha' })]
    expect(sortRows(rows, { key: 'title', dir: 'asc' }).map(r => r.task.id)).toEqual(['a', 'b'])
  })

  it('never mutates its input', () => {
    const rows = [row({ id: 'b', title: 'b' }), row({ id: 'a', title: 'a' })]
    sortRows(rows, { key: 'title', dir: 'asc' })
    expect(rows.map(r => r.task.id)).toEqual(['b', 'a'])
  })
})

describe('compareBy', () => {
  it('reads a zero as a real value, not as absent', () => {
    const zero = row({ id: 'z' }, { rollup: { costUSD: 0, tokens: 0, rounds: 0, sessionsUsed: 0 } })
    const none = row({ id: 'n' }, { rollup: { costUSD: null, tokens: null, rounds: null, sessionsUsed: 0 } })
    expect(compareBy({ key: 'cost', dir: 'asc' }, zero, none)).toBeLessThan(0)
  })
})

describe('nextSort', () => {
  it('cycles a column none → asc → desc → the board’s own order', () => {
    const a = nextSort(DEFAULT_SORT, 'cost')
    expect(a).toEqual({ key: 'cost', dir: 'asc' })
    const b = nextSort(a, 'cost')
    expect(b).toEqual({ key: 'cost', dir: 'desc' })
    expect(nextSort(b, 'cost')).toEqual(DEFAULT_SORT)
  })

  it('starts a NEW column ascending rather than inheriting the last direction', () => {
    expect(nextSort({ key: 'cost', dir: 'desc' }, 'title')).toEqual({ key: 'title', dir: 'asc' })
  })
})
