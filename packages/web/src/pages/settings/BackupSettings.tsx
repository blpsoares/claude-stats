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
// `RotateCcw` is the restore verb's glyph; `Pencil` and `Trash2` are the repository row's two
// verbs. There is deliberately no `Github` here: lucide-react v1
// — the version this repo installs — carries no brand icons, so the GitHub mark is the local
// `GithubMark` SVG below rather than a new dependency for one glyph.
import { PlayCircle, Loader2, AlertTriangle, CheckCircle2, Clock, ChevronLeft, ChevronRight, RotateCcw, Pencil, Trash2 } from 'lucide-react'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
import type { AppContext } from '../../lib/app-context'
import { HARNESS_LABELS, HARNESS_COLORS } from '../../lib/harness'
import { useIsMobile } from '../../hooks/useIsMobile'
import { OVERLAY_TOP } from '../../lib/mobileOverlay'
import { SectionHeader, Divider, RecordCard, Checkbox } from './primitives'

// Redeclared from `server/backup/backup-plan.ts` / `server/backup/schedule.ts` — `packages/web`
// may never import `packages/server` (Vite would try to bundle it and fail on Bun/Node APIs).
// `BACKUP_LAYERS` order matters: metrics leads, and every layer row below is drawn in this order.
type BackupLayer = 'metrics' | 'repos' | 'archive' | 'raw'
const BACKUP_LAYERS: BackupLayer[] = ['metrics', 'repos', 'archive', 'raw']
type BackupScheduleId = 'off' | 'daily' | 'weekly' | 'custom'
const SCHEDULE_IDS: BackupScheduleId[] = ['off', 'daily', 'weekly', 'custom']

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

/** `fits` / `maybe-not` — see `backup-github.ts`. NOT the versioning section below; this is only
 *  the honest size indicator computed from the measured uncompressed total. */
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
    /** Hours between runs when `schedule` is `'custom'`; null when never set. */
    customHours: number | null
    /** The local hour a daily/weekly run is anchored to; null when never chosen. */
    atHour: number | null
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
  /** Hours between runs, when `schedule` is `'custom'`. */
  customHours?: number
  /** The local hour a daily/weekly run is anchored to. */
  atHour?: number
}

type RunOutcome = { ok: true; bytesLabel: string; skipped?: number } | { ok: false; reason: string }

/**
 * GitHub versioning — mirrors `backup-routes.ts`'s `GithubSection`. There is NO token field here
 * and there must never be one: the GET does not carry it, this page has no input for it, and
 * connecting a repository (the one step that genuinely needs a PAT, verified against the API and
 * refused on a public repository) lives in `agentop backup github setup`.
 */
type GithubSectionJson =
  | {
    configured: false
    /** Whether this machine can authenticate through the GitHub CLI it already has. */
    gh?: { usable: true; account: string } | { usable: false; reason: 'not-installed' | 'logged-out' }
  }
  | {
    configured: true
    url: string
    /** `owner/repo`, for display. */
    repo: string
    /** What this machine is called in its release tags. */
    label: string
    /** How many of THIS machine's releases to keep. 0 = keep them all. */
    keepRemote: number
    deleteLocalAfterUpload: boolean
    /** Which credential this machine uses. `'gh'` means nothing is stored here. */
    auth: 'token' | 'gh'
    /**
     * A better name for this machine than the one stored, or null.
     *
     * Non-null only when the stored label is the hostname — a default nobody typed — AND a central
     * holds a real name for the same machine. OFFERED, never applied: the label rides in the
     * release tag, so switching it splits this machine's history into two that retention then
     * treats as two machines.
     */
    suggestedLabel: string | null
  }

/**
 * RESTORE — mirrors `server/backup/restore-routes.ts`'s `RestoreCandidate` / `RestoreMachine` /
 * `RestoreJob`. Redeclared for the same reason every other wire shape on this page is: `packages/web`
 * may never import `packages/server`.
 *
 * EVERY derived field is nullable, and that is the whole point of the shape: a release whose body
 * could not be decoded is still LISTED — dropping it could hide somebody's only copy — with what is
 * unknown SAID. Rendering a null `sessions` as `0` or a null `sizeLabel` as an empty cell would
 * invent a fact about a stranger's backup, which is the one thing a restore screen must never do.
 */
interface RestoreCandidate {
  tagName: string
  createdAt: string
  sizeLabel: string | null
  layers: BackupLayer[] | null
  harnesses: string[] | null
  sessions: number | null
  sha256: string | null
}

/** `machine === null` is a backup whose machine name the release body never recorded — said in
 *  words, never printed as a name. */
interface RestoreMachine {
  machine: string | null
  /** Is this the machine the user is sitting at? Marked, and sorted first, by the server. */
  thisMachine: boolean
  releases: RestoreCandidate[]
}

type RestoreJobState = 'queued' | 'running' | 'done' | 'failed'

/** A restore in flight. It is a JOB and not a request/response because the repos phase clones every
 *  repository the backup mapped and can take many minutes — see `restore-routes.ts`. */
interface RestoreJob {
  id: string
  tag: string
  withRepos: boolean
  state: RestoreJobState
  startedAt: string
  finishedAt: string | null
  lines: string[]
  written: number | null
  reason: string | null
}

/** How many of a running restore's tail lines the block below shows. The server keeps 500 (the
 *  repos phase prints thousands); a screen only ever needs the end. */
const RESTORE_TAIL_LINES = 15

function unknownWord(pt: boolean): string {
  return pt ? 'desconhecido' : 'unknown'
}

/**
 * The GitHub mark.
 *
 * NOT a lucide icon: `lucide-react` v1 — the version this repo installs — dropped every brand
 * glyph, so there is no `Github` export to import (checked against the installed
 * `lucide-react.d.ts`: `GitBranch`, `GitFork`, `GitMerge` … and no `Github`). A settings page may
 * not pull in a new dependency for one glyph, and this file is the only one this change may touch,
 * so the mark is inlined here. It paints in `currentColor` and takes a `size`, exactly like the
 * lucide icons beside it, so it can sit on any row and inherit that row's colour.
 */
