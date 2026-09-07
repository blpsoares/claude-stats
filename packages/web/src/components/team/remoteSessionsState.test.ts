import { describe, it, expect } from 'bun:test'
import { remotePanelView, consentPatchFor } from './remoteSessionsState'
import type { ConnectionStatusEntry } from './statusTypes'

function entry(extra?: Partial<ConnectionStatusEntry>): ConnectionStatusEntry {
  return {
    id: 'c1', endpoint: 'https://c.example.com', org: 'default', user: 'alice',
    lastSuccessAt: null, errKind: null, latencyMs: null,
    shareMode: 'denylist', deniedRepos: 0, deniedProjects: 0, allowedCount: 0, deniedCount: 0,
    restricted: false, boundary: null, prehistorySessions: null, canForget: false,
    centralTooOld: true, resync: null, pendingRules: false,
    ...extra,
  }
}

describe('remotePanelView', () => {
  it('an absent entry is OFF — not being told is not an agreement', () => {
    // Covers both the first poll and an older server build that sends neither field.
    expect(remotePanelView(undefined)).toEqual({ level: 'off', screensAvailable: false, announcementPending: false })
  })

  it('a server that sends neither field reads as off', () => {
    expect(remotePanelView(entry()).level).toBe('off')
  })

  it('the fleet switch alone is the `sessions` level, and it unlocks the screen switch', () => {
    const v = remotePanelView(entry({ remoteSessions: true }))
    expect(v.level).toBe('sessions')
    expect(v.screensAvailable).toBe(true)
  })

  it('both switches is the `screens` level', () => {
    expect(remotePanelView(entry({ remoteSessions: true, remoteScreens: true })).level).toBe('screens')
  })

  it('a screen grant with no fleet grant is off, and the screen switch stays locked', () => {
    // The server resolves this away before it reaches the wire; the card must not re-open it if a
    // future writer ever gets the pair wrong.
    const v = remotePanelView(entry({ remoteSessions: false, remoteScreens: true }))
    expect(v.level).toBe('off')
    expect(v.screensAvailable).toBe(false)
  })

  it('a failing connection marks the announcement pending — but only when something IS granted', () => {
    expect(remotePanelView(entry({ remoteSessions: true, errKind: 'net' })).announcementPending).toBe(true)
    expect(remotePanelView(entry({ remoteSessions: true, errKind: 'auth' })).announcementPending).toBe(true)
    // Nothing granted, nothing to announce — a warning here would be noise on a card that is off.
    expect(remotePanelView(entry({ errKind: 'net' })).announcementPending).toBe(false)
  })

  it('a healthy connection that simply has not pushed recently is NOT pending', () => {
    // lastSuccessAt measures the metrics push, not the reverse channel the announcement rides.
    // Reading it as "not announced" would warn on every machine following a slow central cadence.
    expect(remotePanelView(entry({ remoteSessions: true, lastSuccessAt: null, errKind: null })).announcementPending).toBe(false)
  })
})

describe('consentPatchFor', () => {
  const off = remotePanelView(undefined)
  const sessionsOn = remotePanelView(entry({ remoteSessions: true }))
  const screensOn = remotePanelView(entry({ remoteSessions: true, remoteScreens: true }))

  it('turning the fleet on from off grants the fleet and no screen', () => {
    expect(consentPatchFor(off, 'sessions')).toEqual({ allowRemoteSessions: true, allowRemoteScreens: false })
  })

  it('turning the fleet off takes the screens with it', () => {
    expect(consentPatchFor(screensOn, 'sessions')).toEqual({ allowRemoteSessions: false, allowRemoteScreens: false })
    expect(consentPatchFor(sessionsOn, 'sessions')).toEqual({ allowRemoteSessions: false, allowRemoteScreens: false })
  })

  it('the screen switch toggles only itself, and always states the fleet it depends on', () => {
    expect(consentPatchFor(sessionsOn, 'screens')).toEqual({ allowRemoteSessions: true, allowRemoteScreens: true })
    expect(consentPatchFor(screensOn, 'screens')).toEqual({ allowRemoteSessions: true, allowRemoteScreens: false })
  })

  it('every patch states the whole pair — a request is an END STATE, never a partial edit', () => {
    for (const view of [off, sessionsOn, screensOn]) {
      for (const which of ['sessions', 'screens'] as const) {
        const body = consentPatchFor(view, which)
        expect(Object.keys(body).sort()).toEqual(['allowRemoteScreens', 'allowRemoteSessions'])
        expect(typeof body.allowRemoteSessions).toBe('boolean')
        expect(typeof body.allowRemoteScreens).toBe('boolean')
      }
    }
  })
})
