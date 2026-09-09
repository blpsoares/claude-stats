/**
 * SessionDrilldown — everything the store knows about ONE conversation, as two pieces.
 *
 * It was a modal and nothing else. It is now a HEAD (what this session is) and a BODY (what it
 * spent), because the same reading is wanted in two shapes: a centred dialog on the dashboard's
 * session lists, where there is nothing else on screen to put it beside, and a TAB IN THE RIGHT
 * ASIDE inside the sessions workspace, where the conversation stays visible next to it. A second
 * implementation of these panels is a second set of answers about the same session, which is the
 * duplication this repo is built against.
 *
 * THE LAYOUT FOLLOWS THE COLUMN, NOT THE VIEWPORT. The dense grids here — five KPIs abreast, a
 * four-column token legend, a `120px 1fr 60px 70px` tool row — were switched on `useIsMobile()`,
 * which is the right question for a dialog that is either 980px or the whole phone and the WRONG
 * one for a panel the reader drags between 280 and 900px. So the body MEASURES ITSELF
 * (`NARROW_AT`) and `isMobile` is only the answer for the one frame before the measurement, which
 * is exactly what it used to decide. `useLayoutEffect` is what keeps that frame from being seen.
 */

import React, { useLayoutEffect, useRef, useState } from 'react'
import { format, parseISO } from 'date-fns'
import {
  Clock, FileCode, GitCommit, Wrench, MessageSquare, Bot, Zap, AlertTriangle,
  CheckCircle, Circle, XCircle, Globe, Workflow as WorkflowIcon, Type } from 'lucide-react'
import type { SessionMeta, Lang, WorkflowRun } from '@agentistics/core'
import { sessionTime } from '../lib/sessionTime'
import { formatProjectName, formatModel, getModelColor, sessionLabel, fmtCost, sessionCostUSD, sessionPromptAverages } from '@agentistics/core'
import {
  TOKEN_COLORS, TOKEN_PARTS, sessionTokens, tokenHelp, tokenLabel, tokenShares,
  totalTokens as totalTokensOf, totalTokensExplained,
} from '@agentistics/core'
import { blendedCostPerToken, blendedSessionCost } from '../hooks/useData'
import { buildWorkflowSteps } from '../lib/workflowSteps'
import { fmt as fmtShort, fmtFull, workflowTokens } from '@agentistics/core'
import { PrecisionToggle } from './PrecisionToggle'
import { useIsMobile } from '../hooks/useIsMobile'

/** The statsCache's per-model volume, used only when a session names no model of its own. */
export type GlobalModelUsage = Record<string, {
  inputTokens: number; outputTokens: number
  cacheReadInputTokens: number; cacheCreationInputTokens: number
}>

/** Everything both pieces need. One shape, so a caller cannot hand the head and the body
 *  different sessions. */
export interface SessionDrilldownProps {
  session: SessionMeta
  globalModelUsage: GlobalModelUsage
  currency: 'USD' | 'BRL'
  brlRate: number
  lang: Lang
  /** All dynamic-workflow runs (from /api/data); the body shows the ones for THIS session. */
  workflows?: WorkflowRun[]
}

/**
 * Below this many pixels of CONTENT width the grids stack.
 *
 * It is the width the wide layout stops fitting in, not a device: the tool row alone spends 280px
 * on its fixed columns before the bar, and the agent row 340px. A phone (~358px of content) and a
 * narrow aside are the same problem, and the modal at 980px and a dragged-open aside are the same
 * answer.
 */
const NARROW_AT = 560


/**
 * The drawer's own wrapper: the precision toggle swaps the compact reading for the exact one.
 *
 * The compact side delegates to the shared `fmt`, which knows about billions. The local copy this
 * replaced stopped at millions, so a cached session rendered as `9809.8M` — a number nobody can
 * read at a glance, which is the entire job of a compact format.
 */
function fmt(n: number, full = false): string {
  return full ? fmtFull(n) : fmtShort(n)
}


