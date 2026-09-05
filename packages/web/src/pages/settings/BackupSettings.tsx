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
import { PlayCircle, Loader2, AlertTriangle, CheckCircle2, Clock, ChevronLeft, ChevronRight } from 'lucide-react'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import type { AppContext } from '../../lib/app-context'
import { HARNESS_LABELS, HARNESS_COLORS } from '../../lib/harness'
import { useIsMobile } from '../../hooks/useIsMobile'
import { SectionHeader, Divider, RecordCard, Checkbox } from './primitives'

// Redeclared from `server/backup/backup-plan.ts` / `server/backup/schedule.ts` — `packages/web`
// may never import `packages/server` (Vite would try to bundle it and fail on Bun/Node APIs).
// `BACKUP_LAYERS` order matters: metrics leads, and every layer row below is drawn in this order.
type BackupLayer = 'metrics' | 'repos' | 'archive' | 'raw'
const BACKUP_LAYERS: BackupLayer[] = ['metrics', 'repos', 'archive', 'raw']
type BackupScheduleId = 'off' | 'daily' | 'weekly'
const SCHEDULE_IDS: BackupScheduleId[] = ['off', 'daily', 'weekly']

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

/** `present` / `pruned` / `missing` — computed server-side by `backup-store.ts`'s `markPresence`,
 *  never re-derived here. `pruned` (we deleted it on purpose, by retention) and `missing` (gone
 *  for some other reason) look identical from a client's point of view — only the server, holding
 *  the prune events, can tell them apart. */
type BackupPresence = 'present' | 'pruned' | 'missing'

interface BackupHistoryJson {
  at: string
  layers: string[]
  harnesses: HarnessId[]
  bytesLabel: string
  skipped?: number
  presence: BackupPresence
}

/** `fits` / `maybe-not` — see `backup-github.ts`. NOT the "push to GitHub" feature (it does not
 *  exist yet); this is the honest indicator computed from the measured uncompressed total. */
type GithubFitVerdict = 'fits' | 'maybe-not'

interface BackupStatusJson {
  harnesses: BackupHarnessJson[]
  config: {
    layers: BackupLayer[]
    /** Layers a SCHEDULED run writes — deliberately separate from `layers`, so a daily schedule
     *  cannot silently inherit `raw` from a manual run and fill a disk. */
    scheduleLayers: BackupLayer[]
    destDir: string
    schedule: string
    scheduleActive: boolean
    keep: number
    retainedLabel: string
    secretsCount: number
    /** Every layer's measured weight on this machine, already formatted. `repos` is `null` —
     *  produced during a run, not measurable ahead of one — rendered as "known after running". */
    layerSizes: Record<BackupLayer, string | null>
    /** Whether the ticked layers would fit a single GitHub Release asset (2 GB per file),
     *  recomputed by the server on every read — see `backup-github.ts`. */
    githubFit: GithubFitVerdict
    scheduleGithubFit: GithubFitVerdict
    /** This machine's history-preservation mode, when chosen. Absent reads the same as anything
     *  other than `'full'` — the `archive` layer is frozen either way. */
    archiveMode?: 'off' | 'consolidate' | 'full'
    last?: { at: string; bytesLabel: string; skipped?: number }
  }
  history: BackupHistoryJson[]
}

/** Everything the format/recurrence pickers can change in one call — mirrors the server's
 *  `BackupConfigPatch` (`backup-routes.ts`). All fields optional: a picker sends only what it
 *  changed. */
