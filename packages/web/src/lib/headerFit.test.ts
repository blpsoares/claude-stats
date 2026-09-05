import { test, expect } from 'bun:test'
import {
  headerFit, FULL_BAR_W, COMPACT_DATE_BAR_W, ICON_ACTIVE_BAR_W, ICON_BOTH_BAR_W,
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
