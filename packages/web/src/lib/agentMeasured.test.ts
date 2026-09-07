import { test, expect } from 'bun:test'
import { unmeasuredNote } from './agentMeasured'

test('nothing is said when every invocation carries its numbers', () => {
  expect(unmeasuredNote(0, 12, 'en')).toBeNull()
})

test('the note names how many of the shown invocations the totals do NOT cover', () => {
  expect(unmeasuredNote(3, 12, 'en')).toContain('3 of 12')
  expect(unmeasuredNote(3, 12, 'pt')).toContain('3 de 12')
})

test('the note says WHY, so an absent number does not read as a fault in the panel', () => {
  expect(unmeasuredNote(1, 2, 'en')?.toLowerCase()).toContain('transcript')
  expect(unmeasuredNote(1, 2, 'pt')?.toLowerCase()).toContain('transcri')
})

test('one is singular in both languages', () => {
  expect(unmeasuredNote(1, 4, 'en')).toContain('1 of 4')
  expect(unmeasuredNote(1, 4, 'pt')).toContain('1 de 4')
})
