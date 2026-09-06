import { describe, expect, it } from 'bun:test'
import { attachmentToken, bodyWithAttachments, looksLikeImage, parseCommentBody } from './commentBody'

describe('parseCommentBody', () => {
  it('returns the whole body as one text part when there is no reference', () => {
    expect(parseCommentBody('just words')).toEqual([{ kind: 'text', text: 'just words' }])
  })

  it('splits text around a reference, keeping both sides', () => {
    expect(parseCommentBody('before ![shot.png](file:abc123) after')).toEqual([
      { kind: 'text', text: 'before ' },
      { kind: 'file', id: 'abc123', name: 'shot.png' },
      { kind: 'text', text: ' after' },
    ])
  })

  it('reads EVERY reference of a body, and of the next one', () => {
    // The regex is rebuilt per call; a shared /g would carry `lastIndex` across and skip the first
    // reference of the second comment rendered.
    const body = '![a.png](file:one) ![b.png](file:two)'
    for (const _ of [0, 1]) {
      expect(parseCommentBody(body).filter(p => p.kind === 'file')).toHaveLength(2)
    }
  })

  it('leaves a malformed reference as plain text rather than inventing a file', () => {
    expect(parseCommentBody('![a.png](file:)')).toEqual([{ kind: 'text', text: '![a.png](file:)' }])
  })
})

describe('bodyWithAttachments', () => {
  it('is the text untouched when nothing was attached', () => {
    expect(bodyWithAttachments('hi', [])).toBe('hi')
  })

  it('puts the references on their own line, so prose stays readable in a raw reader', () => {
    expect(bodyWithAttachments('hi', [{ id: 'x1', name: 'a.png' }]))
      .toBe('hi\n\n![a.png](file:x1)')
  })

  it('is the references alone when there is no prose', () => {
    expect(bodyWithAttachments('   ', [{ id: 'x1', name: 'a.png' }])).toBe('![a.png](file:x1)')
  })

  it('round-trips through the parser', () => {
    const parts = parseCommentBody(bodyWithAttachments('look', [{ id: 'x1', name: 'a.png' }]))
    expect(parts.at(-1)).toEqual({ kind: 'file', id: 'x1', name: 'a.png' })
  })

  it('strips brackets from a name, which are the one thing the form cannot carry', () => {
    expect(attachmentToken({ id: 'x', name: 'a[1].png' })).toBe('![a1.png](file:x)')
  })
})

describe('looksLikeImage', () => {
  it('is the extension, and only the ones a browser paints', () => {
    expect(looksLikeImage('a.PNG')).toBe(true)
    expect(looksLikeImage('spec.md')).toBe(false)
  })
})
