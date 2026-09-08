/**
 * HardwareModal.tsx — the hardware surface, as a modal reached from the top bar.
 *
 * It used to be a page (`/hardware`) in both navs. It is not a destination: it answers "what is this
 * machine doing right now", which is a question you ask FROM wherever you are and then dismiss —
 * the same shape as Settings or the notification bell, and the reason it is now an icon in the
 * sticky header (a tile in the "More" sheet on mobile, where the header carries only the logo).
 *
 * It maximizes, and the maximized view is the SAME content in a wider frame — the precedent is
 * `MaximizedRestrictions`: `esc` closes, the backdrop closes, focus returns to whatever opened it,
 * and on a phone it is edge-to-edge because that is the only way three columns of figures read.
 *
 * Every figure it draws is capability-honest: a number that cannot be produced renders `N/A` with
 * the REASON as its tooltip, and an empty fleet says which of the three empties it is. The
 * sentences live in the pure `lib/hardwareNotice.ts`.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity,
  AlertCircle,
  Container,
  Cpu,
  HardDrive,
  Layers,
  Maximize2,
  Minimize2,
  RefreshCw,
  Server,
  Terminal,
  X,
} from 'lucide-react'
import type { HarnessId, Lang } from '@agentistics/core'
import { HARNESS_LABELS } from '../lib/harness'
import { useIsMobile } from '../hooks/useIsMobile'
import { OVERLAY_TOP } from '../lib/mobileOverlay'
import {
  metricsReasonText,
  serviceBadge,
  serviceNote,
  sessionsEmptyNotice,
  type HardwareSessionMetricsReason,
  type HardwareSessionsReason,
  type ServiceHosting,
  type ServiceRunState,
} from '../lib/hardwareNotice'

interface DiskUsage {
  mountPath: string
  totalBytes: number | null
  usedBytes: number | null
  freeBytes: number | null
  available: boolean
}

interface HostMetrics {
  loadavg: number[] | null
  cpuCores: number | null
  totalMemoryBytes: number | null
  freeMemoryBytes: number | null
  usedMemoryBytes: number | null
  disk: DiskUsage
}

interface ProcessMetrics {
  pid: number | null
  name: string
  running: boolean
  state?: ServiceRunState
  hosting?: ServiceHosting
  cpuPercent: number | null
  rssBytes: number | null
}

interface ContainerMetrics {
  id: string
  name: string
  image: string
  cpuPercent: number | null
  memUsageBytes: number | null
  memLimitBytes: number | null
}

interface ManagedSessionHardware {
  id: string
  harness?: HarnessId
  label?: string
  cwd?: string
  task?: string
  pid: number | null
  cpuPercent: number | null
  rssBytes: number | null
  metricsReason?: HardwareSessionMetricsReason
}

interface HardwareSnapshot {
  procAvailable: boolean
  host: HostMetrics
  agentop: {
    server: ProcessMetrics
    otelWatcher: ProcessMetrics
    dockerContainers: ContainerMetrics[]
    dockerAvailable: boolean
  }
  sessions?: {
    sessions: ManagedSessionHardware[]
    procAvailable: boolean
    unavailable?: HardwareSessionsReason
    unavailableDetail?: string
  }
  sampledAtMs: number
}

function NaBadge({ title }: { title?: string }) {
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 6px',
        borderRadius: 4,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--text-tertiary)',
        letterSpacing: '0.03em',
        cursor: title ? 'help' : 'default',
      }}
    >
      N/A
    </span>
  )
}

function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return 'N/A'
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  const val = bytes / Math.pow(k, i)
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${sizes[i]}`
}

function fmtPercent(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return 'N/A'
  return `${val.toFixed(1)}%`
}

const TONE_COLOR: Record<'ok' | 'off' | 'unknown', { fg: string; bg: string }> = {
  ok: { fg: '#22c55e', bg: 'rgba(34, 197, 94, 0.15)' },
  off: { fg: 'var(--text-tertiary)', bg: 'var(--border)' },
  unknown: { fg: '#f59e0b', bg: 'rgba(245, 158, 11, 0.15)' },
}

/** One service card: the badge, the honest sentence under it, and its two figures. */
function ServiceCard(p: { proc: ProcessMetrics | undefined; title: string; lang: Lang; serverName: string }) {
  const lang2 = p.lang === 'pt' ? 'pt' : 'en'
  const badge = serviceBadge(p.proc?.state, lang2)
  const tone = TONE_COLOR[badge.tone]
  // The server IS this process; only a daemon hosted INSIDE it needs the sentence saying so.
  const isSelf = p.proc?.name === p.serverName
  const note = p.proc && !isSelf
    ? serviceNote({ state: p.proc.state, hosting: p.proc.hosting, serverName: p.serverName }, lang2)
    : null
  const inProcess = p.proc?.hosting === 'in-process' && !isSelf
  return (
    <div
      style={{
        padding: 16,
        borderRadius: 10,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <Terminal size={16} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{p.title}</span>
        </div>
        <span
          style={{
            fontSize: 11, padding: '2px 8px', borderRadius: 12,
            background: tone.bg, color: tone.fg, fontWeight: 600, whiteSpace: 'nowrap',
          }}
        >
          {badge.label}
          {p.proc?.pid ? ` · PID ${p.proc.pid}` : ''}
        </span>
      </div>

      {note && (
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.45 }}>{note}</span>
      )}

      {/* A daemon hosted inside the server has no figures of its own — printing two N/A there would
          look like a failed read of something that was never separate. */}
      {!inProcess && (
        <div style={{ display: 'flex', gap: 24, fontSize: 13, flexWrap: 'wrap' }}>
          <div>
            <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>CPU: </span>
            <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
              {p.proc && p.proc.cpuPercent !== null && p.proc.cpuPercent !== undefined
                ? fmtPercent(p.proc.cpuPercent)
                : <NaBadge title={metricsReasonText('first-sample', lang2) ?? undefined} />}
            </strong>
          </div>
          <div>
            <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
              {p.lang === 'pt' ? 'Memória (RSS): ' : 'Memory (RSS): '}
            </span>
            <strong style={{ fontVariantNumeric: 'tabular-nums' }}>
              {p.proc?.rssBytes ? fmtBytes(p.proc.rssBytes) : <NaBadge />}
            </strong>
          </div>
        </div>
      )}
    </div>
  )
}

