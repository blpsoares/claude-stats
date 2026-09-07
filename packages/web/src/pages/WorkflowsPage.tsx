import { runStatusText } from '../lib/workflows'
import React, { useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Workflow as WorkflowIcon, ChevronDown, ChevronRight, Search, FileCode, GitBranch } from 'lucide-react'
import type { WorkflowRun, WorkflowAgent, SessionMeta } from '@agentistics/core'
import { getModelPrice, fmtCost, fmt, sessionLabel, formatProjectName, repoShortName, workflowTokens } from '@agentistics/core'
import { DYNAMIC_WORKFLOWS_DOC } from '../lib/harness'
import { DocLink } from '../components/DocLink'
import type { AppContext } from '../lib/app-context'
import { Section } from '../components/Section'
import { getDateRangeFilter } from '../hooks/useData'
import { useIsMobile } from '../hooks/useIsMobile'

type GroupBy = 'phase' | 'model'

/** Average of input/output USD-per-1M-token rates. */
function perMillionUSD(model: string) {
  const p = getModelPrice(model)
  return (p.input + p.output) / 2
}

interface Totals { count: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number; costUSD: number }
function sumAgents(agents: WorkflowAgent[]): Totals {
  return agents.reduce<Totals>((t, a) => ({
    count: t.count + 1,
    tokensIn: t.tokensIn + a.tokensIn,
    tokensOut: t.tokensOut + a.tokensOut,
    cacheRead: t.cacheRead + a.cacheRead,
    cacheWrite: t.cacheWrite + a.cacheWrite,
    costUSD: t.costUSD + a.costUSD,
  }), { count: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0 })
}

export default function WorkflowsPage() {
  const ctx = useOutletContext<AppContext>()
  const { data, filters, lang, brlRate, currency } = ctx
  const pt = lang === 'pt'
  const rate = brlRate

  const [groupBy, setGroupBy] = useState<GroupBy>('phase')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(5)

  const sessionById = useMemo(
    () => new Map((data.sessions ?? []).map(s => [s.session_id, s] as [string, SessionMeta])),
    [data.sessions],
  )

  // Reactive to the global filter bar: date range, project, and harness (workflows are Claude-only).
  const filtered = useMemo(() => {
    const runs = data.workflows ?? []
    const { start, end } = getDateRangeFilter(filters.dateRange, filters.customStart, filters.customEnd)
    const projects = filters.projects ?? []
    const harnessSel = filters.harnesses ?? []
    const users = filters.users ?? []
    const claudeExcluded = harnessSel.length > 0 && !harnessSel.includes('claude')
    if (claudeExcluded) return []
    return runs.filter(run => {
      if (start || end) {
        const t = run.startedAt ? new Date(run.startedAt).getTime() : NaN
        if (!Number.isNaN(t)) {
          if (start && t < start.getTime()) return false
          if (end && t > end.getTime()) return false
        }
      }
      if (projects.length > 0) {
        const proj = sessionById.get(run.sessionId)?.project_path
        if (!proj || !projects.includes(proj)) return false
      }
      // Team/central: filter by owning member when a member filter is active.
      if (users.length > 0 && run.user && !users.includes(run.user)) return false
      return true
    })
  }, [data.workflows, filters.dateRange, filters.customStart, filters.customEnd, filters.projects, filters.harnesses, filters.users, sessionById])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 18, fontWeight: 700, color: 'var(--text-primary)' }}>
          <span style={{ color: 'var(--anthropic-orange)' }}><WorkflowIcon size={16} /></span>
          Dynamic Workflows
          <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-tertiary)' }}>({filtered.length})</span>
          <DocLink href={DYNAMIC_WORKFLOWS_DOC} title={pt ? 'O que é Dynamic Workflows? (doc da Anthropic)' : 'What is Dynamic Workflows? (Anthropic docs)'} size={14} />
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          {pt
            ? 'Execuções de workflow: agrupe por fase ou modelo, com totais por grupo e do workflow.'
            : 'Workflow runs: group by phase or model, with per-group and per-run totals.'}
        </div>
      </div>

      {/* Controls: grouping + agent search (applies inside every run) */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', margin: '4px 0 12px' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)', alignSelf: 'center', marginRight: 4 }}>{pt ? 'Agrupar:' : 'Group:'}</span>
          {(['phase', 'model'] as GroupBy[]).map(g => (
            <button key={g} onClick={() => setGroupBy(g)} style={pill(groupBy === g)}>
              {g === 'phase' ? (pt ? 'Fase' : 'Phase') : (pt ? 'Modelo' : 'Model')}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 180, maxWidth: 320, border: '1px solid var(--border)', borderRadius: 8, padding: '5px 9px', background: 'var(--bg-elevated)' }}>
          <Search size={13} style={{ color: 'var(--text-tertiary)' }} />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={pt ? 'Filtrar agentes (label ou modelo)…' : 'Filter agents (label or model)…'}
            style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text-primary)', fontSize: 12, fontFamily: 'inherit' }}
          />
        </div>
      </div>

      {filtered.length === 0
        ? (
          <Section flashId="wf-empty" title={pt ? 'Nenhum workflow' : 'No workflows'}>
            <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '8px 2px' }}>
              {pt ? 'Nenhuma execução de workflow para os filtros atuais.' : 'No workflow runs for the current filters.'}
            </div>
          </Section>
        )
        : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {filtered.slice(safePage * pageSize, safePage * pageSize + pageSize).map(run => (
                <RunBlock key={run.runId} run={run} pt={pt} rate={rate} currency={currency} groupBy={groupBy} query={query.trim().toLowerCase()} sessionById={sessionById} />
              ))}
            </div>
            <Pagination
              pt={pt}
              page={safePage}
              pageCount={pageCount}
              pageSize={pageSize}
              total={filtered.length}
              onPage={setPage}
              onPageSize={n => { setPageSize(n); setPage(0) }}
            />
          </>
        )}
    </>
  )
}

