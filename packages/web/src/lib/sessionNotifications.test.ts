import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { SessionMeta } from '@agentistics/core'
import {
  DEFAULT_NOTIFICATION_SETTINGS, handleSessionStateTransitions, notifyFleetTransitions,
  resetNotificationMemory, type SessionActivity,
} from './sessionNotifications'

/**
 * These tests exist because this module reaches the user through the OS: a browser notification and
 * a sound. A wrong number on a chart is read by someone who chose to look at the chart; a wrong
 * notification interrupts whatever they were doing instead. So the two failures pinned here are the
 * two that were live in production — one that fired alerts nobody asked for, and one that put a
 * Portuguese word inside an English sentence.
 */

const STORAGE_KEY = 'agentistics.notifications'

/** A minimal localStorage + Notification, so the module runs outside a browser. */
function installBrowser(): { notifications: Array<{ title: string; body: string }> } {
  const store = new Map<string, string>()
  const notifications: Array<{ title: string; body: string }> = []
  const g = globalThis as Record<string, unknown>
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }
  g.window = g
  class FakeNotification {
    static permission = 'granted'
    constructor(title: string, opts?: { body?: string }) {
      notifications.push({ title, body: opts?.body ?? '' })
    }
  }
  g.Notification = FakeNotification
  // Sound is a no-op here: `playNotificationSound` swallows a missing AudioContext by design.
  store.set(STORAGE_KEY, JSON.stringify({
    ...DEFAULT_NOTIFICATION_SETTINGS,
    enabled: true,
    soundEnabled: false,
    events: { 'waiting-approval': true, waiting: true, working: true, exited: true },
  }))
  return { notifications }
}

const session = (id: string): SessionMeta => ({
  session_id: id,
  project_path: '/home/padawan/agentistics',
  harness: 'claude',
  first_prompt: 'the migration one',
} as SessionMeta)

let captured: Array<{ title: string; body: string }>

beforeEach(() => { captured = installBrowser().notifications; resetNotificationMemory() })
afterEach(() => {
  const g = globalThis as Record<string, unknown>
  delete g.Notification
  delete g.localStorage
})

const map = new Map([['a', session('a')], ['b', session('b')]])

describe('what counts as news', () => {
  it('says nothing when a state has not changed', () => {
    const same: Record<string, SessionActivity> = { a: 'waiting' }
    handleSessionStateTransitions(same, same, map, 'en')
    expect(captured).toHaveLength(0)
  })

  it('reports a real transition', () => {
    handleSessionStateTransitions({ a: 'working' }, { a: 'waiting-approval' }, map, 'en')
    expect(captured).toHaveLength(1)
    expect(captured[0]!.title).toContain('Needs Approval')
  })

  it('would announce every running session against an EMPTY previous map', () => {
    // The production bug, pinned as the behaviour of this function rather than hidden: with no
    // previous state every session looks new. That is correct HERE — a session that appears really
    // is news — and catastrophic when the caller hands it a cold start, which is why the page now
    // takes a silent baseline on its first poll before it ever calls this. Both halves are needed:
    // if this ever stops firing for genuinely new sessions, the page's guard would hide it.
    handleSessionStateTransitions({}, { a: 'waiting', b: 'waiting-approval' }, map, 'en')
    expect(captured).toHaveLength(2)
  })
})

describe('the language of the sentence', () => {
  it('keeps an English notification entirely English', () => {
    // It read "Session … (CLAUDE CODE em agentistics) is waiting …" — one Portuguese connector in
    // the middle of an English sentence, on a surface people read at a glance.
    handleSessionStateTransitions({ a: 'working' }, { a: 'waiting' }, map, 'en')
    expect(captured[0]!.body).toContain(' in agentistics')
    expect(captured[0]!.body).not.toContain(' em ')
  })

  it('keeps a Portuguese notification Portuguese', () => {
    handleSessionStateTransitions({ a: 'working' }, { a: 'waiting' }, map, 'pt')
    expect(captured[0]!.body).toContain(' em agentistics')
  })
})


