import React, { useMemo, useState } from 'react'
import type { ModelUsage } from '@agentistics/core'
import { fmt, formatModel, calcCost, getModelColor, fmtCost, usageTokenTotal } from '@agentistics/core'
import { useIsMobile } from '../hooks/useIsMobile'
import { resolveProvider, providerOrder } from '@agentistics/core'
import { MetricNote } from './MetricNote'

type SortKey = 'cost' | 'tokens' | 'model'

interface Props {
  modelUsage: Record<string, ModelUsage>
  note?: string
  currency?: 'USD' | 'BRL'
  brlRate?: number
  fallbackInputTokens?: number
  fallbackOutputTokens?: number
  fallbackCostUSD?: number
  /**
   * C/A for this scope, when the page is showing the plan basis.
   *
   * Every cost in the table is multiplied by it. WITHIN ONE HARNESS that is a linear rescale, so
   * the ordering, the proportions and the percentages are all preserved exactly — what changes is
   * the magnitude and the meaning. It is an ALLOCATION, not a measurement: nobody was billed
   * per model on a flat monthly plan, and the header says so rather than leaving the reader to
   * assume these figures were observed.
   *
   * `undefined` (or 1) leaves the table in API basis.
   */
  planFactor?: number | null
  lang?: 'en' | 'pt'
}



const COL: React.CSSProperties = { fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }
const GRID = 'minmax(120px,1fr) 56px 64px 64px 64px 88px'
const GRID_MOBILE = 'minmax(100px,1fr) 56px 70px 88px'