const PAGE_SIZES = [5, 10, 20, 50] as const

function Pagination({ pt, page, pageCount, pageSize, total, onPage, onPageSize }: {
  pt: boolean; page: number; pageCount: number; pageSize: number; total: number
  onPage: (p: number) => void; onPageSize: (n: number) => void
}) {
  const from = total === 0 ? 0 : page * pageSize + 1
  const to = Math.min(total, page * pageSize + pageSize)
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginTop: 16 }}>
      <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
        {from}–{to} {pt ? 'de' : 'of'} {total}
      </span>
      <div style={{ display: 'flex', gap: 4, marginLeft: 'auto', alignItems: 'center' }}>
        <button onClick={() => onPage(Math.max(0, page - 1))} disabled={page === 0} style={pageBtn(false, page === 0)}>‹</button>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '0 6px' }}>{page + 1}/{pageCount}</span>
        <button onClick={() => onPage(Math.min(pageCount - 1, page + 1))} disabled={page >= pageCount - 1} style={pageBtn(false, page >= pageCount - 1)}>›</button>
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)', alignSelf: 'center', marginRight: 2 }}>{pt ? 'por página' : 'per page'}</span>
        {PAGE_SIZES.map(n => (
          <button key={n} onClick={() => onPageSize(n)} style={pill(pageSize === n)}>{n}</button>
        ))}
      </div>
    </div>
  )
}

function pageBtn(active: boolean, disabled: boolean): React.CSSProperties {
  return {
    padding: '3px 9px', borderRadius: 6, fontSize: 13, cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit',
    border: '1px solid var(--border)', background: 'var(--bg-elevated)',
    color: disabled ? 'var(--text-tertiary)' : 'var(--text-secondary)', opacity: disabled ? 0.5 : 1,
  }
}

