import { describe, expect, it } from 'bun:test'
import { rowSelected } from './fleetSelection'

describe('rowSelected', () => {
  it('matches the row by its id', () => {
    expect(rowSelected({ id: 'a' }, 'a')).toBe(true)
    expect(rowSelected({ id: 'a' }, 'b')).toBe(false)
  })

  it('matches the row by its conversation', () => {
    expect(rowSelected({ id: 'a', conversationId: 'c1' }, 'c1')).toBe(true)
  })

  it('selects NOTHING when no session is open', () => {
    // The defect this exists for: both sides undefined is not a match.
    expect(rowSelected({ id: 'a' }, undefined)).toBe(false)
    expect(rowSelected({ id: 'a', conversationId: undefined }, undefined)).toBe(false)
    expect(rowSelected({ id: 'a', conversationId: 'c1' }, undefined)).toBe(false)
    expect(rowSelected({ id: 'a' }, '')).toBe(false)
  })
})
