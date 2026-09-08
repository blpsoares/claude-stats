import { expect, test } from 'bun:test'
import { frameChanged } from './submit-check'

test('an input that emptied is a change', () => {
  expect(frameChanged(['> hello there', '  auto mode on'], ['> ', '  auto mode on'])).toBe(true)
})

test('a pane that did not move is what buys the extra return — never a verdict', () => {
  const f = ['> the prompt nobody submitted', '  auto mode on']
  expect(frameChanged(f, [...f])).toBe(false)
})

test('trailing blank lines are not a change — a TUI repaints its own padding', () => {
  expect(frameChanged(['a', 'b'], ['a', 'b', '', '   '])).toBe(false)
})

test('a blank line in the MIDDLE is a change — only the tail is padding', () => {
  expect(frameChanged(['a', 'b'], ['a', '', 'b'])).toBe(true)
})
