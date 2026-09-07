import { describe, it, expect } from 'bun:test'
import { resolveRemoteConsent, NO_REMOTE_CONSENT } from './remoteSessions'

describe('resolveRemoteConsent', () => {
  it('an absent config agrees to nothing', () => {
    // The whole point of the strict reading: every machine that upgrades into this feature stays
    // off until somebody chooses otherwise.
    expect(resolveRemoteConsent(undefined, undefined)).toEqual({ sessions: false, screens: false })
  })

  it('false is off, exactly like absent', () => {
    expect(resolveRemoteConsent(false, false)).toEqual({ sessions: false, screens: false })
  })

  it('sessions alone grants the fleet and not the screen', () => {
    expect(resolveRemoteConsent(true, undefined)).toEqual({ sessions: true, screens: false })
    expect(resolveRemoteConsent(true, false)).toEqual({ sessions: true, screens: false })
  })

  it('screens needs sessions — a screen with no fleet is the transcript channel alone', () => {
    // Reachable by hand-editing preferences.json, and by any write that sets one field before the
    // other. The honest reading is "no", not "the terminal but not the row it belongs to".
    expect(resolveRemoteConsent(false, true)).toEqual({ sessions: false, screens: false })
    expect(resolveRemoteConsent(undefined, true)).toEqual({ sessions: false, screens: false })
  })

  it('both on is the only shape that grants a screen', () => {
    expect(resolveRemoteConsent(true, true)).toEqual({ sessions: true, screens: true })
  })

  it('only a literal true counts — a truthy value is not consent', () => {
    // preferences.json is hand-editable and older writers exist; `'yes'`/`1` must not read as an
    // agreement nobody typed into the switch.
    expect(resolveRemoteConsent('yes' as unknown as boolean, 1 as unknown as boolean))
      .toEqual({ sessions: false, screens: false })
  })

  it('NO_REMOTE_CONSENT is what an absent config resolves to', () => {
    expect(resolveRemoteConsent(undefined, undefined)).toEqual(NO_REMOTE_CONSENT)
  })
})
