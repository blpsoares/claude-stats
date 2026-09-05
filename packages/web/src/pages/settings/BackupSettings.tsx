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
        setConnectToken('')
        setConnectUrl('')
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
    } catch {
      setGithub(null)
    }
  }, [])

  useEffect(() => { void loadGithub() }, [loadGithub])

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

          {/* Where the backups GO, before anything about what they contain. It is the decision a
              person makes first and revisits least — an unconnected machine is one whose whole
              history lives only on the disk being replaced, and burying that under four sections
              about format and recurrence answers questions nobody asked yet. */}
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
              />
            </>
          )}

          <Divider />

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

          {/* GitHub versioning. Absent entirely when the endpoint 404s (a central) — see
              `loadGithub`. */}
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

/**
 * GITHUB VERSIONING — each backup becomes a Release on a private GitHub repository the user owns.
 *
 * Two shapes, and the unconfigured one is deliberately NOT a form. Connecting a repository needs a
 * GitHub token, which `agentop backup github setup` verifies against the API and refuses on a
 * public repository; a token box on a settings page is exactly the habit that flow avoids teaching.
 * So an unconfigured machine gets the explanation plus the command to run, and nothing to type.
 *
 * The configured shape changes only what can be changed WITHOUT a token — the machine name, how
 * many of this machine's releases to keep, and whether the local archive goes after a confirmed
 * upload. Nothing on this page is, or could be, a credential.
 */
function GithubVersioning({
  section, labelDraft, keepDraft, saving, result, pt,
  onLabelDraft, onKeepDraft, onSaveLabel, onSaveKeep, onToggleDeleteLocal,
  connectUrl, connectToken, connecting, connectError, onConnectUrl, onConnectToken, onConnect,
  useGh, onUseGh,
}: {
  section: GithubSectionJson
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
      <SectionHeader label={pt ? 'Versionamento no GitHub' : 'GitHub versioning'} />

      {!section.configured ? (
        <GithubConnectForm
          pt={pt}
          urlDraft={connectUrl}
          tokenDraft={connectToken}
          busy={connecting}
          error={connectError}
          gh={section.gh}
          useGh={useGh}
          onUrl={onConnectUrl}
          onToken={onConnectToken}
          onUseGh={onUseGh}
          onSubmit={onConnect}
        />
      ) : (
        <>
          <ConfigRow
            label={pt ? 'Repositório' : 'Repository'}
            value={
              <a
                href={section.url}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--anthropic-orange)', textDecoration: 'none', wordBreak: 'break-word' }}
              >
                {section.repo}
              </a>
            }
          />

          <div style={{ marginTop: 16 }}>
            <GithubTextField
              label={pt ? 'Nome da máquina' : 'Machine name'}
              hint={pt
                ? `Várias máquinas podem versionar no MESMO repositório, e este nome é o que separa os backups delas: ele entra na tag do release, e a retenção só apaga releases desta máquina — nunca os de outra. \`agentop restore <url> --from ${section.label}\` restaura especificamente esta máquina.`
                : `Several machines can version to the SAME repository, and this name is what tells their backups apart: it rides in the release tag, and retention only ever deletes this machine’s own releases — never another machine’s. \`agentop restore <url> --from ${section.label}\` restores this machine specifically.`}
              value={labelDraft}
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
            label={pt ? 'Manter no GitHub' : 'Keep on GitHub'}
            hint={pt
              ? 'Quantos releases DESTA máquina manter. 0 mantém todos. A retenção conta só os releases desta máquina e nunca toca nos de outra.'
              : 'How many of THIS machine’s releases to keep. 0 keeps every one. Retention counts only this machine’s releases and never touches another machine’s.'}
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
 * One editable value with its own explicit Save and its own resolution.
 *
 * Styled like `primitives.tsx`'s `FieldInput` (same box, same focus accent) but carrying a Save
 * button and a pending state, which that one has no notion of. The input deliberately sets NO
 * inline `font-size`: `index.css` forces 16px on every mobile input to stop iOS Safari zooming
 * the viewport, and a value here would only be a live-looking line that rule already overrides.
 */
function GithubTextField({
  label, hint, value, onChange, onSave, saveLabel, savingLabel, saving, busy, dirty, numeric, feedback,
}: {
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
}: {
  pt: boolean
  urlDraft: string
  tokenDraft: string
  busy: boolean
  error: string | null
  /** Whether the GitHub CLI on this machine can be used instead of a token. */
  gh?: { usable: true; account: string } | { usable: false; reason: 'not-installed' | 'logged-out' }
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
        {pt
          ? 'Cada backup vira um Release num repositório privado do GitHub que é seu — o histórico desta máquina passa a viver fora dela, e o arquivo local pode ser apagado assim que o envio é conferido byte a byte.'
          : 'Each backup becomes a Release on a private GitHub repository you own — this machine’s history then lives off the machine, and the local archive can be deleted once the upload is confirmed byte for byte.'}
      </p>
      <ol style={{
        fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6, margin: '0 0 14px',
        paddingLeft: 18,
      }}>
        <li>{pt
          ? 'Crie um repositório no GitHub e marque PRIVADO. Um público é recusado aqui — o backup carrega suas métricas, os primeiros prompts e um mapa dos seus diretórios.'
          : 'Create a repository on GitHub and mark it PRIVATE. A public one is refused here — a backup carries your metrics, your first prompts and a map of your directories.'}</li>
        <li>{pt ? 'Cole a URL abaixo.' : 'Paste the URL below.'}</li>
        {!ghUsable && (
          <li>{pt
            ? 'Gere um token: fine-grained com acesso só a esse repositório e "Contents: Read and write", ou um clássico com o escopo repo.'
            : 'Generate a token: fine-grained with access to that repository only and "Contents: Read and write", or a classic one with the repo scope.'}</li>
        )}
      </ol>

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

      <button
        type="button"
        onClick={onSubmit}
        disabled={!canSubmit}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
          padding: isMobile ? '0 16px' : '8px 16px', minHeight: isMobile ? 44 : undefined,
          width: isMobile ? '100%' : undefined,
          borderRadius: 7, border: `1px solid ${canSubmit ? 'var(--anthropic-orange)' : 'var(--border)'}`,
          background: canSubmit ? 'var(--anthropic-orange-dim)' : 'transparent',
          color: canSubmit ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
          fontSize: 13, fontWeight: 700, fontFamily: 'inherit',
          cursor: canSubmit ? 'pointer' : 'not-allowed', opacity: canSubmit ? 1 : 0.6,
        }}
      >
        {busy
          ? <><Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> {pt ? 'Conectando…' : 'Connecting…'}</>
          : (pt ? 'Conectar repositório' : 'Connect repository')}
      </button>

      <GithubFeedback feedback={error === null ? null : { ok: false, text: error }} />

      <p style={{ fontSize: 11.5, color: 'var(--text-tertiary)', lineHeight: 1.5, margin: '10px 0 0' }}>
        {pt
          ? `Pela linha de comando o mesmo passo é: ${GITHUB_SETUP_COMMAND}`
          : `From the command line the same step is: ${GITHUB_SETUP_COMMAND}`}
      </p>
    </div>
  )
}
