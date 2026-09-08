import { runStatusText } from '../lib/workflows'
import React, { useMemo, useState } from 'react'
import { useOutletContext, useParams, useNavigate } from 'react-router-dom'
import {
  GitBranch, ArrowLeft, ExternalLink, Link2Off, Users, Zap, Workflow as WorkflowIcon, GitCompare,
  Clock, GitCommit, ChevronDown, DollarSign, Cpu, Wrench, Bot, FileCode, MessageSquare, Database, AlertTriangle,
  EyeOff,
} from 'lucide-react'
import type { AppContext, } from '../lib/app-context'
import type { SessionMeta, MemberPresence, HarnessId, WorkflowRun, WorkflowAgent } from '@agentistics/core'
import { repoShortName, fmt, fmtCost, fmtDuration, formatProjectName, formatModel, calcCost, sessionCostUSD, sessionLabel, workflowTokens, NO_REPO_KEY, sessionTokenTotal, totalTokens, totalTokensExplained } from '@agentistics/core'
import { TokenBreakdownLine } from '../components/TokenBreakdownLine'
import { capable, HARNESS_LABELS, HARNESS_COLORS, DYNAMIC_WORKFLOWS_DOC } from '../lib/harness'
import { canonicalRepoKey } from '../lib/shareRepos'
import { PLURAL_COPY, interpolate, plural } from '../components/team/copy'
import { withheldMarkStyle } from '../components/team/withheldStyle'
import { DocLink } from '../components/DocLink'
import { buildWorkflowSteps, groupRunsBySession } from '../lib/workflowSteps'
import { useDerivedStats, computeMemberSummaries, type MemberSummary } from '../hooks/useData'
import { useIsMobile } from '../hooks/useIsMobile'
import { Section } from '../components/Section'
import { ModelBreakdown } from '../components/ModelBreakdown'
import { ActivityChart } from '../components/ActivityChart'
import { RecentSessions } from '../components/RecentSessions'
import { ScopedSessions } from '../components/ScopedSessions'
import { MetricNote } from '../components/MetricNote'

type Tab = 'overview' | 'members' | 'compare' | 'actions' | 'sessions' | 'workflows'

