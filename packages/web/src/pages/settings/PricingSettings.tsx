import { useEffect, useMemo, useState } from 'react'
import { NavLink, useOutletContext } from 'react-router-dom'
import type React from 'react'
import { ExternalLink, AlertTriangle, ArrowUp, ArrowDown } from 'lucide-react'
import { resolveProvider, providerOrder, type ProviderId } from '@agentistics/core'
import type { AppContext } from '../../lib/app-context'
import { HARNESS_COLORS, HARNESS_LABELS } from '../../lib/harness'
import { useIsMobile } from '../../hooks/useIsMobile'
import type { HarnessId } from '@agentistics/core'
import { createSharedPref } from '../../lib/sharedPref'

type Origin = 'official' | 'community' | 'builtin'
/** How the table is carved up. Persisted, because it is a viewing habit rather than a one-off. */
type GroupBy = 'provider' | 'source' | 'harness' | 'none'
// SHARED: a grouping choice is about how this person reads their own prices, not about the device.
const groupStore = createSharedPref<GroupBy>({
  key: 'agentistics-pricing-groupby',
  prefKey: 'pricingGroupBy',
  fallback: 'provider',
  parse: raw => (raw === 'provider' || raw === 'source' || raw === 'harness' || raw === 'none' ? raw : null),
})
/** Sort applies WITHIN each group; the groups keep their own order (providers by their canonical
 *  order, sources by trust). Sorting across groups would fight the grouping. */
type SortKey = 'model' | 'input' | 'output' | 'cache' | 'provider'
type SortDir = 'asc' | 'desc'

interface PricedRow {
  id: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  origin: Origin
}

interface PricingResponse {
  models: PricedRow[]
  fetchedAt: number
  communityOk: boolean
  sources: Record<'official' | 'community', { label: string; url: string }>
}

const ORIGIN: Record<Origin, { color: string; en: string; pt: string; whyEn: string; whyPt: string }> = {
  official: {
    color: '#22c55e', en: 'Official', pt: 'Oficial',
    whyEn: "Read from the vendor's own pricing page.",
    whyPt: 'Lido da página de preços do próprio fabricante.',
  },
  community: {
    color: '#3b82f6', en: 'Community', pt: 'Comunidade',
    whyEn: 'From the LiteLLM dataset, validated before use.',
    whyPt: 'Do dataset LiteLLM, validado antes de usar.',
  },
  builtin: {
    color: '#a1a1aa', en: 'Built-in', pt: 'Local',
    whyEn: 'The table compiled into agentistics — no live source listed this model.',
    whyPt: 'A tabela compilada no agentistics — nenhuma fonte ao vivo listou este modelo.',
  },
}

/**
 * A per-1M-token rate in the chosen currency.
 *
 * NOT fmtCost: that floors at "<USD 0.01" because it formats spend, and half these rates are below
 * that (cache reads run to $0.025). A rate rendered as "<USD 0,01" would hide the difference
 * between a cheap model and a very cheap one, which is the comparison this table exists for.
 */
const fmtRate = (usd: number, currency: 'USD' | 'BRL', rate: number): string => {
  const v = currency === 'BRL' ? usd * rate : usd
  const decimals = v >= 1 ? 2 : v >= 0.01 ? 3 : 4
  const [int, dec] = v.toFixed(decimals).split('.')
  return currency === 'BRL'
    ? `R$${(int ?? '0').replace(/\B(?=(\d{3})+$)/g, '.')},${dec}`
    : `$${(int ?? '0').replace(/\B(?=(\d{3})+$)/g, ',')}.${dec}`
}

/** A header cell that sorts. The arrow only appears on the active column, so the header row stays
 *  quiet instead of showing four competing indicators. */
function SortableTh({ sortKey, sort, onSort, align, children }: {
  sortKey: SortKey
  sort: { key: SortKey; dir: SortDir }
  onSort: (k: SortKey) => void
  align?: 'right'
  children: React.ReactNode
}) {
  const active = sort.key === sortKey
  return (
    <th style={{ padding: 0, fontWeight: 600, textAlign: align ?? 'left' }}>
      <button
        onClick={() => onSort(sortKey)}
        style={{
          width: '100%', padding: '8px 10px', border: 'none', background: 'transparent',
          font: 'inherit', fontWeight: 600, cursor: 'pointer',
          color: active ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
          display: 'flex', alignItems: 'center', gap: 4,
          justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
        }}>
        {children}
        {active && (sort.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
      </button>
    </th>
  )
}

const ago = (ms: number, pt: boolean): string => {
  if (!ms) return pt ? 'nunca' : 'never'
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000))
  if (mins < 1) return pt ? 'agora' : 'just now'
  if (mins < 60) return pt ? `há ${mins} min` : `${mins} min ago`
  return pt ? `há ${Math.round(mins / 60)}h` : `${Math.round(mins / 60)}h ago`
}

