import React, { useRef, useState, useMemo, useEffect } from 'react'
import {
  BarChart2, TrendingUp, Clock, Wrench, FolderOpen, List, LayoutGrid, Trophy, Bot, Cpu, GitCompare,
} from 'lucide-react'
import { format, parseISO, subDays } from 'date-fns'
import type { AppData, Filters, Lang, ModelUsage, SessionMeta, HarnessId } from '@agentistics/core'
import { sessionTime } from '../lib/sessionTime'
import { formatModel, formatProjectName, repoShortName, calcCost, sessionLabel, fmt, fmtCost, fmtFull, EMPTY_TOKENS, totalTokens } from '@agentistics/core'
import { useDerivedStats, blendedCostPerToken, blendedSessionCost, type BlendedRates, type HarnessSummary } from '../hooks/useData'
import { HARNESS_LABELS, HARNESS_COLORS, capable } from '../lib/harness'

// Types

export type PDFTheme = 'light' | 'dark'

export const SECTION_IDS = ['summary', 'activity', 'heatmap', 'hours', 'models', 'projects', 'tools', 'sessions', 'highlights', 'agents', 'compare'] as const
export type SectionId = typeof SECTION_IDS[number]

interface Colors {
  bg: string; bgCard: string; bgElevated: string; border: string
  text: string; textSec: string; textTer: string
  orange: string; blue: string; green: string; purple: string; cyan: string; red: string
}

interface HeatmapDay { date: string; value: number; sessions: number; tools: number }

// Constants

export const COLORS: Record<PDFTheme, Colors> = {
  light: {
    bg: '#ffffff', bgCard: '#f9fafb', bgElevated: '#f3f4f6', border: '#e5e7eb',
    text: '#111827', textSec: '#6b7280', textTer: '#9ca3af',
    orange: '#D97706', blue: '#3b82f6', green: '#10b981', purple: '#8b5cf6', cyan: '#06b6d4', red: '#ef4444',
  },
  dark: {
    bg: '#0f1117', bgCard: '#181b24', bgElevated: '#1e2230', border: '#2a2e3f',
    text: '#e8eaf0', textSec: '#8892a4', textTer: '#586070',
    orange: '#f59e0b', blue: '#60a5fa', green: '#34d399', purple: '#a78bfa', cyan: '#22d3ee', red: '#f87171',
  },
}

export const SECTIONS: { id: SectionId; labelPt: string; labelEn: string; Icon: React.ElementType }[] = [
  { id: 'summary',    labelPt: 'Resumo',       labelEn: 'Summary',    Icon: BarChart2   },
  { id: 'activity',   labelPt: 'Atividade',    labelEn: 'Activity',   Icon: TrendingUp  },
  { id: 'heatmap',    labelPt: 'Mapa calor',   labelEn: 'Heatmap',    Icon: LayoutGrid  },
  { id: 'hours',      labelPt: 'Por hora',     labelEn: 'By hour',    Icon: Clock       },
  { id: 'models',     labelPt: 'Modelos',      labelEn: 'Models',     Icon: Cpu         },
  { id: 'projects',   labelPt: 'Projetos',     labelEn: 'Projects',   Icon: FolderOpen  },
  { id: 'tools',      labelPt: 'Ferramentas',  labelEn: 'Tools',      Icon: Wrench      },
  { id: 'sessions',   labelPt: 'Sessões',      labelEn: 'Sessions',   Icon: List        },
  { id: 'highlights', labelPt: 'Recordes',     labelEn: 'Highlights', Icon: Trophy      },
  { id: 'agents',     labelPt: 'Agentes',      labelEn: 'Agents',     Icon: Bot         },
  { id: 'compare',    labelPt: 'Comparação',   labelEn: 'Compare',    Icon: GitCompare  },
]

export const DATE_OPTIONS = [
  { value: 'all',  labelPt: 'Tudo',      labelEn: 'All' },
  { value: '7d',   labelPt: '7 dias',    labelEn: '7 days' },
  { value: '30d',  labelPt: '30 dias',   labelEn: '30 days' },
  { value: '90d',  labelPt: '90 dias',   labelEn: '90 days' },
] as const

// Helper formatters
// Token/count values go through the shared `fmt()` (K/M abbreviated) and costs
// through the shared `fmtCost()` (thousands-separated, e.g. "USD 4,729.65") from
// @agentistics/core — never inline ad-hoc formatting here.

