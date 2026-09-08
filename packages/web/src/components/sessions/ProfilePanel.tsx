import type { Baseline, ProfileMetric } from '@agentistics/core'
import { SHOWN, roundProfile } from '@agentistics/tui/control/profile-lines'

/**
 * The labels are `Record<ProfileMetric, string>` with NO `?? key` fallback: a seventh metric added
 * to `SHOWN` must fail the build here rather than printing `activeMinutes` at a reader. `SHOWN` and
 * `roundProfile` themselves come from the cockpit's own pure module — this panel used to re-declare
 * both, so a metric added there reached the terminal and silently not the dashboard.
 */
const LABEL_EN: Record<ProfileMetric, string> = {
  messages: 'messages', activeMinutes: 'active minutes', compacts: 'compacts',
  skills: 'skills', mcpServers: 'MCP servers', subagents: 'subagents',
  tokens: 'tokens', toolErrors: 'tool errors',
}
const LABEL_PT: Record<ProfileMetric, string> = {
  messages: 'mensagens', activeMinutes: 'minutos ativos', compacts: 'compacts',
  skills: 'skills', mcpServers: 'servidores MCP', subagents: 'subagentes',
  tokens: 'tokens', toolErrors: 'erros de ferramenta',
}

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
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>{roundProfile(m!.median)}</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{label[k]}</div>
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>n={m!.n}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