export default function PricingSettings() {
  const { data, lang, currency, brlRate } = useOutletContext<AppContext>()
  const pt = lang === 'pt'
  const money = (usd: number) => fmtRate(usd, currency, brlRate)
  const isMobile = useIsMobile()
  const [resp, setResp] = useState<PricingResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [groupBy, setGroupBy] = useState<GroupBy>(() => {
    return groupStore.get()
  })
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'model', dir: 'asc' })
  const toggleSort = (key: SortKey) => setSort(prev =>
    prev.key === key
      // Second click reverses; a price column starts high-to-low because "what costs most" is the
      // question people bring to it, while a name starts A-Z.
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'model' || key === 'provider' ? 'asc' : 'desc' })

  const setGroup = (g: GroupBy) => {
    setGroupBy(g)
    groupStore.set(g)
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await fetch('/api/pricing')
        if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) throw new Error(`HTTP ${r.status}`)
        const json = await r.json() as PricingResponse
        if (alive) setResp(json)
      } catch (e) { if (alive) setErr(String(e)) }
    })()
    return () => { alive = false }
  }, [])

  /** Models this machine has actually run, and which harnesses ran them. The table shows ONLY
   *  these: a price list of a thousand models nobody here uses is a catalogue, not a statement
   *  about your costs. A model appears the first time it is used, with no code change — the id
   *  comes from the sessions, and the rate from whichever source lists it. */
  const usedBy = useMemo(() => {
    const map = new Map<string, Set<HarnessId>>()
    const add = (model: string, h: HarnessId) => {
      if (!model) return
      const set = map.get(model) ?? new Set<HarnessId>()
      set.add(h)
      map.set(model, set)
    }
    for (const s of data.sessions) {
      if (s.model_usage) for (const m of Object.keys(s.model_usage)) add(m, s.harness)
      else if (s.model) add(s.model, s.harness)
    }
    return map
  }, [data.sessions])

  const byId = useMemo(() => new Map((resp?.models ?? []).map(m => [m.id, m])), [resp])

  /** Resolve a used model to its row the same way the cost maths does: exact, then the longest row
   *  that prefixes it (so `gemini-3.6-flash-tiered` is priced by `gemini-3.6-flash`). */
  const rowFor = useMemo(() => {
    const ids = [...byId.keys()]
    return (model: string): PricedRow | null => {
      const exact = byId.get(model)
      if (exact) return exact
      const prefix = ids.filter(k => model.startsWith(k)).sort((a, b) => b.length - a.length)[0]
      return prefix ? byId.get(prefix)! : null
    }
  }, [byId])

  /** One entry per model actually used, with everything a row or a heading might need. */
  const entries = useMemo(() => {
    const q = query.trim().toLowerCase()
    let list = [...usedBy].map(([model, hs]) => ({
      model,
      row: rowFor(model),
      harnesses: [...hs].sort(),
      provider: resolveProvider(model),
    }))
    // Search spans the model id, its provider and the harnesses that ran it, so "google", "codex"
    // and "opus" all find something without the user having to know which field they are in.
    if (q) {
      list = list.filter(e =>
        e.model.toLowerCase().includes(q)
        || e.provider.label.toLowerCase().includes(q)
        || e.harnesses.some(h => (HARNESS_LABELS[h] ?? h).toLowerCase().includes(q)))
    }
    const num = (e: typeof list[number], k: SortKey): number =>
      !e.row ? -1 : k === 'input' ? e.row.input : k === 'output' ? e.row.output : e.row.cacheRead
    list.sort((a, b) => {
      const dir = sort.dir === 'asc' ? 1 : -1
      if (sort.key === 'model') return a.model.localeCompare(b.model) * dir
      if (sort.key === 'provider') {
        return (a.provider.label.localeCompare(b.provider.label) || a.model.localeCompare(b.model)) * dir
      }
      // An unpriced row has no number to compare; keep those together at the end either way.
      return ((num(a, sort.key) - num(b, sort.key)) * dir) || a.model.localeCompare(b.model)
    })
    return list
  }, [usedBy, rowFor, query, sort])

  /**
   * Group into [heading, rows] pairs. Grouping by harness is the one dimension that is NOT a
   * partition: two harnesses running the same model put it in both groups on purpose, because the
   * question being asked is "what does Codex cost me", not "how many distinct models exist".
   */
  const grouped = useMemo((): Array<{ key: string; label: string; rows: typeof entries }> => {
    if (groupBy === 'none') {
      return [{ key: 'all', label: '', rows: entries }]
    }
    if (groupBy === 'provider') {
      return providerOrder()
        .map(p => ({ key: p.id, label: p.label, rows: entries.filter(e => e.provider.id === p.id) }))
        .filter(g => g.rows.length > 0)
    }
    if (groupBy === 'source') {
      const order: Array<Origin | 'fallback'> = ['official', 'community', 'builtin', 'fallback']
      return order
        .map(o => ({
          key: o,
          label: o === 'fallback'
            ? (pt ? 'Sem tarifa própria' : 'No rate of their own')
            : (pt ? ORIGIN[o].pt : ORIGIN[o].en),
          rows: entries.filter(e => (e.row ? e.row.origin : 'fallback') === o),
        }))
        .filter(g => g.rows.length > 0)
    }
    // harness
    const seen = new Map<HarnessId, typeof entries>()
    for (const e of entries) {
      for (const h of e.harnesses) seen.set(h, [...(seen.get(h) ?? []), e])
    }
    return [...seen].map(([h, rows]) => ({ key: h, label: HARNESS_LABELS[h] ?? h, rows }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [entries, groupBy, pt])

  const unpriced = useMemo(
    () => [...usedBy.keys()].filter(m => !rowFor(m)).sort(),
    [usedBy, rowFor],
  )

  if (err) {
    return <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
      {pt ? 'Não foi possível carregar os preços.' : 'Could not load pricing.'} {err}
    </div>
  }
  if (!resp) {
    return <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>{pt ? 'Carregando…' : 'Loading…'}</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
          {pt ? 'Preços por modelo' : 'Model pricing'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6, marginTop: 4 }}>
          {pt
            ? 'As tarifas que calculam todo custo do dashboard. Só aparecem os modelos que você já usou — um modelo novo entra na lista sozinho, na primeira vez que for usado.'
            : 'The rates behind every cost in this dashboard. Only models you have actually used are listed — a new one joins the list by itself, the first time it is used.'}
        </div>

        {/* How the billing actually works. Without this the table is four numbers with no unit, and
            a reader has no way to turn them into the cost of anything they did. */}
        <div style={{
          marginTop: 10, padding: 10, borderRadius: 9,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.7,
        }}>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            {pt ? 'Como a cobrança funciona' : 'How billing works'}
          </div>
          {pt
            ? <>Cada tarifa abaixo vale por <strong>1.000.000 de tokens</strong>. A cobrança é proporcional:
              metade dos tokens custa metade do valor. O total de uma sessão é
              {' '}<code>entrada × tarifa de entrada + cache × tarifa de cache + saída × tarifa de saída</code>,
              somado por modelo.</>
            : <>Each rate below is per <strong>1,000,000 tokens</strong>, charged pro rata: half the
              tokens cost half the amount. A session's total is
              {' '}<code>input × input rate + cache × cache rate + output × output rate</code>,
              summed per model.</>}
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            <li>{pt ? <><strong>Entrada</strong> — tokens que você envia (prompt, arquivos, histórico).</> : <><strong>Input</strong> — tokens you send (prompt, files, history).</>}</li>
            <li>{pt ? <><strong>Cache</strong> — releitura de contexto já enviado, cobrada bem mais barato que entrada.</> : <><strong>Cache</strong> — re-reading context already sent, billed far below the input rate.</>}</li>
            <li>{pt ? <><strong>Saída</strong> — tokens que o modelo escreve; quase sempre a tarifa mais cara.</> : <><strong>Output</strong> — tokens the model writes; almost always the priciest rate.</>}</li>
          </ul>
          {currency === 'BRL' && (
            <div style={{ marginTop: 6, color: 'var(--text-tertiary)' }}>
              {pt
                ? <>Os fabricantes cobram em dólar. Convertido a <strong>USD 1 = R${brlRate.toFixed(4).replace('.', ',')}</strong>, cotação do dia.</>
                : <>Vendors bill in USD. Converted at <strong>USD 1 = R${brlRate.toFixed(4)}</strong>, today's rate.</>}
            </div>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 8 }}>
          {pt ? 'atualizado' : 'updated'} {ago(resp.fetchedAt, pt)}
          {!resp.communityOk && (
            <span style={{ color: '#f59e0b' }}>
              {' · '}{pt ? 'fonte da comunidade indisponível, usando o último resultado bom' : 'community source unavailable, using the last good result'}
            </span>
          )}
        </div>
      </div>

      {unpriced.length > 0 && (
        <div style={{ border: '1px solid #f59e0b44', background: '#f59e0b11', borderRadius: 10, padding: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600, color: '#f59e0b' }}>
            <AlertTriangle size={14} /> {pt ? 'Sem tarifa própria' : 'No rate of their own'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginTop: 6 }}>
            {pt
              ? 'Nenhuma fonte lista estes modelos, então eles usam a tarifa padrão: o custo deles é aproximação, não cálculo.'
              : 'No source lists these models, so they fall back to the default rate: their cost is an approximation, not a calculation.'}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {unpriced.map(m => <code key={m} style={{ fontSize: 11.5 }}>{m}</code>)}
          </div>
        </div>
      )}

      {/* Grouping selector. The same rows, carved differently — provider answers "who bills me",
          source answers "how much of this is the vendor's own word", harness answers "what does
          this tool cost me". */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={pt ? 'Buscar modelo, provedor ou harness…' : 'Search model, provider or harness…'}
          style={{
            flex: '1 1 220px', minWidth: 0, boxSizing: 'border-box',
            padding: isMobile ? '11px 10px' : '6px 10px',
            minHeight: isMobile ? 44 : undefined,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8,
            // 16px on mobile or iOS Safari zooms the viewport and breaks the sticky header.
            fontSize: isMobile ? 16 : 12.5,
            color: 'var(--text-primary)', outline: 'none', fontFamily: 'inherit',
          }}
        />
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{pt ? 'Agrupar por' : 'Group by'}</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {([
            ['provider', pt ? 'Provedor' : 'Provider'],
            ['source', pt ? 'Fonte' : 'Source'],
            ['harness', 'Harness'],
            ['none', pt ? 'Sem grupo' : 'No group'],
          ] as Array<[GroupBy, string]>).map(([g, label]) => (
            <button
              key={g}
              onClick={() => setGroup(g)}
              className="ag-tap"
              style={{
                padding: isMobile ? '6px 12px' : '5px 11px',
                borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
                border: `1px solid ${groupBy === g ? 'var(--anthropic-orange)' : 'var(--border)'}`,
                background: groupBy === g ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
                color: groupBy === g ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
                fontWeight: groupBy === g ? 600 : 400,
              }}>{label}</button>
          ))}
        </div>
      </div>

      {entries.length === 0 && query.trim() && (
        <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          {pt
            ? `Nenhum modelo usado corresponde a "${query.trim()}".`
            : `No model you have used matches "${query.trim()}".`}
        </div>
      )}

      {grouped.map(group => (
        <div key={group.key}>
          {group.label && (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              {groupBy === 'source' && (
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', alignSelf: 'center',
                  background: group.key === 'fallback' ? '#f59e0b' : ORIGIN[group.key as Origin].color,
                }} />
              )}
              {groupBy === 'harness' && (
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', alignSelf: 'center',
                  background: HARNESS_COLORS[group.key as HarnessId] ?? 'var(--text-tertiary)',
                }} />
              )}
              <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)' }}>{group.label}</span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                {group.rows.length} {group.rows.length === 1 ? (pt ? 'modelo' : 'model') : (pt ? 'modelos' : 'models')}
              </span>
              {groupBy === 'provider' && (() => {
                const url = providerOrder().find(p => p.id === group.key)?.pricingUrl
                return url ? (
                  <a href={url} target="_blank" rel="noreferrer"
                    style={{ fontSize: 11, color: 'var(--text-tertiary)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    {pt ? 'tabela oficial' : 'official table'} <ExternalLink size={10} />
                  </a>
                ) : null
              })()}
            </div>
          )}

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 460 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-tertiary)', background: 'var(--bg-elevated)' }}>
                  <SortableTh sortKey="model" sort={sort} onSort={toggleSort}>{pt ? 'Modelo' : 'Model'}</SortableTh>
                  <SortableTh sortKey="input" sort={sort} onSort={toggleSort} align="right">{pt ? 'Entrada / 1M' : 'Input / 1M'}</SortableTh>
                  <SortableTh sortKey="cache" sort={sort} onSort={toggleSort} align="right">{pt ? 'Cache / 1M' : 'Cache / 1M'}</SortableTh>
                  <SortableTh sortKey="output" sort={sort} onSort={toggleSort} align="right">{pt ? 'Saída / 1M' : 'Output / 1M'}</SortableTh>
                  {/* The grouping key leaves the rows — repeating it under its own heading is noise. */}
                  {groupBy !== 'provider' && <SortableTh sortKey="provider" sort={sort} onSort={toggleSort}>{pt ? 'Provedor' : 'Provider'}</SortableTh>}
                  {groupBy !== 'source' && <th style={{ padding: '8px 10px', fontWeight: 600 }}>{pt ? 'Fonte' : 'Source'}</th>}
                </tr>
              </thead>
              <tbody>
                {group.rows.map(({ model, row, harnesses, provider }) => (
                  <tr key={model} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '8px 10px' }}>
                      <code style={{ fontSize: 12, color: 'var(--text-primary)' }}>{model}</code>
                      {/* Under a harness heading every row shares it, so the badges say nothing. */}
                      {groupBy !== 'harness' && (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                          {harnesses.map(h => (
                            <span key={h} style={{
                              fontSize: 9.5, padding: '1px 5px', borderRadius: 999, whiteSpace: 'nowrap',
                              color: HARNESS_COLORS[h], border: `1px solid ${HARNESS_COLORS[h]}66`,
                            }}>{HARNESS_LABELS[h]}</span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>{row ? money(row.input) : '—'}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap', color: 'var(--text-tertiary)' }}>{row ? money(row.cacheRead) : '—'}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>{row ? money(row.output) : '—'}</td>
                    {groupBy !== 'provider' && (
                      <td style={{ padding: '8px 10px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{provider.label}</td>
                    )}
                    {groupBy !== 'source' && (
                      <td style={{ padding: '8px 10px' }}>
                        {row
                          ? <span title={pt ? ORIGIN[row.origin].whyPt : ORIGIN[row.origin].whyEn}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: ORIGIN[row.origin].color, whiteSpace: 'nowrap' }}>
                              <span style={{ width: 7, height: 7, borderRadius: '50%', background: ORIGIN[row.origin].color }} />
                              {pt ? ORIGIN[row.origin].pt : ORIGIN[row.origin].en}
                            </span>
                          : <span style={{ color: '#f59e0b' }}>{pt ? 'padrão' : 'fallback'}</span>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.6, paddingBottom: isMobile ? 8 : 0 }}>
        {pt
          ? 'O custo é o equivalente em API. Assinaturas (Claude Max, Copilot, Codex) não cobram por token, então o valor é quanto isto custaria pela API — não a sua fatura.'
          : 'Cost is the API equivalent. Subscriptions (Claude Max, Copilot, Codex) do not bill per token, so the figure is what this would cost through the API, not your invoice.'}
        {' '}
        <NavLink to="/settings/billing" style={{ color: 'var(--anthropic-orange)', textDecoration: 'none' }}>
          {pt ? 'Cadastre seu plano' : 'Register your plan'}
        </NavLink>
        {pt
          ? ' e o app passa a poder mostrar o custo real no lugar da estimativa.'
          : ' and the app can show your real cost instead of the estimate.'}
        {' '}
        {/* This table itself never moves. It is a RATE table — a price per million tokens — and a
            flat monthly fee has no per-token equivalent to put in these cells. */}
        <em>
          {pt
            ? 'Esta tabela é sempre de preços de API: é uma tabela de tarifas, e uma assinatura mensal não tem tarifa por token.'
            : 'This table is always API pricing: it is a rate table, and a flat monthly fee has no per-token rate.'}
        </em>
      </div>
    </div>
  )
}
