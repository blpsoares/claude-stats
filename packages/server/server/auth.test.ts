/**
 * auth.test.ts — unit tests for the pure helpers in auth.ts.
 *
 * No mocking, no filesystem, no network — pure function round-trips only.
 * Run with: bun test packages/server/server/auth.test.ts
 */

import { describe, expect, it } from 'bun:test'
import {
  signSession,
  verifySession,
  parseCookies,
  constantTimeEqual,
  handleSession,
} from './auth'

// ---------------------------------------------------------------------------
// signSession / verifySession
// ---------------------------------------------------------------------------

describe('signSession + verifySession', () => {
  const secret = 'test-secret-abc'
  const nowMs = 1_000_000_000_000 // fixed reference point

  it('round-trip: a freshly signed session verifies correctly', () => {
    const expiryMs = nowMs + 60_000
    const cookie = signSession(expiryMs, secret)
    expect(verifySession(cookie, secret, nowMs)).toBe(true)
  })

  it('fails on tampered HMAC', () => {
    const expiryMs = nowMs + 60_000
    const cookie = signSession(expiryMs, secret)
    // Flip the last character of the HMAC
    const tampered = cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a')
    expect(verifySession(tampered, secret, nowMs)).toBe(false)
  })

  it('fails when expired (expiryMs <= nowMs)', () => {
    const expiryMs = nowMs - 1 // already expired
    const cookie = signSession(expiryMs, secret)
    expect(verifySession(cookie, secret, nowMs)).toBe(false)
  })

  it('fails exactly at expiry boundary (expiryMs === nowMs)', () => {
    const expiryMs = nowMs
    const cookie = signSession(expiryMs, secret)
    // The spec: expiryMs > nowMs, so equal should fail
    expect(verifySession(cookie, secret, nowMs)).toBe(false)
  })

  it('fails with the wrong secret', () => {
    const expiryMs = nowMs + 60_000
    const cookie = signSession(expiryMs, secret)
    expect(verifySession(cookie, 'different-secret', nowMs)).toBe(false)
  })

  it('fails for undefined cookie value', () => {
    expect(verifySession(undefined, secret, nowMs)).toBe(false)
  })

  it('fails for empty string', () => {
    expect(verifySession('', secret, nowMs)).toBe(false)
  })

  it('fails for value without a dot separator', () => {
    expect(verifySession('nodot', secret, nowMs)).toBe(false)
  })

  it('fails for non-numeric expiry', () => {
    expect(verifySession('NaN.abc123', secret, nowMs)).toBe(false)
  })

  it('cookie format is expiryMs.hmacHex (no extra dots in payload)', () => {
    const expiryMs = nowMs + 60_000
    const cookie = signSession(expiryMs, secret)
    const [expiryStr, mac] = cookie.split('.')
    expect(Number(expiryStr)).toBe(expiryMs)
    // HMAC-SHA256 hex is always 64 characters
    expect(mac).toHaveLength(64)
    expect(mac).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ---------------------------------------------------------------------------
// constantTimeEqual
// ---------------------------------------------------------------------------

describe('constantTimeEqual', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEqual('hello', 'hello')).toBe(true)
  })

  it('returns false for different strings of the same length', () => {
    expect(constantTimeEqual('hello', 'hellx')).toBe(false)
  })

  it('returns false for different lengths', () => {
    expect(constantTimeEqual('short', 'longer-string')).toBe(false)
  })

  it('returns true for empty strings', () => {
    expect(constantTimeEqual('', '')).toBe(true)
  })

  it('returns false for one empty and one non-empty', () => {
    expect(constantTimeEqual('', 'x')).toBe(false)
  })

  it('handles 64-char hex strings (HMAC-SHA256 output length)', () => {
    const a = 'a'.repeat(64)
    const b = 'a'.repeat(63) + 'b'
    expect(constantTimeEqual(a, a)).toBe(true)
    expect(constantTimeEqual(a, b)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseCookies
// ---------------------------------------------------------------------------

describe('parseCookies', () => {
  it('parses a single cookie', () => {
    const result = parseCookies('foo=bar')
    expect(result).toEqual({ foo: 'bar' })
  })

  it('parses multiple cookies', () => {
    const result = parseCookies('a=1; b=2; c=3')
    expect(result).toEqual({ a: '1', b: '2', c: '3' })
  })

  it('returns empty object for null header', () => {
    expect(parseCookies(null)).toEqual({})
  })

  it('returns empty object for empty string', () => {
    expect(parseCookies('')).toEqual({})
  })

  it('handles cookie values that contain = (e.g. base64 or signed cookie)', () => {
    // The value after the first = may itself contain =
    const result = parseCookies('token=abc=def==')
    expect(result['token']).toBe('abc=def==')
  })

  it('trims whitespace around keys and values', () => {
    const result = parseCookies('  key  =  value  ')
    expect(result['key']).toBe('value')
  })

  it('ignores segments with no = sign', () => {
    const result = parseCookies('nodots; key=val')
    expect(result).toEqual({ key: 'val' })
  })
})

// ---------------------------------------------------------------------------
// handleSession
// ---------------------------------------------------------------------------

describe('handleSession', () => {
  it('returns JSON with authed, required, and central boolean fields', async () => {
    const req = new Request('http://localhost/api/team/session')
    const res = await handleSession(req)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json')

    const body = (await res.json()) as Record<string, unknown>
    // All three keys must be present
    expect('authed'   in body).toBe(true)
    expect('required' in body).toBe(true)
    expect('central'  in body).toBe(true)
    // All three values must be booleans
    expect(typeof body['authed']).toBe('boolean')
    expect(typeof body['required']).toBe('boolean')
    expect(typeof body['central']).toBe('boolean')
  })

  it('reports shellEnabled separately from capabilities.localShell', async () => {
    // Two different questions, and Settings has to be able to say "your profile allows this, you
    // have it off" — the same split `chatEnabled` already makes. `shellEnabled` is the capability
    // AND the user's switch; `capabilities.localShell` stays the exposure profile's answer alone.
    const body = (await (await handleSession(new Request('http://localhost/api/team/session'))).json()) as
      Record<string, unknown>
    expect(typeof body['shellEnabled']).toBe('boolean')
    // Absent reads as OFF: nobody acquires a browser shell by having upgraded.
    expect(body['shellEnabled']).toBe(false)
  })
})