export default function RepoDetailPage() {
  const ctx = useOutletContext<AppContext>()
  const { data, filters, currency, brlRate, lang, theme, isCentral, setSelectedSession, deniedRepoLabels } = ctx
  const { id } = useParams()
  const navigate = useNavigate()
  const pt = lang === 'pt'

  // Route id → scope. A `folder:<path>` id is an unlinked project folder (scoped by its
  // project_path); anything else is a normalized remote (scoped by the repos filter).
  const rawId = id ?? ''
  const isFolder = rawId.startsWith('folder:')
  const folderPath = isFolder ? rawId.slice('folder:'.length) : ''
  const remote = isFolder ? '' : rawId
  const linked = !isFolder

  // Scope every metric to this repo/folder by overriding the relevant filter WITHOUT mutating
  // the global filter (so leaving the page leaves the FiltersBar untouched). All other active
  // filters (date/harness/models/users/presence) still compose because we spread `filters`.
  const scopedFilters = useMemo(
    () => (isFolder ? { ...filters, projects: [folderPath] } : { ...filters, repos: [remote] }),
    [filters, isFolder, folderPath, remote],
  )
  const scoped = useDerivedStats(data, scopedFilters)
  const [tab, setTab] = useState<Tab>('overview')
  // All hooks must run before any early return (rules of hooks); guard on scoped safely inside.
  const sessionIds = useMemo(
    () => new Set((scoped?.filteredSessions ?? []).map(s => s.session_id)),
    [scoped],
  )
  const sessionByIdWf = useMemo(
    () => new Map((data.sessions ?? []).map(s => [s.session_id, s] as [string, SessionMeta])),
    [data.sessions],
  )

  if (!scoped) return null

  const sessions = scoped.filteredSessions
  const ciSessions = sessions.filter(s => s.ci)
  const workflows = (data.workflows ?? []).filter(w => sessionIds.has(w.sessionId))
  const harnessOf = (w: WorkflowRun): HarnessId => sessionByIdWf.get(w.sessionId)?.harness ?? 'claude'

  const title = linked ? repoShortName(remote) : (folderPath.split('/').filter(Boolean).pop() || (pt ? 'Sem repositório' : 'No repository'))
  const host = linked ? remote.split('/')[0]! : ''
  // Task 13 — the hidden-repo badge. Keyed by the CANONICAL repo key, same as RepositoriesList and
  // the sharing picker — `remote` here is already `normalizeGitRemote`'d (see the routing comment
  // above), so only the further canonicalization (case/ssh-alias folding) is needed.
  const hiddenKey = linked ? canonicalRepoKey(remote) : NO_REPO_KEY
  const hiddenLabels = deniedRepoLabels?.get(hiddenKey)

  const tabs: { id: Tab; label: string; icon: React.ReactNode; show: boolean; badge?: number }[] = [
    { id: 'overview', label: pt ? 'Visão geral' : 'Overview', icon: <GitBranch size={13} />, show: true },
    { id: 'members', label: pt ? 'Membros' : 'Members', icon: <Users size={13} />, show: isCentral, badge: scoped.repoStats[0]?.members.length },
    { id: 'compare', label: pt ? 'Comparar' : 'Compare', icon: <GitCompare size={13} />, show: isCentral && (scoped.repoStats[0]?.members.length ?? 0) > 1 },
    { id: 'actions', label: 'Actions', icon: <Zap size={13} />, show: ciSessions.length > 0, badge: ciSessions.length || undefined },
    { id: 'sessions', label: pt ? 'Sessões' : 'Sessions', icon: <Clock size={13} />, show: true },
    { id: 'workflows', label: 'Dynamic Workflows', icon: <WorkflowIcon size={13} />, show: workflows.length > 0 && workflows.some(w => capable(harnessOf(w), 'dynamicWorkflows')), badge: workflows.length },
  ]

  return (
    <>
      {/* Header */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button
          onClick={() => navigate('/repositories')}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
            fontSize: 12, color: 'var(--text-tertiary)', background: 'transparent', border: 'none',
            cursor: 'pointer', fontFamily: 'inherit', padding: 0,
          }}
        >
          <ArrowLeft size={13} /> {pt ? 'Repositórios' : 'Repositories'}
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ color: linked ? 'var(--anthropic-orange)' : 'var(--text-tertiary)' }}>
            {linked ? <GitBranch size={18} /> : <Link2Off size={18} />}
          </span>
          <span style={{ fontSize: 19, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
          {host && (
            <a href={`https://${remote}`} target="_blank" rel="noreferrer" style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 600,
              color: 'var(--text-secondary)', background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              padding: '3px 8px', borderRadius: 6, textDecoration: 'none',
            }}>
              {remote} <ExternalLink size={11} />
            </a>
          )}
          {hiddenLabels && hiddenLabels.length > 0 && (
            <span
              role="button"
              tabIndex={0}
              title={hiddenLabels.join(', ')}
              onClick={() => navigate('/settings/connection')}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/settings/connection') } }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700,
                ...withheldMarkStyle(),
                padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
              }}
            >
              <EyeOff size={11} />
              {interpolate(plural(PLURAL_COPY.hiddenFromN[lang], hiddenLabels.length), { n: hiddenLabels.length })}
              {' · '}{hiddenLabels.join(', ')}
            </span>
          )}
        </div>
        {/* Full folder path subtitle — a machine-local detail, hidden on the central where a repo
            is keyed by its remote (the title/host chip already identify it). Shown on machines,
            where the same repo can live at several local paths. */}
        {!isCentral && (folderPath || scoped.repoStats[0]?.path) && (
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            {formatProjectName(folderPath || scoped.repoStats[0]!.path)}
          </span>
        )}
      </div>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
        <StatTile label={pt ? 'Sessões' : 'Sessions'} value={String(scoped.totalSessions)} />
        <StatTile label={pt ? 'Custo' : 'Cost'} value={fmtCost(scoped.totalCostUSD, currency, brlRate)} accent />
        {/* ONE tokens tile — the total of all four billed counters, where this used to be input
            and output as two tiles (the pair that comes to 0,34 % of the volume). The four
            counters themselves are the line UNDER this strip, not tiles in it: the grid is
            `repeat(auto-fit, minmax(120px, 1fr))`, which fits `floor((W + gap) / 130)` columns —
            ten at ~1400px — so taking the strip to eleven tiles stranded the last one alone on a
            second row. `scoped.tokenTotals` is the same filtered model usage `totalCostUSD` above
            is priced from, so the tokens and the money describe the same turns under the repo
            scope. */}
        <StatTile
          label="Tokens"
          value={fmt(totalTokens(scoped.tokenTotals))}
          title={totalTokensExplained(scoped.tokenTotals, pt ? 'pt' : 'en')}
        />
        <StatTile label="Commits" value={String(scoped.gitCommits)} />
        <StatTile label={pt ? 'Linhas' : 'Lines'} value={`+${fmt(scoped.linesAdded)} −${fmt(scoped.linesRemoved)}`} />
        {isCentral && <StatTile label={pt ? 'Membros' : 'Members'} value={String(scoped.repoStats[0]?.members.length ?? 0)} />}
        <StatTile label="Agents" value={String(scoped.totalAgentInvocations)} />
      </div>
      {/* What the Tokens tile above is made of. A wrapping line has no cell count, so unlike four
          more tiles it cannot strand anything at any width. */}
      <TokenBreakdownLine tokens={scoped.tokenTotals} lang={pt ? 'pt' : 'en'} />

      {/* Tabs */}
      <div className="tabscroll" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', overflowX: 'auto' }}>
        {tabs.filter(t => t.show).map(t => {
          const active = tab === t.id
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
                padding: '9px 13px', fontSize: 13, fontWeight: active ? 700 : 500, fontFamily: 'inherit',
                color: active ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
                background: 'transparent', border: 'none', cursor: 'pointer',
                borderBottom: active ? '2px solid var(--anthropic-orange)' : '2px solid transparent',
                marginBottom: -1,
              }}
            >
              {t.icon} {t.label}
              {t.badge != null && t.badge > 0 && (
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', background: 'var(--bg-elevated)', borderRadius: 8, padding: '1px 6px' }}>{t.badge}</span>
              )}
            </button>
          )
        })}
      </div>

      {tab === 'overview' && (
        <>
          <Section title={<><Clock size={14} /> {pt ? 'Atividade ao longo do tempo' : 'Activity over time'}</>}>
            <ActivityChart data={scoped.heatmapData} height={200} theme={theme} />
          </Section>
          <Section title={pt ? 'Uso por modelo' : 'Model usage & cost'}>
            <ModelBreakdown
              modelUsage={scoped.modelUsage}
              currency={currency}
              brlRate={brlRate}
              fallbackInputTokens={scoped.inputTokens}
              fallbackOutputTokens={scoped.outputTokens}
              fallbackCostUSD={scoped.totalCostUSD}
            />
          </Section>
        </>
      )}

      {tab === 'members' && isCentral && (
        <Section title={<><Users size={14} /> {pt ? 'Quem trabalha neste repositório' : 'Who works on this repository'}</>}>
          <MembersTable sessions={sessions} presence={data.presence} lang={lang} currency={currency} brlRate={brlRate} />
        </Section>
      )}

      {tab === 'compare' && (
        <Section title={<><GitCompare size={14} /> {pt ? 'Comparar membros' : 'Compare members'}</>}>
          <MemberComparePanel sessions={sessions} lang={lang} currency={currency} brlRate={brlRate} />
        </Section>
      )}

      {tab === 'actions' && (
        <Section title={<><Zap size={14} /> {pt ? 'GitHub Actions (runners de CI)' : 'GitHub Actions (CI runners)'}</>}>
          {ciSessions.length === 0 ? (
            <div style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: 20, textAlign: 'center', lineHeight: 1.6 }}>
              {pt
                ? 'Nenhum run de GitHub Actions registrado para este repositório ainda. Configure o workflow do agentistics para enviar as métricas do Claude Code Actions à central.'
                : 'No GitHub Actions runs recorded for this repository yet. Configure the agentistics workflow to push Claude Code Actions metrics to the central.'}
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginBottom: 14 }}>
                <StatTile label={pt ? 'Runs' : 'Runs'} value={String(ciSessions.length)} />
                <StatTile label={pt ? 'Tokens' : 'Tokens'} value={fmt(ciSessions.reduce((a, s) => a + sessionTokenTotal(s), 0))} />
                <StatTile label="Commits" value={String(ciSessions.reduce((a, s) => a + (s.git_commits ?? 0), 0))} />
              </div>
              <MetricNote style={{ marginTop: 0, marginBottom: 12 }}>
                {pt
                  ? 'Tokens somam os quatro contadores cobrados: entrada nova, saída, leitura e escrita de cache.'
                  : 'Tokens add all four billed counters: fresh input, output, cache read and cache write.'}
              </MetricNote>
              <RecentSessions sessions={ciSessions} lang={lang} onSelect={setSelectedSession} />
            </>
          )}
        </Section>
      )}

      {tab === 'sessions' && (
        <Section title={<><Clock size={14} /> {pt ? 'Sessões' : 'Sessions'}</>}>
          {/* `ScopedSessions`, not `RecentSessions`: this tab is already scoped to ONE repository,
              so the browser's group-by, status filter, six-key sort, search and grid toggle re-ask
              questions the page has answered — and cost the first screen of a phone before a single
              session appeared. What is left is what the tab is for: each session's metrics, and the
              way into it. See the module comment on ScopedSessions for the rest.
              The Actions tab above keeps `RecentSessions` on purpose: a CI runner's session was
              never on this machine's fleet, so it has no /sessions row to link to. */}
          <ScopedSessions sessions={sessions} lang={lang} currency={currency} brlRate={brlRate} />
        </Section>
      )}

      {tab === 'workflows' && (
        <Section title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><WorkflowIcon size={14} /> Dynamic Workflows <DocLink href={DYNAMIC_WORKFLOWS_DOC} title={pt ? 'O que é Dynamic Workflows? (doc da Anthropic)' : 'What is Dynamic Workflows? (Anthropic docs)'} /></span>}>
          <WorkflowsMini workflows={workflows} lang={lang} currency={currency} brlRate={brlRate} sessionById={sessionByIdWf} />
        </Section>
      )}
    </>
  )
}

