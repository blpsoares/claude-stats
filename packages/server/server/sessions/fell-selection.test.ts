import { test, expect } from 'bun:test'
import { selectFell } from './fell-selection'
import type { ManagedSession } from './types'

const e = (id: string): ManagedSession => ({
  id, harness: 'claude', cwd: '/p', createdAt: '2026-09-01T00:00:00Z',
} as unknown as ManagedSession)

const GROUP = [e('a'), e('b'), e('c')]

/**
 * THE DISTINCTION THIS MODULE EXISTS FOR. `null` is a caller with no selection to make — the
 * cockpit's `R` on a group already named. `[]` is a person who unticked every row. Collapsing them
 * would start every assistant on the machine because a list came back empty.
 */
test('null reopens everything; an empty list reopens nothing', () => {
  expect(selectFell(GROUP, null).chosen.map(x => x.id)).toEqual(['a', 'b', 'c'])
  expect(selectFell(GROUP, []).chosen).toEqual([])
  expect(selectFell(GROUP, []).unknown).toEqual([])
})

test('takes exactly what was ticked', () => {
  expect(selectFell(GROUP, ['a', 'c']).chosen.map(x => x.id)).toEqual(['a', 'c'])
})

/**
 * The caller is acting on a list that has moved — the session ended on its own, or another window
 * reopened it. A count that quietly shrinks is how somebody concludes a button half-worked.
 */
test('an unknown id is reported, never silently dropped', () => {
  const out = selectFell(GROUP, ['a', 'gone'])
  expect(out.chosen.map(x => x.id)).toEqual(['a'])
  expect(out.unknown).toEqual(['gone'])
})

test('the same row ticked twice is one session', () => {
  expect(selectFell(GROUP, ['b', 'b', 'b']).chosen.map(x => x.id)).toEqual(['b'])
})

/**
 * The group is ordered newest-first by `planFellOffer`, and a browser hands back whatever order its
 * DOM was in. The order that means something is the offered one.
 */
test('restores the order they were offered in, whatever order they arrive', () => {
  expect(selectFell(GROUP, ['c', 'a', 'b']).chosen.map(x => x.id)).toEqual(['a', 'b', 'c'])
})

test('an empty group yields nothing, and says which ids it could not find', () => {
  expect(selectFell([], null).chosen).toEqual([])
  expect(selectFell([], ['a']).unknown).toEqual(['a'])
})
