import React from 'react'
import { useOutletContext } from 'react-router-dom'
import { Wrench, Bot } from 'lucide-react'
import { planAllocation } from '@agentistics/core'
import type { AppContext } from '../lib/app-context'
import { HARNESS_LABELS } from '../lib/harness'
import { Section } from '../components/Section'
import { ToolMetricsPanel } from '../components/ToolMetricsPanel'
import { AgentMetricsPanel } from '../components/AgentMetricsPanel'

export default function ToolsPage() {
  const ctx = useOutletContext<AppContext>()
  const { derived, lang, currency, brlRate, filters } = ctx

  const subtitle = lang === 'pt'
    ? filters.harness
      ? `Quais ferramentas o ${HARNESS_LABELS[filters.harness]} usa mais e a performance dos agentes delegados.`
      : 'Quais ferramentas estão sendo mais usadas e a performance dos agentes delegados.'
    : filters.harness
      ? `Which tools ${HARNESS_LABELS[filters.harness]} uses the most and the performance of delegated agents.`
      : 'Which tools are used most across all harnesses and the performance of delegated agents.'

  return (
    <>
      <PageHeader
        icon={<Wrench size={16} />}
        title={lang === 'pt' ? 'Ferramentas & agentes' : 'Tools & agents'}
        subtitle={subtitle}
      />

      <Section flashId="tools" title={<><Wrench size={14} /> {lang === 'pt' ? 'Métricas de ferramentas' : 'Tool metrics'}</>}>
        <ToolMetricsPanel toolCounts={derived.toolCounts} toolOutputTokens={derived.toolOutputTokens} agentFileReads={derived.agentFileReads} lang={lang} />
      </Section>

      <Section flashId="agents" title={<><Bot size={14} /> {lang === 'pt' ? 'Métricas de agentes' : 'Agent metrics'}</>}>
        <AgentMetricsPanel invocations={derived.agentInvocations} agentTypeBreakdown={derived.agentTypeBreakdown} totalInvocations={derived.totalAgentInvocations} totalTokens={derived.totalAgentTokens} totalCostUSD={derived.totalAgentCostUSD} totalDurationMs={derived.totalAgentDurationMs} currency={currency} brlRate={brlRate} planFactor={ctx.costBasis === "plan" && ctx.planBasis.basis ? planAllocation(ctx.planBasis.basis).byHarness.claude ?? null : null} lang={lang} harness={filters.harness} />
      </Section>
    </>
  )
}

function PageHeader({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
        <span style={{ color: 'var(--anthropic-orange)' }}>{icon}</span>
        {title}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{subtitle}</div>
    </div>
  )
}
