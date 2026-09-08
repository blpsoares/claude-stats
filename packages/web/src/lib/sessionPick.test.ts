import { test, expect } from 'bun:test'
import {
  initialPick, pickAllState, pickConfirmLabel, pickedRows, togglePick, togglePickAll,
} from './sessionPick'

const rows = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }]

/**
 * The one place the two features differ. Reopening what a crash took has a defensible "all"; typing
 * into every live session does not.
 */
test('reopen opens ticked, broadcast opens empty', () => {
  expect([...initialPick(rows, 'all')]).toEqual(['a', 'b', 'c'])
  expect([...initialPick(rows, 'none')]).toEqual([])
})

test('the header box has three states, and `some` is not `none`', () => {
  expect(pickAllState(rows, new Set(['a', 'b', 'c']))).toBe('all')
  expect(pickAllState(rows, new Set())).toBe('none')
  expect(pickAllState(rows, new Set(['a']))).toBe('some')
  expect(pickAllState([], new Set())).toBe('none')
})

/**
 * A half-ticked list means somebody has been choosing. Of the two readings of one click, the safe
 * one starts them over rather than silently adding back what they just removed.
 */
test('the header box CLEARS from `some`, and from `all`', () => {
  expect([...togglePickAll(rows, new Set(['a']))]).toEqual(['a', 'b', 'c'])
  expect([...togglePickAll(rows, new Set(['a', 'b', 'c']))]).toEqual([])
  expect([...togglePickAll(rows, new Set())]).toEqual(['a', 'b', 'c'])
})

test('one row toggles on and off without touching the others', () => {
  const p = togglePick(new Set(['a']), 'b')
  expect([...p].sort()).toEqual(['a', 'b'])
  expect([...togglePick(p, 'a')]).toEqual(['b'])
})

/**
 * A Set iterates in CLICK order, not reading order. The confirmation's list and the server's report
 * are checked against the screen, so the two have to agree.
 */
test('picked rows come back in the order they were SHOWN', () => {
  expect(pickedRows(rows, new Set(['c', 'a'])).map(r => r.id)).toEqual(['a', 'c'])
})

/**
 * The count is in the label, always: this button starts assistants or writes into them, and the
 * number is what a person checks before pressing.
 */
test('the button carries the count, and singular is not "1 sessions"', () => {
  expect(pickConfirmLabel(1, 'reopen', true).label).toBe('Reabrir 1 sessão')
  expect(pickConfirmLabel(3, 'reopen', true).label).toBe('Reabrir 3 sessões')
  expect(pickConfirmLabel(1, 'send', false).label).toBe('Send to 1 session')
  expect(pickConfirmLabel(4, 'send', false).label).toBe('Send to 4 sessions')
})

test('nothing picked is not pressable, and says so instead of showing a zero', () => {
  const v = pickConfirmLabel(0, 'reopen', true)
  expect(v.enabled).toBe(false)
  expect(v.label).not.toContain('0')
  expect(pickConfirmLabel(0, 'send', false).enabled).toBe(false)
})
