/**
 * costBasis.ts — the one place a cost figure is converted for display.
 *
 * All arithmetic lives in `@agentistics/core/billing`; this is wiring plus one multiply. What it
 * really carries is a REFUSAL: asking for the plan basis when there is no usable plan cost does
 * NOT produce a number. It returns the API figure, flagged, so the surface can render N/A or say
 * which basis it actually used — a surface must never be able to fabricate a plan number by
 * passing the wrong argument.
 *
 * `allocated` travels with the value rather than being decided per call site, because a per-row
 * plan figure is an ALLOCATION — no row was individually billed — and a label that can be
 * forgotten will be.
 */
import { planAllocation, type AggregatePlanBasis, type CostBasis, type HarnessId } from '@agentistics/core'

export interface CostView {
  usd: number
  /** The basis actually applied. May be `'api'` even when `'plan'` was requested. */
  basis: CostBasis
  /** The figure is a share of a plan cost, not a measurement of this row. */
  allocated: boolean
  /** The plan basis was requested and could not be produced. Render N/A, never this number. */
  unavailable: boolean
}

/**
 * Express one cost in the requested basis.
 *
 * `factor` is `C/A` for the scope this figure belongs to (`planAllocation`'s per-harness value, or
 * its aggregate). `null` means the plan cost is not computable there.
 */
export function viewCost(
  usd: number,
  opts: { basis: CostBasis; factor: number | null; allocated?: boolean },
): CostView {
  if (opts.basis === 'api') {
    return { usd, basis: 'api', allocated: false, unavailable: false }
  }
  if (opts.factor === null || !Number.isFinite(opts.factor)) {
    // The requested basis cannot be produced. Hand back the API figure AND say so — a caller that
    // ignores `unavailable` shows a real number under the wrong label, which is bad; one that
    // received a silent 0 would show a confident lie, which is worse.
    return { usd, basis: 'api', allocated: false, unavailable: true }
  }
  return {
    usd: usd * opts.factor,
    basis: 'plan',
    allocated: opts.allocated ?? false,
    unavailable: false,
  }
}

/**
 * The KEY of a cost row: which basis the number beside it is in.
 *
 * It follows `view.basis` — what was ACTUALLY applied — never what was requested. A plan figure
 * that could not be produced comes back as the API number flagged `unavailable`, and labelling
 * that "plan" would put a real API cost under a heading claiming it is the user's subscription.
 *
 * "Allocated" rather than "plan cost": within a session, a plan figure is a SHARE of a
 * subscription — nothing was billed for this conversation on its own — and a label that can be
 * forgotten will be.
 */
export function costBasisLabel(view: CostView, pt: boolean): string {
  if (view.basis === 'plan') return pt ? 'Rateado (plano)' : 'Allocated (plan)'
  return pt ? 'Estimado (API)' : 'Estimated (API)'
}

/**
 * The short marker a surface puts beside a converted figure.
 *
 * `null` when nothing needs saying — an API-basis figure on a page whose basis is API is simply
 * the number, and marking it would train people to ignore the marker that matters.
 */
export function costBasisMarker(view: CostView, lang: 'pt' | 'en'): string | null {
  const pt = lang === 'pt'
  if (view.unavailable) return pt ? 'sem plano cadastrado' : 'no registered plan'
  if (view.basis === 'api') return null
  if (view.allocated) return pt ? 'rateado' : 'allocated'
  return null
}

/**
 * Which harnesses a plan figure actually covers, and how many were on screen.
 *
 * `perHarness` holds one entry per harness present in the FILTERED data; the computable ones are
 * the only ones a plan cost was produced for. The two counts differing is the normal case — most
 * people register one subscription while several harnesses show up in their sessions — and it is
 * the fact the headline has to state, because the cards beside it count all of them.
 */
export function planScopeHarnesses(basis: AggregatePlanBasis): {
  covered: HarnessId[]
  inScope: number
} {
  const entries = Object.entries(basis.perHarness) as [HarnessId, { coverage: { computable: boolean } }][]
  return {
    covered: entries.filter(([, r]) => r.coverage.computable).map(([harness]) => harness),
    inScope: entries.length,
  }
}

