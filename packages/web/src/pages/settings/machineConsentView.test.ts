import { describe, it, expect } from 'bun:test'
import { machineConsentView } from './machineConsentView'

describe('machineConsentView', () => {
  it('absent means the caller may not ask — the row draws nothing', () => {
    // An instance owner who is not this machine's account gets the field omitted, not null.
    expect(machineConsentView(undefined, true, 'en')).toBeNull()
    expect(machineConsentView(undefined, false, 'pt')).toBeNull()
  })

  it('null is SILENCE, never a refusal', () => {
    const v = machineConsentView(null, true, 'en')!
    expect(v.tone).toBe('silent')
    expect(v.screens).toBe(false)
    // The distinction that matters: it must not tell someone their machine refuses when it has
    // merely not spoken — that sends them to change a switch that is already set.
    expect(v.text).not.toContain('does not allow')
  })

  it('silence names the obvious reason when the machine is offline', () => {
    expect(machineConsentView(null, false, 'en')!.text).toContain('offline')
    expect(machineConsentView(null, true, 'en')!.text).toContain('has not said')
  })

  it('a stored refusal is its own tone and says so', () => {
    const v = machineConsentView({ sessions: false, screens: false, atMs: 1 }, true, 'en')!
    expect(v.tone).toBe('refused')
    expect(v.screens).toBe(false)
    expect(v.text).toContain('does not allow')
  })

  it('a grant without screens says the screen is NOT sent', () => {
    const v = machineConsentView({ sessions: true, screens: false, atMs: 1 }, true, 'en')!
    expect(v.tone).toBe('granted')
    expect(v.screens).toBe(false)
    expect(v.text).toContain('not sent')
  })

  it('a grant with screens says so', () => {
    const v = machineConsentView({ sessions: true, screens: true, atMs: 1 }, true, 'en')!
    expect(v.tone).toBe('granted')
    expect(v.screens).toBe(true)
    expect(v.text).toContain('session screen')
  })

  it('every state has words in both languages — a state with no sentence is a state to guess at', () => {
    const cases = [null, { sessions: false, screens: false, atMs: 1 }, { sessions: true, screens: false, atMs: 1 }, { sessions: true, screens: true, atMs: 1 }]
    for (const c of cases) {
      for (const lang of ['en', 'pt'] as const) {
        for (const online of [true, false]) {
          const v = machineConsentView(c, online, lang)!
          expect(v).not.toBeNull()
          expect(v.text.length).toBeGreaterThan(10)
        }
      }
    }
  })

  it('every state also has a SHORT label — the dense desktop row has no room for the sentence', () => {
    const cases = [null, { sessions: false, screens: false, atMs: 1 }, { sessions: true, screens: false, atMs: 1 }, { sessions: true, screens: true, atMs: 1 }]
    for (const c of cases) {
      for (const lang of ['en', 'pt'] as const) {
        for (const online of [true, false]) {
          const v = machineConsentView(c, online, lang)!
          expect(v.short.length).toBeGreaterThan(0)
          // A label is not a sentence: if they were the same string the row would be unreadable.
          expect(v.short.length).toBeLessThan(v.text.length)
        }
      }
    }
  })

  it('a grant and a refusal never share a short label', () => {
    const granted = machineConsentView({ sessions: true, screens: false, atMs: 1 }, true, 'en')!
    const refused = machineConsentView({ sessions: false, screens: false, atMs: 1 }, true, 'en')!
    const silent = machineConsentView(null, true, 'en')!
    expect(new Set([granted.short, refused.short, silent.short]).size).toBe(3)
  })

  it('the PT and EN sentences are actually different text, not one language twice', () => {
    expect(machineConsentView({ sessions: true, screens: true, atMs: 1 }, true, 'pt')!.text)
      .not.toBe(machineConsentView({ sessions: true, screens: true, atMs: 1 }, true, 'en')!.text)
  })
})

describe('the viewer who may administer but may not ask', () => {
  // An instance OWNER manages every machine (`canManageMachine` short-circuits on the role) and
  // owns only the ones linked to their account (`machineOwnedBy` does not) — so the server omits
  // `remoteConsent` and the row used to draw NOTHING. A working boundary that looks like a broken
  // feature; reported as "the sessions don't appear and I'm the owner".
  it('says WHY instead of drawing nothing', () => {
    const v = machineConsentView(undefined, true, 'en', false)
    expect(v).not.toBeNull()
    expect(v!.tone).toBe('not-owner')
    expect(v!.text).toMatch(/only by the accounts it is linked to/)
    // Stating a limit is not lifting it: the row's button is gated on `granted`.
    expect(v!.screens).toBe(false)
  })

  it('is really translated', () => {
    expect(machineConsentView(undefined, true, 'pt', false)!.text).toMatch(/só podem ser vistas/)
  })

  it('keeps drawing nothing when the caller cannot tell', () => {
    // A caller that does not pass the flag must not assert a reason it does not know.
    expect(machineConsentView(undefined, true, 'en')).toBeNull()
    expect(machineConsentView(undefined, true, 'en', true)).toBeNull()
  })
})
