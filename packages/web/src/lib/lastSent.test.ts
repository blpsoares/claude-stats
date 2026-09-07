import { test, expect } from 'bun:test'
import { isPersonMessage, lastSentMessage, turnAnchorId } from './lastSent'

const user = (text: string) => ({ role: 'user' as const, text })
const bot = (text: string) => ({ role: 'assistant' as const, text })

test('the last USER turn is recalled, not the last turn', () => {
  const turns = [user('first'), bot('answer'), user('second'), bot('answer again')]
  expect(lastSentMessage(turns)).toEqual({ kind: 'turn', index: 2, text: 'second' })
})

test('a system envelope under the user role is NOT a message somebody sent', () => {
  const turns = [
    user('what I wrote'),
    { role: 'user' as const, text: 'a reminder nobody typed', system: 'system reminder' },
  ]
  expect(lastSentMessage(turns)).toEqual({ kind: 'turn', index: 0, text: 'what I wrote' })
})

test('a background-task status line is not a message either', () => {
  const turns = [
    user('what I wrote'),
    { role: 'user' as const, text: 'finished', task: { label: 'build', running: false } },
  ]
  expect(lastSentMessage(turns)?.text).toBe('what I wrote')
})

test('a turn with no text is work, not a message', () => {
  const turns = [user('what I wrote'), user('   ')]
  expect(lastSentMessage(turns)?.text).toBe('what I wrote')
})

test('an ECHO wins — it is newer than anything in the transcript by construction', () => {
  const turns = [user('committed')]
  expect(lastSentMessage(turns, ['just sent'])).toEqual({ kind: 'echo', index: 0, text: 'just sent' })
})

test('the LAST echo wins, and a blank one is skipped', () => {
  expect(lastSentMessage([], ['one', 'two'])?.text).toBe('two')
  expect(lastSentMessage([user('a')], ['  '])).toEqual({ kind: 'turn', index: 0, text: 'a' })
})

test('a conversation with nothing the person sent answers NULL, so no control is drawn', () => {
  expect(lastSentMessage([])).toBeNull()
  expect(lastSentMessage([bot('hello')])).toBeNull()
  expect(lastSentMessage([{ role: 'user', text: 'x', system: 'command output' }])).toBeNull()
  expect(lastSentMessage([], [])).toBeNull()
})

test('isPersonMessage answers each exclusion on its own', () => {
  expect(isPersonMessage(user('x'))).toBe(true)
  expect(isPersonMessage(bot('x'))).toBe(false)
  expect(isPersonMessage({ role: 'user', text: 'x', system: 'slash command' })).toBe(false)
  expect(isPersonMessage({ role: 'user', text: 'x', task: {} })).toBe(false)
  expect(isPersonMessage(user('\n\t '))).toBe(false)
})

test('the two runs are namespaced apart — turn 0 and echo 0 are both a first', () => {
  expect(turnAnchorId('turn', 0)).not.toBe(turnAnchorId('echo', 0))
  expect(turnAnchorId('turn', 3)).toBe('ag-chat-turn-3')
})
