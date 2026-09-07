/**
 * session-dimensions.ts — PURE. The ONE table of things a session can be grouped by and filtered on.
 *
 * ## Why it is one table
 *
 * Grouping was a hand-written union (`'none' | 'harness' | 'model' | 'project' | 'task' | 'repo'`)
 * and filtering was a separate, differently-shaped thing beside it (`states`, `onlyActive`,
 * `showClosed`, `showExited`, `showUnfiled`, a task scope and a project scope). Two lists of the same
 * set of facts, maintained by hand, in different places — exactly the pattern CLAUDE.md forbids for
 * harnesses ("never hardcode a harness list anywhere else — five places used to, and TypeScript
 * accepts an array literal with a member missing"), and it failed the same way: adding `status` meant
 * remembering two places, and whoever forgot one shipped a dimension that groups but cannot filter.
 *
 * So there is one `Record<SessionDimensionId, SessionDimension>`, the build breaks until a new
 * dimension is declared, and **grouping and filtering both read the same `keyOf`**. That is not a
 * tidiness argument: with two derivations, the chip "status: waiting" and the band "waiting" drift
 * into showing different sets and nothing in the build complains. `session-dimensions.test.ts`
 * cross-checks it for every dimension and every bucket — filtering to one bucket must return exactly
 * the rows that bucket's band contains.
 *
 * ## The two defects this replaces
 *
 * **One dimension owned by two controls, and one of them silently won.** The show switches
 * (`only active`, `closed conversations`, `finished sessions`) and the state section both decided
 * which lifecycle states the list contained, and the state section was the whole answer whenever it
 * was present — so the switches changed nothing while continuing to draw their own on/off. Measured
 * on the reporting machine: `onlyActive: true` on screen, `62 of 65` sessions listed, nearly all of
 * them closed or ended. Ordering the switches differently does not fix a control that lies.
 *
 * Now there is exactly one piece of state for the dimension — the status selection — and the
 * switches are SHORTCUTS that write into it and read their on/off back OUT of it. They cannot
 * disagree, because there is nothing left to disagree about. The visible consequence is the point:
 * ticking "closed conversations" while "only active" is on widens the selection, and "only active"
 * turns ITSELF off, because it no longer describes the list.
 *
 * **The named-row exception was invisible.** A row the user renamed, noted or filed under a task
 * passed the history switches unconditionally. It exists for a real reason — a reboot turns every
 * managed session `lost`, and without it the default list came back empty, taking the names with it
 * — but an unwritten widening is the same class of defect as the switches above. It is now the
 * `showNamed` switch: off as it ships, so the filter applies to everyone, and a widening someone
 * chose and can see when it is on.
 *
 * It widens the STATUS dimension only. Generalising it to every dimension would let a named row
 * escape a project or repo filter, which is not an exception anyone asked for and would make those
 * filters lie in the same way.
 */

// TYPE-only, deliberately: `types.ts` imports the two default VALUES below, and a value cycle
// between them would be a real one. Types are erased, so this direction costs nothing and keeps the
// default arrangement derived from the vocabulary rather than spelled out a second time beside it.
import { recencyOf } from './session-order'
import type { ControlSession, SessionState, SessionViewPrefs } from './types'

// ---------------------------------------------------------------------------
// the status vocabulary — here rather than in `sessions.ts` because `keyOf` needs it, and the
// dependency has to run one way
// ---------------------------------------------------------------------------

/**
 * Declared FIRST because the lists below are derived from them, and a `const` referenced before its
 * declaration is a runtime error the type checker does not see — the derived list threw at import
 * time while `tsc` stayed clean.
 */
const ACTIVE_STATES_RAW: readonly SessionState[] =
  ['working', 'waiting', 'waiting-approval', 'unknown'] as const
const OFF_STATE_RAW: SessionState = 'closed'

/**
 * Every state a row can wear, in the order the menu lists them: most urgent first, history last.
 *
 * Exhaustive on purpose — `Record`-shaped elsewhere, a plain array here — so a state added to
 * `SessionState` shows up as a missing row rather than as a filter that silently drops every session
 * wearing it.
 */
