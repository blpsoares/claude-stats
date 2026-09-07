import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import {
  ATTACHMENT_DIR, attachmentImageType, attachmentMediaType, attachmentPathByName, resolveAttachmentRead,
} from './attachment-web'

describe('resolveAttachmentRead', () => {
  it('resolves a plain path inside the attachment directory', () => {
    const p = join(ATTACHMENT_DIR, 'abcd1234-screenshot.png')
    expect(resolveAttachmentRead(p)).toBe(p)
  })

  it('refuses a path outside the attachment directory', () => {
    expect(resolveAttachmentRead('/etc/passwd')).toBeNull()
  })

  it('refuses a traversal that only LOOKS like it starts inside the directory', () => {
    // The raw string starts with ATTACHMENT_DIR; only resolving it first reveals it does not.
    expect(resolveAttachmentRead(join(ATTACHMENT_DIR, '..', '..', '.ssh', 'id_rsa'))).toBeNull()
  })

  it('refuses a sibling directory whose name happens to share the prefix', () => {
    // A bare string prefix check would let "ATTACHMENT_DIR-evil" through; the trailing separator
    // in the base guards exactly this.
    expect(resolveAttachmentRead(`${ATTACHMENT_DIR}-evil/file.png`)).toBeNull()
  })

  it('refuses an empty path', () => {
    expect(resolveAttachmentRead('')).toBeNull()
  })
})

describe('attachmentPathByName', () => {
  it('resolves a stored name into the attachment directory', () => {
    expect(attachmentPathByName('724e7aa8-image.png')).toBe(join(ATTACHMENT_DIR, '724e7aa8-image.png'))
  })

  it('REFUSES a traversal', () => {
    expect(attachmentPathByName('../../.ssh/id_rsa')).toBeNull()
    expect(attachmentPathByName('..')).toBeNull()
    expect(attachmentPathByName('.')).toBeNull()
    expect(attachmentPathByName('..%2F..%2Fetc%2Fpasswd')).toBeNull()
  })

  it('refuses anything carrying a separator, on either platform', () => {
    expect(attachmentPathByName('sub/file.png')).toBeNull()
    expect(attachmentPathByName('sub\\file.png')).toBeNull()
    expect(attachmentPathByName('/etc/passwd')).toBeNull()
  })

  it('refuses a NUL byte', () => {
    expect(attachmentPathByName('image.png\0.txt')).toBeNull()
  })

  it('refuses an empty name and an absurd one', () => {
    expect(attachmentPathByName('')).toBeNull()
    expect(attachmentPathByName('a'.repeat(201))).toBeNull()
  })

  it('refuses a name this machine could not have written', () => {
    expect(attachmentPathByName('imagem com espaço.png')).toBeNull()
    expect(attachmentPathByName('a$(whoami).png')).toBeNull()
  })
})

describe('attachmentImageType', () => {
  it('names the real type of every image the browser side previews', () => {
    expect(attachmentImageType('a.png')).toBe('image/png')
    expect(attachmentImageType('a.JPG')).toBe('image/jpeg')
    expect(attachmentImageType('a.jpeg')).toBe('image/jpeg')
    expect(attachmentImageType('a.gif')).toBe('image/gif')
    expect(attachmentImageType('a.webp')).toBe('image/webp')
    expect(attachmentImageType('a.avif')).toBe('image/avif')
    expect(attachmentImageType('a.bmp')).toBe('image/bmp')
    expect(attachmentImageType('a.svg')).toBe('image/svg+xml')
  })

  it('is the IMAGE half only — a video and a PDF are shown by other elements', () => {
    expect(attachmentImageType('notes.txt')).toBeNull()
    expect(attachmentImageType('id_rsa')).toBeNull()
    expect(attachmentImageType('a.pdf')).toBeNull()
    expect(attachmentImageType('a.mp4')).toBeNull()
    expect(attachmentImageType('.png')).toBeNull()
  })
})

describe('attachmentMediaType', () => {
  it('THE REPORTED CASE: an attached PDF and video are served, each as what it is', () => {
    // The route served images only, so a person who attached a PDF or a recording got a card
    // saying "no preview" beside a file agentop had itself stored, and no way to open it.
    expect(attachmentMediaType('notes.pdf')).toEqual({ mime: 'application/pdf', kind: 'pdf' })
    expect(attachmentMediaType('demo.MP4')).toEqual({ mime: 'video/mp4', kind: 'video' })
    expect(attachmentMediaType('clip.mov')).toEqual({ mime: 'video/quicktime', kind: 'video' })
    expect(attachmentMediaType('screen.webm')).toEqual({ mime: 'video/webm', kind: 'video' })
  })

  it('still refuses everything the table does not name, so this cannot become a file server', () => {
    // The point of a closed table: adding a kind is a deliberate act, never a fallthrough.
    for (const n of ['notes.txt', 'id_rsa', 'a.zip', 'a.exe', 'a.mkv', '.png', 'noext']) {
      expect(attachmentMediaType(n)).toBeNull()
    }
  })

  it('the image rows are the same ones, and `attachmentImageType` is derived from them', () => {
    for (const n of ['a.png', 'a.JPG', 'a.gif', 'a.webp', 'a.avif', 'a.bmp', 'a.svg']) {
      const t = attachmentMediaType(n)
      expect(t?.kind).toBe('image')
      expect(attachmentImageType(n)).toBe(t!.mime)
    }
  })
})
