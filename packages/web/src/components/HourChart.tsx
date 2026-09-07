import React, { useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'

interface Props {
  hourCounts: Record<number, number>
  hourMeta?: Record<number, { firstTs: string; lastTs: string }>
  height?: number
}

const PERIODS = [
  { label: 'Night', hours: [0, 1, 2, 3, 4, 5], color: '#6366f1' },
  { label: 'Morning', hours: [6, 7, 8, 9, 10, 11], color: '#D97706' },
  { label: 'Afternoon', hours: [12, 13, 14, 15, 16, 17], color: '#f59e0b' },
  { label: 'Evening', hours: [18, 19, 20, 21, 22, 23], color: '#8b5cf6' },
]

function getPeriodColor(hour: number): string {
  for (const p of PERIODS) {
    if (p.hours.includes(hour)) return p.color
  }
  return '#6366f1'
}

function fmtHour(h: number, use24: boolean): string {
  if (use24) return h.toString().padStart(2, '0') + ':00'
  if (h === 0) return '12 AM'
  if (h < 12) return `${h} AM`
  if (h === 12) return '12 PM'
  return `${h - 12} PM`
}

function fmtTimestamp(ts: string, use24: boolean): string {
  try {
    const d = new Date(ts)
    if (use24) {
      return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0')
    }
    const h = d.getHours()
    const m = d.getMinutes().toString().padStart(2, '0')
    if (h === 0) return `12:${m} AM`
    if (h < 12) return `${h}:${m} AM`
    if (h === 12) return `12:${m} PM`
    return `${h - 12}:${m} PM`
  } catch {
    return ''
  }
}

const CustomTooltip = ({ active, payload, label, use24, hourMeta }: any) => {
  if (!active || !payload?.length) return null
  const hour = parseInt(label)
  const meta = hourMeta?.[hour]
  const first = meta ? fmtTimestamp(meta.firstTs, use24) : null
  const last = meta ? fmtTimestamp(meta.lastTs, use24) : null
  const sameTime = first === last
  return (
    <div style={{
      background: 'var(--bg-elevated)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: '8px 12px',
      fontSize: 12,
    }}>
      <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{fmtHour(hour, use24)}</div>
      <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>{payload[0].value} messages</div>
      {first && (
        <div style={{ color: 'var(--text-tertiary)', marginTop: 4, fontSize: 11 }}>
          {sameTime ? (
            <>1ª e última: <span style={{ color: 'var(--text-secondary)' }}>{first}</span></>
          ) : (
            <>1ª: <span style={{ color: 'var(--text-secondary)' }}>{first}</span> · última: <span style={{ color: 'var(--text-secondary)' }}>{last}</span></>
          )}
        </div>
      )}
    </div>
  )
}

export function HourChart({ hourCounts, hourMeta, height = 336 }: Props) {
  const [use24, setUse24] = useState(false)

  const chartData = Array.from({ length: 24 }, (_, i) => ({
    hour: String(i),
    label: fmtHour(i, use24),
    value: hourCounts[i] ?? 0,
  }))

  const peakHour = chartData.reduce((a, b) => b.value > a.value ? b : a, chartData[0]!)

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {PERIODS.map(p => {
          const total = p.hours.reduce((s, h) => s + (hourCounts[h] ?? 0), 0)
          return (
            <div key={p.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
              <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                {p.label} <span style={{ color: 'var(--text-tertiary)' }}>({total})</span>
              </span>
            </div>
          )
        })}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            Peak: <span style={{ color: 'var(--anthropic-orange)', fontWeight: 600 }}>
              {fmtHour(parseInt(peakHour.hour), use24)}
            </span>
          </span>
          <button
            onClick={() => setUse24(v => !v)}
            style={{
              fontSize: 10, fontWeight: 600,
              padding: '2px 7px', borderRadius: 4,
              border: `1px solid ${use24 ? 'var(--anthropic-orange)' : 'var(--border)'}`,
              background: use24 ? 'var(--anthropic-orange-dim)' : 'transparent',
              color: use24 ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
              cursor: 'pointer', fontFamily: 'inherit',
              transition: 'all 0.15s',
            }}
          >
            24h
          </button>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }} barCategoryGap={1}>
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey="label"
            tick={{ fill: 'var(--text-tertiary)', fontSize: 9 }}
            axisLine={false}
            tickLine={false}
            width={44}
            interval={0}
          />
          <Tooltip content={<CustomTooltip use24={use24} hourMeta={hourMeta} />} cursor={{ fill: 'var(--ag-tint-1)' }} />
          {/* AN HOUR YOU WORKED MUST NOT LOOK LIKE AN HOUR YOU DID NOT.
              Reported: "eu tive conversas ontem às 4 e às 5 e não estão aparecendo". They were
              there — 347 messages at 04h and 31 at 05h on this machine — and against a 6 PM peak of
              29.394 that is 1,2 % and 0,1 %, which recharts draws as a sub-pixel sliver and a
              browser paints as nothing. The row read as a night with no work in it.
              `minPointSize` gives every non-zero hour 3px of bar and leaves a real zero at zero, so
              the two are distinguishable at a glance — the same rule this product applies to a
              metric it cannot measure: never render something as nothing. The FIGURE is untouched;
              only the floor of its drawing. */}
          <Bar dataKey="value" radius={[0, 2, 2, 0]} minPointSize={(value: number | null | undefined) => ((value ?? 0) > 0 ? 3 : 0)}>
            {chartData.map(entry => (
              <Cell key={entry.hour} fill={getPeriodColor(parseInt(entry.hour))} fillOpacity={0.8} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
