import { describe, it, expect } from 'bun:test'
import { fleetIsStale, fleetSeedNotice, fleetStaleNotice, STALE_AFTER_FAILURES } from './fleetStale'

const NOW = 1_000_000

describe('fleetIsStale', () => {
  it('is false while everything is answering', () => {
    expect(fleetIsStale({ failures: 0, lastOkMs: NOW })).toBe(false)
  })

  it('tolerates ONE miss — a single failed poll is the normal noise of a 5s poll', () => {
    // A rebuild, a laptop waking, a server restart. A warning that fires on those is one people
    // stop reading.
    expect(fleetIsStale({ failures: 1, lastOkMs: NOW })).toBe(false)
  })

  it('fires once the misses reach the threshold, and stays', () => {
    expect(fleetIsStale({ failures: STALE_AFTER_FAILURES, lastOkMs: NOW })).toBe(true)
    expect(fleetIsStale({ failures: 20, lastOkMs: NOW })).toBe(true)
  })

  it('is FALSE when nothing has ever answered — that is loading, not staleness', () => {
    // "This list may be out of date" about a list that was never fetched names the wrong problem.
    expect(fleetIsStale({ failures: 99, lastOkMs: null })).toBe(false)
  })
})

describe('fleetStaleNotice', () => {
  it('says nothing when the fleet is fresh', () => {
    expect(fleetStaleNotice({ failures: 0, lastOkMs: NOW }, NOW, 'en')).toBeNull()
    expect(fleetStaleNotice({ failures: 99, lastOkMs: null }, NOW, 'en')).toBeNull()
  })

  it('states that the list is the LAST ONE THAT ARRIVED, not what is running', () => {
    // The whole point: a stale list is worse than an empty one, because an empty one is obviously
    // wrong.
    const msg = fleetStaleNotice({ failures: 3, lastOkMs: NOW - 15_000 }, NOW, 'en')!
    expect(msg).toMatch(/last one that arrived/)
    expect(msg).toMatch(/not what is running now/)
  })

  it('carries the AGE, in seconds and then in minutes', () => {
    // "a few seconds" and "eleven minutes" call for different reactions.
    expect(fleetStaleNotice({ failures: 2, lastOkMs: NOW - 12_000 }, NOW, 'en')).toMatch(/12s/)
    expect(fleetStaleNotice({ failures: 2, lastOkMs: NOW - 660_000 }, NOW, 'en')).toMatch(/11 min/)
  })

  it('never reports a negative age from a clock that jumped', () => {
    expect(fleetStaleNotice({ failures: 2, lastOkMs: NOW + 5_000 }, NOW, 'en')).toMatch(/0s/)
  })

  it('is really translated, not the English sentence twice', () => {
    const en = fleetStaleNotice({ failures: 2, lastOkMs: NOW - 10_000 }, NOW, 'en')!
    const pt = fleetStaleNotice({ failures: 2, lastOkMs: NOW - 10_000 }, NOW, 'pt')!
    expect(pt).not.toBe(en)
    expect(pt).toMatch(/Sem resposta da máquina/)
  })
})

describe('fleetSeedNotice', () => {
  it('says nothing when there is no seed — that is loading, not a stale list', () => {
    expect(fleetSeedNotice(0, NOW, 'en')).toBeNull()
    expect(fleetSeedNotice(-1, NOW, 'en')).toBeNull()
    expect(fleetSeedNotice(Number.NaN, NOW, 'en')).toBeNull()
  })

  it('does NOT claim the machine failed to answer', () => {
    // The defect this function exists for: a seeded list borrowed the stale sentence, which opens
    // with "no answer from this machine" — false on a normal reopen, where nothing has been asked
    // yet. A warning that cries wolf on every visit is one people stop reading.
    const en = fleetSeedNotice(NOW - 30_000, NOW, 'en')!
    expect(en).not.toMatch(/No answer/i)
    expect(en).toMatch(/waiting for this machine to confirm/i)
    const pt = fleetSeedNotice(NOW - 30_000, NOW, 'pt')!
    expect(pt).not.toMatch(/Sem resposta/i)
    expect(pt).toMatch(/esperando esta máquina confirmar/i)
  })

  it('carries the AGE on the same scale the stale sentence uses', () => {
    expect(fleetSeedNotice(NOW - 12_000, NOW, 'en')).toMatch(/12s/)
    expect(fleetSeedNotice(NOW - 660_000, NOW, 'en')).toMatch(/11 min/)
  })

  it('never reports a negative age from a clock that jumped', () => {
    expect(fleetSeedNotice(NOW + 5_000, NOW, 'en')).toMatch(/0s/)
  })

  it('is a DIFFERENT sentence from the stale one, in both languages', () => {
    const seed = fleetSeedNotice(NOW - 10_000, NOW, 'en')
    const staleMsg = fleetStaleNotice({ failures: 2, lastOkMs: NOW - 10_000 }, NOW, 'en')
    expect(seed).not.toBe(staleMsg)
    expect(fleetSeedNotice(NOW - 10_000, NOW, 'pt')).not.toBe(seed)
  })
})
