import { describe, expect, it } from 'bun:test'
import { modeStyle } from './modeStyle'

describe('modeStyle', () => {
  it('gives each measured mode its own colour', () => {
    const ids = ['manual', 'plan', 'accept-edits', 'auto']
    const seen = ids.map(id => modeStyle(id).fg)
    expect(new Set(seen).size).toBe(ids.length)
  })

  it('NEVER uses the fault colour', () => {
    // `var(--accent-red)` is what a broken connection, an unauthorized member and an offline machine
    // wear. `auto mode` is how this product is normally used, and painting the ordinary state red is
    // the cry-wolf `withheldStyle.ts` and the connection pill's `stale` case both avoid. A mode is a
    // choice somebody made, not a fault.
    for (const id of ['manual', 'plan', 'accept-edits', 'auto']) {
      const s = modeStyle(id)
      expect(`${s.fg} ${s.bg} ${s.border}`).not.toContain('--accent-red')
    }
  })

  it('manual is the ordinary chip — nothing happens on its own, nothing is highlighted', () => {
    expect(modeStyle('manual').fg).toBe('var(--text-secondary)')
  })

  it('an unknown id is NEUTRAL, never another mode\'s colour', () => {
    // A future claude release can add a mode. An uncoloured chip still reads correctly; one wearing
    // somebody else's colour is a wrong answer given confidently.
    expect(modeStyle('some-future-mode')).toEqual(modeStyle('manual'))
    expect(modeStyle(undefined)).toEqual(modeStyle('manual'))
    expect(modeStyle('')).toEqual(modeStyle('manual'))
  })

  it('every style is complete — a chip may not end up with a missing colour', () => {
    for (const id of ['manual', 'plan', 'accept-edits', 'auto', 'nope']) {
      const s = modeStyle(id)
      for (const v of [s.fg, s.bg, s.border]) expect(v.length).toBeGreaterThan(0)
    }
  })
})
