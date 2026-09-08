/**
 * ScopedSessions.tsx — the session list a REPOSITORY or a PROJECT shows.
 *
 * These two places used to render `RecentSessions`, which is the dashboard's full session BROWSER:
 * group-by (none/status/repo/project/harness/model/marked), a status filter, a six-key sort, a
 * search field, a list-or-grid toggle, per-row pins, and a drilldown modal. Inside a tab that is
 * already scoped to one repository, nearly all of that re-asks a question the page has already
 * answered — "group by repo" under a repo, "filter by project" under a project — and it costs the
 * whole width and about eight rows of vertical chrome before the first session appears. On a phone
 * that was the entire first screen.
 *
 * So this is the two things the tab is actually for: WHAT EACH SESSION SPENT, and THE WAY IN. The
 * way in is the sessions workspace (`/sessions/:id`) and not the drilldown modal, because the
 * workspace is where a session is read, continued and acted on — a modal here would be a second,
 * poorer reader for a conversation the product already has a home for. A session the fleet no
 * longer holds is not a broken link: that page says so in a sentence of its own.
 *
 * Nothing here filters or sorts by anything the caller did not already decide, with one exception —
 * `MORE_STEP` reveals more rows. That is paging, not a question: a repository with 300 sessions
 * cannot be one list, and the button says how many are left rather than silently truncating.
 */
import React, { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, Clock } from 'lucide-react'
import {
  calcCost, fmt, fmtCost, formatModel, sessionCostUSD, sessionLabel, sessionTokens,
  sessionTokenTotal, totalTokensExplained, type HarnessId, type SessionMeta,
} from '@agentistics/core'
import { HARNESS_COLORS, HARNESS_LABELS } from '../lib/harness'
import { useIsMobile } from '../hooks/useIsMobile'

/** How many more rows one press of the reveal button adds. */
const MORE_STEP = 30
/** How many rows the list opens with. */
const FIRST_PAGE = 20

/** Cost of one session, priced per model; the blended-free fallback prices all four counters at
 *  the unknown-model rate rather than pricing cache as fresh input (~10x too high). Mirrors
 *  `sessCost` in RepoDetailPage — the same rule, not a second one. */
function sessionCost(s: SessionMeta): number {
  const byModel = sessionCostUSD(s)
  if (byModel !== null) return byModel
  return calcCost({
    inputTokens: s.input_tokens ?? 0,
    outputTokens: s.output_tokens ?? 0,
    cacheReadInputTokens: s.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: s.cache_creation_input_tokens ?? 0,
    webSearchRequests: 0,
    costUSD: 0,
  }, '')
}

function fmtDay(iso: string, pt: boolean): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return '—'
  return d.toLocaleDateString(pt ? 'pt-BR' : 'en-US', { day: '2-digit', month: 'short' })
    + ' ' + d.toLocaleTimeString(pt ? 'pt-BR' : 'en-US', { hour: '2-digit', minute: '2-digit' })
}

/** Active minutes as a duration, or `—`. Never a 0: a session with no usable timing has not been
 *  measured at zero, it has not been measured (see `SessionMeta.active_minutes`). */