function GithubMark({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 16 16" fill="currentColor"
      aria-hidden="true" focusable="false" style={{ flexShrink: 0 }}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

/**
 * A section heading with a glyph beside it — the SAME `SectionHeader` every other section on this
 * page uses, never a second heading style. Both children carry the header's own `marginBottom`, so
 * the flex row centres their margin boxes against each other and the glyph sits on the word's line.
 */
function SectionHeaderWithIcon({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <span style={{
        display: 'inline-flex', color: 'var(--text-tertiary)', flexShrink: 0, marginBottom: 14,
      }}>
        {icon}
      </span>
      <SectionHeader label={label} />
    </div>
  )
}

/** Mirrors the server's `GithubSectionUpdate` — every field optional, a control sends only its own. */
interface GithubUpdate {
  label?: string
  keepRemote?: number
  deleteLocalAfterUpload?: boolean
}

type GithubSaveOutcome = { ok: true; section: GithubSectionJson } | { ok: false; reason: string }

/** Which control is writing / which one a message belongs to. Feedback is rendered under the
 *  control that produced it — one shared status line would leave a reader guessing which of three
 *  saves it is talking about. */
type GithubField = 'label' | 'keepRemote' | 'deleteLocalAfterUpload'

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
  custom: { en: 'custom', pt: 'personalizado' },
}

/** The floor the server clamps to (`MIN_CUSTOM_HOURS`). Mirrored, never imported — the web bundle
 *  may not import from `packages/server`. */
const MIN_CUSTOM_HOURS = 1

/**
 * The named shapes a backup can take — mirrored from `backup/backup-presets.ts` (the web bundle may
 * never import from `packages/server`). `backup-presets.test.ts` owns the rules; this is the list
 * and its words.
 *
 * Exactly one is RECOMMENDED, and it says so on the button. The four layer checkboxes are four
 * independent switches, and asking somebody to pick among them is asking them to already know what
 * a restore needs — the layers are not a preference, they decide whether a restore brings a
 * machine back or half of one.
 */
const BACKUP_PRESETS: { id: string; layers: BackupLayer[]; recommended?: true }[] = [
  { id: 'minimal', layers: ['metrics'] },
  { id: 'recommended', layers: ['metrics', 'repos'], recommended: true },
  { id: 'everything', layers: ['metrics', 'repos', 'archive', 'raw'] },
]

const PRESET_TEXT: Record<string, { en: { name: string; what: string }; pt: { name: string; what: string } }> = {
  minimal: {
    en: { name: 'Essentials', what: 'Sessions, metrics and settings. The dashboard comes back; the map of where your repositories were does not.' },
    pt: { name: 'Essencial', what: 'Sessões, métricas e configurações. O dashboard volta; o mapa de onde ficavam seus repositórios não.' },
  },
  recommended: {
    en: { name: 'Recommended', what: 'The essentials plus the map of every repository, a bundle of the commits that exist on no remote and a patch of your uncommitted work. The difference between “my dashboard is back” and “my machine is back”.' },
    pt: { name: 'Recomendado', what: 'O essencial mais o mapa de cada repositório, um pacote dos commits que não estão em remote nenhum e um patch do que você não commitou. A diferença entre “meu dashboard voltou” e “minha máquina voltou”.' },
  },
  everything: {
    en: { name: 'Everything', what: 'Adds the conversation transcripts. Complete, and much larger — a size to choose on purpose rather than arrive at.' },
    pt: { name: 'Tudo', what: 'Inclui as transcrições das conversas. Completo, e muito maior — um tamanho para se escolher de propósito, não para se chegar sem querer.' },
  },
}

/** Which preset a layer set IS, by SET and not by order — or null. Never a nearest guess: telling
 *  somebody they are on the recommended shape when they are not is worse than saying they are on
 *  their own. */
function presetOf(layers: BackupLayer[]): string | null {
  const want = [...new Set(layers)].sort().join(',')
  return BACKUP_PRESETS.find(p => [...p.layers].sort().join(',') === want)?.id ?? null
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
    en: 'Your agentistics settings, plus the computed record of every session — cost, tokens, '
      + 'model, duration, files touched — the deep Claude aggregate, tags, workflows, attachments '
      + 'and your event subscriptions.',
    pt: 'Suas configurações do agentistics, mais o registro calculado de cada sessão — custo, '
      + 'tokens, modelo, duração, arquivos tocados — o agregado profundo do Claude, tags, '
      + 'workflows, anexos e as assinaturas de evento.',
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

/** The exact command that connects a repository. Kept as one constant so the copy and the block
 *  the user reads can never drift apart. */
const GITHUB_SETUP_COMMAND = 'agentop backup github setup https://github.com/OWNER/REPO'

/**
 * The server's refusal reasons, in words. An unknown reason is printed AS IS rather than replaced
 * by a friendly generic — a code the reader can quote is worth more than a sentence that hides it.
 */
const GITHUB_REASON_TEXT: Record<string, { en: string; pt: string }> = {
  not_configured: {
    en: 'no GitHub repository is connected on this machine',
    pt: 'nenhum repositório do GitHub está conectado nesta máquina',
  },
  bad_label: {
    en: 'the machine name cannot be empty',
    pt: 'o nome da máquina não pode ficar vazio',
  },
  bad_keep_remote: {
    en: 'the number must be a whole number, 0 or greater',
    pt: 'o número precisa ser inteiro, 0 ou maior',
  },
  bad_request: {
    en: 'the request was malformed',
    pt: 'a requisição estava malformada',
  },
}

function githubReasonText(reason: string, pt: boolean): string {
  const entry = GITHUB_REASON_TEXT[reason]
  return entry ? (pt ? entry.pt : entry.en) : reason
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

  // GitHub versioning — its OWN read, and its own silence. A central answers 404 here
  // (`index.ts`'s `TEAM_CENTRAL` guard) and 404 renders NOTHING: a central aggregates other
  // machines and has no local machine to version, so an error box would report a fault that isn't
  // one. `github === null` therefore means "not available here", never "failed".
  const [github, setGithub] = useState<GithubSectionJson | null>(null)
  // The two text fields are drafts with an explicit Save — a rename or a retention change that
  // fired on every keystroke would write a half-typed name into every future release tag.
  const [labelDraft, setLabelDraft] = useState('')
  const [keepDraft, setKeepDraft] = useState('')
  const [githubSaving, setGithubSaving] = useState<GithubField | null>(null)
  // The connect form. Held here, not inside the form, so a refusal keeps what was typed — retyping
  // a PAT because the URL had a typo is the kind of friction that sends people back to the CLI.
  const [connectUrl, setConnectUrl] = useState('')
  const [connectToken, setConnectToken] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  /**
   * Authenticate through the GitHub CLI instead of storing a token.
   *
   * Defaults to ON the moment the server reports a usable `gh` — it is the better answer when it
   * is available (nothing is stored at all), and defaulting to the token would mean the machine
   * that needs no credential is the one being asked for one.
   */
  const [useGh, setUseGh] = useState(false)
  /**
   * The pencil. `true` puts the SAME `GithubConnectForm` on screen with the current URL prefilled,
   * so pointing this machine at a different repository is the very flow that connected it in the
   * first place — a second, smaller "change the URL" form would be a second set of checks and a
   * second place for the two to disagree about what a valid repository is.
   */
  const [editingRepo, setEditingRepo] = useState(false)
  /** The trash's modal. A destructive action never fires from the click that asks for it. */
  const [disconnectAsk, setDisconnectAsk] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [disconnectError, setDisconnectError] = useState<string | null>(null)

  /**
   * Connect the repository. The five checks live on the server (`connectGithub` calls the same
   * `setupGithubBackup` the CLI does), so this only carries the answer.
   *
   * The token is CLEARED on success and kept on failure: it is of no further use to this page once
   * accepted — it lives in the 0600 config from then on — and holding it in React state after that
   * is a copy with nothing to do.
   */
  const connectGithubRepo = useCallback(async () => {
    setConnecting(true)
    setConnectError(null)
    try {
      const r = await fetch('/api/backup/github/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: connectUrl, token: connectToken, auth: useGh ? 'gh' : 'token' }),
      })
      const data = (await r.json()) as { ok: boolean; reason?: string; section?: GithubSectionJson }
      if (data.ok && data.section) {
        setGithub(data.section)
        if (data.section.configured) {
          setLabelDraft(data.section.label)
          setKeepDraft(String(data.section.keepRemote))
        }
        // ONE repository. The restore section reads the SAME URL rather than asking for it again,
        // so a re-point through the pencil moves both halves at once — a stale restore URL left
        // behind would send "take it back from" at a repository this machine no longer writes to.
        if (data.section.configured) setRestoreUrl(data.section.url)
        setConnectToken('')
        setConnectUrl('')
        setEditingRepo(false)
      } else {
        setConnectError(data.reason ?? (pt ? 'não foi possível conectar' : 'could not connect'))
      }
    } catch {
      setConnectError(pt ? 'a requisição falhou' : 'the request failed')
    } finally {
      setConnecting(false)
    }
  }, [connectUrl, connectToken, useGh, pt])
  const [githubResult, setGithubResult] = useState<{ field: GithubField; ok: boolean; text: string } | null>(null)

  const loadGithub = useCallback(async () => {
    try {
      const r = await fetch('/api/backup/github')
      if (!r.ok) { setGithub(null); return }
      const data = (await r.json()) as GithubSectionJson
      setGithub(data)
      if (data.configured) {
        setLabelDraft(data.label)
        setKeepDraft(String(data.keepRemote))
      } else if (data.gh?.usable) {
        setUseGh(true)
      }
      // ONE repository, not two. Where this machine sends its backups is where it takes them back
      // from — asking for the URL a second time, in a second editable field on the same screen, was
      // two questions for one fact and invited them to disagree (reported verbatim: "eh 1 pra
      // destino e recuperação. apenas"). So a CONFIGURED machine's restore section shows this URL
      // read-only and the pencil above is the one place it changes; the editable field survives
      // only for the machine that has nothing connected, which has no other way to name a
      // repository. Set unconditionally for the same reason: there is nothing being typed to
      // overwrite.
      if (data.configured) setRestoreUrl(data.url)
    } catch {
      setGithub(null)
    }
  }, [])

  useEffect(() => { void loadGithub() }, [loadGithub])

  /**
   * The pencil. Prefills the connect form with what is stored — the URL, and which credential this
   * machine already uses — so "point me at a different repository" starts from the answer that is
   * true now rather than from an empty box. The token is deliberately NOT prefilled: it is never
   * returned by a route, so there is nothing to prefill it with.
   */
  const startEditRepo = useCallback(() => {
    if (!github?.configured) return
    setConnectUrl(github.url)
    setConnectToken('')
    setConnectError(null)
    setUseGh(github.auth === 'gh')
    setEditingRepo(true)
  }, [github])

  /** Cancel — back to the row, with nothing changed and nothing typed kept. */
  const cancelEditRepo = useCallback(() => {
    setEditingRepo(false)
    setConnectError(null)
    setConnectUrl('')
    setConnectToken('')
  }, [])

  /**
   * The trash's ONLY caller is the modal's confirm button. `DELETE /api/backup/github` removes the
   * LOCAL config and nothing else — the releases already on GitHub are untouched, which is the one
   * thing the modal says before asking. The refetch is what returns the page to its unconfigured
   * shape (the connect form); the server's own `reason` is passed through untouched on failure.
   */
  const disconnectGithubRepo = useCallback(async () => {
    setDisconnecting(true)
    setDisconnectError(null)
    try {
      const r = await fetch('/api/backup/github', { method: 'DELETE' })
      const data = (await r.json()) as { ok: true } | { ok: false; reason: string }
      if (data.ok) {
        setDisconnectAsk(false)
        setEditingRepo(false)
        setGithubResult(null)
        setConnectUrl('')
        setConnectToken('')
        setConnectError(null)
        await loadGithub()
      } else {
        setDisconnectError(data.reason || (pt ? 'não foi possível desconectar' : 'could not disconnect'))
      }
    } catch {
      setDisconnectError(pt ? 'a requisição falhou' : 'the request failed')
    } finally {
      setDisconnecting(false)
    }
  }, [loadGithub, pt])

  /** The one write path. Every control is disabled while a write is in flight (`githubSaving`),
   *  and every outcome — success or the server's own reason — lands under the control that asked
   *  for it. A click that resolves into nothing is the state this guards against. */
  const saveGithub = useCallback(async (field: GithubField, patch: GithubUpdate) => {
    setGithubSaving(field)
    setGithubResult(null)
    try {
      const r = await fetch('/api/backup/github', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
      const data = (await r.json()) as GithubSaveOutcome
      if (data.ok) {
        setGithub(data.section)
        if (data.section.configured) {
          setLabelDraft(data.section.label)
          setKeepDraft(String(data.section.keepRemote))
        }
        setGithubResult({ field, ok: true, text: pt ? 'Salvo.' : 'Saved.' })
      } else {
        setGithubResult({ field, ok: false, text: githubReasonText(data.reason, pt) })
      }
    } catch {
      setGithubResult({ field, ok: false, text: pt ? 'a requisição falhou' : 'the request failed' })
    } finally {
      setGithubSaving(null)
    }
  }, [pt])

  /** An empty name is refused HERE rather than by leaving Save greyed out: a control that is
   *  disabled for a reason it does not state is indistinguishable from a broken one. The server
   *  refuses the same input with the same `bad_label`. */
  const saveLabelName = useCallback(() => {
    const name = labelDraft.trim()
    if (!name) {
      setGithubResult({ field: 'label', ok: false, text: githubReasonText('bad_label', pt) })
      return
    }
    void saveGithub('label', { label: name })
  }, [labelDraft, pt, saveGithub])

  /** Parsed here so a non-number never reaches the wire — the server refuses it with the same
   *  `bad_keep_remote`, and the round trip would only make the answer slower. An EMPTY field is
   *  refused explicitly: `Number('')` is 0, and 0 means "keep every release", which is the one
   *  answer a blank box must not silently become. */
  const saveKeepRemote = useCallback(() => {
    const raw = keepDraft.trim()
    const value = Number(raw)
    if (!raw || !Number.isInteger(value) || value < 0) {
      setGithubResult({ field: 'keepRemote', ok: false, text: githubReasonText('bad_keep_remote', pt) })
      return
    }
    void saveGithub('keepRemote', { keepRemote: value })
  }, [keepDraft, pt, saveGithub])

  // -------------------------------------------------------------------------
  // Restore — the scenario this exists for is a machine that has just been reformatted, whose owner
  // has the repository URL and nothing else. So it asks for a URL and (only if this machine has no
  // `gh` login) a token, and every fact it shows comes from the repository.
  // -------------------------------------------------------------------------
  /**
   * Whether this machine can restore at all. `null` while the probe is in flight, `false` for a
   * central — `GET /api/backup/restore/status` answers 404 there (`index.ts`'s `TEAM_CENTRAL`
   * guard) and 404 renders NOTHING, exactly like the GitHub block above: a central aggregates other
   * machines and has no harness directories of its own to restore into, so an error box would
   * report a fault that isn't one.
   */
  const [restoreSupported, setRestoreSupported] = useState<boolean | null>(null)
  const [restoreUrl, setRestoreUrl] = useState('')
  const [restoreToken, setRestoreToken] = useState('')
  const [listing, setListing] = useState<RestoreMachine[] | null>(null)
  const [listingBusy, setListingBusy] = useState(false)
  const [listingError, setListingError] = useState<string | null>(null)
  const [restoreJob, setRestoreJob] = useState<RestoreJob | null>(null)
  /**
   * The release the RESTORE MODAL is asking about, together with the machine it belongs to (the
   * modal names both). `null` = the modal is closed.
   *
   * It replaced an inline two-step confirmation whose two buttons were named after their PAYLOAD
   * ("Metrics only" / "Everything, including cloning repositories") and so never read as restore
   * at all — reported verbatim: "eu cliquei em ver backup e nao tem a opcao de restaurar". Each
   * release now carries ONE button and one verb, `Restaurar`, and the choice plus the warnings
   * live in the modal it opens. Still not `window.confirm`: that blocks the whole tab, and this
   * page polls a running restore job.
   */
  const [restoreAsk, setRestoreAsk] = useState<{ release: RestoreCandidate; machine: string | null } | null>(null)
  const [startBusy, setStartBusy] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)

  /** The one read. It doubles as the availability probe (404 → this section does not exist here)
   *  and as the poll, so a restore started from the CLI or another tab is picked up on mount rather
   *  than running invisibly. */
  const loadRestoreJob = useCallback(async () => {
    try {
      const r = await fetch('/api/backup/restore/status')
      if (!r.ok) { setRestoreSupported(false); setRestoreJob(null); return }
      const data = (await r.json()) as { job: RestoreJob | null }
      setRestoreSupported(true)
      setRestoreJob(data.job)
    } catch {
      setRestoreSupported(false)
    }
  }, [])

  useEffect(() => { void loadRestoreJob() }, [loadRestoreJob])

  const restoreRunning = restoreJob !== null
    && (restoreJob.state === 'queued' || restoreJob.state === 'running')

  // Polling STOPS the moment the state is terminal: `restoreRunning` goes false, this effect tears
  // its own timer down, and nothing is left asking every two seconds forever.
  useEffect(() => {
    if (!restoreRunning) return
    const timer = setInterval(() => { void loadRestoreJob() }, 2000)
    return () => clearInterval(timer)
  }, [restoreRunning, loadRestoreJob])

  const listRestore = useCallback(async () => {
    setListingBusy(true)
    setListingError(null)
    setListing(null)
    setStartError(null)
    setRestoreAsk(null)
    try {
      const r = await fetch('/api/backup/restore/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: restoreUrl.trim(),
          token: restoreToken.trim() || undefined,
        }),
      })
      const data = (await r.json()) as
        { ok: true; machines: RestoreMachine[] } | { ok: false; reason: string }
      // The server's own sentence, passed through untouched — the credential rule and the URL rule
      // are enforced there, and composing a friendlier copy here would be a second explanation of
      // somebody else's check.
      if (data.ok) setListing(data.machines)
      else setListingError(data.reason || (pt ? 'não foi possível listar' : 'could not list'))
    } catch {
      setListingError(pt ? 'a requisição falhou' : 'the request failed')
    } finally {
      setListingBusy(false)
    }
  }, [restoreUrl, restoreToken, pt])

  /** Reached only from the modal's confirm button. The token is NOT cleared on success: `start` needs
   *  the same credential the listing used, and a second restore from the same list must not ask
   *  for it again. */
  const beginRestore = useCallback(async (tag: string, withRepos: boolean) => {
    setStartBusy(true)
    setStartError(null)
    try {
      const r = await fetch('/api/backup/restore/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: restoreUrl.trim(),
          tag,
          token: restoreToken.trim() || undefined,
          withRepos,
        }),
      })
      const data = (await r.json()) as
        { ok: true; job: RestoreJob } | { ok: false; reason: string }
      if (data.ok) {
        setRestoreJob(data.job)
        // The modal closes only on a STARTED job. A refusal keeps it open with the server's own
        // sentence inside it — closing on failure would drop the answer the click asked for.
        setRestoreAsk(null)
      } else {
        setStartError(data.reason || (pt ? 'não foi possível iniciar' : 'could not start'))
      }
    } catch {
      setStartError(pt ? 'a requisição falhou' : 'the request failed')
    } finally {
      setStartBusy(false)
    }
  }, [restoreUrl, restoreToken, pt])

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
      {/* The SCREEN's title, deliberately NOT a `SectionHeader`: every block below is one of those,
          and a page title drawn in the section style put two identical uppercase labels three lines
          apart with the intro between them — a screen that reads as having no levels at all, which
          is the complaint this pass answers. `h2` because `SettingsPage` already owns the `h1`. */}
      <h2 style={{
        fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', margin: '0 0 6px',
      }}>
        {pt ? 'Backup' : 'Backup'}
      </h2>
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
          {/* SECTION 1 — Backup now. The one thing this page DOES, at the top, under a heading of
              its own like every other block: the page was one long unlabelled column and read as
              such. */}
          <SectionHeader label={pt ? 'Backup agora' : 'Backup now'} />
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

          {/* SECTION 2 — Where the backups GO, before anything about what they contain. It is the
              decision a person makes first and revisits least — an unconnected machine is one whose
              whole history lives only on the disk being replaced, and burying that under four
              sections about format and recurrence answers questions nobody asked yet.

              Its `Divider` is INSIDE the conditional: a central answers 404 here and renders
              nothing, and a divider left standing outside would draw two rules with nothing
              between them. Same for the restore block below. */}
          {github && (
            <>
              <GithubVersioning
                section={github}
                labelDraft={labelDraft}
                keepDraft={keepDraft}
                saving={githubSaving}
                result={githubResult}
                pt={pt}
                connectUrl={connectUrl}
                connectToken={connectToken}
                connecting={connecting}
                connectError={connectError}
                onConnectUrl={setConnectUrl}
                onConnectToken={setConnectToken}
                onConnect={() => { void connectGithubRepo() }}
                useGh={useGh}
                onUseGh={setUseGh}
                onLabelDraft={setLabelDraft}
                onKeepDraft={setKeepDraft}
                onSaveLabel={saveLabelName}
                onSaveKeep={saveKeepRemote}
                onToggleDeleteLocal={checked => void saveGithub('deleteLocalAfterUpload', { deleteLocalAfterUpload: checked })}
                editing={editingRepo}
                onEdit={startEditRepo}
                onCancelEdit={cancelEditRepo}
                onAskDisconnect={() => { setDisconnectError(null); setDisconnectAsk(true) }}
                disconnecting={disconnecting}
              />
              {/* The trash's confirmation. Rendered from the page rather than from inside
                  `GithubVersioning` so it survives that section swapping into its connect form —
                  and so the one API call it can make has the page's own refetch behind it. */}
              {disconnectAsk && github.configured && (
                <GithubDisconnectModal
                  repo={github.repo}
                  url={github.url}
                  pt={pt}
                  busy={disconnecting}
                  error={disconnectError}
                  onCancel={() => { if (!disconnecting) { setDisconnectAsk(false); setDisconnectError(null) } }}
                  onConfirm={() => { void disconnectGithubRepo() }}
                />
              )}
              <Divider />
            </>
          )}

          {/* SECTION 3 — Restoring: the other half of versioning, and until now CLI-only. It sits
              right under the repository block because that is the same question read backwards:
              where the history goes, and where it comes back from. Absent entirely when the
              endpoint 404s (a central) — see `loadRestoreJob`. */}
          {restoreSupported === true && (
            <>
              <RestoreSection
                pt={pt}
                configuredUrl={github?.configured ? github.url : null}
                configuredRepo={github?.configured ? github.repo : null}
                // A configured machine on `auth: 'gh'` has a working gh by construction — it is
                // how the repository was verified. An unconfigured one is told by the probe.
                ghUsable={github === null ? false
                  : github.configured ? github.auth === 'gh' : github.gh?.usable === true}
                url={restoreUrl}
                token={restoreToken}
                onUrl={setRestoreUrl}
                onToken={setRestoreToken}
                onList={() => { void listRestore() }}
                listingBusy={listingBusy}
                listingError={listingError}
                machines={listing}
                job={restoreJob}
                running={restoreRunning}
                ask={restoreAsk}
                onAsk={ask => { setStartError(null); setRestoreAsk(ask) }}
                startBusy={startBusy}
                startError={startError}
                onStart={(tag, withRepos) => { void beginRestore(tag, withRepos) }}
              />
              <Divider />
            </>
          )}

          {/* SECTION 4 — Configuration: the facts this page does not let you change: destination,
              retention, excluded secrets, and the last run. Layers and the schedule are below,
              interactive. */}
          <SectionHeader label={pt ? 'Configuração' : 'Configuration'} />
          {/* Destination is TWO facts on a versioned machine, and showing only the first one was a
              half-truth: the local directory is where the archive is written, and the repository is
              where it then lives. Each is labelled for what it is; the repository row is absent —
              not empty — when nothing is connected, which is exactly what "only the local path" has
              always meant here. */}
          <ConfigRow
            label={github?.configured
              ? (pt ? 'Destino — pasta local' : 'Destination — local folder')
              : (pt ? 'Destino' : 'Destination')}
            value={status.config.destDir}
            mono
          />
          {github?.configured && (
            <ConfigRow
              label={pt ? 'Destino — repositório no GitHub' : 'Destination — GitHub repository'}
              value={
                <a
                  href={github.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    color: 'var(--anthropic-orange)', textDecoration: 'none', wordBreak: 'break-word',
                  }}
                >
                  <GithubMark size={13} />
                  {github.repo}
                </a>
              }
            />
          )}
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

          {/* SECTION 5 — Format: the four layers, under the names a person thinks in, each with its
              measured size on this machine. Metrics is always on and non-interactive. */}
          <SectionHeader label={pt ? 'Formato' : 'Format'} />
          <p style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: '-6px 0 12px' }}>
            {pt
              ? 'O que um backup MANUAL grava. Um sinalizador explícito da CLI (--with-archive/--with-raw) tem prioridade sobre esta escolha.'
              : 'What a MANUAL backup writes. An explicit CLI flag (--with-archive/--with-raw) overrides this choice.'}
          </p>
          {/* The named shapes, ABOVE the checkboxes. The checkboxes stay: a preset is a starting
              point, not a cage, and the row below reflects whatever is ticked. */}
          <PresetPicker
            layers={status.config.layers}
            pt={pt}
            disabled={savingConfig}
            onPick={layers => void patchConfig({ layers })}
          />
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

          {/* SECTION 6 — Recurrence: the schedule, and (deliberately separate) what a SCHEDULED run
              carries. */}
          <SectionHeader label={pt ? 'Recorrência' : 'Recurrence'} />
          <SchedulePicker
            value={SCHEDULE_IDS.includes(status.config.schedule as BackupScheduleId)
              ? status.config.schedule as BackupScheduleId : 'off'}
            active={status.config.scheduleActive}
            pt={pt}
            disabled={savingConfig}
            customHours={status.config.customHours ?? null}
            atHour={status.config.atHour ?? null}
            onChange={(schedule, customHours, atHour) => void patchConfig({ schedule, customHours, atHour })}
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

          {/* SECTION 7 — Per-harness coverage: last-backup is PER HARNESS, never one date at the
              top: an unticked harness must read as unprotected. */}
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

          {/* SECTION 8 — History: paginated, newest first. Unpaginated was an actual bug report: a
              machine with months of daily backups rendered as one endless, unreadable table. */}
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

function ConfigRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
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
const DEFAULT_BACKUP_HOUR = 10

function SchedulePicker({ value, active, pt, disabled, customHours, atHour, onChange }: {
  value: BackupScheduleId
  active: boolean
  pt: boolean
  disabled: boolean
  /** The hours last chosen, or null when never set. */
  customHours: number | null
  /** The local hour chosen, or null when never chosen — rendered as the default, not as blank. */
  atHour: number | null
  onChange: (schedule: BackupScheduleId, customHours?: number, atHour?: number) => void
}) {
  const isMobile = useIsMobile()
  // Local, so typing a two-digit number does not fire a save on the first digit — `6` would be a
  // legitimate schedule, and saving it on the way to `64` would run a backup six times a day.
  const [draft, setDraft] = useState(String(customHours ?? 24))
  const parsed = Number(draft)
  const canSave = Number.isFinite(parsed) && parsed >= MIN_CUSTOM_HOURS
    && parsed !== customHours && !disabled
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
      {/* A cadence with no time of day is anchored to whenever the machine last happened to run
          one, which drifts across the day. `custom` is deliberately excluded: "every 6 hours" has
          no single time of day, and forcing one on it would turn it into a different schedule. */}
      {(value === 'daily' || value === 'weekly') && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 2 }}>
            {pt ? 'A que horas' : 'At what time'}
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.45, margin: '0 0 6px' }}>
            {pt
              ? 'No relógio desta máquina. Se ela estiver desligada nesse horário, o backup roda assim que você ligar e o próximo volta a ser no horário marcado.'
              : 'On this machine’s clock. If it is off at that time the backup runs as soon as you turn it on, and the next one goes back to the chosen time.'}
          </p>
          <select
            value={String(atHour ?? DEFAULT_BACKUP_HOUR)}
            disabled={disabled}
            onChange={e => onChange(value, undefined, Number(e.target.value))}
            style={{
              padding: '7px 10px', minHeight: isMobile ? 44 : undefined,
              width: isMobile ? '100%' : 140, boxSizing: 'border-box',
              background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7,
              // 16px or iOS Safari zooms the viewport on focus and breaks the sticky header.
              fontFamily: 'inherit', fontSize: isMobile ? 16 : 13,
              color: 'var(--text-primary)', outline: 'none',
              ...(disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
            }}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={String(h)}>{`${String(h).padStart(2, '0')}:00`}</option>
            ))}
          </select>
        </div>
      )}
      {value === 'custom' && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 2 }}>
            {pt ? 'A cada quantas horas' : 'Every how many hours'}
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.45, margin: '0 0 6px' }}>
            {pt
              // Hours, because it is the one unit that covers both ends of what people ask for.
              ? `Em horas — 6 roda quatro vezes ao dia, 72 roda de três em três dias. Mínimo ${MIN_CUSTOM_HOURS}h: cada backup é grande e o envio confere o arquivo baixando ele de volta inteiro.`
              : `In hours — 6 runs four times a day, 72 runs every three days. Minimum ${MIN_CUSTOM_HOURS}h: each backup is large, and confirming its upload re-downloads the whole file.`}
          </p>
          <div style={{
            display: 'flex', flexDirection: isMobile ? 'column' : 'row',
            alignItems: isMobile ? 'stretch' : 'center', gap: 8,
          }}>
            <input
              type="number"
              min={MIN_CUSTOM_HOURS}
              step={1}
              inputMode="numeric"
              value={draft}
              disabled={disabled}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && canSave) { e.preventDefault(); onChange('custom', parsed) } }}
              style={{
                flex: isMobile ? undefined : 1, width: isMobile ? '100%' : undefined,
                minWidth: 0, boxSizing: 'border-box',
                padding: '7px 10px', minHeight: isMobile ? 44 : undefined,
                background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7,
                fontFamily: 'inherit', color: 'var(--text-primary)', outline: 'none',
                ...(disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
              }}
            />
            <button
              type="button"
              onClick={() => onChange('custom', parsed)}
              disabled={!canSave}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                padding: isMobile ? '0 16px' : '8px 16px', minHeight: isMobile ? 44 : undefined,
                width: isMobile ? '100%' : undefined, flexShrink: 0,
                borderRadius: 7, border: `1px solid ${canSave ? 'var(--anthropic-orange)' : 'var(--border)'}`,
                background: canSave ? 'var(--anthropic-orange-dim)' : 'transparent',
                color: canSave ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
                cursor: canSave ? 'pointer' : 'not-allowed', opacity: canSave ? 1 : 0.6,
              }}
            >
              {pt ? 'Salvar' : 'Save'}
            </button>
          </div>
        </div>
      )}
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

/**
 * GITHUB VERSIONING — each backup becomes a Release on a private GitHub repository the user owns.
 *
 * Two shapes. The unconfigured one is `GithubConnectForm`; the configured one is the repository
 * row plus the settings that can be changed WITHOUT a token — the machine name, how many of this
 * machine's releases to keep, and whether the local archive goes after a confirmed upload.
 *
 * The row carries the two verbs the repository itself has: a PENCIL, which puts the very same
 * connect form back on screen with the current URL prefilled (a second, smaller "edit the URL"
 * form would be a second set of checks and a second place for the two to disagree about what a
 * valid repository is), and a TRASH, which opens a modal and nothing else. Nothing on this page
 * is, or could be, a credential that is read back: a token is written and never returned.
 */
