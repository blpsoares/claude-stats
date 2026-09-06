import React, { useState } from 'react'
import { CheckCircle, XCircle, ChevronDown, ChevronUp, Bot } from 'lucide-react'
import { fmt, fmtCost } from '@agentistics/core'
import type { AgentInvocation, HarnessId } from '@agentistics/core'
import type { Lang } from '@agentistics/core'
import { MetricNote } from './MetricNote'
import { useIsMobile } from '../hooks/useIsMobile'
import { capable } from '../lib/harness'
import { NAtag } from './NAtag'
import { unmeasuredNote } from '../lib/agentMeasured'

interface AgentMetricsPanelProps {
  invocations: AgentInvocation[]
  agentTypeBreakdown: Record<string, { count: number; tokens: number; costUSD: number; durationMs: number }>
  totalInvocations: number
  totalTokens: number
  totalCostUSD: number
  totalDurationMs: number
  currency: 'USD' | 'BRL'
  brlRate: number
  /** Claude's own C/A when the page is in plan basis. Agents are a Claude-only capability, so the
   *  cross-harness aggregate would price them partly against a plan paying for something else. */
  planFactor?: number | null
  lang: Lang
  /** When set, gates the panel — renders N/A if the harness cannot produce agent metrics. */
  harness?: HarnessId
}



/** No figure, and never a zero — see `agentMeasured.ts`. */
function Absent() {
  return <span style={{ color: 'var(--text-tertiary)' }}>—</span>
}