function RunBlock({ run, pt, rate, currency, groupBy, query, sessionById }: {
  run: WorkflowRun; pt: boolean; rate: number; currency: 'USD' | 'BRL'; groupBy: GroupBy; query: string; sessionById: Map<string, SessionMeta>
}) {
  const [open, setOpen] = useState(true)
  // Same palette as the sessions aside and the repo page. The old expression painted anything that
  // was not completed/partial red, so a RUNNING workflow read as a failure.
  const runState = runStatusText(run.status, pt)
  const statusColor = runState.color
  const s = sessionById.get(run.sessionId)
  const sessionDisplay = s ? sessionLabel(s) : run.sessionId.slice(0, 8)
  const project = s?.project_path ? formatProjectName(s.project_path) : ''
  // Repo shown only when the session is linked to a git remote; omitted otherwise.
  const repo = s?.git_remote ? repoShortName(s.git_remote) : ''

  // Apply the in-tab agent search, then group.
  const agents = useMemo(() => {
    if (!query) return run.agents
    return run.agents.filter(a => a.label.toLowerCase().includes(query) || a.model.toLowerCase().includes(query))
  }, [run.agents, query])

  const groups = useMemo(() => {
    const map = new Map<string, WorkflowAgent[]>()
    for (const a of agents) {
      const key = groupBy === 'phase'
        ? (a.phase || (pt ? '(sem fase)' : '(no phase)'))
        : (a.model || (pt ? '(sem modelo)' : '(no model)'))
      const arr = map.get(key) ?? []
      arr.push(a)
      map.set(key, arr)
    }
    // Order phases by the run's declared order; models by descending cost.
    const entries = [...map.entries()]
    if (groupBy === 'phase') {
      const order = new Map(run.phases.map((p, i) => [p.title, i]))
      entries.sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999))
    } else {
      entries.sort((a, b) => sumAgents(b[1]).costUSD - sumAgents(a[1]).costUSD)
    }
    return entries
  }, [agents, groupBy, run.phases, pt])

  const total = useMemo(() => sumAgents(agents), [agents])

  if (query && agents.length === 0) return null

  return (
    <Section
      flashId={`wf-${run.runId}`}
      title={
        <span onClick={() => setOpen(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', flexWrap: 'wrap' }}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {/* A colour alone cannot carry five states — the word rides the title. */}
          <span title={runState.text} style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor }} />
          <span style={{ fontWeight: 700 }}>{run.name}</span>
          {run.user && (
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--anthropic-orange)', background: 'var(--anthropic-orange-dim)', border: '1px solid rgba(217,119,6,0.3)', borderRadius: 5, padding: '1px 7px' }}>{run.user}</span>
          )}
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 400 }}>{pt ? 'sessão' : 'session'}: {sessionDisplay}</span>
          {project && (
            <span title={project} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 400, color: 'var(--text-tertiary)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <FileCode size={11} style={{ flexShrink: 0 }} /> {project}
            </span>
          )}
          {repo && (
            <span title={repo} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 400, color: 'var(--text-tertiary)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <GitBranch size={11} style={{ flexShrink: 0 }} /> {repo}
            </span>
          )}
        </span>
      }
    >
      {/* Per-run overall totals — one clean strip with divided cells and tabular numbers */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'stretch',
        border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-elevated)',
        marginBottom: 12, overflow: 'hidden',
      }}>
        <Stat label={pt ? 'Agentes' : 'Agents'} value={String(total.count)} />
        <Stat label="Tokens" value={fmt(workflowTokens(total))} />
        <Stat label="In" value={fmt(total.tokensIn)} />
        <Stat label="Out" value={fmt(total.tokensOut)} />
        <Stat label="Cache" value={fmt(total.cacheRead + total.cacheWrite)} />
        <Stat label={pt ? 'Custo' : 'Cost'} value={fmtCost(total.costUSD, currency, rate)} accent />
        {run.durationMs > 0 && <Stat label={pt ? 'Duração' : 'Duration'} value={fmtDur(run.durationMs)} />}
        {run.totals.toolUses > 0 && <Stat label="Tools" value={fmt(run.totals.toolUses)} />}
      </div>

      {/* Animated collapse — glides open/closed instead of snapping. */}
      <div style={{ display: 'grid', gridTemplateRows: open ? '1fr' : '0fr', transition: 'grid-template-rows 0.28s cubic-bezier(0.22, 1, 0.36, 1)' }}>
        <div style={{ overflow: 'hidden', minHeight: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 2 }}>
            {groups.map(([groupKey, groupAgents]) => {
              const sub = sumAgents(groupAgents)
              return (
                <div key={groupKey} style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--bg-elevated)' }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>{groupKey}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{sub.count} {pt ? 'agentes' : 'agents'}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                      {fmt(workflowTokens(sub))} tok · {fmt(sub.tokensOut)} out · <strong style={{ color: 'var(--anthropic-orange)' }}>{fmtCost(sub.costUSD, currency, rate)}</strong>
                    </span>
                  </div>
                  <AgentTable agents={groupAgents} pt={pt} rate={rate} currency={currency} />
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </Section>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{
      flex: '1 1 90px', minWidth: 90, padding: '7px 12px',
      borderRight: '1px solid var(--border)',
    }}>
      <div style={{ fontSize: 9.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>{label}</div>
      <div style={{
        fontSize: 15, fontWeight: 700, lineHeight: 1.3, fontVariantNumeric: 'tabular-nums',
        color: accent ? 'var(--anthropic-orange)' : 'var(--text-primary)',
      }}>{value}</div>
    </div>
  )
}

function AgentTable({ agents, pt, rate, currency }: { agents: WorkflowAgent[]; pt: boolean; rate: number; currency: 'USD' | 'BRL' }) {
  const isMobile = useIsMobile()

  // Mobile: stacked cards instead of a horizontally-scrolling table.
  if (isMobile) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {agents.map((a, i) => (
          <div key={i} style={{ padding: '10px 10px', borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', wordBreak: 'break-word' }}>{a.label}</div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>{a.model || '—'}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 6, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ color: 'var(--text-secondary)' }}>In <strong style={{ color: 'var(--text-primary)' }}>{a.tokensIn.toLocaleString()}</strong></span>
              <span style={{ color: 'var(--text-secondary)' }}>Out <strong style={{ color: 'var(--text-primary)' }}>{a.tokensOut.toLocaleString()}</strong></span>
              <span style={{ color: 'var(--text-secondary)' }}>{pt ? 'Cache' : 'Cache'} <strong style={{ color: 'var(--text-primary)' }}>{(a.cacheRead + a.cacheWrite).toLocaleString()}</strong></span>
              <span style={{ color: 'var(--text-secondary)' }}>{pt ? 'Custo' : 'Cost'} <strong style={{ color: 'var(--anthropic-orange)' }}>{fmtCost(a.costUSD, currency, rate)}</strong></span>
              {a.model && <span style={{ color: 'var(--text-tertiary)' }}>{fmtCost(perMillionUSD(a.model), currency, rate)}/M</span>}
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ color: 'var(--text-tertiary)', textAlign: 'left' }}>
            <th style={cell}>{pt ? 'Agente' : 'Agent'}</th>
            <th style={cell}>{pt ? 'Modelo' : 'Model'}</th>
            <th style={cellR}>In</th>
            <th style={cellR}>Out</th>
            <th style={cellR}>Cache R</th>
            <th style={cellR}>Cache W</th>
            <th style={cellR}>{pt ? 'Custo' : 'Cost'}</th>
            <th style={cellR}>{pt ? 'Custo/M' : 'Cost/M'}</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a, i) => (
            <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={cell}>{a.label}</td>
              <td style={cell}>{a.model || '—'}</td>
              <td style={cellR}>{a.tokensIn.toLocaleString()}</td>
              <td style={cellR}>{a.tokensOut.toLocaleString()}</td>
              <td style={cellR}>{a.cacheRead.toLocaleString()}</td>
              <td style={cellR}>{a.cacheWrite.toLocaleString()}</td>
              <td style={cellR}>{fmtCost(a.costUSD, currency, rate)}</td>
              <td style={cellR}>{a.model ? fmtCost(perMillionUSD(a.model), currency, rate) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`
}

function pill(active: boolean): React.CSSProperties {
  return {
    padding: '5px 12px', borderRadius: 7, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
    border: '1px solid var(--border)',
    background: active ? 'var(--anthropic-orange-dim, rgba(205,93,56,0.12))' : 'var(--bg-elevated)',
    color: active ? 'var(--anthropic-orange, #cd5d38)' : 'var(--text-secondary)',
    fontWeight: active ? 600 : 500,
  }
}

const cell: React.CSSProperties = { padding: '6px 8px' }
const cellR: React.CSSProperties = { padding: '6px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
