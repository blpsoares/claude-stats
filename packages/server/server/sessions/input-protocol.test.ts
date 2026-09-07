import { describe, expect, test } from 'bun:test'
import {
  KEY_ALLOWLIST,
  MAX_INPUT_TEXT,
  ackFail,
  ackOk,
  encodeAck,
  parseInputMessage,
  wsInputOriginOk,
} from './input-protocol'

describe('parseInputMessage', () => {
  test('accepts a text message and keeps the literal data verbatim', () => {
    const r = parseInputMessage(JSON.stringify({ seq: 1, kind: 'text', data: 'h' }))
    expect(r).toEqual({ ok: true, msg: { seq: 1, kind: 'text', text: 'h' } })
  })

  test('a text message may carry a raw control byte (xterm.onData sends these)', () => {
    const r = parseInputMessage(JSON.stringify({ seq: 7, kind: 'text', data: '[A' }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.msg).toEqual({ seq: 7, kind: 'text', text: '[A' })
  })

  test('accepts a named key from the closed set', () => {
    const r = parseInputMessage(JSON.stringify({ seq: 2, kind: 'key', name: 'C-c' }))
    expect(r).toEqual({ ok: true, msg: { seq: 2, kind: 'key', key: 'C-c' } })
  })

  test('rejects invalid JSON with bad_json and a null seq', () => {
    const r = parseInputMessage('{not json')
    expect(r).toEqual({ ok: false, seq: null, reason: 'bad_json' })
  })

  test('rejects a non-object payload', () => {
    expect(parseInputMessage('42')).toEqual({ ok: false, seq: null, reason: 'bad_message' })
    expect(parseInputMessage('null')).toEqual({ ok: false, seq: null, reason: 'bad_message' })
    expect(parseInputMessage('"a"')).toEqual({ ok: false, seq: null, reason: 'bad_message' })
  })

  test('rejects a missing or non-numeric seq — an ack needs a real seq to map', () => {
    expect(parseInputMessage(JSON.stringify({ kind: 'text', data: 'a' })))
      .toEqual({ ok: false, seq: null, reason: 'bad_message' })
    expect(parseInputMessage(JSON.stringify({ seq: 'x', kind: 'text', data: 'a' })))
      .toEqual({ ok: false, seq: null, reason: 'bad_message' })
    expect(parseInputMessage(JSON.stringify({ seq: Infinity, kind: 'text', data: 'a' })))
      .toEqual({ ok: false, seq: null, reason: 'bad_message' })
  })

  test('rejects an unknown kind but echoes the seq so the client can map the failure', () => {
    expect(parseInputMessage(JSON.stringify({ seq: 5, kind: 'nope', data: 'a' })))
      .toEqual({ ok: false, seq: 5, reason: 'bad_message' })
  })

  test('rejects empty text — an empty send that "succeeds" would be a lie', () => {
    expect(parseInputMessage(JSON.stringify({ seq: 3, kind: 'text', data: '' })))
      .toEqual({ ok: false, seq: 3, reason: 'empty_text' })
  })

  test('rejects text that is not a string', () => {
    expect(parseInputMessage(JSON.stringify({ seq: 3, kind: 'text', data: 9 })))
      .toEqual({ ok: false, seq: 3, reason: 'bad_message' })
  })

  test('rejects text over the length ceiling', () => {
    const big = 'a'.repeat(MAX_INPUT_TEXT + 1)
    expect(parseInputMessage(JSON.stringify({ seq: 4, kind: 'text', data: big })))
      .toEqual({ ok: false, seq: 4, reason: 'text_too_long' })
  })

  test('accepts text exactly at the ceiling', () => {
    const atLimit = 'a'.repeat(MAX_INPUT_TEXT)
    const r = parseInputMessage(JSON.stringify({ seq: 4, kind: 'text', data: atLimit }))
    expect(r.ok).toBe(true)
  })

  test('rejects a key name OUTSIDE the closed allowlist — defence in depth', () => {
    for (const name of ['C-c; rm', 'a b', 'F1', 'Escape', 'Home', 'M-Up', 'PageDown', '', 'C-x']) {
      const r = parseInputMessage(JSON.stringify({ seq: 6, kind: 'key', name }))
      expect(r).toEqual({ ok: false, seq: 6, reason: 'bad_key' })
    }
  })

  test('rejects a non-string key name', () => {
    expect(parseInputMessage(JSON.stringify({ seq: 6, kind: 'key', name: 3 })))
      .toEqual({ ok: false, seq: 6, reason: 'bad_key' })
  })

  test('KEY_ALLOWLIST is exactly the agreed closed set', () => {
    expect([...KEY_ALLOWLIST].sort()).toEqual(
      ['BSpace', 'C-a', 'C-c', 'C-d', 'C-e', 'C-k', 'C-u', 'C-w', 'Down', 'Enter', 'Left', 'Right', 'Tab', 'Up'],
    )
    for (const k of KEY_ALLOWLIST) {
      expect(parseInputMessage(JSON.stringify({ seq: 1, kind: 'key', name: k })).ok).toBe(true)
    }
  })
})

describe('ack shapes', () => {
  test('ackOk / ackFail carry the seq and the outcome, and reason only on failure', () => {
    expect(ackOk(1)).toEqual({ seq: 1, ok: true })
    expect(ackFail(2, 'send_failed')).toEqual({ seq: 2, ok: false, reason: 'send_failed' })
    expect(ackFail(null, 'bad_json')).toEqual({ seq: null, ok: false, reason: 'bad_json' })
  })

  test('encodeAck is a valid JSON string echoing the seq', () => {
    expect(JSON.parse(encodeAck(ackOk(3)))).toEqual({ seq: 3, ok: true })
    expect(JSON.parse(encodeAck(ackFail(4, 'send_failed')))).toEqual({ seq: 4, ok: false, reason: 'send_failed' })
  })
})

describe('wsInputOriginOk — CSWSH protection', () => {
  const base = { host: 'localhost:47292', allowlist: [] as string[], dev: false }

  test('accepts the request’s own origin (same-origin dashboard), prod or dev', () => {
    expect(wsInputOriginOk({ ...base, origin: 'http://localhost:47292' })).toBe(true)
    expect(wsInputOriginOk({ ...base, origin: 'https://localhost:47292' })).toBe(true)
  })

  test('accepts an allowlisted origin', () => {
    expect(wsInputOriginOk({ ...base, origin: 'http://desk.example', allowlist: ['http://desk.example'] })).toBe(true)
  })

  test('accepts a localhost dev origin only in dev', () => {
    expect(wsInputOriginOk({ ...base, origin: 'http://localhost:5173', dev: true })).toBe(true)
    expect(wsInputOriginOk({ ...base, origin: 'http://localhost:5173', dev: false })).toBe(false)
  })

  test('rejects a foreign origin — the CSWSH case', () => {
    expect(wsInputOriginOk({ ...base, origin: 'http://evil.example' })).toBe(false)
  })

  test('accepts a missing Origin — a non-browser client; browsers always send one', () => {
    expect(wsInputOriginOk({ ...base, origin: null })).toBe(true)
  })
})
