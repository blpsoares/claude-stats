/**
 * RepoTasksTab — the deliveries that touched one repository.
 *
 * It is a READ view. Every verb a task has — status, claim, comments, subtasks, files — lives on
 * the board, and a row here opens it. Wiring the board's operating surface into this tab would be a
 * second copy of the `TasksPage` controller, and two controllers for one gesture is exactly the bug
 * `task-reopen.ts` exists to have fixed once.
 *
 * It computes nothing about a delivery: every figure arrives already decided from `/api/tasks`,
 * scoped to this repository by the same filter that scopes every other tab of the page. What it
 * owns is the honesty of the rendering — a `null` is `N/A` and never `0`, an open task shows no
 * delivery date, and a task that also spent Copilot credits says so rather than letting a dollar
 * figure read as the whole bill.
 */

import { useMemo, type CSSProperties } from 'react'
import { SquareArrowOutUpRight } from 'lucide-react'
import { fmtCost, sortRows, type SortSpec } from '@agentistics/core'
import { useIsMobile } from '../../hooks/useIsMobile'
import type { TaskListRow } from '../../lib/tasks'
import {
  NA, PRIORITY, STATUS, fmtInt, fmtTokens, harnessColor, microLabel, numeric, pill, surface,
  type BoardStatus,
} from './board'
import { TaskProgressBar } from './TaskProgressBar'

/**
 * Most recently touched first.
 *
 * The board's own default is the MANUAL order, which on a subset that was never dragged falls back
 * to creation date and puts the oldest delivered task at the top — the wrong first row for a
 * question about what is happening in this repository. It still goes through the shared `sortRows`:
 * this view picks a key, it does not invent an ordering.
 */
const REPO_SORT: SortSpec = { key: 'updated', dir: 'desc' }

export interface RepoTasksTabProps {
  /** Already narrowed to this repository by `tasksOfRepo`. */
  rows: TaskListRow[]
  lang: 'pt' | 'en'
  currency: 'USD' | 'BRL'
  brlRate: number
  onOpen: (taskId: string) => void
}

/** A local day, formatted the way the rest of the dashboard writes a date. */
function fmtDay(iso: string | undefined, lang: 'pt' | 'en'): string | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return new Date(t).toLocaleDateString(lang === 'pt' ? 'pt-BR' : 'en-US', {
    day: '2-digit', month: 'short',
  })
}

function StatusPill({ status }: { status: string }) {
  const s = STATUS[status as BoardStatus] ?? STATUS.backlog
  return <span style={{ ...pill(s.color), background: s.dim }}>{s.label}</span>
}

function Harnesses({ harnesses }: { harnesses: string[] }) {
  if (harnesses.length === 0) return <span style={{ color: 'var(--text-tertiary)' }}>{NA}</span>
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {harnesses.map(h => (
        <span key={h} style={{ ...pill(harnessColor(h)), fontSize: 10 }}>{h}</span>
      ))}
    </span>
  )
}

