import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useOutletContext, useParams } from 'react-router-dom'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { format, parseISO } from 'date-fns'
import { ArrowLeft, Pencil, Trash2, CalendarRange } from 'lucide-react'
import {
  fmt, fmtCost, formatModel, formatProjectName, repoShortName,
  totalTokens as totalTokensOf, totalTokensExplained,
} from '@agentistics/core'
import { TokenBreakdownLine } from '../components/TokenBreakdownLine'
import type { AppContext } from '../lib/app-context'
import type { TokenBreakdown } from '@agentistics/core'
import { MetricNote } from '../components/MetricNote'
import { HARNESS_LABELS } from '../lib/harness'
import { ConfirmModal, SectionHeader } from './settings/primitives'
import { useIsMobile } from '../hooks/useIsMobile'

// GET /api/tags/:id response. Aggregate-only by design (spec rule 2): the server never sends the
// session rows behind a tag, so every value rendered here is a count or a sum it already computed.
type TagSourceType = 'repo' | 'project' | 'machine' | 'team' | 'account'
interface TagSource { type: TagSourceType; value: string }
interface TagAggregate {
  sessions: number
  costUSD: number
  /** The two conversational counters. NOT the total — read `tokens`. */
  inputTokens: number
  outputTokens: number
  /** All four billed counters, as the server's `TagAggregate` now sends them. */
  tokens: TokenBreakdown
  topProject: string | null
  topModel: string | null
  topHarness: string | null
}
/** Optional period the tag is pinned to — inclusive `yyyy-MM-dd`, each side independent. */
interface TagWindow { start?: string; end?: string }
interface Tag {
  _id: string
  name: string
  color?: string
  sources: TagSource[]
  filters?: TagSource[]
  window?: TagWindow
  sharedWith: string[]
  createdBy: string
  aggregate: TagAggregate
}
/** A ranked bucket. `label` is only present for machines, whose key stays the opaque memberId. */
interface Bucket { key: string; sessions: number; costUSD: number; tokens: number; label?: string }
interface DayPoint { date: string; sessions: number; costUSD: number; tokens: number }
interface TagStats {
  projects: Bucket[]
  models: Bucket[]
  harnesses: Bucket[]
  repos: Bucket[]
  members: Bucket[]
  /** People (session.user). A person can drive several machines, so this ranks differently. */
  users: Bucket[]
  daily: DayPoint[]
  /** Distinct contributors — plain counts, computed server-side before any bucket redaction. */
  distinctMembers: number
  distinctMachines: number
  firstSessionDate: string | null
  lastSessionDate: string | null
  sessionsWithoutModel: number
}
interface TagDetail {
  tag: Tag
  breakdown: { source: TagSource; aggregate: TagAggregate }[]
  stats: TagStats
}

interface IamTeam { _id: string; name: string }
interface IamAccount { id: string; name: string; email: string }
interface IamMachine { id: string; machineName: string }

/** Mirrors OTHER_BUCKET_KEY in packages/server/server/tags-authority.ts: the anonymous bucket that
 *  absorbs every key the viewer may not see by name, keeping the totals whole. */
const OTHER_KEY = '__other__'
const DEFAULT_COLOR = '#f59e0b'
/** Mirrors LOCAL_MACHINE_ID in packages/server/server/tags-handlers.ts. */
const LOCAL_MACHINE_ID = 'local'

/**
 * Read a JSON response, refusing anything that is not JSON.
 *
 * `/api/tags` used to answer with the plain-TEXT body "Not found" off a central, and this page fed
 * it straight to `r.json()` — a SyntaxError that took the whole page down instead of an error
 * state. Status and content-type are checked before parsing now.
 */
async function readJson<T>(r: Response): Promise<T & { error?: string }> {
  if (!(r.headers.get('content-type') ?? '').includes('application/json')) {
    const text = (await r.text().catch(() => '')).slice(0, 200).trim()
    throw new Error(text || `HTTP ${r.status}`)
  }
  const body = await r.json().catch(() => null) as (T & { error?: string }) | null
  if (!body) throw new Error(`HTTP ${r.status}`)
  if (!r.ok && !body.error) throw new Error(`HTTP ${r.status}`)
  return body
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg)', padding: 16, minWidth: 0,
}
// 44px was applied on every screen (a module object cannot read `useIsMobile()`), so the pencil
// and the trash beside the tag's title were each the height of the title block. The mobile target
// is `.ag-tap-icon`'s invisible box on both consumers.
const iconBtn: React.CSSProperties = {
  width: 30, height: 30, flexShrink: 0, borderRadius: 8,
  border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)',
  cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  fontFamily: 'inherit',
}

