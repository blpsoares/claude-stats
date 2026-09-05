import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import {
  ATTACHMENT_DIR, attachmentImageType, attachmentPathByName, resolveAttachmentRead,
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

  it('refuses anything that is not one, so this cannot become a file server', () => {
    expect(attachmentImageType('notes.txt')).toBeNull()
    expect(attachmentImageType('id_rsa')).toBeNull()
    expect(attachmentImageType('a.pdf')).toBeNull()
    expect(attachmentImageType('.png')).toBeNull()
  })
})
