import { test, expect } from 'bun:test'
import { attachmentName, isImageAttachment, splitMessage } from './messageAttachments'

const A = '/home/u/.agentistics/attachments/abc-image.png'
const B = '/home/u/.agentistics/attachments/def-shot.jpg'

test('the paths come off the top and the words are left alone', () => {
  expect(splitMessage(`${A}\nolha esse print`)).toEqual({ attachments: [A], text: 'olha esse print' })
})

test('several attachments in one message keep their order', () => {
  expect(splitMessage(`${A}\n${B}\ndois prints`).attachments).toEqual([A, B])
})

test('a message with no attachment is returned whole', () => {
  expect(splitMessage('just words\nover two lines'))
    .toEqual({ attachments: [], text: 'just words\nover two lines' })
})

test('only LEADING lines count — a path further down is something somebody wrote', () => {
  // A message quoting a file it wants read is not a message carrying one.
  const msg = `read this\n${A}`
  expect(splitMessage(msg)).toEqual({ attachments: [], text: msg })
})

test('a path OUTSIDE the attachments directory is left in the text', () => {
  // A person can legitimately start a message with a filename; making that a chip would invent an
  // attachment that was never sent.
  const msg = 'packages/web/src/x.ts\nlook at this file'
  expect(splitMessage(msg).attachments).toEqual([])
  expect(splitMessage(msg).text).toBe(msg)
})

test('a blank line between the paths and the words is not part of either', () => {
  expect(splitMessage(`${A}\n\nthe words`)).toEqual({ attachments: [A], text: 'the words' })
})

test('the name is the last segment, and images are known by extension', () => {
  expect(attachmentName(A)).toBe('abc-image.png')
  expect(isImageAttachment(A)).toBe(true)
  expect(isImageAttachment('/x/.agentistics/attachments/notes.pdf')).toBe(false)
})
