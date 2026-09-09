import { describe, expect, test } from 'bun:test'
import {
  ARRIVAL_WAIT_MS, arrivalFor, reopenedSessionRoute, sessionPath, stillArriving,
} from './sessionRoute'

test('an external id keeps its directory inside ONE path segment', () => {
  // Raw interpolation made this three segments and matched no route — a blank page.
  const id = 'external:antigravity:/home/mithrandir/agentistics:1788625485620'
  const path = sessionPath(id)
  expect(path.slice('/sessions/'.length)).not.toContain('/')
  expect(decodeURIComponent(path.slice('/sessions/'.length))).toBe(id)
})

test('a closed id round-trips too', () => {
  const id = 'closed:731e8d13-db8a-465b-81fc-3c520aba76d4'
  expect(decodeURIComponent(sessionPath(id).slice('/sessions/'.length))).toBe(id)
})

test('a plain managed id is unchanged in practice', () => {
  expect(sessionPath('a61d428316')).toBe('/sessions/a61d428316')
})

test('a windows-shaped cwd survives as well', () => {
  const id = 'external:claude:C:\\Users\\u\\proj:12'
  expect(decodeURIComponent(sessionPath(id).slice('/sessions/'.length))).toBe(id)
})

describe('arrivalFor — the budget belongs to the ID, not to the mount', () => {
  test('an announced id starts the wait', () => {
    expect(arrivalFor(null, 'b', true, 1000)).toEqual({ id: 'b', since: 1000 })
  })

  test('the same id is NOT re-stamped — an unrelated re-render must not extend the budget', () => {
    const prev = { id: 'b', since: 1000 }
    expect(arrivalFor(prev, 'b', true, 9000)).toBe(prev)
  })

  test('a DIFFERENT id is a new arrival — the reopen case the mount-scoped budget missed', () => {
    // `/sessions/A` -> `/sessions/B` is the SAME <Route>, so the page never remounts and the stamp
    // taken when it was opened was still in force. A reopen minutes in got no wait at all, and the
    // fleet overview showed for the whole poll interval — reported as "me joga pra tela de
    // sessions".
    expect(arrivalFor({ id: 'a', since: 1000 }, 'b', true, 500_000))
      .toEqual({ id: 'b', since: 500_000 })
  })

  test('nothing announced is not a wait — navigating to a session that already exists', () => {
    expect(arrivalFor({ id: 'a', since: 1000 }, 'a', false, 2000)).toBeNull()
    expect(arrivalFor(null, undefined, true, 2000)).toBeNull()
  })
})

describe('stillArriving — bounded, because an endless loader cannot be told from a dead id', () => {
  test('inside the budget, for the id it was stamped for', () => {
    expect(stillArriving({ id: 'b', since: 1000 }, 'b', 1000 + ARRIVAL_WAIT_MS - 1)).toBe(true)
  })

  test('past the budget it stops claiming', () => {
    expect(stillArriving({ id: 'b', since: 1000 }, 'b', 1000 + ARRIVAL_WAIT_MS)).toBe(false)
  })

  test('never for a different id, and never with no record', () => {
    expect(stillArriving({ id: 'b', since: 1000 }, 'c', 1200)).toBe(false)
    expect(stillArriving(null, 'b', 1200)).toBe(false)
  })
})

describe('reopenedSessionRoute — the landing carries the wait', () => {
  test('the path is the session path, and the state announces the arrival', () => {
    const r = reopenedSessionRoute('new-1', { harness: 'claude', title: 'FILTRO TODAY' })
    expect(r.path).toBe('/sessions/new-1')
    expect(r.options.state.creating).toEqual({ harness: 'claude', label: 'FILTRO TODAY' })
  })

  test('with no row to name it the state still EXISTS — its presence is what says "coming"', () => {
    const r = reopenedSessionRoute('new-1')
    expect(r.options.state.creating).toEqual({})
    expect(stillArriving(arrivalFor(null, 'new-1', true, 0), 'new-1', 0)).toBe(true)
  })

  test('an id with slashes is still one path segment', () => {
    expect(reopenedSessionRoute('external:agy:/home/x:1').path)
      .toBe(sessionPath('external:agy:/home/x:1'))
  })
})
