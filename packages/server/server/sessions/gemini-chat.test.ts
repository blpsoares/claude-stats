import { describe, expect, it } from 'bun:test'
import { parseGeminiChatTurns } from './gemini-chat'

/**
 * VERBATIM shapes from `~/.gemini/tmp/agentistics/chats/session-2026-09-08T14-11-2a2b4e9d.jsonl`,
 * captured 2026-09-08 against gemini 0.55.x — the file the harness wrote for a session agentop had
 * just started.
 */
const HEADER = JSON.stringify({
  sessionId: '2a2b4e9d-c1ac-4b92-8a23-d2dc9a2158a2',
  projectHash: 'ce276284a10422f5496a58c38fa491f7891a1bf27',
  startTime: '2026-09-08T14:11:24.125Z',
  lastUpdated: '2026-09-08T14:11:24.125Z',
  kind: 'main',
})
const SEED = JSON.stringify({ $set: { messages: [], lastUpdated: '2026-09-08T14:11:24.125Z' } })
const PATCH = JSON.stringify({ $set: { lastUpdated: '2026-09-08T14:12:18.661Z' } })
const USER = JSON.stringify({
  id: '5295492b-11e0-43a0-89db-62ab3d4769ef',
  timestamp: '2026-09-08T14:11:33.230Z',
  type: 'user',
  content: [{ text: 'responda apenas: ok' }],
})
const MODEL = JSON.stringify({
  id: '9f1ae60b-59d7-46ed-8684-f6d479b2f05a',
  timestamp: '2026-09-08T14:12:18.661Z',
  type: 'gemini',
  content: 'ok',
  model: 'gemini-3.5-flash',
})

const lines = (...l: string[]) => l

describe('parseGeminiChatTurns', () => {
  it('reads the conversation, oldest first, with both roles', () => {
    const turns = parseGeminiChatTurns(lines(HEADER, SEED, USER, PATCH, MODEL, PATCH), 50)
    expect(turns.map(t => [t.role, t.text])).toEqual([
      ['user', 'responda apenas: ok'],
      ['assistant', 'ok'],
    ])
    expect(turns[0]!.at).toBe('2026-09-08T14:11:33.230Z')
  })

  /** The header and the `lastUpdated` patches are bookkeeping. Neither is a turn. */
  it('draws no turn from the header or a bare patch', () => {
    expect(parseGeminiChatTurns(lines(HEADER, SEED, PATCH, PATCH), 50)).toEqual([])
  })

  /**
   * A resumed session's opening snapshot repeats turns that then arrive again as their own lines.
   * Same rule as the metrics parser: `id` decides, and one turn is one turn.
   */
  it('counts a turn once when the snapshot and its own line both carry it', () => {
    const msg = {
      id: 'dup-1', timestamp: '2026-09-08T14:11:33.230Z', type: 'user', content: 'oi',
    }
    const turns = parseGeminiChatTurns(
      lines(HEADER, JSON.stringify({ $set: { messages: [msg] } }), JSON.stringify(msg)), 50)
    expect(turns.map(t => t.text)).toEqual(['oi'])
  })

  /**
   * `info` and `error` are the harness talking about itself, not either party talking. They are
   * dropped rather than attributed to somebody — the same rule `antigravity-chat.ts` applies to a
   * `SYSTEM_MESSAGE`.
   */
  it('drops the harness\'s own notices instead of giving them a speaker', () => {
    const info = JSON.stringify({ id: 'i-1', type: 'info', content: 'Loaded cached credentials.' })
    const err = JSON.stringify({ id: 'e-1', type: 'error', content: 'quota exceeded' })
    expect(parseGeminiChatTurns(lines(HEADER, info, err, MODEL), 50).map(t => t.role))
      .toEqual(['assistant'])
  })

  /**
   * gemini writes a `<session_context>` bootstrap block under the USER role on startup. It is not
   * something the person said, and showing it makes every session open on a wall of injected
   * context — the same rule every other reader here applies to an injected entry.
   */
  it('drops the injected session context, and keeps the message after it', () => {
    const boot = JSON.stringify({
      id: 'b-1', type: 'user',
      content: '<session_context>cwd=/home/x\nfiles=…</session_context>',
    })
    const turns = parseGeminiChatTurns(lines(HEADER, boot, USER), 50)
    expect(turns.map(t => t.text)).toEqual(['responda apenas: ok'])
  })

  /** The window is the LAST `max` turns — a chat opens on what was just said. */
  it('keeps the newest turns when the window is smaller than the conversation', () => {
    const many = [HEADER]
    for (let i = 0; i < 6; i++) {
      many.push(JSON.stringify({ id: `u${i}`, type: 'user', content: `m${i}` }))
    }
    expect(parseGeminiChatTurns(many, 2).map(t => t.text)).toEqual(['m4', 'm5'])
  })

  /** A line that will not parse costs that line, never the conversation. */
  it('skips an unparseable line and reads the rest', () => {
    expect(parseGeminiChatTurns(lines(HEADER, '{ not json', USER), 50).map(t => t.text))
      .toEqual(['responda apenas: ok'])
  })

  it('answers with nothing for an empty file', () => {
    expect(parseGeminiChatTurns([], 50)).toEqual([])
  })
})
