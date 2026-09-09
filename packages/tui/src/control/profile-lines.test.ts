import { describe, expect, it } from 'bun:test'
import { profileLines } from './profile-lines'
import { controlStrings } from './i18n'
import type { Baseline } from '@agentistics/core'

const S = controlStrings('en')

const baseline = (over: Partial<Baseline['metrics']> = {}): Baseline => ({
  windowDays: 30,
  sessions: 692,
  metrics: {
    compacts: { median: 0, mean: 0.066, n: 700, nonZero: 23 },
    messages: { median: 30, mean: 92, n: 692, nonZero: 692 },
    activeMinutes: { median: 12, mean: 40, n: 500, nonZero: 480 },
    tokens: { median: 1000, mean: 5000, n: 692, nonZero: 692 },
    toolErrors: { median: 0, mean: 2, n: 692, nonZero: 100 },
    skills: { median: 0, mean: 0.3, n: 57, nonZero: 40 },
    mcpServers: { median: 0, mean: 1, n: 692, nonZero: 88 },
    subagents: { median: 0, mean: 2, n: 50, nonZero: 34 },
    ...over,
  },
})

describe('profileLines', () => {
  it('states the median with the metric it belongs to', () => {
    const out = profileLines(baseline(), 80, S).join('\n')
    expect(out).toContain('30')
    expect(out).toContain('messages')
  })

  it('names the window and the denominator, because a baseline without them is an opinion', () => {
    const out = profileLines(baseline(), 80, S).join('\n')
    expect(out).toContain('30')
    expect(out).toContain('692')
  })

  it('drops a metric no session could answer rather than printing a zero', () => {
    // A row reading "skills: 0" on a machine where no transcript survived would claim the user
    // never invokes one. `n === 0` means unanswerable, and unanswerable is absent.
    const out = profileLines(baseline({ skills: { median: 0, mean: 0, n: 0, nonZero: 0 } }), 80, S)
    expect(out.join('\n')).not.toContain('skills')
  })

  it('returns nothing at all when there is no baseline', () => {
    expect(profileLines(undefined, 80, S)).toEqual([])
  })

  it('never emits a line wider than the width it was given', () => {
    for (const w of [30, 50, 80, 120]) {
      for (const line of profileLines(baseline(), w, S)) {
        expect(line.length).toBeLessThanOrEqual(w)
      }
    }
  })
})
