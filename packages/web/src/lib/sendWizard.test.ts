import { expect, test } from 'bun:test'
import { canAdvanceToCompose, composeBroadcastText, wizardPrimaryLabel, wizardSteps } from './sendWizard'

test('reopen stays one step; send grows a compose step', () => {
  expect(wizardSteps('reopen')).toEqual(['pick'])
  expect(wizardSteps('send')).toEqual(['pick', 'compose'])
})

test('the compose step is reachable only once something is ticked', () => {
  expect(canAdvanceToCompose(0)).toBe(false)
  expect(canAdvanceToCompose(1)).toBe(true)
  expect(canAdvanceToCompose(5)).toBe(true)
})

/**
 * `send`'s pick step must not borrow the sending verb's wording — pressing it only turns the page.
 */
test('send/pick says "Next" and never claims delivery', () => {
  const zero = wizardPrimaryLabel('pick', 'send', 0, false)
  expect(zero.enabled).toBe(false)
  expect(zero.label).toBe('None picked')

  const one = wizardPrimaryLabel('pick', 'send', 1, false)
  expect(one.enabled).toBe(true)
  expect(one.label).toBe('Next · 1 session')
  expect(one.label).not.toContain('Send')

  const many = wizardPrimaryLabel('pick', 'send', 4, true)
  expect(many.label).toBe('Avançar · 4 sessões')
})

/**
 * `send`'s compose step and `reopen`'s only step are the two places that actually PERFORM the verb,
 * so both go through `pickConfirmLabel`'s own arithmetic — this is a cross-check, not a re-decision.
 */
test('send/compose and reopen share pickConfirmLabel wording exactly', () => {
  expect(wizardPrimaryLabel('compose', 'send', 3, false)).toEqual({ enabled: true, label: 'Send to 3 sessions' })
  expect(wizardPrimaryLabel('compose', 'send', 0, false)).toEqual({ enabled: false, label: 'None picked' })
  expect(wizardPrimaryLabel('pick', 'reopen', 2, false)).toEqual({ enabled: true, label: 'Reopen 2 sessions' })
  expect(wizardPrimaryLabel('pick', 'reopen', 0, true)).toEqual({ enabled: false, label: 'Nenhuma escolhida' })
})

test('composing puts paths on their own lines above what was typed', () => {
  expect(composeBroadcastText([], 'hello')).toBe('hello')
  expect(composeBroadcastText(['/tmp/a.png'], 'hello'))
    .toBe('/tmp/a.png\n\nhello')
  expect(composeBroadcastText(['/tmp/a.png', '/tmp/b.png'], ''))
    .toBe('/tmp/a.png\n/tmp/b.png')
  expect(composeBroadcastText([], '')).toBe('')
})
