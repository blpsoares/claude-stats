import { expect, test, describe } from 'bun:test'
import { deleteWord } from './Prompt'

describe('deleteWord — the field editor ctrl+w drives', () => {
  test('removes the last word', () => {
    expect(deleteWord('refactor the session wizard')).toBe('refactor the session ')
  })

  test('eats the trailing space with the word, so pressing it twice deletes two words', () => {
    // The bug this guards: without the leading `\s+$` trim the second press only removes the space
    // the first one left, so it appears to do nothing.
    expect(deleteWord(deleteWord('refactor the session wizard'))).toBe('refactor the ')
  })

  test('clears a single word, and an already-empty field stays empty', () => {
    expect(deleteWord('wizard')).toBe('')
    expect(deleteWord('')).toBe('')
    expect(deleteWord('   ')).toBe('')
  })
})
