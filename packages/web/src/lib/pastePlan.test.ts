import { expect, test, describe } from 'bun:test'
import {
  MAX_ATTACHMENTS, PASTE_LINE_LIMIT, PASTE_TEXT_LIMIT,
  attachmentRoom, pastedTextName, planPaste,
} from './pastePlan'

const file = (name: string) => new File(['x'], name)

describe('planPaste', () => {
  test('ordinary text goes in the field — that is what pasting means', () => {
    expect(planPaste({ files: [], text: 'fix the auth bug', existing: 0 }))
      .toEqual({ kind: 'text', text: 'fix the auth bug' })
  })

  test('files win over text', () => {
    // A copied screenshot arrives with BOTH an image and a text/plain fallback, usually the file
    // name. Inserting the name is never what was meant.
    const plan = planPaste({ files: [file('shot.png')], text: 'shot.png', existing: 0 })
    expect(plan.kind).toBe('files')
  })

  test('a very long paste is attached instead of typed', () => {
    // The composer types into a tmux pane character by character; a paste this size is a file
    // somebody had in the clipboard, and typing it would take minutes.
    const huge = 'x'.repeat(PASTE_TEXT_LIMIT + 1)
    const plan = planPaste({ files: [], text: huge, existing: 0 })
    expect(plan.kind).toBe('textFile')
  })

  test('many SHORT lines count too — a 300-row log is a log whatever its character count', () => {
    const log = Array.from({ length: PASTE_LINE_LIMIT + 1 }, (_, i) => `line ${i}`).join('\n')
    expect(log.length).toBeLessThan(PASTE_TEXT_LIMIT)
    expect(planPaste({ files: [], text: log, existing: 0 }).kind).toBe('textFile')
  })

  test('right at the limits it is still a message', () => {
    expect(planPaste({ files: [], text: 'x'.repeat(PASTE_TEXT_LIMIT), existing: 0 }).kind).toBe('text')
    const atLines = Array.from({ length: PASTE_LINE_LIMIT }, () => 'a').join('\n')
    expect(planPaste({ files: [], text: atLines, existing: 0 }).kind).toBe('text')
  })

  test('a batch is trimmed to what still fits', () => {
    const files = Array.from({ length: 8 }, (_, i) => file(`f${i}.png`))
    const plan = planPaste({ files, text: '', existing: 5 })
    expect(plan.kind).toBe('files')
    if (plan.kind === 'files') expect(plan.files).toHaveLength(MAX_ATTACHMENTS - 5)
  })

  test('with no room left, a file paste does nothing rather than silently dropping the cap', () => {
    expect(planPaste({ files: [file('a.png')], text: '', existing: MAX_ATTACHMENTS }).kind).toBe('none')
  })

  test('with no room left, a big paste goes in the FIELD rather than being refused', () => {
    // Losing content the user chose to send is worse than a slow paste.
    const huge = 'x'.repeat(PASTE_TEXT_LIMIT + 1)
    expect(planPaste({ files: [], text: huge, existing: MAX_ATTACHMENTS }).kind).toBe('text')
  })

  test('an empty clipboard yields nothing', () => {
    expect(planPaste({ files: [], text: '', existing: 0 })).toEqual({ kind: 'none' })
  })
})

describe('pastedTextName', () => {
  test('uses a first line that reads like a name', () => {
    expect(pastedTextName('deploy-notes\nrest of it')).toBe('deploy-notes.txt')
  })

  test('falls back for anything that does not — a stack trace is not a name', () => {
    expect(pastedTextName('Traceback (most recent call last):\n  File "x"')).toBe('pasted.txt')
    expect(pastedTextName('a'.repeat(200))).toBe('pasted.txt')
    expect(pastedTextName('   \nx')).toBe('pasted.txt')
    expect(pastedTextName('!!!')).toBe('pasted.txt')
  })

  test('always ends in .txt, so the chip and the file agree about what it is', () => {
    for (const s of ['notes', 'Traceback: x', '', 'a b c']) {
      expect(pastedTextName(s).endsWith('.txt')).toBe(true)
    }
  })
})

describe('attachmentRoom', () => {
  test('never negative, even if the cap were somehow already exceeded', () => {
    expect(attachmentRoom(0)).toBe(MAX_ATTACHMENTS)
    expect(attachmentRoom(MAX_ATTACHMENTS)).toBe(0)
    expect(attachmentRoom(MAX_ATTACHMENTS + 5)).toBe(0)
  })
})
