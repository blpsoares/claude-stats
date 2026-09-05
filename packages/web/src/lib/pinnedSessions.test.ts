import { describe, expect, it } from 'bun:test'
import { planPinMove, resolvePinnedRows } from './pinnedSessions'

describe('planPinMove', () => {
  it('moves a pin down', () => {
    expect(planPinMove(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
  })
  it('moves a pin up', () => {
    expect(planPinMove(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })
  it('is a no-op when nothing moves', () => {
    expect(planPinMove(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c'])
  })
  it('leaves the list untouched for an index that does not exist', () => {
    expect(planPinMove(['a', 'b'], 5, 0)).toEqual(['a', 'b'])
    expect(planPinMove(['a', 'b'], 0, -1)).toEqual(['a', 'b'])
    expect(planPinMove([], 0, 0)).toEqual([])
  })
  it('never changes membership', () => {
    const out = planPinMove(['a', 'b', 'c', 'd'], 3, 1)
    expect([...out].sort()).toEqual(['a', 'b', 'c', 'd'])
  })
})

interface Row { id: string; state: string }
const keyOf = (r: Row) => r.id

describe('resolvePinnedRows', () => {
  it('finds a pinned row regardless of its state — a filter is never its job', () => {
    // The bug this pins: a pinned row that FINISHED is exactly the case that must still resolve.
    // If a caller pre-filters to "active only" before calling this, the row is gone from the
    // input and no amount of correctness here can bring it back — this asserts the function
    // itself does not add a second filter on top of whatever it is handed.
    const rows: Row[] = [{ id: 'a', state: 'working' }, { id: 'b', state: 'exited' }]
    expect(resolvePinnedRows(['a', 'b'], rows, keyOf)).toEqual(rows)
  })

  it('keeps pin order, not row order', () => {
    const rows: Row[] = [{ id: 'a', state: 'working' }, { id: 'b', state: 'working' }]
    expect(resolvePinnedRows(['b', 'a'], rows, keyOf).map(r => r.id)).toEqual(['b', 'a'])
  })

  it('drops a pinned key with no matching row, rather than inventing one', () => {
    const rows: Row[] = [{ id: 'a', state: 'working' }]
    expect(resolvePinnedRows(['a', 'gone'], rows, keyOf).map(r => r.id)).toEqual(['a'])
  })

  it('is empty for no pins or no rows', () => {
    expect(resolvePinnedRows([], [{ id: 'a', state: 'working' }], keyOf)).toEqual([])
    expect(resolvePinnedRows(['a'], [], keyOf)).toEqual([])
  })
})