function fmtDur(min: number): string {
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/** Distribute daily session counts into n equal-width time buckets over a shared
 *  [minMs, maxMs] axis so sparklines across harnesses are temporally comparable. */
function bucketize(
  daily: { date: string; sessions: number }[],
  minMs: number,
  maxMs: number,
  n: number,
): number[] {
  const buckets = new Array<number>(n).fill(0)
  if (daily.length === 0 || maxMs <= minMs) {
    for (const d of daily) buckets[0] = (buckets[0] ?? 0) + d.sessions
    return buckets
  }
  const span = maxMs - minMs
  for (const d of daily) {
    const ts = new Date(d.date).getTime()
    if (Number.isNaN(ts)) continue
    let idx = Math.floor(((ts - minMs) / span) * n)
    if (idx < 0) idx = 0
    if (idx >= n) idx = n - 1
    buckets[idx] = (buckets[idx] ?? 0) + d.sessions
  }
  return buckets
}

// Mini chart components (all use inline styles + actual hex colors)

function SectionTitle({ title, c }: { title: string; c: Colors }) {
  return (
    <div style={{
      fontSize: 12, fontWeight: 700, color: c.text, marginBottom: 12,
      paddingBottom: 6, borderBottom: `1px solid ${c.border}`,
    }}>
      {title}
    </div>
  )
}

function KPICard({ label, value, sub, accent, c }: {
  label: string; value: string | number; sub: string; accent: string; c: Colors
}) {
  return (
    <div style={{ background: c.bgCard, border: `1px solid ${c.border}`, borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ fontSize: 9, color: c.textSec, fontWeight: 500, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color: accent, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: c.textTer, marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

export type ChartMetric = 'messages' | 'sessions' | 'tools'

const METRIC_META: Record<ChartMetric, { label: string; getVal: (d: HeatmapDay) => number; colorKey: keyof Colors }> = {
  messages: { label: 'Messages', getVal: d => d.value,    colorKey: 'orange' },
  sessions: { label: 'Sessions', getVal: d => d.sessions, colorKey: 'blue'   },
  tools:    { label: 'Tool calls', getVal: d => d.tools,  colorKey: 'green'  },
}

function MiniLineChart({ data, c, metric = 'messages', overlay = null, overlayAll = false }: {
  data: HeatmapDay[]; c: Colors; metric?: ChartMetric; overlay?: ChartMetric | null; overlayAll?: boolean
}) {
  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date)).slice(-60)
  if (sorted.length < 2) {
    return <div style={{ height: 128, display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.textTer, fontSize: 11 }}>No data</div>
  }

  const LEGEND_H = 18
  const W = 698, H = 110 + LEGEND_H, padL = 36, padR = 8, padT = LEGEND_H + 8, padB = 24
  const innerW = W - padL - padR, innerH = H - padT - padB

  const step = Math.max(1, Math.floor(sorted.length / 6))
  const xLabels = sorted.map((d, i) => ({ d, i })).filter(({ i }) => i % step === 0 || i === sorted.length - 1)

  if (overlayAll) {
    // Show all 3 lines normalized to 0-100% (own scale each)
    const allMetrics = Object.values(METRIC_META) as (typeof METRIC_META)[keyof typeof METRIC_META][]
    const allKeys = (Object.keys(METRIC_META) as ChartMetric[])
    const maxes = allKeys.map(k => Math.max(...sorted.map(d => METRIC_META[k].getVal(d)), 1))

    return (
      <svg width={W} height={H} style={{ display: 'block', overflow: 'visible' }}>
        {/* Legend */}
        {allKeys.map((k, ki) => {
          const color = c[METRIC_META[k].colorKey] as string
          return (
            <g key={k}>
              <circle cx={padL + ki * 110} cy={LEGEND_H / 2} r={3} fill={color} />
              <line x1={padL + ki * 110 + 6} y1={LEGEND_H / 2} x2={padL + ki * 110 + 18} y2={LEGEND_H / 2} stroke={color} strokeWidth={1.5} strokeDasharray={ki > 0 ? '4,2' : ''} />
              <text x={padL + ki * 110 + 22} y={LEGEND_H / 2 + 3.5} fontSize={8} fill={c.textSec} fontWeight="600">{METRIC_META[k].label}</text>
            </g>
          )
        })}
        <text x={padL + 350} y={LEGEND_H / 2 + 3.5} fontSize={7} fill={c.textTer}>(normalized 0–100%)</text>

        {/* Grid */}
        {[0, 0.25, 0.5, 0.75, 1].map(pct => {
          const y = padT + (1 - pct) * innerH
          return (
            <g key={pct}>
              <line x1={padL} y1={y} x2={padL + innerW} y2={y} stroke={c.border} strokeWidth={0.5} strokeDasharray="2,2" />
              <text x={padL - 4} y={y + 3.5} fontSize={8} fill={c.textTer} textAnchor="end">{Math.round(pct * 100)}%</text>
            </g>
          )
        })}

        {/* Lines */}
        {allKeys.map((k, ki) => {
          const color = c[METRIC_META[k].colorKey] as string
          const mx = maxes[ki] ?? 1
          const pts = sorted.map((d, i) => {
            const x = padL + (i / (sorted.length - 1)) * innerW
            const y = padT + (1 - METRIC_META[k].getVal(d) / mx) * innerH
            return `${x.toFixed(1)},${y.toFixed(1)}`
          }).join(' ')
          return (
            <polyline key={k} points={pts} fill="none" stroke={color} strokeWidth={1.5}
              strokeLinejoin="round" strokeDasharray={ki > 0 ? '5,2' : ''} />
          )
        })}

        {/* X labels */}
        {xLabels.map(({ d, i }) => {
          const x = padL + (i / (sorted.length - 1)) * innerW
          return (
            <text key={d.date} x={x} y={H - 4} fontSize={8} fill={c.textTer} textAnchor="middle">
              {d.date.slice(5)}
            </text>
          )
        })}
      </svg>
    )
  }

  const meta = METRIC_META[metric]
  const overlayMeta = overlay ? METRIC_META[overlay] : null

  const primaryColor = c[meta.colorKey] as string
  const max = Math.max(...sorted.map(d => meta.getVal(d)), 1)

  const pts = sorted.map((d, i) => {
    const x = padL + (i / (sorted.length - 1)) * innerW
    const y = padT + (1 - meta.getVal(d) / max) * innerH
    return [x, y] as [number, number]
  })
  const lineStr = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const areaStr = `${padL},${padT + innerH} ${lineStr} ${padL + innerW},${padT + innerH}`

  let overlayStr = ''
  let overlayColor = ''
  if (overlayMeta) {
    overlayColor = c[overlayMeta.colorKey] as string
    const overlayMax = Math.max(...sorted.map(d => overlayMeta.getVal(d)), 1)
    overlayStr = sorted.map((d, i) => {
      const x = padL + (i / (sorted.length - 1)) * innerW
      const y = padT + (1 - overlayMeta.getVal(d) / overlayMax) * innerH
      return `${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')
  }

  return (
    <svg width={W} height={H} style={{ display: 'block', overflow: 'visible' }}>
      {/* Legend */}
      <circle cx={padL} cy={LEGEND_H / 2} r={4} fill={primaryColor} />
      <text x={padL + 9} y={LEGEND_H / 2 + 3.5} fontSize={8} fill={c.textSec} fontWeight="600">{meta.label}</text>
      {overlayMeta && (
        <>
          <circle cx={padL + 90} cy={LEGEND_H / 2} r={3} fill={overlayColor} />
          <line x1={padL + 96} y1={LEGEND_H / 2} x2={padL + 108} y2={LEGEND_H / 2} stroke={overlayColor} strokeWidth={1.5} strokeDasharray="3,2" />
          <text x={padL + 112} y={LEGEND_H / 2 + 3.5} fontSize={8} fill={c.textSec} fontWeight="600">{overlayMeta.label}</text>
          <text x={padL + 112 + 55} y={LEGEND_H / 2 + 3.5} fontSize={7} fill={c.textTer}>(scaled)</text>
        </>
      )}

      {/* Grid */}
      {[0, 0.25, 0.5, 0.75, 1].map(pct => {
        const y = padT + (1 - pct) * innerH
        return (
          <g key={pct}>
            <line x1={padL} y1={y} x2={padL + innerW} y2={y} stroke={c.border} strokeWidth={0.5} strokeDasharray="2,2" />
            <text x={padL - 4} y={y + 3.5} fontSize={8} fill={c.textTer} textAnchor="end">{fmt(Math.round(pct * max))}</text>
          </g>
        )
      })}

      {/* Area + primary line */}
      <polygon points={areaStr} fill={`${primaryColor}25`} />
      <polyline points={lineStr} fill="none" stroke={primaryColor} strokeWidth={1.5} strokeLinejoin="round" />

      {/* Overlay line (dashed, own scale) */}
      {overlayStr && (
        <polyline points={overlayStr} fill="none" stroke={overlayColor} strokeWidth={1.5} strokeLinejoin="round" strokeDasharray="4,2" />
      )}

      {/* X labels */}
      {xLabels.map(({ d, i }) => {
        const x = padL + (i / (sorted.length - 1)) * innerW
        return (
          <text key={d.date} x={x} y={H - 4} fontSize={8} fill={c.textTer} textAnchor="middle">
            {d.date.slice(5)}
          </text>
        )
      })}
    </svg>
  )
}

function MiniHeatmap({ data, c }: { data: HeatmapDay[]; c: Colors }) {
  // Size cells to fill the full 698px content area
  // 698px - 20px (day labels) = 678px / 26 weeks ≈ 26px/week → cell=22, gap=4
  const cell = 22, gap = 4, weeks = 26
  const slotW = cell + gap  // 26px per week
  const dateMap = new Map(data.map(d => [d.date, d.value]))
  const max = Math.max(...data.map(d => d.value), 1)
  const today = new Date()
  const labelW = 20
  const svgW = labelW + weeks * slotW  // 20 + 676 = 696px
  const svgH = 7 * slotW + 18          // day cells + month label row

  const cells: { x: number; y: number; intensity: number }[] = []
  for (let w = weeks - 1; w >= 0; w--) {
    for (let dow = 0; dow < 7; dow++) {
      const date = subDays(today, w * 7 + (6 - dow))
      const dateStr = format(date, 'yyyy-MM-dd')
      const v = dateMap.get(dateStr) ?? 0
      cells.push({
        x: labelW + (weeks - 1 - w) * slotW,
        y: dow * slotW,
        intensity: v / max,
      })
    }
  }

  const dayLabels = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S']

  // Month labels
  const monthLabels: { x: number; label: string }[] = []
  let lastMonth = ''
  for (let w = 0; w < weeks; w++) {
    const date = subDays(today, (weeks - 1 - w) * 7)
    const m = format(date, 'MMM')
    if (m !== lastMonth) {
      monthLabels.push({ x: labelW + w * slotW, label: m })
      lastMonth = m
    }
  }

  return (
    <svg width={svgW} height={svgH} style={{ display: 'block' }}>
      {/* Day labels */}
      {[1, 3, 5].map(dow => (
        <text key={dow} x={labelW - 3} y={dow * slotW + cell - 4}
          fontSize={8} fill={c.textTer} textAnchor="end">
          {dayLabels[dow]}
        </text>
      ))}
      {/* Cells */}
      {cells.map((cl, i) => (
        <rect key={i} x={cl.x} y={cl.y} width={cell} height={cell} rx={3}
          fill={cl.intensity > 0 ? c.orange : c.bgElevated}
          opacity={cl.intensity > 0 ? 0.2 + cl.intensity * 0.8 : 1}
        />
      ))}
      {/* Month labels */}
      {monthLabels.map(({ x, label }) => (
        <text key={label + x} x={x} y={svgH - 3} fontSize={8} fill={c.textTer}>{label}</text>
      ))}
    </svg>
  )
}

function MiniBarChart({ hourCounts, c }: { hourCounts: Record<number, number>; c: Colors }) {
  const hours = Array.from({ length: 24 }, (_, i) => ({ h: i, v: hourCounts[i] ?? 0 }))
  const max = Math.max(...hours.map(h => h.v), 1)
  const W = 698, H = 90, padB = 18, barArea = H - padB
  const bw = Math.floor((W - 23) / 24)

  return (
    <svg width={W} height={H} style={{ display: 'block' }}>
      {[0.5, 1].map(pct => (
        <line key={pct} x1={0} y1={barArea * (1 - pct)} x2={W} y2={barArea * (1 - pct)}
          stroke={c.border} strokeWidth={0.5} strokeDasharray="2,2" />
      ))}
      {hours.map(({ h, v }) => {
        const barH = (v / max) * (barArea - 2)
        const x = h * (bw + 1)
        return (
          <g key={h}>
            <rect x={x} y={barArea - barH} width={bw} height={Math.max(barH, 0)} rx={2}
              fill={c.orange} opacity={v > 0 ? 0.35 + (v / max) * 0.65 : 0.08} />
            {h % 6 === 0 && (
              <text x={x + bw / 2} y={H - 3} fontSize={8} fill={c.textTer} textAnchor="middle">{h}h</text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

function MiniModelBars({ modelUsage, c, currency, brlRate }: {
  modelUsage: Record<string, ModelUsage>; c: Colors; currency: 'USD' | 'BRL'; brlRate: number
}) {
  const entries = Object.entries(modelUsage)
    .map(([id, u]) => ({ id, cost: calcCost(u, id), tokens: u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens }))
    .sort((a, b) => b.cost - a.cost).slice(0, 6)

  if (entries.length === 0) {
    return <div style={{ color: c.textTer, fontSize: 11, padding: '12px 0' }}>No model data</div>
  }
  const maxCost = Math.max(...entries.map(e => e.cost), 0.001)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {entries.map(({ id, cost, tokens }) => (
        <div key={id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: c.text }}>{formatModel(id)}</span>
            <span style={{ fontSize: 10, color: c.textSec }}>{fmtCost(cost, currency, brlRate)} · {fmt(tokens)} tokens</span>
          </div>
          <div style={{ height: 7, background: c.bgElevated, borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(cost / maxCost) * 100}%`, background: c.orange, borderRadius: 4 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function MiniTagCloud({ data, color, c }: { data: Record<string, number>; color: string; c: Colors }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, 15)
  const max = Math.max(...entries.map(([, v]) => v), 1)
  if (entries.length === 0) return <div style={{ color: c.textTer, fontSize: 11 }}>No data</div>
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
      {entries.map(([name, count]) => {
        const pct = count / max
        return (
          <div key={name} style={{
            padding: '3px 8px', borderRadius: 20,
            background: `${color}18`,
            border: `1px solid ${color}${Math.round((0.2 + pct * 0.4) * 255).toString(16).padStart(2, '0')}`,
            fontSize: 9 + pct * 2, fontWeight: pct > 0.5 ? 600 : 400, color: c.textSec,
            display: 'flex', alignItems: 'center', gap: 4,
          }}>
            {name}<span style={{ opacity: 0.5, fontSize: 8 }}>{count}</span>
          </div>
        )
      })}
    </div>
  )
}

function MiniProjectsList({ projectStats, c, lang }: {
  projectStats: Record<string, { sessions: number; messages: number; tools: number }>
  c: Colors; lang: Lang
}) {
  const entries = Object.entries(projectStats).sort((a, b) => b[1].sessions - a[1].sessions).slice(0, 8)
  if (entries.length === 0) return <div style={{ color: c.textTer, fontSize: 11 }}>No data</div>
  const maxS = Math.max(...entries.map(([, v]) => v.sessions), 1)
  const cols = '1fr 60px 70px 60px'

  return (
    <div style={{ fontSize: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, paddingBottom: 5, borderBottom: `1px solid ${c.border}`, marginBottom: 6 }}>
        {['Projeto', lang === 'pt' ? 'Sessões' : 'Sessions', lang === 'pt' ? 'Mensagens' : 'Messages', 'Tools'].map(h => (
          <div key={h} style={{ fontSize: 8, fontWeight: 600, color: c.textTer, textTransform: 'uppercase' }}>{h}</div>
        ))}
      </div>
      {entries.map(([path, stats]) => (
        <div key={path} style={{ marginBottom: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8, alignItems: 'center', marginBottom: 3 }}>
            <div style={{ color: c.text, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {formatProjectName(path)}
            </div>
            <div style={{ color: c.orange, fontWeight: 600 }}>{stats.sessions}</div>
            <div style={{ color: c.textSec }}>{fmt(stats.messages)}</div>
            <div style={{ color: c.textSec }}>{fmt(stats.tools)}</div>
          </div>
          <div style={{ height: 3, background: c.bgElevated, borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${(stats.sessions / maxS) * 100}%`, background: c.orange, opacity: 0.5, borderRadius: 2 }} />
          </div>
        </div>
      ))}
    </div>
  )
}

function MiniSessionsTable({ sessions, c, lang, currency, brlRate, blendedRates }: {
  sessions: SessionMeta[]; c: Colors; lang: Lang; currency: 'USD' | 'BRL'; brlRate: number
  blendedRates: BlendedRates
}) {
  // The duration column carries "3h 12m ativo · 958h decorrido", so it needs real width.
  const cols = '84px 1fr 150px 40px 40px 62px'
  const headers = [lang === 'pt' ? 'Data' : 'Date', lang === 'pt' ? 'Projeto' : 'Project',
    lang === 'pt' ? 'Dur.' : 'Dur.', 'Msgs', 'Tools', lang === 'pt' ? 'Custo' : 'Cost']
  return (
    <div style={{ fontSize: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 6, paddingBottom: 5, borderBottom: `1px solid ${c.border}`, marginBottom: 4 }}>
        {headers.map(h => <div key={h} style={{ fontWeight: 600, color: c.textTer, fontSize: 8, textTransform: 'uppercase' }}>{h}</div>)}
      </div>
      {sessions.slice(0, 12).map((s, i) => {
        const msgs = (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0)
        const tools = Object.values(s.tool_counts ?? {}).reduce((a, b) => a + b, 0)
        const costUSD = s.model
          ? calcCost({
              inputTokens: s.input_tokens ?? 0,
              outputTokens: s.output_tokens ?? 0,
              cacheReadInputTokens: s.cache_read_input_tokens ?? 0,
              cacheCreationInputTokens: s.cache_creation_input_tokens ?? 0,
              webSearchRequests: 0,
              costUSD: 0,
            }, s.model)
          : blendedSessionCost(s, blendedRates)
        return (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: cols, gap: 6, padding: '4px 0', borderBottom: `1px solid ${c.border}40`, alignItems: 'center' }}>
            <div style={{ color: c.textSec }}>{s.start_time ? format(parseISO(s.start_time), 'MM/dd HH:mm') : '—'}</div>
            <div style={{ color: c.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{formatProjectName(s.project_path || '')}</div>
            <div style={{ color: c.textSec }}>{sessionTime(s, lang).combined}</div>
            <div style={{ color: c.orange, fontWeight: 600 }}>{msgs}</div>
            <div style={{ color: c.textSec }}>{tools}</div>
            <div style={{ color: c.textSec }}>{fmtCost(costUSD, currency, brlRate)}</div>
          </div>
        )
      })}
    </div>
  )
}

function MiniHighlightsSection({ sessions, c, lang }: {
  sessions: SessionMeta[]; c: Colors; lang: Lang
}) {
  const pt = lang === 'pt'
  if (sessions.length === 0) return null

  function fmtDuration(minutes: number): string {
    const h = Math.floor(minutes / 60)
    const m = Math.round(minutes % 60)
    if (h > 0) return `${h}h ${m}m`
    return `${m}m`
  }

  function avg(arr: number[]): number {
    if (arr.length === 0) return 0
    return arr.reduce((a, b) => a + b, 0) / arr.length
  }

  function multiplier(value: number, mean: number): string | null {
    if (mean === 0 || value === 0) return null
    const x = value / mean
    if (x < 1.5) return null
    return `${x.toFixed(1)}× avg`
  }

  // sessions[0] is guaranteed defined because of the sessions.length === 0 guard above
  const firstSession = sessions[0]!
  // Ranked by ACTIVE time (same rule as the dashboard's HighlightsBoard) — wall clock crowns
  // whichever session merely stayed open longest. See lib/sessionTime.ts.
  const anyActive = sessions.some(s => s.active_minutes !== undefined)
  const sessionRank = (s: SessionMeta) =>
    anyActive ? (s.active_minutes ?? -1) : (s.duration_minutes ?? 0)
  const longestSession = sessions.reduce((b, s) => sessionRank(s) > sessionRank(b) ? s : b, firstSession)
  const mostInputTokens = sessions.reduce((b, s) =>
    (s.input_tokens ?? 0) > (b.input_tokens ?? 0) ? s : b, firstSession)
  const mostOutputTokens = sessions.reduce((b, s) =>
    (s.output_tokens ?? 0) > (b.output_tokens ?? 0) ? s : b, firstSession)
  const mostMessages = sessions.reduce((b, s) => {
    const v = (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0)
    const bv = (b.user_message_count ?? 0) + (b.assistant_message_count ?? 0)
    return v > bv ? s : b
  }, firstSession)
  const mostToolCalls = sessions.reduce((b, s) => {
    const v = Object.values(s.tool_counts ?? {}).reduce((a, x) => a + x, 0)
    const bv = Object.values(b.tool_counts ?? {}).reduce((a, x) => a + x, 0)
    return v > bv ? s : b
  }, firstSession)

  const projectSessionCounts: Record<string, number> = {}
  for (const s of sessions) {
    if (s.project_path) projectSessionCounts[s.project_path] = (projectSessionCounts[s.project_path] ?? 0) + 1
  }
  const topProjectEntry = Object.entries(projectSessionCounts).sort((a, b) => b[1] - a[1])[0]

  const avgDuration = avg(sessions
    .map(s => anyActive ? (s.active_minutes ?? 0) : (s.duration_minutes ?? 0))
    .filter(v => v > 0))
  const avgInput    = avg(sessions.map(s => s.input_tokens ?? 0).filter(v => v > 0))
  const avgOutput   = avg(sessions.map(s => s.output_tokens ?? 0).filter(v => v > 0))
  const avgMessages = avg(sessions.map(s => (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0)).filter(v => v > 0))
  const avgTools    = avg(sessions.map(s => Object.values(s.tool_counts ?? {}).reduce((a, b) => a + b, 0)).filter(v => v > 0))

  function truncate(str: string | undefined, len: number) {
    if (!str) return pt ? 'Sem título' : 'Untitled'
    return str.length > len ? str.slice(0, len) + '…' : str
  }

  const records = [
    {
      label: pt ? 'Sessão mais longa' : 'Longest session',
      value: sessionTime(longestSession, pt ? 'pt' : 'en').combined,
      badge: multiplier(sessionRank(longestSession), avgDuration),
      prompt: truncate(sessionLabel(longestSession), 80),
      project: formatProjectName(longestSession.project_path ?? ''),
      accent: '#a855f7',
    },
    {
      label: pt ? 'Mais tokens de entrada' : 'Most input tokens',
      value: fmt(mostInputTokens.input_tokens ?? 0),
      badge: multiplier(mostInputTokens.input_tokens ?? 0, avgInput),
      prompt: truncate(sessionLabel(mostInputTokens), 80),
      project: formatProjectName(mostInputTokens.project_path ?? ''),
      accent: '#3b82f6',
    },
    {
      label: pt ? 'Mais tokens de saída' : 'Most output tokens',
      value: fmt(mostOutputTokens.output_tokens ?? 0),
      badge: multiplier(mostOutputTokens.output_tokens ?? 0, avgOutput),
      prompt: truncate(sessionLabel(mostOutputTokens), 80),
      project: formatProjectName(mostOutputTokens.project_path ?? ''),
      accent: '#8b5cf6',
    },
    {
      label: pt ? 'Mais mensagens' : 'Most messages',
      value: fmt((mostMessages.user_message_count ?? 0) + (mostMessages.assistant_message_count ?? 0)),
      badge: multiplier((mostMessages.user_message_count ?? 0) + (mostMessages.assistant_message_count ?? 0), avgMessages),
      prompt: truncate(sessionLabel(mostMessages), 80),
      project: formatProjectName(mostMessages.project_path ?? ''),
      accent: '#e8690b',
    },
    {
      label: pt ? 'Mais chamadas de ferramentas' : 'Most tool calls',
      value: fmt(Object.values(mostToolCalls.tool_counts ?? {}).reduce((a, b) => a + b, 0)),
      badge: multiplier(Object.values(mostToolCalls.tool_counts ?? {}).reduce((a, b) => a + b, 0), avgTools),
      prompt: truncate(sessionLabel(mostToolCalls), 80),
      project: formatProjectName(mostToolCalls.project_path ?? ''),
      accent: '#10b981',
    },
    ...(topProjectEntry ? [{
      label: pt ? 'Projeto mais ativo' : 'Most active project',
      value: `${topProjectEntry[1]} ${pt ? 'sessões' : 'sessions'}`,
      badge: `${Math.round((topProjectEntry[1] / sessions.length) * 100)}% ${pt ? 'do período' : 'of period'}`,
      prompt: formatProjectName(topProjectEntry[0]),
      project: topProjectEntry[0],
      accent: '#06b6d4',
    }] : []),
  ]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
      {records.map((r, i) => (
        <div key={i} style={{
          background: c.bgCard,
          border: `1px solid ${c.border}`,
          borderRadius: 8,
          padding: '12px 14px',
          borderLeft: `3px solid ${r.accent}`,
          position: 'relative',
          overflow: 'hidden',
        }}>
          <div style={{ fontSize: 8, fontWeight: 700, color: c.textTer, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6 }}>
            {r.label}
          </div>
          <div style={{ fontSize: 24, fontWeight: 800, color: r.accent, lineHeight: 1, letterSpacing: '-0.02em', marginBottom: 4 }}>
            {r.value}
          </div>
          {r.badge && (
            <div style={{
              display: 'inline-flex', alignItems: 'center',
              fontSize: 8, fontWeight: 600, color: r.accent,
              background: `${r.accent}18`, border: `1px solid ${r.accent}30`,
              borderRadius: 20, padding: '2px 6px', marginBottom: 8,
            }}>
              {r.badge}
            </div>
          )}
          {!r.badge && <div style={{ marginBottom: 8 }} />}
          <div style={{ height: 1, background: c.border, marginBottom: 8 }} />
          <div style={{ fontSize: 9, color: c.textSec, fontStyle: 'italic', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' } as React.CSSProperties}>
            "{r.prompt}"
          </div>
          <div style={{ fontSize: 9, color: c.textTer, marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.project}
          </div>
        </div>
      ))}
    </div>
  )
}

// Standalone PDF generation (used by PDFDirectExporter and ExportPage)

export async function runPDFCapture(el: HTMLElement, pdfTheme: PDFTheme, filename?: string): Promise<void> {
  const resolvedFilename = filename ?? `claude-stats-${format(new Date(), 'yyyy-MM-dd')}.pdf`
  const html2canvas = (await import('html2canvas')).default
  const { jsPDF } = await import('jspdf')

  const offscreen = document.createElement('div')
  offscreen.style.cssText = `position:fixed;left:-9999px;top:0;width:794px;background:${COLORS[pdfTheme].bg};pointer-events:none;z-index:-1;`
  const clone = el.cloneNode(true) as HTMLElement
  offscreen.appendChild(clone)
  document.body.appendChild(offscreen)

  const canvas = await html2canvas(clone, {
    scale: 2, useCORS: true, logging: false,
    backgroundColor: COLORS[pdfTheme].bg,
    windowWidth: 794,
  })

  document.body.removeChild(offscreen)

  const A4_W = 210, A4_H = 297
  const pxPerMm = canvas.width / A4_W
  const totalH_mm = canvas.height / pxPerMm

  if (totalH_mm <= A4_H) {
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: [A4_W, totalH_mm] })
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, A4_W, totalH_mm)
    pdf.save(resolvedFilename)
  } else {
    const pageH_px = Math.round(A4_H * pxPerMm)
    const totalPages = Math.ceil(canvas.height / pageH_px)
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    for (let page = 0; page < totalPages; page++) {
      const startY = page * pageH_px
      const sliceH_px = Math.min(pageH_px, canvas.height - startY)
      const sliceH_mm = sliceH_px / pxPerMm
      const slice = document.createElement('canvas')
      slice.width = canvas.width
      slice.height = sliceH_px
      const ctx = slice.getContext('2d')!
      ctx.fillStyle = COLORS[pdfTheme].bg
      ctx.fillRect(0, 0, slice.width, slice.height)
      ctx.drawImage(canvas, 0, startY, canvas.width, sliceH_px, 0, 0, canvas.width, sliceH_px)
      if (page > 0) pdf.addPage()
      if (sliceH_mm < A4_H) {
        const padded = document.createElement('canvas')
        padded.width = canvas.width
        padded.height = pageH_px
        const pCtx = padded.getContext('2d')!
        pCtx.fillStyle = COLORS[pdfTheme].bg
        pCtx.fillRect(0, 0, padded.width, padded.height)
        pCtx.drawImage(slice, 0, 0)
        pdf.addImage(padded.toDataURL('image/png'), 'PNG', 0, 0, A4_W, A4_H)
      } else {
        pdf.addImage(slice.toDataURL('image/png'), 'PNG', 0, 0, A4_W, sliceH_mm)
      }
    }
    pdf.save(resolvedFilename)
  }
}

// Direct PDF export (no modal) — renders content offscreen and downloads

export interface PDFDirectExporterProps {
  data: AppData
  range: string
  currentFilters: Filters
  lang: Lang
  currency: 'USD' | 'BRL'
  brlRate: number
  onDone: () => void
}

export function PDFDirectExporter({ data, range, currentFilters, lang, currency, brlRate, onDone }: PDFDirectExporterProps) {
  const pdfFilters: Filters = {
    ...currentFilters,
    dateRange: (range === '7d' || range === '30d' || range === '90d') ? range : 'all',
    customStart: '',
    customEnd: '',
  }
  const pdfTheme: PDFTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  const derived = useDerivedStats(data, pdfFilters)
  const blendedRates = useMemo(
    () => blendedCostPerToken(derived?.modelUsage ?? data.statsCache.modelUsage ?? {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [derived?.modelUsage, data.statsCache.modelUsage],
  )
  const pdfFilename = useMemo(() => {
    const h = currentFilters.harness
    const dateStr = format(new Date(), 'yyyy-MM-dd')
    if (h && h !== 'claude') return `${h}-stats-${dateStr}.pdf`
    return `claude-stats-${dateStr}.pdf`
  }, [currentFilters.harness])
  const contentRef = useRef<HTMLDivElement>(null)
  const [logoDataUri, setLogoDataUri] = useState<string>('/logo.png')
  const triggered = useRef(false)

  useEffect(() => {
    fetch('/logo.png')
      .then(r => r.blob())
      .then(blob => new Promise<string>(resolve => {
        const reader = new FileReader()
        reader.onloadend = () => resolve(reader.result as string)
        reader.readAsDataURL(blob)
      }))
      .then(setLogoDataUri)
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!contentRef.current || !derived || triggered.current) return
    triggered.current = true
    runPDFCapture(contentRef.current, pdfTheme, pdfFilename)
      .catch(err => console.error('PDF direct export failed:', err))
      .finally(onDone)
  }, [derived, logoDataUri])

  return (
    <div style={{ position: 'fixed', left: -9999, top: 0, width: 794, pointerEvents: 'none', zIndex: -1 }}>
      <div ref={contentRef}>
        <PDFContent
          pdfTheme={pdfTheme}
          sectionOrder={['summary', 'activity', 'heatmap', 'hours', 'models', 'projects', 'tools']}
          derived={derived}
          pdfFilters={pdfFilters}
          lang={lang}
          currency={currency}
          brlRate={brlRate}
          blendedRates={blendedRates}
          chartMetric="messages"
          chartOverlay={null}
          chartOverlayAll={false}
          logoDataUri={logoDataUri}
        />
      </div>
    </div>
  )
}

// Compare section — rendered INSIDE the unified report when the "compare"
// section is enabled. Content mirrors the harness-comparison view (overview
// cards, comparison table, usage by hour/dow, activity, peaks, cost by model)
// but as one section among others, not a standalone whole-page mode. Always
// fed the same filtered summaries as the rest of the report (see ExportPage).

function CompareSectionContent({ summaries, harnesses, c, pt, currency, brlRate }: {
  summaries: Record<HarnessId, HarnessSummary>
  harnesses: HarnessId[]
  c: Colors
  pt: boolean
  currency: 'USD' | 'BRL'
  brlRate: number
}) {
  const fmtCostInline = (usd: number): string => fmtCost(usd, currency, brlRate)

  const fmtDate = (raw: string | null | undefined): string => {
    if (!raw) return '—'
    const d = new Date(raw)
    if (isNaN(d.getTime())) return '—'
    return format(d, pt ? 'dd/MM/yyyy' : 'MMM d, yyyy')
  }

  // Shared time axis for sparklines
  let minMs = Infinity, maxMs = -Infinity
  for (const h of harnesses) {
    for (const d of summaries[h]?.dailyActivity ?? []) {
      const ts = new Date(d.date).getTime()
      if (Number.isNaN(ts)) continue
      if (ts < minMs) minMs = ts
      if (ts > maxMs) maxMs = ts
    }
  }
  if (minMs === Infinity) minMs = 0
  if (maxMs === -Infinity) maxMs = 0

  // Per-harness bar chart SVG (inline, CSS-var-free for html2canvas)
  const renderMiniBar = (values: number[], color: string, peakIndex: number | null, svgWidth: number, height = 28) => {
    const max = Math.max(...values, 1)
    const n = values.length
    const bw = Math.max(1, Math.floor((svgWidth - n) / n))
    return (
      <svg width={svgWidth} height={height} style={{ display: 'block' }}>
        {values.map((v, i) => {
          const barH = max > 0 ? Math.max((v / max) * (height - 2), v > 0 ? 2 : 0) : 0
          const isPeak = i === peakIndex
          return (
            <rect
              key={i}
              x={i * (bw + 1)}
              y={height - barH}
              width={bw}
              height={barH}
              rx={1}
              fill={color}
              opacity={isPeak ? 1 : 0.4}
            />
          )
        })}
      </svg>
    )
  }

  // Content area: 698px (matches the rest of the report)
  const CONTENT_W = 698
  const colBarW = Math.floor((CONTENT_W - 16 * (harnesses.length - 1)) / Math.max(1, harnesses.length))

  const dayLabels = pt
    ? ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  const SubTitle = ({ title }: { title: string }) => (
    <div style={{ fontSize: 9, fontWeight: 700, color: c.textSec, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
      {title}
    </div>
  )

  return (
    <div>
      {/* Harness overview cards */}
      <div style={{ marginBottom: 20 }}>
        <SubTitle title={pt ? 'Visão geral' : 'Overview'} />
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${harnesses.length}, 1fr)`, gap: 12 }}>
          {harnesses.map(h => {
            const s = summaries[h]
            const hColor = HARNESS_COLORS[h]
            return (
              <div key={h} style={{
                background: c.bgCard, border: `1px solid ${c.border}`,
                borderRadius: 8, padding: '12px 14px', borderTop: `3px solid ${hColor}`,
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: hColor, marginBottom: 8 }}>
                  {HARNESS_LABELS[h]}
                </div>
                <div style={{ fontSize: 22, fontWeight: 800, color: c.text, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
                  {fmt(s?.sessions ?? 0)}
                </div>
                <div style={{ fontSize: 9, color: c.textSec, marginTop: 2 }}>{pt ? 'sessões' : 'sessions'}</div>
                <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  <div>
                    <div style={{ fontSize: 8, color: c.textTer, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{pt ? 'Mensagens' : 'Messages'}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: c.text }}>{fmt(s?.messages ?? 0)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: 8, color: c.textTer, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{pt ? 'Tokens' : 'Tokens'}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: capable(h, 'tokens') ? c.blue : c.textTer }}>
                      {capable(h, 'tokens') ? fmt(totalTokens(s?.tokens ?? EMPTY_TOKENS)) : 'N/A'}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 8, color: c.textTer, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{pt ? 'Custo' : 'Cost'}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: capable(h, 'cost') ? c.orange : c.textTer }}>
                      {capable(h, 'cost') ? fmtCostInline(s?.costUSD ?? 0) : 'N/A'}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 8, color: c.textTer, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{pt ? '/ 1M tok' : '/ 1M tok'}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: (capable(h, 'cost') && capable(h, 'tokens')) ? c.green : c.textTer }}>
                      {(capable(h, 'cost') && capable(h, 'tokens') && s?.costPerMTokens != null)
                        ? fmtCostInline(s.costPerMTokens)
                        : 'N/A'}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Comparison table */}
      <div style={{ marginBottom: 20 }}>
        <SubTitle title={pt ? 'Tabela comparativa' : 'Comparison table'} />
        {[
          { label: pt ? 'Sessões' : 'Sessions', getValue: (h: HarnessId) => ({ val: fmt(summaries[h]?.sessions ?? 0), na: false }) },
          { label: pt ? 'Mensagens' : 'Messages', getValue: (h: HarnessId) => ({ val: fmt(summaries[h]?.messages ?? 0), na: false }) },
          { label: pt ? 'Total de tokens' : 'Total tokens', getValue: (h: HarnessId) => capable(h, 'tokens') ? { val: fmt(totalTokens(summaries[h]?.tokens ?? EMPTY_TOKENS)), na: false } : { val: 'N/A', na: true } },
          { label: pt ? 'Custo estimado' : 'Estimated cost', getValue: (h: HarnessId) => capable(h, 'cost') ? { val: fmtCostInline(summaries[h]?.costUSD ?? 0), na: false } : { val: 'N/A', na: true } },
          { label: pt ? 'Custo / 1M tokens' : 'Cost / 1M tokens', getValue: (h: HarnessId) => (capable(h, 'cost') && capable(h, 'tokens') && summaries[h]?.costPerMTokens != null) ? { val: `${fmtCostInline(summaries[h]!.costPerMTokens!)}`, na: false } : { val: 'N/A', na: true } },
        ].map(row => (
          <div key={row.label} style={{
            display: 'grid',
            gridTemplateColumns: `140px ${harnesses.map(() => '1fr').join(' ')}`,
            gap: 8, padding: '8px 0', borderBottom: `1px solid ${c.border}40`,
          }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: c.textSec }}>{row.label}</div>
            {harnesses.map(h => {
              const { val, na } = row.getValue(h)
              return (
                <div key={h} style={{ fontSize: 12, fontWeight: 700, color: na ? c.textTer : c.text }}>
                  {val}
                </div>
              )
            })}
          </div>
        ))}
      </div>

      {/* Usage by hour of day */}
      <div style={{ marginBottom: 20 }}>
        <SubTitle title={pt ? 'Uso por hora do dia' : 'Usage by hour of day'} />
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${harnesses.length}, 1fr)`, gap: 16 }}>
          {harnesses.map(h => {
            const s = summaries[h]
            const hColor = HARNESS_COLORS[h]
            const totalMsgs = s?.hourCounts.reduce((a, v) => a + v, 0) ?? 0
            return (
              <div key={h}>
                <div style={{ fontSize: 9, fontWeight: 700, color: hColor, marginBottom: 6 }}>
                  {HARNESS_LABELS[h]}
                  {s?.peakHour != null && (
                    <span style={{ fontWeight: 400, color: c.textTer, marginLeft: 6 }}>
                      {pt ? `Pico ${String(s.peakHour).padStart(2, '0')}:00` : `Peak ${String(s.peakHour).padStart(2, '0')}:00`}
                    </span>
                  )}
                </div>
                {totalMsgs === 0 ? (
                  <div style={{ height: 28, display: 'flex', alignItems: 'center', fontSize: 9, color: c.textTer }}>N/A</div>
                ) : renderMiniBar(s?.hourCounts ?? Array(24).fill(0), hColor, s?.peakHour ?? null, colBarW, 28)}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
                  <span style={{ fontSize: 7, color: c.textTer }}>0h</span>
                  <span style={{ fontSize: 7, color: c.textTer }}>12h</span>
                  <span style={{ fontSize: 7, color: c.textTer }}>23h</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Busiest day of week */}
      <div style={{ marginBottom: 20 }}>
        <SubTitle title={pt ? 'Dia da semana mais movimentado' : 'Busiest day of week'} />
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${harnesses.length}, 1fr)`, gap: 16 }}>
          {harnesses.map(h => {
            const s = summaries[h]
            const hColor = HARNESS_COLORS[h]
            const hasData = s && s.dowCounts.some(v => v > 0)
            return (
              <div key={h}>
                <div style={{ fontSize: 9, fontWeight: 700, color: hColor, marginBottom: 6 }}>
                  {HARNESS_LABELS[h]}
                  {s?.peakDow != null && (
                    <span style={{ fontWeight: 400, color: c.textTer, marginLeft: 6 }}>
                      {pt ? `Pico: ${dayLabels[s.peakDow]}` : `Peak: ${dayLabels[s.peakDow]}`}
                    </span>
                  )}
                </div>
                {!hasData ? (
                  <div style={{ height: 28, display: 'flex', alignItems: 'center', fontSize: 9, color: c.textTer }}>N/A</div>
                ) : renderMiniBar(s?.dowCounts ?? Array(7).fill(0), hColor, s?.peakDow ?? null, colBarW, 28)}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
                  {dayLabels.map((d, i) => (
                    <span key={i} style={{ fontSize: 7, color: i === s?.peakDow ? hColor : c.textTer, fontWeight: i === s?.peakDow ? 700 : 400 }}>
                      {d.slice(0, 1)}
                    </span>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Activity over time */}
      <div style={{ marginBottom: 20 }}>
        <SubTitle title={pt ? 'Atividade ao longo do tempo' : 'Activity over time'} />
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${harnesses.length}, 1fr)`, gap: 16 }}>
          {harnesses.map(h => {
            const s = summaries[h]
            const hColor = HARNESS_COLORS[h]
            const daily = s?.dailyActivity ?? []
            const BUCKETS = 40
            const bkts = bucketize(daily, minMs, maxMs, BUCKETS)
            const bkMax = Math.max(...bkts, 1)
            const bw = Math.max(1, Math.floor((colBarW - BUCKETS) / BUCKETS))
            return (
              <div key={h}>
                <div style={{ fontSize: 9, fontWeight: 700, color: hColor, marginBottom: 6 }}>
                  {HARNESS_LABELS[h]}
                </div>
                {daily.length === 0 ? (
                  <div style={{ height: 28, display: 'flex', alignItems: 'center', fontSize: 9, color: c.textTer }}>
                    {pt ? 'Sem dados' : 'No data'}
                  </div>
                ) : (
                  <svg width={colBarW} height={28} style={{ display: 'block' }}>
                    {bkts.map((v, i) => {
                      const barH = v > 0 ? Math.max((v / bkMax) * 24, 3) : 0
                      return <rect key={i} x={i * (bw + 1)} y={28 - barH} width={bw} height={barH} rx={1} fill={hColor} opacity={0.75} />
                    })}
                  </svg>
                )}
                <div style={{ fontSize: 7, color: c.textTer, marginTop: 2 }}>
                  {daily.length > 0
                    ? `${fmtDate(daily[0]?.date)} – ${fmtDate(daily[daily.length - 1]?.date)}`
                    : ''}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Peaks table */}
      <div style={{ marginBottom: 20 }}>
        <SubTitle title={pt ? 'Picos' : 'Peaks'} />
        {[
          {
            label: pt ? 'Dia de maior uso de tokens' : 'Busiest token day',
            getValue: (h: HarnessId) => {
              if (!capable(h, 'tokens')) return { val: 'N/A', na: true }
              const ptd = summaries[h]?.peakTokenDay
              if (!ptd) return { val: '—', na: false }
              return { val: `${fmt(ptd.tokens)} (${fmtDate(ptd.date)})`, na: false }
            },
          },
          {
            label: pt ? 'Maior custo de sessão' : 'Peak session cost',
            getValue: (h: HarnessId) => {
              if (!capable(h, 'cost')) return { val: 'N/A', na: true }
              const psc = summaries[h]?.peakSessionCost
              if (psc == null) return { val: '—', na: false }
              return { val: fmtCostInline(psc), na: false }
            },
          },
        ].map(row => (
          <div key={row.label} style={{
            display: 'grid',
            gridTemplateColumns: `140px ${harnesses.map(() => '1fr').join(' ')}`,
            gap: 8, padding: '8px 0', borderBottom: `1px solid ${c.border}40`,
          }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: c.textSec }}>{row.label}</div>
            {harnesses.map(h => {
              const { val, na } = row.getValue(h)
              return (
                <div key={h} style={{ fontSize: 12, fontWeight: 700, color: na ? c.textTer : c.text }}>
                  {val}
                </div>
              )
            })}
          </div>
        ))}
      </div>

      {/* Cost by model */}
      <div>
        <SubTitle title={pt ? 'Custo por modelo' : 'Cost by model'} />
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${harnesses.length}, 1fr)`, gap: 16 }}>
          {harnesses.map(h => {
            const hColor = HARNESS_COLORS[h]
            const s = summaries[h]
            const showModels = capable(h, 'cost') && capable(h, 'model')
            const models = showModels ? (s?.models ?? []).slice(0, 5) : []
            return (
              <div key={h}>
                <div style={{ fontSize: 9, fontWeight: 700, color: hColor, marginBottom: 6 }}>
                  {HARNESS_LABELS[h]}
                </div>
                {!showModels ? (
                  <div style={{ fontSize: 9, color: c.textTer }}>N/A</div>
                ) : models.length === 0 ? (
                  <div style={{ fontSize: 9, color: c.textTer }}>{pt ? 'Sem dados' : 'No data'}</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {models.map(m => {
                      const totalTok = totalTokens(m.tokens)
                      const maxTok = Math.max(...models.map(x => totalTokens(x.tokens)), 1)
                      return (
                        <div key={m.model}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                            <span style={{ fontSize: 8, fontWeight: 600, color: c.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>{formatModel(m.model)}</span>
                            <span style={{ fontSize: 8, color: c.orange, fontWeight: 600 }}>{fmtCostInline(m.costUSD)}</span>
                          </div>
                          <div style={{ height: 4, background: c.bgElevated, borderRadius: 2, overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${Math.round((totalTok / maxTok) * 100)}%`, background: hColor, opacity: 0.6, borderRadius: 2 }} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// PDF Content (the exportable A4 page, 794px wide)

export interface PDFContentProps {
  pdfTheme: PDFTheme
  sectionOrder: SectionId[]
  derived: ReturnType<typeof useDerivedStats>
  pdfFilters: Filters
  lang: Lang
  currency: 'USD' | 'BRL'
  brlRate: number
  blendedRates: BlendedRates
  chartMetric: ChartMetric
  chartOverlay: ChartMetric | null
  chartOverlayAll: boolean
  logoDataUri: string
  /** Per-harness comparison summaries, scoped by the same filters as the rest of the
   *  report. Only used when the 'compare' section is enabled; omit/undefined otherwise. */
  compareSummaries?: Record<HarnessId, HarnessSummary>
  /** Harness columns to show in the compare section (already filtered/ordered). */
  compareHarnesses?: HarnessId[]
}

export function PDFContent({ pdfTheme, sectionOrder, derived, pdfFilters, lang, currency, brlRate, blendedRates, chartMetric, chartOverlay, chartOverlayAll, logoDataUri, compareSummaries, compareHarnesses }: PDFContentProps) {
  if (!derived) return null
  const c = COLORS[pdfTheme]
  const pt = lang === 'pt'

  const periodLabel = (() => {
    if (pdfFilters.dateRange === 'all') return pt ? 'Todos os dados' : 'All time'
    if (pdfFilters.dateRange === '7d') return pt ? 'Últimos 7 dias' : 'Last 7 days'
    if (pdfFilters.dateRange === '30d') return pt ? 'Últimos 30 dias' : 'Last 30 days'
    if (pdfFilters.dateRange === '90d') return pt ? 'Últimos 90 dias' : 'Last 90 days'
    return `${pdfFilters.customStart} → ${pdfFilters.customEnd}`
  })()

  const modelLabel = pdfFilters.models && pdfFilters.models.length > 0
    ? pdfFilters.models.length === 1 ? formatModel(pdfFilters.models[0]!) : `${pdfFilters.models.length} models`
    : null

  // Scope labels for the report header — so a repo/project-filtered PDF says what it covers.
  const repoLabel = pdfFilters.repos && pdfFilters.repos.length > 0
    ? pdfFilters.repos.length === 1
      ? (pdfFilters.repos[0] === '' ? (pt ? 'Sem repositório' : 'No repository') : repoShortName(pdfFilters.repos[0]!))
      : `${pdfFilters.repos.length} ${pt ? 'repositórios' : 'repos'}`
    : null
  const projectLabel = pdfFilters.projects && pdfFilters.projects.length > 0
    ? pdfFilters.projects.length === 1 ? formatProjectName(pdfFilters.projects[0]!) : `${pdfFilters.projects.length} ${pt ? 'projetos' : 'projects'}`
    : null

  // Harness-aware title: use the harness label when filtered to a specific harness,
  // otherwise fall back to the neutral 'agentistics' brand name.
  const harnessTitle = pdfFilters.harness
    ? HARNESS_LABELS[pdfFilters.harness]
    : 'agentistics'

  return (
    <div style={{
      width: 794, background: c.bg,
      fontFamily: 'Arial, "Helvetica Neue", Helvetica, sans-serif',
      padding: '40px 48px', boxSizing: 'border-box', color: c.text,
    }}>
      {/* Header */}
      <div style={{ marginBottom: 28, paddingBottom: 20, borderBottom: `2px solid ${c.orange}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
          <img
            src={logoDataUri}
            alt="agentistics"
            style={{ width: 36, height: 36, borderRadius: 10, flexShrink: 0, objectFit: 'contain' }}
          />
          <div>
            <div style={{ fontSize: 20, fontWeight: 700, color: c.text, lineHeight: 1 }}>{harnessTitle}</div>
            <div style={{ fontSize: 11, color: c.textSec, marginTop: 3 }}>
              {pt ? 'Relatório de uso' : 'Usage Report'} · {periodLabel}
              {repoLabel && ` · ${repoLabel}`}
              {projectLabel && ` · ${projectLabel}`}
              {modelLabel && ` · ${modelLabel}`}
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ textAlign: 'right', fontSize: 10, color: c.textTer }}>
            <div>{pt ? 'Gerado em' : 'Generated on'}</div>
            <div style={{ fontWeight: 600, color: c.textSec }}>{format(new Date(), 'dd/MM/yyyy HH:mm')}</div>
          </div>
        </div>
      </div>

      {sectionOrder.map(id => {
        switch (id) {
          case 'summary': return (
            <div key="summary" style={{ marginBottom: 28 }}>
              <SectionTitle title={pt ? 'Resumo' : 'Summary'} c={c} />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 10 }}>
                <KPICard label={pt ? 'Mensagens' : 'Messages'} value={fmt(derived.totalMessages)} sub={pt ? 'no período' : 'in period'} accent={c.orange} c={c} />
                <KPICard label={pt ? 'Sessões' : 'Sessions'} value={fmt(derived.totalSessions)} sub={`avg ${derived.totalSessions > 0 ? Math.round(derived.totalMessages / derived.totalSessions) : 0} msgs`} accent={c.blue} c={c} />
                <KPICard label="Tool calls" value={fmt(derived.totalToolCalls)} sub={pt ? 'execuções' : 'executions'} accent={c.green} c={c} />
                <KPICard label={pt ? 'Custo est.' : 'Est. cost'} value={fmtCost(derived.totalCostUSD, currency, brlRate)} sub="Anthropic pricing" accent={c.orange} c={c} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
                <KPICard label={pt ? 'Sequência' : 'Streak'} value={`${derived.streak}d`} sub={pt ? 'dias consec.' : 'consecutive'} accent={c.red} c={c} />
                <KPICard label={pt ? 'Sessão mais longa' : 'Longest session'}
                  value={derived.longestSession ? (sessionTime(derived.longestSession, pt ? 'pt' : 'en').active ?? sessionTime(derived.longestSession, pt ? 'pt' : 'en').elapsed) : '—'}
                  sub={derived.longestSession ? `${sessionTime(derived.longestSession, pt ? 'pt' : 'en').elapsed} ${pt ? 'decorrido' : 'elapsed'}` : ''}
                  accent={c.purple} c={c} />
                <KPICard label="Commits" value={fmt(derived.gitCommits)} sub={derived.gitPushes > 0 ? `${fmt(derived.gitPushes)} pushes` : `via ${harnessTitle}`} accent={c.cyan} c={c} />
                <KPICard label={pt ? 'Arquivos' : 'Files'} value={fmt(derived.filesModified)} sub={`+${fmt(derived.linesAdded)} / -${fmt(derived.linesRemoved)}`} accent={c.green} c={c} />
              </div>
            </div>
          )
          case 'activity': return (
            <div key="activity" style={{ marginBottom: 28 }}>
              <SectionTitle title={pt ? 'Atividade ao longo do tempo' : 'Activity over time'} c={c} />
              <MiniLineChart data={derived.heatmapData} c={c} metric={chartMetric} overlay={chartOverlayAll ? null : chartOverlay} overlayAll={chartOverlayAll} />
            </div>
          )
          case 'heatmap': return (
            <div key="heatmap" style={{ marginBottom: 28 }}>
              <SectionTitle title={pt ? 'Mapa de calor (26 semanas)' : 'Activity heatmap (26 weeks)'} c={c} />
              <MiniHeatmap data={derived.heatmapData} c={c} />
            </div>
          )
          case 'hours': return (
            <div key="hours" style={{ marginBottom: 28 }}>
              <SectionTitle title={pt ? 'Uso por hora do dia' : 'Usage by hour of day'} c={c} />
              <MiniBarChart hourCounts={derived.hourCounts} c={c} />
            </div>
          )
          case 'models': return (
            <div key="models" style={{ marginBottom: 28 }}>
              <SectionTitle title={pt ? 'Uso por modelo' : 'Model usage & cost'} c={c} />
              <MiniModelBars modelUsage={derived.modelUsage} c={c} currency={currency} brlRate={brlRate} />
            </div>
          )
          case 'projects': return (
            <div key="projects" style={{ marginBottom: 28 }}>
              <SectionTitle title={pt ? 'Principais projetos' : 'Top projects'} c={c} />
              <MiniProjectsList projectStats={derived.projectStats} c={c} lang={lang} />
            </div>
          )
          case 'tools': return (
            <div key="tools" style={{ marginBottom: 28 }}>
              <SectionTitle title={pt ? 'Ferramentas e linguagens' : 'Tools & languages'} c={c} />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: c.textSec, marginBottom: 8 }}>{pt ? 'Ferramentas mais usadas' : 'Most used tools'}</div>
                  <MiniTagCloud data={derived.toolCounts} color={c.green} c={c} />
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: c.textSec, marginBottom: 8 }}>{pt ? 'Linguagens' : 'Languages'}</div>
                  <MiniTagCloud data={derived.langCounts} color={c.blue} c={c} />
                </div>
              </div>
            </div>
          )
          case 'sessions': return (
            <div key="sessions" style={{ marginBottom: 28 }}>
              <SectionTitle title={pt ? 'Sessões recentes (top 12)' : 'Recent sessions (top 12)'} c={c} />
              <MiniSessionsTable
                sessions={[...derived.filteredSessions].sort((a, b) => (b.start_time ?? '').localeCompare(a.start_time ?? '')).slice(0, 12)}
                c={c} lang={lang} currency={currency} brlRate={brlRate}
                blendedRates={blendedRates}
              />
            </div>
          )
          case 'highlights': return (
            <div key="highlights" style={{ marginBottom: 28 }}>
              <SectionTitle title={pt ? 'Recordes do período' : 'Period highlights'} c={c} />
              <MiniHighlightsSection sessions={derived.filteredSessions} c={c} lang={lang} />
            </div>
          )
          case 'agents': return (
            <div key="agents" style={{ marginBottom: 28 }}>
              <SectionTitle title={pt ? 'Métricas de agentes' : 'Agent metrics'} c={c} />
              {derived.totalAgentInvocations === 0 ? (
                <div style={{ fontSize: 10, color: c.textTer, fontStyle: 'italic', padding: '12px 0' }}>
                  {pt ? 'Nenhuma invocação de agente encontrada no período.' : 'No agent invocations found in this period.'}
                </div>
              ) : (
                <>
                  {/* Summary KPI row */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
                    <KPICard label={pt ? 'Invocações' : 'Invocations'} value={fmt(derived.totalAgentInvocations)} sub={pt ? 'total de agentes' : 'total agent calls'} accent={c.purple} c={c} />
                    <KPICard label={pt ? 'Tokens agentes' : 'Agent tokens'} value={fmt(derived.totalAgentTokens)} sub={`avg ${fmt(Math.round(derived.totalAgentTokens / Math.max(1, derived.totalAgentInvocations)))} / call`} accent={c.blue} c={c} />
                    <KPICard label={pt ? 'Custo agentes' : 'Agent cost'} value={fmtCost(derived.totalAgentCostUSD, currency, brlRate)} sub="Anthropic pricing" accent={c.orange} c={c} />
                    <KPICard label={pt ? 'Dur. média' : 'Avg duration'} value={(() => { const ms = derived.totalAgentDurationMs / Math.max(1, derived.totalAgentInvocations); const s = Math.round(ms/1000); return s < 60 ? `${s}s` : `${Math.floor(s/60)}m ${s%60}s` })()} sub={pt ? 'por invocação' : 'per invocation'} accent={c.green} c={c} />
                  </div>
                  {/* Agent type breakdown */}
                  {Object.keys(derived.agentTypeBreakdown).length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 9, fontWeight: 700, color: c.textSec, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                        {pt ? 'Por tipo de agente' : 'By agent type'}
                      </div>
                      {Object.entries(derived.agentTypeBreakdown)
                        .sort((a, b) => b[1].count - a[1].count)
                        .map(([type, stats]) => {
                          const maxC = Math.max(...Object.values(derived.agentTypeBreakdown).map(s => s.count))
                          return (
                            <div key={type} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 50px 80px 80px', gap: 8, alignItems: 'center', marginBottom: 5 }}>
                              <div style={{ fontSize: 9, fontWeight: 600, color: c.purple, background: `${c.purple}20`, borderRadius: 8, padding: '2px 7px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {type}
                              </div>
                              <div style={{ position: 'relative', height: 5, background: c.bgElevated, borderRadius: 3, overflow: 'hidden' }}>
                                <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(stats.count / maxC) * 100}%`, background: c.purple, borderRadius: 3, opacity: 0.6 }} />
                              </div>
                              <span style={{ fontSize: 9, color: c.text, fontWeight: 700, textAlign: 'right' }}>{stats.count}×</span>
                              <span style={{ fontSize: 9, color: c.textSec, textAlign: 'right' }}>{fmt(stats.tokens)} tok</span>
                              <span style={{ fontSize: 9, color: c.orange, textAlign: 'right' }}>{fmtCost(stats.costUSD, currency, brlRate)}</span>
                            </div>
                          )
                        })}
                    </div>
                  )}
                  {/* Top 8 invocations */}
                  <div style={{ fontSize: 9, fontWeight: 700, color: c.textSec, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    {pt ? 'Invocações recentes (top 8)' : 'Recent invocations (top 8)'}
                  </div>
                  <div style={{ border: `1px solid ${c.border}`, borderRadius: 6, overflow: 'hidden' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr 55px 55px 70px', gap: 8, padding: '5px 10px', background: c.bgElevated, fontSize: 8, fontWeight: 700, color: c.textTer, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      <span>{pt ? 'Tipo' : 'Type'}</span><span>{pt ? 'Descrição' : 'Description'}</span>
                      <span style={{ textAlign: 'right' }}>Tokens</span>
                      <span style={{ textAlign: 'right' }}>{pt ? 'Dur.' : 'Dur.'}</span>
                      <span style={{ textAlign: 'right' }}>{pt ? 'Custo' : 'Cost'}</span>
                    </div>
                    {derived.agentInvocations.slice(0, 8).map((inv, i) => (
                      <div key={inv.toolUseId || i} style={{ display: 'grid', gridTemplateColumns: '130px 1fr 55px 55px 70px', gap: 8, padding: '5px 10px', borderTop: `1px solid ${c.border}`, background: i % 2 === 0 ? 'transparent' : c.bgCard }}>
                        <span style={{ fontSize: 8, fontWeight: 600, color: c.purple, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inv.agentType}</span>
                        <span style={{ fontSize: 8, color: c.textSec, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inv.description || '—'}</span>
                        {/* An invocation nothing could measure prints a dash. A PDF is read away
                            from the app, so a zero here is a wrong number with nothing beside it to
                            question. */}
                        <span style={{ fontSize: 8, color: c.text, textAlign: 'right' }}>{inv.totalTokens === null ? '—' : fmt(inv.totalTokens)}</span>
                        <span style={{ fontSize: 8, color: c.textSec, textAlign: 'right' }}>{inv.totalDurationMs === null ? '—' : (() => { const s = Math.round(inv.totalDurationMs/1000); return s < 60 ? `${s}s` : `${Math.floor(s/60)}m` })()} </span>
                        <span style={{ fontSize: 8, color: c.orange, textAlign: 'right' }}>{inv.costUSD === null ? '—' : fmtCost(inv.costUSD, currency, brlRate)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )
          case 'compare': return (
            <div key="compare" style={{ marginBottom: 28 }}>
              <SectionTitle title={pt ? 'Comparação de harnesses' : 'Harness comparison'} c={c} />
              {!compareSummaries || !compareHarnesses || compareHarnesses.length < 2 ? (
                <div style={{ fontSize: 10, color: c.textTer, fontStyle: 'italic', padding: '12px 0' }}>
                  {pt ? 'Nenhum dado de comparação disponível para o período selecionado.' : 'No comparison data available for the selected period.'}
                </div>
              ) : (
                <CompareSectionContent
                  summaries={compareSummaries}
                  harnesses={compareHarnesses}
                  c={c}
                  pt={pt}
                  currency={currency}
                  brlRate={brlRate}
                />
              )}
            </div>
          )
          default: return null
        }
      })}

      <div style={{ marginTop: 24, paddingTop: 14, borderTop: `1px solid ${c.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 8, color: c.textTer }}>{harnessTitle} · {pt ? 'Gerado automaticamente' : 'Auto-generated'}</div>
        <div style={{ fontSize: 8, color: c.textTer }}>
          {fmtFull(derived.totalSessions)} {pt ? 'sessões analisadas' : 'sessions analyzed'}
        </div>
      </div>
    </div>
  )
}