export const SESSION_STATES: readonly SessionState[] =
  ['waiting-approval', 'waiting', 'working', 'exited', 'lost', 'closed', 'unknown'] as const

/**
 * The states as the MENU offers them — one row per CHOICE, not one per internal state.
 *
 * `SESSION_STATES` stays exhaustive because it is what a stored selection is validated against and
 * what `statusKey` maps into. This is the shorter list a person picks from, and the difference
 * between the two is the whole of the "3 desligados, wtf" report: collapsing the word left three
 * rows all reading `desligada`, which is worse than three different words — one choice offered
 * three times, with nothing on screen saying why.
 *
 * Derived by filtering the exhaustive list rather than written beside it, so a state added to
 * `SessionState` appears here automatically if it is active, and folds into the off bucket if it is
 * not. A second hand-written array is the pattern this module exists to remove.
 */
export const SESSION_STATE_CHOICES: readonly SessionState[] =
  SESSION_STATES.filter(v => ACTIVE_STATES_RAW.includes(v) || v === OFF_STATE_RAW)

/**
 * The states that mean something is ALIVE on the other end — what the `active` shortcut keeps.
 *
 * `unknown` is in the list, and that is not a hedge. It is the state of an EXTERNAL session, and an
 * external row exists precisely because `/proc` reported a live assistant process: the thing that
 * cannot be read is its ACTIVITY, never whether it is running. Leaving it out hid exactly the
 * sessions someone opened outside agentop and is in the middle of.
 */
export const ACTIVE_STATES: readonly SessionState[] = ACTIVE_STATES_RAW

/**
 * The one bucket every not-running state falls into.
 *
 * `exited`, `lost` and `closed` are three internal facts — a session that finished, one the backend
 * can no longer find, and a conversation that was never ours. They are real and the detail pane
 * still tells them apart. But as a CHOICE they are one: "is it running?" has two answers, and a
 * menu that offers the third one twice more is a menu where two rows do nothing you can see.
 *
 * A `SessionState` and not a new string, so it needs no vocabulary of its own — the word tables
 * already map all three to the same label.
 */
export const OFF_STATE: SessionState = OFF_STATE_RAW

/** The status BUCKET a row belongs to — PURE. See `OFF_STATE`. */
export function statusKey(state: SessionState): SessionState {
  return ACTIVE_STATES.includes(state) ? state : OFF_STATE
}

/**
 * Is this session RUNNING right now — PURE.
 *
 * Takes the STATE and nothing else, for the reason `sessionRank` gives: a client holding a reduced
 * row (the VS Code extension's `FleetRow`, read over HTTP) asks THIS function rather than restating
 * which states count as active. Every existing caller passes a `ControlSession` and is unaffected.
 */
export function sessionRunning(s: Pick<ControlSession, 'state'>): boolean {
  return ACTIVE_STATES.includes(s.state)
}

/**
 * Whether the user deliberately MARKED this row — a name, a note, or a task — PURE.
 *
 * Its own flag rather than something inferred from `title`, because `title` always has a value: the
 * host derives one when there is no label, so "has a title" says nothing about whether anyone chose
 * it.
 */
export function sessionNamed(s: ControlSession): boolean {
  return s.named === true
}

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------

export type SessionDimensionId =
  | 'day'
  | 'status'
  | 'harness'
  | 'model'
  | 'project'
  | 'repo'
  | 'task'
  | 'marked'

/**
 * What a row is grouped under, and filtered by, when it has NO value on a dimension.
 *
 * A real bucket with a real name, not a hole. A session with no task, no repo, no model exists and
 * has to be findable — the old `showUnfiled` switch was this case solved for exactly one dimension,
 * and only while grouping by that dimension. Every dimension now names its own, and it is selectable
 * like any other value.
 *
 * `''` is safe as the key: every other key is a harness id, a model id, a folder name, a repository
 * name, a task name or a state word, and none of those can be empty — the host drops the value
 * rather than recording a blank. It is also the key `groupSessions` already used for the same idea,
 * so nothing on disk changes meaning.
 */
