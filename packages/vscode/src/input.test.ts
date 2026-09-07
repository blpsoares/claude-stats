/**
 * input.test.ts — what this client puts on the write channel's wire.
 *
 * The server validates every one of these again (`input-protocol.ts`, `KEY_ALLOWLIST`), and that is
 * the authority. What is tested here is the client not ASKING for things it knows will be refused —
 * a modifier press, a media key — because each of those would cost the user an ack failure for a
 * key nobody meant to send.
 */
import { describe, expect, it } from 'bun:test'
import { parseAck, wireFor } from './input'

describe('wireFor', () => {
  it('sends a printable character as literal text, never as a key name', () => {
    // `send-keys -l` types it; as a NAME it would be refused, and on a server without the allowlist
    // it would be interpreted as a key nobody has.
    expect(wireFor({ key: 'a' })).toEqual({ kind: 'text', data: 'a' })
    expect(wireFor({ key: 'A', shift: true })).toEqual({ kind: 'text', data: 'A' })
    expect(wireFor({ key: ' ' })).toEqual({ kind: 'text', data: ' ' })
  })

  it('uses tmux\'s vocabulary for the keys that have a name', () => {
    expect(wireFor({ key: 'Enter' })).toEqual({ kind: 'key', name: 'Enter' })
    expect(wireFor({ key: 'Backspace' })).toEqual({ kind: 'key', name: 'BSpace' })
    expect(wireFor({ key: 'ArrowUp' })).toEqual({ kind: 'key', name: 'Up' })
    expect(wireFor({ key: 'Tab' })).toEqual({ kind: 'key', name: 'Tab' })
  })

  it('sends the control keys the server accepts, and only those', () => {
    expect(wireFor({ key: 'c', ctrl: true })).toEqual({ kind: 'key', name: 'C-c' })
    // Uppercase arrives when shift is held; the key name is lowercase either way.
    expect(wireFor({ key: 'C', ctrl: true, shift: true })).toEqual({ kind: 'key', name: 'C-c' })
    expect(wireFor({ key: 'd', ctrl: true })).toEqual({ kind: 'key', name: 'C-d' })
    // Outside the server's set: refused here rather than sent and bounced.
    expect(wireFor({ key: 'z', ctrl: true })).toBeNull()
  })

  it('asks for nothing it knows will be refused', () => {
    // A modifier fires its own keydown, and a laptop's media row sends a whole family of names.
    // Sent, each costs the user one ack failure for a key they never pressed.
    expect(wireFor({ key: 'Shift', shift: true })).toBeNull()
    expect(wireFor({ key: 'MediaTrackNext' })).toBeNull()
    expect(wireFor({ key: 'F5' })).toBeNull()
    expect(wireFor({ key: 'a', ctrl: true, alt: true })).toBeNull()
    expect(wireFor({ key: 'b', alt: true })).toBeNull()
  })
})

describe('parseAck', () => {
  it('reads the ack the server sends', () => {
    expect(parseAck('{"seq":3,"ok":true}')).toEqual({ seq: 3, ok: true })
    expect(parseAck('{"seq":4,"ok":false,"reason":"bad_key"}'))
      .toEqual({ seq: 4, ok: false, reason: 'bad_key' })
  })

  it('keeps a rejection that could not carry a seq', () => {
    expect(parseAck('{"seq":null,"ok":false,"reason":"bad_json"}'))
      .toEqual({ seq: null, ok: false, reason: 'bad_json' })
  })

  it('is total — junk on the socket is ignored, never thrown on', () => {
    expect(parseAck('not json')).toBeNull()
    expect(parseAck('[]')).toBeNull()
    expect(parseAck('{"seq":1}')).toBeNull()
  })
})
