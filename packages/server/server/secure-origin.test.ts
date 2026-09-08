import { test, expect } from 'bun:test'
import { secureOriginFor } from './secure-origin'

/** The real shape, read off this machine while both rules were configured. */
const REAL = {
  Web: {
    'alien-wsl.seahorse-cobia.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4900' } } },
    'alien-wsl.seahorse-cobia.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:47292' } } },
  },
}

test('finds the https origin that proxies to OUR web port, and no other', () => {
  expect(secureOriginFor(REAL, 47292)).toBe('https://alien-wsl.seahorse-cobia.ts.net:8443')
})

/**
 * The rule that keeps this from being a confident wrong answer: an https origin pointing at some
 * OTHER service on the same machine is not this dashboard, and sending somebody there is worse
 * than sending them nowhere.
 */
test('never claims an origin that serves something else', () => {
  expect(secureOriginFor(REAL, 4900)).toBe('https://alien-wsl.seahorse-cobia.ts.net')
  expect(secureOriginFor(REAL, 9999)).toBe(null)
})

test('drops an explicit :443 — an origin says nothing about its default port', () => {
  const s = { Web: { 'h.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:47292' } } } } }
  expect(secureOriginFor(s, 47292)).toBe('https://h.ts.net')
})

/**
 * A sub-path proxy would serve the app from a base the bundle was not built for — the service
 * worker's scope, the manifest's `start_url` and every absolute asset are root-relative. A link to
 * a broken page is worse than no link.
 */
test('ignores a handler that is not the ROOT', () => {
  const s = { Web: { 'h.ts.net:8443': { Handlers: { '/agentistics': { Proxy: 'http://127.0.0.1:47292' } } } } }
  expect(secureOriginFor(s, 47292)).toBe(null)
})

test('a proxy to another MACHINE is not this dashboard', () => {
  const s = { Web: { 'h.ts.net:8443': { Handlers: { '/': { Proxy: 'http://10.0.0.5:47292' } } } } }
  expect(secureOriginFor(s, 47292)).toBe(null)
})

test('accepts the other ways loopback is written', () => {
  for (const host of ['localhost', '[::1]']) {
    const s = { Web: { 'h.ts.net:8443': { Handlers: { '/': { Proxy: `http://${host}:47292` } } } } }
    expect(secureOriginFor(s, 47292)).toBe('https://h.ts.net:8443')
  }
})

test('says null for everything it cannot read, rather than guessing', () => {
  expect(secureOriginFor(null, 47292)).toBe(null)
  expect(secureOriginFor({}, 47292)).toBe(null)
  expect(secureOriginFor({ Web: {} }, 47292)).toBe(null)
  expect(secureOriginFor({ Web: { 'h:8443': {} } }, 47292)).toBe(null)
  expect(secureOriginFor({ Web: { 'h:8443': { Handlers: { '/': { Proxy: 42 } } } } }, 47292)).toBe(null)
  expect(secureOriginFor({ Web: { 'h:8443': { Handlers: { '/': { Proxy: 'not a url' } } } } }, 47292)).toBe(null)
})
