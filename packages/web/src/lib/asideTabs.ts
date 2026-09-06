/**
 * asideTabs.ts — PURE: which tabs fit on the aside's bar, and which the grid holds.
 *
 * The artifacts aside carries eight tabs in a column that is 440px on desktop and `min(440px, 88%)`
 * on mobile — about 343px on a 390px phone. They do not fit, and the stopgap was `overflow-x: auto`:
 * the tabs past the fold were invisible, nothing on screen said they existed, and reaching one was
 * a sideways drag inside a narrow column. Every round of work on this panel has added a tab.
 *
 * So the bar keeps what fits and a trailing control opens a GRID with every tab in it. This module
 * decides the split, and only the split — the measuring is the component's (see `widths`), because
 * labels are words in two languages and a width estimated from character counts is wrong in one of
 * them.
 *
 * FOUR RULES, and each is the difference between this and a junk drawer.
 *
 * 1. **THE ACTIVE TAB IS ALWAYS ON THE BAR.** If it would fall past the fold it takes the last
 *    visible slot and the tab that was there moves to the grid. A bar showing tabs while the
 *    content comes from one you cannot see is the "where am I" bug the scroll already had.
 * 2. **THE OVERFLOW CONTROL IS BUDGETED ONLY WHEN IT WILL EXIST.** Reserving room for it while
 *    everything fits pushes out a tab in order to advertise that nothing was pushed out. So the fit
 *    is computed WITHOUT it first, and only recomputed WITH it once something genuinely overflows.
 * 3. **A MINIMUM STAYS ON THE BAR.** A bar reduced to its overflow button is a menu wearing a
 *    bar's clothes, and at that point the tabs are strictly harder to reach than before. Below the
 *    minimum the bar keeps drawing them and gives up the fit instead — the component clips there,
 *    which is visible, rather than hiding them, which is not.
 * 4. **THE GRID HOLDS EVERY TAB, NOT THE LEFTOVERS.** Returned as `all`, with the active one
 *    marked by the caller. A grid of only what did not fit changes contents as the panel resizes,
 *    so the same tab is in a different place each time you look for it.
 */

/** One tab, as much of it as this module reads. Kept structural so it never imports the panel. */
export interface AsideTabFit {
  id: string
  /** The tab's rendered width in px, measured by the caller. */
  width: number
}

export interface TabSplit {
  /** The ids the bar draws, in the tabs' own order. */
  bar: string[]
  /** The ids the bar does NOT draw — what the overflow control's badge counts. */
  hidden: string[]
  /** Whether the overflow control is drawn at all. False only when everything fits. */
  overflow: boolean
}

/**
 * How few tabs the bar may be reduced to before it stops giving ground.
 *
 * Two, not one: with one visible tab plus a button there is nothing left for the bar to be, and the
 * grid is a strictly better version of that. Two is where a bar is still a bar.
 */
export const MIN_BAR_TABS = 2

/** Gap between tabs, and the bar's own horizontal padding — the component's own metrics. */
export interface BarMetrics {
  /** Usable width of the bar, measured. */
  container: number
  /** Width of the overflow control, measured. */
  overflowWidth: number
  /** Space between two tabs. */
  gap: number
}

function packed(tabs: readonly AsideTabFit[], room: number, gap: number): number {
  let used = 0
  let n = 0
  for (const t of tabs) {
    const next = used + (n === 0 ? 0 : gap) + t.width
    if (next > room) break
    used = next
    n++
  }
  return n
}

/**
 * Split the tabs between the bar and the grid.
 *
 * A container that has not been measured yet (0, negative, non-finite) puts EVERYTHING on the bar
 * and draws no overflow control: a first paint has no width, and guessing "nothing fits" would
 * collapse the bar to a button for one frame on every mount, which reads as a fault. The component
 * clips for that frame instead, and the measurement corrects it.
 */
export function splitAsideTabs(
  tabs: readonly AsideTabFit[],
  active: string,
  m: BarMetrics,
): TabSplit {
  const all = tabs.map(t => t.id)
  if (!Number.isFinite(m.container) || m.container <= 0 || tabs.length === 0) {
    return { bar: all, hidden: [], overflow: false }
  }

  // Rule 2: ask whether everything fits with NO control reserved.
  if (packed(tabs, m.container, m.gap) === tabs.length) {
    return { bar: all, hidden: [], overflow: false }
  }

  // Something overflows, so the control exists and takes its room.
  const room = m.container - m.overflowWidth - m.gap
  const count = Math.max(MIN_BAR_TABS, packed(tabs, room, m.gap))
  const shown = tabs.slice(0, Math.min(count, tabs.length))

  // Rule 1: the active tab is on the bar, even if it had to displace the last one that fitted.
  const barIds = shown.map(t => t.id)
  if (!barIds.includes(active) && all.includes(active)) {
    barIds[barIds.length - 1] = active
  }

  return {
    bar: barIds,
    hidden: all.filter(id => !barIds.includes(id)),
    overflow: true,
  }
}
