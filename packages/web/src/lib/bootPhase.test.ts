import { describe, it, expect } from 'bun:test'
import { bootLoading, type BootSignals } from './bootPhase'

// The whole app already had a boot loader, but it was gated on `loading` (the /api/data fetch)
// ALONE. `loading` flips false the instant that one fetch resolves — yet the app still cannot
// paint until the derived stats are computed AND the first-run preferences (the archive choice)
// have resolved. Those in-between moments returned a SILENT BLANK screen: the loader vanished
// before the data was ready. `bootLoading` is the single predicate that keeps the loader on until
// every one of those signals is ready.

const ready: BootSignals = { loading: false, hasData: true, hasDerived: true, prefsLoaded: true }

describe('bootLoading', () => {
  it('is false only when EVERYTHING the first paint needs is ready', () => {
    expect(bootLoading(ready)).toBe(false)
  })

  it('stays true while the /api/data fetch is in flight', () => {
    expect(bootLoading({ ...ready, loading: true })).toBe(true)
  })

  it('stays true when data has not arrived yet', () => {
    expect(bootLoading({ ...ready, hasData: false })).toBe(true)
  })

  it('stays true when derived stats are not computed yet', () => {
    expect(bootLoading({ ...ready, hasDerived: false })).toBe(true)
  })

  // THE regression this function exists for: the fetch settled (loading:false, data present) but
  // the first-run prefs are still loading, so the app is NOT ready — the loader must remain, never
  // a blank.
  it('stays true after the fetch settles while first-run prefs are still loading', () => {
    expect(bootLoading({ loading: false, hasData: true, hasDerived: true, prefsLoaded: false })).toBe(true)
  })

  it('is true if any single signal is not ready, in every combination', () => {
    const keys: (keyof BootSignals)[] = ['loading', 'hasData', 'hasDerived', 'prefsLoaded']
    for (const k of keys) {
      const s = { ...ready }
      // loading is inverted meaning (true = not ready); the others are false = not ready.
      ;(s as any)[k] = k === 'loading' ? true : false
      expect(bootLoading(s)).toBe(true)
    }
  })
})
