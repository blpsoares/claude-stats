import { describe, expect, it, test } from 'bun:test'
import { costBasisLabel, costBasisMarker, formatMultiple, sessionPlanFactor, planCostSubtitle, planScopeHarnesses, planScopeNote, viewCost } from './costBasis'

describe('viewCost', () => {
  test('api basis is an identity', () => {
    const v = viewCost(123.45, { basis: 'api', factor: 0.2 })
    expect(v).toEqual({ usd: 123.45, basis: 'api', allocated: false, unavailable: false })
  })

  test('plan basis scales by the factor', () => {
    const v = viewCost(1000, { basis: 'plan', factor: 0.1 })
    expect(v.usd).toBeCloseTo(100, 9)
    expect(v.basis).toBe('plan')
    expect(v.unavailable).toBe(false)
  })

  test('a null factor NEVER produces a plan number', () => {
    // The surface asked for the plan basis and cannot have it. It gets the API figure plus the
    // flag; a silent 0 here would be a confident lie on the most-read number in the app.
    const v = viewCost(1000, { basis: 'plan', factor: null })
    expect(v.usd).toBe(1000)
    expect(v.basis).toBe('api')
    expect(v.unavailable).toBe(true)
  })

  test('a non-finite factor is treated as no factor', () => {
    for (const factor of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const v = viewCost(1000, { basis: 'plan', factor })
      expect(v.unavailable).toBe(true)
      expect(Number.isFinite(v.usd)).toBe(true)
    }
  })

  test('allocated travels with the value and is never inferred', () => {
    expect(viewCost(10, { basis: 'plan', factor: 2, allocated: true }).allocated).toBe(true)
    expect(viewCost(10, { basis: 'plan', factor: 2 }).allocated).toBe(false)
    // An unavailable plan figure is not an allocation of anything.
    expect(viewCost(10, { basis: 'plan', factor: null, allocated: true }).allocated).toBe(false)
  })

  test('a zero cost stays zero in either basis', () => {
    expect(viewCost(0, { basis: 'plan', factor: 0.5 }).usd).toBe(0)
  })
})

describe('costBasisMarker', () => {
  test('says nothing when nothing needs saying', () => {
    // Marking an API figure on an API-basis page trains people to ignore the marker that matters.
    expect(costBasisMarker(viewCost(10, { basis: 'api', factor: null }), 'en')).toBeNull()
    expect(costBasisMarker(viewCost(10, { basis: 'plan', factor: 2 }), 'en')).toBeNull()
  })

  test('names an allocation', () => {
    const v = viewCost(10, { basis: 'plan', factor: 2, allocated: true })
    expect(costBasisMarker(v, 'en')).toBe('allocated')
    expect(costBasisMarker(v, 'pt')).toBe('rateado')
  })

  test('names the missing plan', () => {
    const v = viewCost(10, { basis: 'plan', factor: null })
    expect(costBasisMarker(v, 'en')).toBe('no registered plan')
    expect(costBasisMarker(v, 'pt')).toBe('sem plano cadastrado')
  })
})

describe('planCostSubtitle', () => {
  const base = { multiple: 24.5, coveredDays: 126, lang: 'pt' as const }

  test('stays ONE short line — a KPI card is not a report', () => {
    // An earlier version stacked the multiple, the day count, the proration, the window AND the
    // uncovered days into this slot. It wrapped to four lines and made that card twice the height
    // of every sibling in the row, because a grid row shares its height.
    for (const lang of ['pt', 'en'] as const) {
      const out = planCostSubtitle({ ...base, lang })
      expect(out).not.toContain('\n')
      // A guard against regressing to a paragraph, not a pixel measurement — the card ellipsizes
      // at its own width anyway. The version this replaced ran to 110 characters.
      expect(out.length).toBeLessThan(40)
      // The scope costs a few characters and is worth them; it must not cost a second line.
      const scoped = planCostSubtitle({ ...base, lang, scope: 'só Claude Code' })
      expect(scoped).not.toContain('\n')
      expect(scoped.length).toBeLessThan(50)
    }
  })

  test('leads with the multiple and names the prorated days', () => {
    expect(planCostSubtitle(base)).toBe('24,5× o valor de API · 126d rateados')
    expect(planCostSubtitle({ ...base, lang: 'en' })).toBe('24.5× the API value · 126d prorated')
  })

  test('an absent multiple still names the figure rather than printing a dash', () => {
    const out = planCostSubtitle({ ...base, multiple: null })
    expect(out).not.toContain('×')
    expect(out).toContain('126d')
  })

  test('no covered days leaves only the headline phrase', () => {
    expect(planCostSubtitle({ ...base, coveredDays: 0 })).toBe('24,5× o valor de API')
  })

  test('a scope note replaces "rateados" rather than joining it', () => {
    // Both would overflow the one line this slot gets, and "which harnesses" outranks a word that
    // only restates the day count sitting next to it.
    const out = planCostSubtitle({ ...base, scope: 'só Claude Code' })
    expect(out).toBe('24,5× o valor de API · 126d · só Claude Code')
    expect(out).not.toContain('rateados')
  })

  test('the scope is dropped from the line when there is none to state', () => {
    expect(planCostSubtitle({ ...base, scope: null })).toBe('24,5× o valor de API · 126d rateados')
  })
})

