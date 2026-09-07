import { describe, test, expect } from 'bun:test'
import { attachmentKind, attachmentName, isImageAttachment, splitMessage } from './messageAttachments'

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

describe('attachmentKind', () => {
  test('names the three things this product can SHOW', () => {
    expect(attachmentKind('/x/.agentistics/attachments/a.png')).toBe('image')
    expect(attachmentKind('/x/.agentistics/attachments/a.MP4')).toBe('video')
    expect(attachmentKind('/x/.agentistics/attachments/a.pdf')).toBe('pdf')
  })

  test('THE REPORTED CASE: a PDF and a video are not "other"', () => {
    // The boolean this replaced could only say "picture or nothing", so an attached PDF or
    // recording — both of which agentop stores and can serve — were filed under nothing, shown as
    // "no preview" and could not be opened at all.
    for (const n of ['notes.pdf', 'demo.mp4', 'clip.mov', 'screen.webm']) {
      expect(attachmentKind(`/x/${n}`)).not.toBe('other')
    }
  })

  test('anything else is `other`, and that is an answer', () => {
    expect(attachmentKind('/x/notes.txt')).toBe('other')
    expect(attachmentKind('/x/archive.zip')).toBe('other')
    expect(attachmentKind('/x/noextension')).toBe('other')
  })

  test('isImageAttachment is DERIVED, so the two cannot drift', () => {
    expect(isImageAttachment('/x/a.png')).toBe(true)
    expect(isImageAttachment('/x/a.mp4')).toBe(false)
    expect(isImageAttachment('/x/a.pdf')).toBe(false)
  })
})