/** The KPI tile used across the app: big number over an uppercase caption. */
function StatTile({ label, value, accent, title }: { label: string; value: string; accent?: boolean; title?: string }) {
  return (
    <div title={title} style={{
      display: 'flex', flexDirection: 'column', gap: 3, padding: '12px 14px', minWidth: 0,
      background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
    }}>
      <span style={{
        fontSize: 18, fontWeight: 700, color: accent ? 'var(--anthropic-orange)' : 'var(--text-primary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{value}</span>
      <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
    </div>
  )
}

type Metric = 'costUSD' | 'sessions' | 'tokens'

/** Overlay needs three distinguishable series, so it cannot use the tag's single colour. */
const OVERLAY_COLORS: Record<Metric, string> = {
  costUSD: '#f59e0b',
  sessions: '#3b82f6',
  tokens: '#22c55e',
}

export default function TagDetailPage() {
  const { lang, currency, brlRate, me, isCentral } = useOutletContext<AppContext>()
  const { id } = useParams()
  const navigate = useNavigate()
  const pt = lang === 'pt'
  const isMobile = useIsMobile()

  const [detail, setDetail] = useState<TagDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Central policy: type the name before a destructive delete. Defaults ON, and stays ON if the
  // config read fails — a safety guard must fail closed, never open.
  const [requireDeleteText, setRequireDeleteText] = useState(true)
  useEffect(() => {
    void fetch('/api/team/config')
      .then(r => r.ok ? r.json() as Promise<{ requireDeleteConfirmText?: boolean }> : null)
      .then(c => { if (c && typeof c.requireDeleteConfirmText === 'boolean') setRequireDeleteText(c.requireDeleteConfirmText) })
      .catch(() => { /* keep the safe default */ })
  }, [])
  const [metric, setMetric] = useState<Metric>('costUSD')
  const [overlay, setOverlay] = useState(false)

  // IAM lookups turn a source's opaque id into a readable label. Failures are non-fatal — the raw
  // id is shown instead, which is still unambiguous.
  const [teams, setTeams] = useState<IamTeam[]>([])
  const [accounts, setAccounts] = useState<IamAccount[]>([])
  const [machines, setMachines] = useState<IamMachine[]>([])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setErr(null); setDetail(null)
    void (async () => {
      try {
        const r = await fetch(`/api/tags/${encodeURIComponent(id ?? '')}`)
        const d = await readJson<Partial<TagDetail>>(r)
        if (cancelled) return
        if (d.error || !d.tag) setErr(d.error ?? 'not found')
        else setDetail({ tag: d.tag, breakdown: d.breakdown ?? [], stats: d.stats ?? emptyStats() })
      } catch (e) {
        if (!cancelled) setErr(errText(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [id])

  // IAM lookups exist only on a central; off one there is one machine and no accounts or teams.
  useEffect(() => {
    if (!isCentral) {
      setTeams([]); setAccounts([])
      setMachines([{ id: LOCAL_MACHINE_ID, machineName: pt ? 'Esta máquina' : 'This machine' }])
      return
    }
    void (async () => {
      const [t, a, m] = await Promise.all([
        fetch('/api/iam/teams').then(r => r.ok ? r.json() as Promise<{ teams?: IamTeam[] }> : { teams: [] }).catch(() => ({ teams: [] })),
        fetch('/api/iam/accounts').then(r => r.ok ? r.json() as Promise<{ accounts?: IamAccount[] }> : { accounts: [] }).catch(() => ({ accounts: [] })),
        fetch('/api/iam/machines').then(r => r.ok ? r.json() as Promise<{ machines?: IamMachine[] }> : { machines: [] }).catch(() => ({ machines: [] })),
      ])
      setTeams(t.teams ?? []); setAccounts(a.accounts ?? []); setMachines(m.machines ?? [])
    })()
  }, [isCentral, pt])

  const otherLabel = pt ? 'Outros (fora do seu escopo)' : 'Other (outside your scope)'

  const sourceTypeLabel = useCallback((t: TagSourceType) => ({
    repo: pt ? 'Repositório' : 'Repository',
    project: pt ? 'Projeto' : 'Project',
    machine: pt ? 'Máquina' : 'Machine',
    team: pt ? 'Time' : 'Team',
    account: pt ? 'Conta' : 'Account',
  }[t]), [pt])

  const sourceValueLabel = useCallback((s: TagSource) => {
    switch (s.type) {
      case 'team': return teams.find(t => t._id === s.value)?.name ?? s.value
      case 'account': return accounts.find(a => a.id === s.value)?.name ?? s.value
      case 'machine': return machines.find(m => m.id === s.value)?.machineName ?? s.value
      case 'project': return formatProjectName(s.value)
      default: return s.value
    }
  }, [teams, accounts, machines])

  const doDelete = useCallback(async () => {
    setConfirmDelete(false)
    try {
      const r = await fetch('/api/tags', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: detail?.tag._id ?? id }),
      })
      // Navigating away on a FAILED delete made the tag look gone until the list reloaded it.
      if (!r.ok) {
        const d = await readJson<Record<string, never>>(r).catch((e: unknown) => ({ error: errText(e) }))
        setErr(d.error ?? `HTTP ${r.status}`)
        return
      }
    } catch (e) { setErr(errText(e)); return }
    navigate('/tags')
  }, [detail, id, navigate])

  const tag = detail?.tag
  const stats = detail?.stats
  const color = tag?.color || DEFAULT_COLOR
  // Off a central nobody signs in — the single local user owns every tag on the machine.
  const mayEdit = !!tag && (!isCentral || me?.role === 'owner' || tag.createdBy === me?.id)

  // Overlay mode draws all three series at once. They live on wildly different scales (cost in
  // hundreds, sessions in tens, tokens in millions), so each is normalised to 0-100% of its own
  // peak — the shapes become comparable and the tooltip still reports the REAL values. Same
  // approach as the dashboard's ActivityChart, so the two read alike.
  const chartData = useMemo(() => {
    const daily = stats?.daily ?? []
    const peak = {
      costUSD: Math.max(...daily.map(d => d.costUSD), 1),
      sessions: Math.max(...daily.map(d => d.sessions), 1),
      tokens: Math.max(...daily.map(d => d.tokens), 1),
    }
    return daily.map(d => ({
      ...d,
      costUSD_norm: (d.costUSD / peak.costUSD) * 100,
      sessions_norm: (d.sessions / peak.sessions) * 100,
      tokens_norm: (d.tokens / peak.tokens) * 100,
    }))
  }, [stats])
  const hasRedacted = useMemo(() => {
    if (!stats) return false
    return [stats.projects, stats.repos, stats.members].some(list => list.some(b => b.key === OTHER_KEY))
  }, [stats])

  const back = (
    <button
      type="button"
      onClick={() => navigate('/tags')}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
        minHeight: 44, fontSize: 12, color: 'var(--text-tertiary)', background: 'transparent',
        border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: 0,
      }}
    >
      <ArrowLeft size={13} /> Tags
    </button>
  )

  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {back}
        <div style={{ ...card, fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          {pt ? 'Carregando…' : 'Loading…'}
        </div>
      </div>
    )
  }

  if (err || !tag || !stats) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {back}
        <div style={{ ...card, borderColor: '#ef444455' }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#ef4444', marginBottom: 6 }}>
            {pt ? 'Tag indisponível' : 'Tag unavailable'}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {err ?? (pt ? 'Tag não encontrada.' : 'Tag not found.')}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 8, lineHeight: 1.5 }}>
            {pt
              ? 'Ela pode ter sido excluída, ou você deixou de ter acesso a alguma de suas fontes.'
              : 'It may have been deleted, or you may have lost access to one of its sources.'}
          </div>
        </div>
      </div>
    )
  }

  // Two different things, and conflating them would be the confusing part: `activity` is when work
  // actually happened, `pinned` is the period the tag is fixed to. With a period set the first is
  // necessarily inside the second — seeing both is how you tell "the run ended early" from "the
  // period is wrong".
  const activity = stats.firstSessionDate && stats.lastSessionDate
    ? `${niceDate(stats.firstSessionDate)} → ${niceDate(stats.lastSessionDate)}`
    : (pt ? 'Sem atividade registrada' : 'No recorded activity')
  const pinned = tag.window && (tag.window.start || tag.window.end)
    ? (tag.window.start && tag.window.end
      ? `${niceDate(tag.window.start)} → ${niceDate(tag.window.end)}`
      : tag.window.start
        ? `${pt ? 'desde' : 'from'} ${niceDate(tag.window.start)}`
        : `${pt ? 'até' : 'until'} ${niceDate(tag.window.end!)}`)
    : null

  // Every billed counter — see `tokens.ts` in the core.
  const totalTokens = totalTokensOf(tag.aggregate.tokens)
  const empty = tag.aggregate.sessions === 0

  const metricLabel: Record<Metric, string> = {
    costUSD: pt ? 'Custo' : 'Cost',
    sessions: pt ? 'Sessões' : 'Sessions',
    tokens: 'Tokens',
  }
  const metricValue = (v: number) =>
    metric === 'costUSD' ? fmtCost(v, currency, brlRate) : metric === 'sessions' ? v.toLocaleString() : fmt(v)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
      {back}

      {/* ---- header ---- */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        gap: 12, flexWrap: 'wrap', minWidth: 0,
      }}>
        <div style={{ minWidth: 0, flex: '1 1 220px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
            <span style={{ width: 12, height: 12, borderRadius: '50%', background: color, flexShrink: 0 }} />
            <h1 style={{
              fontSize: 21, fontWeight: 700, color: 'var(--text-primary)', margin: 0,
              minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{tag.name}</h1>
          </div>
          {pinned && (
            <div style={{ marginTop: 7 }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '3px 9px', borderRadius: 999, fontSize: 11.5, fontWeight: 600,
                background: 'var(--anthropic-orange-dim)', border: '1px solid rgba(217,119,6,0.35)',
                color: 'var(--anthropic-orange)', fontVariantNumeric: 'tabular-nums',
              }}>
                <CalendarRange size={12} />
                {pt ? 'Período fixado' : 'Pinned period'}: {pinned}
              </span>
            </div>
          )}
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 5 }}>
            {pinned ? `${pt ? 'Atividade' : 'Activity'}: ${activity}` : activity}
            {' · '}
            {tag.sources.length} {tag.sources.length === 1 ? (pt ? 'fonte' : 'source') : (pt ? 'fontes' : 'sources')}
            {(tag.filters?.length ?? 0) > 0 && (
              <> · {tag.filters!.length} {pt ? 'restrição' : 'restriction'}{tag.filters!.length === 1 ? '' : (pt ? 'ões' : 's')}</>
            )}
          </div>
        </div>
        {mayEdit && (
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            {/* Editing lives on the list page (one editor drawer, one source of truth) — the pencil
                sends the tag back to it with the editor already open. */}
            <button
              type="button"
              aria-label={pt ? 'Editar tag' : 'Edit tag'}
              title={pt ? 'Editar' : 'Edit'}
              className="ag-tap-icon"
              style={iconBtn}
              onClick={() => navigate('/tags', { state: { editTagId: tag._id } })}
            >
              <Pencil size={15} />
            </button>
            <button
              type="button"
              aria-label={pt ? 'Excluir tag' : 'Delete tag'}
              title={pt ? 'Excluir' : 'Delete'}
              className="ag-tap-icon"
              style={{ ...iconBtn, color: '#ef4444' }}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={15} />
            </button>
          </div>
        )}
      </div>

      {/* ---- KPIs ---- */}
      <div>
        {/* Just "Total" — a total is deduplicated by definition. The per-source note below is where
            the overlap is explained, which is the only place it can surprise anyone. */}
        <SectionHeader label={pt ? 'Total' : 'Total'} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10 }}>
          <StatTile label={pt ? 'Custo' : 'Cost'} value={fmtCost(tag.aggregate.costUSD, currency, brlRate)} accent />
          <StatTile label={pt ? 'Sessões' : 'Sessions'} value={tag.aggregate.sessions.toLocaleString()} />
          {/* ONE tokens tile, with the four counters on the line below the strip. It was the total
              plus input and output as three tiles, under a note explaining why two of them did not
              add up to the first — an apology for the missing pair rather than the pair. Adding
              them as tiles was the first fix and the wrong one: this grid is `auto-fit` over
              `minmax(130px, 1fr)`, so past a certain count the last tile is stranded alone on a
              second row. */}
          <StatTile
            label="Tokens"
            value={fmt(totalTokens)}
            title={totalTokensExplained(tag.aggregate.tokens, pt ? 'pt' : 'en')}
          />
          {/* Counts, not names — so they need no redaction and stay honest even when the machine
              buckets below collapse several unseeable ones into a single "other". */}
          <StatTile label={pt ? 'Membros' : 'Members'} value={(detail?.stats.distinctMembers ?? 0).toLocaleString()} />
          <StatTile label={pt ? 'Máquinas' : 'Machines'} value={(detail?.stats.distinctMachines ?? 0).toLocaleString()} />
        </div>
        <TokenBreakdownLine tokens={tag.aggregate.tokens} lang={pt ? 'pt' : 'en'} />
        {/* A tag whose sources resolve to nothing is a real, common state (a brand-new grouping, or
            one whose machines have not pushed yet) — say so instead of showing five zeros. */}
        {empty && (
          <div style={{
            marginTop: 10, border: '1px dashed var(--border)', borderRadius: 12, padding: 20,
            fontSize: 12.5, color: 'var(--text-tertiary)', textAlign: 'center', lineHeight: 1.5,
          }}>
            {pt
              ? 'Nenhuma sessão corresponde às fontes desta tag ainda.'
              : 'No sessions match this tag’s sources yet.'}
          </div>
        )}
      </div>

      {/* ---- activity ---- */}
      {chartData.length > 0 && (
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginRight: 'auto' }}>
              {pt ? 'Atividade' : 'Activity'}
            </span>
            {(['costUSD', 'sessions', 'tokens'] as Metric[]).map(m => (
              <button
                key={m}
                type="button"
                disabled={overlay}
                onClick={() => setMetric(m)}
                className="ag-tap"
                style={{
                  // The 44px MOBILE touch target is `.ag-tap`'s invisible box, not the pill: a
                  // segmented control painted at 44px is the "chubby" shape this page was reported
                  // for. Desktop follows the project's control density (TabSelect, primitives).
                  padding: isMobile ? '5px 12px' : '0 10px',
                  minHeight: isMobile ? undefined : 28,
                  borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit',
                  border: metric === m ? `1px solid ${color}60` : '1px solid var(--border)',
                  background: metric === m ? `${color}18` : 'transparent',
                  color: metric === m ? color : 'var(--text-secondary)',
                  fontSize: 12, fontWeight: 600, transition: 'all 0.15s',
                }}
              >
                {metricLabel[m]}
              </button>
            ))}
            {/* Overlay draws all three at once, normalised so their shapes can be compared. It is a
                separate toggle rather than a fourth pill because it is a different KIND of choice:
                the pills pick which series, this picks how many. */}
            <button
              type="button"
              onClick={() => setOverlay(o => !o)}
              aria-pressed={overlay}
              title={pt ? 'Sobrepor as três séries (escala normalizada)' : 'Overlay all three series (normalised scale)'}
              className="ag-tap"
              style={{
                padding: isMobile ? '5px 12px' : '0 10px',
                minHeight: isMobile ? undefined : 28,
                borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit',
                border: overlay ? `1px solid ${color}60` : '1px solid var(--border)',
                background: overlay ? `${color}18` : 'transparent',
                color: overlay ? color : 'var(--text-secondary)',
                fontSize: 12, fontWeight: 600, transition: 'all 0.15s',
              }}
            >
              {pt ? 'Sobrepor' : 'Overlay'}
            </button>
          </div>
          {/* The tooltip is absolutely positioned by recharts and was clipped by the card's
              rounded overflow near the edges — `visible` lets it overlap the card as intended. */}
          <div style={{ overflow: 'visible' }}>
          <ResponsiveContainer width="100%" height={isMobile ? 170 : 210}>
            <AreaChart data={chartData} margin={{ left: -10, right: 4 }}>
              <defs>
                <linearGradient id="tag-detail-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.32} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--border)" strokeDasharray="0" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fill: 'var(--text-tertiary)', fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={v => { try { return format(parseISO(String(v)), 'MMM d') } catch { return String(v) } }}
                interval="preserveStartEnd"
              />
              <YAxis hide />
              <Tooltip
                content={<DayTooltip currency={currency} brlRate={brlRate} pt={pt} />}
                cursor={{ stroke: 'var(--border)' }}
              />
              {overlay ? (
                // One area per metric, on the normalised keys. Distinct colours because the tag's
                // own colour cannot distinguish three series; fills are faint so the lines read.
                (['costUSD', 'sessions', 'tokens'] as Metric[]).map(m => (
                  <Area
                    key={m}
                    type="monotone"
                    dataKey={`${m}_norm`}
                    stroke={OVERLAY_COLORS[m]}
                    strokeWidth={2}
                    fill={OVERLAY_COLORS[m]}
                    fillOpacity={0.08}
                    dot={false}
                    activeDot={{ r: 3, fill: OVERLAY_COLORS[m], stroke: 'var(--bg-base)', strokeWidth: 2 }}
                    name={metricLabel[m]}
                  />
                ))
              ) : (
                <Area
                  type="monotone"
                  dataKey={metric}
                  stroke={color}
                  strokeWidth={2}
                  fill="url(#tag-detail-grad)"
                  dot={false}
                  activeDot={{ r: 4, fill: color, stroke: 'var(--bg-base)', strokeWidth: 2 }}
                  name={metricLabel[metric]}
                />
              )}
            </AreaChart>
          </ResponsiveContainer>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 6 }}>
            {pt ? 'Pico: ' : 'Peak: '}
            {(() => {
              const peak = chartData.reduce<DayPoint | null>((acc, d) => (!acc || d[metric] > acc[metric] ? d : acc), null)
              return peak ? `${niceDate(peak.date)} — ${metricValue(peak[metric])}` : '—'
            })()}
          </div>
        </div>
      )}

      {/* ---- ranked breakdowns ---- */}
      {/* Bare `.ag-grid` is the 2-column utility, collapsing to one column below 420px. */}
      <div className="ag-grid">
        <Ranked title={pt ? 'Projetos' : 'Projects'} buckets={stats.projects} color={color} pt={pt}
          currency={currency} brlRate={brlRate} otherLabel={otherLabel}
          labelOf={b => formatProjectName(b.key)} />
        <Ranked title={pt ? 'Repositórios' : 'Repositories'} buckets={stats.repos} color={color} pt={pt}
          currency={currency} brlRate={brlRate} otherLabel={otherLabel}
          labelOf={b => repoShortName(b.key) || b.key} />
        <Ranked title={pt ? 'Modelos' : 'Models'} buckets={stats.models} color={color} pt={pt}
          currency={currency} brlRate={brlRate} otherLabel={otherLabel}
          labelOf={b => formatModel(b.key)}
          footnote={stats.sessionsWithoutModel > 0
            ? (pt
              ? `${stats.sessionsWithoutModel} sessão(ões) sem modelo identificado — contam no total, mas não aqui.`
              : `${stats.sessionsWithoutModel} session(s) carry no model id — they count in the total but not here.`)
            : undefined} />
        <Ranked title="Harnesses" buckets={stats.harnesses} color={color} pt={pt}
          currency={currency} brlRate={brlRate} otherLabel={otherLabel}
          labelOf={b => HARNESS_LABELS[b.key as keyof typeof HARNESS_LABELS] ?? b.key} />
        {/* People first, then the machines they used: "who worked on this" is the question a
            reader asks before "from where". A person on two machines is one row here and two below. */}
        <Ranked title={pt ? 'Membros' : 'Members'} buckets={stats.users} color={color} pt={pt}
          currency={currency} brlRate={brlRate} otherLabel={otherLabel}
          labelOf={b => b.key} />
        <Ranked title={pt ? 'Máquinas' : 'Machines'} buckets={stats.members} color={color} pt={pt}
          currency={currency} brlRate={brlRate} otherLabel={otherLabel}
          labelOf={b => b.label ?? b.key} />
      </div>

      {/* ---- per source ---- */}
      <div style={card}>
        <SectionHeader label={pt ? 'Por fonte' : 'Per source'} />
        {/* The per-source numbers deliberately sum to MORE than the tag total when sources overlap —
            a session counted by two sources is counted once in the total. That gap is the dedupe
            working, so say so instead of letting it read as a bug. */}
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginBottom: 12, lineHeight: 1.5 }}>
          {pt
            ? 'O total da tag é sem duplicidade; os números por fonte não são. Fontes que se sobrepõem contam a mesma sessão mais de uma vez, então somar as linhas abaixo pode passar do total — isso é esperado.'
            : 'The tag total is deduplicated; the per-source figures are not. Overlapping sources count the same session more than once, so summing the rows below may exceed the total — that is expected.'}
        </div>

        {/* Say the restriction out loud. Without it a reader comparing these numbers against the
            repo's own page sees smaller figures with nothing to explain the gap. */}
        {(tag.filters?.length ?? 0) > 0 && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6,
            fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 12,
            padding: '8px 10px', borderRadius: 8,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          }}>
            <span style={{ color: 'var(--text-tertiary)' }}>
              {pt ? 'Restrita a:' : 'Restricted to:'}
            </span>
            {tag.filters!.map((f, i) => (
              <span key={`${f.type}-${f.value}-${i}`} style={{
                padding: '2px 7px', borderRadius: 999, fontSize: 11,
                background: 'var(--bg-card)', border: '1px solid var(--border)',
              }}>
                <span style={{ color: 'var(--text-tertiary)' }}>{f.type}</span>{' '}{f.value}
              </span>
            ))}
            <span style={{ color: 'var(--text-tertiary)', width: '100%', marginTop: 2 }}>
              {pt
                ? 'Dentro de um mesmo tipo vale qualquer um; entre tipos, todos.'
                : 'Within one type any value counts; across types, all must.'}
            </span>
          </div>
        )}
        {detail.breakdown.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
            {pt ? 'Nenhuma fonte configurada.' : 'No sources configured.'}
          </div>
        ) : (
          // Wide row: scrolls inside its own container so the page itself never scrolls sideways.
          <div style={{ overflowX: 'auto', margin: '0 -4px', padding: '0 4px' }}>
            <div style={{ minWidth: 460 }}>
              <div style={{
                display: 'grid', gridTemplateColumns: '90px minmax(120px, 1fr) 90px 80px 90px',
                gap: 10, padding: '0 0 8px', fontSize: 9.5, fontWeight: 700,
                color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em',
                borderBottom: '1px solid var(--border-subtle)',
              }}>
                <span>{pt ? 'Tipo' : 'Type'}</span>
                <span>{pt ? 'Fonte' : 'Source'}</span>
                <span style={{ textAlign: 'right' }}>{pt ? 'Custo' : 'Cost'}</span>
                <span style={{ textAlign: 'right' }}>{pt ? 'Sessões' : 'Sessions'}</span>
                <span style={{ textAlign: 'right' }}>Tokens</span>
              </div>
              {detail.breakdown.map((b, i) => (
                <div key={`${b.source.type}:${b.source.value}:${i}`} style={{
                  display: 'grid', gridTemplateColumns: '90px minmax(120px, 1fr) 90px 80px 90px',
                  gap: 10, alignItems: 'center', minHeight: 44, fontSize: 12,
                  borderBottom: i === detail.breakdown.length - 1 ? 'none' : '1px solid var(--border-subtle)',
                }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {sourceTypeLabel(b.source.type)}
                  </span>
                  <span style={{ color: 'var(--text-primary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {sourceValueLabel(b.source)}
                  </span>
                  <span style={{ textAlign: 'right', color: 'var(--anthropic-orange)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtCost(b.aggregate.costUSD, currency, brlRate)}
                  </span>
                  <span style={{ textAlign: 'right', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                    {b.aggregate.sessions.toLocaleString()}
                  </span>
                  <span style={{ textAlign: 'right', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                    {fmt(totalTokensOf(b.aggregate.tokens))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ---- access ----
          Every line of this panel names an IAM concept (owners, the creator, grantees) and the
          redaction that goes with them. Off a central none of it exists — one user, nothing
          redacted, nothing shared — so the whole panel is hidden rather than shown stating rules
          that do not apply. */}
      {isCentral && (
      <div style={card}>
        <SectionHeader label={pt ? 'Quem tem acesso' : 'Who has access'} />
        {/* Three DIFFERENT kinds of access were rendered as one flat row of identical chips, so
            "Owners" (a standing role), the creator (implicit and revocable) and the explicit
            grantees looked interchangeable. Each is now its own group stating where the access
            comes from and what it allows — the same distinction the server enforces. */}
        <div className="ag-grid cols-3">
          <AccessGroup
            title={pt ? 'Owners' : 'Owners'}
            permission={pt ? 'ver · editar · excluir' : 'view · edit · delete'}
            note={pt
              ? 'Todo owner do central enxerga qualquer tag, por cargo.'
              : 'Every central owner sees any tag, by role.'}
          >
            <AccessChip text={pt ? 'Todos os owners' : 'All owners'} muted />
          </AccessGroup>

          <AccessGroup
            title={pt ? 'Criador' : 'Creator'}
            permission={pt ? 'ver · editar · excluir' : 'view · edit · delete'}
            note={pt
              ? 'Mantém o acesso enquanto continuar enxergando todas as fontes da tag.'
              : 'Keeps access while they can still see every one of the tag’s sources.'}
          >
            <AccessChip text={accounts.find(a => a.id === tag.createdBy)?.name ?? tag.createdBy} />
          </AccessGroup>

          <AccessGroup
            title={pt ? 'Compartilhada com' : 'Shared with'}
            permission={pt ? 'somente ver' : 'view only'}
            note={pt
              ? 'Vê os números completos da tag, mas não as sessões por trás deles nem pode editá-la.'
              : 'Sees the tag’s full numbers, but not the sessions behind them, and cannot edit it.'}
          >
            {tag.sharedWith.length === 0
              ? (
                <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
                  {pt ? 'Ainda não compartilhada com ninguém.' : 'Not shared with anyone yet.'}
                </span>
              )
              : tag.sharedWith.map(accId => (
                <AccessChip key={accId} text={accounts.find(a => a.id === accId)?.name ?? accId} />
              ))}
          </AccessGroup>
        </div>
        {/* Rule 2: the keys of buckets the viewer cannot see are collapsed server-side, never sent. */}
        {hasRedacted && (
          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 8, lineHeight: 1.5 }}>
            {pt
              ? `“${otherLabel}” agrupa itens fora do seu escopo: os números entram no total, mas os nomes não são exibidos.`
              : `“${otherLabel}” groups items outside your scope: their numbers count towards the total, but their names are not shown.`}
          </div>
        )}
        {me && me.role !== 'owner' && (
          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 8, lineHeight: 1.5 }}>
            {pt
              ? 'Filtrar o dashboard por esta tag mostra apenas as sessões que você já pode ver — os totais aqui podem ser maiores.'
              : 'Filtering the dashboard by this tag shows only sessions you can already see — the totals here may be higher.'}
          </div>
        )}
      </div>
      )}

      <ConfirmModal
        open={confirmDelete}
        title={pt ? 'Excluir tag?' : 'Delete tag?'}
        message={pt
          ? `A tag "${tag.name}" será removida. As sessões não são afetadas.`
          : `The tag "${tag.name}" will be removed. Sessions are not affected.`}
        confirmLabel={pt ? 'Excluir' : 'Delete'}
        cancelLabel={pt ? 'Cancelar' : 'Cancel'}
        // Typing the name is the central's default; an owner can turn it off in Settings.
        requireText={requireDeleteText ? tag.name : undefined}
        requireTextHint={requireDeleteText
          ? (pt ? `Digite "${tag.name}" para confirmar` : `Type "${tag.name}" to confirm`)
          : undefined}
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  )
}

function emptyStats(): TagStats {
  return {
    projects: [], models: [], harnesses: [], repos: [], members: [], users: [], daily: [],
    distinctMembers: 0, distinctMachines: 0,
    firstSessionDate: null, lastSessionDate: null, sessionsWithoutModel: 0,
  }
}

/** `2026-07-25` → a short, locale-neutral label. Falls back to the raw key on a bad date. */
function niceDate(iso: string): string {
  try { return format(parseISO(iso), 'MMM d, yyyy') } catch { return iso }
}

/** One category of access: where it comes from, what it allows, and who holds it.
 *  The permission is stated per group because the three differ — only the shared-with group is
 *  read-only, and conflating them is what made the flat chip row misleading. */
function AccessGroup({ title, permission, note, children }: {
  title: string
  permission: string
  note: string
  children: React.ReactNode
}) {
  return (
    // A column in the access grid. The explanation is a `title` tooltip rather than a paragraph:
    // three sentences stacked vertically turned a three-fact panel into a full screen of text.
    <div title={note} style={{
      minWidth: 0, padding: '10px 12px', borderRadius: 9,
      border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
      display: 'flex', flexDirection: 'column', gap: 7,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
        <span style={{
          fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)',
          textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap',
        }}>{title}</span>
        <span style={{
          fontSize: 9.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap',
          overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{permission}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>{children}</div>
    </div>
  )
}

function AccessChip({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <span style={{
      display: 'inline-block', maxWidth: '100%', padding: '5px 10px', borderRadius: 999, fontSize: 11.5,
      background: 'var(--bg-elevated)', border: '1px solid var(--border)',
      color: muted ? 'var(--text-tertiary)' : 'var(--text-secondary)',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    }}>{text}</span>
  )
}

/** One ranked distribution: name, share-of-total bar, then sessions / cost / tokens.
 *  The share is computed on cost, falling back to sessions when nothing in the list cost anything
 *  (Gemini/Copilot sessions carry no token data, so a cost-only bar would render flat at zero). */
function Ranked({ title, buckets, color, pt, currency, brlRate, otherLabel, labelOf, footnote }: {
  title: string
  buckets: Bucket[]
  color: string
  pt: boolean
  currency: 'USD' | 'BRL'
  brlRate: number
  otherLabel: string
  labelOf: (b: Bucket) => string
  footnote?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const totalCost = buckets.reduce((a, b) => a + b.costUSD, 0)
  const totalSessions = buckets.reduce((a, b) => a + b.sessions, 0)
  const share = (b: Bucket) => totalCost > 0
    ? b.costUSD / totalCost
    : (totalSessions > 0 ? b.sessions / totalSessions : 0)

  const LIMIT = 6
  const shown = expanded ? buckets : buckets.slice(0, LIMIT)

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 'auto' }}>{buckets.length}</span>
      </div>
      {buckets.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>
          {pt ? 'Sem dados.' : 'No data.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {shown.map(b => {
            const isOther = b.key === OTHER_KEY
            return (
              <div key={b.key} style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
                  <span style={{
                    fontSize: 12.5, fontWeight: 600, minWidth: 0, flex: 1,
                    color: isOther ? 'var(--text-tertiary)' : 'var(--text-primary)',
                    fontStyle: isOther ? 'italic' : 'normal',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{isOther ? otherLabel : labelOf(b)}</span>
                  <span style={{
                    fontSize: 12, fontWeight: 700, color: 'var(--anthropic-orange)',
                    fontVariantNumeric: 'tabular-nums', flexShrink: 0,
                  }}>{fmtCost(b.costUSD, currency, brlRate)}</span>
                </div>
                <div style={{ height: 4, borderRadius: 2, background: 'var(--bg-elevated)', margin: '5px 0 4px', overflow: 'hidden' }}>
                  <div style={{
                    width: `${Math.max(2, Math.round(share(b) * 100))}%`, height: '100%',
                    background: isOther ? 'var(--text-tertiary)' : color, borderRadius: 2,
                  }} />
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
                  {b.sessions.toLocaleString()} {pt ? 'sessões' : 'sessions'}
                  {' · '}{fmt(b.tokens)} tokens
                  {' · '}{Math.round(share(b) * 100)}%
                </div>
              </div>
            )
          })}
          {buckets.length > LIMIT && (
            <button
              type="button"
              onClick={() => setExpanded(v => !v)}
              style={{
                minHeight: 44, border: '1px solid var(--border)', borderRadius: 7, background: 'transparent',
                color: 'var(--text-secondary)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >
              {expanded
                ? (pt ? 'Mostrar menos' : 'Show less')
                : (pt ? `Mostrar todos (${buckets.length})` : `Show all (${buckets.length})`)}
            </button>
          )}
        </div>
      )}
      {footnote && (
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 10, lineHeight: 1.5 }}>{footnote}</div>
      )}
    </div>
  )
}

/** Recharts tooltip for the daily series — all three metrics at once, same chrome as ActivityChart. */
function DayTooltip({ active, payload, label, currency, brlRate, pt }: {
  active?: boolean
  payload?: { payload?: DayPoint }[]
  label?: string | number
  currency: 'USD' | 'BRL'
  brlRate: number
  pt: boolean
}) {
  const point = active ? payload?.[0]?.payload : undefined
  if (!point) return null
  return (
    <div style={{
      background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '10px 14px', fontSize: 12, boxShadow: 'var(--shadow-elevated)',
    }}>
      <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
        {niceDate(String(label ?? point.date))}
      </div>
      <Row label={pt ? 'Custo' : 'Cost'} value={fmtCost(point.costUSD, currency, brlRate)} />
      <Row label={pt ? 'Sessões' : 'Sessions'} value={point.sessions.toLocaleString()} />
      <Row label="Tokens" value={fmt(point.tokens)} />
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 10, justifyContent: 'space-between', color: 'var(--text-secondary)', marginTop: 2 }}>
      <span>{label}</span>
      <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{value}</span>
    </div>
  )
}