describe('the caller that was missing — the live fleet', () => {
  it('announces nothing on the FIRST snapshot, and returns the states to compare against', () => {
    // Opening a machine with nine blocked sessions must not greet the reader with nine toasts
    // about things that happened while they were away.
    const rows = [{ id: 'a', state: 'waiting-approval' }, { id: 'b', state: 'working' }]
    const out = notifyFleetTransitions(null, rows, 'en')
    expect(out).toEqual({ a: 'waiting-approval', b: 'working' })
    expect(captured).toHaveLength(0)
  })

  it('rings on a CONFIRMED transition and stays quiet on the level', () => {
    const first = notifyFleetTransitions(null, [{ id: 'a', state: 'working' }], 'en')
    expect(captured).toHaveLength(0)
    // First sighting of `waiting` — held back until it is seen again.
    const second = notifyFleetTransitions(first, [{ id: 'a', state: 'waiting' }], 'en')
    expect(captured).toHaveLength(0)
    const third = notifyFleetTransitions(second, [{ id: 'a', state: 'waiting' }], 'en')
    expect(captured).toHaveLength(1)
    notifyFleetTransitions(third, [{ id: 'a', state: 'waiting' }], 'en')
    expect(captured).toHaveLength(1)
  })

  it('a state that FLICKERS for one poll is never announced', () => {
    // The reported storm: a pane repaints, the row reads `working` for a single poll and goes back.
    let snap = notifyFleetTransitions(null, [{ id: 'a', state: 'waiting' }], 'en')
    for (let i = 0; i < 6; i++) {
      snap = notifyFleetTransitions(snap, [{ id: 'a', state: i % 2 === 0 ? 'working' : 'waiting' }], 'en')
    }
    expect(captured).toHaveLength(0)
  })

  it('a row that leaves the fleet is forgotten, so its return is news again', () => {
    let snap = notifyFleetTransitions(null, [{ id: 'a', state: 'working' }], 'en')
    snap = notifyFleetTransitions(snap, [], 'en')
    expect(snap).toEqual({})
  })

  it('has no words for what a row IS, so those are not events', () => {
    const out = notifyFleetTransitions(null, [
      { id: 'a', state: 'lost' }, { id: 'b', state: 'closed' }, { id: 'c', state: 'unknown' },
    ], 'en')
    expect(out).toEqual({})
  })

  it('names the session from the fleet ROW — it is not a transcript', () => {
    const row = (state: string) =>
      [{ id: 'a', state, title: 'the migration one', cwd: '/home/padawan/agentistics', harness: 'claude' }]
    let snap = notifyFleetTransitions(null, row('working'), 'en')
    // Two polls, because a state is only announced once it has been confirmed.
    snap = notifyFleetTransitions(snap, row('waiting'), 'en')
    notifyFleetTransitions(snap, row('waiting'), 'en')
    expect(captured[0]?.title).toContain('the migration one')
    expect(captured[0]?.body).toContain('agentistics')
  })
})

describe('a row nobody watched arrive is not an event that happened', () => {
  /**
   * The report: "notificações de sessões FECHADAS estão disparando para sessões que já fecharam."
   *
   * A SECOND rule, composed with the two-poll confirmation above rather than replacing it. That one
   * settles WHEN a state is believed; this one settles whether believing it is NEWS. Rows join and
   * leave this list for reasons that are not the session changing state — a short-lived session
   * born and finished inside one poll interval, a retired predecessor `collapseSupersededSessions`
   * hides and shows again, a row reading `lost` for one poll (which has no words here, so it leaves
   * the map) and returning as `exited` on the next. Each arrives with no previous state, and the
   * confirmation alone only DELAYS the announcement by one poll.
   *
   * Every test here polls the same fleet TWICE, because that is what confirmation costs.
   */
  /** Poll the same rows twice — one state, confirmed. Returns the snapshot to carry forward. */
  const settle = (
    prev: Record<string, SessionActivity> | null,
    rows: { id: string; state: string }[],
  ): Record<string, SessionActivity> => {
    const once = notifyFleetTransitions(prev, rows, 'en')
    return notifyFleetTransitions(once, rows, 'en')
  }

  it('does not announce a session first seen already finished', () => {
    const alive = settle(null, [{ id: 'a', state: 'working' }])
    settle(alive, [{ id: 'a', state: 'working' }, { id: 'b', state: 'exited' }])
    expect(captured).toHaveLength(0)
  })

  it('still announces a session it watched finish', () => {
    const alive = settle(null, [{ id: 'a', state: 'working' }])
    settle(alive, [{ id: 'a', state: 'exited' }])
    expect(captured).toHaveLength(1)
    expect(captured[0]!.title).toContain('Session Closed')
  })

  it('does not re-announce a finished row that left the list and came back', () => {
    // `lost` carries no words here, so the row drops out of the activity map and returns with no
    // previous state — which is exactly the flapping case, and it rang every time it came back.
    const alive = settle(null, [{ id: 'a', state: 'working' }])
    const ended = settle(alive, [{ id: 'a', state: 'exited' }])
    expect(captured).toHaveLength(1)
    const gone = settle(ended, [{ id: 'a', state: 'lost' }])
    settle(gone, [{ id: 'a', state: 'exited' }])
    expect(captured).toHaveLength(1)
  })

  it('records a first-sighted row so its NEXT change is news', () => {
    // Withholding the announcement must not withhold the BASELINE, or a row first seen as
    // `working` could never announce anything it did afterwards.
    const alive = settle(null, [{ id: 'a', state: 'working' }])
    const both = settle(alive, [{ id: 'a', state: 'working' }, { id: 'b', state: 'working' }])
    expect(captured).toHaveLength(0)
    expect(both).toEqual({ a: 'working', b: 'working' })
    settle(both, [{ id: 'a', state: 'working' }, { id: 'b', state: 'waiting' }])
    expect(captured).toHaveLength(1)
    expect(captured[0]!.title).toContain('Waiting Input')
  })

  it('makes the ONE exception for a session blocked on a person', () => {
    // Silence on `waiting-approval` costs the session itself: it stays blocked until somebody
    // answers, and there may never be another transition to ring on.
    const alive = settle(null, [{ id: 'a', state: 'working' }])
    settle(alive, [{ id: 'a', state: 'working' }, { id: 'b', state: 'waiting-approval' }])
    expect(captured).toHaveLength(1)
    expect(captured[0]!.title).toContain('Needs Approval')
  })

  it('still waits for the confirmation before making that exception', () => {
    // The exception is about whether a state is NEWS, never about whether it is real — a
    // `waiting-approval` seen for a single poll is exactly the flicker the rule above exists for.
    const alive = settle(null, [{ id: 'a', state: 'working' }])
    notifyFleetTransitions(alive, [{ id: 'a', state: 'working' }, { id: 'b', state: 'waiting-approval' }], 'en')
    expect(captured).toHaveLength(0)
  })
})