interface BackupConfigPatch {
  layers?: BackupLayer[]
  scheduleLayers?: BackupLayer[]
  schedule?: BackupScheduleId
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

/**
 * The four layers, under the names a person thinks in — never the CLI's own `metrics`/`repos`/
 * `archive`/`raw` vocabulary, which is what the read-only config rows above still use (that value
 * is deliberately untranslated, the same convention as `native`/`docker`). This is the only place
 * the friendly names are used, for the format/recurrence pickers below.
 */
const LAYER_NAME: Record<BackupLayer, { en: string; pt: string }> = {
  metrics: { en: 'Metrics', pt: 'Métricas' },
  repos: { en: 'Repositories', pt: 'Repositórios' },
  archive: { en: 'Mirrored transcripts', pt: 'Transcripts espelhados' },
  raw: { en: 'Conversations', pt: 'Conversas' },
}

/**
 * What each layer ACTUALLY saves — the truth about the code, not marketing. Shown under its row
 * in the format/recurrence pickers so a checked box is never unexplained. The same wording the
 * cockpit's `backup` tab uses (`control/i18n.ts`'s `backupLayerDescription`) — the two surfaces
 * must teach the same vocabulary, never two different ones for the same checkbox.
 */
const LAYER_DESCRIPTION: Record<BackupLayer, { en: string; pt: string }> = {
  metrics: {
    en: 'The computed record of every session — cost, tokens, model, duration, files touched — '
      + 'plus the deep Claude aggregate, tags, workflows and your preferences.',
    pt: 'O registro calculado de cada sessão — custo, tokens, modelo, duração, arquivos tocados — '
      + 'mais o agregado profundo do Claude, tags, workflows e suas preferências.',
  },
  repos: {
    en: 'A map of every project directory, plus a bundle of each repository\'s commits that are '
      + 'not on its remote, and a patch of the uncommitted changes in each working tree. Restores '
      + 'your repository layout and unpushed work.',
    pt: 'Um mapa de cada diretório de projeto, mais um bundle dos commits de cada repositório que '
      + 'não estão no remoto, e um patch das mudanças não commitadas de cada working tree. Restaura '
      + 'a estrutura dos seus repositórios e o trabalho não enviado.',
  },
  archive: {
    en: 'Transcripts already mirrored into ~/.agentistics/archive.',
    pt: 'Transcripts que já foram espelhados em ~/.agentistics/archive.',
  },
  raw: {
    en: 'The harness directories themselves — the conversation text. Lets a session be resumed '
      + 'after a restore. Gigabytes.',
    pt: 'Os diretórios dos harnesses em si — o texto das conversas. Permite retomar uma sessão '
      + 'depois de um restore. Gigabytes.',
  },
}

/** `metrics` ALWAYS carries this — the one fact its own name does not carry. */
function metricsNoResumeText(pt: boolean): string {
  return pt
    ? 'Isto sozinho não permite retomar uma sessão — não guarda texto de conversa.'
    : 'This alone does not let you resume a session — it holds no conversation text.'
}

/** `archive` only grows while `archiveMode === 'full'`. Named on the row when it is anything
 *  else (including never chosen), so a frozen layer does not look live. `mode` is the CLI's own
 *  untranslated word, same convention as `native`/`docker`. */
function archiveFrozenText(mode: string, pt: boolean): string {
  return pt
    ? `congelado nesta máquina — a preservação de histórico está em \`${mode}\`, não em \`full\``
    : `frozen on this machine — history preservation is set to \`${mode}\`, not \`full\``
}

/** One row's own legend — description, plus a caveat in parentheses when it has one. */
function layerLegendText(
  layer: BackupLayer, archiveMode: BackupStatusJson['config']['archiveMode'], pt: boolean,
): string {
  const description = pt ? LAYER_DESCRIPTION[layer].pt : LAYER_DESCRIPTION[layer].en
  const caveat = layer === 'metrics' ? metricsNoResumeText(pt)
    : layer === 'archive' && archiveMode !== 'full' ? archiveFrozenText(archiveMode ?? (pt ? 'ainda não escolhido' : 'not chosen yet'), pt)
    : null
  return caveat ? `${description} ${caveat}` : description
}

const GITHUB_FIT_TEXT: Record<GithubFitVerdict, { en: string; pt: string }> = {
  fits: { en: 'fits a GitHub Release, for certain', pt: 'cabe num release do GitHub, com certeza' },
  'maybe-not': {
    en: 'might not fit a GitHub Release (2 GB per file) — the real size is only known after compressing',
    pt: 'pode não caber num release do GitHub (limite de 2 GB por arquivo) — o tamanho real só é conhecido depois de comprimir',
  },
}

function layerSizeText(sizes: BackupStatusJson['config']['layerSizes'], layer: BackupLayer, pt: boolean): string {
  return sizes[layer] ?? (pt ? 'conhecido só depois de rodar' : 'known after running')
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
  // The history list is paginated client-side, newest first (the server already sorts it that
  // way) — a machine with months of daily backups must not render as one endless table.
  const [historyPage, setHistoryPage] = useState(0)
  const HISTORY_PAGE_SIZE = 10

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

  // The format/recurrence pickers' one write path — `POST /api/backup/config`, the same three
  // writers `agentop backup config` and the cockpit's layers editor call. `savingConfig` disables
  // every checkbox and the schedule buttons while a request is in flight, so a second tap cannot
  // race the first: `writeBackupLayers`/`writeBackupScheduleLayers` read-modify-write preferences,
  // and two overlapping writes would let the earlier one win after the later one already returned.
  const [savingConfig, setSavingConfig] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)