// Compare members (repo-scoped, mirrors the /compare page but keyed by member)
const MEMBER_COLORS = ['#D97706', '#6366f1', '#10b981', '#ef4444', '#06b6d4', '#8b5cf6', '#f59e0b', '#ec4899']
const mcolor = (i: number): string => MEMBER_COLORS[i % MEMBER_COLORS.length]!
const DOW_NAMES: Record<'pt' | 'en', string[]> = {
  pt: ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
}

function CmpBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div style={{ height: 4, background: 'var(--bg-elevated)', borderRadius: 2, overflow: 'hidden', marginTop: 5 }}>
      <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 2, transition: 'width 0.4s ease-out' }} />
    </div>
  )
}

function CmpSparkline({ series, color }: { series: { date: string; sessions: number }[]; color: string }) {
  if (series.length < 2) return <div style={{ height: 24 }} />
  const vals = series.map(d => d.sessions)
  const max = Math.max(...vals, 1)
  const W = 120, H = 24, step = W / (vals.length - 1)
  const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(H - (v / max) * (H - 2) - 1).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 24, display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" opacity={0.9} />
    </svg>
  )
}

function MemberComparePanel({ sessions, lang, currency, brlRate }: {
  sessions: SessionMeta[]; lang: 'pt' | 'en'; currency: 'USD' | 'BRL'; brlRate: number
}) {
  const pt = lang === 'pt'
  const members = useMemo(() => computeMemberSummaries(sessions), [sessions])
  if (members.length < 2) {
    return <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '8px 2px' }}>{pt ? 'Só há um membro neste repositório.' : 'Only one member on this repository.'}</div>
  }

  // Every billed counter — the row is labelled "Tokens" and members are ranked by it.
  const tok = (m: MemberSummary) => totalTokens(m.summary.tokens)
  const rows: { label: string; val: (m: MemberSummary) => number; display: (m: MemberSummary) => string }[] = [
    { label: pt ? 'Sessões' : 'Sessions', val: m => m.summary.sessions, display: m => String(m.summary.sessions) },
    { label: pt ? 'Mensagens' : 'Messages', val: m => m.summary.messages, display: m => fmt(m.summary.messages) },
    { label: 'Tokens', val: m => tok(m), display: m => fmt(tok(m)) },
    { label: pt ? 'Custo' : 'Cost', val: m => m.summary.costUSD, display: m => fmtCost(m.summary.costUSD, currency, brlRate) },
    { label: pt ? 'Custo/M tok' : 'Cost/M tok', val: m => m.summary.costPerMTokens ?? 0, display: m => m.summary.costPerMTokens != null ? fmtCost(m.summary.costPerMTokens, currency, brlRate) : '—' },
  ]

  const gridCols = `minmax(120px, 1.1fr) ${members.map(() => 'minmax(150px, 1fr)').join(' ')}`

  const compRow = (label: string, cell: (m: MemberSummary) => string) => (
    <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 12, alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--border)' }}>
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 600 }}>{label}</span>
      {members.map((m, i) => (
        <span key={i} style={{ fontSize: 12, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{cell(m)}</span>
      ))}
    </div>
  )

  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ minWidth: 120 + members.length * 160 }}>
        {/* Header — member names */}
        <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 12, alignItems: 'end', paddingBottom: 8 }}>
          <span />
          {members.map((m, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: mcolor(i), flexShrink: 0 }} />
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.user}</span>
            </div>
          ))}
        </div>

        {/* Numeric rows with comparative bars */}
        {rows.map(row => {
          const max = Math.max(...members.map(row.val), 0)
          return (
            <div key={row.label} style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 12, alignItems: 'start', padding: '9px 0', borderTop: '1px solid var(--border)' }}>
              <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', fontWeight: 600, paddingTop: 2 }}>{row.label}</span>
              {members.map((m, i) => (
                <div key={i} style={{ minWidth: 0 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{row.display(m)}</span>
                  <CmpBar value={row.val(m)} max={max} color={mcolor(i)} />
                </div>
              ))}
            </div>
          )
        })}

        {/* Comparatives */}
        <div style={{ marginTop: 6 }}>
          {compRow(pt ? 'Hora de pico' : 'Peak hour', m => m.summary.peakHour == null ? '—' : `${String(m.summary.peakHour).padStart(2, '0')}:00`)}
          {compRow(pt ? 'Dia mais ativo' : 'Busiest day', m => m.summary.peakDow == null ? '—' : DOW_NAMES[lang][m.summary.peakDow] ?? '—')}
          {compRow(pt ? 'Pico de tokens/dia' : 'Peak token day', m => m.summary.peakTokenDay ? `${fmt(m.summary.peakTokenDay.tokens)} · ${m.summary.peakTokenDay.date.slice(5)}` : '—')}
          {compRow(pt ? 'Sessão mais cara' : 'Peak session cost', m => m.summary.peakSessionCost != null ? fmtCost(m.summary.peakSessionCost, currency, brlRate) : '—')}
        </div>

        {/* Activity sparklines */}
        <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 12, alignItems: 'center', padding: '10px 0 2px', borderTop: '1px solid var(--border)' }}>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 600 }}>{pt ? 'Atividade' : 'Activity'}</span>
          {members.map((m, i) => (
            <CmpSparkline key={i} series={m.summary.dailyActivity} color={mcolor(i)} />
          ))}
        </div>
      </div>
    </div>
  )
}

