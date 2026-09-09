import { expect, test } from 'bun:test'
import { reconcileShells } from './shell-backend'
import type { ShellRecord } from './shell-store'

const rec = (id: string): ShellRecord => ({
  id, sessionId: 's1', cwd: '/home/u/proj', createdMs: 1, lastViewedMs: 2,
})

test('a shell whose tmux session is gone is DROPPED — `exit` is the ordinary death', () => {
  expect(reconcileShells([rec('a'), rec('b')], ['a']).map(r => r.id)).toEqual(['a'])
})

test('a tmux session with no record is NOT adopted', () => {
  // The exact opposite of `session-adopt.ts`, and deliberately. A session there carries a name, a
  // task and a conversation worth recovering; a shell carries none of that, and this store's whole
  // job is to be the small exact list the ceiling counts.
  expect(reconcileShells([rec('a')], ['a', 'stray']).map(r => r.id)).toEqual(['a'])
})

test('nothing running empties the store rather than keeping ghosts', () => {
  // Ghost records would make the ceiling refuse an open with every shell already dead — a cap you
  // cannot get under by closing things.
  expect(reconcileShells([rec('a'), rec('b')], [])).toEqual([])
})

test('order is preserved — the store is read in the order it was written', () => {
  expect(reconcileShells([rec('b'), rec('a')], ['a', 'b']).map(r => r.id)).toEqual(['b', 'a'])
})

test('an empty store stays empty whatever tmux is running', () => {
  expect(reconcileShells([], ['a', 'b'])).toEqual([])
})
