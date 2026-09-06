import { describe, it, expect } from 'bun:test'
import {
  remoteActionAllowed, remoteActionRefusal, REMOTE_SCREENLESS_ACTIONS, REMOTE_SCREEN_ACTIONS,
} from './machineActions'

const granted = { sessions: true, screens: false }
const withScreens = { sessions: true, screens: true }
const nothing = { sessions: false, screens: false }

describe('remoteActionAllowed', () => {
  it('allows every screenless verb once the fleet consent is given', () => {
    for (const a of REMOTE_SCREENLESS_ACTIONS) expect(remoteActionAllowed(a, granted)).toBe(true)
  })

  it('allows nothing at all without the fleet consent', () => {
    // The machine's own switch is the gate; a central that asks anyway is refused by the member.
    for (const a of REMOTE_SCREENLESS_ACTIONS) expect(remoteActionAllowed(a, nothing)).toBe(false)
    for (const a of REMOTE_SCREEN_ACTIONS) expect(remoteActionAllowed(a, nothing)).toBe(false)
  })

  it('refuses approve and prompt on the FLEET consent alone — the screen is what they need', () => {
    // Answering a dialog needs the dialog to be READABLE: the keystroke cannot know which option it
    // is taking, and a claude permission prompt is `1. Yes / 2. Yes, always / 3. No`. A central
    // holding the verbs without the screen would be choosing for the person.
    for (const a of REMOTE_SCREEN_ACTIONS) expect(remoteActionAllowed(a, granted)).toBe(false)
  })

  it('allows them once the SCREEN consent is given — that switch is what it is for', () => {
    for (const a of REMOTE_SCREEN_ACTIONS) expect(remoteActionAllowed(a, withScreens)).toBe(true)
    // And the screenless ones are unaffected by it.
    for (const a of REMOTE_SCREENLESS_ACTIONS) expect(remoteActionAllowed(a, withScreens)).toBe(true)
  })

  it('is CLOSED — an action it does not know is refused', () => {
    // A new FleetActionId added upstream must be listed here on purpose before a central can
    // drive it. Same allowlist reasoning as the row reduction, applied to verbs.
    for (const junk of ['', 'wipe', 'exec', 'RENAME', 'rename ', 'approve;kill']) {
      expect(remoteActionAllowed(junk, withScreens)).toBe(false)
    }
  })

  it('the two lists never overlap', () => {
    const screenless = new Set<string>(REMOTE_SCREENLESS_ACTIONS)
    for (const a of REMOTE_SCREEN_ACTIONS) expect(screenless.has(a)).toBe(false)
  })
})

describe('remoteActionRefusal', () => {
  it('says nothing for an action that is offered', () => {
    for (const a of REMOTE_SCREENLESS_ACTIONS) expect(remoteActionRefusal(a, granted)).toBeNull()
  })

  it('distinguishes the three reasons — a missing verb must never be unexplained', () => {
    expect(remoteActionRefusal('rename', nothing)).toBe('no-consent')
    expect(remoteActionRefusal('approve', granted)).toBe('needs-screen')
    // With the screen granted there is nothing left to explain: a refusal code for an action that
    // IS allowed would put a sentence under a button that works.
    expect(remoteActionRefusal('prompt', withScreens)).toBeNull()
    expect(remoteActionRefusal('approve', withScreens)).toBeNull()
    expect(remoteActionRefusal('teleport', granted)).toBe('unknown')
  })

  it('no consent outranks everything — it is the reason the user can act on', () => {
    expect(remoteActionRefusal('approve', nothing)).toBe('no-consent')
    expect(remoteActionRefusal('teleport', nothing)).toBe('no-consent')
  })

  it('agrees with remoteActionAllowed on every case', () => {
    // Two predicates over one policy is two places to drift; this pins them together.
    const actions = [...REMOTE_SCREENLESS_ACTIONS, ...REMOTE_SCREEN_ACTIONS, 'nonsense']
    for (const consent of [nothing, granted, withScreens]) {
      for (const a of actions) {
        expect(remoteActionAllowed(a, consent)).toBe(remoteActionRefusal(a, consent) === null)
      }
    }
  })
})
