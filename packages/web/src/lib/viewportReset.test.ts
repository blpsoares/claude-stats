import { test, expect } from 'bun:test'
import { SCROLLABLE_SLACK, shouldResetDocumentScroll } from './viewportReset'

/** A workspace that cannot scroll, displaced by the caret scroll, with nothing focused. */
const stuck = {
  scrollY: 180, scrollHeight: 800, clientHeight: 800, editableFocused: false,
}

test('puts back a scroll the document cannot have had', () => {
  expect(shouldResetDocumentScroll(stuck)).toBe(true)
})

/**
 * THE ONE THAT WAS REVERTED WITHIN THE HOUR. While a field has the caret, that scroll is what
 * carries the composer above the keyboard — cancelling it left the input invisible: "agora eu nem
 * consigo ver ele quando o teclado abre". This cleans up AFTER the keyboard, never during.
 */
test('never while something is being typed into', () => {
  expect(shouldResetDocumentScroll({ ...stuck, editableFocused: true })).toBe(false)
})

test('never on a page that really can scroll — that scroll is the reader\'s', () => {
  expect(shouldResetDocumentScroll({ ...stuck, scrollHeight: 4000 })).toBe(false)
})

test('the slack absorbs a sub-pixel document, and stops well short of a real page', () => {
  expect(shouldResetDocumentScroll({ ...stuck, scrollHeight: 800 + SCROLLABLE_SLACK })).toBe(true)
  expect(shouldResetDocumentScroll({ ...stuck, scrollHeight: 800 + SCROLLABLE_SLACK + 1 })).toBe(false)
})

test('nothing to undo is not a reason to write', () => {
  // Writing anyway would fight a rubber-band mid-gesture.
  expect(shouldResetDocumentScroll({ ...stuck, scrollY: 0 })).toBe(false)
  expect(shouldResetDocumentScroll({ ...stuck, scrollY: -20 })).toBe(false)
})
