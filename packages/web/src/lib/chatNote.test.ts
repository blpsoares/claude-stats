import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHAT_NOTES, chatNote } from './chatNote'

describe('chatNote', () => {
  it('THE REPORTED CASE: a chip says what it means', () => {
    // "quando aparecem esses cardzinhos embaixo de mensagens eu nunca sei o que eles significam".
    const r = chatNote('background task reported back', true)
    expect(r.label).toBe('tarefa em segundo plano respondeu')
    expect(r.help).toBeTruthy()
  })

  it('sends the reader to the tab that IS the answer', () => {
    expect(chatNote('background task reported back', false).tab).toBe('agents')
    expect(chatNote('a skill was loaded', false).tab).toBe('skills')
    expect(chatNote('an image was attached', false).tab).toBe('gallery')
  })

  it('does NOT send a command note to a feed of hundreds with no step to land on', () => {
    // The edge strip's own comment calls that a mistake: a navigation control rather than an
    // answer. A chat turn carries no step id, so these explain and do not navigate.
    expect(chatNote('command output', false).tab).toBe(null)
    expect(chatNote('shell command', false).tab).toBe(null)
    expect(chatNote('command output', false).help).toBeTruthy()
  })

  it('a note nobody has mapped keeps its own words and claims nothing', () => {
    const r = chatNote('some future note', true)
    expect(r).toEqual({ label: 'some future note', help: null, tab: null })
  })

  it('English keeps the note as the server wrote it', () => {
    expect(chatNote('system reminder', false).label).toBe('system reminder')
  })

  it('every row carries both languages of both strings', () => {
    for (const [key, row] of Object.entries(CHAT_NOTES)) {
      expect(row.pt.length, `${key}: pt`).toBeGreaterThan(0)
      expect(row.help.en.length, `${key}: help.en`).toBeGreaterThan(0)
      expect(row.help.pt.length, `${key}: help.pt`).toBeGreaterThan(0)
      // The help must SAY something, not restate the label.
      expect(row.help.en.toLowerCase(), `${key}: help repeats the label`).not.toBe(key.toLowerCase())
    }
  })
})

/**
 * THE TABLE MUST NOT FALL BEHIND THE SERVER.
 *
 * `SYSTEM_NOTE_PT` — the table this one replaces — did exactly that: five readers arrived with
 * their own notes and it never grew, so a conversation in any of them printed English chrome in
 * the middle of a Portuguese screen. It survived unnoticed because the fall-through is graceful,
 * which is the right fall-through and the reason the gap needs a test rather than vigilance.
 *
 * Greps the server's own sources, the way `tokens.lint.test.ts` greps for two-term token sums.
 */
describe('every note the server can emit has a row', () => {
  const dir = join(import.meta.dir, '../../../server/server/sessions')

  it('finds them all', () => {
    const emitted = new Set<string>()
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
      const src = readFileSync(join(dir, file), 'utf-8')
      for (const m of src.matchAll(/note: '([^']+)'/g)) emitted.add(m[1]!)
    }
    // The grep must actually find something, or this test passes by reading nothing.
    expect(emitted.size).toBeGreaterThan(10)
    const missing = [...emitted].filter(note => !(note in CHAT_NOTES))
    expect(missing, `notes with no row in CHAT_NOTES: ${missing.join(', ')}`).toEqual([])
  })
})
