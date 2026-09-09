/**
 * money.ts — the board prices in the reader's OWN currency, like every other screen.
 *
 * `fmtUSD` was the board's own formatter and it hardcoded a dollar sign, so a dashboard set to BRL
 * — the header, the cost page, the session cards, all of it in `R$` — answered `$12.07` on the one
 * screen whose entire subject is what work COST. Nothing was wrong with the number; it was labelled
 * with a currency the reader does not pay in, which is the same class of error as an unlabelled
 * total: it invites a comparison that is off by the exchange rate.
 *
 * The conversion is `@agentistics/core`'s `fmtCost` and the rate is the one `/api/rates` already
 * cached for the rest of the app, read off the page's own `AppContext`. Neither is re-derived here:
 * a second rate is a second answer, and the board would then disagree with the header above it.
 *
 * `null` stays `N/A`. A delivery nobody could price is not a delivery that cost nothing, and the
 * conversion must not turn one into `R$0,00`.
 */

import { useCallback } from 'react'
import { useOutletContext } from 'react-router-dom'
import { fmtCost } from '@agentistics/core'
import { NA } from './board'
import type { AppContext } from '../../lib/app-context'

export type Money = (usd: number | null | undefined) => string

/** The formatter with nothing to read the preference from — dollars, unconverted. */
export const usdOnly: Money = n => (n === null || n === undefined ? NA : fmtCost(n))

/**
 * Every board surface renders under a route, so the page's context is there to be read.
 *
 * It is read DEFENSIVELY all the same: a component mounted outside a router (a test, a future
 * embed) gets dollars rather than a crash, which is the one behaviour that cannot mislead — an
 * unconverted figure under its own `USD` label is true.
 */
export function useMoney(): Money {
  const ctx = useOutletContext<AppContext | null>()
  const currency = ctx?.currency ?? 'USD'
  const rate = ctx?.brlRate ?? 1
  return useCallback(
    n => (n === null || n === undefined ? NA : fmtCost(n, currency, rate)),
    [currency, rate],
  )
}