export function RepoTasksTab(p: RepoTasksTabProps) {
  const isMobile = useIsMobile()
  const pt = p.lang === 'pt'
  const rows = useMemo(() => sortRows(p.rows, REPO_SORT), [p.rows])
  const cost = (n: number | null) => (n === null ? NA : fmtCost(n, p.currency, p.brlRate))

  if (rows.length === 0) {
    return (
      <div style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: 20, textAlign: 'center', lineHeight: 1.6 }}>
        {pt
          ? 'Nenhuma entrega tocou este repositório na janela selecionada. Uma task pertence a um repositório pelas sessões filiadas a ela.'
          : 'No delivery touched this repository in the selected window. A task belongs to a repository through the sessions filed under it.'}
      </div>
    )
  }

  // ------------------------------------------------------------------ mobile: the same rows, as cards
  if (isMobile) {
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        {rows.map(r => {
          const prio = PRIORITY[r.task.priority ?? 'none'] ?? PRIORITY.none!
          return (
            <button
              key={r.task.id}
              onClick={() => p.onOpen(r.task.id)}
              style={{
                ...surface, padding: 12, display: 'grid', gap: 8, textAlign: 'left', width: '100%',
                minHeight: 44, color: 'var(--text-primary)', cursor: 'pointer', font: 'inherit',
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <StatusPill status={r.task.status} />
                {r.task.priority && r.task.priority !== 'none' && (
                  <span style={{ ...pill(prio.color), background: prio.dim, fontSize: 10 }}>{prio.label}</span>
                )}
              </div>
              <span style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.35 }}>{r.task.title}</span>
              {r.counts.subtasks > 0 && (
                <TaskProgressBar done={r.counts.subtasksDone} total={r.counts.subtasks} />
              )}
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', ...numeric, fontSize: 11.5 }}>
                <span>{fmtInt(r.rollup.sessionsLinked)} <span style={microLabel}>{pt ? 'sessões' : 'sessions'}</span></span>
                <span>{fmtInt(r.rollup.rounds)} <span style={microLabel}>{pt ? 'rodadas' : 'rounds'}</span></span>
                <span>{fmtTokens(r.rollup.tokens)} <span style={microLabel}>tokens</span></span>
                <span style={{ color: 'var(--anthropic-orange)' }}>{cost(r.rollup.costUSD)}</span>
              </div>
              <Harnesses harnesses={r.harnesses} />
            </button>
          )
        })}
      </div>
    )
  }

  // ------------------------------------------------------------------ desktop: a table, scrolling in its own box
  const th: CSSProperties = {
    ...microLabel, textAlign: 'left', padding: '7px 10px', fontWeight: 600,
    borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
  }
  const td: CSSProperties = {
    padding: '8px 10px', fontSize: 12.5, borderBottom: '1px solid var(--border)',
    verticalAlign: 'middle',
  }
  const tdNum: CSSProperties = { ...td, ...numeric, textAlign: 'right' }

  return (
    <div style={{ ...surface, overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 780 }}>
        <thead>
          <tr>
            <th style={th}>{pt ? 'Entrega' : 'Delivery'}</th>
            <th style={th}>Status</th>
            <th style={th}>{pt ? 'Progresso' : 'Progress'}</th>
            <th style={{ ...th, textAlign: 'right' }}>{pt ? 'Sessões' : 'Sessions'}</th>
            <th style={{ ...th, textAlign: 'right' }}>{pt ? 'Rodadas' : 'Rounds'}</th>
            <th style={{ ...th, textAlign: 'right' }}>Tokens</th>
            <th style={{ ...th, textAlign: 'right' }}>{pt ? 'Custo' : 'Cost'}</th>
            <th style={th}>Harnesses</th>
            <th style={th}>{pt ? 'Entregue em' : 'Delivered'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const delivered = fmtDay(r.task.deliveredAt, p.lang)
            return (
              <tr
                key={r.task.id}
                onClick={() => p.onOpen(r.task.id)}
                style={{ cursor: 'pointer' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
              >
                <td style={{ ...td, maxWidth: 320 }}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600,
                    color: 'var(--text-primary)',
                  }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 290 }}>
                      {r.task.title}
                    </span>
                    <SquareArrowOutUpRight size={11} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                  </span>
                </td>
                <td style={td}><StatusPill status={r.task.status} /></td>
                <td style={{ ...td, minWidth: 120 }}>
                  {r.counts.subtasks > 0
                    ? <TaskProgressBar done={r.counts.subtasksDone} total={r.counts.subtasks} />
                    : <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>—</span>}
                </td>
                {/* `sessionsLinked`, not `sessionsUsed`: a row with no conversation link named no
                    repository and contributed no numbers, so counting it here would place a session
                    in a repository nothing observed it in. */}
                <td style={tdNum}>{fmtInt(r.rollup.sessionsLinked)}</td>
                <td style={tdNum}>{fmtInt(r.rollup.rounds)}</td>
                <td style={tdNum}>{fmtTokens(r.rollup.tokens)}</td>
                <td style={{ ...tdNum, color: 'var(--anthropic-orange)' }}>{cost(r.rollup.costUSD)}</td>
                <td style={td}><Harnesses harnesses={r.harnesses} /></td>
                {/* An open task has no delivery date — "still running" is not a date, and a
                    duration "so far" beside a delivered one reads as the same measurement. */}
                <td style={{ ...td, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                  {delivered ?? <span style={{ color: 'var(--text-tertiary)' }}>—</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