/**
 * The short scope note, or `null` when the figure covers everything in scope and saying so would
 * be noise.
 *
 * Takes already-labelled names: the label table is a web concern and this module is pure wiring.
 */
export function planScopeNote(args: {
  covered: readonly string[]
  inScope: number
  lang: 'pt' | 'en'
}): string | null {
  const { covered, inScope, lang } = args
  const pt = lang === 'pt'
  if (covered.length === 0 || covered.length >= inScope) return null
  if (covered.length === 1) return pt ? `só ${covered[0]}` : `${covered[0]} only`
  return pt
    ? `${covered.length} de ${inScope} harnesses`
    : `${covered.length} of ${inScope} harnesses`
}

/**
 * The sentence under a plan-cost headline.
 *
 * It always names the WINDOW that was measured. That is the whole job: a user who filtered
 * "all time" and got a figure covering the last 90 days — because that is as far back as the
 * daily series reaches — has a correct number under a misleading heading, and only the window
 * corrects it. Partial coverage is stated in the same breath, in days, because "82%" of an
 * unstated period tells nobody anything.
 */
export function planCostSubtitle(args: {
  multiple: number | null
  /** Days the plan actually covered. Named because it is what makes the figure non-round. */
  coveredDays: number
  /** `planScopeNote`'s output. Appended when the figure covers less than what is on screen. */
  scope?: string | null
  lang: 'pt' | 'en'
}): string {
  const { multiple, coveredDays, scope, lang } = args
  const pt = lang === 'pt'

  // ONE SHORT LINE, and no longer than its neighbours'. This sits in a KPI card whose siblings
  // read "tokens enviados ao modelo"; an earlier version stacked the multiple, the day count, the
  // proration, the window AND the uncovered days into it, wrapped to four lines, and made that
  // one card twice the height of the row. The card is a headline — the caveats belong to the
  // "API vs your plan" panel below it, which is always on screen whenever this figure is, and to
  // the info popover.
  const mult = formatMultiple(multiple, lang)
  const value = mult
    ? (pt ? `${mult} o valor de API` : `${mult} the API value`)
    : (pt ? 'custo do seu plano' : 'your plan cost')
  // The scope replaces "rateados"/"prorated" rather than joining it: the line has to stay one
  // short line, and "which harnesses" outranks a word that only restates the day count beside it.
  const days = coveredDays > 0
    ? (scope ? `${coveredDays}d` : (pt ? `${coveredDays}d rateados` : `${coveredDays}d prorated`))
    : null
  return [value, days, scope].filter(Boolean).join(' · ')
}

/** A multiple, for display. `null` stays `null` — an absent multiple is not "1×". */
export function formatMultiple(multiple: number | null, lang: 'pt' | 'en'): string | null {
  if (multiple === null || !Number.isFinite(multiple)) return null
  const decimals = multiple >= 100 ? 0 : multiple >= 10 ? 1 : 2
  const value = multiple.toFixed(decimals)
  return lang === 'pt' ? `${value.replace('.', ',')}×` : `${value}×`
}

/**
 * `C/A` for ONE session — the factor a per-session plan figure is allocated by.
 *
 * PER HARNESS, never the aggregate. A session is one harness's spend, and rescaling it by a factor
 * that also covers a subscription paying for something else allocates it against a plan it has
 * nothing to do with — the same rule `AgentMetricsPanel` follows for a Claude-only metric.
 *
 * `null` whenever no plan covers that harness, which is what makes the basis toggle ABSENT rather
 * than present and answering "no registered plan".
 */
export function sessionPlanFactor(
  basis: AggregatePlanBasis | null,
  harness: string,
): number | null {
  if (!basis) return null
  const factor = planAllocation(basis).byHarness[harness as HarnessId]
  return typeof factor === 'number' && Number.isFinite(factor) ? factor : null
}