describe('planScopeHarnesses + planScopeNote — the headline says what it covers', () => {
  /** Only the field the helpers read; the rest of PlanBasisResult is irrelevant here. */
  const part = (computable: boolean) => ({ coverage: { computable } })
  const agg = (perHarness: Record<string, { coverage: { computable: boolean } }>) =>
    ({ perHarness } as unknown as Parameters<typeof planScopeHarnesses>[0])

  test('covers everything in scope → nothing to say', () => {
    const scope = planScopeHarnesses(agg({ claude: part(true) }))
    expect(scope).toEqual({ covered: ['claude'], inScope: 1 })
    expect(planScopeNote({ covered: ['Claude Code'], inScope: 1, lang: 'pt' })).toBeNull()
  })

  test('one covered harness out of several is named, not counted', () => {
    // The common case by far: one subscription registered, six harnesses on screen. "só Claude
    // Code" is the whole explanation for why the headline is smaller than the cards beside it.
    const scope = planScopeHarnesses(agg({
      claude: part(true), codex: part(false), gemini: part(false),
    }))
    expect(scope).toEqual({ covered: ['claude'], inScope: 3 })
    expect(planScopeNote({ covered: ['Claude Code'], inScope: 3, lang: 'pt' })).toBe('só Claude Code')
    expect(planScopeNote({ covered: ['Claude Code'], inScope: 3, lang: 'en' })).toBe('Claude Code only')
  })

  test('several covered harnesses are counted rather than listed', () => {
    // Listing four labels is what made this line a paragraph the last time.
    expect(planScopeNote({ covered: ['a', 'b'], inScope: 5, lang: 'pt' })).toBe('2 de 5 harnesses')
    expect(planScopeNote({ covered: ['a', 'b'], inScope: 5, lang: 'en' })).toBe('2 of 5 harnesses')
  })

  test('nothing covered says nothing — that case renders N/A, not a scope note', () => {
    expect(planScopeNote({ covered: [], inScope: 3, lang: 'pt' })).toBeNull()
  })
})

describe('formatMultiple', () => {
  test('null stays null — an absent multiple is not 1x', () => {
    expect(formatMultiple(null, 'en')).toBeNull()
    expect(formatMultiple(Number.POSITIVE_INFINITY, 'en')).toBeNull()
    expect(formatMultiple(Number.NaN, 'en')).toBeNull()
  })

  test('precision drops as the number grows', () => {
    expect(formatMultiple(8.523, 'en')).toBe('8.52×')
    expect(formatMultiple(12.34, 'en')).toBe('12.3×')
    expect(formatMultiple(140.6, 'en')).toBe('141×')
  })

  test('pt uses a comma', () => {
    expect(formatMultiple(8.5, 'pt')).toBe('8,50×')
    expect(formatMultiple(8.5, 'en')).toBe('8.50×')
  })
})

describe('costBasisLabel — the row says WHICH basis it is showing', () => {
  it('names the API estimate as an estimate', () => {
    expect(costBasisLabel(viewCost(10, { basis: 'api', factor: null }), true)).toBe('Estimado (API)')
    expect(costBasisLabel(viewCost(10, { basis: 'api', factor: null }), false)).toBe('Estimated (API)')
  })

  it('names a plan figure an ALLOCATION, because no session was billed on its own', () => {
    const v = viewCost(10, { basis: 'plan', factor: 0.5, allocated: true })
    expect(v.usd).toBe(5)
    expect(costBasisLabel(v, true)).toBe('Rateado (plano)')
    expect(costBasisLabel(v, false)).toBe('Allocated (plan)')
  })

  it('a plan figure that could not be produced says so, and never wears the plan label', () => {
    // `viewCost` hands back the API number flagged. The label must follow the basis ACTUALLY used,
    // or a real API figure is shown under a heading claiming it is the user's plan cost.
    const v = viewCost(10, { basis: 'plan', factor: null })
    expect(v.unavailable).toBe(true)
    expect(costBasisLabel(v, false)).toBe('Estimated (API)')
  })
})

describe('sessionPlanFactor — a session allocates against ITS OWN harness', () => {
  const basis = {
    planCostUSD: 50, apiCostUSD: 200, multiple: 4, effectiveCostPerMTokens: null,
    coverage: { computable: true } as never,
    perHarness: {
      claude: { planCostUSD: 50, apiCostUSD: 200, coverage: { computable: true } },
      codex: { planCostUSD: 0, apiCostUSD: 0, coverage: { computable: false } },
    },
    uncoveredHarnesses: ['codex'],
  } as never as import('@agentistics/core').AggregatePlanBasis

  it('is the covered harness own C/A, not the aggregate', () => {
    expect(sessionPlanFactor(basis, 'claude')).toBeCloseTo(0.25, 6)
  })

  it('is null for a harness no plan covers — which is what removes the toggle', () => {
    expect(sessionPlanFactor(basis, 'codex')).toBe(null)
    expect(sessionPlanFactor(basis, 'gemini')).toBe(null)
  })

  it('is null with no basis at all — a central, or nobody has registered a plan', () => {
    expect(sessionPlanFactor(null, 'claude')).toBe(null)
  })
})