export function ModelBreakdown({ modelUsage, note, currency = 'USD', brlRate = 1, fallbackInputTokens, fallbackOutputTokens, fallbackCostUSD, planFactor, lang = "en" }: Props) {
  const isMobile = useIsMobile()
  const pt = lang === 'pt'
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('cost')
  const [byProvider, setByProvider] = useState(false)

  // A model whose whole volume is cache is still a model that ran. Filtering on the two
  // conversational counters dropped rows that had real spend behind them.
  const allEntries = Object.entries(modelUsage).filter(([, u]) => u && usageTokenTotal(u) > 0)

  /** Search matches the model id or the company that bills it, so "opus" and "anthropic" both work.
   *  Sorting is by spend by default — the question this table is opened with. */
  const entries = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? allEntries.filter(([id]) => id.toLowerCase().includes(q) || resolveProvider(id).label.toLowerCase().includes(q))
      : allEntries
    const tokensOf = (u: ModelUsage) => u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens
    return [...filtered].sort(([aId, a], [bId, b]) =>
      sortKey === 'model' ? aId.localeCompare(bId)
      : sortKey === 'tokens' ? tokensOf(b) - tokensOf(a)
      : calcCost(b, bId) - calcCost(a, aId))
  }, [allEntries, query, sortKey])

  /** Grouping reorders rather than nesting: the table keeps one column grid, so a provider heading
   *  is just a row in the same flow. Within a provider the chosen sort still applies. */
  const ordered = useMemo(() => {
    if (!byProvider) return entries
    const rank = new Map(providerOrder().map((p, i) => [p.id, i]))
    return [...entries].sort(([a], [b]) => {
      const ra = rank.get(resolveProvider(a).id) ?? 99
      const rb = rank.get(resolveProvider(b).id) ?? 99
      return ra - rb || entries.findIndex(([m]) => m === a) - entries.findIndex(([m]) => m === b)
    })
  }, [entries, byProvider])

  if (entries.length === 0) {
    const hasFallback = fallbackCostUSD !== undefined && (fallbackInputTokens ?? 0) + (fallbackOutputTokens ?? 0) > 0
    if (!hasFallback) {
      return (
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic', textAlign: 'center', padding: 24 }}>
          {note ?? 'No model data available'}
        </div>
      )
    }
    return (
      <div style={{ background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8, padding: '8px 14px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-card)' }}>
          <span style={COL}>Model</span>
          <span style={{ ...COL, textAlign: 'right' }}>Input</span>
          <span style={{ ...COL, textAlign: 'right' }}>Output</span>
          <span style={{ ...COL, textAlign: 'right' }}>C.Read</span>
          <span style={{ ...COL, textAlign: 'right' }}>C.Write</span>
          <span style={{ ...COL, textAlign: 'right' }}>Cost</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8, padding: '10px 14px', alignItems: 'center' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--text-tertiary)', flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', lineHeight: 1 }}>
                All models (blended)
              </span>
            </div>
            <div style={{ height: 2, background: 'var(--bg-card)', borderRadius: 1 }}>
              <div style={{ height: '100%', width: '100%', background: 'linear-gradient(90deg, var(--text-tertiary), var(--text-tertiary)40)', borderRadius: 1 }} />
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-blue)' }}>{fmt(fallbackInputTokens ?? 0)}</span>
          </div>
          <div style={{ textAlign: 'right' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent-green)' }}>{fmt(fallbackOutputTokens ?? 0)}</span>
          </div>
          <div style={{ textAlign: 'right' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>—</span>
          </div>
          <div style={{ textAlign: 'right' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>—</span>
          </div>
          <div style={{ textAlign: 'right' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--anthropic-orange)', background: 'var(--anthropic-orange-dim)', padding: '2px 7px', borderRadius: 5, whiteSpace: 'nowrap' }}>
              {fmtCost(fallbackCostUSD!, currency, brlRate)}
            </span>
          </div>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic', textAlign: 'center', padding: '8px 14px', borderTop: '1px solid var(--border-subtle)' }}>
          {note ?? '* Cost and tokens estimated via blended rate — sessions do not record the model used individually.'}
        </div>
      </div>
    )
  }

  // A linear rescale of every cost in the table. Ordering and proportions are untouched by
  // construction; only the magnitude and the meaning change, and `allocNote` below says which.
  const alloc = planFactor !== null && planFactor !== undefined && Number.isFinite(planFactor) ? planFactor : 1
  const showAlloc = alloc !== 1
  const totalCost = entries.reduce((s, [id, u]) => s + calcCost(u, id), 0) * alloc
  const totalTokens = entries.reduce((s, [, u]) => s + u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens, 0)
  const totalInput = entries.reduce((s, [, u]) => s + u.inputTokens, 0)
  const totalOutput = entries.reduce((s, [, u]) => s + u.outputTokens, 0)
  const totalCacheRead = entries.reduce((s, [, u]) => s + u.cacheReadInputTokens, 0)
  const totalCacheWrite = entries.reduce((s, [, u]) => s + u.cacheCreationInputTokens, 0)

  // 44px is the finger's, not the paint's — every consumer of this style carries `.ag-tap`,
  // which projects the target invisibly. At `borderRadius: 999` a 44px-tall pill is an ellipse.
  const chip = (active: boolean): React.CSSProperties => ({
    padding: isMobile ? '5px 12px' : '4px 10px',
    borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5,
    border: `1px solid ${active ? 'var(--anthropic-orange)' : 'var(--border)'}`,
    background: active ? 'var(--anthropic-orange-dim)' : 'var(--bg-card)',
    color: active ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
    fontWeight: active ? 600 : 400,
  })

  return (
    <>
    {/* Controls sit OUTSIDE the table frame so the header row stays the table's own, and the
        toolbar does not inherit the grid that the columns depend on. */}
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <input
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={pt ? 'Buscar modelo ou provedor…' : 'Search model or provider…'}
        style={{
          flex: '1 1 180px', minWidth: 0, boxSizing: 'border-box',
          padding: isMobile ? '11px 10px' : '5px 10px',
          minHeight: isMobile ? 44 : undefined,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8,
          fontSize: isMobile ? 16 : 12, color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit',
        }}
      />
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {([['cost', pt ? 'Custo' : 'Cost'], ['tokens', 'Tokens'], ['model', pt ? 'Nome' : 'Name']] as Array<[SortKey, string]>)
          .map(([k, label]) => (
            <button key={k} onClick={() => setSortKey(k)} className="ag-tap" style={chip(sortKey === k)}>{label}</button>
          ))}
        <button onClick={() => setByProvider(v => !v)} className="ag-tap" style={chip(byProvider)}>
          {pt ? 'Por provedor' : 'By provider'}
        </button>
      </div>
    </div>

    {entries.length === 0 ? (
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '10px 2px' }}>
        {pt ? `Nenhum modelo corresponde a "${query.trim()}".` : `No model matches "${query.trim()}".`}
      </div>
    ) : (
    <div style={{
      background: 'var(--bg-elevated)',
      borderRadius: 'var(--radius-md)',
      border: '1px solid var(--border-subtle)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'grid', gridTemplateColumns: isMobile ? GRID_MOBILE : GRID, gap: 8,
        padding: '8px 14px',
        borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--bg-card)',
      }}>
        <span style={COL}>Model</span>
        <span style={{ ...COL, textAlign: 'right' }}>Input</span>
        <span style={{ ...COL, textAlign: 'right' }}>Output</span>
        {!isMobile && <span style={{ ...COL, textAlign: 'right' }}>C.Read</span>}
        {!isMobile && <span style={{ ...COL, textAlign: 'right' }}>C.Write</span>}
        <span style={{ ...COL, textAlign: 'right' }}>Cost</span>
      </div>

      {/* Rows */}
      {ordered.map(([modelId, usage], i) => {
        const provider = resolveProvider(modelId)
        const newGroup = byProvider && (i === 0 || resolveProvider(ordered[i - 1]![0]).id !== provider.id)
        const costUSD = calcCost(usage, modelId) * alloc
        const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens
        const pct = totalTokens > 0 ? tokens / totalTokens : 0
        const color = getModelColor(modelId)
        const isLast = i === ordered.length - 1

        return (
          <React.Fragment key={modelId}>
          {newGroup && (
            <div style={{
              padding: '7px 14px', background: 'var(--bg-card)',
              borderTop: i === 0 ? 'none' : '1px solid var(--border-subtle)',
              borderBottom: '1px solid var(--border-subtle)',
              fontSize: 11, fontWeight: 700, letterSpacing: 0.3,
              color: 'var(--text-secondary)', textTransform: 'uppercase',
            }}>{provider.label}</div>
          )}
          <div style={{
            display: 'grid', gridTemplateColumns: isMobile ? GRID_MOBILE : GRID, gap: 8,
            padding: '10px 14px',
            alignItems: 'center',
            borderBottom: isLast ? 'none' : '1px solid var(--border-subtle)',
          }}>
            {/* Model name + bar */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <div style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1 }}>
                  {formatModel(modelId)}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-tertiary)', marginLeft: 'auto', flexShrink: 0 }}>
                  {(pct * 100).toFixed(0)}%
                </span>
              </div>
              <div style={{ height: 2, background: 'var(--bg-card)', borderRadius: 1, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', width: `${pct * 100}%`,
                  background: `linear-gradient(90deg, ${color}, ${color}80)`,
                  borderRadius: 1, transition: 'width 0.6s ease',
                }} />
              </div>
            </div>

            {/* Token stats — compact, right-aligned */}
            {[
              { v: usage.inputTokens,              c: 'var(--accent-blue)',   show: true  },
              { v: usage.outputTokens,             c: 'var(--accent-green)',  show: true  },
              { v: usage.cacheReadInputTokens,     c: 'var(--accent-cyan)',   show: !isMobile },
              { v: usage.cacheCreationInputTokens, c: 'var(--accent-purple)', show: !isMobile },
            ].filter(x => x.show).map(({ v, c }, idx) => (
              <div key={idx} style={{ textAlign: 'right' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: c }}>{fmt(v)}</span>
              </div>
            ))}

            {/* Cost */}
            <div style={{ textAlign: 'right' }}>
              <span style={{
                fontSize: 12, fontWeight: 700,
                color: 'var(--anthropic-orange)',
                background: 'var(--anthropic-orange-dim)',
                padding: '2px 7px', borderRadius: 5,
                whiteSpace: 'nowrap',
              }}>
                {fmtCost(costUSD, currency, brlRate)}
              </span>
            </div>
          </div>
          </React.Fragment>
        )
      })}

      {/* Total row */}
      {entries.length > 1 && (
        <div style={{
          display: 'grid', gridTemplateColumns: isMobile ? GRID_MOBILE : GRID, gap: 8,
          padding: '9px 14px',
          borderTop: '1px solid var(--border-subtle)',
          background: 'var(--anthropic-orange-glow)',
          alignItems: 'center',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {showAlloc ? (pt ? 'Total do plano' : 'Plan total') : 'Estimated Total'}
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-tertiary)', marginLeft: 'auto', flexShrink: 0 }}>100%</span>
          </div>
          {[
            { v: totalInput,      c: 'var(--accent-blue)',   show: true       },
            { v: totalOutput,     c: 'var(--accent-green)',  show: true       },
            { v: totalCacheRead,  c: 'var(--accent-cyan)',   show: !isMobile  },
            { v: totalCacheWrite, c: 'var(--accent-purple)', show: !isMobile  },
          ].filter(x => x.show).map(({ v, c }, idx) => (
            <div key={idx} style={{ textAlign: 'right' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: c }}>{fmt(v)}</span>
            </div>
          ))}
          <div style={{ textAlign: 'right' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--anthropic-orange)' }}>
              {fmtCost(totalCost, currency, brlRate)}
            </span>
          </div>
        </div>
      )}

      {/* Said once, at the bottom, where the numbers end: these are shares of a monthly fee, not
          per-model charges. Nobody was billed per model on a flat plan, and the ratios between the
          rows are the only part of this table that was actually measured. */}
      {showAlloc && (
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center', padding: '8px 14px', borderTop: '1px solid var(--border-subtle)', lineHeight: 1.5 }}>
          {pt
            ? 'Rateado: o custo do seu plano dividido entre os modelos na proporção do uso de cada um. Nenhum modelo é cobrado separadamente numa assinatura.'
            : 'Allocated: your plan cost split across models in proportion to each one’s usage. No model is billed separately on a subscription.'}
        </div>
      )}

      {note && (
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic', textAlign: 'center', padding: '8px 14px' }}>
          {note}
        </div>
      )}

      {/* The token column here is the model's whole billed volume, and the money beside it is
          priced from the same four counters — which is exactly why a cheap-looking model can carry
          a large number. */}
      <MetricNote style={{ padding: '0 14px 10px' }}>
        {lang === 'pt'
          ? 'A coluna de tokens soma os quatro contadores cobrados deste modelo — entrada nova, saída, leitura e escrita de cache — e o custo ao lado é calculado sobre os mesmos quatro, cada um ao seu preço. Um modelo pode aparecer com volume enorme e custo baixo: leitura de cache vale cerca de 1/10 da entrada nova.'
          : "The tokens column adds this model's four billed counters — fresh input, output, cache read and cache write — and the cost beside it is priced from those same four, each at its own rate. A model can show a huge volume and a small cost: cache reads are worth roughly 1/10 of fresh input."}
      </MetricNote>
    </div>
    )}
    </>
  )
}