function fmtActive(min: number | undefined, pt: boolean): string {
  if (min === undefined) return '—'
  if (min < 60) return `${Math.round(min)}min`
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`
}

function Metric({ label, value, title, accent }: {
  label: string; value: string; title?: string; accent?: boolean
}) {
  return (
    <div title={title} style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      <span style={{
        fontSize: 12.5, fontWeight: 700, fontVariantNumeric: 'tabular-nums',
        color: accent ? 'var(--anthropic-orange)' : 'var(--text-primary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{value}</span>
      <span style={{
        fontSize: 9.5, color: 'var(--text-tertiary)', textTransform: 'uppercase',
        letterSpacing: '0.05em', whiteSpace: 'nowrap',
      }}>{label}</span>
    </div>
  )
}

interface Props {
  sessions: SessionMeta[]
  lang: 'pt' | 'en'
  currency: 'USD' | 'BRL'
  brlRate: number
}

export function ScopedSessions({ sessions, lang, currency, brlRate }: Props) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const [shown, setShown] = useState(FIRST_PAGE)

  // Most recent first. The caller decided WHICH sessions; the only ordering that needs no control
  // beside it is the one every reader assumes.
  const ordered = useMemo(
    () => [...sessions].sort((a, b) => (b.start_time || '').localeCompare(a.start_time || '')),
    [sessions],
  )

  if (ordered.length === 0) {
    return (
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '18px 2px', lineHeight: 1.6 }}>
        {pt ? 'Nenhuma sessão neste recorte.' : 'No sessions in this scope.'}
      </div>
    )
  }

  const rest = ordered.length - shown

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {ordered.slice(0, shown).map(s => {
        const harness = (s.harness ?? 'claude') as HarnessId
        const tokens = sessionTokenTotal(s)
        const messages = (s.user_message_count ?? 0) + (s.assistant_message_count ?? 0)
        const tools = Object.values(s.tool_counts ?? {}).reduce((a, b) => a + b, 0)
        return (
          <Link
            key={s.session_id}
            to={`/sessions/${encodeURIComponent(s.session_id)}`}
            title={pt ? 'Abrir em Sessões' : 'Open in Sessions'}
            style={{
              display: 'flex', alignItems: 'center', gap: 12, textDecoration: 'none',
              padding: isMobile ? '11px 12px' : '10px 14px',
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)', color: 'inherit', minWidth: 0,
            }}
          >
            <span style={{
              display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0,
              // The identity column is the one that gives way; every metric beside it is a short,
              // fixed-width figure and would only ellipsis into uselessness.
              flex: '1 1 auto',
            }}>
              <span style={{
                fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{sessionLabel(s)}</span>
              <span style={{
                display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                fontSize: 10.5, color: 'var(--text-tertiary)',
              }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' }}>
                  <Clock size={10} /> {fmtDay(s.start_time, pt)}
                </span>
                <span style={{ color: HARNESS_COLORS[harness] ?? 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                  {HARNESS_LABELS[harness] ?? harness}
                </span>
                {s.model && <span style={{ whiteSpace: 'nowrap' }}>{formatModel(s.model)}</span>}
              </span>
            </span>

            {/* The metrics. A wrapping row rather than a grid: it has no cell count, so it cannot
                strand a lone figure on a second line at any width. */}
            <span style={{
              display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
              gap: isMobile ? 14 : 18, flexWrap: 'wrap', flexShrink: 0,
            }}>
              <Metric label={pt ? 'Custo' : 'Cost'} value={fmtCost(sessionCost(s), currency, brlRate)} accent />
              <Metric
                label="Tokens"
                value={fmt(tokens)}
                title={totalTokensExplained(sessionTokens(s), lang)}
              />
              {!isMobile && <Metric label={pt ? 'Mensagens' : 'Messages'} value={fmt(messages)} />}
              {!isMobile && <Metric label={pt ? 'Ferramentas' : 'Tools'} value={fmt(tools)} />}
              <Metric label={pt ? 'Tempo ativo' : 'Active time'} value={fmtActive(s.active_minutes, pt)} />
            </span>

            <ChevronRight size={16} color="var(--text-tertiary)" style={{ flexShrink: 0 }} />
          </Link>
        )
      })}

      {rest > 0 && (
        <button
          onClick={() => setShown(n => n + MORE_STEP)}
          style={{
            alignSelf: 'center', marginTop: 4, padding: isMobile ? '11px 18px' : '7px 16px',
            minHeight: isMobile ? 44 : undefined,
            borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-elevated)',
            color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12.5, cursor: 'pointer',
          }}
        >
          {pt ? `Mostrar mais ${Math.min(rest, MORE_STEP)} · faltam ${rest}` : `Show ${Math.min(rest, MORE_STEP)} more · ${rest} left`}
        </button>
      )}
    </div>
  )
}
