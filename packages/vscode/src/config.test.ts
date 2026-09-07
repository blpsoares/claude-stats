import { describe, expect, it } from 'bun:test'
import { resolveEndpoints } from './config'

describe('resolveEndpoints', () => {
  it('defaults to the local server', () => {
    expect(resolveEndpoints({})).toEqual({ api: 'http://127.0.0.1:47291' })
  })

  it('takes the address the user named', () => {
    expect(resolveEndpoints({ apiUrl: 'http://dev-box.lan:9100' }).api).toBe('http://dev-box.lan:9100')
  })

  it('trims trailing slashes so callers can concatenate a path', () => {
    expect(resolveEndpoints({ apiUrl: 'http://127.0.0.1:47291/' }).api).toBe('http://127.0.0.1:47291')
  })

  it('reports an unreadable setting instead of silently correcting it', () => {
    // A working panel reading a machine the user did not name is worse than a visible complaint.
    const out = resolveEndpoints({ apiUrl: 'not a url' })
    expect(out.api).toBe('http://127.0.0.1:47291')
    expect(out.invalid).toBe('not a url')
  })

  it('refuses a scheme no fetch can follow', () => {
    expect(resolveEndpoints({ apiUrl: 'file:///tmp/x' }).invalid).toBe('file:///tmp/x')
  })
})
