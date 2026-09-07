import { test, expect } from 'bun:test'
import { answerFollowUp, dialogShape } from './answer-followup'
import type { DialogOption } from './dialog-choice'

const o = (number: number, label: string, selected = false): DialogOption => ({ number, label, selected })

const THREE: DialogOption[] = [o(1, 'Yes'), o(2, 'Yes, always'), o(3, 'No')]

test('the dialog is GONE: the digit submitted it, and nothing more is sent', () => {
  expect(answerFollowUp({ stillAsking: false, before: THREE, after: [], choice: 2 }))
    .toEqual({ kind: 'done' })
  // Even if a frame still parses options, "not asking" is the authority.
  expect(answerFollowUp({ stillAsking: false, before: THREE, after: THREE, choice: 2 }))
    .toEqual({ kind: 'done' })
})

test('the SAME dialog with our option highlighted: the digit only moved the cursor', () => {
  const after = [o(1, 'Yes'), o(2, 'Yes, always', true), o(3, 'No')]
  expect(answerFollowUp({ stillAsking: true, before: THREE, after, choice: 2 }))
    .toEqual({ kind: 'submit' })
})

/**
 * The dangerous case, and the reason this is read off the screen rather than held in a table.
 * Our answer landed and the session asked something NEW; an Enter here answers a question nobody
 * has read, on whichever row that new dialog happens to be highlighting.
 */
test('a DIFFERENT dialog is up: nothing is pressed, however tempting the highlight', () => {
  const other = [o(1, 'Delete everything', true), o(2, 'Cancel')]
  expect(answerFollowUp({ stillAsking: true, before: THREE, after: other, choice: 1 }))
    .toEqual({ kind: 'changed' })
})

test('a frame that still looks like a dialog but reads no options is NOT ours', () => {
  expect(answerFollowUp({ stillAsking: true, before: THREE, after: [], choice: 1 }))
    .toEqual({ kind: 'changed' })
})

test('the same dialog with our option NOT highlighted: the keystroke did not take', () => {
  const after = [o(1, 'Yes', true), o(2, 'Yes, always'), o(3, 'No')]
  expect(answerFollowUp({ stillAsking: true, before: THREE, after, choice: 2 }))
    .toEqual({ kind: 'stuck' })
})

/**
 * Moving the highlight is exactly what the digit is FOR, so a shape that counted it would call
 * every successful keypress a different dialog — and turn every `submit` into a `changed`.
 */
test('the shape ignores which row is highlighted', () => {
  const moved = [o(1, 'Yes'), o(2, 'Yes, always', true), o(3, 'No')]
  expect(dialogShape(moved)).toBe(dialogShape(THREE))
})

test('the shape DOES notice a changed label or a changed count', () => {
  expect(dialogShape([o(1, 'Yes'), o(2, 'No')])).not.toBe(dialogShape(THREE))
  expect(dialogShape([o(1, 'Yes'), o(2, 'Maybe'), o(3, 'No')])).not.toBe(dialogShape(THREE))
})