function GithubVersioning({
  section, labelDraft, keepDraft, saving, result, pt,
  onLabelDraft, onKeepDraft, onSaveLabel, onSaveKeep, onToggleDeleteLocal,
  connectUrl, connectToken, connecting, connectError, onConnectUrl, onConnectToken, onConnect,
  useGh, onUseGh, editing, onEdit, onCancelEdit, onAskDisconnect, disconnecting,
}: {
  section: GithubSectionJson
  /** The pencil is pressed: the connect form takes the row's place, prefilled. */
  editing: boolean
  onEdit: () => void
  onCancelEdit: () => void
  /** The trash. It only ever OPENS the modal — the page owns the call. */
  onAskDisconnect: () => void
  /** A disconnect is in flight: both icon buttons stand down rather than queueing a second one. */
  disconnecting: boolean
  labelDraft: string
  keepDraft: string
  /** The connect form's two fields, held by the page so a failed attempt keeps what was typed. */
  connectUrl: string
  connectToken: string
  connecting: boolean
  /** The SERVER's own refusal, passed through untouched — see `GithubConnectForm`. */
  connectError: string | null
  onConnectUrl: (v: string) => void
  onConnectToken: (v: string) => void
  onConnect: () => void
  /** Authenticate through the GitHub CLI instead of storing a token. */
  useGh: boolean
  onUseGh: (v: boolean) => void
  /** Which control is writing right now, if any — every control is disabled while one is. */
  saving: GithubField | null
  result: { field: GithubField; ok: boolean; text: string } | null
  pt: boolean
  onLabelDraft: (v: string) => void
  onKeepDraft: (v: string) => void
  onSaveLabel: () => void
  onSaveKeep: () => void
  onToggleDeleteLocal: (checked: boolean) => void
}) {
  const busy = saving !== null

  return (
    <div>
      <SectionHeaderWithIcon
        icon={<GithubMark size={13} />}
        label={pt ? 'Versionamento no GitHub' : 'GitHub versioning'}
      />

      {!section.configured || editing ? (
        <GithubConnectForm
          pt={pt}
          urlDraft={connectUrl}
          tokenDraft={connectToken}
          busy={connecting}
          error={connectError}
          // The `gh` probe only exists on the UNCONFIGURED read (`readGithubSection` does not spawn
          // it for a machine that is already set up), so a re-point is told which credential is
          // STORED instead — a fact, where an invented account name would not be.
          gh={section.configured ? undefined : section.gh}
          reconnect={section.configured ? { repo: section.repo, auth: section.auth } : undefined}
          onCancel={section.configured ? onCancelEdit : undefined}
          useGh={useGh}
          onUrl={onConnectUrl}
          onToken={onConnectToken}
          onUseGh={onUseGh}
          onSubmit={onConnect}
        />
      ) : (
        <>
          {/* The repository, and its two verbs. It used to be the link alone, with nothing on the
              page that could change or remove it — reported verbatim: "eu n consigo editar o repo
              pra onde eu estou mandando". The pencil re-opens the connect form; the trash opens a
              modal, and only the modal's confirm calls the API. */}
          <ConfigRow
            label={pt ? 'Repositório' : 'Repository'}
            value={
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end',
                gap: 8, flexWrap: 'wrap',
              }}>
                <a
                  href={section.url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    minWidth: 0, maxWidth: '100%',
                    color: 'var(--anthropic-orange)', textDecoration: 'none', wordBreak: 'break-word',
                  }}
                >
                  <GithubMark size={13} />
                  {section.repo}
                </a>
                <IconButton
                  icon={<Pencil size={14} />}
                  label={pt ? 'Trocar o repositório' : 'Change the repository'}
                  disabled={busy || disconnecting}
                  onClick={onEdit}
                />
                <IconButton
                  icon={<Trash2 size={14} />}
                  label={pt ? 'Desconectar o repositório' : 'Disconnect the repository'}
                  danger
                  disabled={busy || disconnecting}
                  onClick={onAskDisconnect}
                />
              </span>
            }
          />

          <div style={{ marginTop: 16 }}>
            <GithubTextField
              label={pt ? 'Nome da máquina' : 'Machine name'}
              hint={pt
                ? `Várias máquinas podem versionar no MESMO repositório, e este nome é o que separa os backups delas: ele entra na tag do release, e a retenção só apaga releases desta máquina — nunca os de outra. \`agentop restore <url> --from ${section.label}\` restaura especificamente esta máquina.`
                : `Several machines can version to the SAME repository, and this name is what tells their backups apart: it rides in the release tag, and retention only ever deletes this machine’s own releases — never another machine’s. \`agentop restore <url> --from ${section.label}\` restores this machine specifically.`}
              value={labelDraft}
              suggestion={section.suggestedLabel}
              suggestionText={pt
                ? 'A central chama esta máquina de'
                : 'The central calls this machine'}
              onSuggestion={onLabelDraft}
              onChange={onLabelDraft}
              onSave={onSaveLabel}
              saveLabel={pt ? 'Salvar' : 'Save'}
              savingLabel={pt ? 'Salvando…' : 'Saving…'}
              saving={saving === 'label'}
              busy={busy}
              dirty={labelDraft.trim() !== section.label}
              feedback={result?.field === 'label' ? result : null}
            />
          </div>

          <GithubTextField
            label={pt ? 'Quantos backups guardar no GitHub' : 'How many backups to keep on GitHub'}
            // The old copy said "how many releases to keep", which assumed the reader knew that
            // one backup is one GitHub release. Reported as not understood, and fairly: the number
            // decides when your OLDEST backup is deleted, and nothing on screen said so.
            hint={pt
              ? 'Quantos backups DESTA máquina ficam guardados. Com 2: você tem o mais recente e o anterior; ao fazer um novo, ele vira o mais recente, o que era mais recente vira o anterior, e o que era anterior é APAGADO do GitHub. 0 nunca apaga nada. Backups de outras máquinas no mesmo repositório nunca são tocados.'
              : 'How many of THIS machine’s backups are kept. With 2: you have the newest and the one before it; when a new one is made it becomes the newest, the old newest becomes the one before, and the third is DELETED from GitHub. 0 never deletes anything. Other machines’ backups in the same repository are never touched.'}
            value={keepDraft}
            onChange={onKeepDraft}
            onSave={onSaveKeep}
            saveLabel={pt ? 'Salvar' : 'Save'}
            savingLabel={pt ? 'Salvando…' : 'Saving…'}
            saving={saving === 'keepRemote'}
            busy={busy}
            dirty={keepDraft.trim() !== String(section.keepRemote)}
            numeric
            feedback={result?.field === 'keepRemote' ? result : null}
          />

          {/* The same `Checkbox` the layer rows use — whole row is the control, ≥44px on mobile.
              It writes immediately, so its own outcome is stated right under it. */}
          <Checkbox
            checked={section.deleteLocalAfterUpload}
            onChange={onToggleDeleteLocal}
            label={pt
              ? 'Apagar o arquivo local depois de um upload confirmado'
              : 'Delete the local archive after a confirmed upload'}
            disabled={busy}
          />
          <p style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.45, margin: '2px 0 0 24px' }}>
            {pt
              ? 'O arquivo local só é apagado depois que o upload é conferido byte a byte contra o release.'
              : 'The local archive is only deleted after the upload has been checked byte for byte against the release.'}
          </p>
          <div style={{ marginLeft: 24 }}>
            <GithubFeedback feedback={result?.field === 'deleteLocalAfterUpload' ? result : null} />
          </div>
        </>
      )}
    </div>
  )
}

/**
 * A square icon button — the repository row's pencil and trash.
 *
 * An icon carries no name, so BOTH `aria-label` and `title` are required rather than optional: the
 * first is what a screen reader reads, the second is what a pointer user gets on hover, and a glyph
 * with neither is a control nobody can identify. It is a REAL touch target on mobile (≥44px) — a
 * 20px tall button beside a wrapping link is one that gets missed and then mis-hit, and the one
 * next to it here removes a configuration.
 */
function IconButton({ icon, label, danger, disabled, onClick }: {
  icon: React.ReactNode
  /** The accessible name, in the reader's own language. Used for `aria-label` AND `title`. */
  label: string
  /** The destructive one, in the same red every warning on this page uses. */
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  const isMobile = useIsMobile()
  const side = isMobile ? 44 : 30
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: side, height: side, minHeight: isMobile ? 44 : undefined,
        flexShrink: 0, boxSizing: 'border-box', padding: 0,
        borderRadius: 7, border: '1px solid var(--border)', background: 'transparent',
        color: danger ? '#ef4444' : 'var(--text-secondary)',
        fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
      }}
    >
      {icon}
    </button>
  )
}

/**
 * The TRASH's confirmation.
 *
 * Built to the same shape as `RestoreConfirmModal` below — Escape and a backdrop click cancel,
 * full-screen on mobile through `OVERLAY_TOP` (a bare `0` puts the dialog's header under the iOS
 * clock, and `mobileOverlay.test.ts` fails the build on one), no hand-rolled focus trap. Not
 * `window.confirm`: it blocks the whole tab, and this page polls a restore job.
 *
 * What it must say is the half people get wrong about a "remove": disconnecting forgets the LOCAL
 * configuration, and the backups already on GitHub are NOT touched. `disconnectGithub` (server)
 * removes one 0600 file and makes no API call at all — so "your backups are gone" would be a false
 * sentence in the frightening direction, and "we cleaned up for you" a false one in the reassuring
 * direction. Both are stated, and the repository is NAMED: a machine can be pointed at any
 * repository, and the last screen before it is forgotten is the one that can still say which.
 */
function GithubDisconnectModal({ repo, url, pt, busy, error, onCancel, onConfirm }: {
  repo: string
  url: string
  pt: boolean
  busy: boolean
  /** The server's own reason, untouched. The modal stays open on failure — closing it would drop
   *  the answer the click asked for. */
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const isMobile = useIsMobile()
  const cancelRef = React.useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onCancel])

  // CANCEL takes the focus, not the confirm — this dialog's confirm is the destructive one, and a
  // stray Enter on open must not be the thing that fires it. (`RestoreConfirmModal` focuses its
  // confirm because that one still has a choice to make first.)
  useEffect(() => { cancelRef.current?.focus() }, [])

  return (
    <div
      onClick={onCancel}
      role="presentation"
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        display: 'flex', alignItems: isMobile ? 'stretch' : 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)',
        padding: isMobile ? OVERLAY_TOP : 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={pt ? 'Desconectar o repositório' : 'Disconnect the repository'}
        style={{
          width: '100%', maxWidth: isMobile ? '100%' : 520,
          height: isMobile ? '100%' : undefined,
          maxHeight: isMobile ? '100%' : '90vh',
          overflowY: 'auto', boxSizing: 'border-box',
          background: 'var(--bg-card)', border: isMobile ? 'none' : '1px solid var(--border)',
          borderRadius: isMobile ? 0 : 12, padding: isMobile ? 16 : 22,
          boxShadow: isMobile ? 'none' : '0 12px 48px rgba(0,0,0,0.5)',
          display: 'flex', flexDirection: 'column', gap: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            display: 'inline-flex', padding: 8, borderRadius: 9,
            background: 'color-mix(in srgb, #ef4444 12%, transparent)', color: '#ef4444',
          }}>
            <Trash2 size={17} />
          </span>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
            {pt ? 'Desconectar este repositório?' : 'Disconnect this repository?'}
          </span>
        </div>

        {/* WHICH repository. Named, and linked, before anything is forgotten. */}
        <div style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12,
          padding: '5px 0', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)', flexShrink: 0 }}>
            {pt ? 'Repositório' : 'Repository'}
          </span>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '100%',
              fontSize: 12, color: 'var(--anthropic-orange)', textDecoration: 'none',
              wordBreak: 'break-word', textAlign: 'right',
            }}
          >
            <GithubMark size={12} />
            {repo}
          </a>
        </div>

        <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.55, margin: 0 }}>
          {pt
            ? 'Esta máquina para de enviar backups para esse repositório e esquece a configuração guardada aqui — a URL, o nome da máquina e a credencial. Os backups locais em disco continuam onde estão.'
            : 'This machine stops sending backups to that repository and forgets the configuration stored here — the URL, the machine name and the credential. The local backups on disk stay where they are.'}
        </p>

        {/* What it does NOT do. Stated as loudly as what it does: a "remove" that reads as
            "delete my backups" is one nobody presses, and one that quietly did would be worse. */}
        <div style={{
          padding: '10px 12px', borderRadius: 8,
          background: 'color-mix(in srgb, var(--accent-green) 10%, transparent)',
          border: '1px solid color-mix(in srgb, var(--accent-green) 30%, transparent)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6,
            fontSize: 12, fontWeight: 700, color: 'var(--text-primary)',
          }}>
            <CheckCircle2 size={14} style={{ color: 'var(--accent-green)', flexShrink: 0 }} />
            {pt ? 'O que NÃO acontece' : 'What does NOT happen'}
          </div>
          <p style={{
            margin: 0, fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-secondary)',
          }}>
            {pt
              ? 'Os backups que já estão no GitHub NÃO são apagados. Eles continuam no repositório, e conectá-lo de novo mais tarde encontra todos eles — inclusive pela seção “Restaurar” abaixo.'
              : 'The backups already on GitHub are NOT deleted. They stay in the repository, and connecting it again later finds every one of them — including from the “Restore” section below.'}
          </p>
        </div>

        <GithubFeedback feedback={error === null ? null : { ok: false, text: error }} />

        <div style={{
          display: 'flex', gap: 8, marginTop: 2, justifyContent: 'flex-end',
          flexDirection: isMobile ? 'column-reverse' : 'row',
        }}>
          <RestoreButton
            buttonRef={cancelRef}
            text={pt ? 'Cancelar' : 'Cancel'}
            primary={false}
            disabled={busy}
            onClick={onCancel}
          />
          <RestoreButton
            text={busy
              ? (pt ? 'Desconectando…' : 'Disconnecting…')
              : (pt ? 'Desconectar' : 'Disconnect')}
            busy={busy}
            primary
            danger
            disabled={busy}
            onClick={onConfirm}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * One editable value with its own explicit Save and its own resolution.
 *
 * Styled like `primitives.tsx`'s `FieldInput` (same box, same focus accent) but carrying a Save
 * button and a pending state, which that one has no notion of. The input deliberately sets NO
 * inline `font-size`: `index.css` forces 16px on every mobile input to stop iOS Safari zooming
 * the viewport, and a value here would only be a live-looking line that rule already overrides.
 */
