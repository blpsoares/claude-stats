import { describe, expect, test } from 'bun:test'
import { isImagePath, splitImageAttachments } from './attachmentPreview'

describe('isImagePath', () => {
  test('recognises known image extensions, case-insensitively', () => {
    expect(isImagePath('/tmp/x/screenshot.PNG')).toBe(true)
    expect(isImagePath('/tmp/x/photo.jpeg')).toBe(true)
  })
  test('rejects a non-image extension and a bare name', () => {
    expect(isImagePath('/tmp/x/notes.txt')).toBe(false)
    expect(isImagePath('noext')).toBe(false)
  })
})

describe('splitImageAttachments', () => {
  test('pulls a bare attachment path out of the text', () => {
    const out = splitImageAttachments('/home/me/.agentistics/attachments/a1-shot.png\nlook at this')
    expect(out.images).toEqual(['/home/me/.agentistics/attachments/a1-shot.png'])
    expect(out.text).toBe('look at this')
  })

  test('leaves prose mentioning a filename alone — it has spaces around it', () => {
    const out = splitImageAttachments('see diagram.png in the repo root')
    expect(out.images).toEqual([])
    expect(out.text).toBe('see diagram.png in the repo root')
  })

  test('pulls several attachments, keeping their order', () => {
    const out = splitImageAttachments('/a/one.png\n/a/two.jpg\nboth attached')
    expect(out.images).toEqual(['/a/one.png', '/a/two.jpg'])
    expect(out.text).toBe('both attached')
  })

  test('a message that is ONLY attachments leaves empty text, not a blank line', () => {
    const out = splitImageAttachments('/a/one.png')
    expect(out.images).toEqual(['/a/one.png'])
    expect(out.text).toBe('')
  })

  test('a non-image bare path is left as ordinary text', () => {
    const out = splitImageAttachments('/a/notes.txt\nhere it is')
    expect(out.images).toEqual([])
    expect(out.text).toBe('/a/notes.txt\nhere it is')
  })
})
