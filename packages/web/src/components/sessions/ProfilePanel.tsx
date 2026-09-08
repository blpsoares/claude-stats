import type { Baseline, ProfileMetric } from '@agentistics/core'

const SHOWN: ProfileMetric[] = ['messages', 'activeMinutes', 'compacts', 'skills', 'mcpServers', 'subagents']

const LABEL_EN: Record<string, string> = {
  messages: 'messages', activeMinutes: 'active minutes', compacts: 'compacts',
  skills: 'skills', mcpServers: 'MCP servers', subagents: 'subagents',
}
const LABEL_PT: Record<string, string> = {
  messages: 'mensagens', activeMinutes: 'minutos ativos', compacts: 'compacts',
  skills: 'skills', mcpServers: 'servidores MCP', subagents: 'subagentes',
}

const round = (n: number) => (n >= 10 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(2))

/**
 * The behaviour profile, shown where the sessions list is empty.
 *
 * A metric with `n === 0` is DROPPED, never rendered as a zero — the same N/A-versus-a-confident-0
 * rule `HARNESS_CAPABILITIES` applies to harness metrics.
 */
export function ProfilePanel({ baseline, pt }: { baseline?: Baseline; pt: boolean }) {
  if (!baseline) return null
  const label = pt ? LABEL_PT : LABEL_EN
  const rows = SHOWN
    .map(k => ({ k, m: baseline.metrics[k] }))
    .filter(r => r.m && r.m.n > 0)
  if (rows.length === 0) return null

  return (
    <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {pt
          ? `Seus últimos ${baseline.windowDays} dias · ${baseline.sessions} sessões`
          : `Your last ${baseline.windowDays} days · ${baseline.sessions} sessions`}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
        {rows.map(({ k, m }) => (
          <div key={k} style={{
            padding: '10px 12px', borderRadius: 10,
            background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', minWidth: 0,
          }}>
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>{round(m!.median)}</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{label[k] ?? k}</div>
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>n={m!.n}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