function GithubTextField({
  label, hint, value, onChange, onSave, saveLabel, savingLabel, saving, busy, dirty, numeric, feedback,
  suggestion, suggestionText, onSuggestion,
}: {
  /** A better value this machine could use, offered as one click. See `suggestedLabel`. */
  suggestion?: string | null
  suggestionText?: string
  onSuggestion?: (v: string) => void
  label: string
  hint: string
  value: string
  onChange: (v: string) => void
  onSave: () => void
  saveLabel: string
  savingLabel: string
  /** THIS field is the one writing. */
  saving: boolean
  /** ANY field is writing — two overlapping read-modify-writes of the same config file would let
   *  the earlier one win after the later one already returned. */
  busy: boolean
  /** Nothing to save is a disabled Save, never a request that reports "Saved." having changed
   *  nothing. */
  dirty: boolean
  numeric?: boolean
  feedback: { ok: boolean; text: string } | null
}) {
  const isMobile = useIsMobile()
  const canSave = dirty && !busy
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 2 }}>{label}</div>
      <p style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.45, margin: '0 0 6px' }}>{hint}</p>
      <div style={{
        display: 'flex', flexDirection: isMobile ? 'column' : 'row',
        alignItems: isMobile ? 'stretch' : 'center', gap: 8,
      }}>
        <input
          type={numeric ? 'number' : 'text'}
          {...(numeric ? { min: 0, step: 1, inputMode: 'numeric' as const } : null)}
          value={value}
          disabled={busy}
          readOnly={busy}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && canSave) { e.preventDefault(); onSave() } }}
          style={{
            flex: isMobile ? undefined : 1, width: isMobile ? '100%' : undefined,
            minWidth: 0, boxSizing: 'border-box',
            padding: '7px 10px', minHeight: isMobile ? 44 : undefined,
            background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7,
            fontFamily: 'inherit', color: 'var(--text-primary)', outline: 'none',
            transition: 'border-color 0.15s',
            ...(busy ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
          }}
          onFocus={e => { if (!busy) e.currentTarget.style.borderColor = 'var(--anthropic-orange)' }}
          onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
        />
        <button
          type="button"
          onClick={onSave}
          disabled={!canSave}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            padding: isMobile ? '0 16px' : '8px 16px', minHeight: isMobile ? 44 : undefined,
            width: isMobile ? '100%' : undefined, flexShrink: 0,
            borderRadius: 7, border: `1px solid ${canSave ? 'var(--anthropic-orange)' : 'var(--border)'}`,
            background: canSave ? 'var(--anthropic-orange-dim)' : 'transparent',
            color: canSave ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
            fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
            cursor: canSave ? 'pointer' : 'not-allowed', opacity: canSave ? 1 : 0.6,
          }}
        >
          {saving
            ? <><Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> {savingLabel}</>
            : saveLabel}
        </button>
      </div>
      {/* The offer. It fills the FIELD rather than saving: the label rides in the release tag, so
          the person should see the value land and press Save themselves — a one-click rename that
          also splits a machine's history is a click nobody agreed to. */}
      {suggestion && suggestion !== value && onSuggestion && (
        <p style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: '6px 0 0' }}>
          {suggestionText}{' '}
          <button
            type="button"
            onClick={() => onSuggestion(suggestion)}
            disabled={busy}
            style={{
              padding: 0, border: 'none', background: 'none', font: 'inherit',
              color: 'var(--anthropic-orange)', fontWeight: 700,
              cursor: busy ? 'not-allowed' : 'pointer', textDecoration: 'underline',
            }}
          >
            {suggestion}
          </button>
        </p>
      )}
      <GithubFeedback feedback={feedback} />
    </div>
  )
}

/** A save's outcome, in the two shapes the rest of this page already uses for one — never a click
 *  that resolves into silence. */
function GithubFeedback({ feedback }: { feedback: { ok: boolean; text: string } | null }) {
  if (!feedback) return null
  return (
    <p style={{
      display: 'flex', alignItems: 'center', gap: 6,
      fontSize: 11.5, lineHeight: 1.45, margin: '6px 0 0',
      color: feedback.ok ? 'var(--accent-green)' : '#ef4444',
    }}>
      {feedback.ok
        ? <CheckCircle2 size={12} style={{ flexShrink: 0 }} />
        : <AlertTriangle size={12} style={{ flexShrink: 0 }} />}
      <span>{feedback.text}</span>
    </p>
  )
}

/**
 * The form that connects a private GitHub repository — the instructions and the two fields, in the
 * place the person is already looking.
 *
 * It takes a TOKEN, which is why it is worth saying what protects it: `/api/backup` requires the
 * `localShell` capability, which is false on the `public` exposure profile and opt-in on `lan`, so
 * on a dashboard anyone else can open this whole section does not exist. The field is
 * `type="password"` and its value is never put back by the server — the reply is the ordinary
 * `GithubSection`, which has no token in it — so a reload shows an empty box, not a recovered
 * secret.
 *
 * Every refusal shown here is the SERVER's own sentence, passed through untouched: the five checks
 * (github.com, the repository exists, it is PRIVATE, the token can push) are the ones
 * `agentop backup github setup` performs, because it is the same function. Composing a friendlier
 * message here would be a second explanation of a rule enforced somewhere else.
 */
function GithubConnectForm({
  pt, urlDraft, tokenDraft, busy, error, gh, useGh, onUrl, onToken, onUseGh, onSubmit,
  reconnect, onCancel,
}: {
  pt: boolean
  urlDraft: string
  tokenDraft: string
  busy: boolean
  error: string | null
  /** Whether the GitHub CLI on this machine can be used instead of a token. */
  gh?: { usable: true; account: string } | { usable: false; reason: 'not-installed' | 'logged-out' }
  /**
   * Present when the pencil opened this form on an ALREADY CONNECTED machine: the repository it is
   * connected to now, and which credential it uses. `readGithubSection` does not run the `gh` probe
   * for a configured machine (it spawns a process and makes a network call to answer a question
   * that machine no longer has), so `gh` is absent here and this stored fact takes its place. It is
   * a fact, not a probe — the credential block below says so rather than promising `gh` will work.
   */
  reconnect?: { repo: string; auth: 'token' | 'gh' }
  /** Back out with nothing changed. Only ever passed on the reconnect path — an unconfigured
   *  machine has nothing to go back TO. */
  onCancel?: () => void
  useGh: boolean
  onUrl: (v: string) => void
  onToken: (v: string) => void
  onUseGh: (v: boolean) => void
  onSubmit: () => void
}) {
  const isMobile = useIsMobile()
  const ghUsable = gh?.usable === true
  // With `gh` the token field is not shown at all, so it cannot be part of what makes the button
  // pressable — requiring a value the form never asks for is a button that is disabled forever.
  const canSubmit = urlDraft.trim().length > 0
    && (useGh || tokenDraft.trim().length > 0)
    && !busy
  // Whether the "generate a token" step still applies. On a fresh machine that is decided by the
  // probe; on a re-point it is decided by the switch, since nothing probed anything.
  const tokenNeeded = reconnect ? !useGh : !ghUsable

  const field = (
    label: string, hint: string, value: string, set: (v: string) => void, password: boolean,
    placeholder: string,
  ): React.ReactNode => (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 2 }}>{label}</div>
      <p style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.45, margin: '0 0 6px' }}>{hint}</p>
      <input
        // No inline fontSize: iOS Safari zooms the viewport on any field under 16px and that breaks
        // the sticky header. `index.css` carries the global guard.
        type={password ? 'password' : 'text'}
        value={value}
        placeholder={placeholder}
        disabled={busy}
        autoComplete={password ? 'off' : 'off'}
        spellCheck={false}
        onChange={e => set(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && canSubmit) { e.preventDefault(); onSubmit() } }}
        style={{
          width: '100%', minWidth: 0, boxSizing: 'border-box',
          padding: '7px 10px', minHeight: isMobile ? 44 : undefined,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7,
          fontFamily: password ? 'monospace' : 'inherit', color: 'var(--text-primary)', outline: 'none',
          transition: 'border-color 0.15s',
          ...(busy ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
        }}
        onFocus={e => { if (!busy) e.currentTarget.style.borderColor = 'var(--anthropic-orange)' }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
      />
    </div>
  )

  return (
    <div>
      <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.55, margin: '-6px 0 12px' }}>
        {reconnect
          ? (pt
            // The re-point. It names the repository being left, because that is the fact the user
            // is about to replace and the only screen that can still state it.
            ? `Aponte esta máquina para outro repositório. Hoje ela usa ${reconnect.repo}. É UM repositório só: para onde os backups vão e de onde eles voltam — trocar aqui troca os dois. Os backups que já estão no repositório atual não são apagados.`
            : `Point this machine at a different repository. Today it uses ${reconnect.repo}. There is only ONE repository: where the backups go and where they come back from — changing it here changes both. The backups already in the current repository are not deleted.`)
          : (pt
            ? 'Cada backup vira um Release num repositório privado do GitHub que é seu — o histórico desta máquina passa a viver fora dela, e o arquivo local pode ser apagado assim que o envio é conferido byte a byte.'
            : 'Each backup becomes a Release on a private GitHub repository you own — this machine’s history then lives off the machine, and the local archive can be deleted once the upload is confirmed byte for byte.')}
      </p>
      <ol style={{
        fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6, margin: '0 0 14px',
        paddingLeft: 18,
      }}>
        <li>{pt
          ? 'Crie um repositório no GitHub e marque PRIVADO. Um público é recusado aqui — o backup carrega suas métricas, os primeiros prompts e um mapa dos seus diretórios.'
          : 'Create a repository on GitHub and mark it PRIVATE. A public one is refused here — a backup carries your metrics, your first prompts and a map of your directories.'}</li>
        <li>{pt ? 'Cole a URL abaixo.' : 'Paste the URL below.'}</li>
        {tokenNeeded && (
          <li>{pt
            ? 'Gere um token: fine-grained com acesso só a esse repositório e "Contents: Read and write", ou um clássico com o escopo repo.'
            : 'Generate a token: fine-grained with access to that repository only and "Contents: Read and write", or a classic one with the repo scope.'}</li>
        )}
      </ol>

      {/* The RE-POINT's credential block. It states what is STORED — the one thing that is known
          here without a probe — and offers the other option with its caveat said out loud: nothing
          on this path has checked whether `gh` works, so the sentence promises a refusal in words
          rather than a success. The server performs the same five checks either way. */}
      {reconnect && (
        <div style={{
          padding: '10px 12px', borderRadius: 8, marginBottom: 14,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        }}>
          <p style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: '0 0 8px' }}>
            {reconnect.auth === 'gh'
              ? (pt
                ? 'Hoje esta máquina autentica pelo GitHub CLI (gh) — nenhum token fica guardado aqui.'
                : 'Today this machine authenticates through the GitHub CLI (gh) — no token is stored here.')
              : (pt
                ? 'Hoje esta máquina autentica por um token guardado nela.'
                : 'Today this machine authenticates with a token stored on it.')}
          </p>
          <Checkbox
            checked={useGh}
            onChange={onUseGh}
            disabled={busy}
            label={pt
              ? 'Usar o GitHub CLI desta máquina (gh)'
              : 'Use this machine’s GitHub CLI (gh)'}
          />
          <p style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: '6px 0 0 24px' }}>
            {useGh
              ? (pt
                ? 'Nenhum token é guardado aqui: o agentop pede um ao gh no momento de cada envio. Se o gh não estiver logado nesta máquina, a conexão é recusada e diz o motivo.'
                : 'No token is stored here: agentop asks gh for one at the moment of each upload. If gh is not logged in on this machine, the connection is refused and says why.')
              : (pt
                ? 'Desmarcado, você cola um token — ele substitui a credencial guardada hoje. Fica em ~/.agentistics/github-backup.json com permissão 0600, nunca é devolvido por uma rota e está na lista de exclusão do próprio backup.'
                : 'Unchecked, you paste a token — it replaces the credential stored today. It lives in ~/.agentistics/github-backup.json at mode 0600, is never returned by a route, and is on the backup’s own exclusion list.')}
          </p>
        </div>
      )}

      {/* Which credential. The gh option is offered FIRST and pre-selected when it works, because
          it is the better answer: nothing is stored on this machine at all. The trade is stated
          rather than hidden — gh's token carries every scope the user's login has, while a
          fine-grained PAT can be scoped to this one repository. */}
      {gh && (
        <div style={{
          padding: '10px 12px', borderRadius: 8, marginBottom: 14,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        }}>
          {ghUsable ? (
            <>
              <Checkbox
                checked={useGh}
                onChange={onUseGh}
                disabled={busy}
                label={pt
                  ? `Usar o GitHub CLI desta máquina (${gh.usable ? gh.account : ''})`
                  : `Use this machine’s GitHub CLI (${gh.usable ? gh.account : ''})`}
              />
              <p style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: '6px 0 0 24px' }}>
                {useGh
                  ? (pt
                    ? 'Nenhum token é guardado aqui. O agentop pede um ao gh no momento de cada envio — então se você rodar `gh auth logout`, o versionamento para, em vez de continuar com uma credencial antiga.'
                    : 'No token is stored here. agentop asks gh for one at the moment of each upload — so if you run `gh auth logout`, versioning stops instead of carrying on with a stale credential.')
                  : (pt
                    ? 'Desmarcado, você cola um token. Ele fica em ~/.agentistics/github-backup.json com permissão 0600, nunca é devolvido por uma rota e está na lista de exclusão do próprio backup. Um token fine-grained alcança só este repositório — mais estreito que o do gh, que carrega todos os escopos do seu login.'
                    : 'Unchecked, you paste a token. It lives in ~/.agentistics/github-backup.json at mode 0600, is never returned by a route, and is on the backup’s own exclusion list. A fine-grained token reaches only this repository — narrower than gh’s, which carries every scope your login has.')}
              </p>
            </>
          ) : (
            // Two reasons, two instructions. One sentence covering both would be right for neither.
            <p style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: 0 }}>
              {gh.usable ? '' : gh.reason === 'not-installed'
                ? (pt
                  ? 'O GitHub CLI (gh) não está instalado aqui. Com ele, o agentop não precisaria guardar token nenhum — instale e recarregue esta tela para usar essa opção.'
                  : 'The GitHub CLI (gh) is not installed here. With it, agentop would store no token at all — install it and reload this screen to use that option.')
                : (pt
                  ? 'O GitHub CLI (gh) está instalado mas não autenticado. Rode `gh auth login` e recarregue esta tela para conectar sem guardar token nenhum.'
                  : 'The GitHub CLI (gh) is installed but not logged in. Run `gh auth login` and reload this screen to connect without storing any token.')}
            </p>
          )}
        </div>
      )}

      {field(
        pt ? 'URL do repositório' : 'Repository URL',
        pt ? 'Precisa ser github.com — a checagem acontece antes de qualquer requisição, para o token nunca sair para um host digitado errado.'
          : 'Must be github.com — checked before any request is made, so the token never leaves for a host you mistyped.',
        urlDraft, onUrl, false, 'https://github.com/owner/repo',
      )}
      {!useGh && field(
        pt ? 'Token do GitHub' : 'GitHub token',
        pt ? 'Guardado só nesta máquina, com permissão 0600. Nunca é devolvido por uma rota e está na lista de exclusão do próprio backup.'
          : 'Stored only on this machine, mode 0600. Never returned by a route, and on the backup’s own exclusion list.',
        tokenDraft, onToken, true, pt ? 'ghp_… (não é exibido)' : 'ghp_… (never shown back)',
      )}

      {/* The pair. Cancel exists only on the re-point path and is FIRST in the DOM on mobile's
          reversed column, so the destructive-adjacent one is not the thumb's default. */}
      <div style={{
        display: 'flex', gap: 8, flexWrap: 'wrap',
        flexDirection: isMobile ? 'column-reverse' : 'row',
      }}>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
            padding: isMobile ? '0 16px' : '8px 16px', minHeight: isMobile ? 44 : undefined,
            width: isMobile ? '100%' : undefined, boxSizing: 'border-box',
            borderRadius: 7, border: `1px solid ${canSubmit ? 'var(--anthropic-orange)' : 'var(--border)'}`,
            background: canSubmit ? 'var(--anthropic-orange-dim)' : 'transparent',
            color: canSubmit ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
            fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
            cursor: canSubmit ? 'pointer' : 'not-allowed', opacity: canSubmit ? 1 : 0.6,
          }}
        >
          {busy
            ? <><Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> {pt ? 'Conectando…' : 'Connecting…'}</>
            : reconnect
              ? (pt ? 'Salvar repositório' : 'Save repository')
              : (pt ? 'Conectar repositório' : 'Connect repository')}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              padding: isMobile ? '0 16px' : '8px 16px', minHeight: isMobile ? 44 : undefined,
              width: isMobile ? '100%' : undefined, boxSizing: 'border-box',
              borderRadius: 7, border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--text-secondary)',
              fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
              cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1,
            }}
          >
            {pt ? 'Cancelar' : 'Cancel'}
          </button>
        )}
      </div>

      <GithubFeedback feedback={error === null ? null : { ok: false, text: error }} />

      <p style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: '10px 0 0' }}>
        {pt
          ? `Pela linha de comando o mesmo passo é: ${GITHUB_SETUP_COMMAND}`
          : `From the command line the same step is: ${GITHUB_SETUP_COMMAND}`}
      </p>
    </div>
  )
}

