import { describe, expect, test } from 'bun:test'
import { isImagePath, splitImageAttachments, splitImageMarkers } from './attachmentPreview'

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

describe('splitImageMarkers', () => {
  test('a marker jammed against the first word is taken off it', () => {
  expect(splitImageMarkers('[Image #22]os itens nao estao indo'))
    .toEqual({ markers: [22], text: 'os itens nao estao indo' })
})

test('a merged turn carries the whole run of markers at the front', () => {
  expect(splitImageMarkers('[Image #4] [Image #5] [Image #6]1. a visao geral'))
    .toEqual({ markers: [4, 5, 6], text: '1. a visao geral' })
})

test('a marker further down is left where it is — somebody wrote it', () => {
  const msg = 'the harness writes [Image #4] where the image was'
  expect(splitImageMarkers(msg)).toEqual({ markers: [], text: msg })
})

test('text with no marker is returned untouched, whitespace included', () => {
  expect(splitImageMarkers('  olha esse print\n')).toEqual({ markers: [], text: '  olha esse print\n' })
})

test('a turn that is nothing but markers keeps no text', () => {
  expect(splitImageMarkers('[Image #1] [Image #2]')).toEqual({ markers: [1, 2], text: '' })
})
})
