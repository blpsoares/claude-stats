import { describe, expect, it } from 'bun:test'
import { promptCharCount, promptCountLabel } from './promptCount'

describe('promptCharCount', () => {
  it('counts what a person would count', () => {
    expect(promptCharCount('')).toBe(0)
    expect(promptCharCount('ok')).toBe(2)
    expect(promptCharCount('responda apenas: ok')).toBe(19)
  })

  /**
   * `String.length` counts UTF-16 CODE UNITS, so an emoji reads as 2 and a flag as 4. Nobody typing
   * one thinks they typed two, and this number sits next to a field where the whole point is that
   * it matches what you can see.
   */
  it('counts an emoji as one character, not two', () => {
    expect('🙂'.length).toBe(2) // what the naive reading would have said
    expect(promptCharCount('🙂')).toBe(1)
    expect(promptCharCount('oi 🙂')).toBe(4)
  })

  it('counts an accented letter as one', () => {
    expect(promptCharCount('não')).toBe(3)
    expect(promptCharCount('ação')).toBe(4)
  })

  /** A newline is a character somebody typed. Trimming it would make the count disagree with the field. */
  it('counts newlines and spaces, because the field holds them', () => {
    expect(promptCharCount('a\nb')).toBe(3)
    expect(promptCharCount('  ')).toBe(2)
  })

  it('answers 0 for nothing at all rather than throwing', () => {
    expect(promptCharCount(undefined as unknown as string)).toBe(0)
    expect(promptCharCount(null as unknown as string)).toBe(0)
  })
})

describe('promptCountLabel', () => {
  /**
   * It is ABSENT on an empty field. A counter reading `0` beside an empty box is a control with
   * nothing to say taking up room that the hint under the composer needs.
   */
  it('says nothing when there is nothing typed', () => {
    expect(promptCountLabel('', 'pt')).toBeNull()
    expect(promptCountLabel('', 'en')).toBeNull()
  })

  it('reads as a plain count in both languages', () => {
    expect(promptCountLabel('ok', 'en')).toBe('2 characters')
    expect(promptCountLabel('ok', 'pt')).toBe('2 caracteres')
  })

  /** One is one. A hard-coded plural on a field somebody is typing into is visible immediately. */
  it('gets the singular right', () => {
    expect(promptCountLabel('a', 'en')).toBe('1 character')
    expect(promptCountLabel('a', 'pt')).toBe('1 caractere')
  })

  /**
   * Grouped past a thousand — a pasted block runs to five figures, and `10480` beside a text box is
   * a number people re-read. Portuguese groups with a dot, English with a comma.
   */
  it('groups the thousands the reader’s way', () => {
    expect(promptCountLabel('x'.repeat(10480), 'en')).toBe('10,480 characters')
    expect(promptCountLabel('x'.repeat(10480), 'pt')).toBe('10.480 caracteres')
  })
})
