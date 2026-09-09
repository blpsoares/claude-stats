import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * THE DEV PROXY MUST CARRY WEBSOCKETS, and nothing else in this repo would say so.
 *
 * `vite.config.ts` proxies `/api` to the API port, and a proxy entry without `ws: true` forwards
 * ordinary requests and silently DROPS an upgrade — the handshake gets no answer at all, so the
 * browser reports a plain connection failure with no status to look up. Both write channels ride a
 * WebSocket (`/api/fleet/input`, `/api/shell/input`), so under `bun run dev` typing into a session
 * or into a utility shell simply does nothing, while every other route works perfectly and the READ
 * stream (SSE, a plain GET) keeps drawing the live screen.
 *
 * That is the worst shape a dev-only gap can take: the feature looks alive and one half of it is
 * dead. Measured on 2026-09-09 — the same shell id opened a socket on the API port and timed out
 * with no response through the vite port.
 */
describe('the vite dev proxy', () => {
  const src = readFileSync(join(import.meta.dir, 'vite.config.ts'), 'utf-8')

  test('proxies WebSockets, or the write channels are dead in dev', () => {
    const proxyBlock = src.slice(src.indexOf('proxy:'))
    expect(proxyBlock).toContain('ws: true')
  })

  test('and the assertion is looking at the proxy, not at a comment somewhere else', () => {
    expect(src).toContain('proxy:')
    expect(src.indexOf('ws: true')).toBeGreaterThan(src.indexOf('proxy:'))
  })
})
