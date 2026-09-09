/**
 * BoardOverviewView — the DEFAULT view of the board: what the work is costing.
 *
 * The kanban answers "which column is full", which is a tracking question. This answers "what is my
 * work costing me", which is the question the product exists for — so it opens here.
 *
 * Every average states its denominator. An average over a set the reader cannot see is a number
 * that looks like a measurement and is not: the cost averages say how many tasks could not be
 * priced, and the delivery-time average says it covers delivered tasks only, because an open task
 * has no duration at all (`task-stats.ts`).
 */

import { CircleDashed, CircleCheck, CircleSlash, Coins, Timer } from 'lucide-react'
import {
  COLUMN_ORDER, NA, STATUS, fmtInt, fmtTokens, harnessColor, microLabel, numeric, surface,
  type BoardStatus,
} from './board'
import { useMoney } from './money'
import { fmtDuration, type BoardOverview, type Bucket } from '../../lib/tasks'

function Big({ label, value, note, icon, accent }: {
  label: string
  value: string
  note?: string
  icon?: React.ReactNode
  accent?: boolean
}) {
  const absent = value === NA
  return (
    <div style={{ ...surface, padding: 14, display: 'grid', gap: 4, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {icon}
        <span style={microLabel}>{label}</span>
      </div>
      <div style={{
        fontSize: 24, fontWeight: 650, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1,
        color: absent ? 'var(--text-tertiary)' : accent ? 'var(--anthropic-orange)' : 'var(--text-primary)',
      }}>{value}</div>
      {note && (
        <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', lineHeight: 1.4 }}>{note}</div>
      )}
    </div>
  )
}

function Ranked({ title, items, color }: {
  title: string
  items: Bucket[]
  color?: (key: string) => string
}) {
  const top = Math.max(...items.map(i => i.tokens ?? 0), 1)
  return (
    <div style={{ ...surface, padding: 14, display: 'grid', gap: 10, minWidth: 0 }}>
      <div style={microLabel}>{title}</div>
      {items.length === 0
        ? <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>Nothing reported one.</div>
        : items.slice(0, 6).map(i => {
          const pct = i.tokens === null ? 0 : Math.round((i.tokens / top) * 100)
          return (
            <div key={i.key} style={{ display: 'grid', gap: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{
                  fontSize: 11.5, color: 'var(--text-secondary)', minWidth: 0,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{i.key}</span>
                <span style={{ ...numeric, fontSize: 11.5, flexShrink: 0 }}>
                  {fmtTokens(i.tokens)}
                  <span style={{ color: 'var(--text-tertiary)' }}> · {i.sessions}s</span>
                </span>
              </div>
              <div style={{ height: 5, borderRadius: 3, background: 'var(--bg-elevated)' }}>
                <div style={{
                  width: `${pct}%`, height: '100%', borderRadius: 3,
                  background: color ? color(i.key) : 'var(--anthropic-orange)',
                }} />
              </div>
            </div>
          )
        })}
    </div>
  )
}

export function BoardOverviewView({ o }: { o: BoardOverview }) {
  const money = useMoney()
  const gap = o.tasksWithoutCost > 0
    ? `${o.tasksWithoutCost} of ${o.tasks} could not be priced`
    : undefined

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <Big
          label="In flight" value={String(o.inFlight)}
          icon={<CircleDashed size={13} style={{ color: 'var(--anthropic-orange)' }} />}
          note={`${o.tasks} task${o.tasks === 1 ? '' : 's'} on the board`}
        />
        <Big
          label="Delivered" value={String(o.delivered)}
          icon={<CircleCheck size={13} style={{ color: 'var(--accent-green)' }} />}
          note={o.abandoned > 0 ? `${o.abandoned} abandoned` : undefined}
        />
        <Big
          label="Avg cost / delivery" value={money(o.avgCostPerDelivered)} accent
          icon={<Coins size={13} style={{ color: 'var(--anthropic-orange)' }} />}
          note={o.avgCostPerDelivered === null ? 'nothing delivered yet' : gap}
        />
        <Big
          label="Avg cost / task" value={money(o.avgCostPerTask)}
          icon={<Coins size={13} style={{ color: 'var(--text-tertiary)' }} />}
          note={gap}
        />
        <Big
          label="Avg delivery time" value={fmtDuration(o.avgDeliveryMs) ?? NA}
          icon={<Timer size={13} style={{ color: 'var(--accent-blue)' }} />}
          note="delivered tasks only — an open task has no duration"
        />
        <Big
          label="Total spent" value={money(o.totalCostUSD)}
          icon={<Coins size={13} style={{ color: 'var(--text-tertiary)' }} />}
          note={`${fmtTokens(o.totalTokens)} tokens`}
        />
      </div>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
        <Big
          label="Rounds / task" value={o.avgRoundsPerTask === null ? NA : o.avgRoundsPerTask.toFixed(1)}
          note="how many turns a delivery takes"
        />
        <Big
          label="Sessions / task" value={o.avgSessionsPerTask === null ? NA : o.avgSessionsPerTask.toFixed(1)}
          note="above 1 means the work outgrew one conversation"
        />
        <Big label="Sessions filed" value={fmtInt(o.totalSessions)} />
      </div>

      <div style={{ ...surface, padding: 14, display: 'grid', gap: 10 }}>
        <div style={microLabel}>Where the work stands</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {COLUMN_ORDER.map(st => {
            const c = STATUS[st]
            const n = o.statusCounts[st] ?? 0
            return (
              // A column at zero is DRAWN, dimmed: an absent bar reads as a status that does not
              // exist, and the reader would have to know the vocabulary to notice it is missing.
              <div key={st} style={{
                display: 'flex', alignItems: 'center', gap: 7, padding: '5px 11px', borderRadius: 8,
                background: n > 0 ? c.dim : 'transparent',
                border: `1px solid ${n > 0 ? c.color : 'var(--border)'}`,
                opacity: n > 0 ? 1 : 0.5,
              }}>
                <span style={{ fontSize: 11.5, color: n > 0 ? c.color : 'var(--text-tertiary)' }}>{c.label}</span>
                <span style={{ ...numeric, fontSize: 13, color: n > 0 ? c.color : 'var(--text-tertiary)' }}>{n}</span>
              </div>
            )
          })}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        <Ranked title="Top models across tasks" items={o.topModels} />
        <Ranked title="Harnesses" items={o.topHarnesses} color={harnessColor} />
      </div>

      {o.tasks === 0 && (
        <div style={{ ...surface, padding: 16, fontSize: 12.5, color: 'var(--text-tertiary)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <CircleSlash size={15} /> No tasks yet — the numbers above are empty because there is
          nothing to measure, not because the measuring failed.
        </div>
      )}
    </div>
  )
}