export const UNFILED = ''

/**
 * The project key for a row whose DIRECTORY is gone and whose repository was never recorded.
 *
 * Unreachable as a real key by construction: a project key is a single path SEGMENT, and no segment
 * contains a separator. A sentinel a folder could be named would silently merge that folder's
 * sessions into this bucket.
 *
 * It is its own bucket rather than `UNFILED`'s: "no directory recorded" and "the directory is not
 * there any more" are different facts, and the second must not be grouped under the last segment of
 * a path that resolves to nothing — that is how a removed worktree became a project standing beside
 * the project it was a worktree of.
 */
export const GONE_PROJECT_KEY = '/gone'

/** Facts a `keyOf` may need that do not live on the session itself. */
export interface DimensionContext {
  /** Ids the user MARKED. Only the `marked` dimension reads it. */
  marked?: ReadonlySet<string>
}

export interface SessionDimension {
  id: SessionDimensionId
  /**
   * This row's bucket on this dimension, or `undefined` when the row has no value on it.
   *
   * Structural and string-free: the words belong to the caller, as everywhere else in the control
   * center. `dimensionValueLabel` is where a key becomes something a person reads.
   */
  keyOf(s: ControlSession, ctx: DimensionContext): string | undefined
}

/**
 * `Record<…>`, never an array literal, so the build breaks when a dimension is added and some
 * surface has not been told. Same reason as `HARNESS_SORT`, `SPAWN_SPECS` and `ATTENTION_RULES`.
 */
/**
 * A local calendar day, `YYYY-MM-DD` — PURE given the timestamp.
 *
 * LOCAL and not UTC, deliberately, and it is the opposite call from `tagSessionDay`: a tag's window
 * is a stored range compared against stored days across machines, while this is a heading over the
 * work somebody did, and at UTC-3 a session from 21:00 last night belongs under yesterday for the
 * person reading it, not under today. The two rules exist for two different questions; this file
 * answers the second.
 */
