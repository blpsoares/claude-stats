import { describe, expect, it } from 'bun:test'
import { CREATION_CEILING, CREATION_STEPS, creationView, creationStepText } from './creationProgress'

describe('creationView', () => {
  it('is already moving on the first frame', () => {
    // A bar that starts at zero and sits there reads as a bar that is stuck. It starts SMALL and
    // it starts MOVING, which is the whole job of this thing.
    const v = creationView(0, false)
    expect(v.index).toBe(0)
    expect(v.percent).toBeGreaterThan(0)
    expect(v.complete).toBe(false)
  })

  it('never reaches 100 while the work is still going', () => {
    // The one rule this module exists for. A bar sitting at 100% while the session is still being
    // started is a lie, and it is the lie people remember — the same reason `contextFraction`
    // rounds DOWN so a gauge cannot read full with room left.
    for (const ms of [500, 2_000, 10_000, 120_000, 3_600_000]) {
      const v = creationView(ms, false)
      expect(v.percent, `${ms}ms`).toBeLessThanOrEqual(CREATION_CEILING)
      expect(v.complete, `${ms}ms`).toBe(false)
    }
  })

  it('goes straight to 100 the moment the session is ready', () => {
    // NOTHING WAITS FOR THE ANIMATION. The caller shows the session as soon as it can; this is
    // only what the bar reads if it happens to still be on screen.
    const v = creationView(300, true)
    expect(v.percent).toBe(100)
    expect(v.complete).toBe(true)
    expect(v.index).toBe(CREATION_STEPS.length - 1)
  })

  it('only ever moves forward', () => {
    let last = -1
    for (let ms = 0; ms <= 20_000; ms += 137) {
      const p = creationView(ms, false).percent
      expect(p).toBeGreaterThanOrEqual(last)
      last = p
    }
  })

  it('walks the steps in order as time passes', () => {
    const seen: number[] = []
    for (let ms = 0; ms <= 20_000; ms += 100) {
      const i = creationView(ms, false).index
      if (seen[seen.length - 1] !== i) seen.push(i)
    }
    expect(seen[0]).toBe(0)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    expect(Math.max(...seen)).toBeLessThanOrEqual(CREATION_STEPS.length - 1)
  })

  it('holds on the LAST step instead of running out of them', () => {
    // A slow machine must not leave the loader with nothing to say. It stays on the final step and
    // keeps easing toward the ceiling — honest, because that IS what is happening: still waiting.
    const v = creationView(10 * 60_000, false)
    expect(v.index).toBe(CREATION_STEPS.length - 1)
    expect(v.percent).toBeLessThanOrEqual(CREATION_CEILING)
  })

  it('treats a nonsense elapsed as the first frame rather than throwing', () => {
    for (const ms of [-1, NaN, Number.POSITIVE_INFINITY]) {
      const v = creationView(ms, false)
      expect(v.index).toBeGreaterThanOrEqual(0)
      expect(v.percent).toBeGreaterThanOrEqual(0)
      expect(v.percent).toBeLessThanOrEqual(CREATION_CEILING)
    }
  })
})

describe('creationStepText', () => {
  it('says every step in both languages', () => {
    for (let i = 0; i < CREATION_STEPS.length; i++) {
      expect(creationStepText(i, 'en', 'codex').length).toBeGreaterThan(0)
      expect(creationStepText(i, 'pt', 'codex').length).toBeGreaterThan(0)
    }
  })

  it('names the harness where the step is about the harness', () => {
    const withName = CREATION_STEPS.findIndex(s => s.en.includes('{harness}'))
    expect(withName).toBeGreaterThanOrEqual(0)
    expect(creationStepText(withName, 'en', 'antigravity')).toContain('antigravity')
    expect(creationStepText(withName, 'pt', 'antigravity')).toContain('antigravity')
    // …and never leaves the placeholder on screen when nobody named a harness.
    expect(creationStepText(withName, 'en', undefined)).not.toContain('{harness}')
  })

  it('answers for an index outside the list instead of returning undefined', () => {
    expect(creationStepText(-5, 'pt', 'kimi').length).toBeGreaterThan(0)
    expect(creationStepText(999, 'en', 'kimi').length).toBeGreaterThan(0)
  })
})
