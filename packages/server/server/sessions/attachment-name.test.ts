import { expect, test, describe } from 'bun:test'
import { safeAttachmentName, storedAttachmentName } from './attachment-name'

describe('safeAttachmentName — the name arrives from outside and is REBUILT, not trimmed', () => {
  test('an ordinary name survives unchanged', () => {
    expect(safeAttachmentName('notes.txt')).toEqual({ name: 'notes.txt', changed: false })
    expect(safeAttachmentName('report-2026_final.pdf').name).toBe('report-2026_final.pdf')
  })

  test('path traversal cannot survive — this is the whole reason the module exists', () => {
    // Joining any of these to a directory is how an upload endpoint becomes an arbitrary write.
    for (const evil of [
      '../../.ssh/authorized_keys',
      '..\\..\\windows\\system32\\drivers\\etc\\hosts',
      '/etc/passwd',
      '....//....//etc/shadow',
    ]) {
      const { name } = safeAttachmentName(evil)
      expect(name).not.toContain('/')
      expect(name).not.toContain('\\')
      expect(name.startsWith('.')).toBe(false)
      expect(name).not.toBe('..')
      expect(name).not.toBe('.')
    }
  })

  test('a bare dot-segment yields a real name rather than a hidden or empty file', () => {
    expect(safeAttachmentName('..').name).toBe('file')
    expect(safeAttachmentName('.').name).toBe('file')
    expect(safeAttachmentName('').name).toBe('file')
    expect(safeAttachmentName('///').name).toBe('file')
  })

  test('a dotfile does not stay hidden', () => {
    // `.env` written as `.env` is a file the user cannot see in a directory listing.
    expect(safeAttachmentName('.env').name.startsWith('.')).toBe(false)
  })

  test('shell metacharacters are gone — the path is typed into a terminal', () => {
    const { name } = safeAttachmentName('a;rm -rf ~$(whoami)`id`.txt')
    for (const ch of [';', '$', '`', '(', ')', ' ', '~', '&', '|', '>', '<', "'", '"']) {
      expect(name).not.toContain(ch)
    }
  })

  test('length is bounded on both the stem and the extension', () => {
    const long = `${'a'.repeat(500)}.${'b'.repeat(500)}`
    const { name } = safeAttachmentName(long)
    expect(name.length).toBeLessThanOrEqual(60 + 1 + 12)
  })

  test('unicode reduces to something writable rather than being refused', () => {
    const { name } = safeAttachmentName('relatório-ação-📊.csv')
    expect(name.endsWith('.csv')).toBe(true)
    expect(/^[A-Za-z0-9._-]+$/.test(name)).toBe(true)
  })

  test('`changed` reports honestly, so the caller can say the name was rewritten', () => {
    expect(safeAttachmentName('notes.txt').changed).toBe(false)
    expect(safeAttachmentName('../notes.txt').changed).toBe(true)
    expect(safeAttachmentName('my notes.txt').changed).toBe(true)
  })
})

describe('storedAttachmentName', () => {
  test('prefixes the id, so two uploads of one filename cannot collide', () => {
    expect(storedAttachmentName('notes.txt', 'abc123')).toBe('abc123-notes.txt')
    expect(storedAttachmentName('notes.txt', 'def456')).not.toBe(storedAttachmentName('notes.txt', 'abc123'))
  })

  test('the prefix does not rescue a hostile name — the name is still rebuilt', () => {
    expect(storedAttachmentName('../../etc/passwd', 'x')).toBe('x-passwd')
  })
})