  const patchConfig = useCallback(async (patch: BackupConfigPatch) => {
    setSavingConfig(true)
    setConfigError(null)
    try {
      const r = await fetch('/api/backup/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
      const data = await r.json() as { ok: true; status: BackupStatusJson } | { ok: false; reason: string }
      if (data.ok) setStatus(data.status)
      else setConfigError(data.reason || (pt ? 'não foi possível salvar' : 'could not save'))
    } catch {
      setConfigError(pt ? 'a requisição falhou' : 'the request failed')
    } finally {
      setSavingConfig(false)
    }
  }, [pt])

  /** Metrics can never be toggled off — this only ever fires for `repos`/`archive`/`raw`, and
   *  `updateBackupConfig` (server) normalizes the set regardless, so this is a UI convenience,
   *  never the enforcement. */
  const toggleLayer = useCallback((kind: 'layers' | 'scheduleLayers', layer: BackupLayer, checked: boolean) => {
    if (!status || layer === 'metrics') return
    const current = status.config[kind]
    const next = checked ? [...current, layer] : current.filter(l => l !== layer)
    void patchConfig({ [kind]: next })
  }, [status, patchConfig])

  const byId = new Map((status?.harnesses ?? []).map(h => [h.id, h]))
  // HARNESS_ORDER, never the server array's own order — the same discipline every other surface
  // that lists harnesses follows.
  const harnessRows = HARNESS_ORDER.filter(id => byId.has(id)).map(id => byId.get(id)!)

  // The history page — clamped rather than trusted, so a page left pointing past the end after
  // the list shrinks (a prune) corrects itself instead of rendering nothing.
  const historyAll = status?.history ?? []
  const historyPages = Math.max(1, Math.ceil(historyAll.length / HISTORY_PAGE_SIZE))
  const historyPageClamped = Math.min(Math.max(0, historyPage), historyPages - 1)
  const historyShown = historyAll.slice(
    historyPageClamped * HISTORY_PAGE_SIZE, historyPageClamped * HISTORY_PAGE_SIZE + HISTORY_PAGE_SIZE,
  )

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

          {/* Configuration — the facts this page does not let you change: destination, retention,
              excluded secrets, and the last run. Layers and the schedule are below, interactive. */}
          <SectionHeader label={pt ? 'Configuração' : 'Configuration'} />
          <ConfigRow label={pt ? 'Destino' : 'Destination'} value={status.config.destDir} mono />
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

          {configError && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderRadius: 8,
              background: 'color-mix(in srgb, #ef4444 8%, transparent)',
              border: '1px solid color-mix(in srgb, #ef4444 28%, transparent)',
              fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 16,
            }}>
              <AlertTriangle size={14} style={{ color: '#ef4444', flexShrink: 0 }} />
              <span>{configError}</span>
            </div>
          )}

          {/* Format — the four layers, under the names a person thinks in, each with its measured
              size on this machine. Metrics is always on and non-interactive. */}
          <SectionHeader label={pt ? 'Formato' : 'Format'} />
          <p style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: '-6px 0 12px' }}>
            {pt
              ? 'O que um backup MANUAL grava. Um sinalizador explícito da CLI (--with-archive/--with-raw) tem prioridade sobre esta escolha.'
              : 'What a MANUAL backup writes. An explicit CLI flag (--with-archive/--with-raw) overrides this choice.'}
          </p>
          <LayerPicker
            layers={status.config.layers}
            sizes={status.config.layerSizes}
            archiveMode={status.config.archiveMode}
            pt={pt}
            disabled={savingConfig}
            onToggle={(layer, checked) => toggleLayer('layers', layer, checked)}
          />
          <GithubFitNote verdict={status.config.githubFit} pt={pt} />

          <Divider />

          {/* Recurrence — the schedule, and (deliberately separate) what a SCHEDULED run carries. */}
          <SectionHeader label={pt ? 'Recorrência' : 'Recurrence'} />
          <SchedulePicker
            value={SCHEDULE_IDS.includes(status.config.schedule as BackupScheduleId)
              ? status.config.schedule as BackupScheduleId : 'off'}
            active={status.config.scheduleActive}
            pt={pt}
            disabled={savingConfig}
            onChange={schedule => void patchConfig({ schedule })}
          />
          <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', margin: '18px 0 4px' }}>
            {pt ? 'O que uma execução agendada grava' : 'What a scheduled run carries'}
          </p>
          <LayerPicker
            layers={status.config.scheduleLayers}
            sizes={status.config.layerSizes}
            archiveMode={status.config.archiveMode}
            pt={pt}
            disabled={savingConfig}
            onToggle={(layer, checked) => toggleLayer('scheduleLayers', layer, checked)}
          />
          <GithubFitNote verdict={status.config.scheduleGithubFit} pt={pt} />
          {status.config.scheduleLayers.includes('repos') && (
            <p style={{ fontSize: 12, color: 'var(--anthropic-orange)', lineHeight: 1.5, margin: '8px 0 0' }}>
              {pt
                ? 'Uma execução agendada nunca carrega isto — é construído por `agentop backup`, não numa agenda.'
                : 'A scheduled run never carries this — it is built by `agentop backup`, not on a schedule.'}
            </p>
          )}

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

          {/* History — paginated, newest first. Unpaginated was an actual bug report: a machine
              with months of daily backups rendered as one endless, unreadable table. */}
          <SectionHeader label={pt ? 'Histórico' : 'History'} />
          {historyAll.length === 0 ? (
            <div style={{ fontSize: 12.5, color: 'var(--text-tertiary)', padding: '8px 0 20px' }}>
              {pt ? 'Nenhum backup registrado ainda.' : 'No backups recorded yet.'}
            </div>
          ) : isMobile ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {historyShown.map((h, i) => (
                <RecordCard
                  key={`${h.at}-${i}`}
                  title={new Date(h.at).toLocaleString()}
                  subtitle={h.layers.join(' + ')}
                  badge={
                    <HistoryBadge presence={h.presence} pt={pt} />
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
                  {historyShown.map((h, i) => (
                    <tr key={`${h.at}-${i}`}>
                      <Td>{new Date(h.at).toLocaleString()}</Td>
                      <Td>{h.layers.join(' + ')}</Td>
                      <Td>{h.bytesLabel}</Td>
                      <Td>{h.harnesses.length}</Td>
                      <Td><HistoryBadge presence={h.presence} pt={pt} /></Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {historyAll.length > 0 && (
            <HistoryPager
              page={historyPageClamped} pages={historyPages} total={historyAll.length}
              pageSize={HISTORY_PAGE_SIZE} pt={pt}
              onChange={p => setHistoryPage(p)}
            />
          )}
        </>
      )}
    </div>
  )
}

/** `1–10 of 42`, with prev/next buttons — real ≥44px touch targets on mobile. Clamped by the
 *  caller (`historyPageClamped`), so this component never has to guess whether `page` is valid. */
function HistoryPager({ page, pages, total, pageSize, pt, onChange }: {
  page: number
  pages: number
  total: number
  pageSize: number
  pt: boolean
  onChange: (page: number) => void
}) {
  const isMobile = useIsMobile()
  if (pages <= 1) return null
  const from = page * pageSize + 1
  const to = Math.min(total, from + pageSize - 1)
  const btnStyle = (enabled: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 44, height: 44, borderRadius: 7,
    border: '1px solid var(--border)', background: 'transparent',
    color: enabled ? 'var(--text-secondary)' : 'var(--text-tertiary)',
    cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.4,
  })
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
      marginTop: 12, flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
        {pt ? `${from}–${to} de ${total}` : `${from}–${to} of ${total}`}
      </span>
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button" aria-label={pt ? 'Página anterior' : 'Previous page'}
          disabled={page === 0} onClick={() => onChange(page - 1)}
          style={{ ...btnStyle(page > 0), minHeight: isMobile ? 44 : 36, minWidth: isMobile ? 44 : 36, width: isMobile ? 44 : 36, height: isMobile ? 44 : 36 }}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          type="button" aria-label={pt ? 'Próxima página' : 'Next page'}
          disabled={page >= pages - 1} onClick={() => onChange(page + 1)}
          style={{ ...btnStyle(page < pages - 1), minHeight: isMobile ? 44 : 36, minWidth: isMobile ? 44 : 36, width: isMobile ? 44 : 36, height: isMobile ? 44 : 36 }}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  )
}

/**
 * The GitHub-fit indicator beside the format picker — NOT the "push to GitHub" feature (it does
 * not exist yet). Reasoned only from the measured UNCOMPRESSED total; see `backup-github.ts`.
 */
function GithubFitNote({ verdict, pt }: { verdict: GithubFitVerdict; pt: boolean }) {
  const text = pt ? GITHUB_FIT_TEXT[verdict].pt : GITHUB_FIT_TEXT[verdict].en
  return (
    <p style={{
      fontSize: 11.5, color: verdict === 'fits' ? 'var(--text-tertiary)' : 'var(--anthropic-orange)',
      lineHeight: 1.5, margin: '8px 0 0',
    }}>
      {text}
    </p>
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

/**
 * Three states, not two — see `backup-store.ts`'s `markPresence`. A backup pruned by RETENTION
 * (the normal, expected outcome of a week of daily backups) is neutral wording in the muted
 * colour; only a genuinely MISSING file — recorded, not pruned by us, and not on disk — gets the
 * warning red. Rendering both the same red is exactly the "looks full of errors" complaint this
 * fix answers.
 */
function HistoryBadge({ presence, pt }: { presence: BackupPresence; pt: boolean }) {
  if (presence === 'present') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: 'var(--accent-green)' }}>
        <CheckCircle2 size={12} />
        {pt ? 'no disco' : 'on disk'}
      </span>
    )
  }
  if (presence === 'pruned') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)' }}>
        <Clock size={12} />
        {pt ? 'removido pela retenção' : 'pruned by retention'}
      </span>
    )
  }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600,
      color: '#ef4444',
    }}>
      <AlertTriangle size={12} />
      {pt ? 'arquivo ausente' : 'file gone'}
    </span>
  )
}