function StatTile({ label, value, accent, title }: { label: string; value: string; accent?: boolean; title?: string }) {
  return (
    <div title={title} style={{
      display: 'flex', flexDirection: 'column', gap: 3, padding: '12px 14px', minWidth: 0,
      background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
    }}>
      {/* No `nowrap`: the Lines tile is two figures ("+517.3K −61.2K") and at a 120px column it was
          painted straight through the card's right edge — the tile has no `overflow`, so the text
          simply left the box. Wrapping at the space costs a second line on the widest tile and
          keeps every digit. `minWidth: 0` is what lets the tile shrink inside its grid track at
          all; without it the track floors at the value's intrinsic width and the ROW overflows
          instead of the cell. */}
      <span style={{
        fontSize: 18, fontWeight: 700, lineHeight: 1.15, minWidth: 0,
        color: accent ? 'var(--anthropic-orange)' : 'var(--text-primary)',
      }}>{value}</span>
      <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</span>
    </div>
  )
}

interface MemberAgg {
  user: string
  sessions: number; messages: number; toolCalls: number
  cost: number; inTok: number; outTok: number; cacheRead: number; cacheWrite: number
  commits: number; linesAdded: number; linesRemoved: number; files: number
  agents: number; durationMin: number; durationUnmeasured: number
  interruptions: number; errors: number
  models: Set<string>; harnesses: Set<HarnessId>; firstActive: string; lastActive: string
  byDay: Record<string, number>; byHour: Record<number, number>
}

/** Cost of a single session — calcCost with its model (Sonnet fallback via '' when unknown). */
function sessCost(s: SessionMeta): number {
  const byModel = sessionCostUSD(s)
  if (byModel !== null) return byModel
  return calcCost({
    inputTokens: s.input_tokens ?? 0, outputTokens: s.output_tokens ?? 0,
    cacheReadInputTokens: s.cache_read_input_tokens ?? 0, cacheCreationInputTokens: s.cache_creation_input_tokens ?? 0,
    webSearchRequests: 0, costUSD: 0,
  }, '')
}

