import { test, expect } from 'bun:test'
import {
  composerMaxHeight, COMPOSER_VIEWPORT_SHARE, MAX_COMPOSER_H, MIN_COMPOSER_H,
} from './composerHeight'

test('a tall window gets the ceiling, not the whole screen', () => {
  expect(composerMaxHeight(2000)).toBe(MAX_COMPOSER_H)
})

test('an ordinary laptop gets its share, between the two bounds', () => {
  const h = composerMaxHeight(900)
  expect(h).toBe(Math.round(900 * COMPOSER_VIEWPORT_SHARE))
  expect(h).toBeGreaterThan(MIN_COMPOSER_H)
  expect(h).toBeLessThan(MAX_COMPOSER_H)
})

test('a very short window still keeps several lines — collapsing to one IS the bug', () => {
  expect(composerMaxHeight(200)).toBe(MIN_COMPOSER_H)
})

test('an unmeasured viewport answers the FLOOR, never the ceiling', () => {
  // Too small is a field somebody scrolls; too large is a field covering the conversation. Only
  // the first is recoverable by typing less.
  for (const v of [0, -1, Number.NaN]) expect(composerMaxHeight(v)).toBe(MIN_COMPOSER_H)
})

test('it never returns anything outside its own bounds', () => {
  for (const v of [1, 320, 640, 768, 1080, 1440, 4000]) {
    const h = composerMaxHeight(v)
    expect(h).toBeGreaterThanOrEqual(MIN_COMPOSER_H)
    expect(h).toBeLessThanOrEqual(MAX_COMPOSER_H)
  }
})

test('the old fixed 140 is inside the range it replaced, so nothing regressed for that size', () => {
  expect(MIN_COMPOSER_H).toBeLessThan(140)
  expect(MAX_COMPOSER_H).toBeGreaterThan(140)
})
