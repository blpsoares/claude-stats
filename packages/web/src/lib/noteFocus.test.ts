import { expect, test } from 'bun:test'
import { focusMissNotice, isFocusedRow, rowsCarry } from './noteFocus'

test('the row the chip named is the focused one, and only it', () => {
  expect(isFocusedRow('superpowers:brainstorming', 'superpowers:brainstorming')).toBe(true)
  expect(isFocusedRow('graphify', 'superpowers:brainstorming')).toBe(false)
})

test('NO reference focuses NOTHING — never every row', () => {
  // The chip opens the tab with no reference whenever the note named nothing resolvable, and the
  // list must then look exactly as it always has.
  expect(isFocusedRow('graphify', undefined)).toBe(false)
})

test('a list that carries the reference needs no notice', () => {
  expect(rowsCarry(['a', 'superpowers:brainstorming'], 'superpowers:brainstorming')).toBe(true)
})

test('a reference no row carries is REPORTED, not silently ignored', () => {
  // The honest case: a skill loaded from a directory this machine no longer lists, or a list that
  // has not loaded. Opening the tab and highlighting nothing looks identical to a broken button.
  expect(rowsCarry(['a', 'b'], 'superpowers:brainstorming')).toBe(false)
  expect(focusMissNotice('superpowers:brainstorming', true))
    .toContain('superpowers:brainstorming')
  expect(focusMissNotice('superpowers:brainstorming', false).toLowerCase())
    .toContain('not in this list')
})

test('with no reference there is nothing to miss', () => {
  expect(rowsCarry(['a'], undefined)).toBe(true)
})
