import { describe, test, expect } from 'bun:test'
import {
  pickLensesToSync,
  nextMinInterval,
  MIRROR_DEFAULTS,
  MIRROR_BUDGET_MS,
  MIRROR_MAX_INTERVAL_MS,
  MIRROR_MIN_INTERVAL_MS,
  type MirrorLensState,
} from './mirrorSchedule'

const state = (over: Partial<MirrorLensState> & { id: string }): MirrorLensState => ({
  dirty: false, onScreen: true, lastSyncMs: 0, ...over,
})

describe('pickLensesToSync', () => {
  test('never picks more than maxPerFrame and filters out ineligible lenses', () => {
    // Create 20 lenses: 16 eligible (dirty, onScreen, due), 4 ineligible (off-screen or too recent)
    const eligible = Array.from({ length: 16 }, (_, i) => state({ id: `e${i}`, dirty: true, lastSyncMs: 0, onScreen: true }))
    const offScreen = Array.from({ length: 2 }, (_, i) => state({ id: `off${i}`, dirty: true, lastSyncMs: 0, onScreen: false }))
    const tooRecent = Array.from({ length: 2 }, (_, i) => state({ id: `recent${i}`, dirty: true, lastSyncMs: 950, onScreen: true }))
    const many = [...eligible, ...offScreen, ...tooRecent]

    const result = pickLensesToSync(many, 1000, MIRROR_DEFAULTS)

    // Should pick exactly maxPerFrame lenses
    expect(result).toHaveLength(MIRROR_DEFAULTS.maxPerFrame)

    // Should not contain any ineligible ids
    expect(result).not.toContain('off0')
    expect(result).not.toContain('off1')
    expect(result).not.toContain('recent0')
    expect(result).not.toContain('recent1')
  })

  test('picks the least recently synced first — that is the round robin', () => {
    const lenses = [
      state({ id: 'new', dirty: true, lastSyncMs: 900 }),
      state({ id: 'old', dirty: true, lastSyncMs: 100 }),
      state({ id: 'mid', dirty: true, lastSyncMs: 500 }),
    ]
    expect(pickLensesToSync(lenses, 2000, MIRROR_DEFAULTS)).toEqual(['old', 'mid'])
  })

  test('an off-screen lens is never synced, however dirty', () => {
    const lenses = [state({ id: 'hidden', dirty: true, onScreen: false, lastSyncMs: 0 })]
    expect(pickLensesToSync(lenses, 10_000, MIRROR_DEFAULTS)).toEqual([])
  })

  test('a dirty lens waits out the minimum interval', () => {
    const lenses = [state({ id: 'a', dirty: true, lastSyncMs: 1000 })]
    expect(pickLensesToSync(lenses, 1000 + MIRROR_DEFAULTS.minIntervalMs - 1, MIRROR_DEFAULTS)).toEqual([])
    expect(pickLensesToSync(lenses, 1000 + MIRROR_DEFAULTS.minIntervalMs, MIRROR_DEFAULTS)).toEqual(['a'])
  })

  test('a clean lens still syncs on the heartbeat — canvas paint moves no DOM', () => {
    const lenses = [state({ id: 'a', dirty: false, lastSyncMs: 0 })]
    expect(pickLensesToSync(lenses, MIRROR_DEFAULTS.heartbeatMs - 1, MIRROR_DEFAULTS)).toEqual([])
    expect(pickLensesToSync(lenses, MIRROR_DEFAULTS.heartbeatMs, MIRROR_DEFAULTS)).toEqual(['a'])
  })

  test('a negative maxPerFrame is clamped to zero and yields an empty array', () => {
    const lenses = [state({ id: 'a', dirty: true, lastSyncMs: 0 }), state({ id: 'b', dirty: true, lastSyncMs: 100 })]
    expect(pickLensesToSync(lenses, 1000, { ...MIRROR_DEFAULTS, maxPerFrame: -1 })).toEqual([])
  })
})

describe('nextMinInterval', () => {
  test('a cycle over budget doubles the interval', () => {
    expect(nextMinInterval(MIRROR_BUDGET_MS + 1, 100)).toBe(200)
  })
  test('the backoff is capped', () => {
    expect(nextMinInterval(999, MIRROR_MAX_INTERVAL_MS)).toBe(MIRROR_MAX_INTERVAL_MS)
  })
  test('a cheap cycle recovers gradually, never below the floor', () => {
    expect(nextMinInterval(1, 400)).toBe(300)
    expect(nextMinInterval(1, MIRROR_MIN_INTERVAL_MS)).toBe(MIRROR_MIN_INTERVAL_MS)
  })
})
