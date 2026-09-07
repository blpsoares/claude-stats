import { test, expect } from 'bun:test'
import {
  headerFit, stripPadding, COST_BASIS_W, FULL_BAR_W, COMPACT_DATE_BAR_W, ICON_ACTIVE_BAR_W, ICON_BOTH_BAR_W,
  MIN_BAR_W,
  DATE_FULL_W, DATE_COMPACT_W, ACTIVE_W, ACTIVE_ICON_W, ADD_FILTER_W, ADD_FILTER_ICON_W,
} from './headerFit'

test('a wide strip keeps the presets, the from/to range and both labels', () => {
  const fit = headerFit(1600)
  expect(fit).toEqual({ date: 'full', activeFilters: 'label', addFilter: 'label' })
  expect(headerFit(FULL_BAR_W).date).toBe('full')
})

test('the date block is the FIRST thing given up — everything else keeps its words', () => {
  const fit = headerFit(FULL_BAR_W - 1)
  expect(fit.date).toBe('compact')
  expect(fit.activeFilters).toBe('label')
  expect(fit.addFilter).toBe('label')
})

test('then "see active filters" loses its label, and + Filtro keeps its own', () => {
  const fit = headerFit(COMPACT_DATE_BAR_W - 1)
  expect(fit).toEqual({ date: 'compact', activeFilters: 'icon', addFilter: 'label' })
})

test('+ Filtro gives up its word LAST — it is the only way to add one', () => {
  const fit = headerFit(ICON_ACTIVE_BAR_W - 1)
  expect(fit).toEqual({ date: 'compact', activeFilters: 'icon', addFilter: 'icon' })
})

test('the tiers descend: each one is genuinely narrower than the one above it', () => {
  expect(COMPACT_DATE_BAR_W).toBeLessThan(FULL_BAR_W)
  expect(ICON_ACTIVE_BAR_W).toBeLessThan(COMPACT_DATE_BAR_W)
  expect(ICON_BOTH_BAR_W).toBeLessThan(ICON_ACTIVE_BAR_W)
})

test('every tier is the sum of what it actually draws, never a number picked to feel right', () => {
  const gaps = 2 * 8
  expect(FULL_BAR_W).toBe(DATE_FULL_W + ACTIVE_W + ADD_FILTER_W + gaps)
  expect(ICON_BOTH_BAR_W).toBe(DATE_COMPACT_W + ACTIVE_ICON_W + ADD_FILTER_ICON_W + gaps)
})

test('the floor still fits the narrowest desktop, so nothing is ever removed outright', () => {
  // 768px viewport, less the collapsed rail and the two page insets, less the view tabs, the
  // session actions and a minimum title — what is left is what the bar gets.
  const narrowestDesktopSlot = 768 - 64 - 48 - 200 - 130 - 100
  expect(ICON_BOTH_BAR_W).toBeLessThanOrEqual(narrowestDesktopSlot)
})

test('an unmeasured width answers the widest layout — never a collapse on first paint', () => {
  for (const w of [0, -1, Number.NaN]) {
    expect(headerFit(w)).toEqual({ date: 'full', activeFilters: 'label', addFilter: 'label' })
  }
})

// --- stripPadding: centring is what gives way, not the controls ---------------------------------

test('centres fully while there is slack for it', () => {
  // A wide screen: the cluster's width fits inside the slack, so the bar lands on the strip's own
  // centre line AND still has room for its widest layout.
  expect(stripPadding(2000, 300)).toBe(300)
  expect(headerFit(2000 - stripPadding(2000, 300)).date).toBe('full')
})

test('gives the centring up BEFORE it gives a control up', () => {
  // The reported case: a 930px slot beside a 258px cluster. Charging the cluster twice — once as a
  // sibling, once as centring padding — left 672 and collapsed the date block with most of the
  // header empty beside it.
  const slot = 930
  const actions = 258
  expect(slot - actions).toBeLessThan(FULL_BAR_W)   // what it used to pass
  const pad = stripPadding(slot, actions)
  expect(pad).toBeLessThan(actions)                 // less centred…
  expect(headerFit(slot - pad).date).toBe('full')   // …and the controls survive
})

test('stops centring entirely rather than compacting for it', () => {
  expect(stripPadding(FULL_BAR_W, 300)).toBe(0)
  expect(stripPadding(FULL_BAR_W - 50, 300)).toBe(0)
})

test('never returns something that is not a number', () => {
  expect(stripPadding(Number.NaN, 300)).toBe(0)
  expect(stripPadding(2000, Number.NaN)).toBe(0)
})

// --- headerFit: what the bar draws that the tiers do not name -----------------------------------

test('budgets the cost-basis toggle when the page offers one', () => {
  // The `API | Plan` toggle sits on the same line and was in no tier's sum, so the bar drew wider
  // than it had been budgeted for.
  expect(headerFit(FULL_BAR_W).date).toBe('full')
  expect(headerFit(FULL_BAR_W, COST_BASIS_W).date).toBe('compact')
  expect(headerFit(FULL_BAR_W + COST_BASIS_W, COST_BASIS_W).date).toBe('full')
})

test('reserves nothing for a toggle that is not there — a central has none', () => {
  expect(headerFit(FULL_BAR_W, 0)).toEqual(headerFit(FULL_BAR_W))
})

/**
 * THE FLOOR, which is what the slot hosting the bar must not go below.
 *
 * `headerFit` promises the bar shrinks rather than clips, and that promise ends at the narrowest
 * tier: below it there is no tier left, and the bar — `flexWrap: nowrap`, `maxWidth: 100%` — can
 * neither wrap nor clip, so its controls crush into each other. Reported from a tablet with eleven
 * filters on, against a slot whose `minWidth` was 90 — 122px under what the narrowest tier draws.
 */
test('IS the narrowest tier, so the floor and the tier can never disagree', () => {
  expect(MIN_BAR_W).toBe(ICON_BOTH_BAR_W)
})

test('is enough for the tier chosen AT it — the floor is self-consistent', () => {
  // At exactly the floor, `headerFit` picks the layout the floor was measured from. Anything else
  // would mean the slot reserves one layout's width and the bar draws another's.
  expect(headerFit(MIN_BAR_W)).toEqual({ date: 'compact', activeFilters: 'icon', addFilter: 'icon' })
})

test('budgets for the CROWDED case, like every tier here', () => {
  // "See active filters" exists only while something is filtering. A floor that fits only an
  // unfiltered bar fails the moment somebody filters — which is when the bar is at its widest and
  // the only time the count badge, the thing that crushed, is even drawn.
  expect(MIN_BAR_W).toBeGreaterThanOrEqual(DATE_COMPACT_W + ACTIVE_ICON_W + ADD_FILTER_ICON_W)
})

test('is below every wider tier, so it never forces a compaction that was not needed', () => {
  expect(MIN_BAR_W).toBeLessThan(ICON_ACTIVE_BAR_W)
  expect(MIN_BAR_W).toBeLessThan(COMPACT_DATE_BAR_W)
  expect(MIN_BAR_W).toBeLessThan(FULL_BAR_W)
})
