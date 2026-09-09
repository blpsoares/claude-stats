import { describe, expect, it } from 'bun:test'
import { shouldDismiss } from './dismissOverlay'

describe('shouldDismiss', () => {
  it('closes on a real click on the backdrop', () => {
    expect(shouldDismiss({ startedOnBackdrop: true, targetIsBackdrop: true })).toBe(true)
  })

  it('does NOT close when the gesture began inside the dialog', () => {
    // Press in the description, drag to select, release over the backdrop: the browser fires one
    // click whose target is the backdrop. Closing there loses everything typed — the reported bug.
    expect(shouldDismiss({ startedOnBackdrop: false, targetIsBackdrop: true })).toBe(false)
  })

  it('does NOT close on a click that merely bubbled out of the dialog', () => {
    expect(shouldDismiss({ startedOnBackdrop: true, targetIsBackdrop: false })).toBe(false)
    expect(shouldDismiss({ startedOnBackdrop: false, targetIsBackdrop: false })).toBe(false)
  })
})
