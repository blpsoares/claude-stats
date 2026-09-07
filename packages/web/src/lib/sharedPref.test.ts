import { expect, test } from 'bun:test'
import { sameValue } from './sharedPref'

test('equal values compare equal even as different objects', () => {
  expect(sameValue(['a', 'b'], ['a', 'b'])).toBe(true)
  expect(sameValue({ x: 1 }, { x: 1 })).toBe(true)
})

test('a changed value compares unequal', () => {
  expect(sameValue(['a'], ['a', 'b'])).toBe(false)
  expect(sameValue({ x: 1 }, { x: 2 })).toBe(false)
})

test('order is a change — a reordered pin list must notify', () => {
  expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(false)
})

test('absent and empty are different, so an unread pref never reads as a cleared one', () => {
  expect(sameValue(undefined, [])).toBe(false)
})