/**
 * The FORMAT picker — one row per `BACKUP_LAYERS` member, each a checkbox (whole row is the
 * control, ≥44px on mobile via the shared `Checkbox`) plus its measured size, right-aligned.
 *
 * `metrics` is always rendered checked and disabled, with the reason stated in a sentence right
 * under its row — a backup without it restores nothing, and disabling a control silently is not
 * the same as saying why. Used for BOTH the manual `layers` set and the SCHEDULE's own
 * `scheduleLayers` — the caller decides which one `onToggle` writes to.
 */
function LayerPicker({ layers, sizes, archiveMode, pt, disabled, onToggle }: {
  layers: BackupLayer[]
  sizes: BackupStatusJson['config']['layerSizes']
  /** Absent reads the same as anything other than `'full'` — the `archive` row's caveat covers
   *  both cases identically, never a confident "it's fine". */
  archiveMode: BackupStatusJson['config']['archiveMode']
  pt: boolean
  disabled: boolean
  onToggle: (layer: BackupLayer, checked: boolean) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {BACKUP_LAYERS.map(layer => {
        const fixed = layer === 'metrics'
        const checked = fixed || layers.includes(layer)
        return (
          <div key={layer}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
              <Checkbox
                checked={checked}
                onChange={c => onToggle(layer, c)}
                label={pt ? LAYER_NAME[layer].pt : LAYER_NAME[layer].en}
                disabled={fixed || disabled}
              />
              <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)', flexShrink: 0 }}>
                {layerSizeText(sizes, layer, pt)}
              </span>
            </div>
            {fixed && (
              <p style={{ fontSize: 11, color: 'var(--text-tertiary)', margin: '2px 0 0 24px' }}>
                {pt
                  ? 'sempre ativo — um backup sem métricas não restaura nada'
                  : 'always on — a backup with no metrics restores nothing'}
              </p>
            )}
            {/* What this layer actually saves, and its caveat if it has one (metrics: cannot
                resume a session; archive: frozen outside `full` mode) — the legend this whole fix
                exists to put beside every checked box. */}
            <p style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.45, margin: '2px 0 0 24px' }}>
              {layerLegendText(layer, archiveMode, pt)}
            </p>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The RECURRENCE picker — off / daily / weekly, as a segmented control. A custom row rather than
 * the shared `TabSelect` (which uses fixed, sub-44px padding): this control must be a real touch
 * target on mobile, exactly like the "Run backup now" button above it.
 *
 * `active` mirrors `ControlBackupConfig.scheduleActive` — with the server stopped, a schedule other
 * than `off` reads INACTIVE rather than a "next at…" that will not arrive.
 */
function SchedulePicker({ value, active, pt, disabled, onChange }: {
  value: BackupScheduleId
  active: boolean
  pt: boolean
  disabled: boolean
  onChange: (schedule: BackupScheduleId) => void
}) {
  const isMobile = useIsMobile()
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {SCHEDULE_IDS.map(id => {
          const on = id === value
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              disabled={disabled}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                padding: isMobile ? '0 16px' : '7px 16px', minHeight: isMobile ? 44 : undefined,
                flex: isMobile ? 1 : undefined, minWidth: isMobile ? 0 : 84,
                borderRadius: 7, border: `1px solid ${on ? 'var(--anthropic-orange)' : 'var(--border)'}`,
                background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
                color: on ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
                fontSize: 12.5, fontWeight: on ? 700 : 500, fontFamily: 'inherit',
                cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
              }}
            >
              {pt ? SCHEDULE_WORD[id]!.pt : SCHEDULE_WORD[id]!.en}
            </button>
          )
        })}
      </div>
      {value !== 'off' && !active && (
        <p style={{ fontSize: 11.5, color: 'var(--anthropic-orange)', margin: '8px 0 0' }}>
          {pt
            ? 'inativo — o servidor não está rodando, então nada vai disparar'
            : 'inactive — the server is not running, so nothing will fire'}
        </p>
      )}
    </div>
  )
}
