import { expect, test } from 'bun:test'
import { CHAT_MIN_WIDTH, PANEL_MIN_WIDTH, panelWidth } from './artifactLayout'

test('a request that fits is granted whole', () => {
  expect(panelWidth(1600, 620)).toBe(620)
})

test('the conversation keeps its floor when the request would starve it', () => {
  // 1200 wide with a 900px panel left 300px of chat — the report this exists for.
  expect(panelWidth(1200, 900)).toBe(1200 - CHAT_MIN_WIDTH)
})

test('the panel never goes under its own floor', () => {
  const w = panelWidth(600, 500)
  expect(w).toBeGreaterThanOrEqual(PANEL_MIN_WIDTH)
})

test('the clamp only ever narrows — a modest request in a wide window is untouched', () => {
  expect(panelWidth(1600, 300)).toBe(300)
})

test('when NEITHER floor can hold, the panel takes its own and the chat gets the rest', () => {
  // 600px of room cannot give 420 to the chat and 280 to the panel. That is the case
  // `resolveArtifactLayout` answers with `overlay`; if a split is drawn anyway it must not be a
  // 500px panel over a 100px conversation.
  expect(panelWidth(600, 500)).toBe(PANEL_MIN_WIDTH)
})

test('an unmeasured container grants the request rather than guessing', () => {
  // The observer has not reported yet. Granting the stored width is the previous behaviour and is
  // corrected a frame later; inventing a width here would resize the panel on every mount.
  expect(panelWidth(0, 620)).toBe(620)
  expect(panelWidth(Number.NaN, 620)).toBe(620)
})
