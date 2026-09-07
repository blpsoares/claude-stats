/**
 * board.ts — the board's visual vocabulary, in one place.
 *
 * Styles live here rather than inline in the page because a board is a grid of the SAME card
 * repeated: a card, a column, a chip and a status cell defined once are what make it read as one
 * surface instead of a stack of boxes. It also keeps the page file about behaviour.
 *
 * Every colour is a token from `index.css` — `--text-primary`, `--bg-card`, `--bg-elevated` and
 * friends. An earlier draft of this screen invented `--text` and `--bg`, which do not exist, so half
 * its colours silently fell back to the browser default and the whole thing read as unstyled.
 */

import type { CSSProperties } from 'react'
import { HARNESS_COLORS } from '../../lib/harness'
import type { HarnessId } from '@agentistics/core'

export type BoardStatus =
  | 'backlog' | 'todo' | 'in_progress' | 'blocked' | 'in_review' | 'done' | 'abandoned'

/**
 * The table's columns, named HERE rather than in `TaskTable`.
 *
 * `boardPrefs` stores which of them are shown, so it needs the name — and importing it from
 * `TaskTable`, which imports `boardPrefs` back, made the two modules a CYCLE. Today it is erased
 * (the import is `import type`, so nothing of it survives the bundle), but that safety rests
 * entirely on one keyword: the day somebody imports a VALUE across it, `boardPrefs`'s module-scope
 * `DEFAULT_PREFS` can be evaluated before the constants it reads, which is a temporal-dead-zone
 * crash at load with no clue in it pointing here. `board.ts` imports nothing local, so a name that
 * lives here can never close a loop.
 */
export type ColumnId =
  | 'status' | 'priority' | 'assignee' | 'due' | 'claim' | 'attempts' | 'sessions' | 'rounds'
  | 'tokens' | 'cost' | 'harnesses' | 'subtasks' | 'comments' | 'files' | 'links' | 'blockedBy'
  | 'created' | 'updated'

/**
 * A status has a colour and it is the SAME colour everywhere — the column header, the card's stripe
 * and the table's status cell. Monday's whole legibility trick is that a status is a colour you
 * learn once.
 */
export const STATUS: Record<BoardStatus, { label: string; color: string; dim: string }> = {
  backlog: { label: 'Backlog', color: 'var(--text-tertiary)', dim: 'var(--border)' },
  todo: { label: 'To do', color: 'var(--accent-blue)', dim: 'var(--accent-blue-dim)' },
  in_progress: { label: 'In progress', color: 'var(--anthropic-orange)', dim: 'var(--anthropic-orange-dim)' },
  // Red, and the only red on the board. Blocked is the one column somebody has to go and act on.
  blocked: { label: 'Blocked', color: 'var(--accent-red)', dim: 'var(--accent-red-dim)' },
  in_review: { label: 'In review', color: 'var(--accent-purple)', dim: 'rgba(139, 92, 246, 0.14)' },
  done: { label: 'Done', color: 'var(--accent-green)', dim: 'var(--accent-green-dim)' },
  abandoned: { label: 'Abandoned', color: 'var(--text-tertiary)', dim: 'var(--border)' },
}

/**
 * Priority reads as a COLOUR and a word, and `none` is deliberately grey and last.
 *
 * `none` means "nobody has said", which is not the same as `low` — a board full of `medium` because
 * something had to be the default is a board where priority means nothing. Only `urgent` gets the
 * alarm colour, and it is the same red `blocked` uses: both mean somebody has to act.
 */
export const PRIORITY: Record<string, { label: string; short: string; color: string; dim: string }> = {
  urgent: { label: 'Urgent', short: 'U', color: 'var(--accent-red)', dim: 'var(--accent-red-dim)' },
  high: { label: 'High', short: 'H', color: 'var(--anthropic-orange)', dim: 'var(--anthropic-orange-dim)' },
  medium: { label: 'Medium', short: 'M', color: 'var(--accent-blue)', dim: 'var(--accent-blue-dim)' },
  low: { label: 'Low', short: 'L', color: 'var(--text-tertiary)', dim: 'var(--border)' },
  none: { label: 'Unset', short: '—', color: 'var(--text-tertiary)', dim: 'transparent' },
}

/**
 * How long a claim has left, in words — or that it has run out.
 *
 * An EXPIRED lease is said out loud rather than hidden: the task is available again, and a card
 * that simply stopped showing a holder would read as one nobody ever took.
 */
