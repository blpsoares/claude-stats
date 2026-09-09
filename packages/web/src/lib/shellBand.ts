/**
 * shellBand.ts — PURE. The decisions the per-session shell band makes, kept out of the JSX.
 *
 * Three of them, and each is a rule the spec states rather than a preference:
 *
 *  - **The unwatch discipline** (`shellWatching`). The capture loop runs ONLY while the band is
 *    open, the session selected and the document visible. It is the only per-second cost this
 *    feature has — two tmux reads a second per watched pane — and `terminal-web.ts` already records
 *    the rule for the fleet's own channel: "capture is viewer-gated, so a surface that forgets to
 *    unwatch leaves a `capture-pane` loop running for a screen nobody can see."
 *  - **The geometry** (`clampBandHeight`). A drag may not shrink the band below a readable floor
 *    nor let it eat the conversation above it.
 *  - **The refusals** (`shellErrorText`). The route-level errors — the ones `index.ts` answers
 *    BEFORE `shell-web.ts` gets to compose a sentence — carry a CODE and no prose. The band must
 *    still say what happened: a blank pane is the confident-nothing this repo refuses everywhere
 *    else. `shell-web.ts`'s own refusals (`no-tmux`, `no-cwd`, `cwd-missing`, `at-cap`) already
 *    arrive as sentences and are shown verbatim; nothing here re-words them.
 *
 * The band's open/closed state and its height are a per-viewer convenience, so they live in
 * `localStorage` — the CLAUDE.md rule for exactly this kind of state — and every read and write is
 * guarded: a private window, cleared site data or a browser blocking storage makes the accessor
 * itself throw.
 */

/** The smallest band worth drawing: a prompt, a command and a few lines of its output. */
export const BAND_MIN_PX = 140

/** The most of the panel a band may take. Above this the conversation it docks under is gone. */
export const BAND_MAX_FRACTION = 0.7

const STORAGE_KEY = 'agentistics-shell-band'

export interface ShellWatchFacts {
  /** Is the band expanded (or the mobile sheet up)? */
  bandOpen: boolean
  /** Is a session selected, and is this band that session's? */
  sessionSelected: boolean
  /** `document.visibilityState === 'visible'`. */
  documentVisible: boolean
}

export function shellWatching(f: ShellWatchFacts): boolean {
  return f.bandOpen && f.sessionSelected && f.documentVisible
}

/**
 * The dragged height, bounded.
 *
 * The floor is applied LAST so a viewport too short for it still yields a layable-out box rather
 * than a ceiling below the floor, which a naive `Math.min(max, Math.max(min, h))` produces as a
 * height smaller than the minimum — and a flex child cannot be laid out at a negative one.
 */
export function clampBandHeight(px: number, viewportHeight: number): number {
  if (!Number.isFinite(px)) return BAND_MIN_PX
  const ceiling = Math.round(viewportHeight * BAND_MAX_FRACTION)
  return Math.max(BAND_MIN_PX, Math.min(px, ceiling))
}

/** The route-level refusal codes, which carry no sentence of their own. */
const ERROR_TEXT: Record<string, { en: string; pt: string }> = {
  shell_disabled: {
    en: 'The terminal is off on this machine. Turn it on in Settings → Sessions.',
    pt: 'O terminal está desligado nesta máquina. Ligue em Configurações → Sessões.',
  },
  shell_central: {
    en: 'A central aggregates other machines and has no host of its own to open a terminal on.',
    pt: 'Uma central agrega outras máquinas e não tem host próprio para abrir um terminal.',
  },
  no_host: {
    en: 'This server cannot reach its session host right now.',
    pt: 'Este servidor não consegue alcançar o host das sessões agora.',
  },
  unknown_session: {
    en: 'This machine does not manage that session, so there is no directory to open a terminal in.',
    pt: 'Esta máquina não gerencia essa sessão, então não há diretório onde abrir um terminal.',
  },
  network: {
    en: 'The server did not answer.',
    pt: 'O servidor não respondeu.',
  },
}

/** An unknown code is shown VERBATIM — a reason nobody can read still beats a silent failure. */
export function shellErrorText(code: string, lang: 'pt' | 'en'): string {
  const entry = ERROR_TEXT[code]
  return entry ? entry[lang] : code
}

/**
 * How many trailing segments of the directory the band names.
 *
 * Two, because one is ambiguous on a machine full of `src` and `web` folders and three does not fit
 * a band's title row at 390px.
 */
const WHERE_SEGMENTS = 2

/**
 * Where the shell was opened, said in the room a band's title row has.
 *
 * `direction: rtl` is the trick the session list uses to keep a path's tail visible, and it is
 * WRONG here: this string starts with `~`, and rtl moves that marker to the END —
 * `eu/freelas/Pelvis-Institucional/~`, which reads as a directory called `~` inside the project.
 * Verified on screen at 390px before this existed. So the trim is computed, and the leading `…`
 * says out loud that something was cut.
 */
export function shellWhere(cwd: string | undefined): string {
  if (!cwd) return ''
  const short = cwd.replace(/^\/home\/[^/]+/, '~').replace(/^\/Users\/[^/]+/, '~')
  const segments = short.split('/').filter(Boolean)
  // `~/x` and `/srv/app` are already at the budget; only a genuinely deeper path is cut.
  if (segments.length <= WHERE_SEGMENTS) return short
  return `…/${segments.slice(-WHERE_SEGMENTS).join('/')}`
}

export interface BandPrefs {
  open: boolean
  height: number
}

/** ABSENT READS AS CLOSED. Nobody acquires an open shell band by having reloaded the page. */
export const DEFAULT_BAND_PREFS: BandPrefs = { open: false, height: 240 }

export function readBandPrefs(storage?: Storage): BandPrefs {
  try {
    const raw = (storage ?? globalThis.localStorage)?.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_BAND_PREFS
    const v = JSON.parse(raw) as unknown
    if (typeof v !== 'object' || v === null) return DEFAULT_BAND_PREFS
    const r = v as Record<string, unknown>
    return {
      open: r.open === true,
      // A height that does not read as one falls back to the DEFAULT, not to the floor: a record
      // half of which could not be read is not a request for the smallest possible band.
      height: typeof r.height === 'number' && Number.isFinite(r.height)
        ? Math.max(BAND_MIN_PX, r.height)
        : DEFAULT_BAND_PREFS.height,
    }
  } catch {
    return DEFAULT_BAND_PREFS
  }
}

export function writeBandPrefs(prefs: BandPrefs, storage?: Storage): void {
  try {
    (storage ?? globalThis.localStorage)?.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch { /* a browser blocking site data costs the convenience, never the band */ }
}