/**
 * RESTORE — bringing a machine's whole history back from the repository its backups were versioned
 * to.
 *
 * The scenario every decision here is written against is the one `restore-routes.ts` states: a
 * machine that has just been REFORMATTED. It has the repository URL and nothing else — no stored
 * config, no token, no local history, no expected hash. So an UNCONFIGURED machine gets an editable
 * URL field, which is the only way it can name a repository; a CONFIGURED one is shown the
 * repository it already has, read-only, because there is exactly one and the pencil above is where
 * it changes. The token field appears only for the machine with no `gh` login (the server tries
 * `gh` first), and every fact shown about a release comes from the repository, never from anything
 * local.
 *
 * Three rules it must not break:
 *
 * - **Nothing is invented.** Every derived field on a `RestoreCandidate` is nullable, because a
 *   release whose body could not be decoded is still listed rather than hidden. A null is rendered
 *   as the word "unknown" — never `0`, never a blank cell that reads as zero.
 * - **A restore writes into `$HOME`, so it is confirmed first** — in a MODAL this file builds, not
 *   `window.confirm` (which blocks the whole tab and would freeze a page that is polling a job).
 *   Each release carries ONE button, `Restaurar`, and the modal holds the choice and the warnings:
 *   the two buttons that used to sit here were named after their payload and never read as the
 *   verb, which is exactly what was reported.
 * - **Every refusal is the SERVER's own sentence, passed through untouched.** The credential rule
 *   ("log in with gh, or paste a token"), the URL rule, and "a restore is already running" are all
 *   enforced there and already written in words.
 */
function RestoreSection({
  pt, configuredUrl, configuredRepo, ghUsable, url, token, onUrl, onToken, onList, listingBusy,
  listingError, machines, job, running, ask, onAsk, startBusy, startError, onStart,
}: {
  pt: boolean
  /**
   * Whether the GitHub CLI on this machine can authenticate.
   *
   * When it can, the token field is NOT SHOWN AT ALL. It existed as a fallback for a machine with
   * no `gh`, and offering a credential box to somebody who needs no credential is the habit this
   * whole feature avoids teaching — it reads as "you must paste a token", which is exactly the
   * question the gh path answers.
   */
  ghUsable: boolean
  /**
   * The repository this machine already versions to, when there is one — and `owner/repo` for
   * display beside it.
   *
   * When it is there, this section shows it READ-ONLY and asks for no URL at all: it is the same
   * repository the versioning block above names, and the machine has exactly one. An editable box
   * here was a second question for one fact, and the two could disagree — reported verbatim: "no
   * repository url nao deveria permitir a edicao dessa forma … eh 1 pra destino e recuperação.
   * apenas". Changing it is the PENCIL above, which is also the only place that re-verifies a
   * repository. The editable field survives for `null` — a freshly reformatted machine has nothing
   * configured and no other way to name a repository, which is the whole reason it exists.
   */
  configuredUrl: string | null
  configuredRepo: string | null
  url: string
  token: string
  onUrl: (v: string) => void
  onToken: (v: string) => void
  onList: () => void
  listingBusy: boolean
  /** The server's own refusal for the LISTING, untouched. */
  listingError: string | null
  /** `null` = nothing asked for yet. An empty array is a real answer: the repository holds no
   *  backup releases, which is a different fact from "not asked". */
  machines: RestoreMachine[] | null
  job: RestoreJob | null
  running: boolean
  /** The release the modal is asking about, with the machine it belongs to. `null` = closed. */
  ask: { release: RestoreCandidate; machine: string | null } | null
  onAsk: (ask: { release: RestoreCandidate; machine: string | null } | null) => void
  startBusy: boolean
  startError: string | null
  onStart: (tag: string, withRepos: boolean) => void
}) {
  const isMobile = useIsMobile()
  const canList = url.trim().length > 0 && !listingBusy

  return (
    <div>
      {/* The GitHub mark belongs on this heading too: a restore READS from a GitHub repository —
          it is the versioning question asked backwards. */}
      <SectionHeaderWithIcon
        icon={<GithubMark size={13} />}
        label={pt ? 'Restaurar' : 'Restore'}
      />
      <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.55, margin: '-6px 0 12px' }}>
        {pt
          ? 'Traz de volta o histórico de uma máquina a partir do repositório em que os backups dela foram versionados. Feito para a máquina recém-formatada: basta a URL do repositório. Uma restauração escreve dentro da sua pasta pessoal.'
          : 'Brings a machine’s history back from the repository its backups were versioned to. Built for the machine that has just been reformatted: the repository URL is all it needs. A restore writes inside your home directory.'}
      </p>

      {configuredUrl && configuredRepo ? (
        // ONE repository, stated once. Drawn exactly like the versioning block's own row — the
        // mark, `owner/repo`, the link — so the two places that name it cannot look like two
        // different things.
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 2 }}>
            {pt ? 'Repositório' : 'Repository'}
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.45, margin: '0 0 6px' }}>
            {pt
              ? 'É o repositório que esta máquina usa — para onde os backups vão e de onde eles voltam. Para trocar, use o lápis em “Versionamento no GitHub”, acima.'
              : 'The repository this machine uses — where its backups go and where they come back from. To change it, use the pencil in “GitHub versioning”, above.'}
          </p>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            padding: '9px 10px', minHeight: isMobile ? 44 : undefined, boxSizing: 'border-box',
            background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7,
          }}>
            <a
              href={configuredUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: '100%',
                fontSize: 12.5, color: 'var(--anthropic-orange)', textDecoration: 'none',
                wordBreak: 'break-word',
              }}
            >
              <GithubMark size={13} />
              {configuredRepo}
            </a>
          </div>
        </div>
      ) : (
        <RestoreField
          label={pt ? 'URL do repositório' : 'Repository URL'}
          hint={pt
            ? 'O repositório privado onde os backups desta (ou de outra) máquina foram versionados.'
            : 'The private repository this machine’s — or another machine’s — backups were versioned to.'}
          value={url}
          placeholder="https://github.com/owner/repo"
          password={false}
          busy={listingBusy}
          canSubmit={canList}
          onChange={onUrl}
          onSubmit={onList}
        />
      )}
      {/* Only when `gh` cannot serve. See `ghUsable`. */}
      {!ghUsable && <RestoreField
        label={pt ? 'Token do GitHub' : 'GitHub token'}
        hint={pt
          ? 'Esta máquina não tem login no GitHub CLI. `gh auth login` costuma ser o caminho mais curto — feito isso, este campo some.'
          : 'This machine has no GitHub CLI login. `gh auth login` is usually the shorter road — once it is done, this field disappears.'}
        value={token}
        placeholder={pt ? 'ghp_… (não é exibido)' : 'ghp_… (never shown back)'}
        password
        busy={listingBusy}
        canSubmit={canList}
        onChange={onToken}
        onSubmit={onList}
      />}

      <button
        type="button"
        onClick={onList}
        disabled={!canList}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
          padding: isMobile ? '0 16px' : '8px 16px', minHeight: isMobile ? 44 : undefined,
          width: isMobile ? '100%' : undefined,
          borderRadius: 7, border: `1px solid ${canList ? 'var(--anthropic-orange)' : 'var(--border)'}`,
          background: canList ? 'var(--anthropic-orange-dim)' : 'transparent',
          color: canList ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
          fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
          cursor: canList ? 'pointer' : 'not-allowed', opacity: canList ? 1 : 0.6,
        }}
      >
        {listingBusy
          ? <><Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> {pt ? 'Procurando…' : 'Looking…'}</>
          : (pt ? 'Ver backups' : 'List backups')}
      </button>

      <GithubFeedback feedback={listingError === null ? null : { ok: false, text: listingError }} />

      {/* The result, grouped by the MACHINE that made each backup — never one flat chronological
          list. A repository can hold several machines' backups (that is what the labelled tags are
          for), and interleaving them makes "the newest" whichever machine happened to run last.
          Restoring the wrong computer onto this one is the accident this grouping exists to
          prevent. */}
      {machines !== null && machines.length === 0 && (
        <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: '14px 0 0' }}>
          {pt
            ? 'Este repositório não tem nenhum release de backup.'
            : 'This repository holds no backup releases.'}
        </p>
      )}

      {machines !== null && machines.length > 0 && (
        <div style={{ marginTop: 16 }}>
          {/* The Restaurar buttons below are disabled while a restore runs, and this is the
              sentence that says why — a disabled control that explains nothing is
              indistinguishable from a broken one. */}
          {running && (
            <p style={{ fontSize: 11.5, color: 'var(--anthropic-orange)', lineHeight: 1.5, margin: '0 0 10px' }}>
              {pt
                ? 'Uma restauração já está em andamento — só uma roda por vez, então os botões Restaurar abaixo voltam quando ela terminar.'
                : 'A restore is already running — only one runs at a time, so the Restore buttons below come back when it finishes.'}
            </p>
          )}
          {machines.map((m, mi) => (
            <div key={m.machine ?? `unnamed-${mi}`} style={{ marginBottom: 18 }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8,
                wordBreak: 'break-word',
              }}>
                {/* A machine with no recorded name is SAID, never printed as if `null` were a
                    name — the release body simply never carried one. */}
                <span>{m.machine ?? (pt
                  ? 'Backups sem nome de máquina registrado no release'
                  : 'Backups with no machine name recorded in the release')}</span>
                {/* WHICH of these is the machine you are sitting at. Every machine in the
                    repository is offered on purpose — a reformatted machine has a new name and
                    needs the OLD one's backups — so the list has to say which is which, and the
                    server has already sorted this one first. */}
                {m.thisMachine
                  ? (
                    <span style={{
                      fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
                      padding: '1px 6px', borderRadius: 4,
                      color: 'var(--anthropic-orange)',
                      border: '1px solid var(--anthropic-orange)',
                    }}>
                      {pt ? 'esta máquina' : 'this machine'}
                    </span>
                  )
                  : (
                    <span style={{
                      fontSize: 10, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
                      padding: '1px 6px', borderRadius: 4,
                      color: 'var(--text-tertiary)', border: '1px solid var(--border)',
                    }}>
                      {pt ? 'outra máquina' : 'another machine'}
                    </span>
                  )}
              </div>
              {m.releases.map(r => (
                <RestoreRelease
                  key={r.tagName}
                  release={r}
                  pt={pt}
                  disabled={running || startBusy}
                  onRestore={() => onAsk({ release: r, machine: m.machine })}
                />
              ))}
            </div>
          ))}
          {/* Only when the modal is CLOSED: a refusal keeps the modal open and is shown inside it,
              beside the button that asked for it. Repeating it out here would state the same
              failure twice. */}
          {ask === null && (
            <GithubFeedback feedback={startError === null ? null : { ok: false, text: startError }} />
          )}
        </div>
      )}

      {job && <RestoreJobBlock job={job} pt={pt} />}

      {ask && (
        <RestoreConfirmModal
          release={ask.release}
          machine={ask.machine}
          pt={pt}
          starting={startBusy}
          error={startError}
          onCancel={() => onAsk(null)}
          onConfirm={withRepos => onStart(ask.release.tagName, withRepos)}
        />
      )}
    </div>
  )
}

