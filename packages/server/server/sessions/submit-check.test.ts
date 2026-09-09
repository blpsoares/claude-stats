import { expect, test } from 'bun:test'
import { frameChanged, needsSecondReturn } from './submit-check'

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

/**
 * THE CHECK WAS A CONSTANT `true` ON EXACTLY THE SESSIONS IT EXISTS FOR.
 *
 * `frameChanged` is right about an IDLE pane and says nothing about a BUSY one: a session mid-turn
 * repaints its own spinner, its elapsed timers and its token counter, so any two captures differ
 * however the submit went. Measured 2026-09-08 on a live pane, two captures 200 ms apart with
 * NOTHING sent to it:
 *
 *     < ● UI fixes: delivery picker… · 1m 28s     >   UI fixes: delivery picker… · 1m 29s
 *     < * Drizzling… (37m 47s · ↓ 56.8k tokens)   > ✻ Drizzling… (37m 47s · ↓ 56.8k tokens)
 *
 * So `paneMoved` returned true on its first 60 ms poll of every send to a working session, the
 * bounded retry never fired, and a swallowed return was reported as delivered — the composer
 * cleared and the row said "delivered · it reads this when its turn ends" over a prompt sitting
 * unsent in the harness's input box. Observed with 36 minutes on the clock.
 */
test('an ANIMATING pane always buys the extra return — the check cannot answer there', () => {
  // Whatever the post-return comparison said, it was measuring the spinner.
  expect(needsSecondReturn(true, true)).toBe(true)
  expect(needsSecondReturn(true, false)).toBe(true)
})

test('a STILL pane keeps today’s behaviour exactly', () => {
  expect(needsSecondReturn(false, true)).toBe(false)
  expect(needsSecondReturn(false, false)).toBe(true)
})

test('the safe default is pressing return again, because that is the harmless direction', () => {
  // An extra return on an emptied input does nothing; a missing one strands the message. So every
  // case this cannot settle resolves toward the keystroke.
  for (const moved of [true, false]) expect(needsSecondReturn(true, moved)).toBe(true)
})
