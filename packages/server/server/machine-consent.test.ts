import { test, expect, beforeEach } from 'bun:test'
import {
  recordMachineConsent, forgetMachineConsent, machineConsent, effectiveConsent, resetMachineConsent,
} from './machine-consent'

beforeEach(() => { resetMachineConsent() })

test('a machine that has not said is null — not a refusal', () => {
  // The two must stay distinguishable: "has not told us" sends the owner to check whether the
  // machine is running, "says no" sends them to the switch. One falsy value cannot say both.
  expect(machineConsent('m1')).toBeNull()
  expect(effectiveConsent('m1')).toEqual({ sessions: false, screens: false })
})

test('an announcement is recorded as the resolved pair', () => {
  recordMachineConsent('m1', true, true, 1000)
  expect(machineConsent('m1')).toEqual({ sessions: true, screens: true, atMs: 1000 })
  expect(effectiveConsent('m1')).toEqual({ sessions: true, screens: true })
})

test('screens without sessions agrees to nothing — the rule is applied here too', () => {
  // A frame can arrive in any shape; the registry must not store a screen grant with no fleet.
  recordMachineConsent('m1', false, true, 1000)
  expect(machineConsent('m1')).toEqual({ sessions: false, screens: false, atMs: 1000 })
})

test('only literal booleans count — a truthy frame agrees to nothing', () => {
  recordMachineConsent('m1', 'yes', 1, 1000)
  expect(machineConsent('m1')).toEqual({ sessions: false, screens: false, atMs: 1000 })
})

test('a refusal is stored, and is a different answer from silence', () => {
  recordMachineConsent('m1', false, false, 1000)
  expect(machineConsent('m1')).toEqual({ sessions: false, screens: false, atMs: 1000 })
  expect(machineConsent('m2')).toBeNull()
})

test('a later announcement replaces the earlier one — including a withdrawal', () => {
  recordMachineConsent('m1', true, true, 1000)
  recordMachineConsent('m1', false, false, 2000)
  expect(machineConsent('m1')).toEqual({ sessions: false, screens: false, atMs: 2000 })
})

test('forgetting returns the machine to silence, never to a refusal', () => {
  recordMachineConsent('m1', true, false, 1000)
  forgetMachineConsent('m1')
  expect(machineConsent('m1')).toBeNull()
})

test('machines never share a record — the registry is keyed per machine', () => {
  recordMachineConsent('laptop', true, true, 1000)
  recordMachineConsent('desktop', false, false, 1000)
  expect(effectiveConsent('laptop')).toEqual({ sessions: true, screens: true })
  expect(effectiveConsent('desktop')).toEqual({ sessions: false, screens: false })
  forgetMachineConsent('desktop')
  expect(machineConsent('laptop')).not.toBeNull()
})

test('an empty machine id is never recorded', () => {
  recordMachineConsent('', true, true, 1000)
  expect(machineConsent('')).toBeNull()
})