/**
 * What one release IS, in label/value pairs — the ONE place those four facts are worded, read by
 * both the row and the modal that asks about it. Two lists would be two chances to describe the
 * same backup differently on the two screens the user compares.
 *
 * Every value is nullable on the wire and every null renders as the WORD unknown — never `0`,
 * never a blank that reads as zero. That is the rule the whole restore screen is judged on.
 */
function releaseFacts(release: RestoreCandidate, pt: boolean): { label: string; value: string }[] {
  const unknown = unknownWord(pt)
  return [
    { label: pt ? 'Tamanho' : 'Size', value: release.sizeLabel ?? unknown },
    { label: pt ? 'Camadas' : 'Layers', value: release.layers === null ? unknown : release.layers.join(' + ') },
    { label: pt ? 'Sessões' : 'Sessions', value: release.sessions === null ? unknown : String(release.sessions) },
    {
      label: pt ? 'Harnesses' : 'Harnesses',
      value: release.harnesses === null ? unknown : release.harnesses.join(', '),
    },
  ]
}

/**
 * One release, and ONE verb.
 *
 * It used to carry two buttons named after their payload — "Só métricas" and "Tudo, incluindo
 * clonar repositórios" — with an inline two-step confirm. Reported verbatim: "eu cliquei em ver
 * backup e nao tem a opcao de restaurar". Both buttons DID restore; neither said so. The row now
 * says `Restaurar`, and the choice between the two payloads, with what each does to what you
 * already have, is the modal it opens.
 */
function RestoreRelease({ release, pt, disabled, onRestore }: {
  release: RestoreCandidate
  pt: boolean
  /** A restore is running, or a start is in flight. The sentence that says WHY is above the list. */
  disabled: boolean
  onRestore: () => void
}) {
  const facts = releaseFacts(release, pt)

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px',
      marginBottom: 8, background: 'var(--bg-elevated)',
    }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>
        {new Date(release.createdAt).toLocaleString()}
      </div>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '2px 14px', margin: '4px 0 0',
        fontSize: 11.5, color: 'var(--text-secondary)',
      }}>
        {facts.map(f => (
          <span key={f.label}>
            <span style={{ color: 'var(--text-tertiary)' }}>{f.label}: </span>
            {f.value}
          </span>
        ))}
      </div>
      {/* The tag is what `agentop restore` takes, so it is shown verbatim. It scrolls inside its
          own box: nothing on this page may make the page itself scroll sideways at 390px. */}
      <div style={{ overflowX: 'auto', margin: '6px 0 0' }}>
        <code style={{
          fontFamily: 'monospace', fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'pre',
        }}>
          {release.tagName}
        </code>
      </div>

      <div style={{ marginTop: 10 }}>
        <RestoreButton
          text={pt ? 'Restaurar' : 'Restore'}
          icon={<RotateCcw size={14} />}
          primary
          disabled={disabled}
          onClick={onRestore}
        />
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.45, margin: '6px 0 0' }}>
        {pt
          ? 'Abre as opções e o que muda no que você já tem, antes de qualquer escrita.'
          : 'Opens the choices, and what changes in what you already have, before anything is written.'}
      </p>
    </div>
  )
}

/**
 * The RESTORE modal — the question this whole flow exists to ask, in one place.
 *
 * NOT `window.confirm`: it blocks the whole tab, and this page polls a running restore job. NOT the
 * shared `ConfirmModal` from `primitives.tsx` either — that one takes a `message: string`, and what
 * has to be on screen here is a backup's identity, two options with their own descriptions, and a
 * block of what happens to the files already on this machine. So it is built here, out of the same
 * boxes, colours and touch sizes the rest of this page uses.
 *
 * Escape and a backdrop click cancel. There is deliberately NO focus trap: the confirm button takes
 * focus on open, and everything else stays reachable by Tab in document order — a hand-rolled trap
 * is the thing that breaks keyboard use, not the absence of one.
 *
 * The WARNINGS are not written here from memory. They are `restore-plan.ts`'s own four rules:
 * a local file that is NEWER is kept (`skip: 'newer-local'`), `preferences.json` is MERGED with
 * local keys winning (`mergePreferences`), a repository whose destination directory already exists
 * is SKIPPED (`destination-exists`), and the whole thing writes inside `$HOME`.
 */
function RestoreConfirmModal({ release, machine, pt, starting, error, onCancel, onConfirm }: {
  release: RestoreCandidate
  /** The machine this backup came from, or null when the release body never recorded one. */
  machine: string | null
  pt: boolean
  starting: boolean
  /** The server's own refusal for a failed start, untouched. Shown here because the modal stays
   *  open on failure — closing it would drop the answer the click asked for. */
  error: string | null
  onCancel: () => void
  onConfirm: (withRepos: boolean) => void
}) {
  const isMobile = useIsMobile()
  // The choice, defaulting to the cheap one. "Everything" clones every repository the backup
  // mapped and can run for many minutes, so it is never what a modal opens already selected.
  const [withRepos, setWithRepos] = useState(false)
  const confirmRef = React.useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onCancel])

  useEffect(() => { confirmRef.current?.focus() }, [])

  const facts = releaseFacts(release, pt)
  const identity: { label: string; value: string }[] = [
    {
      label: pt ? 'Máquina' : 'Machine',
      value: machine ?? (pt
        ? 'nenhum nome de máquina registrado no release'
        : 'no machine name recorded in the release'),
    },
    { label: pt ? 'Data' : 'Date', value: new Date(release.createdAt).toLocaleString() },
    ...facts,
  ]

  const confirmText = withRepos
    ? (pt ? 'Restaurar tudo e clonar os repositórios' : 'Restore everything and clone repositories')
    : (pt ? 'Restaurar só as métricas' : 'Restore metrics only')

  return (
    <div
      onClick={onCancel}
      role="presentation"
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        display: 'flex', alignItems: isMobile ? 'stretch' : 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)',
        // Full-screen on mobile — flush left, right and bottom, with only the status-bar inset
        // reserved at the top (`OVERLAY_TOP`). A bare `0` here puts the dialog's own header under
        // the iOS clock, which takes the taps: `mobileOverlay.ts` owns that decision for every
        // full-screen overlay in the app, and its lint fails the build on a hardcoded zero.
        padding: isMobile ? OVERLAY_TOP : 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={pt ? 'Restaurar backup' : 'Restore backup'}
        style={{
          width: '100%', maxWidth: isMobile ? '100%' : 560,
          height: isMobile ? '100%' : undefined,
          maxHeight: isMobile ? '100%' : '90vh',
          overflowY: 'auto', boxSizing: 'border-box',
          background: 'var(--bg-card)', border: isMobile ? 'none' : '1px solid var(--border)',
          borderRadius: isMobile ? 0 : 12, padding: isMobile ? 16 : 22,
          boxShadow: isMobile ? 'none' : '0 12px 48px rgba(0,0,0,0.5)',
          display: 'flex', flexDirection: 'column', gap: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            display: 'inline-flex', padding: 8, borderRadius: 9,
            background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)',
          }}>
            <RotateCcw size={17} />
          </span>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
            {pt ? 'Restaurar este backup' : 'Restore this backup'}
          </span>
        </div>

        {/* WHICH backup. Named before anything is chosen — restoring the wrong computer onto this
            one is the accident the machine grouping in the list exists to prevent, and the modal
            is the last place that can still say which machine this is. */}
        <div>
          {identity.map(f => (
            <div
              key={f.label}
              style={{
                display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12,
                padding: '5px 0', borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)', flexShrink: 0 }}>{f.label}</span>
              <span style={{
                fontSize: 12, color: 'var(--text-primary)', textAlign: 'right',
                minWidth: 0, wordBreak: 'break-word',
              }}>
                {f.value}
              </span>
            </div>
          ))}
          {/* The tag verbatim, in its own sideways-scrolling box — the page must not scroll
              horizontally at 390px, and this modal IS the page there. */}
          <div style={{ overflowX: 'auto', margin: '8px 0 0' }}>
            <code style={{
              fontFamily: 'monospace', fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'pre',
            }}>
              {release.tagName}
            </code>
          </div>
        </div>

        {/* THE CHOICE. Two options, each named for what it does and carrying its own one-line
            description — never a bare pair of buttons whose difference the reader has to infer. */}
        <div role="radiogroup" aria-label={pt ? 'O que restaurar' : 'What to restore'} style={{
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          <RestoreChoice
            selected={!withRepos}
            disabled={starting}
            onSelect={() => setWithRepos(false)}
            title={pt ? 'Só as métricas' : 'Metrics only'}
            description={pt
              ? 'Traz sessões, métricas e configurações. Segundos.'
              : 'Brings sessions, metrics and settings. Seconds.'}
          />
          <RestoreChoice
            selected={withRepos}
            disabled={starting}
            onSelect={() => setWithRepos(true)}
            title={pt ? 'Tudo, incluindo clonar os repositórios' : 'Everything, including cloning repositories'}
            description={pt
              ? 'Além das métricas, clona cada repositório que este backup mapeou. Pode levar muitos minutos.'
              : 'On top of the metrics, clones every repository this backup mapped. It can take many minutes.'}
          />
        </div>

        {/* WHAT HAPPENS TO WHAT YOU HAVE NOW. Every line is a rule that exists in
            `restore-plan.ts`, not a reassurance written for this screen. */}
        <div style={{
          padding: '10px 12px', borderRadius: 8,
          background: 'color-mix(in srgb, var(--anthropic-orange) 8%, transparent)',
          border: '1px solid color-mix(in srgb, var(--anthropic-orange) 28%, transparent)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 7, marginBottom: 6,
            fontSize: 12, fontWeight: 700, color: 'var(--text-primary)',
          }}>
            <AlertTriangle size={14} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />
            {pt ? 'O que acontece com o que você já tem' : 'What happens to what you have now'}
          </div>
          <ul style={{
            margin: 0, paddingLeft: 18, fontSize: 11.5, lineHeight: 1.55,
            color: 'var(--text-secondary)',
          }}>
            <li>{pt
              ? 'Um arquivo que já existe aqui e é MAIS NOVO que o do backup é mantido — a restauração não sobrescreve às cegas.'
              : 'A file you already have that is NEWER than the one in the backup is KEPT — the restore does not blindly overwrite.'}</li>
            <li>{pt
              ? 'As suas preferências são MESCLADAS, nunca substituídas: as suas chaves ganham, e só as que você não tem são trazidas do backup.'
              : 'Your preferences are MERGED, never replaced: your local keys win, and only keys you do not have are taken from the backup.'}</li>
            {withRepos && (
              <li>{pt
                ? 'Um repositório cujo diretório de destino JÁ EXISTE é pulado — um checkout que já está aí nunca é tocado nem sobrescrito.'
                : 'A repository whose destination directory ALREADY EXISTS is skipped — a checkout that is already there is never touched or overwritten.'}</li>
            )}
            <li>{pt
              ? 'A restauração escreve dentro da sua pasta pessoal.'
              : 'The restore writes inside your home directory.'}</li>
          </ul>
        </div>

        {/* The server's own refusal, untouched, beside the button that asked for it. */}
        <GithubFeedback feedback={error === null ? null : { ok: false, text: error }} />

        <div style={{
          display: 'flex', gap: 8, marginTop: 2, justifyContent: 'flex-end',
          flexDirection: isMobile ? 'column-reverse' : 'row',
        }}>
          <RestoreButton
            text={pt ? 'Cancelar' : 'Cancel'}
            primary={false}
            disabled={false}
            onClick={onCancel}
          />
          <RestoreButton
            buttonRef={confirmRef}
            text={starting ? (pt ? 'Iniciando…' : 'Starting…') : confirmText}
            busy={starting}
            primary
            disabled={starting}
            onClick={() => onConfirm(withRepos)}
          />
        </div>
      </div>
    </div>
  )
}

/** One of the modal's two options: a whole-card radio, ≥44px on mobile, carrying its own one-line
 *  description. A bare button pair would leave the difference between the two to be inferred. */
function RestoreChoice({ selected, disabled, onSelect, title, description }: {
  selected: boolean
  disabled: boolean
  onSelect: () => void
  title: string
  description: string
}) {
  const isMobile = useIsMobile()
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 3,
        width: '100%', boxSizing: 'border-box', textAlign: 'left',
        padding: '10px 12px', minHeight: isMobile ? 44 : undefined,
        borderRadius: 8,
        border: `1px solid ${selected ? 'var(--anthropic-orange)' : 'var(--border)'}`,
        background: selected ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
        fontFamily: 'inherit',
      }}
    >
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 7,
        fontSize: 12.5, fontWeight: 700,
        color: selected ? 'var(--anthropic-orange)' : 'var(--text-primary)',
      }}>
        <span style={{
          width: 12, height: 12, borderRadius: '50%', flexShrink: 0, boxSizing: 'border-box',
          border: `2px solid ${selected ? 'var(--anthropic-orange)' : 'var(--border)'}`,
          background: selected ? 'var(--anthropic-orange)' : 'transparent',
          boxShadow: selected ? 'inset 0 0 0 2px var(--bg-card)' : 'none',
        }} />
        {title}
      </span>
      <span style={{
        fontSize: 11, lineHeight: 1.45, color: 'var(--text-tertiary)', fontWeight: 400,
      }}>
        {description}
      </span>
    </button>
  )
}

