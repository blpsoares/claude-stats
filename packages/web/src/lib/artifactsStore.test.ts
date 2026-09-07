import { test, expect, beforeEach } from 'bun:test'
import {
  closeArtifacts, getArtifacts, openArtifacts, resetArtifacts, setArtifactCount, toggleArtifacts,
} from './artifactsStore'

beforeEach(() => resetArtifacts())

test('it starts knowing nothing — no session, no count, shut', () => {
  expect(getArtifacts()).toEqual({ sessionId: null, open: false, count: 0, dismissed: false, tabRequest: null })
})

test('a count is recorded against the session it belongs to', () => {
  setArtifactCount('a', 3)
  expect(getArtifacts()).toMatchObject({ sessionId: 'a', count: 3 })
})

test('switching sessions resets the panel AND the dismissal', () => {
  setArtifactCount('a', 3)
  openArtifacts()
  closeArtifacts()
  expect(getArtifacts()).toMatchObject({ open: false, dismissed: true })
  setArtifactCount('b', 1)
  // A decision about one conversation says nothing about the next, and a count on the header of a
  // different session would be a confident wrong answer.
  expect(getArtifacts()).toEqual({ sessionId: 'b', count: 1, open: false, dismissed: false, tabRequest: null })
})

test('a new count for the SAME session keeps the panel as it was', () => {
  setArtifactCount('a', 1)
  openArtifacts()
  setArtifactCount('a', 4)
  expect(getArtifacts()).toEqual({ sessionId: 'a', count: 4, open: true, dismissed: false, tabRequest: null })
})

test('closing is also a decision not to be reopened automatically', () => {
  setArtifactCount('a', 2)
  openArtifacts()
  closeArtifacts()
  expect(getArtifacts()).toMatchObject({ open: false, dismissed: true })
})

test('opening again after a close lifts nothing but the shutter — the dismissal was theirs', () => {
  // Re-opening by hand is a new decision to look; it does not need to pretend the close never
  // happened, and leaving `dismissed` set is what stops the panel re-opening by itself later.
  setArtifactCount('a', 2)
  closeArtifacts()
  openArtifacts()
  expect(getArtifacts()).toMatchObject({ open: true, dismissed: true })
})

test('toggle is the two actions, in the order the button uses them', () => {
  setArtifactCount('a', 1)
  toggleArtifacts()
  expect(getArtifacts().open).toBe(true)
  toggleArtifacts()
  expect(getArtifacts()).toMatchObject({ open: false, dismissed: true })
})

test('an unchanged write keeps the SAME object, so no consumer re-renders', () => {
  // `useSyncExternalStore` compares by reference. The chat polls every few seconds and reports the
  // same count nearly every time; a fresh object each poll would re-render the header and the page
  // for nothing.
  setArtifactCount('a', 1)
  const before = getArtifacts()
  setArtifactCount('a', 1)
  expect(getArtifacts()).toBe(before)
})

test('an opener may ask for a tab, and asking twice is two requests', () => {
  setArtifactCount('t', 0)
  openArtifacts('live')
  const first = getArtifacts().tabRequest
  expect(first?.tab).toBe('live')
  closeArtifacts()
  openArtifacts('live')
  const second = getArtifacts().tabRequest
  // The STAMP is what makes the panel obey a second time — the reader may have moved to Files in
  // between, and a prop that never changes could never bring them back.
  expect(second).not.toBe(first)
})

test('opening without naming a tab leaves the reader where they were', () => {
  setArtifactCount('u', 0)
  openArtifacts('live')
  const asked = getArtifacts().tabRequest
  openArtifacts()
  expect(getArtifacts().tabRequest).toBe(asked)
})
