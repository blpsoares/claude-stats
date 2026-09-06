import { describe, expect, it } from 'bun:test'
import { MIN_BAR_TABS, splitAsideTabs, type AsideTabFit } from './asideTabs'

/** Eight tabs at plausible rendered widths — the panel's real set, measured shapes. */
const TABS: AsideTabFit[] = [
  { id: 'files', width: 76 },
  { id: 'docs', width: 58 },
  { id: 'live', width: 66 },
  { id: 'gallery', width: 72 },
  { id: 'skills', width: 60 },
  { id: 'agents', width: 96 },
  { id: 'mcps', width: 62 },
  { id: 'prs', width: 52 },
]
const M = { container: 424, overflowWidth: 62, gap: 2 }

describe('splitAsideTabs — what the bar keeps', () => {
  it('puts everything on the bar when everything fits, and draws no control', () => {
    // Rule 2: reserving room for the control while nothing overflows would push a tab out in order
    // to advertise that nothing was pushed out.
    const s = splitAsideTabs(TABS, 'files', { ...M, container: 2000 })
    expect(s.bar).toHaveLength(8)
    expect(s.hidden).toEqual([])
    expect(s.overflow).toBe(false)
  })

  it('reserves the control only once something genuinely overflows', () => {
    const s = splitAsideTabs(TABS, 'files', M)
    expect(s.overflow).toBe(true)
    expect(s.bar.length).toBeLessThan(8)
    expect(s.bar.length + s.hidden.length).toBe(8)
  })

  it('keeps the tabs in their own order — the bar is not re-sorted by what fits', () => {
    const s = splitAsideTabs(TABS, 'files', M)
    const order = TABS.map(t => t.id)
    expect(s.bar).toEqual(order.filter(id => s.bar.includes(id)))
  })
})

describe('the ACTIVE tab is always on the bar', () => {
  it('brings a tab that would have fallen past the fold onto the bar', () => {
    // The bug the horizontal scroll already had: the bar shows tabs while the content comes from
    // one you cannot see.
    const s = splitAsideTabs(TABS, 'prs', M)
    expect(s.bar).toContain('prs')
    expect(s.hidden).not.toContain('prs')
  })

  it('displaces the LAST tab that fitted, never one further left', () => {
    const wide = splitAsideTabs(TABS, 'files', M)
    const displaced = wide.bar[wide.bar.length - 1]!
    const s = splitAsideTabs(TABS, 'prs', M)
    expect(s.bar.slice(0, -1)).toEqual(wide.bar.slice(0, -1))
    expect(s.hidden).toContain(displaced)
  })

  it('leaves the bar alone when the active tab already fits', () => {
    const s = splitAsideTabs(TABS, 'files', M)
    expect(s.bar[0]).toBe('files')
  })

  it('ignores an active id that is not in the list at all', () => {
    const s = splitAsideTabs(TABS, 'nope', M)
    expect(s.bar.length + s.hidden.length).toBe(8)
    expect(s.bar).not.toContain('nope')
  })
})

describe('the floor, and the unmeasured first paint', () => {
  it('never reduces the bar below two tabs, however narrow', () => {
    // A bar reduced to its overflow button is a menu wearing a bar's clothes, and the tabs are then
    // strictly harder to reach than they were.
    const s = splitAsideTabs(TABS, 'files', { ...M, container: 40 })
    expect(s.bar).toHaveLength(MIN_BAR_TABS)
    expect(s.overflow).toBe(true)
  })

  it('draws every tab while the width is not known yet', () => {
    // A first paint has no width; guessing "nothing fits" would collapse the bar for one frame on
    // every mount, which reads as a fault. The component clips for that frame instead.
    for (const container of [0, -10, Number.NaN]) {
      const s = splitAsideTabs(TABS, 'files', { ...M, container })
      expect(s.bar).toHaveLength(8)
      expect(s.overflow).toBe(false)
    }
  })

  it('answers an empty list without inventing a control', () => {
    expect(splitAsideTabs([], 'files', M)).toEqual({ bar: [], hidden: [], overflow: false })
  })
})

describe('a phone, where the aside is ~343px', () => {
  it('still keeps the active tab and still offers every other one', () => {
    const s = splitAsideTabs(TABS, 'agents', { ...M, container: 327 })
    expect(s.bar).toContain('agents')
    expect(s.overflow).toBe(true)
    expect([...s.bar, ...s.hidden].sort()).toEqual(TABS.map(t => t.id).sort())
  })
})
