import React from 'react'
import {
  MessageSquare, Zap, Clock, Flame, GitCommit,
  Wrench, FileCode, TrendingUp, BarChart2,
  Download, Upload, Trophy, Bot, Target, FolderOpen, Layers,
  Activity, CalendarDays, CalendarClock, Gauge, Crown, Sigma, Coins,
} from 'lucide-react'
import type { AppContext } from './app-context'
import { sessionTime } from './sessionTime'
import { widerValue } from './statCardSize'
import { projectFolder, fmt, fmtDuration, fmtCost, fmtFull } from '@agentistics/core'
import { StatCard } from '../components/StatCard'
import { StreakBreakdownButton } from '../components/StreakBreakdownButton'
import { HighlightsBoard } from '../components/HighlightsBoard'
import { ActivityChart } from '../components/ActivityChart'
import { ActivityHeatmap } from '../components/ActivityHeatmap'
import { HourChart } from '../components/HourChart'
import { ModelBreakdown } from '../components/ModelBreakdown'
import { BudgetPanel } from '../components/BudgetPanel'
import { CacheHitRatePanel } from '../components/CacheHitRatePanel'
import { ProjectsList } from '../components/ProjectsList'
import { TagCloud } from '../components/TagCloud'
import { ToolMetricsPanel } from '../components/ToolMetricsPanel'
import { AgentMetricsPanel } from '../components/AgentMetricsPanel'
import { RecentSessions } from '../components/RecentSessions'
import { TopBoards } from '../components/TopBoards'
import { TokenTotalsPanel } from '../components/TokenTotalsPanel'
import { TokenStatCard } from '../components/TokenStatCard'
import { Section } from '../components/Section'

/**
 * Category for palette grouping.
 */
export type CatalogCategory =
  | 'kpi'          // KPI cards
  | 'activity'     // charts, heatmaps
  | 'costs'        // model breakdown, budget, cache
  | 'projects'     // projects, languages
  | 'tools'        // tool metrics, agents
  | 'sessions'     // recent sessions, highlights

export interface CatalogItem {
  id: string
  /** If set, this is a variant of a "parent" component (e.g. "Activity chart — sessions only"). */
  parentId?: string
  labelPt: string
  labelEn: string
  category: CatalogCategory
  icon: React.ComponentType<{ size?: number }>
  /** Default grid size in RGL units (12-col grid). */
  defaultW: number
  defaultH: number
  minW: number
  minH: number
  /** Renders the component using current app context. */
  render: (ctx: AppContext) => React.ReactNode
}


function kpiCard(
  ctx: AppContext,
  cardId: string,
  label: string,
  accent: string,
  icon: React.ReactNode,
  value: string | number,
  valueFull: string | number,
  sub: React.ReactNode,
  rawValue?: number,
  action?: React.ReactNode,
) {
  const full = ctx.cardPrecision?.[cardId] ?? false
  const showToggle = rawValue === undefined || rawValue >= 1000
  return (
    <StatCard
      label={label}
      value={full ? valueFull : value}
      sub={sub as any}
      icon={icon}
      accent={accent}
      fullPrecision={full}
      onTogglePrecision={showToggle ? () => ctx.setCardPrecision?.(cardId, !full) : undefined}
      action={action}
      lang={ctx.lang}
    />
  )
}

