/**
 * status-bar.ts — today's spend, and how many sessions are waiting on a person.
 *
 * Two numbers with two different refresh rates, on purpose. The fleet is polled every 5 seconds
 * (the cockpit's own interval, so the two stay in step) and is a few kilobytes. `/api/data` is the
 * whole metrics payload — megabytes on a well-used machine — so it is re-read on a much slower
 * timer that the user can lengthen. Polling the large one at the small one's rate would spend a
 * megabyte a minute to move a figure that changes once a turn.
 *
 * **An unreachable server prints a sentence, never a zero.** `R$ 0,00` from a machine whose server
 * is not running is a confident, wrong answer to the one question this item exists to answer — the
 * same N/A-versus-a-real-0 rule the dashboard applies to a harness that cannot produce a metric.
 */

import * as vscode from 'vscode'
import { fmtCost } from '@agentistics/core'
import { fill } from './i18n'
import { shortTokens, type TodayTotals } from './today'

export class StatusBar {
  private readonly item: vscode.StatusBarItem
  private totals: TodayTotals | null = null
  /** `null` until the first read has come back — "not asked yet" is not "no answer". */
  private read = false
  private attention = 0
  private currency: 'USD' | 'BRL' = 'USD'
  /**
   * The live USD→BRL rate, or `null`.
   *
   * A null rate with BRL selected shows DOLLARS, not a converted figure invented from a guess —
   * the same rule the rest of this product follows about a number it cannot produce.
   */
  private rate: number | null = null

  constructor(private strings: Record<string, string>) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    // Clicking it goes to the fleet — the dashboard tab it used to open is gone (a VS Code webview
    // could not load the dashboard, and a control that does nothing is worse than no control).
    this.item.command = 'agentistics.focusSessions'
    this.item.name = 'Agentistics'
  }

  setStrings(strings: Record<string, string>): void {
    this.strings = strings
    this.render()
  }

  setTotals(totals: TodayTotals | null): void {
    this.totals = totals
    this.read = true
    this.render()
  }

  /** The chosen currency, and the rate to reach it with. */
  setCurrency(currency: 'USD' | 'BRL', rate: number | null): void {
    this.currency = currency
    this.rate = rate
    this.render()
  }

  setAttention(count: number): void {
    this.attention = count
    this.render()
  }

  show(visible: boolean): void {
    if (visible) this.item.show()
    else this.item.hide()
  }

  dispose(): void {
    this.item.dispose()
  }

  private render(): void {
    const waiting = this.attention > 0
      ? ` $(bell-dot) ${fill(this.strings.statusWaiting ?? '{0}', this.attention)}`
      : ''

    if (!this.read || !this.totals) {
      // Before the first answer, and after one that never came, the item says what it does not
      // know. The waiting count still shows: it comes from the other, cheaper, poll.
      this.item.text = `$(pulse) ${this.strings.statusUnknown ?? '—'}${waiting}`
      this.item.tooltip = this.strings.statusTitle ?? 'Agentistics'
      // Amber, not red: a server that is not running is not a fault, it is a machine at rest.
      this.item.backgroundColor = this.attention > 0
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined
      return
    }

    // `fmtCost` from `@agentistics/core` — the dashboard's own formatter, so the same day reads the
    // same in both places, down to the separators. BRL without a rate falls back to dollars rather
    // than printing a converted number nobody can stand behind.
    const useBrl = this.currency === 'BRL' && this.rate !== null
    const cost = fmtCost(this.totals.costUSD, useBrl ? 'BRL' : 'USD', useBrl ? this.rate! : 1)
    this.item.text = `$(pulse) ${fill(
      this.strings.statusToday ?? '{0} {1} {2}',
      cost,
      shortTokens(this.totals.tokens),
      this.totals.sessions,
    )}${waiting}`
    this.item.tooltip = this.strings.statusTitle ?? 'Agentistics'
    this.item.backgroundColor = this.attention > 0
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined
  }
}
