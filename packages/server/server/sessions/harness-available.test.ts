import { expect, test, describe } from 'bun:test'
import { HARNESS_ORDER } from '@agentistics/core'
import { SPAWN_SPECS } from './spawn-spec'
import { availableHarnesses, startableHarnessIds } from './harness-available'

describe('availableHarnesses — what the session wizard may offer', () => {
  test('startable is spec-derived, never a second hand-written list', () => {
    expect(startableHarnessIds()).toEqual(HARNESS_ORDER.filter(h => SPAWN_SPECS[h] !== null))
  })

  test('the offer is a subset of what agentop knows how to spawn', () => {
    const startable = new Set(startableHarnessIds())
    for (const id of availableHarnesses().ids) expect(startable.has(id)).toBe(true)
  })

  test('never empty — a wizard offering nothing is indistinguishable from a broken one', () => {
    // The fallback: when no CLI resolves on PATH the machine cannot TELL, and the honest answer is
    // every startable harness rather than a screen that refuses to start anything.
    expect(availableHarnesses().ids.length).toBeGreaterThan(0)
  })
})
