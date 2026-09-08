import { expect, test } from 'bun:test'
import { addDelta, editDelta, replacementDelta } from './edit-lines'

test('a Write counts its own lines as added, and claims no removal', () => {
  // The call does not carry what was there; inventing a removal would be inventing a number.
  expect(editDelta('Write', { content: 'a\nb\nc' })).toEqual({ added: 3, removed: 0 })
})

test('a two-word fix is not forty lines', () => {
  // The whole reason this is not `old.length + new.length`.
  const before = 'one\ntwo\nthree\nfour'
  const after = 'one\nTWO\nthree\nfour'
  expect(editDelta('Edit', { old_string: before, new_string: after })).toEqual({ added: 1, removed: 1 })
})

test('growing an edit adds the difference', () => {
  expect(replacementDelta('a\nb', 'a\nb\nc\nd')).toEqual({ added: 2, removed: 0 })
})

test('shrinking an edit removes the difference', () => {
  expect(replacementDelta('a\nb\nc', 'a')).toEqual({ added: 0, removed: 2 })
})

test('MultiEdit is the sum of its edits', () => {
  expect(editDelta('MultiEdit', {
    edits: [
      { old_string: 'a', new_string: 'A' },
      { old_string: 'x\ny', new_string: 'x' },
    ],
  })).toEqual({ added: 1, removed: 2 })
})

test('an unknown tool, or junk, contributes nothing', () => {
  expect(editDelta('Read', { file_path: '/x' })).toEqual({ added: 0, removed: 0 })
  expect(editDelta('Edit', null)).toEqual({ added: 0, removed: 0 })
  expect(editDelta('MultiEdit', { edits: 'nonsense' })).toEqual({ added: 0, removed: 0 })
})

test('an empty string is zero lines, not one', () => {
  expect(editDelta('Write', { content: '' })).toEqual({ added: 0, removed: 0 })
})

test('deltas accumulate', () => {
  expect(addDelta({ added: 2, removed: 1 }, { added: 3, removed: 4 })).toEqual({ added: 5, removed: 5 })
})
