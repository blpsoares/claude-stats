import { describe, test, expect } from 'bun:test'
import { DEFAULT_ACCESSIBILITY_PREFS, ZOOM_MAX } from '@agentistics/core'
import { resolveA11yStore, applyA11yPut } from './a11y-prefs'

describe('resolveA11yStore', () => {
  test('a machine stores in its own preferences file, signed in or not', () => {
    expect(resolveA11yStore(false, null)).toEqual({ kind: 'machine' })
    expect(resolveA11yStore(false, 'acct-1')).toEqual({ kind: 'machine' })
  })

  test('a central stores per ACCOUNT — one operator must not configure everyone', () => {
    expect(resolveA11yStore(true, 'acct-1')).toEqual({ kind: 'account', accountId: 'acct-1' })
    expect(resolveA11yStore(true, 'acct-2')).toEqual({ kind: 'account', accountId: 'acct-2' })
  })

  test('a central session with no account resolves to anonymous, never to the machine file', () => {
    expect(resolveA11yStore(true, null)).toEqual({ kind: 'anonymous' })
    expect(resolveA11yStore(true, '')).toEqual({ kind: 'anonymous' })
  })

  test('a whitespace-only accountId is treated as absent, resolving to anonymous', () => {
    expect(resolveA11yStore(true, ' ')).toEqual({ kind: 'anonymous' })
    expect(resolveA11yStore(true, '  \t\n')).toEqual({ kind: 'anonymous' })
  })
})

describe('applyA11yPut', () => {
  test('an explicitly emptied lensesByPage comes back empty — no defaults are injected', () => {
    // The real replace-vs-merge guarantee lives in the route handler: it must write
    // applyA11yPut(body) as the whole stored document, never spread it over the document
    // it just read. That property has to be verified against the handler's own code.
    const emptied = applyA11yPut({ enabled: true, lensesByPage: {} })
    expect(emptied.lensesByPage).toEqual({})
  })

  test('it sanitises, so a stale client cannot store an impossible lens', () => {
    const out = applyA11yPut({ enabled: true, lensesByPage: { '/': [{ id: 'a', x: 0, y: 0, zoom: 1e9 }] } })
    expect(out.lensesByPage['/']![0]!.zoom).toBe(ZOOM_MAX)
  })

  test('junk yields the defaults instead of throwing', () => {
    expect(applyA11yPut(undefined)).toEqual(DEFAULT_ACCESSIBILITY_PREFS)
  })
})
