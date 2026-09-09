import { describe, expect, it } from 'bun:test'
import { isPickerSelectKey } from './pickerKeys'

const key = (over: Partial<Parameters<typeof isPickerSelectKey>[0]>) =>
  isPickerSelectKey({ key: 'Enter', shiftKey: false, isMobile: false, ...over })

describe('what takes the highlighted entry', () => {
  it('takes it on Enter and on Tab', () => {
    expect(key({ key: 'Enter' })).toBe(true)
    expect(key({ key: 'Tab' })).toBe(true)
  })

  it('takes it on Tab even on a touch layout', () => {
    // A soft keyboard rarely has Tab, and where it does it is not the line-break key.
    expect(key({ key: 'Tab', isMobile: true })).toBe(true)
  })

  it('leaves Enter alone on a touch layout, where it breaks the line', () => {
    expect(key({ key: 'Enter', isMobile: true })).toBe(false)
  })
})

describe('shift is the way out', () => {
  it('never selects with shift held, so focus can still leave the field', () => {
    // Once Tab picks an entry there is no Tab left to leave with; shift+tab still moves focus.
    expect(key({ key: 'Tab', shiftKey: true })).toBe(false)
    expect(key({ key: 'Enter', shiftKey: true })).toBe(false)
  })
})

describe('everything else is somebody typing', () => {
  it('ignores the keys the picker does not own', () => {
    for (const k of ['a', 'Escape', 'ArrowDown', 'ArrowUp', ' ', 'Backspace']) {
      expect(key({ key: k })).toBe(false)
    }
  })
})