/** This page's shared button shape — the same box every other control here uses, sized as a real
 *  touch target and full-width on mobile. Used by the restore rows and by both modals. */
function RestoreButton({ text, primary, danger, disabled, busy, icon, buttonRef, onClick }: {
  text: string
  primary: boolean
  /** The destructive confirm — the same red as every warning on this page, so a button that
   *  removes something is never dressed in the accent colour that Save wears. Only meaningful
   *  together with `primary`. */
  danger?: boolean
  disabled: boolean
  busy?: boolean
  /** A glyph before the label — the row's `Restaurar` carries one so the verb is recognisable
   *  before it is read. Never shown while `busy`: the spinner takes that slot. */
  icon?: React.ReactNode
  /** So the modal can put focus on its confirm button when it opens. */
  buttonRef?: React.RefObject<HTMLButtonElement | null>
  onClick: () => void
}) {
  const isMobile = useIsMobile()
  const live = !disabled
  const accent = danger ? '#ef4444' : 'var(--anthropic-orange)'
  const accentDim = danger
    ? 'color-mix(in srgb, #ef4444 12%, transparent)'
    : 'var(--anthropic-orange-dim)'
  return (
    <button
      type="button"
      ref={buttonRef}
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        padding: isMobile ? '0 14px' : '7px 14px', minHeight: isMobile ? 44 : undefined,
        width: isMobile ? '100%' : undefined, boxSizing: 'border-box',
        borderRadius: 7,
        border: `1px solid ${live && primary ? accent : 'var(--border)'}`,
        background: live && primary ? accentDim : 'transparent',
        color: live ? (primary ? accent : 'var(--text-secondary)') : 'var(--text-tertiary)',
        fontSize: 12.5, fontWeight: primary ? 700 : 500, fontFamily: 'inherit',
        cursor: live ? 'pointer' : 'not-allowed', opacity: live ? 1 : 0.6,
        textAlign: 'center',
      }}
    >
      {busy
        ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
        : icon}
      {text}
    </button>
  )
}

/**
 * The running (or finished) restore.
 *
 * The tail is bounded at `RESTORE_TAIL_LINES` and scrolls inside its own box — the repos phase
 * prints thousands of lines and the end is where the outcome is. A finished job KEEPS its lines
 * beside its outcome: "it wrote 699 files" is worth much less without what it was doing.
 */
function RestoreJobBlock({ job, pt }: { job: RestoreJob; pt: boolean }) {
  const active = job.state === 'queued' || job.state === 'running'
  const tail = job.lines.slice(-RESTORE_TAIL_LINES)
  const stateWord = job.state === 'queued' ? (pt ? 'na fila' : 'queued')
    : job.state === 'running' ? (pt ? 'em andamento' : 'running')
    : job.state === 'done' ? (pt ? 'concluída' : 'done')
    : (pt ? 'falhou' : 'failed')

  return (
    <div style={{
      marginTop: 16, padding: '10px 12px', borderRadius: 8,
      background: 'var(--bg-elevated)', border: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        {active
          ? <Loader2 size={14} style={{ color: 'var(--anthropic-orange)', animation: 'spin 1s linear infinite', flexShrink: 0 }} />
          : job.state === 'done'
            ? <CheckCircle2 size={14} style={{ color: 'var(--accent-green)', flexShrink: 0 }} />
            : <AlertTriangle size={14} style={{ color: '#ef4444', flexShrink: 0 }} />}
        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)' }}>
          {pt ? `Restauração ${stateWord}` : `Restore ${stateWord}`}
        </span>
        <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>
          {job.withRepos
            ? (pt ? '· tudo, incluindo repositórios' : '· everything, including repositories')
            : (pt ? '· só métricas' : '· metrics only')}
        </span>
      </div>

      <div style={{ overflowX: 'auto', margin: '4px 0 0' }}>
        <code style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'pre' }}>
          {job.tag}
        </code>
      </div>

      {job.state === 'done' && (
        <p style={{ fontSize: 12, color: 'var(--accent-green)', lineHeight: 1.45, margin: '6px 0 0' }}>
          {/* `written` is nullable on the wire like every other derived number here, so a job that
              finished without one says so rather than reporting a confident zero. */}
          {job.written === null
            ? (pt ? 'Concluída — número de arquivos desconhecido.' : 'Done — the number of files written is unknown.')
            : (pt ? `Concluída — ${job.written} arquivo(s) escrito(s).` : `Done — ${job.written} file(s) written.`)}
        </p>
      )}
      {job.state === 'failed' && (
        <p style={{ fontSize: 12, color: '#ef4444', lineHeight: 1.45, margin: '6px 0 0' }}>
          {/* The server's own reason, untouched. */}
          {job.reason ?? (pt ? 'falhou, sem motivo registrado' : 'failed, with no recorded reason')}
        </p>
      )}

      {tail.length > 0 && (
        <div style={{
          marginTop: 8, padding: '8px 10px', borderRadius: 7,
          background: 'var(--bg-base)', border: '1px solid var(--border-subtle)',
          overflowX: 'auto',
        }}>
          <pre style={{
            margin: 0, fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5,
            color: 'var(--text-secondary)', whiteSpace: 'pre',
          }}>
            {tail.join('\n')}
          </pre>
        </div>
      )}
    </div>
  )
}

/**
 * One field of the restore form.
 *
 * Styled exactly like `GithubConnectForm`'s own fields — same box, same focus accent, same
 * deliberate ABSENCE of an inline `font-size` (`index.css` forces 16px on every mobile input to
 * stop iOS Safari zooming the viewport, and a value here would only be a live-looking line that
 * rule already overrides). It is its own component rather than a call into that form's local
 * closure so that neither section can change the other's fields by accident.
 */
function RestoreField({
  label, hint, value, placeholder, password, busy, canSubmit, onChange, onSubmit,
}: {
  label: string
  hint: string
  value: string
  placeholder: string
  password: boolean
  busy: boolean
  /** Whether Enter should submit — the same predicate the button is disabled by, so the key and
   *  the button can never disagree. */
  canSubmit: boolean
  onChange: (v: string) => void
  onSubmit: () => void
}) {
  const isMobile = useIsMobile()
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 2 }}>{label}</div>
      <p style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.45, margin: '0 0 6px' }}>{hint}</p>
      <input
        type={password ? 'password' : 'text'}
        value={value}
        placeholder={placeholder}
        disabled={busy}
        autoComplete="off"
        spellCheck={false}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && canSubmit) { e.preventDefault(); onSubmit() } }}
        style={{
          width: '100%', minWidth: 0, boxSizing: 'border-box',
          padding: '7px 10px', minHeight: isMobile ? 44 : undefined,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 7,
          fontFamily: password ? 'monospace' : 'inherit', color: 'var(--text-primary)', outline: 'none',
          transition: 'border-color 0.15s',
          ...(busy ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
        }}
        onFocus={e => { if (!busy) e.currentTarget.style.borderColor = 'var(--anthropic-orange)' }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
      />
    </div>
  )
}

/**
 * The three named shapes, one of them marked RECOMMENDED.
 *
 * Above the layer checkboxes rather than instead of them: a preset is a starting point, not a cage,
 * and the checkboxes below go on showing exactly what is ticked. A hand-picked set that happens to
 * equal a preset shows as that preset — order does not decide it — and a set matching none shows
 * none selected rather than the nearest one.
 */
function PresetPicker({ layers, pt, disabled, onPick }: {
  layers: BackupLayer[]
  pt: boolean
  disabled: boolean
  onPick: (layers: BackupLayer[]) => void
}) {
  const isMobile = useIsMobile()
  const current = presetOf(layers)
  const shown = current ?? 'recommended'
  const text = PRESET_TEXT[shown]!
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        display: 'flex', gap: 8, flexWrap: 'wrap',
        flexDirection: isMobile ? 'column' : 'row',
      }}>
        {BACKUP_PRESETS.map(p => {
          const on = current === p.id
          const t = PRESET_TEXT[p.id]!
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onPick(p.layers)}
              disabled={disabled}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                padding: isMobile ? '0 16px' : '7px 14px', minHeight: isMobile ? 44 : undefined,
                width: isMobile ? '100%' : undefined,
                borderRadius: 7,
                border: `1px solid ${on ? 'var(--anthropic-orange)' : 'var(--border)'}`,
                background: on ? 'var(--anthropic-orange-dim)' : 'transparent',
                color: on ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
                fontSize: 12.5, fontWeight: on ? 700 : 500, fontFamily: 'inherit',
                cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
              }}
            >
              {pt ? t.pt.name : t.en.name}
              {p.recommended && (
                // Said on the button and not only in a paragraph: the whole point is that it is
                // readable at the moment of choosing.
                <span style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
                  padding: '1px 5px', borderRadius: 4,
                  color: on ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
                  border: `1px solid ${on ? 'var(--anthropic-orange)' : 'var(--border)'}`,
                }}>
                  {pt ? 'sugerido' : 'suggested'}
                </span>
              )}
            </button>
          )
        })}
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: '8px 0 0' }}>
        {current === null
          // Never presented as a preset it is not — the description shown belongs to a shape the
          // user is not on, so it is labelled as a suggestion instead of a statement.
          ? (pt
            ? 'Você escolheu as camadas à mão. O sugerido é “Recomendado”.'
            : 'You picked the layers by hand. The suggested shape is “Recommended”.')
          : (pt ? text.pt.what : text.en.what)}
      </p>
    </div>
  )
}
