/**
 * Backup settings — the web's window onto the SAME backup engine `agentop backup` and the
 * cockpit's `backup` tab drive. This page owns no decisions: every number and every verdict is
 * read straight off `GET /api/backup/status` (`backup-routes.ts`, which calls the exact functions
 * `cli-start.ts`'s `backupStatus` calls for the cockpit) and the only write it performs is
 * `POST /api/backup/run` — the same `performBackup` the CLI and the cockpit's `b` key call.
 *
 * Absent on a central (`settingsSections.ts`'s `backup` gate) — a central aggregates other
 * machines and has no local harness directories of its own to back up.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { PlayCircle, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import type { AppContext } from '../../lib/app-context'
import { HARNESS_LABELS, HARNESS_COLORS } from '../../lib/harness'
import { useIsMobile } from '../../hooks/useIsMobile'
import { SectionHeader, Divider, RecordCard } from './primitives'

// ---------------------------------------------------------------------------
// wire shapes — mirrors packages/server/server/backup-routes.ts's BackupStatusJson. Redeclared
// rather than imported: packages/web may never import packages/server (Vite would try to bundle
// Bun/Node-only code and fail).
// ---------------------------------------------------------------------------

interface BackupHarnessJson {
  id: HarnessId
  enabled: boolean
  sessions: number
  sizeLabel: string
  lastBackupAt?: string
  lastBackupGone?: boolean
}

interface BackupHistoryJson {
  at: string
  path: string
  layers: string[]
  harnesses: HarnessId[]
  bytesLabel: string
  skipped?: number
  present: boolean
}

interface BackupStatusJson {
  harnesses: BackupHarnessJson[]
  config: {
    layers: string[]
    destDir: string
    schedule: string
    scheduleActive: boolean
    keep: number
    retainedLabel: string
    secretsCount: number
    last?: { at: string; bytesLabel: string; skipped?: number }
  }
  history: BackupHistoryJson[]
}

type RunOutcome = { ok: true; bytesLabel: string; skipped?: number } | { ok: false; reason: string }

// ---------------------------------------------------------------------------
// pure display helpers — the presentation twin of packages/tui/src/control/backup.ts's
// `formatElapsed`/`harnessLastLabel`. A separate, small implementation rather than an import:
// the web bundle cannot reach `packages/tui` (Ink, React-for-terminals) any more than it can
// reach `packages/server`, and this is display vocabulary, not a decision — the FACTS (whether a
// harness is covered, whether a file is gone) all come from the server response above.
// ---------------------------------------------------------------------------

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const min = Math.floor(ms / 60000)
  if (min < 1) return '<1m'
  if (min < 60) return `${min}m`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}h${min % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d${hours % 24}h`
}

function agoLabel(iso: string, now: number, pt: boolean): string {
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return iso
  const elapsed = formatElapsed(ms)
  return pt ? `há ${elapsed}` : `${elapsed} ago`
}

/** A recorded backup whose file is gone says so — never a reassuring date. Mirrors the cockpit's
 *  `harnessLastLabel`. */
function harnessLastText(h: BackupHarnessJson, now: number, pt: boolean): string {
  if (h.lastBackupAt) return agoLabel(h.lastBackupAt, now, pt)
  if (h.lastBackupGone) {
    return pt
      ? 'nenhum (o backup registrado não existe mais em disco)'
      : 'none (no recorded backup whose file is still on disk)'
  }
  return pt ? 'nunca' : 'never'
}

const SCHEDULE_WORD: Record<string, { en: string; pt: string }> = {
  off: { en: 'off', pt: 'desligado' },
  daily: { en: 'daily', pt: 'diário' },
  weekly: { en: 'weekly', pt: 'semanal' },
}

function scheduleText(config: BackupStatusJson['config'], pt: boolean): string {
  const word = SCHEDULE_WORD[config.schedule]
  const base = word ? (pt ? word.pt : word.en) : config.schedule
  if (config.schedule === 'off' || config.scheduleActive) return base
  // With the server stopped, the schedule reads INACTIVE — never a "next at…" that will not
  // arrive. Same N/A-versus-a-confident-answer rule the dashboard applies everywhere else.
  return pt ? `${base} (inativo — o servidor não está rodando)` : `${base} (inactive — the server is not running)`
}