export const CATALOG: CatalogItem[] = [
  // KPI cards
  {
    id: 'kpi.messages', labelPt: 'Mensagens', labelEn: 'Messages', category: 'kpi',
    icon: MessageSquare, defaultW: 3, defaultH: 3, minW: 2, minH: 2,
    render: (ctx) => kpiCard(
      ctx, 'kpi.messages',
      ctx.lang === 'pt' ? 'Mensagens' : 'Messages',
      'var(--anthropic-orange)',
      <MessageSquare size={15} />,
      fmt(ctx.derived.totalMessages),
      fmtFull(ctx.derived.totalMessages),
      ctx.lang === 'pt' ? 'no período selecionado' : 'in selected period',
      ctx.derived.totalMessages,
    ),
  },
  {
    id: 'kpi.sessions', labelPt: 'Sessões', labelEn: 'Sessions', category: 'kpi',
    icon: Zap, defaultW: 3, defaultH: 3, minW: 2, minH: 2,
    render: (ctx) => kpiCard(
      ctx, 'kpi.sessions',
      ctx.lang === 'pt' ? 'Sessões' : 'Sessions',
      'var(--accent-blue)',
      <Zap size={15} />,
      fmt(ctx.derived.totalSessions),
      fmtFull(ctx.derived.totalSessions),
      `avg ${ctx.derived.totalSessions > 0 ? Math.round(ctx.derived.totalMessages / ctx.derived.totalSessions) : 0} msgs/sessão`,
      ctx.derived.totalSessions,
    ),
  },
  {
    id: 'kpi.tool-calls', labelPt: 'Tool calls', labelEn: 'Tool calls', category: 'kpi',
    icon: Wrench, defaultW: 3, defaultH: 3, minW: 2, minH: 2,
    render: (ctx) => kpiCard(
      ctx, 'kpi.tool-calls',
      ctx.lang === 'pt' ? 'Tool calls' : 'Tool calls',
      'var(--accent-green)',
      <Wrench size={15} />,
      fmt(ctx.derived.totalToolCalls),
      fmtFull(ctx.derived.totalToolCalls),
      ctx.lang === 'pt' ? 'execuções totais' : 'total executions',
      ctx.derived.totalToolCalls,
    ),
  },
  {
    id: 'kpi.cost', labelPt: 'Custo estimado', labelEn: 'Estimated cost', category: 'kpi',
    icon: TrendingUp, defaultW: 3, defaultH: 3, minW: 2, minH: 2,
    render: ({ derived, lang, currency, brlRate }) => (
      <StatCard
        label={lang === 'pt' ? 'Custo estimado' : 'Est. cost'}
        value={fmtCost(derived.totalCostUSD, currency, brlRate)}
        // Same rule as the HomePage cost card: size by the wider currency so switching
        // USD ⇄ BRL leaves the headline alone.
        sizeBasis={widerValue(fmtCost(derived.totalCostUSD, 'USD', brlRate), fmtCost(derived.totalCostUSD, 'BRL', brlRate))}
        sub={lang === 'pt' ? 'preços da API Anthropic' : 'Anthropic API pricing'}
        icon={<TrendingUp size={15} />}
        accent="var(--anthropic-orange)"
      />
    ),
  },
  {
    id: 'kpi.streak', labelPt: 'Sequência', labelEn: 'Streak', category: 'kpi',
    icon: Flame, defaultW: 3, defaultH: 3, minW: 2, minH: 2,
    render: ({ derived, lang, filters }) => (
      <StatCard
        label={lang === 'pt' ? 'Sequência' : 'Streak'}
        value={`${derived.streak}d`}
        sub={lang === 'pt' ? 'dias consecutivos' : 'consecutive days'}
        icon={<Flame size={15} />}
        accent="#ef4444"
        action={derived.streakDayBreakdown.length > 0 && filters.projects.length !== 1
          ? <StreakBreakdownButton items={derived.streakDayBreakdown} pt={lang === 'pt'} />
          : undefined}
      />
    ),
  },
  {
    id: 'kpi.longest-session', labelPt: 'Sessão mais longa', labelEn: 'Longest session', category: 'kpi',
    icon: Clock, defaultW: 3, defaultH: 3, minW: 2, minH: 2,
    render: ({ derived, lang, filters }) => (
      <StatCard
        label={lang === 'pt' ? 'Sessão mais longa' : 'Longest session'}
        value={(() => {
          // Active time is the headline; the wall clock moves to the sub-line — same rule as the
          // HomePage KPI, since this is the same card in the custom layout.
          const t = sessionTime(derived.longestSession, lang)
          return derived.longestSession ? (t.active ?? t.elapsed) : '—'
        })()}
        valueTitle={derived.longestSession ? sessionTime(derived.longestSession, lang).tooltip : undefined}
        sub={derived.longestSession ? (() => {
          const t = sessionTime(derived.longestSession, lang)
          const msgs = (derived.longestSession!.user_message_count ?? 0) + (derived.longestSession!.assistant_message_count ?? 0)
          const msgStr = `${t.activeLabel} · ${t.elapsed} ${t.elapsedLabel} · ${msgs} msgs`
          if (filters.projects.length === 0 && derived.longestSession!.project_path)
            return `${msgStr} · ${projectFolder(derived.longestSession!.project_path)}`
          return msgStr
        })() : ''}
        subNoWrap
        icon={<Clock size={15} />}
        accent="var(--accent-purple)"
      />
    ),
  },
  {
    id: 'kpi.commits', labelPt: 'Commits', labelEn: 'Commits', category: 'kpi',
    icon: GitCommit, defaultW: 3, defaultH: 3, minW: 2, minH: 2,
    render: ({ derived, lang }) => (
      <StatCard
        label={lang === 'pt' ? 'Commits' : 'Commits'}
        value={derived.gitCommits}
        sub={derived.gitPushes > 0
          ? `${derived.gitPushes} pushes`
          : lang === 'pt' ? 'via chamadas Bash' : 'via Bash calls'}
        icon={<GitCommit size={15} />}
        accent="var(--accent-cyan)"
      />
    ),
  },
  {
    id: 'kpi.files', labelPt: 'Arquivos modificados', labelEn: 'Files modified', category: 'kpi',
    icon: FileCode, defaultW: 3, defaultH: 3, minW: 2, minH: 2,
    render: ({ derived, lang }) => (
      <StatCard
        label={lang === 'pt' ? 'Arquivos' : 'Files'}
        value={derived.filesModified}
        sub={derived.linesAdded + derived.linesRemoved > 0
          ? `+${fmt(derived.linesAdded)} / -${fmt(derived.linesRemoved)} linhas`
          : lang === 'pt' ? 'via chamadas Bash' : 'via Bash calls'}
        icon={<FileCode size={15} />}
        accent="var(--accent-green)"
      />
    ),
  },
  {
    // The whole token story in one tile: the total plus all four billed counters. Wider and taller
    // than a single-figure KPI by default, because it carries five numbers rather than one.
    id: 'kpi.tokens', labelPt: 'Tokens (completo)', labelEn: 'Tokens (full breakdown)', category: 'kpi',
    icon: Coins, defaultW: 4, defaultH: 4, minW: 3, minH: 3,
    render: (ctx) => (
      <TokenStatCard
        lang={ctx.lang === 'pt' ? 'pt' : 'en'}
        tokens={ctx.derived.tokenTotals}
        accent="var(--accent-blue)"
        fullPrecision={ctx.cardPrecision['kpi.tokens'] ?? false}
        onTogglePrecision={() => ctx.setCardPrecision('kpi.tokens', !(ctx.cardPrecision['kpi.tokens'] ?? false))}
      />
    ),
  },
  // The two counters below stay as their own placeable tiles: a custom layout is SAVED, and
  // removing a component id would empty a slot somebody had arranged deliberately. They are the
  // conversational pair (`input + output`) — a fraction of the volume — so the full tile above is
  // the one to reach for; these remain for a layout that wants exactly one of them.
  {
    id: 'kpi.input-tokens', labelPt: 'Tokens de entrada', labelEn: 'Input tokens', category: 'kpi',
    icon: Download, defaultW: 3, defaultH: 3, minW: 2, minH: 2,
    render: (ctx) => kpiCard(
      ctx, 'kpi.input-tokens',
      ctx.lang === 'pt' ? 'Tokens entrada' : 'Input tokens',
      'var(--accent-blue)',
      <Download size={15} />,
      fmt(ctx.totalInputTokens),
      fmtFull(ctx.totalInputTokens),
      ctx.lang === 'pt' ? 'tokens enviados ao modelo' : 'tokens sent to model',
      ctx.totalInputTokens,
    ),
  },
  {
    id: 'kpi.output-tokens', labelPt: 'Tokens de saída', labelEn: 'Output tokens', category: 'kpi',
    icon: Upload, defaultW: 3, defaultH: 3, minW: 2, minH: 2,
    render: (ctx) => kpiCard(
      ctx, 'kpi.output-tokens',
      ctx.lang === 'pt' ? 'Tokens saída' : 'Output tokens',
      'var(--accent-purple)',
      <Upload size={15} />,
      fmt(ctx.totalOutputTokens),
      fmtFull(ctx.totalOutputTokens),
      ctx.lang === 'pt' ? 'tokens gerados pelo modelo' : 'tokens generated by model',
      ctx.totalOutputTokens,
    ),
  },

  // Activity & charts
  {
    id: 'activity.chart', labelPt: 'Gráfico de atividade (completo)', labelEn: 'Activity chart (full)', category: 'activity',
    icon: BarChart2, defaultW: 8, defaultH: 7, minW: 4, minH: 4,
    render: ({ derived, theme, lang }) => (
      <Section title={<><BarChart2 size={14} /> {lang === 'pt' ? 'Atividade ao longo do tempo' : 'Activity over time'}</>}>
        <ActivityChart data={derived.heatmapData} theme={theme} />
      </Section>
    ),
  },
  {
    id: 'activity.chart.messages', parentId: 'activity.chart',
    labelPt: 'Atividade — só Mensagens', labelEn: 'Activity — Messages only', category: 'activity',
    icon: MessageSquare, defaultW: 6, defaultH: 6, minW: 3, minH: 3,
    render: ({ derived, theme, lang }) => (
      <Section title={<><MessageSquare size={14} /> {lang === 'pt' ? 'Mensagens / dia' : 'Messages / day'}</>}>
        <ActivityChart data={derived.heatmapData} theme={theme} forcedMetric="value" hideControls />
      </Section>
    ),
  },
  {
    id: 'activity.chart.sessions', parentId: 'activity.chart',
    labelPt: 'Atividade — só Sessões', labelEn: 'Activity — Sessions only', category: 'activity',
    icon: Zap, defaultW: 6, defaultH: 6, minW: 3, minH: 3,
    render: ({ derived, theme, lang }) => (
      <Section title={<><Zap size={14} /> {lang === 'pt' ? 'Sessões / dia' : 'Sessions / day'}</>}>
        <ActivityChart data={derived.heatmapData} theme={theme} forcedMetric="sessions" hideControls />
      </Section>
    ),
  },
  {
    id: 'activity.chart.tools', parentId: 'activity.chart',
    labelPt: 'Atividade — só Tool calls', labelEn: 'Activity — Tool calls only', category: 'activity',
    icon: Wrench, defaultW: 6, defaultH: 6, minW: 3, minH: 3,
    render: ({ derived, theme, lang }) => (
      <Section title={<><Wrench size={14} /> {lang === 'pt' ? 'Tool calls / dia' : 'Tool calls / day'}</>}>
        <ActivityChart data={derived.heatmapData} theme={theme} forcedMetric="tools" hideControls />
      </Section>
    ),
  },
  {
    id: 'activity.chart.overlay', parentId: 'activity.chart',
    labelPt: 'Atividade — Overlay', labelEn: 'Activity — Overlay', category: 'activity',
    icon: Layers, defaultW: 8, defaultH: 6, minW: 4, minH: 3,
    render: ({ derived, theme, lang }) => (
      <Section title={<><Layers size={14} /> {lang === 'pt' ? 'Atividade (overlay)' : 'Activity (overlay)'}</>}>
        <ActivityChart data={derived.heatmapData} theme={theme} forcedOverlay hideControls />
      </Section>
    ),
  },
  {
    id: 'activity.heatmap', labelPt: 'Heatmap de atividade', labelEn: 'Activity heatmap', category: 'activity',
    icon: CalendarDays, defaultW: 6, defaultH: 6, minW: 3, minH: 3,
    render: ({ derived, lang }) => (
      <Section title={<><CalendarDays size={14} /> {lang === 'pt' ? 'Heatmap de atividade' : 'Activity heatmap'}</>}>
        <ActivityHeatmap data={derived.heatmapData} />
      </Section>
    ),
  },
  {
    id: 'activity.hours', labelPt: 'Uso por hora do dia', labelEn: 'Usage by hour', category: 'activity',
    icon: CalendarClock, defaultW: 8, defaultH: 6, minW: 4, minH: 3,
    render: ({ derived, lang }) => (
      <Section title={<><CalendarClock size={14} /> {lang === 'pt' ? 'Uso por hora do dia' : 'Usage by hour'}</>}>
        <HourChart hourCounts={derived.hourCounts} hourMeta={derived.hourMeta} />
      </Section>
    ),
  },

  // Costs
  {
    id: 'costs.models', labelPt: 'Uso por modelo', labelEn: 'Model usage', category: 'costs',
    icon: TrendingUp, defaultW: 12, defaultH: 7, minW: 6, minH: 4,
    render: ({ derived, filters, currency, brlRate, lang }) => (
      <Section title={<><TrendingUp size={14} /> {lang === 'pt' ? 'Uso por modelo' : 'Model usage & cost'}</>}>
        <ModelBreakdown
          modelUsage={derived.modelUsage}
          currency={currency}
          brlRate={brlRate}
          fallbackInputTokens={filters.projects.length > 0 ? derived.inputTokens : undefined}
          fallbackOutputTokens={filters.projects.length > 0 ? derived.outputTokens : undefined}
          fallbackCostUSD={filters.projects.length > 0 ? derived.totalCostUSD : undefined}
        />
      </Section>
    ),
  },
  {
    id: 'costs.budget', labelPt: 'Orçamento & projeção', labelEn: 'Budget & forecast', category: 'costs',
    icon: Target, defaultW: 6, defaultH: 7, minW: 4, minH: 4,
    render: ({ statsCache, monthlyBudgetUSD, updateBudget, currency, brlRate, lang }) => (
      <Section title={<><Target size={14} /> {lang === 'pt' ? 'Orçamento & projeção' : 'Budget & forecast'}</>}>
        <BudgetPanel statsCache={statsCache} budgetUSD={monthlyBudgetUSD} onBudgetChange={updateBudget} currency={currency} brlRate={brlRate} lang={lang} />
      </Section>
    ),
  },
  {
    id: 'costs.cache', labelPt: 'Eficiência de cache', labelEn: 'Cache efficiency', category: 'costs',
    icon: Gauge, defaultW: 6, defaultH: 7, minW: 4, minH: 4,
    render: ({ derived, currency, brlRate, lang, costBasis }) => (
      <Section title={<><Gauge size={14} /> {lang === 'pt' ? 'Eficiência de cache' : 'Cache efficiency'}</>}>
        <CacheHitRatePanel hitRate={derived.cacheHitRate} cacheTotals={derived.cacheTotals} grossSavedUSD={derived.cacheGrossSavedUSD} writeOverheadUSD={derived.cacheWriteOverheadUSD} netSavedUSD={derived.cacheNetSavedUSD} perModel={derived.cachePerModel} currency={currency} brlRate={brlRate} costBasis={costBasis} lang={lang} />
      </Section>
    ),
  },

  // Projects
  {
    id: 'projects.top', labelPt: 'Principais projetos', labelEn: 'Top projects', category: 'projects',
    icon: FolderOpen, defaultW: 7, defaultH: 7, minW: 4, minH: 4,
    render: ({ derived, setFilters, lang }) => (
      <Section title={<><FolderOpen size={14} /> {lang === 'pt' ? 'Principais projetos' : 'Top projects'}</>}>
        <ProjectsList projectStats={derived.projectStats} onFilter={path => setFilters(f => ({ ...f, projects: [path] }))} />
      </Section>
    ),
  },
  {
    id: 'projects.languages', labelPt: 'Linguagens', labelEn: 'Languages', category: 'projects',
    icon: FileCode, defaultW: 5, defaultH: 6, minW: 3, minH: 3,
    render: ({ derived, lang }) => (
      <Section title={<><FileCode size={14} /> {lang === 'pt' ? 'Linguagens' : 'Languages'}</>}>
        <TagCloud data={derived.langCounts} color="var(--accent-blue)" />
      </Section>
    ),
  },

  // Tools / Agents
  {
    id: 'tools.metrics', labelPt: 'Métricas de ferramentas (completo)', labelEn: 'Tool metrics (full)', category: 'tools',
    icon: Wrench, defaultW: 12, defaultH: 8, minW: 6, minH: 4,
    render: ({ derived, lang }) => (
      <Section title={<><Wrench size={14} /> {lang === 'pt' ? 'Métricas de ferramentas' : 'Tool metrics'}</>}>
        <ToolMetricsPanel toolCounts={derived.toolCounts} toolOutputTokens={derived.toolOutputTokens} agentFileReads={derived.agentFileReads} lang={lang} />
      </Section>
    ),
  },
  {
    id: 'tools.metrics.calls', parentId: 'tools.metrics',
    labelPt: 'Ferramentas — só Chamadas', labelEn: 'Tool metrics — calls only', category: 'tools',
    icon: Activity, defaultW: 8, defaultH: 7, minW: 4, minH: 4,
    render: ({ derived, lang }) => (
      <Section title={<><Wrench size={14} /> {lang === 'pt' ? 'Ferramentas — chamadas' : 'Tools — calls'}</>}>
        <ToolMetricsPanel toolCounts={derived.toolCounts} toolOutputTokens={derived.toolOutputTokens} agentFileReads={derived.agentFileReads} lang={lang} forcedMode="calls" hideAgentReads />
      </Section>
    ),
  },
  {
    id: 'tools.metrics.tokens', parentId: 'tools.metrics',
    labelPt: 'Ferramentas — só Tokens', labelEn: 'Tool metrics — tokens only', category: 'tools',
    icon: TrendingUp, defaultW: 8, defaultH: 7, minW: 4, minH: 4,
    render: ({ derived, lang }) => (
      <Section title={<><Wrench size={14} /> {lang === 'pt' ? 'Ferramentas — tokens' : 'Tools — tokens'}</>}>
        <ToolMetricsPanel toolCounts={derived.toolCounts} toolOutputTokens={derived.toolOutputTokens} agentFileReads={derived.agentFileReads} lang={lang} forcedMode="tokens" hideAgentReads />
      </Section>
    ),
  },
  {
    id: 'tools.agents', labelPt: 'Métricas de agentes', labelEn: 'Agent metrics', category: 'tools',
    icon: Bot, defaultW: 12, defaultH: 8, minW: 6, minH: 4,
    render: ({ derived, currency, brlRate, lang }) => (
      <Section title={<><Bot size={14} /> {lang === 'pt' ? 'Métricas de agentes' : 'Agent metrics'}</>}>
        <AgentMetricsPanel invocations={derived.agentInvocations} agentTypeBreakdown={derived.agentTypeBreakdown} totalInvocations={derived.totalAgentInvocations} totalTokens={derived.totalAgentTokens} totalCostUSD={derived.totalAgentCostUSD} totalDurationMs={derived.totalAgentDurationMs} currency={currency} brlRate={brlRate} lang={lang} />
      </Section>
    ),
  },

  // Sessions / Highlights
  {
    id: 'sessions.highlights', labelPt: 'Recordes (Highlights)', labelEn: 'Highlights', category: 'sessions',
    icon: Trophy, defaultW: 12, defaultH: 6, minW: 6, minH: 3,
    render: ({ derived, data, lang }) => (
      <Section title={<><Trophy size={14} /> {lang === 'pt' ? 'Recordes' : 'Highlights'}</>}>
        <HighlightsBoard sessions={derived.filteredSessions} projects={data.projects as any} lang={lang} />
      </Section>
    ),
  },
  {
    id: 'sessions.recent', labelPt: 'Sessões recentes', labelEn: 'Recent sessions', category: 'sessions',
    icon: Clock, defaultW: 12, defaultH: 7, minW: 6, minH: 4,
    render: ({ derived, setSelectedSession, lang }) => (
      <Section title={<><Clock size={14} /> {lang === 'pt' ? 'Sessões recentes' : 'Recent sessions'}</>}>
        <RecentSessions sessions={derived.filteredSessions} lang={lang} onSelect={setSelectedSession} />
      </Section>
    ),
  },
  {
    id: 'sessions.top-boards', labelPt: 'Quem lidera', labelEn: 'Who leads', category: 'sessions',
    icon: Crown, defaultW: 12, defaultH: 10, minW: 6, minH: 6,
    render: ({ derived, currency, brlRate, setSelectedSession, lang }) => (
      <Section title={<><Crown size={14} /> {lang === 'pt' ? 'Quem lidera' : 'Who leads'}</>}>
        <TopBoards
          sessions={derived.filteredSessions}
          lang={lang}
          currency={currency}
          brlRate={brlRate}
          onSelectSession={setSelectedSession}
        />
      </Section>
    ),
  },
  {
    id: 'costs.token-totals', labelPt: 'Totais de tokens', labelEn: 'Token totals', category: 'costs',
    icon: Sigma, defaultW: 12, defaultH: 8, minW: 6, minH: 5,
    render: ({ derived, filters, lang }) => (
      <Section title={<><Sigma size={14} /> {lang === 'pt' ? 'Totais de tokens' : 'Token totals'}</>}>
        <TokenTotalsPanel tokens={derived.tokenTotals} filters={filters} lang={lang} />
      </Section>
    ),
  },
]

export function getCatalogItem(id: string): CatalogItem | undefined {
  return CATALOG.find(c => c.id === id)
}

export const CATEGORY_LABELS: Record<CatalogCategory, { pt: string; en: string }> = {
  kpi: { pt: 'KPIs', en: 'KPIs' },
  activity: { pt: 'Atividade', en: 'Activity' },
  costs: { pt: 'Custos', en: 'Costs' },
  projects: { pt: 'Projetos', en: 'Projects' },
  tools: { pt: 'Ferramentas & Agentes', en: 'Tools & Agents' },
  sessions: { pt: 'Sessões', en: 'Sessions' },
}
