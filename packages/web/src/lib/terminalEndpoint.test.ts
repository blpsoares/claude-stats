import { describe, expect, it } from 'bun:test'
import { inputWsUrl, streamUrl, type TerminalScope } from './terminalEndpoint'

describe('a scope decides which route a terminal talks to', () => {
  it('a fleet id reads the fleet stream', () => {
    expect(streamUrl('fleet', 'abc')).toBe('/api/fleet/stream?id=abc')
  })

  it('a shell id reads the SHELL stream, never the fleet one', () => {
    // The whole isolation argument, at the client end: a shell is not a fleet row, so a shell id
    // must never be offered to a route that resolves against `managed-sessions.json`.
    expect(streamUrl('shell', 'abc')).toBe('/api/shell/stream?id=abc')
    expect(streamUrl('shell', 'abc')).not.toContain('/api/fleet')
  })

  it('the id is encoded, so it can never smuggle a second query parameter', () => {
    expect(streamUrl('shell', 'a&b=c')).toBe('/api/shell/stream?id=a%26b%3Dc')
  })

  it('the write channel mirrors the read channel, scope for scope', () => {
    expect(inputWsUrl('fleet', 'abc', 'http:', 'host:1')).toBe('ws://host:1/api/fleet/input?id=abc')
    expect(inputWsUrl('shell', 'abc', 'http:', 'host:1')).toBe('ws://host:1/api/shell/input?id=abc')
  })

  it('https becomes wss', () => {
    expect(inputWsUrl('shell', 'x', 'https:', 'h')).toBe('wss://h/api/shell/input?id=x')
  })

  it('every scope has both halves', () => {
    const scopes: TerminalScope[] = ['fleet', 'shell']
    for (const s of scopes) {
      expect(streamUrl(s, 'i')).toStartWith('/api/')
      expect(inputWsUrl(s, 'i', 'http:', 'h')).toStartWith('ws://')
    }
  })
})