export function dayKey(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const SESSION_DIMENSIONS: Record<SessionDimensionId, SessionDimension> = {
  // Banded on `recencyOf`, the very expression the `recent` sort orders by — see its doc comment.
  // A row with no timestamp at all falls to UNFILED rather than to a guessed day.
  day: { id: 'day', keyOf: s => dayKey(recencyOf(s)) },
  // `OFF_STATE` and not `s.state`, and this is the whole of the fix for "3 desligados, wtf".
  // Collapsing the WORDS left three menu rows all reading `desligada` — which is worse than three
  // different words, because now the list offers one choice three times and nothing on screen says
  // why. The bucket has to collapse, not just its label.
  status: { id: 'status', keyOf: s => statusKey(s.state) },
  // `''` is what the registry records for a session whose harness it has forgotten, and that is an
  // absence rather than a harness called nothing.
  harness: { id: 'harness', keyOf: s => s.harness || undefined },
  model: { id: 'model', keyOf: s => s.model || undefined },
  // The PROJECT is what the work is called, which for anything in a repository is the main checkout
  // — never the worktree's own directory, or one project files as three.
  project: {
    id: 'project',
    keyOf: s => s.projectGroup || (s.dirGone ? GONE_PROJECT_KEY : s.project) || undefined,
  },
  repo: { id: 'repo', keyOf: s => s.repo || undefined },
  task: { id: 'task', keyOf: s => s.task || undefined },
  // A yes/no dimension, and the UNFILED bucket is the "no" — so "marked" reads as a band of what you
  // marked, with everything else under the name the caller gives the empty bucket.
  marked: { id: 'marked', keyOf: (s, ctx) => (ctx.marked?.has(s.id) ? 'marked' : undefined) },
}

/**
 * The dimensions in menu order.
 *
 * Derived from the table by hand-ordering its keys rather than being a second list of them: the
 * `Record` is what the build checks, and a dimension left out of this array would be one that groups
 * and filters correctly and simply never appears — which the test below refuses.
 */
export const DIMENSION_ORDER: readonly SessionDimensionId[] =
  ['day', 'status', 'repo', 'project', 'task', 'harness', 'model', 'marked'] as const

/**
 * How the list is arranged, where the arrangement is NOT one of the dimensions.
 *
 * `none` is one flat run. `tree` is the CASCADE: the project as the root and the segments of each
 * session's `cwd` below it as branches.
 *
 * Neither may become a dimension, and `tree` is the one worth stating. Every id in
 * `DIMENSION_ORDER` has a `keyOf` that grouping and filtering BOTH read, and
 * `session-dimensions.test.ts` cross-checks that filtering to one bucket returns exactly the rows
 * that bucket's band contains. A tree NODE is not a bucket: a session belongs to every node on its
 * path, so "filter to `packages`" and "the band `packages`" could never be made to agree. Declaring
 * it a dimension would either break that cross-check or force a false answer into it.
 */
export type SessionArrangementId = 'none' | 'tree'

/**
 * The arrangements that are not dimensions, in menu order. See `SessionArrangementId`.
 *
 * `tree` is deliberately ABSENT: the cascade stopped being a grouping and became a view that draws
 * inside whatever the bands are (`groupSessions`'s `cascade`), so offering it here would ask the
 * user to give up every band to see their directories. The id survives in the type because a
 * `preferences.json` written by an older build still carries it.
 */
export const ARRANGEMENTS: readonly SessionArrangementId[] = ['none'] as const

/** How the list is arranged — an arrangement, or any dimension. */
export type SessionGroupingId = SessionArrangementId | SessionDimensionId

/** The groupings in menu order — `repo` leads because it is the default arrangement's neighbour. */
export const GROUPINGS: readonly SessionGroupingId[] =
  [...ARRANGEMENTS, ...DIMENSION_ORDER] as const

/** This row's bucket, with the absence folded into its own named key — PURE. */
export function bucketKey(
  s: ControlSession,
  id: SessionDimensionId,
  ctx: DimensionContext = {},
): string {
  return SESSION_DIMENSIONS[id].keyOf(s, ctx) ?? UNFILED
}

// ---------------------------------------------------------------------------
// words — supplied by the caller, because this module owns no strings
// ---------------------------------------------------------------------------

export interface DimensionWords {
  /** The dimension's own name, for a heading. */
  label: string
  /** What this dimension's "no value" bucket is called, in words. */
  unfiled: string
  /**
   * Display names for keys that are not already their own name.
   *
   * A project, repo, model or task key IS its name and needs nothing here. A status key is a state
   * word, `marked` is a yes, and a gone directory is a sentence.
   */
  values?: Readonly<Record<string, string>>
}

/**
 * What a bucket is CALLED — PURE.
 *
 * An empty key never shares one blank heading across dimensions: "harness unknown" and "no model
 * recorded" are different facts, and a heading that reads as a category when it is really an absence
 * is how a list starts lying.
 */
export function dimensionValueLabel(words: DimensionWords, key: string): string {
  if (key === UNFILED) return words.unfiled
  return words.values?.[key] ?? key
}

/** Every dimension's words, so a caller resolves the strings once and passes one object. */
export type DimensionWordBook = Record<SessionDimensionId, DimensionWords>

/**
 * Assemble the word book from the localized pieces the caller already has — PURE.
 *
 * A `Record` in, a `Record` out: adding a dimension breaks the build here too, so it cannot ship
 * with a nameless bucket. Only the two dimensions whose keys are not already names need `values` —
 * a project, repo, model or task key IS its name.
 */
export function dimensionWordBook(w: {
  /** The dimension names, as the grouping menu already spells them. */
  labels: Record<SessionDimensionId, string>
  /** What each dimension's "no value" bucket is called, in words. */
  unfiled: Record<SessionDimensionId, string>
  /** The state words — the status dimension's keys ARE states. */
  states: Readonly<Record<string, string>>
  /**
   * What each DAY bucket is called, keyed by `YYYY-MM-DD`.
   *
   * Supplied by the caller and only for the days it wants named, because "today" and "yesterday"
   * are relative to a clock this module does not read. An unnamed day falls back to its key, which
   * is already a date a person can read — so a caller that supplies nothing is degraded, never
   * broken.
   */
  days?: Readonly<Record<string, string>>
  /** "the directory is not there any more" — its own bucket, never `project`'s absence. */
  goneProject: string
  /** What a marked row's band is called. The unmarked side is `unfiled.marked`. */
  marked: string
}): DimensionWordBook {
  const of = (id: SessionDimensionId, values?: Readonly<Record<string, string>>): DimensionWords => ({
    label: w.labels[id],
    unfiled: w.unfiled[id],
    ...(values ? { values } : {}),
  })
  return {
    day: of('day', w.days),
    status: of('status', w.states),
    harness: of('harness'),
    model: of('model'),
    project: of('project', { [GONE_PROJECT_KEY]: w.goneProject }),
    repo: of('repo'),
    task: of('task'),
    marked: of('marked', { marked: w.marked }),
  }
}

// ---------------------------------------------------------------------------
// the filter
// ---------------------------------------------------------------------------

/**
 * What the list is narrowed to, per dimension.
 *
 * A dimension with no entry, or an empty one, is NOT filtered — absent is "no opinion", never "keep
 * nothing". Dimensions combine with AND; the values inside one combine with OR, which is the only
 * reading that makes a multi-select mean anything.
 *
 * Stored by dimension ID and by VALUE, never positionally: an index records "the third dimension"
 * and becomes a different question the moment someone reorders the list.
 */
export type SessionFilters = Partial<Record<SessionDimensionId, readonly string[]>>

/**
 * Does this row survive the filters — PURE.
 *
 * `showNamed` widens the STATUS dimension and nothing else. See the module header for why it may not
 * be general.
 */
export function sessionKept(
  s: ControlSession,
  o: { filters: SessionFilters; showNamed?: boolean; ctx?: DimensionContext },
): boolean {
  const ctx = o.ctx ?? {}
  for (const id of DIMENSION_ORDER) {
    const selected = o.filters[id]
    if (!selected || selected.length === 0) continue
    if (selected.includes(bucketKey(s, id, ctx))) continue
    if (id === 'status' && o.showNamed && sessionNamed(s)) continue
    return false
  }
  return true
}

/**
 * Add or remove one value from a dimension's selection — PURE.
 *
 * **Emptying a selection is refused**, and the refusal is a no-op rather than an error: unticking the
 * last box never means "show nothing at all", it means the person has run out of boxes. The rule
 * lived as a comment in the component; it lives here now, once, where both the keyboard and the
 * mouse path reach it.
 */
export function toggleValue(
  selected: readonly string[],
  value: string,
): string[] {
  if (!selected.includes(value)) return [...selected, value]
  if (selected.length === 1) return [...selected]
  return selected.filter(v => v !== value)
}

// ---------------------------------------------------------------------------
// the status shortcuts — a coarse vocabulary for the same selection
// ---------------------------------------------------------------------------

export type StatusShortcut = 'active' | 'history'

/**
 * Which states each shortcut names. `Record`, so a new shortcut cannot be half-declared.
 *
 * **There were three, and two of them asked the same question.** `closed` named a conversation that
 * is not running; `exited` named a session that finished, plus `lost`, a session the backend can no
 * longer find. Internally those differ and the difference matters — they carry different verbs, and
 * `lost` is a fact about the backend rather than about the work. But from the chair of the person
 * reading the screen all three answer *it is not running*, so the list offered one question twice:
 * ticking either while the other was on appeared to do nothing, which is a control that lies.
 *
 * The vocabulary is now the honest pair — what is RUNNING and what is not. The states keep their
 * distinction and each row still shows its own; it is the FILTER that stopped pretending two
 * switches were two questions.
 */
export const SHORTCUT_STATES: Record<StatusShortcut, readonly SessionState[]> = {
  active: ACTIVE_STATES,
  history: ['closed', 'exited', 'lost'],
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every(v => b.includes(v))

/**
 * Is this shortcut ON — READ OUT of the selection, never stored beside it — PURE.
 *
 * `active` is the strict one and reads on only when the selection is EXACTLY the active states:
 * anything wider is a list it no longer describes, and a switch lit over a list it does not describe
 * is the whole defect this replaces.
 */
export function shortcutOn(selected: readonly string[], shortcut: StatusShortcut): boolean {
  if (shortcut === 'active') return sameSet(selected, ACTIVE_STATES)
  return SHORTCUT_STATES[shortcut].every(v => selected.includes(v))
}

/**
 * Press a shortcut — PURE.
 *
 * `active` is not a membership toggle: on, it NARROWS to exactly the active states; off, it widens to
 * everything, because "not only active" has no other meaning. The other two toggle the states they
 * name, together.
 *
 * Never returns an empty selection, for the same reason `toggleValue` does not.
 */
export function applyShortcut(
  selected: readonly string[],
  shortcut: StatusShortcut,
): string[] {
  if (shortcut === 'active') {
    return shortcutOn(selected, 'active') ? [...SESSION_STATES] : [...ACTIVE_STATES]
  }
  const states = SHORTCUT_STATES[shortcut]
  if (shortcutOn(selected, shortcut)) {
    const next = selected.filter(v => !states.includes(v as SessionState))
    return next.length > 0 ? next : [...selected]
  }
  return [...selected, ...states.filter(v => !selected.includes(v))]
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

/**
 * Marks a `filters` written under this model.
 *
 * The approved filters design called this `statesVersion` when status was the only dimension it
 * covered; it is the same gate, generalised, and there is deliberately only ONE stored source for
 * every dimension — a second one is how the two controls came to disagree in the first place.
 */
export const FILTERS_VERSION = 2

export interface SessionFilterState {
  filters: SessionFilters
  showNamed: boolean
  /**
   * The session ids the user MARKED, so a row can be found again without searching for it.
   *
   * Persisted here with the filters rather than beside them, because the bug it fixes was exactly a
   * hand-written persist: the component wrote `...(marked.size > 0 ? { marked: [...marked] } : {})`,
   * so UNMARKING EVERYTHING removed the key instead of writing an empty list — and the next restore
   * read absence, fell back to whatever was stored before, and resurrected marks the user had just
   * cleared. A conditional spread cannot express "the answer is nothing".
   *
   * So this is always written and always read, and the empty set is a value. `session-dimensions.
   * test.ts` round-trips it INCLUDING empty, which is the case that was broken.
   */
  marked: string[]
}

/**
 * How the list opens on a machine that has never chosen: ONLY ACTIVE conversations, strictly.
 *
 * The filter half of `DEFAULT_SESSION_VIEW`, which imports it — so the default arrangement is
 * DERIVED from the status vocabulary rather than written out beside it. A hand-copied list of the
 * active states in the defaults would be the same two-lists-of-one-fact defect this module exists to
 * remove, one file over.
 */
export const DEFAULT_FILTERS: SessionFilters = { status: [...ACTIVE_STATES] }

/**
 * The named-row exception ships OFF, so the status selection applies to everyone.
 *
 * On, it is still the right behaviour for a machine with months of named work — it is what stops a
 * reboot emptying the list. It is off because it used to be UNWRITTEN: a strict filter kept rows it
 * did not name, and the screen said "only active" over 62 of 65 sessions.
 */
export const DEFAULT_SHOW_NAMED = false

/**
 * Nothing is marked on a machine that has never chosen — an empty LIST, never `undefined`.
 *
 * Stated here so absence has one meaning. It is the half of the round-trip that was missing: with
 * no default, "no marks" and "not loaded yet" were the same value.
 */
export const DEFAULT_MARKED: string[] = []

const knownStates = (values: readonly string[]): string[] =>
  values.filter(v => (SESSION_STATES as readonly string[]).includes(v))

/**
 * What the stored preferences mean under this model — PURE and idempotent.
 *
 * Two paths, and the second one deliberately DISCARDS a stored `states`:
 *
 *  1. `filtersVersion === FILTERS_VERSION` — the file was written by this model; read it.
 *  2. Otherwise the SWITCHES win. A stored `states` could only ever have been written while it
 *     silently overrode the switches beside it, so the user never saw the two evaluated together and
 *     it is not a statement they could have judged. The switches are what they last set and last
 *     saw. On the reporting machine this yields exactly the active states, which is the list they
 *     were asking for.
 *
 * `showUnfiled` is dropped rather than converted. It hid task-less rows while grouping by task, and
 * the faithful translation — an allowlist of every task that existed at migration time — would
 * freeze that list forever, so a task created tomorrow would be invisible under a rule nobody wrote.
 * It is a widening the user can see and re-apply in one click, on the task dimension, where it is now
 * one bucket among the others.
 */
export function migrateSessionFilters(
  prefs: Partial<SessionViewPrefs> | undefined,
): SessionFilterState {
  const p = prefs ?? {}
  const showNamed = p.showNamed ?? DEFAULT_SHOW_NAMED
  const marked = [...(p.marked ?? DEFAULT_MARKED)]

  if (p.filtersVersion === FILTERS_VERSION && p.filters) {
    const filters: SessionFilters = {}
    for (const id of DIMENSION_ORDER) {
      const values = p.filters[id]
      if (!values || values.length === 0) continue
      filters[id] = id === 'status' ? knownStates(values) : [...values]
    }
    // A status selection that survived nothing recognisable is not a filter, it is a list that shows
    // nothing — and the never-empty rule applies to a file just as it applies to a keypress.
    if (!filters.status || filters.status.length === 0) filters.status = [...ACTIVE_STATES]
    return { filters, showNamed, marked }
  }

  // Absent switches read as the default arrangement's own answer: only active. Stated as a literal
  // here rather than read off `DEFAULT_SESSION_VIEW`, which is now DERIVED from this module and
  // cannot be imported back without a value cycle.
  if (p.onlyActive ?? true) return { filters: { status: [...ACTIVE_STATES] }, showNamed, marked }

  // The two legacy switches migrate through the SAME bucket the rest of the module uses. They were
  // independent — `showClosed` for conversations, `showExited` for finished and lost sessions — and
  // the bucket is now one, so EITHER of them on means history is shown. Mapping only one of the two
  // would leave a stored `showExited: true` filtering for states that no longer key to themselves,
  // and the rows it was meant to reveal would vanish instead.
  const status = [...ACTIVE_STATES]
  if (p.showClosed || p.showExited) status.push(OFF_STATE)
  return { filters: { status }, showNamed, marked }
}

/**
 * The stored shape for a filter state — including the fields only an OLDER binary reads.
 *
 * `states` / `onlyActive` / `showClosed` / `showExited` are DERIVED ON WRITE and never read back by
 * current code except by the migration above. Same pattern, and the same reason, as `deniedRepos` in
 * the sharing rules: a machine that downgrades must not come up with every filter lifted.
 */
export function storedFilters(state: SessionFilterState): Partial<SessionViewPrefs> {
  const status = state.filters.status ?? [...ACTIVE_STATES]
  const filters: Record<string, string[]> = {}
  for (const id of DIMENSION_ORDER) {
    const values = state.filters[id]
    if (values && values.length > 0) filters[id] = [...values]
  }
  return {
    filtersVersion: FILTERS_VERSION,
    filters,
    showNamed: state.showNamed,
    // ALWAYS written, empty list included — see `SessionFilterState.marked`.
    marked: [...state.marked],
    states: [...status],
    onlyActive: shortcutOn(status, 'active'),
    // Both legacy switches are derived from the ONE that replaced them. An older binary reading
    // this file gets them lifted or lowered together, which is what `history` means there too —
    // and is strictly better than a downgrade that comes up with half the history hidden.
    showClosed: shortcutOn(status, 'history'),
    showExited: shortcutOn(status, 'history'),
  }
}
