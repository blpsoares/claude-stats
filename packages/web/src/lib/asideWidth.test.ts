import { expect, test, describe } from 'bun:test'
import {
  ASIDE_DEFAULT, ASIDE_MAX, ASIDE_MIN, clampAsideWidth, resolveAsideWidth,
} from './asideWidth'

describe('clampAsideWidth', () => {
  test('holds the width inside its bounds', () => {
    expect(clampAsideWidth(300, 1600)).toBe(300)
    expect(clampAsideWidth(10, 1600)).toBe(ASIDE_MIN)
    expect(clampAsideWidth(9000, 1600)).toBe(ASIDE_MAX)
  })

  test('a narrow viewport lowers the ceiling — a sidebar past half the window is not a sidebar', () => {
    // The case this exists for: a width chosen on a wide monitor, reopened on a laptop.
    expect(clampAsideWidth(500, 900)).toBe(450)
  })

  test('the minimum still wins on a viewport too small to honour the half rule', () => {
    // Otherwise the clamp would return something narrower than a title can be read in.
    expect(clampAsideWidth(300, 300)).toBe(ASIDE_MIN)
  })

  test('with no viewport known it falls back to the fixed ceiling rather than to nothing', () => {
    expect(clampAsideWidth(9000)).toBe(ASIDE_MAX)
  })

  test('rounds to whole pixels — a drag reports fractions', () => {
    expect(clampAsideWidth(300.6, 1600)).toBe(301)
  })
})

describe('resolveAsideWidth', () => {
  test('reads a stored width', () => {
    expect(resolveAsideWidth('340', 1600)).toBe(340)
  })

  test('anything unreadable is the default, never zero', () => {
    // A zero-width sidebar renders as a missing feature rather than as a narrow one.
    for (const bad of [null, '', 'wide', '0', '-40', 'NaN']) {
      expect(resolveAsideWidth(bad, 1600)).toBe(ASIDE_DEFAULT)
    }
  })

  test('a stored width is clamped on the way in, not only on the way out', () => {
    expect(resolveAsideWidth('9000', 1600)).toBe(ASIDE_MAX)
  })
})
