import { test, expect } from 'bun:test'
import { echoStatus, ECHO_AGE_QUIET_MS } from './echoStatus'

test('it LEADS WITH DELIVERY — the message is in the session', () => {
  // "waiting for the session to read it" reads as "this did not send", and left somebody checking
  // the terminal to see whether their message survived.
  expect(echoStatus(0, false, 'en').text).toStartWith('delivered to the session')
  expect(echoStatus(0, false, 'pt').text).toStartWith('entregue à sessão')
})

test('a BUSY session gets the reason, which is what makes the wait normal', () => {
  expect(echoStatus(0, true, 'en').text).toContain('when its turn ends')
  expect(echoStatus(0, false, 'en').text).toContain('not read yet')
})

test('the age is silent while the wait is ordinary', () => {
  const s = echoStatus(ECHO_AGE_QUIET_MS - 1, false, 'en')
  expect(s.notable).toBe(false)
  expect(s.text).not.toContain('for')
})

test('past the quiet window it says how long — the only signal a queue has stalled', () => {
  const s = echoStatus(90_000, false, 'en')
  expect(s.notable).toBe(true)
  expect(s.text).toContain('for 1 min')
})

test('seconds while under a minute, minutes after', () => {
  expect(echoStatus(45_000, false, 'en').text).toContain('for 45s')
  expect(echoStatus(5 * 60_000, false, 'en').text).toContain('for 5 min')
})

test('an unknown age is never notable and never invents a duration', () => {
  const s = echoStatus(null, false, 'en')
  expect(s.notable).toBe(false)
  expect(s.text).toBe('delivered to the session — not read yet')
})