function MembersTable({ sessions, presence, lang, currency, brlRate }: {
  sessions: SessionMeta[]
  presence?: Record<string, MemberPresence>
  lang: 'pt' | 'en'; currency: 'USD' | 'BRL'; brlRate: number
}) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const [openUser, setOpenUser] = useState<string | null>(null)

  const rows = useMemo(() => {
    const byUser: Record<string, MemberAgg> = {}
    for (const s of sessions) {
      const u = s.user || 'local'
      let m = byUser[u]
      if (!m) {
        m = byUser[u] = {
          user: u, sessions: 0, messages: 0, toolCalls: 0, cost: 0, inTok: 0, outTok: 0,
          cacheRead: 0, cacheWrite: 0, commits: 0, linesAdded: 0, linesRemoved: 0, files: 0,
          agents: 0, durationMin: 0, durationUnmeasured: 0, interruptions: 0, errors: 0,
          models: new Set(), harnesses: new Set(), firstActive: '', lastActive: '', byDay: {}, byHour: {},
        }
      }
      m.harnesses.add(s.harness ?? 'claude')
      m.sessions++
      m.messages += (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0)
      m.toolCalls += Object.values(s.tool_counts ?? {}).reduce((a, b) => a + b, 0)
      m.cost += sessCost(s)
      m.inTok += s.input_tokens ?? 0
      m.outTok += s.output_tokens ?? 0
      m.cacheRead += s.cache_read_input_tokens ?? 0
      m.cacheWrite += s.cache_creation_input_tokens ?? 0
      m.commits += s.git_commits ?? 0
      m.linesAdded += s.lines_added ?? 0
      m.linesRemoved += s.lines_removed ?? 0
      m.files += s.files_modified ?? 0
      m.agents += s.agentMetrics?.totalInvocations ?? 0
      // Active time (Σ per-turn), not wall clock: summing wall clock across a member's sessions
      // adds up the weeks they merely had a session open. Sessions with no active figure add 0
      // and are counted in `durationUnmeasured` so the card can say so instead of under-reporting
      // in silence.
      if (s.active_minutes === undefined) m.durationUnmeasured++
      else m.durationMin += s.active_minutes
      m.interruptions += s.user_interruptions ?? 0
      m.errors += s.tool_errors ?? 0
      if (s.model) m.models.add(s.model)
      if (s.start_time) {
        if (!m.firstActive || s.start_time < m.firstActive) m.firstActive = s.start_time
        if (!m.lastActive || s.start_time > m.lastActive) m.lastActive = s.start_time
        m.byDay[s.start_time.slice(0, 10)] = (m.byDay[s.start_time.slice(0, 10)] ?? 0) + 1
      }
      for (const h of s.message_hours ?? []) m.byHour[h] = (m.byHour[h] ?? 0) + 1
    }
    return Object.values(byUser).sort((a, b) => b.cost - a.cost || b.inTok + b.outTok - (a.inTok + a.outTok))
  }, [sessions])

  if (rows.length === 0) return <div style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: 16 }}>—</div>

  const totalCost = rows.reduce((a, r) => a + r.cost, 0)
  const maxCost = Math.max(...rows.map(r => r.cost), 1e-9)
  const fc = (usd: number) => fmtCost(usd, currency, brlRate)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Descriptive intro — what this ranking means */}
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6, marginBottom: 2 }}>
        {pt
          ? <>Ranking dos membros por <strong style={{ color: 'var(--text-secondary)' }}>custo estimado</strong> neste repositório (respeitando os filtros ativos). Clique num membro para ver todas as métricas core — tokens, cache, commits, agentes e atividade.</>
          : <>Members ranked by <strong style={{ color: 'var(--text-secondary)' }}>estimated cost</strong> in this repository (honoring active filters). Click a member to see every core metric — tokens, cache, commits, agents, and activity.</>}
      </div>

      {rows.map((m, i) => {
        const open = openUser === m.user
        const online = presence?.[m.user]?.online
        const share = totalCost > 0 ? (m.cost / totalCost) * 100 : 0
        return (
          <div key={m.user} style={{ background: 'var(--bg-elevated)', borderRadius: 10, border: `1px solid ${open ? 'var(--anthropic-orange)55' : 'var(--border-subtle)'}`, overflow: 'hidden', transition: 'border-color 0.15s' }}>
            {/* Row header (click to expand) */}
            <div
              onClick={() => setOpenUser(open ? null : m.user)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 13px', cursor: 'pointer' }}
            >
              <span style={{ fontSize: 12, fontWeight: 800, color: i === 0 ? 'var(--anthropic-orange)' : 'var(--text-tertiary)', width: 22, flexShrink: 0 }}>#{i + 1}</span>
              {/* Avatar initial + presence dot */}
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--bg-card)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>{m.user.slice(0, 2)}</div>
                {presence && m.user !== 'local' && (
                  <span style={{ position: 'absolute', right: -1, bottom: -1, width: 9, height: 9, borderRadius: '50%', background: online ? '#22c55e' : 'var(--text-tertiary)', border: '2px solid var(--bg-elevated)' }} />
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.user}</div>
                {/* Cost-share bar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <div style={{ flex: 1, maxWidth: 200, height: 4, background: 'var(--bg-card)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${(m.cost / maxCost) * 100}%`, background: 'var(--anthropic-orange)', borderRadius: 2 }} />
                  </div>
                  <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>{share.toFixed(0)}% {pt ? 'do custo' : 'of cost'}</span>
                </div>
              </div>
              {/* Compact headline metrics — on mobile keep only cost + chevron (the rest is one tap
                  away in the expanded card) so the row never overflows. */}
              <div style={{ display: 'flex', gap: isMobile ? 10 : 16, alignItems: 'center', flexShrink: 0 }}>
                {!isMobile && <Head label={pt ? 'sessões' : 'sessions'} value={String(m.sessions)} />}
                {!isMobile && <Head label="tokens" value={fmt(m.inTok + m.outTok)} />}
                <Head label={pt ? 'custo' : 'cost'} value={fc(m.cost)} accent />
                <ChevronDown size={16} color="var(--text-tertiary)" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', flexShrink: 0 }} />
              </div>
            </div>

            {/* Expanded detail — every core metric, with a one-line explanation each */}
            <div style={{ display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', transition: 'grid-template-rows 0.25s cubic-bezier(0.22,1,0.36,1)' }}>
              <div style={{ overflow: 'hidden', minHeight: 0 }}>
                <div style={{ padding: '4px 13px 14px', borderTop: '1px solid var(--border-subtle)' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginTop: 12 }}>
                    <MetricCard icon={<DollarSign size={12} />} label={pt ? 'Custo estimado' : 'Estimated cost'} value={fc(m.cost)} hint={pt ? 'Gasto do membro neste repo (preço por modelo).' : "Member's spend in this repo (per-model pricing)."} accent />
                    <MetricCard icon={<Cpu size={12} />} label={pt ? 'Tokens (in / out)' : 'Tokens (in / out)'} value={`${fmt(m.inTok)} / ${fmt(m.outTok)}`} hint={pt ? 'Enviados ao modelo / gerados pelo modelo.' : 'Sent to / generated by the model.'} />
                    <MetricCard icon={<Database size={12} />} label={pt ? 'Cache lido' : 'Cache read'} value={fmt(m.cacheRead)} hint={pt ? 'Tokens servidos do cache — mais barato que input.' : 'Tokens served from cache — cheaper than input.'} />
                    <MetricCard icon={<Clock size={12} />} label={pt ? 'Sessões' : 'Sessions'} value={String(m.sessions)} hint={(() => {
                      const measured = m.sessions - m.durationUnmeasured
                      const total = fmtDuration(m.durationMin * 60000)
                      const avg = fmtDuration((m.durationMin / Math.max(measured, 1)) * 60000)
                      const missing = m.durationUnmeasured > 0
                        ? (pt ? ` (${m.durationUnmeasured} sem tempo medido)` : ` (${m.durationUnmeasured} without measured time)`)
                        : ''
                      return pt
                        ? `${total} de trabalho ativo no total · ${avg} em média por sessão${missing}.`
                        : `${total} of active work total · ${avg} average per session${missing}.`
                    })()} />
                    <MetricCard icon={<MessageSquare size={12} />} label={pt ? 'Mensagens' : 'Messages'} value={fmt(m.messages)} hint={pt ? 'Turnos de conversa (usuário + assistente).' : 'Conversation turns (user + assistant).'} />
                    <MetricCard icon={<Wrench size={12} />} label={pt ? 'Chamadas de tools' : 'Tool calls'} value={fmt(m.toolCalls)} hint={pt ? 'Total de ferramentas executadas (Bash, Edit…).' : 'Total tools executed (Bash, Edit…).'} />
                    <MetricCard icon={<GitCommit size={12} />} label="Commits" value={String(m.commits)} hint={pt ? `+${fmt(m.linesAdded)} / −${fmt(m.linesRemoved)} linhas · ${m.files} arquivos.` : `+${fmt(m.linesAdded)} / −${fmt(m.linesRemoved)} lines · ${m.files} files.`} />
                    <MetricCard icon={<Bot size={12} />} label="Agents" value={String(m.agents)} hint={pt ? 'Subagentes disparados via Task/Agent.' : 'Subagents launched via Task/Agent.'} />
                    <MetricCard icon={<AlertTriangle size={12} />} label={pt ? 'Erros de tool' : 'Tool errors'} value={String(m.errors)} hint={pt ? `${m.interruptions} interrupções do usuário.` : `${m.interruptions} user interruptions.`} />
                  </div>

                  {/* Harnesses used by this member in this repo */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 14 }}>
                    <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Harnesses:</span>
                    {m.harnesses.size === 0
                      ? <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>—</span>
                      : [...m.harnesses].map(h => (
                        <span key={h} style={{
                          display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600,
                          color: HARNESS_COLORS[h], background: `${HARNESS_COLORS[h]}1f`,
                          border: `1px solid ${HARNESS_COLORS[h]}55`, borderRadius: 5, padding: '2px 7px 2px 8px',
                        }}>
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: HARNESS_COLORS[h], flexShrink: 0 }} />
                          {HARNESS_LABELS[h]}
                        </span>
                      ))}
                  </div>

                  {/* Models used + active range */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 14, alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{pt ? 'Modelos' : 'Models'}:</span>
                      {m.models.size === 0
                        ? <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>—</span>
                        : [...m.models].map(mod => (
                          <span key={mod} style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 5, padding: '2px 7px' }}>{formatModel(mod)}</span>
                        ))}
                    </div>
                    {m.firstActive && (
                      <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                        <Clock size={11} /> {pt ? 'Ativo de' : 'Active'} {m.firstActive.slice(0, 10)} → {m.lastActive.slice(0, 10)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Head({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', minWidth: 46 }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: accent ? 'var(--anthropic-orange)' : 'var(--text-primary)', whiteSpace: 'nowrap' }}>{value}</span>
      <span style={{ fontSize: 9, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
    </div>
  )
}

function MetricCard({ icon, label, value, hint, accent }: { icon: React.ReactNode; label: string; value: string; hint: string; accent?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 12px', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 9 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        <span style={{ color: accent ? 'var(--anthropic-orange)' : 'var(--text-tertiary)', display: 'flex' }}>{icon}</span>{label}
      </span>
      <span style={{ fontSize: 17, fontWeight: 700, color: accent ? 'var(--anthropic-orange)' : 'var(--text-primary)', whiteSpace: 'nowrap' }}>{value}</span>
      <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', lineHeight: 1.4 }}>{hint}</span>
    </div>
  )
}

/** One palette for a run's state, shared with the sessions aside — `lib/workflows.ts`.
 *  It used to be `completed ? green : partial ? yellow : RED`, which painted every other state as
 *  a failure. Now that a run can be `running`, `killed` or `abandoned`, that expression would have
 *  shown a workflow in flight as a red dot. */
function statusColor(status: WorkflowRun['status']): string {
  return runStatusText(status, false).color
}

/** Seconds-aware run duration (fmtDuration floors to whole minutes, so a 12s run
 *  would read "0m" — workflow runs are often sub-minute). */
function fmtRunDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
}

function agentGlyph(status: WorkflowAgent['status']): { ch: string; color: string } {
  if (status === 'completed') return { ch: '✓', color: '#22c55e' }
  if (status === 'failed') return { ch: '✗', color: '#ef4444' }
  return { ch: '⤼', color: 'var(--text-tertiary)' }
}

function WorkflowsMini({ workflows, lang, currency, brlRate, sessionById }: {
  workflows: WorkflowRun[]
  lang: 'pt' | 'en'; currency: 'USD' | 'BRL'; brlRate: number
  sessionById: Map<string, SessionMeta>
}) {
  const pt = lang === 'pt'
  const [view, setView] = useState<'all' | 'session'>('all')
  const sessionCount = useMemo(() => new Set(workflows.map(w => w.sessionId)).size, [workflows])
  const groups = useMemo(() => groupRunsBySession(workflows), [workflows])

  if (workflows.length === 0) {
    return <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '8px 2px' }}>{pt ? 'Nenhum workflow.' : 'No workflows.'}</div>
  }
  return (
    // Fill the full available width so the run cards and step/agent rows reach the component edge.
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
      {/* View toggle: flat list of runs vs grouped by session */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginRight: 2 }}>{pt ? 'Ver:' : 'View:'}</span>
        {([['all', pt ? 'Todos' : 'All'], ['session', pt ? 'Por sessão' : 'By session']] as const).map(([v, label]) => (
          <button key={v} onClick={() => setView(v)} style={wfPill(view === v)}>{label}</button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
          {workflows.length} {pt ? 'workflows' : 'workflows'} · {sessionCount} {pt ? (sessionCount === 1 ? 'sessão' : 'sessões') : (sessionCount === 1 ? 'session' : 'sessions')}
        </span>
      </div>

      {view === 'all'
        ? workflows.map(w => (
          <WorkflowRunCard key={w.runId} run={w} pt={pt} currency={currency} brlRate={brlRate} sessionById={sessionById} />
        ))
        : groups.map(g => (
          <SessionGroupCard key={g.sessionId} group={g} pt={pt} currency={currency} brlRate={brlRate} sessionById={sessionById} />
        ))}
    </div>
  )
}

function SessionGroupCard({ group: g, pt, currency, brlRate, sessionById }: {
  group: ReturnType<typeof groupRunsBySession>[number]
  pt: boolean; currency: 'USD' | 'BRL'; brlRate: number; sessionById: Map<string, SessionMeta>
}) {
  const [open, setOpen] = useState(true)
  const s = sessionById.get(g.sessionId)
  const label = s ? sessionLabel(s) : g.sessionId.slice(0, 8)
  const project = s?.project_path ? formatProjectName(s.project_path) : ''
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '9px 12px', background: 'var(--bg-elevated)', borderBottom: open ? '1px solid var(--border)' : 'none', cursor: 'pointer' }}
      >
        <ChevronDown size={13} style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 0.2s', color: 'var(--text-tertiary)', flexShrink: 0 }} />
        <MessageSquare size={13} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
        <span title={label} style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, maxWidth: '55%' }}>{label}</span>
        {project && (
          <span title={project} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, maxWidth: '30%' }}>
            <FileCode size={11} style={{ flexShrink: 0 }} /> {project}
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
          <span><strong style={{ color: 'var(--text-primary)' }}>{g.totals.runs}</strong> {pt ? 'workflows' : 'workflows'}</span>
          <span>{g.totals.agents} {pt ? 'agentes' : 'agents'}</span>
          <span>{fmt(workflowTokens(g.totals))} tok</span>
          <span style={{ color: 'var(--anthropic-orange)', fontWeight: 600 }}>{fmtCost(g.totals.costUSD, currency, brlRate)}</span>
        </span>
      </div>
      {/* Animated collapse — glides open/closed instead of snapping. */}
      <div style={{ display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', transition: 'grid-template-rows 0.28s cubic-bezier(0.22, 1, 0.36, 1)' }}>
        <div style={{ overflow: 'hidden', minHeight: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 10 }}>
            {g.runs.map(w => (
              <WorkflowRunCard key={w.runId} run={w} pt={pt} currency={currency} brlRate={brlRate} sessionById={sessionById} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function wfPill(active: boolean): React.CSSProperties {
  return {
    padding: '4px 10px', borderRadius: 7, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
    border: '1px solid var(--border)',
    background: active ? 'var(--anthropic-orange-dim, rgba(205,93,56,0.12))' : 'var(--bg-elevated)',
    color: active ? 'var(--anthropic-orange, #cd5d38)' : 'var(--text-secondary)',
    fontWeight: active ? 600 : 500,
  }
}

function WorkflowRunCard({ run, pt, currency, brlRate, sessionById }: {
  run: WorkflowRun; pt: boolean; currency: 'USD' | 'BRL'; brlRate: number; sessionById: Map<string, SessionMeta>
}) {
  const [open, setOpen] = useState(true)
  const s = sessionById.get(run.sessionId)
  const harness = s?.harness ?? 'claude'
  // Session context: title + project. Repo is omitted here — this page is already repo-scoped.
  const sessTitle = s ? sessionLabel(s) : ''
  const project = s?.project_path ? formatProjectName(s.project_path) : ''
  const steps = buildWorkflowSteps(run, pt ? '(sem fase)' : '(no phase)')
  const tok = workflowTokens(run.totals)

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden', background: 'var(--bg-card)' }}>
      {/* Header */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 12px', cursor: 'pointer' }}
      >
        <ChevronDown size={14} style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 0.2s', color: 'var(--text-tertiary)', flexShrink: 0 }} />
        {/* A colour alone cannot carry five states — the word rides the title. */}
        <span title={runStatusText(run.status, pt).text} style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(run.status), flexShrink: 0 }} />
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{run.name}</span>
        <span style={{
          fontSize: 10.5, fontWeight: 600, color: HARNESS_COLORS[harness], flexShrink: 0,
          background: 'var(--bg-elevated)', border: `1px solid ${HARNESS_COLORS[harness]}55`,
          borderRadius: 5, padding: '2px 7px',
        }}>{HARNESS_LABELS[harness]}</span>
        {steps.length > 0 && (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>
            {steps.length} {pt ? (steps.length === 1 ? 'fase' : 'fases') : (steps.length === 1 ? 'phase' : 'phases')}
          </span>
        )}
        {/* Metrics as aligned right-hand columns (value + micro-label) — reads as a table and
            uses the full row width instead of leaving a ragged gap. */}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'stretch', flexShrink: 0 }}>
          <WfMetric label={pt ? 'agentes' : 'agents'} value={String(run.totals.agentCount)} w={78} />
          <WfMetric label="tokens" value={fmt(tok)} w={82} />
          <WfMetric label={pt ? 'custo' : 'cost'} value={fmtCost(run.totals.costUSD, currency, brlRate)} w={92} accent />
          {run.durationMs > 0 && <WfMetric label={pt ? 'duração' : 'duration'} value={fmtRunDuration(run.durationMs)} w={64} />}
        </span>
        {/* Session context line (own row via flex-basis:100%): session title + project. */}
        {(sessTitle || project) && (
          <span style={{ flexBasis: '100%', paddingLeft: 32, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', fontSize: 11, color: 'var(--text-tertiary)', minWidth: 0 }}>
            {sessTitle && (
              <span title={sessTitle} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }}>
                <MessageSquare size={11} style={{ flexShrink: 0 }} /> {sessTitle}
              </span>
            )}
            {project && (
              <span title={project} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <FileCode size={11} style={{ flexShrink: 0 }} /> {project}
              </span>
            )}
          </span>
        )}
      </div>

      {/* Timeline */}
      {open && (() => {
        const noPhaseLabel = pt ? '(sem fase)' : '(no phase)'
        // Agents are only meaningfully phased when at least one DECLARED phase actually ran an
        // agent. When they're not (everything fell into the no-phase bucket), the numbered rail +
        // empty "nada rodou" phases are just noise — show a clean flat agent list instead.
        const phased = steps.some(s => s.title !== noPhaseLabel && s.agents.length > 0)
        if (!phased) {
          const allAgents = steps.flatMap(s => s.agents)
          return (
            <div style={{ padding: '2px 12px 12px', display: 'flex', flexDirection: 'column', gap: 7 }}>
              {allAgents.map((a, j) => <WfAgentRow key={j} a={a} pt={pt} currency={currency} brlRate={brlRate} />)}
            </div>
          )
        }
        const shown = steps.filter(s => s.title !== noPhaseLabel || s.agents.length > 0)
        return (
          <div style={{ padding: '4px 12px 12px', display: 'flex', flexDirection: 'column' }}>
            {shown.map((step, i) => (
              <div key={`${step.title}-${i}`} style={{ display: 'flex', gap: 10 }}>
                {/* Rail */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 22, flexShrink: 0 }}>
                  <span style={{
                    width: 20, height: 20, borderRadius: '50%', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)',
                    background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                  }}>{i + 1}</span>
                  {i < shown.length - 1 && <span style={{ flex: 1, width: 2, background: 'var(--border)', minHeight: 8 }} />}
                </div>
                {/* Step body */}
                <div style={{ flex: 1, minWidth: 0, paddingBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>{step.title}</span>
                    <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>{step.subtotal.count} {pt ? 'agentes' : 'agents'}</span>
                    {step.subtotal.count > 0 && (
                      <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                        {fmt(workflowTokens(step.subtotal))} tok · {fmt(step.subtotal.tokensOut)} out · <strong style={{ color: 'var(--anthropic-orange)' }}>{fmtCost(step.subtotal.costUSD, currency, brlRate)}</strong>
                      </span>
                    )}
                  </div>
                  {step.agents.length === 0
                    ? <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic', marginTop: 4 }}>{pt ? 'nada rodou' : 'nothing ran'}</div>
                    : <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                        {step.agents.map((a, j) => <WfAgentRow key={j} a={a} pt={pt} currency={currency} brlRate={brlRate} />)}
                      </div>}
                </div>
              </div>
            ))}
          </div>
        )
      })()}
    </div>
  )
}

/** One agent line inside a Dynamic Workflow run: status glyph + label + model on the left,
 *  tokens + cost right-aligned, an optional tool-stats line wrapping underneath. */
function WfAgentRow({ a, pt, currency, brlRate }: { a: WorkflowAgent; pt: boolean; currency: 'USD' | 'BRL'; brlRate: number }) {
  const g = agentGlyph(a.status)
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', fontSize: 11.5 }}>
      <span style={{ color: g.color, fontWeight: 700, width: 12, flexShrink: 0 }}>{g.ch}</span>
      {/* label grows to fill the row; tokens/cost sit in fixed right columns aligned with the header */}
      <span style={{ color: 'var(--text-primary)', fontWeight: 600, wordBreak: 'break-word', flex: 1, minWidth: 120 }}>{a.label}</span>
      {a.model && <span style={{ color: 'var(--text-tertiary)', fontSize: 10.5, flexShrink: 0 }}>{formatModel(a.model)}</span>}
      <span style={{ width: 96, textAlign: 'right', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }} title={`${a.tokensIn.toLocaleString()} in · ${a.tokensOut.toLocaleString()} out · ${a.cacheRead.toLocaleString()} cache read · ${a.cacheWrite.toLocaleString()} cache write`}>{fmt(workflowTokens(a))}</span>
      <span style={{ width: 92, textAlign: 'right', color: 'var(--anthropic-orange)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtCost(a.costUSD, currency, brlRate)}</span>
      {a.toolStats && (
        <span style={{ flexBasis: '100%', paddingLeft: 20, color: 'var(--text-tertiary)', fontSize: 10.5 }}>
          {a.toolStats.readCount}r · {a.toolStats.editFileCount}e · +{a.toolStats.linesAdded}/−{a.toolStats.linesRemoved}
        </span>
      )}
    </div>
  )
}

/** A right-aligned metric column (value on top, micro-label below) for the workflow run header —
 *  fixed width so the columns line up across rows and fill the row instead of a ragged gap. */
function WfMetric({ label, value, w, accent }: { label: string; value: string; w: number; accent?: boolean }) {
  return (
    <span style={{ width: w, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1, flexShrink: 0 }}>
      <span style={{ fontSize: 12, fontWeight: accent ? 700 : 600, fontVariantNumeric: 'tabular-nums', color: accent ? 'var(--anthropic-orange)' : 'var(--text-primary)' }}>{value}</span>
      <span style={{ fontSize: 8.5, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)' }}>{label}</span>
    </span>
  )
}