function fmtDuration(ms: number): string {
  if (ms === 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`
}

function AgentTypeBadge({ type }: { type: string }) {
  const colors: Record<string, { bg: string; text: string }> = {
    'general-purpose': { bg: 'rgba(99,102,241,0.15)', text: '#818cf8' },
    'Explore':         { bg: 'rgba(16,185,129,0.15)', text: '#34d399' },
    'Plan':            { bg: 'rgba(245,158,11,0.15)', text: '#fbbf24' },
    'claude-code-guide': { bg: 'rgba(6,182,212,0.15)', text: '#22d3ee' },
    'statusline-setup': { bg: 'rgba(139,92,246,0.15)', text: '#a78bfa' },
    'code-reviewer':   { bg: 'rgba(239,68,68,0.15)', text: '#f87171' },
  }
  const style = colors[type] ?? { bg: 'rgba(148,163,184,0.15)', text: 'var(--text-secondary)' }
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 7px',
      borderRadius: 10,
      fontSize: 10,
      fontWeight: 600,
      background: style.bg,
      color: style.text,
      whiteSpace: 'nowrap',
    }}>
      {type}
    </span>
  )
}

function SummaryCard({ label, value, sub, accent }: { label: string; value: string; sub: string; accent: string }) {
  return (
    <div style={{
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border)',
      borderRadius: 10,
      padding: '12px 14px',
    }}>
      <div style={{ fontSize: 10, color: 'var(--text-tertiary)', fontWeight: 500, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: accent, lineHeight: 1, marginBottom: 3 }}>
        {value}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{sub}</div>
    </div>
  )
}

export function AgentMetricsPanel({
  invocations,
  agentTypeBreakdown,
  totalInvocations,
  totalTokens,
  totalCostUSD,
  totalDurationMs,
  currency,
  brlRate,
  planFactor = null,
  lang,
  harness,
}: AgentMetricsPanelProps) {
  const [showAll, setShowAll] = useState(false)
  const pt = lang === 'pt'
  const isMobile = useIsMobile()

  if (harness && !capable(harness, 'agents')) {
    return <NAtag harness={harness} label="Agent metrics" />
  }

  if (totalInvocations === 0) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        padding: '32px 0',
        color: 'var(--text-tertiary)',
        fontSize: 13,
      }}>
        <Bot size={16} style={{ opacity: 0.4 }} />
        {pt ? 'Nenhuma invocação de agente encontrada no período' : 'No agent invocations found in this period'}
      </div>
    )
  }

  const avgDurationMs = totalInvocations > 0 ? totalDurationMs / totalInvocations : 0
  const avgTokens = totalInvocations > 0 ? totalTokens / totalInvocations : 0

  // Sort breakdown by count descending
  const sortedTypes = Object.entries(agentTypeBreakdown)
    .sort((a, b) => b[1].count - a[1].count)
  const maxCount = sortedTypes[0]?.[1].count ?? 1

  const displayInvocations = showAll ? invocations : invocations.slice(0, 10)
  // Derived from the rows ON SCREEN rather than taken as a prop, so the sentence always describes
  // the list the reader is looking at.
  const unmeasuredShown = displayInvocations.filter(i => i.unmeasured).length
  const note = unmeasuredNote(unmeasuredShown, displayInvocations.length, lang)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Summary cards */}
      <div className="ag-grid cols-4" style={{ gap: 12 }}>
        <SummaryCard
          label={pt ? 'Invocações' : 'Invocations'}
          value={String(totalInvocations)}
          sub={pt ? 'total de agentes chamados' : 'total agent calls'}
          accent="var(--accent-purple)"
        />
        <SummaryCard
          label={pt ? 'Tokens de agentes' : 'Agent tokens'}
          value={fmt(totalTokens)}
          sub={`avg ${fmt(Math.round(avgTokens))} / ${pt ? 'chamada' : 'call'}`}
          accent="var(--accent-blue)"
        />
        {/* Agents are a Claude-only capability, so the allocation uses CLAUDE's own C/A — never
            the cross-harness aggregate, which would price Claude's agents partly against a plan
            paying for something else. */}
        <SummaryCard
          label={planFactor !== null && planFactor !== undefined
            ? (pt ? 'Custo dos agentes (rateado)' : 'Agent cost (allocated)')
            : (pt ? 'Custo dos agentes' : 'Agent cost')}
          value={fmtCost(totalCostUSD * (planFactor ?? 1), currency, brlRate)}
          sub={`avg ${fmtCost((totalCostUSD * (planFactor ?? 1)) / totalInvocations, currency, brlRate)} / ${pt ? 'chamada' : 'call'}`}
          accent="var(--anthropic-orange)"
        />
        <SummaryCard
          label={pt ? 'Duração total' : 'Total duration'}
          value={fmtDuration(totalDurationMs)}
          sub={`avg ${fmtDuration(Math.round(avgDurationMs))} / ${pt ? 'chamada' : 'call'}`}
          accent="var(--accent-green)"
        />
      </div>

      {/* What these numbers ARE. An agent's token figure is the harness's own rollup for that
          invocation, which is a different measurement from the session totals elsewhere — saying so
          is cheaper than the question "why don't these add up to my session". */}
      <MetricNote>
        {pt
          ? 'Tokens e custo por invocação vêm do que o próprio Claude Code reporta ao encerrar cada agente — já incluem leitura e escrita de cache. Um agente é cobrado dentro da sessão que o chamou, então estes valores são uma FATIA do total da sessão, não uma soma à parte.'
          : "Tokens and cost per invocation come from what Claude Code itself reports when each agent finishes — cache reads and writes included. An agent is billed inside the session that called it, so these figures are a SLICE of that session's total, not something to add on top."}
      </MetricNote>

      {/* Agent type breakdown */}
      {sortedTypes.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 10 }}>
            {pt ? 'Por tipo de agente' : 'By agent type'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sortedTypes.map(([type, stats]) => (
              <div key={type} style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0,1fr) 1fr 50px' : '160px 1fr 60px 80px 80px', gap: isMobile ? 8 : 10, alignItems: 'center', fontSize: 11 }}>
                <AgentTypeBadge type={type} />
                <div style={{ position: 'relative', height: 6, background: 'var(--bg-elevated)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0,
                    width: `${(stats.count / maxCount) * 100}%`,
                    background: 'var(--accent-purple)',
                    borderRadius: 3,
                    opacity: 0.7,
                  }} />
                </div>
                <span style={{ color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right' }}>
                  {stats.count}×
                </span>
                {!isMobile && <span style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>
                  {fmt(stats.tokens)} tok
                </span>}
                {!isMobile && <span style={{ color: 'var(--anthropic-orange)', textAlign: 'right' }}>
                  {fmtCost(stats.costUSD, currency, brlRate)}
                </span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-invocation list */}
      <div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 10 }}>
          {pt ? 'Invocações recentes' : 'Recent invocations'}
          <span style={{ marginLeft: 6, fontWeight: 400, color: 'var(--text-tertiary)' }}>
            ({pt ? `exibindo ${displayInvocations.length} de ${totalInvocations}` : `showing ${displayInvocations.length} of ${totalInvocations}`})
          </span>
        </div>
        {note && (
          <div style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-tertiary)', marginBottom: 8 }}>
            {note}
          </div>
        )}
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: isMobile ? 'auto' : 'hidden', width: '100%' }}>
          <div style={{ minWidth: isMobile ? 480 : undefined }}>
          {/* Table header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '140px 1fr 60px 60px 60px 80px',
            gap: 10,
            padding: '7px 12px',
            background: 'var(--bg-elevated)',
            borderBottom: '1px solid var(--border)',
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--text-tertiary)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}>
            <span>{pt ? 'Tipo' : 'Type'}</span>
            <span>{pt ? 'Descrição' : 'Description'}</span>
            <span style={{ textAlign: 'right' }}>Tokens</span>
            <span style={{ textAlign: 'right' }}>{pt ? 'Tools' : 'Tools'}</span>
            <span style={{ textAlign: 'right' }}>{pt ? 'Duração' : 'Duration'}</span>
            <span style={{ textAlign: 'right' }}>{pt ? 'Custo' : 'Cost'}</span>
          </div>
          {/* Rows */}
          {displayInvocations.map((inv, i) => (
            <div
              key={inv.toolUseId || i}
              style={{
                display: 'grid',
                gridTemplateColumns: '140px 1fr 60px 60px 60px 80px',
                gap: 10,
                padding: '8px 12px',
                alignItems: 'center',
                borderBottom: i < displayInvocations.length - 1 ? '1px solid var(--border)' : 'none',
                background: i % 2 === 0 ? 'transparent' : 'var(--bg-elevated)',
              }}
            >
              <AgentTypeBadge type={inv.agentType} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                {inv.status === 'failed'
                  ? <XCircle size={11} color="var(--accent-red, #ef4444)" style={{ flexShrink: 0 }} />
                  : <CheckCircle size={11} color="var(--accent-green)" style={{ flexShrink: 0 }} />
                }
                <span style={{
                  fontSize: 11,
                  color: 'var(--text-secondary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {inv.description || <em style={{ color: 'var(--text-tertiary)' }}>—</em>}
                </span>
              </div>
              {/* An invocation whose subagent transcript is gone carries zeros because the type has
                  no other value to carry. Rendering them would price real work at nothing — the
                  confident 0 this product refuses everywhere else — so the cell says nothing
                  instead, and the note under the heading says why. */}
              <span style={{ fontSize: 11, color: 'var(--text-primary)', textAlign: 'right' }}>
                {inv.unmeasured ? <Absent /> : fmt(inv.totalTokens)}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)', textAlign: 'right' }}>
                {inv.unmeasured ? <Absent /> : inv.totalToolUseCount}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-secondary)', textAlign: 'right' }}>
                {inv.unmeasured ? <Absent /> : fmtDuration(inv.totalDurationMs)}
              </span>
              <span style={{ fontSize: 11, color: 'var(--anthropic-orange)', textAlign: 'right' }}>
                {inv.unmeasured ? <Absent /> : fmtCost(inv.costUSD, currency, brlRate)}
              </span>
            </div>
          ))}
          </div>
        </div>

        {invocations.length > 10 && (
          <button
            onClick={() => setShowAll(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              marginTop: 8,
              padding: '5px 10px',
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--text-secondary)',
              fontSize: 11,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {showAll
              ? <><ChevronUp size={12} /> {pt ? 'Mostrar menos' : 'Show less'}</>
              : <><ChevronDown size={12} /> {pt ? `Ver todas (${totalInvocations})` : `Show all (${totalInvocations})`}</>
            }
          </button>
        )}
      </div>
    </div>
  )
}