function lastOutcomeText(skipped: number | undefined, pt: boolean): string {
  if (skipped === undefined) return pt ? 'situação desconhecida' : 'unknown'
  if (skipped > 0) return pt ? `${skipped} caminho(s) ignorado(s)` : `${skipped} path(s) skipped`
  return pt ? 'completo' : 'clean run'
}

function lastSummaryText(config: BackupStatusJson['config'], now: number, pt: boolean): string {
  if (!config.last) return pt ? 'nenhum backup em disco' : 'none on disk'
  return `${agoLabel(config.last.at, now, pt)} · ${config.last.bytesLabel} · ${lastOutcomeText(config.last.skipped, pt)}`
}

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

export default function BackupSettings() {
  const ctx = useOutletContext<AppContext>()
  const pt = ctx.lang === 'pt'
  const isMobile = useIsMobile()

  const [status, setStatus] = useState<BackupStatusJson | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [runOutcome, setRunOutcome] = useState<RunOutcome | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/backup/status')
      if (!r.ok) {
        setLoadError(pt ? 'Não foi possível carregar o status do backup.' : 'Could not load backup status.')
        return
      }
      const data = (await r.json()) as BackupStatusJson
      setStatus(data)
      setLoadError(null)
    } catch {
      setLoadError(pt ? 'Não foi possível carregar o status do backup.' : 'Could not load backup status.')
    }
  }, [pt])

  useEffect(() => { void load() }, [load])

  // The relative ages ("2h ago") are recomputed against a ticking clock so they do not freeze
  // between loads — the same reason the cockpit's `backup` tab reads `Date.now()` on a timer.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])

  const runNow = useCallback(async () => {
    setRunning(true)
    setRunOutcome(null)
    try {
      const r = await fetch('/api/backup/run', { method: 'POST' })
      const data = (await r.json()) as RunOutcome
      setRunOutcome(data)
      if (data.ok) void load()
    } catch {
      setRunOutcome({ ok: false, reason: pt ? 'a requisição falhou' : 'the request failed' })
    } finally {
      setRunning(false)
    }
  }, [load, pt])

  const byId = new Map((status?.harnesses ?? []).map(h => [h.id, h]))
  // HARNESS_ORDER, never the server array's own order — the same discipline every other surface
  // that lists harnesses follows.
  const harnessRows = HARNESS_ORDER.filter(id => byId.has(id)).map(id => byId.get(id)!)

  return (
    <div>
      <SectionHeader label={pt ? 'Backup' : 'Backup'} />
      <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.55, margin: '0 0 16px' }}>
        {pt
          ? 'Leva o histórico completo desta máquina — métricas, o repositório de projetos e (opcionalmente) as transcrições — para outra máquina. Credenciais nunca são incluídas.'
          : 'Carries this machine’s whole history — computed metrics, the repository manifest, and (optionally) transcripts — to another machine. Credentials are never included.'}
      </p>

      {loadError && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderRadius: 8,
          background: 'color-mix(in srgb, #ef4444 8%, transparent)',
          border: '1px solid color-mix(in srgb, #ef4444 28%, transparent)',
          fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 16,
        }}>
          <AlertTriangle size={14} style={{ color: '#ef4444', flexShrink: 0 }} />
          <span>{loadError}</span>
        </div>
      )}

      {!status && !loadError && (
        <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', padding: '20px 0' }}>
          {pt ? 'Carregando…' : 'Loading…'}
        </div>
      )}

      {status && (
        <>
          {/* Run now */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            <button
              type="button"
              onClick={() => { void runNow() }}
              disabled={running}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                padding: isMobile ? '0 16px' : '8px 16px', minHeight: isMobile ? 44 : undefined,
                width: isMobile ? '100%' : undefined,
                borderRadius: 7, border: '1px solid var(--anthropic-orange)',
                background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)',
                fontSize: 13, fontWeight: 700, cursor: running ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit', opacity: running ? 0.6 : 1,
              }}
            >
              {running
                ? <><Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> {pt ? 'Executando…' : 'Running…'}</>
                : <><PlayCircle size={15} /> {pt ? 'Fazer backup agora' : 'Run backup now'}</>}
            </button>
          </div>

          {runOutcome && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderRadius: 8,
              background: runOutcome.ok
                ? 'color-mix(in srgb, var(--accent-green) 10%, transparent)'
                : 'color-mix(in srgb, #ef4444 8%, transparent)',
              border: `1px solid ${runOutcome.ok
                ? 'color-mix(in srgb, var(--accent-green) 30%, transparent)'
                : 'color-mix(in srgb, #ef4444 28%, transparent)'}`,
              fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 16,
            }}>
              {runOutcome.ok
                ? <CheckCircle2 size={14} style={{ color: 'var(--accent-green)', flexShrink: 0 }} />
                : <AlertTriangle size={14} style={{ color: '#ef4444', flexShrink: 0 }} />}
              <span>
                {runOutcome.ok
                  ? (pt
                    ? `Backup concluído — ${runOutcome.bytesLabel}${runOutcome.skipped ? ` · ${runOutcome.skipped} caminho(s) ignorado(s)` : ''}`
                    : `Backup complete — ${runOutcome.bytesLabel}${runOutcome.skipped ? ` · ${runOutcome.skipped} path(s) skipped` : ''}`)
                  : (pt ? `Backup falhou — ${runOutcome.reason}` : `Backup failed — ${runOutcome.reason}`)}
              </span>
            </div>
          )}

          <Divider />

          {/* Configuration — read-only facts, exactly what the engine decided; this page changes
              nothing about them. */}
          <SectionHeader label={pt ? 'Configuração' : 'Configuration'} />
          <ConfigRow label={pt ? 'Camadas' : 'Layers'} value={status.config.layers.length > 0 ? status.config.layers.join(' + ') : '—'} />
          <ConfigRow label={pt ? 'Destino' : 'Destination'} value={status.config.destDir} mono />
          <ConfigRow label={pt ? 'Agendamento' : 'Schedule'} value={scheduleText(status.config, pt)} />
          <ConfigRow
            label={pt ? 'Manter' : 'Keep'}
            value={pt
              ? `${status.config.keep} backups (${status.config.retainedLabel} ao todo)`
              : `${status.config.keep} backups (${status.config.retainedLabel} total)`}
          />
          <ConfigRow
            label={pt ? 'Segredos' : 'Secrets'}
            value={pt ? `${status.config.secretsCount} excluídos` : `${status.config.secretsCount} excluded`}
          />
          <ConfigRow label={pt ? 'Último backup' : 'Last backup'} value={lastSummaryText(status.config, now, pt)} />

          <Divider />

          {/* Per-harness coverage — last-backup is PER HARNESS, never one date at the top: an
              unticked harness must read as unprotected. */}
          <SectionHeader label={pt ? 'Cobertura por harness' : 'Coverage by harness'} />
          {isMobile ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {harnessRows.map(h => (
                <RecordCard
                  key={h.id}
                  title={
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: HARNESS_COLORS[h.id], flexShrink: 0 }} />
                      {HARNESS_LABELS[h.id]}
                    </span>
                  }
                  badge={
                    <span style={{
                      fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 5,
                      color: h.enabled ? 'var(--accent-green)' : 'var(--text-tertiary)',
                      background: h.enabled ? 'color-mix(in srgb, var(--accent-green) 12%, transparent)' : 'transparent',
                      border: `1px solid ${h.enabled ? 'color-mix(in srgb, var(--accent-green) 30%, transparent)' : 'var(--border)'}`,
                    }}>
                      {h.enabled ? (pt ? 'incluído' : 'included') : (pt ? 'não incluído' : 'not included')}
                    </span>
                  }
                  fields={[
                    { label: pt ? 'Sessões' : 'Sessions', value: h.sessions },
                    { label: pt ? 'Tamanho' : 'Size', value: h.sizeLabel },
                    { label: pt ? 'Último backup' : 'Last backup', value: harnessLastText(h, now, pt) },
                  ]}
                />
              ))}
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <Th>{pt ? 'Harness' : 'Harness'}</Th>
                    <Th>{pt ? 'No backup' : 'In backup'}</Th>
                    <Th>{pt ? 'Sessões' : 'Sessions'}</Th>
                    <Th>{pt ? 'Tamanho' : 'Size'}</Th>
                    <Th>{pt ? 'Último backup' : 'Last backup'}</Th>
                  </tr>
                </thead>
                <tbody>
                  {harnessRows.map(h => (
                    <tr key={h.id}>
                      <Td>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: HARNESS_COLORS[h.id], flexShrink: 0 }} />
                          {HARNESS_LABELS[h.id]}
                        </span>
                      </Td>
                      <Td>{h.enabled ? (pt ? 'sim' : 'yes') : (pt ? 'não' : 'no')}</Td>
                      <Td>{h.sessions}</Td>
                      <Td>{h.sizeLabel}</Td>
                      <Td>{harnessLastText(h, now, pt)}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Divider />

          {/* History */}
          <SectionHeader label={pt ? 'Histórico' : 'History'} />
          {status.history.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', padding: '8px 0 20px' }}>
              {pt ? 'Nenhum backup registrado ainda.' : 'No backups recorded yet.'}
            </div>
          ) : isMobile ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {status.history.map((h, i) => (
                <RecordCard
                  key={`${h.at}-${i}`}
                  title={new Date(h.at).toLocaleString()}
                  subtitle={h.layers.join(' + ')}
                  badge={
                    <HistoryBadge present={h.present} pt={pt} />
                  }
                  fields={[
                    { label: pt ? 'Tamanho' : 'Size', value: h.bytesLabel },
                    { label: pt ? 'Harnesses' : 'Harnesses', value: h.harnesses.length },
                    ...(h.skipped ? [{ label: pt ? 'Ignorados' : 'Skipped', value: h.skipped }] : []),
                  ]}
                />
              ))}
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <Th>{pt ? 'Data' : 'Date'}</Th>
                    <Th>{pt ? 'Camadas' : 'Layers'}</Th>
                    <Th>{pt ? 'Tamanho' : 'Size'}</Th>
                    <Th>{pt ? 'Harnesses' : 'Harnesses'}</Th>
                    <Th>{pt ? 'Situação' : 'Status'}</Th>
                  </tr>
                </thead>
                <tbody>
                  {status.history.map((h, i) => (
                    <tr key={`${h.at}-${i}`}>
                      <Td>{new Date(h.at).toLocaleString()}</Td>
                      <Td>{h.layers.join(' + ')}</Td>
                      <Td>{h.bytesLabel}</Td>
                      <Td>{h.harnesses.length}</Td>
                      <Td><HistoryBadge present={h.present} pt={pt} /></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ConfigRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12,
      padding: '7px 0', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)', flexShrink: 0 }}>{label}</span>
      <span style={{
        fontSize: 12.5, color: 'var(--text-primary)', textAlign: 'right', minWidth: 0,
        wordBreak: 'break-word', fontFamily: mono ? 'monospace' : 'inherit',
      }}>
        {value}
      </span>
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={{
      textAlign: 'left', fontSize: 10.5, fontWeight: 700, color: 'var(--text-tertiary)',
      letterSpacing: '0.06em', textTransform: 'uppercase', padding: '0 10px 8px', whiteSpace: 'nowrap',
    }}>
      {children}
    </th>
  )
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td style={{
      fontSize: 12.5, color: 'var(--text-secondary)', padding: '9px 10px',
      borderTop: '1px solid var(--border-subtle)', verticalAlign: 'middle', whiteSpace: 'nowrap',
    }}>
      {children}
    </td>
  )
}

/** A recorded backup whose file is gone says so — never a reassuring "ok". */
function HistoryBadge({ present, pt }: { present: boolean; pt: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600,
      color: present ? 'var(--accent-green)' : '#ef4444',
    }}>
      {present ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
      {present ? (pt ? 'no disco' : 'on disk') : (pt ? 'arquivo ausente' : 'file gone')}
    </span>
  )
}