function fmtAgentDuration(ms: number): string {
  if (ms === 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`
}


/**
 * Cost of the session on screen.
 *
 * The cache counters were HARDCODED TO ZERO here, so this drawer priced a session on the 4 % of its
 * volume that is not cache. Measured against the cockpit on the same session: USD 1,74 here against
 * a real USD 11,98 — and the drawer was the surface people opened precisely when a number looked
 * wrong. `sessionCostUSD` is the shared per-model pricing every other surface already used.
 */
function sessionCost(session: SessionMeta, globalModelUsage: GlobalModelUsage): number | null {
  // Exact per-model pricing when the session names a model — for any harness, and for a session
  // spanning several models (an Antigravity parent with its subagents folded in).
  const exact = sessionCostUSD(session)
  if (exact !== null) return exact
  // No model on this session.
  // For Claude, fall back to the statsCache blended rate (it's Claude-only data, so safe to use).
  // For any other harness, the Claude blended rate would be misleading — return null (N/A).
  const harness = session.harness ?? 'claude'
  if (harness !== 'claude') return null
  // Each counter at its own blended rate — shared with the PDF's per-session column, which had
  // the same two-term version of this arithmetic.
  return blendedSessionCost(session, blendedCostPerToken(globalModelUsage))
}

/**
 * WHAT THIS SESSION IS — the model, where it ran, when, and how long for.
 *
 * Separate from the body because the two surfaces frame it differently: the dialog gives it a
 * sticky header with a close button beside it, the aside tab has its own header already and only
 * wants the facts. `title` is what that difference comes down to — the dialog says "Session
 * details" because nothing else on screen does, and the tab does not because its own tab says so.
 */
export function SessionDrilldownHead({ session, lang, title = true }: {
  session: SessionMeta
  lang: Lang
  title?: boolean
}) {
  const pt = lang === 'pt'
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        {/* Not said twice. In the dialog nothing else on screen names what this is; in the aside
            the tab that was pressed to get here already did. */}
        {title && (
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
            {pt ? 'Detalhes da sessão' : 'Session details'}
          </span>
        )}
        {session.model && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px', borderRadius: 999,
            background: `${getModelColor(session.model)}22`,
            color: getModelColor(session.model),
            fontSize: 10, fontWeight: 600,
          }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: getModelColor(session.model) }} />
            {formatModel(session.model)}
          </span>
        )}
        {session._source && (
          <span style={{
            padding: '2px 6px', borderRadius: 4,
            background: 'var(--bg-elevated)',
            color: 'var(--text-tertiary)',
            fontSize: 9, fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}>
            {session._source}
          </span>
        )}
      </div>
      {sessionLabel(session) && (
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4, wordBreak: 'break-word' }}>
          {sessionLabel(session)}
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'ui-monospace, monospace', marginBottom: 4 }}>
        {session.session_id}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <span>{formatProjectName(session.project_path)}</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span>{session.start_time ? format(parseISO(session.start_time), 'MMM d, yyyy HH:mm') : '—'}</span>
        <span style={{ opacity: 0.4 }}>·</span>
        <span title={sessionTime(session, lang).tooltip}
          style={{ cursor: 'help' }}>
          {sessionTime(session, lang).combined}
        </span>
      </div>
    </div>
  )
}

/**
 * WHAT THIS SESSION SPENT — the figures, and every one of them with its account.
 */
export function SessionDrilldownBody({ session, globalModelUsage, currency, brlRate, lang, workflows }: SessionDrilldownProps) {
  const pt = lang === 'pt'
  /** `Lang` narrowed for the token vocabulary — `lang` is widened elsewhere in this component. */
  const tokLang: Lang = pt ? 'pt' : 'en'
  const isMobile = useIsMobile()
  const [fullPrecision, setFullPrecision] = useState(false)

  /**
   * The column this is drawn in, measured. See `NARROW_AT`.
   *
   * `null` until it has been read, and `isMobile` answers for that one frame — the same answer the
   * whole component used to give. `useLayoutEffect` runs before paint, so the corrected layout is
   * the first one anybody sees; a plain effect would flash the wide grids inside a 440px panel.
   */
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [measured, setMeasured] = useState<boolean | null>(null)
  useLayoutEffect(() => {
    const el = hostRef.current
    if (!el) return
    const read = () => setMeasured(el.getBoundingClientRect().width < NARROW_AT)
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => { ro.disconnect() }
  }, [])
  const narrow = measured ?? isMobile

  // Dynamic-workflow runs that belong to THIS session (moved here from the old aside menu).
  const sessionRuns = (workflows ?? []).filter(w => w.sessionId === session.session_id)

  // Every billed counter. This read `input + output` and reported a 9,8M-token session as 69,8K.
  const breakdown = sessionTokens(session)
  const totalTokens = totalTokensOf(breakdown)
  const shares = tokenShares(breakdown)
  const totalMessages = (session.user_message_count ?? 0) + (session.assistant_message_count ?? 0)
  /**
   * How long a typical message was, each side on its own.
   *
   * `null` where it was never measured — a record written before these fields existed, or a harness
   * whose counted event carries no text (kimi's assistant side; see `promptChars.ts`). Rendered
   * `N/A`, never `0`, because an average of zero is a claim that every message was empty.
   */
  const chars = sessionPromptAverages(session)
  const totalTools = Object.values(session.tool_counts ?? {}).reduce((a, b) => a + b, 0)
  const cost = sessionCost(session, globalModelUsage)

  // Hour distribution — build 0..23 buckets from message_hours
  const hourBuckets = Array.from({ length: 24 }, () => 0)
  for (const h of session.message_hours ?? []) {
    if (h >= 0 && h < 24) hourBuckets[h]!++
  }
  const maxHour = Math.max(...hourBuckets, 1)
  const activeHours = hourBuckets.filter(c => c > 0).length

  // Tool breakdown sorted by count
  const toolEntries = Object.entries(session.tool_counts ?? {})
    .sort((a, b) => b[1] - a[1])
  const maxToolCount = toolEntries[0]?.[1] ?? 1

  // Tool errors
  const toolErrorEntries = Object.entries(session.tool_error_categories ?? {})
    .sort((a, b) => b[1] - a[1])

  // Agent invocations
  const agentInvocations = session.agentMetrics?.invocations ?? []

  // Response time stats
  const responseTimes = session.user_response_times ?? []
  const avgResponse = responseTimes.length > 0
    ? Math.round(responseTimes.reduce((s, n) => s + n, 0) / responseTimes.length)
    : null

  return (
    <div ref={hostRef} style={{ padding: narrow ? '14px 16px' : '18px 22px', display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>

      {/* KPIs */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 6 }}>
          <PrecisionToggle full={fullPrecision} accent="var(--anthropic-orange)" onToggle={() => setFullPrecision(v => !v)} lang={lang} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: narrow ? 'repeat(auto-fit, minmax(96px, 1fr))' : 'repeat(5, 1fr)', gap: narrow ? 8 : 10 }}>
          <Kpi icon={<MessageSquare size={12} />} label={pt ? 'Mensagens' : 'Messages'} value={fmt(totalMessages, fullPrecision)} accent="var(--accent-blue, #3b82f6)" />
          <Kpi icon={<Zap size={12} />} label="Tokens" value={fmt(totalTokens, fullPrecision)} accent="var(--anthropic-orange)" title={totalTokensExplained(breakdown, tokLang)} />
          <Kpi icon={<Wrench size={12} />} label="Tool calls" value={fmt(totalTools, fullPrecision)} accent="var(--accent-green, #22c55e)" />
          {/* CHARACTERS PER MESSAGE, one tile per side. The denominator is the messages that
              actually said something — most of an assistant's records are tool calls with no
              text, and dividing by all of them read 4x low. See `promptChars.ts`. */}
          <Kpi
            icon={<Type size={12} />}
            label={pt ? 'Chars/prompt' : 'Chars/prompt'}
            value={chars.user !== null ? fmt(Math.round(chars.user), fullPrecision) : 'N/A'}
            accent="var(--accent-blue, #3b82f6)"
            title={pt
              ? 'Média de caracteres por mensagem sua, sobre as que têm texto.'
              : 'Mean characters per message you sent, over the ones with text.'}
          />
          <Kpi
            icon={<Type size={12} />}
            label={pt ? 'Chars/resposta' : 'Chars/reply'}
            value={chars.assistant !== null ? fmt(Math.round(chars.assistant), fullPrecision) : 'N/A'}
            accent="var(--accent-green, #22c55e)"
            title={pt
              ? 'Média de caracteres por resposta do assistente, sobre as que têm texto. N/A onde o harness não registra isso.'
              : 'Mean characters per assistant reply, over the ones with text. N/A where the harness does not record it.'}
          />
          <Kpi icon={<GitCommit size={12} />} label="Commits" value={String(session.git_commits ?? 0)} accent="var(--accent-purple, #a855f7)" />
          <Kpi
            icon={<span style={{ fontSize: 10, fontWeight: 800 }}>$</span>}
            label={pt ? 'Custo' : 'Cost'}
            value={cost !== null ? fmtCost(cost, currency, brlRate) : 'N/A'}
            accent="var(--anthropic-orange)"
          />
        </div>
      </div>

      {/* Token split */}
      <div style={{
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 10,
        padding: '12px 14px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>
            {pt ? 'Divisão de tokens' : 'Token breakdown'}
          </span>
          <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }} title={tokenHelp('total', tokLang)}>
            {fmt(totalTokens, fullPrecision)} {tokenLabel('total', tokLang).toLowerCase()}
          </span>
        </div>
        <div style={{ display: 'flex', height: 8, background: 'var(--bg-card)', borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
          {totalTokens > 0 && TOKEN_PARTS.map(part => (
            <div
              key={part}
              title={`${tokenLabel(part, tokLang)} — ${tokenHelp(part, tokLang)}`}
              style={{ width: `${shares[part] * 100}%`, background: TOKEN_COLORS[part] }}
            />
          ))}
        </div>
        {/* Every counter is named AND explained. The cache pair is the whole reason this number
            is what it is, and a legend of two entries used to imply the other two did not exist. */}
        <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr 1fr' : 'repeat(4, 1fr)', gap: '6px 12px', fontSize: 11 }}>
          {TOKEN_PARTS.map(part => (
            <span
              key={part}
              title={tokenHelp(part, tokLang)}
              style={{ color: TOKEN_COLORS[part], fontWeight: 600, minWidth: 0 }}
            >
              ■ {tokenLabel(part, tokLang)}: {fmt(breakdown[part], fullPrecision)}
            </span>
          ))}
        </div>
        <div style={{ marginTop: 8, fontSize: 10, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
          {totalTokensExplained(breakdown, tokLang)}
        </div>
      </div>

      {/* Tool breakdown + capabilities */}
      {toolEntries.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>
            {pt ? 'Uso de ferramentas' : 'Tool usage'}
          </div>
          <div style={{ overflowX: narrow ? 'auto' : undefined }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: narrow ? 320 : undefined }}>
            {toolEntries.slice(0, 12).map(([tool, count]) => {
              const pct = count / maxToolCount
              const tokens = session.tool_output_tokens?.[tool] ?? 0
              return (
                <div key={tool} style={{
                  display: 'grid',
                  gridTemplateColumns: '120px 1fr 60px 70px',
                  gap: 10,
                  alignItems: 'center',
                  fontSize: 11,
                }}>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {tool}
                  </span>
                  <div style={{ position: 'relative', height: 5, background: 'var(--bg-elevated)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{
                      position: 'absolute', left: 0, top: 0, bottom: 0,
                      width: `${pct * 100}%`,
                      background: 'var(--accent-green, #22c55e)',
                      opacity: 0.75,
                      borderRadius: 3,
                    }} />
                  </div>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {count}×
                  </span>
                  <span style={{ color: 'var(--text-tertiary)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {tokens > 0 ? `${fmt(tokens, fullPrecision)} tkn` : '—'}
                  </span>
                </div>
              )
            })}
            {toolEntries.length > 12 && (
              <div style={{ fontSize: 10, color: 'var(--text-tertiary)', fontStyle: 'italic', marginTop: 4 }}>
                {pt ? `+${toolEntries.length - 12} outras ferramentas` : `+${toolEntries.length - 12} more tools`}
              </div>
            )}
          </div>
          </div>
        </div>
      )}

      {/* Capabilities chips — no hardware/server icon here: MCP is a wiring detail, not a
          session metric, and it read as a stray "hardware" glyph beside the real numbers. */}
      {(session.uses_web_search || session.uses_web_fetch || session.uses_task_agent) && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {session.uses_task_agent && <Capability icon={<Bot size={10} />} label={pt ? 'Subagents' : 'Subagents'} color="var(--accent-purple, #a855f7)" />}
          {session.uses_web_search && <Capability icon={<Globe size={10} />} label="Web search" color="var(--accent-blue, #3b82f6)" />}
          {session.uses_web_fetch && <Capability icon={<Globe size={10} />} label="Web fetch" color="var(--accent-blue, #3b82f6)" />}
        </div>
      )}

      {/* Agent invocations */}
      {agentInvocations.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>
            {pt ? `Invocações de agentes (${agentInvocations.length})` : `Agent invocations (${agentInvocations.length})`}
            {session.agentMetrics && (
              <span style={{ marginLeft: 8, fontWeight: 400, color: 'var(--text-tertiary)' }}>
                {fmt(session.agentMetrics.totalTokens, fullPrecision)} tokens · {fmtCost(session.agentMetrics.totalCostUSD, currency, brlRate)} · {fmtAgentDuration(session.agentMetrics.totalDurationMs)}
              </span>
            )}
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', overflowX: narrow ? 'auto' : 'hidden' }}>
          <div style={{ minWidth: narrow ? 420 : undefined }}>
            {agentInvocations.slice(0, 20).map((inv, i) => (
              <div
                key={inv.toolUseId || i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '120px 1fr 55px 55px 70px',
                  gap: 10,
                  padding: '7px 12px',
                  alignItems: 'center',
                  borderBottom: i < Math.min(19, agentInvocations.length - 1) ? '1px solid var(--border-subtle)' : 'none',
                  background: i % 2 === 0 ? 'transparent' : 'var(--bg-elevated)',
                  fontSize: 11,
                }}
              >
                <span style={{
                  padding: '1px 7px', borderRadius: 10,
                  background: 'rgba(148,163,184,0.15)',
                  color: 'var(--text-secondary)',
                  fontSize: 10, fontWeight: 600,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {inv.agentType}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                  {/* `completed` is not the only thing that is not `failed` — a running agent
                      and one whose outcome was never recorded both drew a green tick. */}
                  {inv.status === 'failed'
                    ? <XCircle size={11} color="#ef4444" style={{ flexShrink: 0 }} />
                    : inv.status === 'completed'
                      ? <CheckCircle size={11} color="var(--accent-green, #22c55e)" style={{ flexShrink: 0 }} />
                      : <Circle size={11} color={inv.status === 'running' ? 'var(--accent-green, #22c55e)' : 'var(--text-tertiary)'} style={{ flexShrink: 0 }} />
                  }
                  <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {inv.description || <em style={{ color: 'var(--text-tertiary)' }}>—</em>}
                  </span>
                </div>
                <span title={inv.totalTokens === null ? (pt ? 'Não medido: a transcrição deste agente ainda não existe ou não está mais no disco.' : 'Not measured: this agent’s transcript does not exist yet, or is no longer on disk.') : undefined} style={{ color: inv.totalTokens === null ? 'var(--text-tertiary)' : 'var(--text-primary)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{inv.totalTokens === null ? '—' : fmt(inv.totalTokens, fullPrecision)}</span>
                <span style={{ color: 'var(--text-secondary)', textAlign: 'right' }}>{inv.totalDurationMs === null ? '—' : fmtAgentDuration(inv.totalDurationMs)}</span>
                <span style={{ color: inv.costUSD === null ? 'var(--text-tertiary)' : 'var(--anthropic-orange)', textAlign: 'right' }}>{inv.costUSD === null ? '—' : fmtCost(inv.costUSD, currency, brlRate)}</span>
              </div>
            ))}
            {agentInvocations.length > 20 && (
              <div style={{ padding: '7px 12px', fontSize: 10, color: 'var(--text-tertiary)', fontStyle: 'italic', background: 'var(--bg-elevated)' }}>
                {pt ? `+${agentInvocations.length - 20} invocações omitidas` : `+${agentInvocations.length - 20} invocations hidden`}
              </div>
            )}
          </div>
          </div>
        </div>
      )}

      {/* Dynamic Workflows that ran in THIS session (moved from the old aside menu). */}
      {sessionRuns.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <WorkflowIcon size={12} /> {pt ? `Dynamic Workflows (${sessionRuns.length})` : `Dynamic Workflows (${sessionRuns.length})`}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {sessionRuns.map(run => {
              const steps = buildWorkflowSteps(run, pt ? '(sem fase)' : '(no phase)')
              const statusColor = run.status === 'completed' ? '#22c55e' : run.status === 'partial' ? '#eab308' : '#ef4444'
              return (
                <div key={run.runId} style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg-elevated)' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>{run.name}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                      {run.totals.agentCount} {pt ? 'agentes' : 'agents'} · {fmt(workflowTokens(run.totals), fullPrecision)} tk · <strong style={{ color: 'var(--anthropic-orange)' }}>{fmtCost(run.totals.costUSD, currency, brlRate)}</strong>
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {steps.map(step => (
                      <div key={step.index} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '7px 10px', borderTop: '1px solid var(--border-subtle)', fontSize: 12 }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', minWidth: 14 }}>{step.index}</span>
                        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{step.title}</span>
                        <span style={{ color: 'var(--text-tertiary)' }}>{step.subtotal.count} {pt ? 'agentes' : 'agents'}</span>
                        <span style={{ marginLeft: 'auto', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                          {fmt(workflowTokens(step.subtotal), fullPrecision)} tk · {fmtCost(step.subtotal.costUSD, currency, brlRate)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Hour distribution + git + errors in 2 cols */}
      <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : (activeHours > 0 ? '2fr 1fr' : '1fr'), gap: 14, alignItems: 'start' }}>
        {activeHours > 0 && (
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
              {pt ? 'Distribuição por hora' : 'Hour distribution'}
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 40, background: 'var(--bg-elevated)', padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border-subtle)' }}>
              {hourBuckets.map((count, h) => {
                const pct = count / maxHour
                return (
                  <div
                    key={h}
                    title={`${h}h: ${count} ${pt ? 'mensagens' : 'messages'}`}
                    style={{
                      flex: 1,
                      height: `${Math.max(2, pct * 100)}%`,
                      background: count > 0 ? 'var(--anthropic-orange)' : 'transparent',
                      opacity: count > 0 ? 0.4 + pct * 0.6 : 0.1,
                      borderRadius: 1,
                      minHeight: 2,
                    }}
                  />
                )
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-tertiary)', marginTop: 3 }}>
              <span>00h</span>
              <span>12h</span>
              <span>23h</span>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Git stats */}
          {(session.git_commits > 0 || session.files_modified > 0) && (
            <MiniStat
              icon={<GitCommit size={11} />}
              label={pt ? 'Git' : 'Git'}
              value={
                [
                  session.git_commits > 0 ? `${session.git_commits} commits` : null,
                  session.git_pushes > 0 ? `${session.git_pushes} pushes` : null,
                  session.files_modified > 0 ? `${session.files_modified} ${pt ? 'arquivos' : 'files'}` : null,
                  (session.lines_added > 0 || session.lines_removed > 0)
                    ? `+${fmt(session.lines_added ?? 0, fullPrecision)} / -${fmt(session.lines_removed ?? 0, fullPrecision)}`
                    : null,
                ].filter(Boolean).join(' · ')
              }
              color="var(--accent-purple, #a855f7)"
            />
          )}
          {/* Response time */}
          {avgResponse !== null && (
            <MiniStat
              icon={<Clock size={11} />}
              label={pt ? 'Tempo de resposta' : 'Response time'}
              value={pt
                ? `média ${avgResponse}s · ${responseTimes.length} retornos`
                : `avg ${avgResponse}s · ${responseTimes.length} turns`}
              color="var(--text-tertiary)"
            />
          )}
          {/* Tool errors */}
          {session.tool_errors > 0 && (
            <MiniStat
              icon={<AlertTriangle size={11} />}
              label={pt ? 'Erros de ferramentas' : 'Tool errors'}
              value={`${session.tool_errors} · ${toolErrorEntries.slice(0, 3).map(([t, c]) => `${t} (${c})`).join(', ')}`}
              color="#ef4444"
            />
          )}
          {/* User interruptions */}
          {session.user_interruptions > 0 && (
            <MiniStat
              icon={<MessageSquare size={11} />}
              label={pt ? 'Interrupções' : 'Interruptions'}
              value={String(session.user_interruptions)}
              color="var(--text-tertiary)"
            />
          )}
          {/* Languages */}
          {(session.languages ?? []).length > 0 && (
            <MiniStat
              icon={<FileCode size={11} />}
              label={pt ? 'Linguagens' : 'Languages'}
              value={session.languages.slice(0, 5).join(', ')}
              color="var(--accent-blue, #3b82f6)"
            />
          )}
        </div>
      </div>

      {/* Agent instruction files read */}
      {Object.keys(session.agent_file_reads ?? {}).length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
            {pt ? 'Arquivos de instrução lidos' : 'Instruction files read'}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {Object.entries(session.agent_file_reads).map(([file, count]) => (
              <span
                key={file}
                style={{
                  padding: '3px 9px', borderRadius: 999,
                  background: 'var(--anthropic-orange-dim)',
                  color: 'var(--anthropic-orange)',
                  fontSize: 10, fontWeight: 600,
                  border: '1px solid var(--anthropic-orange)44',
                }}
              >
                {file} · {count}×
              </span>
            ))}
          </div>
        </div>
      )}

    </div>
  )
}

function Kpi({ icon, label, value, accent, title }: { icon: React.ReactNode; label: string; value: string; accent: string; title?: string }) {
  return (
    <div title={title} style={{
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 10,
      padding: '10px 12px',
      display: 'flex',
      flexDirection: 'column',
      gap: 3,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        <span style={{ color: accent, display: 'flex' }}>{icon}</span>
        {label}
      </div>
      <div style={{ fontSize: 17, fontWeight: 700, color: accent, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
    </div>
  )
}

function Capability({ icon, label, color }: { icon: React.ReactNode; label: string; color: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 9px', borderRadius: 999,
      background: `${color}1e`,
      color,
      fontSize: 11, fontWeight: 600,
      border: `1px solid ${color}33`,
    }}>
      {icon}
      {label}
    </span>
  )
}

function MiniStat({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 8,
      padding: '8px 10px',
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 8,
    }}>
      <span style={{ color, display: 'flex', flexShrink: 0, marginTop: 1 }}>{icon}</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 9, color: 'var(--text-tertiary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 1 }}>
          {label}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-primary)', wordBreak: 'break-word', lineHeight: 1.4 }}>
          {value}
        </div>
      </div>
    </div>
  )
}