export function claimLeft(expiresAt: string, nowMs: number): { text: string; expired: boolean } {
  const ms = Date.parse(expiresAt) - nowMs
  // An unparseable expiry reads as expired, matching `claimState` on the server: a claim nobody can
  // date is a claim nobody can revoke.
  if (!Number.isFinite(ms)) return { text: 'lease unknown', expired: true }
  if (ms <= 0) return { text: 'lease expired', expired: true }
  const mins = Math.round(ms / 60000)
  if (mins < 60) return { text: `${Math.max(1, mins)}m left`, expired: false }
  return { text: `${Math.round(mins / 60)}h left`, expired: false }
}

/** Left to right, the way work moves. */
export const COLUMN_ORDER: BoardStatus[] =
  ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'done', 'abandoned']

/** How a live session reads on a task's row — the fleet's own vocabulary, not a second one. */
export const SESSION_STATE: Record<string, { label: string; color: string }> = {
  working: { label: 'working', color: 'var(--accent-green)' },
  waiting: { label: 'waiting', color: 'var(--accent-blue)' },
  // The one that must catch the eye: a person is blocking this session right now.
  'waiting-approval': { label: 'needs you', color: 'var(--anthropic-orange)' },
  exited: { label: 'finished', color: 'var(--text-tertiary)' },
  closed: { label: 'closed', color: 'var(--text-tertiary)' },
  lost: { label: 'lost', color: 'var(--accent-red)' },
  unknown: { label: 'unknown', color: 'var(--text-tertiary)' },
}

export const harnessColor = (h: string): string =>
  HARNESS_COLORS[h as HarnessId] ?? 'var(--text-tertiary)'

export const surface: CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
}

export const cardStyle: CSSProperties = {
  ...surface,
  padding: 12,
  display: 'grid',
  gap: 8,
  textAlign: 'left',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  width: '100%',
  transition: 'background 0.12s, transform 0.12s',
}

/** The micro-label the whole dashboard uses over a number. */
export const microLabel: CSSProperties = {
  fontSize: 9.5,
  color: 'var(--text-tertiary)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
}

export const numeric: CSSProperties = {
  fontSize: 12.5,
  fontWeight: 600,
  color: 'var(--text-secondary)',
  fontVariantNumeric: 'tabular-nums',
}

export const pill = (color?: string): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 8px',
  borderRadius: 999,
  fontSize: 10.5,
  lineHeight: 1.6,
  whiteSpace: 'nowrap',
  background: 'var(--bg-elevated)',
  border: `1px solid ${color ?? 'var(--border)'}`,
  color: color ?? 'var(--text-tertiary)',
})

export const field = (mobile: boolean): CSSProperties => ({
  width: '100%',
  padding: '8px 11px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)',
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  // 16px on mobile or iOS Safari zooms the viewport and breaks the sticky header.
  fontSize: mobile ? 16 : 13,
  // …and 44px tall, the touch target every control on a phone owes a thumb. The padding alone gave
  // 38px, which is a miss you feel rather than see.
  minHeight: mobile ? 44 : undefined,
  outline: 'none',
})

export const button = (mobile: boolean, kind: 'ghost' | 'primary' = 'ghost'): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '0 13px',
  // 44px is the MOBILE number. Applying it on desktop turns a control row into a toolbar.
  height: mobile ? 44 : 32,
  borderRadius: 'var(--radius-sm)',
  border: `1px solid ${kind === 'primary' ? 'transparent' : 'var(--border)'}`,
  background: kind === 'primary' ? 'var(--anthropic-orange)' : 'transparent',
  color: kind === 'primary' ? '#1a1008' : 'var(--text-secondary)',
  fontWeight: kind === 'primary' ? 600 : 500,
  fontSize: 12.5,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
})

/** `null` is `N/A` in the muted colour — never a `0`, which reads as a measurement. */
export const NA = 'N/A'
export const fmtInt = (n: number | null | undefined): string =>
  (n === null || n === undefined ? NA : n.toLocaleString())
export const fmtUSD = (n: number | null | undefined): string =>
  (n === null || n === undefined ? NA : `$${n.toFixed(2)}`)
export const fmtBytes = (n: number): string =>
  (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)

/** Compact token counts, because these reach the billions and a full number breaks every column. */
export function fmtTokens(n: number | null): string {
  if (n === null) return NA
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return `${(n / 1_000_000_000).toFixed(2)}B`
}
