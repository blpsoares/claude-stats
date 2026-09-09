import { expect, test } from 'bun:test'
import { shellAllowed } from './shell-gate'

/**
 * A raw shell is strictly more powerful than the chat, which `chat-gate.ts` already calls the most
 * powerful thing this server does — the chat at least spawns a NAMED assistant CLI, while this
 * spawns whatever the person types. So it takes the same two gates, and the strict reading of an
 * absent preference matters more here, not less.
 */

test('ABSENT READS AS OFF — nobody acquires a browser shell by having upgraded', () => {
  expect(shellAllowed(true, undefined)).toBe(false)
})

test('an explicit no is a no', () => {
  expect(shellAllowed(true, false)).toBe(false)
})

test('both together, and only both together', () => {
  expect(shellAllowed(true, true)).toBe(true)
})

test('the preference may only ever NARROW the profile, never re-open it', () => {
  // A preference that could re-enable what `public` denied would be the opt-in restoring host power
  // on an exposed instance, which `exposure.ts` exists to make impossible.
  expect(shellAllowed(false, true)).toBe(false)
  expect(shellAllowed(false, undefined)).toBe(false)
  expect(shellAllowed(false, false)).toBe(false)
})
