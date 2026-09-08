import { expect, test } from 'bun:test'
import { actFallbackMessage, parseActResult } from './fleetAct'

test('the created session id is CARRIED, which is the whole bug this replaces', () => {
  // The exact body measured from a reopen that appeared to do nothing.
  const body = { ok: true, message: 'started ACESSIBILIDADE VINI in the background.', id: 'aeb12129c4' }
  expect(parseActResult(body, 'en')).toEqual({
    ok: true, message: 'started ACESSIBILIDADE VINI in the background.', id: 'aeb12129c4',
  })
})

test('a verb that created nothing carries no id', () => {
  expect(parseActResult({ ok: true, message: 'stopped x.' }, 'en').id).toBeUndefined()
})

test('an id that is not a usable string is not one', () => {
  // It would otherwise become a route this app navigates to.
  expect(parseActResult({ ok: true, message: 'm', id: null }, 'en').id).toBeUndefined()
  expect(parseActResult({ ok: true, message: 'm', id: 0 }, 'en').id).toBeUndefined()
  expect(parseActResult({ ok: true, message: 'm', id: '  ' }, 'en').id).toBeUndefined()
})

test('ok is TRUE only when the machine said so', () => {
  expect(parseActResult({ ok: 'yes', message: 'm' }, 'en').ok).toBe(false)
  expect(parseActResult({ message: 'm' }, 'en').ok).toBe(false)
})

test('an unreadable body still yields a sentence', () => {
  expect(parseActResult(null, 'pt')).toEqual({ ok: false, message: actFallbackMessage('pt') })
  expect(parseActResult('nonsense', 'en').message).toBe(actFallbackMessage('en'))
  // An EMPTY message is not a message — the machine's own wording is what this shows, and a blank
  // line under a failed verb says nothing at all.
  expect(parseActResult({ ok: false, message: '' }, 'en').message).toBe(actFallbackMessage('en'))
})
