import { describe, it, expect } from 'bun:test'
import { machineFleetPanelView } from './machineFleetView'

const row = { id: 's1', title: 't', harness: 'claude', state: 'working', stateLabel: 'working', project: 'p', cwd: '/p' }

describe('machineFleetPanelView', () => {
  it('each refusal is its own sentence — the four never collapse into one', () => {
    const texts = (['not-owner', 'refused', 'offline', 'silent'] as const)
      .map(reason => machineFleetPanelView({ reply: null, reason }, 'en').text)
    expect(new Set(texts).size).toBe(4)
    for (const t of texts) expect(t.length).toBeGreaterThan(10)
  })

  it('a refusal names WHERE the switch is — it is not on this page', () => {
    const v = machineFleetPanelView({ reply: null, reason: 'refused' }, 'en')
    expect(v.tone).toBe('blocked')
    expect(v.text).toMatch(/that machine’s own settings/)
  })

  it('a silent machine is never reported as having no sessions', () => {
    // It is connected and did not answer — an older build does exactly this.
    const v = machineFleetPanelView({ reply: null, reason: 'silent' }, 'en')
    expect(v.text).not.toMatch(/no sessions/i)
    expect(v.text).toMatch(/did not answer/)
  })

  it('offline says offline, not "no sessions"', () => {
    expect(machineFleetPanelView({ reply: null, reason: 'offline' }, 'en').text).toMatch(/offline/i)
  })

  it('only a REAL reply may say the fleet is empty', () => {
    const v = machineFleetPanelView({ reply: { rows: [], attention: 0, withheld: 0 } }, 'en')
    expect(v.tone).toBe('empty')
    expect(v.text).toMatch(/No sessions open/)
  })

  it('counts the rows it has', () => {
    expect(machineFleetPanelView({ reply: { rows: [row], attention: 0, withheld: 0 } }, 'en').text).toBe('1 session')
    expect(machineFleetPanelView({ reply: { rows: [row, row, row], attention: 0, withheld: 0 } }, 'en').text).toBe('3 sessions')
  })

  it('withheld sessions are STATED, never silently missing', () => {
    // An allowlist can legitimately make the relayed fleet much shorter than what is running.
    const v = machineFleetPanelView({ reply: { rows: [row], attention: 0, withheld: 2 } }, 'en')
    expect(v.notes.some(n => /2 sessions are not shared/.test(n))).toBe(true)
    expect(machineFleetPanelView({ reply: { rows: [row], attention: 0, withheld: 1 } }, 'en').notes[0])
      .toMatch(/1 session is not shared/)
  })

  it("the machine's own caveat comes first, and both notes can stand together", () => {
    const v = machineFleetPanelView({ reply: { rows: [row], attention: 0, withheld: 1, unavailable: 'tmux is not installed' } }, 'en')
    expect(v.notes[0]).toBe('tmux is not installed')
    expect(v.notes).toHaveLength(2)
  })

  it('nothing withheld and no caveat means no notes at all', () => {
    expect(machineFleetPanelView({ reply: { rows: [row], attention: 0, withheld: 0 } }, 'en').notes).toEqual([])
  })

  it('a failed request is blocked with words, never an empty list', () => {
    const v = machineFleetPanelView(null, 'en')
    expect(v.tone).toBe('blocked')
    expect(v.text.length).toBeGreaterThan(10)
  })

  it('every branch has real PT text, not the English one twice', () => {
    const cases = [
      null,
      { reply: null, reason: 'refused' as const },
      { reply: null, reason: 'offline' as const },
      { reply: null, reason: 'silent' as const },
      { reply: null, reason: 'not-owner' as const },
      { reply: { rows: [], attention: 0, withheld: 0 } },
      { reply: { rows: [row], attention: 0, withheld: 2, unavailable: 'x' } },
    ]
    for (const c of cases) {
      const en = machineFleetPanelView(c, 'en')
      const pt = machineFleetPanelView(c, 'pt')
      expect(pt.text.length).toBeGreaterThan(0)
      if (c !== null && c.reply && c.reply.rows.length > 0) continue // the count reads alike
      expect(pt.text).not.toBe(en.text)
    }
  })
})