/** The content, independent of the frame it is drawn in. */
function HardwareBody(p: {
  lang: Lang
  hardware: HardwareSnapshot | null
  error: string | null
  isMobile: boolean
}) {
  const { lang, hardware, error, isMobile } = p
  const lang2 = lang === 'pt' ? 'pt' : 'en'
  const host = hardware?.host
  const agentop = hardware?.agentop
  const fleet = hardware?.sessions

  const ramUsedPct =
    host?.totalMemoryBytes && host.usedMemoryBytes ? (host.usedMemoryBytes / host.totalMemoryBytes) * 100 : null
  const diskUsedPct =
    host?.disk?.totalBytes && host.disk.usedBytes ? (host.disk.usedBytes / host.disk.totalBytes) * 100 : null

  const sessions = fleet?.sessions ?? []
  const emptyNotice = sessionsEmptyNotice({
    count: sessions.length,
    ...(fleet?.unavailable ? { unavailable: fleet.unavailable } : {}),
    ...(fleet?.unavailableDetail ? { unavailableDetail: fleet.unavailableDetail } : {}),
    lang: lang2,
  })

  const cardStyle: React.CSSProperties = {
    padding: 16,
    borderRadius: 10,
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: isMobile ? 16 : 22, width: '100%', minWidth: 0 }}>
      {error && (
        <div
          style={{
            padding: '12px 16px', borderRadius: 8, background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.3)', color: '#ef4444', fontSize: 13,
            display: 'flex', alignItems: 'center', gap: 10,
          }}
        >
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      )}

      {hardware && !hardware.procAvailable && (
        <div
          style={{
            padding: '12px 16px', borderRadius: 8, background: 'rgba(245, 158, 11, 0.1)',
            border: '1px solid rgba(245, 158, 11, 0.3)', color: '#f59e0b', fontSize: 13,
            display: 'flex', alignItems: 'center', gap: 10,
          }}
        >
          <AlertCircle size={18} style={{ flexShrink: 0 }} />
          <span>
            {lang === 'pt'
              ? 'Esta máquina não expõe /proc — nenhuma medida por processo pode ser lida aqui (N/A, não zero).'
              : 'This machine exposes no /proc — nothing per-process can be read here (N/A, not zero).'}
          </span>
        </div>
      )}

      {/* Host */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-secondary)', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Server size={17} />
          {lang === 'pt' ? 'Máquina' : 'Host machine'}
        </h2>

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, color: 'var(--text-tertiary)', fontWeight: 600 }}>
                {lang === 'pt' ? 'Carga da CPU' : 'CPU load average'}
              </span>
              <Cpu size={16} style={{ color: 'var(--text-secondary)' }} />
            </div>
            {host?.loadavg ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 24, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {host.loadavg[0]?.toFixed(2)}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                    (1m) · 5m: {host.loadavg[1]?.toFixed(2)} · 15m: {host.loadavg[2]?.toFixed(2)}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                  {host.cpuCores ? `${host.cpuCores} ${lang === 'pt' ? 'núcleos lógicos' : 'CPU cores'}` : <NaBadge />}
                </div>
              </div>
            ) : (
              <NaBadge />
            )}
          </div>

          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, color: 'var(--text-tertiary)', fontWeight: 600 }}>
                {lang === 'pt' ? 'Memória RAM' : 'System RAM'}
              </span>
              <Activity size={16} style={{ color: 'var(--text-secondary)' }} />
            </div>
            {host?.totalMemoryBytes ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 24, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtBytes(host.usedMemoryBytes)}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>/ {fmtBytes(host.totalMemoryBytes)}</span>
                </div>
                <div style={{ width: '100%', height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.min(100, Math.max(0, ramUsedPct ?? 0))}%`,
                      background: (ramUsedPct ?? 0) > 85 ? '#ef4444' : (ramUsedPct ?? 0) > 70 ? '#f59e0b' : 'var(--anthropic-orange)',
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
              </div>
            ) : (
              <NaBadge />
            )}
          </div>

          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, color: 'var(--text-tertiary)', fontWeight: 600 }}>
                {lang === 'pt' ? 'Disco (Home)' : 'Disk usage (Home)'}
              </span>
              <HardDrive size={16} style={{ color: 'var(--text-secondary)' }} />
            </div>
            {host?.disk?.available && host.disk.totalBytes ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 24, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtBytes(host.disk.usedBytes)}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>/ {fmtBytes(host.disk.totalBytes)}</span>
                </div>
                <div style={{ width: '100%', height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.min(100, Math.max(0, diskUsedPct ?? 0))}%`,
                      background: (diskUsedPct ?? 0) > 90 ? '#ef4444' : (diskUsedPct ?? 0) > 75 ? '#f59e0b' : '#3b82f6',
                      transition: 'width 0.3s ease',
                    }}
                  />
                </div>
              </div>
            ) : (
              <NaBadge />
            )}
          </div>
        </div>
      </section>

      {/* Services */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-secondary)', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Layers size={17} />
          {lang === 'pt' ? 'Processos do agentop' : 'Agentop services'}
        </h2>

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
          <ServiceCard proc={agentop?.server} title="agentop server" lang={lang} serverName="agentop server" />
          <ServiceCard proc={agentop?.otelWatcher} title="otel-watcher" lang={lang} serverName="agentop server" />
        </div>

        {agentop?.dockerContainers && agentop.dockerContainers.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-tertiary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Container size={14} />
              {lang === 'pt' ? 'Contêineres Docker' : 'Docker containers'}
            </span>
            <div style={{ overflowX: 'auto', width: '100%', WebkitOverflowScrolling: 'touch' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, background: 'var(--bg-surface)', borderRadius: 8, border: '1px solid var(--border)' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left', color: 'var(--text-tertiary)' }}>
                    <th style={{ padding: '8px 12px' }}>Name / ID</th>
                    <th style={{ padding: '8px 12px' }}>Image</th>
                    <th style={{ padding: '8px 12px' }}>CPU%</th>
                    <th style={{ padding: '8px 12px' }}>{lang === 'pt' ? 'Memória' : 'Memory'}</th>
                  </tr>
                </thead>
                <tbody>
                  {agentop.dockerContainers.map(c => (
                    <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 12px', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {c.name} <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 400 }}>({c.id.slice(0, 12)})</span>
                      </td>
                      <td style={{ padding: '8px 12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{c.image}</td>
                      <td style={{ padding: '8px 12px', fontVariantNumeric: 'tabular-nums' }}>{fmtPercent(c.cpuPercent)}</td>
                      <td style={{ padding: '8px 12px', fontVariantNumeric: 'tabular-nums' }}>{fmtBytes(c.memUsageBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* Managed fleet */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-secondary)', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Terminal size={17} />
            {lang === 'pt' ? 'Sessões gerenciadas' : 'Managed sessions'}
          </h2>
          {!emptyNotice && (
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              {sessions.length} {lang === 'pt' ? 'com processo vivo' : 'with a living process'}
            </span>
          )}
        </div>

        {emptyNotice ? (
          <div
            style={{
              padding: 20, borderRadius: 10, background: 'var(--bg-surface)',
              border: '1px solid var(--border)', color: 'var(--text-tertiary)', fontSize: 13,
              display: 'flex', flexDirection: 'column', gap: 6, textAlign: 'center', alignItems: 'center',
            }}
          >
            <strong style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{emptyNotice.title}</strong>
            <span style={{ lineHeight: 1.5 }}>{emptyNotice.detail}</span>
          </div>
        ) : (
          <div style={{ overflowX: 'auto', width: '100%', WebkitOverflowScrolling: 'touch' }}>
            <table
              style={{
                width: '100%', borderCollapse: 'collapse', fontSize: 13,
                background: 'var(--bg-surface)', borderRadius: 10, border: '1px solid var(--border)',
              }}
            >
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left', color: 'var(--text-tertiary)' }}>
                  <th style={{ padding: '10px 14px' }}>{lang === 'pt' ? 'Sessão' : 'Session'}</th>
                  <th style={{ padding: '10px 14px' }}>{lang === 'pt' ? 'Pasta' : 'Folder'}</th>
                  <th style={{ padding: '10px 14px' }}>PID</th>
                  <th style={{ padding: '10px 14px' }}>CPU%</th>
                  <th style={{ padding: '10px 14px' }}>{lang === 'pt' ? 'Memória (RSS)' : 'Memory (RSS)'}</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map(s => {
                  const harnessLabel = s.harness ? (HARNESS_LABELS[s.harness] ?? s.harness) : 'session'
                  const reason = metricsReasonText(s.metricsReason, lang2) ?? undefined
                  return (
                    <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '10px 14px', maxWidth: 260 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                          <span
                            style={{ fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                            title={s.label || s.id}
                          >
                            {s.label || s.id}
                          </span>
                          <span
                            style={{
                              fontSize: 11, padding: '1px 6px', borderRadius: 4,
                              background: 'var(--border)', color: 'var(--text-secondary)', width: 'fit-content',
                            }}
                          >
                            {harnessLabel} · {s.id}
                          </span>
                        </div>
                      </td>
                      <td
                        style={{
                          padding: '10px 14px', color: 'var(--text-secondary)', fontFamily: 'monospace',
                          fontSize: 12, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}
                        title={s.cwd}
                      >
                        {s.cwd ?? <NaBadge />}
                      </td>
                      <td style={{ padding: '10px 14px', fontVariantNumeric: 'tabular-nums', fontFamily: 'monospace' }}>
                        {s.pid ?? <NaBadge title={reason} />}
                      </td>
                      <td style={{ padding: '10px 14px', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                        {s.cpuPercent !== null && s.cpuPercent !== undefined ? fmtPercent(s.cpuPercent) : <NaBadge title={reason} />}
                      </td>
                      <td style={{ padding: '10px 14px', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                        {s.rssBytes ? fmtBytes(s.rssBytes) : <NaBadge title={reason} />}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * The modal. `esc` closes it; the maximize toggle swaps the frame, not the content; focus returns
 * to the control that opened it.
 */
export function HardwareModal({ lang, onClose }: { lang: Lang; onClose: () => void }) {
  const isMobile = useIsMobile()
  const [maximized, setMaximized] = useState(false)
  const [hardware, setHardware] = useState<HardwareSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
  // Whatever had the keyboard when this opened — the icon in the header, or the tile in the sheet.
  const opener = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : (document.activeElement as HTMLElement))

  const fetchData = useCallback(async () => {
    try {
      setError(null)
      const res = await fetch('/api/hardware-resources')
      if (res.status === 403) {
        setError(lang === 'pt'
          ? 'Recurso desativado pelo perfil de exposição desta instalação (CAPS.localProcesses).'
          : 'Disabled by this installation’s exposure profile (CAPS.localProcesses).')
        setLoading(false)
        return
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setHardware((await res.json()) as HardwareSnapshot)
      setLastRefreshed(new Date())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [lang])

  useEffect(() => {
    void fetchData()
    const timer = setInterval(() => void fetchData(), 5000)
    return () => clearInterval(timer)
  }, [fetchData])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Focus goes back where it came from, whichever way the dialog was dismissed.
  useEffect(() => () => { opener.current?.focus?.() }, [])

  const wide = maximized || isMobile
  const btn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    border: '1px solid var(--border)', background: 'transparent', borderRadius: 8,
    color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12,
    fontWeight: 600, padding: isMobile ? '0 12px' : '0 10px',
    height: isMobile ? 44 : 32, minWidth: isMobile ? 44 : 32,
  }

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={lang === 'pt' ? 'Recursos de hardware' : 'Hardware resources'}
      style={{
        position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: isMobile ? 'stretch' : 'center', justifyContent: 'center',
        padding: isMobile ? OVERLAY_TOP : (maximized ? 0 : 24),
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)',
          border: wide ? 'none' : '1px solid var(--border)',
          borderRadius: wide ? 0 : 12,
          width: wide ? '100%' : 'min(1080px, 96vw)',
          height: wide ? '100%' : 'min(84vh, 860px)',
          display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
          padding: isMobile ? '10px 12px' : '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <Cpu size={17} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
              {lang === 'pt' ? 'Recursos de hardware' : 'Hardware resources'}
            </span>
            {lastRefreshed && !isMobile && (
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums', marginLeft: 6 }}>
                {lang === 'pt' ? 'Atualizado às' : 'Updated'} {lastRefreshed.toLocaleTimeString()}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => { setLoading(true); void fetchData() }}
              disabled={loading}
              style={btn}
              title={lang === 'pt' ? 'Atualizar' : 'Refresh'}
              aria-label={lang === 'pt' ? 'Atualizar' : 'Refresh'}
            >
              <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
              {!isMobile && (lang === 'pt' ? 'Atualizar' : 'Refresh')}
            </button>
            {/* Maximizing is meaningless on a phone: the modal is already the whole viewport. */}
            {!isMobile && (
              <button
                type="button"
                onClick={() => setMaximized(v => !v)}
                style={btn}
                title={maximized
                  ? (lang === 'pt' ? 'Restaurar' : 'Restore')
                  : (lang === 'pt' ? 'Tela cheia' : 'Full screen')}
                aria-label={maximized
                  ? (lang === 'pt' ? 'Restaurar' : 'Restore')
                  : (lang === 'pt' ? 'Tela cheia' : 'Full screen')}
                aria-pressed={maximized}
              >
                {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              // First focusable control in the dialog, so a keyboard user lands on the way out.
              autoFocus
              style={btn}
              title={lang === 'pt' ? 'Fechar' : 'Close'}
              aria-label={lang === 'pt' ? 'Fechar' : 'Close'}
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* `minHeight: 0` so the body scrolls instead of pushing the header off the top. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: isMobile ? 12 : 16 }}>
          {lastRefreshed && isMobile && (
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 10, fontVariantNumeric: 'tabular-nums' }}>
              {lang === 'pt' ? 'Atualizado às' : 'Updated'} {lastRefreshed.toLocaleTimeString()}
            </div>
          )}
          <HardwareBody lang={lang} hardware={hardware} error={error} isMobile={isMobile} />
        </div>
      </div>
    </div>
  )
}
