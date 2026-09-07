/**
 * sessions.ts — PURE arithmetic for the sessions screen: its row budget, its cells, its grouping
 * and its counter.
 *
 * Split out for the same reason `chrome.ts` and `surface.ts` are: a row that is one column too wide
 * wraps and shears every row under it, and a screen that draws more rows than its `height` is
 * COMPOSITED by Ink rather than clipped — both read as a corrupted frame rather than as a cramped
 * one, and neither is visible in a screenshot of a wide terminal.
 */

import { PANE_FRAME_Y } from './chrome.ts'
import type { ControlStrings } from './i18n'
import { matchesQuery, matchScopes, scopeCounts, type ScopeCounts, type SearchScope } from './search-scope'
import {
  ACTIVE_STATES, OFF_STATE, GROUPINGS, SESSION_STATES, SESSION_STATE_CHOICES, SESSION_DIMENSIONS,
  UNFILED,
  bucketKey, dimensionValueLabel, sessionNamed, sessionRunning,
  type DimensionContext, type DimensionWordBook, type SessionDimensionId, type SessionGroupingId,
} from './session-dimensions'
import {
  DEFAULT_ORDER, SESSION_SORTS, sessionRank, sortSessions,
  type SessionOrder, type SessionSort,
} from './session-order'
import { buildSessionTree } from './session-tree'
// `.ts` explicitly: `Surface.tsx` sits beside `surface.ts` and a bare specifier resolves to the
// component on a case-insensitive path, exactly as `chrome.ts` is imported above.
import { wrapText } from './surface.ts'
import type { ControlSession, SessionState } from './types'

// The SEMANTICS moved to `session-fleet.ts` and `session-verbs.ts` so the web bundle can import
// them without resolving Ink; this module kept the terminal GEOMETRY. Re-exported here because
// this is the module the rest of the control center imports from, and moving a name is not a
// reason to touch fourteen files.
// ...and imported back, for the geometry below that still measures them. A re-export does not
// put a name in this module's own scope.
import { contextLevel, sessionAge, sessionHandle, sessionNotify, sessionRows, worktreeName, type ContextLevel, type SessionGrouping, type SessionRow } from './session-fleet'
import { actionWords, type OfferedAction, type SessionAction } from './session-verbs'

export * from './session-fleet'
export * from './session-verbs'

export interface SessionCells {
  /** Always present — the state is the one cell nothing else on the screen repeats. */
  state: string
  /** Dropped first under width pressure. */
  title: string
  harness: string
  /** Dropped second. */
  where: string
}

const GAP = 2

/**
 * Fit one row to `width`, giving up cells in the order the screen can afford to lose them.
 *
 * The STATE word is the last thing standing, mirroring `serviceCells`: the harness is said again by
 * the row's colour and by the detail pane, the directory is said by the detail pane, but nothing
 * else on the frame says whether this session is waiting for you. A row reduced to a coloured glyph
 * announces the one thing that matters in colour alone, which is exactly what this model exists to
 * prevent.
 */
export function sessionCells(s: ControlSession, width: number): SessionCells {
  const state = s.stateLabel
  const full: SessionCells = { state, title: s.title, harness: s.harness, where: s.project }

  if (rowWidth(full) <= width) return full

  const noWhere: SessionCells = { ...full, where: '' }
  if (rowWidth(noWhere) <= width) return noWhere

  const noHarness: SessionCells = { ...noWhere, harness: '' }
  if (rowWidth(noHarness) <= width) return noHarness

  // The title is given up LAST among the droppable cells, and truncated rather than dropped whole
  // while any room remains: a row with no name is unusable, a row with a shortened one is not.
  const room = Math.max(0, width - state.length - GAP)
  return { state, harness: '', where: '', title: room > 0 ? truncateCell(s.title, room) : '' }
}

export function rowWidth(c: SessionCells): number {
  const parts = [c.state, c.title, c.harness, c.where].filter(p => p !== '')
  if (parts.length === 0) return 0
  return parts.reduce((n, p) => n + p.length, 0) + GAP * (parts.length - 1)
}

function truncateCell(text: string, width: number): string {
  if (text.length <= width) return text
  if (width <= 1) return text.slice(0, width)
  return text.slice(0, width - 1) + '…'
}

// ---------------------------------------------------------------------------
// the screen's budget
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// the detail pane's content
// ---------------------------------------------------------------------------

/**
 * The rows a QUESTION needs, floor.
 *
 * A confirmation is a wrapped sentence, a blank and two answers; anything less hides one of the
 * answers, which is worse than not asking — the user is looking at a destructive verb with only the
 * word "Yes" on screen. The cockpit reserves its own `QUESTION_ROWS` for exactly this reason.
 */
export const QUESTION_ROWS = 5

/**
 * The most of a blocked session's dialog a confirmation will show.
 *
 * Six lines carries a question, three options and the footer naming the key — measured against the
 * frames `attention-rules.ts` was probed from. It is a CAP rather than a size: a shorter dialog
 * shows whole, and the pane asks for only what it has.
 */
export const APPROVAL_PREVIEW_MAX = 6

/**
 * The dialog cut to the rows there are — from the TOP, so the BOTTOM survives — PURE.
 *
 * The bottom is where the options are, where the highlight is, and where the footer names the key.
 * That is the part being answered; the lines above it are the context that led there, and context is
 * what a short pane can afford to lose. Cutting the other way round would leave a question with its
 * answers off screen, which is the one thing a confirmation may not do.
 */
export function fitApprovalPreview(lines: readonly string[], rows: number): string[] {
  const keep = Math.max(0, Math.min(rows, APPROVAL_PREVIEW_MAX))
  return lines.slice(Math.max(0, lines.length - keep))
}

/**
 * How many rows the detail region must be given for the question that is open — PURE.
 *
 * A question ALWAYS outranks the facts: a prompt with nowhere to draw cannot be answered, which is
 * why `QUESTION_ROWS` is the floor. What is new here is that one question carries evidence — the
 * dialog a person has to read before agreeing — and those rows have to be BUDGETED rather than
 * drawn on top of the answers. Ink composites what does not fit, so an unbudgeted preview does not
 * crowd the two answers, it draws over whatever was under them.
 *
 * `+ 1` for the row that LABELS the evidence. It is not decoration: the dialog being quoted has its
 * own numbered options, the confirmation under it has two of its own, and without a line saying
 * which is which the pane is two menus stacked on top of each other.
 */
export function askRows(o: { preview: number; detail: number; choices?: number }): number {
  const preview = Math.max(0, Math.min(o.preview, APPROVAL_PREVIEW_MAX))
  // A picker draws one row per option instead of the two a yes/no carries, and it is budgeted for
  // the same reason the evidence is: Ink composites what does not fit, so an unbudgeted list does
  // not scroll, it draws over whatever is under the pane. `QUESTION_ROWS` stays the floor — a
  // two-option dialog must not end up with less room than a confirmation would have had.
  const choices = Math.max(0, o.choices ?? 0)
  const body = choices > 1 ? Math.max(QUESTION_ROWS, choices) : QUESTION_ROWS
  return Math.max(body + (preview > 0 ? preview + 1 : 0), Math.max(0, o.detail))
}


// ---------------------------------------------------------------------------
// the visible action row
// ---------------------------------------------------------------------------

/**
 * The summary row's two halves, fitted to `width` — PURE.
 *
 * It has to be MEASURED, not merely truncated. A row wider than the terminal wraps, and a wrapped
 * row takes two of the screen's rows while its budget counted one — which pushes the action row,
 * the detail pane and the footer off the bottom. "Everything below the list vanished" is what that
 * looks like, and nothing about it says the cause was one row too wide.
 *
 * Cells are given up in the order the row can afford to lose them: the list of what is being HIDDEN
 * first (the panel one keypress away states it in full), then the waiting count, then the total,
 * then the fall. The grouping is last because it is the only cell that explains why the rows are
 * arranged as they are, and it is truncated rather than dropped.
 *
 * The FALL outlives the other three because it is the only cell that is an OFFER: the rest describe
 * the list, and this one names work that is one keypress from coming back. It is also the only cell
 * that is usually absent, so it costs nothing on an ordinary machine.
 */
export function summaryCells(o: {
  group: string
  hiding: string
  count: string
  waiting: string
  /** "N sessions fell X ago — R reopens them", or `''` when nothing did. */
  fell?: string
  width: number
}): { group: string; hiding: string; count: string; waiting: string; fell: string } {
  const GAP = 3
  const width = Math.max(0, o.width)
  const fits = (parts: string[]) => {
    const kept = parts.filter(p => p !== '')
    return kept.reduce((n, p) => n + p.length, 0) + GAP * Math.max(0, kept.length - 1) <= width
  }

  const fell = o.fell ?? ''
  const full = { group: o.group, hiding: o.hiding, count: o.count, waiting: o.waiting, fell }
  if (fits([full.group, full.hiding, full.count, full.waiting, full.fell])) return full

  const noHiding = { ...full, hiding: '' }
  if (fits([noHiding.group, noHiding.count, noHiding.waiting, noHiding.fell])) return noHiding

  const noWaiting = { ...noHiding, waiting: '' }
  if (fits([noWaiting.group, noWaiting.count, noWaiting.fell])) return noWaiting

  const noCount = { ...noWaiting, count: '' }
  if (fits([noCount.group, noCount.fell])) return noCount

  const groupOnly = { group: o.group, hiding: '', count: '', waiting: '', fell: '' }
  if (fits([groupOnly.group])) return groupOnly

  return { ...groupOnly, group: o.group.slice(0, Math.max(0, width)) }
}

// ---------------------------------------------------------------------------
// column alignment
// ---------------------------------------------------------------------------

export interface SessionColumns {
  /**
   * The first few characters of the session id.
   *
   * It is the HANDLE: `agentop session attach 3f5f` takes a prefix, so the row that shows one is
   * the row you can act on from another terminal. Fixed width and always drawn — it is five columns
   * and it is the only thing on the screen that names the session to anything but this screen.
   */
  id: number
  state: number
  title: number
  /**
   * The task the session is filed under.
   *
   * `0` when nothing on screen carries one, and `0` while GROUPING BY TASK — there the heading over
   * the row already says it, and repeating it on every row under that heading is a column of the
   * same word. Everywhere else it must be on the row: filing a session under a task and then not
   * being able to see which task it is in is the feature not working.
   */
  task: number
  /**
   * How long ago it started, for a row that is NOT running.
   *
   * On the row rather than only in the detail pane, and only for what is down, because that is the
   * one place it decides something: a live session's age is idle curiosity, while "reopen this or
   * not" is mostly a question about how old it is. A running row spends the column on nothing.
   */
  age: number
  /**
   * The worktree's own folder name. `0` when no row on screen is one — never a column of blanks.
   *
   * The NAME rather than the word "worktree": with the list grouped by project, the heading already
   * says which project and the folder cell says the same, so a cell repeating "worktree" on every
   * row told you the kind and never which one. Three checkouts of one repository are told apart by
   * exactly this.
   */
  worktree: number
  /** Tokens + cost. `0` when nothing on screen has any — never a column of blanks. */
  metrics: number
  /**
   * The context gauge — bar plus percentage. `0` when no row on screen has a reading.
   *
   * It outlives `metrics` under width pressure, which is the one ordering decision here worth
   * stating: tokens and cost are a record of what a session HAS spent, while this is the only cell
   * that says what it can still do. On a narrow terminal the question people are answering is
   * "which of these do I need to deal with", and a session about to run out of window is the
   * answer to it.
   */
  context: number
  harness: number
  where: number
}

/**
 * The NOTIFICATION cell: a dot at the head of a row that is waiting on a person.
 *
 * The state word already says it and is four columns in from the left, among five other words; what
 * a fleet needs is something readable without reading — the same job the header's `⏳ 2` does for
 * the whole machine, done per row. It is a dot AND a word, never a dot alone: a distinction
 * announced only in a glyph has to be taught before the screen can be read.
 *
 * Its own cell rather than the cursor's or the mark's, because all three can be true at once — the
 * row you are on, the row you marked, and the row that needs you are three different facts.
 */
export const NOTIFY_CELL = 2

/**
 * What the notification cell costs on THIS screen — zero when nothing is waiting.
 *
 * The same rule every other cell here follows: a column nothing on screen carries is not drawn and
 * does not narrow the title to reserve a space nothing occupies.
 */
export function notifyCellWidth(rows: readonly ControlSession[]): number {
  return rows.some(sessionNotify) ? NOTIFY_CELL : 0
}

/**
 * Tokens and cost as ONE cell — PURE, and EMPTY when the conversation recorded neither.
 *
 * Empty rather than a zero, for the same reason the detail pane omits the line: a harness that
 * cannot report usage would otherwise show every one of its sessions costing nothing, which is a
 * confident wrong number in the place a person looks to decide what to close.
 */
export function sessionMetric(s: ControlSession): string {
  return [s.tokens, s.cost].filter(Boolean).join(' ')
}

// ---------------------------------------------------------------------------
// the context gauge
// ---------------------------------------------------------------------------

/**
 * Columns the bar itself takes, label excluded.
 *
 * Six, because the bar's job on a row is a GLANCE — nearly empty, half, nearly full — and six cells
 * resolve that to within a sixth. Anything finer is a number, and the number is already printed
 * beside it. Anything coarser stops being a shape.
 */
export const CONTEXT_BAR = 6

/** The filled/empty bar for a fraction — PURE, and SATURATED at both ends.
 *
 *  Saturation is the whole point of drawing this separately from the label: a session really can
 *  exceed the window this reading was computed against, and a bar allowed to overflow would draw
 *  past its own cell and shear every row under it — the exact failure the pure-layout rule exists
 *  to prevent. So the BAR pins at full and the LABEL keeps telling the truth (`106%`), which is the
 *  only division of labour where neither half lies. */
export function contextBar(fraction: number, width: number = CONTEXT_BAR): string {
  const w = Math.max(0, Math.floor(width))
  if (w === 0) return ''
  const safe = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0
  // Rounded DOWN, mirroring the label: a bar showing full while the label says 99% is one of them
  // being wrong, and it would be the bar — the shape is what gets believed at a glance.
  const filled = Math.min(w, Math.floor(safe * w))
  return '█'.repeat(filled) + '░'.repeat(w - filled)
}

/** The whole cell — bar, a space, then the percentage. `''` when this row has no reading. */
export function sessionContext(s: ControlSession, width: number = CONTEXT_BAR): string {
  if (!s.context) return ''
  return `${contextBar(s.context.fraction, width)} ${s.context.label}`
}

/**
 * The column widths for a screenful of rows — PURE.
 *
 * Computed ACROSS the visible rows rather than per row, which is the whole point: the state words
 * have very different lengths ("needs approval" against "waiting"), so a row that merely separates
 * its cells with two spaces starts every title at a different column and every harness after that.
 * The result reads as a jumble of words rather than as a list of sessions.
 *
 * Widths come from what is on screen, not from the whole fleet: a single long title thirty rows
 * down must not narrow every visible row to pay for something nobody can see.
 *
 * The give-up order is unchanged — the directory goes first, then the harness, then the title is
 * squeezed — because the STATE is the one cell nothing else on the frame repeats.
 */
export function sessionColumns(
  rows: readonly ControlSession[],
  width: number,
  o: {
    /** True while the HEADING above each row already names the task, so the cell would repeat it. */
    groupedByTask?: boolean
    /**
     * The same rule for the PROJECT cell, and it was missing: grouped by project, every row of a
     * band ended in the very word the heading over it had just said, in the widest cell on the
     * right-hand side. The cell exists for the arrangements that do NOT say it (`none`, by state,
     * by harness), which is exactly when it is the only thing naming where a session is.
     */
    groupedByProject?: boolean
    /** Already-localized age per row, keyed by session id — see `sessionAge`. */
    ages?: ReadonlyMap<string, string>
    /**
     * The column HEADINGS, when a header row is being drawn.
     *
     * Measured as content of their own columns, because they are: a heading wider than the column
     * under it is truncated, and a truncated heading sits over a cell it no longer names. Passed
     * only when the header is actually drawn — a pane too short for one must not pay for words
     * nobody is going to see.
     */
    headings?: Partial<Record<keyof SessionColumns, string>>
  } = {},
): SessionColumns {
  const head = (key: keyof SessionColumns) => (o.headings?.[key] ?? '').length
  // A column that draws nothing stays at zero: the heading is only content of a column that exists.
  const widest = (key: keyof SessionColumns, pick: (s: ControlSession) => string) => {
    const data = rows.reduce((n, s) => Math.max(n, pick(s).length), 0)
    return data === 0 ? 0 : Math.max(data, head(key))
  }

  const id = widest('id', sessionHandle)
  const state = widest('state', s => s.stateLabel)
  const title = widest('title', s => s.title)

  /**
   * The droppable cells, in the order the screen gives them up — least important FIRST.
   *
   * Named rather than positional. This used to be a list of six-number tuples fed to a six-argument
   * `overhead(a, wt, k, m, h, w)`, which was already at the limit of what can be read; the context
   * gauge would have made it seven, where a transposed pair is invisible in review and shows up as
   * a column of the wrong width on somebody's terminal.
   *
   * The order itself: the directory first (the heading usually says it), then the harness (the
   * row's colour says it), then tokens and cost, then the gauge, then the task, the worktree, and
   * finally the age. The STATE and the NAME are not in this list at all — they are what a row
   * cannot lose, the state because nothing else on the frame says whether this session is waiting
   * for you, the name because a row you cannot identify is not a row you can act on.
   */
  const droppable = [
    // The PROJECT, not the directory: once the grouping keys on the main checkout, a folder cell
    // showing the worktree's own name says something the worktree cell already says better.
    ['where', o.groupedByProject ? 0 : widest('where', s => s.projectGroup || s.project)],
    ['harness', widest('harness', s => s.harness)],
    ['metrics', widest('metrics', sessionMetric)],
    ['context', widest('context', s => sessionContext(s))],
    ['task', o.groupedByTask ? 0 : widest('task', s => s.task ?? '')],
    ['worktree', widest('worktree', worktreeName)],
    ['age', widest('age', s => o.ages?.get(s.id) ?? '')],
  ] as const satisfies ReadonlyArray<readonly [keyof SessionColumns, number]>

  /**
   * Columns everything BUT the title costs: two for the cursor, the cells, and a gap between each
   * pair of cells that is actually drawn.
   *
   * Counted from the cells rather than from a constant because a cell can be ZERO — a fleet where
   * no session reports usage draws no metrics column, and paying its gap anyway would narrow every
   * title on the screen to reserve a space nothing occupies.
   */
  const overhead = (cells: Partial<Record<keyof SessionColumns, number>>) => {
    const values = Object.values(cells).filter((n): n is number => n !== undefined)
    const sum = values.reduce((n, v) => n + v, 0)
    // `1` stands in for the title, which is always drawn and so always pays its own gap.
    const drawn = [id, state, 1, ...values].filter(n => n > 0).length
    return 2 + notifyCellWidth(rows) + id + state + sum + GAP * (drawn - 1)
  }

  // The fewest columns a title is worth. Below it the row has a state word and an ellipsis, which
  // names nothing — so the screen gives up a whole cell instead.
  const MIN_TITLE = 8

  const kept = new Map<keyof SessionColumns, number>(droppable)
  const finish = (room: number): SessionColumns => ({
    id, state, title: Math.max(1, Math.min(title, room)),
    where: kept.get('where') ?? 0,
    harness: kept.get('harness') ?? 0,
    metrics: kept.get('metrics') ?? 0,
    context: kept.get('context') ?? 0,
    task: kept.get('task') ?? 0,
    worktree: kept.get('worktree') ?? 0,
    age: kept.get('age') ?? 0,
  })

  // One pass more than there are droppable cells: the first tries them all, the last tries none.
  for (let i = 0; i <= droppable.length; i++) {
    const room = width - overhead(Object.fromEntries(kept))
    // The title takes what it NEEDS, not what is left: stretching it to the full remainder pushed
    // the trailing cells to the far edge with a field of blank between, which is the old
    // misalignment wearing a different shape.
    if (room >= MIN_TITLE || kept.size === 0) return finish(room)
    kept.delete(droppable[i]![0])
  }
  /* c8 ignore next 2 */
  return finish(width - overhead({}))
}

/** Pad or truncate a cell to exactly `w` columns. `0` means the column is not drawn. */
export function padCell(text: string, w: number): string {
  if (w <= 0) return ''
  return text.length >= w ? truncateCell(text, w) : text + ' '.repeat(w - text.length)
}

// ---------------------------------------------------------------------------
// the cockpit: an aside menu beside the list, over a detail pane
// ---------------------------------------------------------------------------

export interface CockpitLayout {
  /** Columns the aside menu takes. `0` when the terminal is too narrow to carry one. */
  aside: number
  /** Columns the list takes — everything the aside leaves, minus the gap between them. */
  list: number
  /** Rows the list band gets, FRAME INCLUDED — every region here is a framed pane. */
  band: number
  /** Rows the detail pane gets under it, or 0 when the screen cannot pay for one. */
  detail: number
  /** Whether the summary row above the sessions fits INSIDE the list pane. */
  summary: boolean
  /** Whether the column-header row fits under it. */
  header: boolean
  /** Rows for session rows inside the list pane, frame and summary already paid for. */
  listRows: number
}

/** The aside's natural width: wide enough for its longest label, within bounds. */
const ASIDE_MIN = 18

const ASIDE_MAX = 34

/** Below this the screen is all list — an aside that squeezes the sessions to nothing helps nobody. */
const ASIDE_NEEDS = 52

/** The fewest rows a detail pane is worth: a divider plus something to say. */
const COCKPIT_DETAIL_MIN = 4

/**
 * Split the screen into an aside menu, the list beside it, and a detail pane under both.
 *
 * The aside exists because everything on this screen used to be a letter: the grouping cycled on a
 * hidden `v`, the visibility switches were a corner label, and the verbs only appeared once you
 * knew `tab` reached them. A menu you can see and click is not a nicety here, it is the difference
 * between a screen you can use and one you have to be taught.
 *
 * It is DROPPED on a narrow terminal rather than squeezed: at 40 columns an aside leaves nothing for
 * the sessions, and the sessions are what the screen is. The letters keep working, so a narrow
 * terminal loses the menu and not the feature.
 *
 * The detail pane is reserved BEFORE the band on a short screen, the same rule the services cockpit
 * follows — it is where a question is asked, and a prompt with nowhere to draw cannot be answered.
 */
export function sessionsCockpit(o: {
  width: number
  height: number
  /** The widest label the aside must carry, so it is measured rather than guessed at. */
  asideLabel: number
  /** Rows the detail pane is asking for, `0` when there is nothing selected to describe. */
  detailWanted: number
  /** Folded away by the user — the list takes the whole width, whatever it would have fitted. */
  hideAside?: boolean
}): CockpitLayout {
  const width = Math.max(1, o.width)
  const height = Math.max(1, o.height)

  const aside = o.hideAside ? 0 : width >= ASIDE_NEEDS
    // `+ 4` rather than `+ 2`: the rows carry a cursor, a state dot and — for a task or a project —
    // a trailing count, and sizing to the label alone truncated every long verb in the menu.
    ? Math.min(ASIDE_MAX, Math.max(ASIDE_MIN, o.asideLabel + 4))
    : 0
  // One column of divider between the two panes, and only when there are two.
  const list = Math.max(1, width - (aside > 0 ? aside + 1 : 0))

  // Every region is a FRAMED pane now, so the frame is part of the arithmetic rather than something
  // the component pays for out of rows this function already handed to content. A screen whose
  // budget and whose frames are decided in two places is one where they disagree by two rows, and
  // Ink composites the overflow rather than clipping it — which reads as a corrupted frame.
  const finish = (band: number, detail: number): CockpitLayout => {
    const inner = Math.max(0, band - PANE_FRAME_Y)
    // The summary is the first thing given up: it describes the list, and a list with no rows left
    // has nothing to describe.
    const summary = inner >= 5
    // The column HEADER is the row that says what each cell is. It is given up before the summary,
    // because the summary states what is being withheld from the list — a filter you cannot see is
    // a list lying about its length, while an unlabelled column is merely one you have to learn.
    const header = inner >= 4
    const spent = (summary ? 1 : 0) + (header ? 1 : 0)
    return { aside, list, band, detail, summary, header, listRows: Math.max(1, inner - spent) }
  }

  if (height <= COCKPIT_DETAIL_MIN + 2 || o.detailWanted <= 0) return finish(height, 0)
  // `+ PANE_FRAME_Y`: what the pane asks for is its LINES, and the frame around them is this
  // function's to pay.
  const detail = Math.min(
    o.detailWanted + PANE_FRAME_Y,
    Math.max(COCKPIT_DETAIL_MIN, Math.floor(height / 2)),
  )
  return finish(height - detail, detail)
}

// ---------------------------------------------------------------------------
// the aside menu's rows
// ---------------------------------------------------------------------------

/** What an aside row DOES. `heading` and `rule` are not selectable. */
export type AsideRow =
  | { kind: 'heading'; label: string }
  | { kind: 'rule' }
  | { kind: 'action'; action: SessionAction; label: string; enabled: boolean }
  | { kind: 'group'; value: SessionGrouping; label: string; on: boolean }
  /** One LAYOUT the list can be drawn in, and whether it is the one in force. */
  | { kind: 'layout'; value: SessionLayout; label: string; on: boolean }
  | { kind: 'toggle'; toggle: SessionToggle; label: string; on: boolean }
  /**
   * One task, with how many sessions are filed under it.
   *
   * `all` marks the "every task" row — `name: ''` cannot, now that the UNFILED bucket is a real
   * selectable value whose key is also `''`. Two different rows had one identity, and clicking
   * "no task" cleared the scope instead of selecting it.
   */
  | {
      kind: 'task'
      name: string
      /**
       * What the row is CALLED, decided here rather than rebuilt by the renderer.
       *
       * The renderer used to draw `name || allLabel`, which collapsed two different rows the moment
       * the UNFILED bucket became selectable: "every task" and "no task" both carry `name: ''`, so
       * the menu listed "every task" twice and one of them scoped to something else.
       */
      label: string
      count: number
      on: boolean
      done?: boolean
      all?: boolean
    }
  /** One project directory, with its session count. `name: ''` is "every project". */
  | { kind: 'project'; name: string; count: number; on: boolean }
  /** One STATE the list may keep, with how many rows wear it. */
  | { kind: 'state'; value: SessionState; label: string; count: number; on: boolean }
  /** One ordering, and whether it is the one in force. */
  | { kind: 'sort'; value: SessionSort; label: string; on: boolean; dir: 'asc' | 'desc' }

/**
 * The switches in the SHOW block.
 *
 * `unfiled` is gone: it hid the task-less band, but only while grouping BY task, and only for that
 * one dimension. Every dimension now has a selectable "no value" bucket, so the switch was a hidden
 * special case of a control that exists in the open.
 *
 * `named` replaces it, and is the opposite kind of change — it makes an EXISTING hidden behaviour
 * visible. A row the user named used to survive the history switches unconditionally, unwritten.
 */
/**
 * The switches the menu draws.
 *
 * `closed` and `exited` were two of these and asked ONE question — "is it not running" — so ticking
 * either while the other was on appeared to do nothing. They are now `history`.
 */
export type SessionToggle = 'history' | 'named' | 'done' | 'active' | 'detail' | 'cascade'

/**
 * The aside's rows, in reading order — PURE, so what is drawn and what a click resolves against are
 * one answer.
 *
 * Actions first because they are what a person came to do; the view switches under them because they
 * are set once and then left alone. Every row states its own state: a menu that shows only a cursor
 * makes you press things to find out what they already were.
 */
export function asideRows(o: {
  actions: readonly OfferedAction[]
  actionWords: Record<SessionAction, string>
  grouping: SessionGrouping
  groupWords: Record<SessionGrouping, string>
  /**
   * The layout block.
   *
   * Its own section rather than two more rows among the groupings: "list or cards" and "grouped by
   * what" are different questions, and six grouping rows with two unlike ones among them is a menu
   * nobody reads correctly.
   */
  layout: { heading: string; words: Record<SessionLayout, string>; value: SessionLayout }
  toggles: Record<SessionToggle, boolean>
  toggleWords: Record<SessionToggle, string>
  headings: { actions: string; view: string; show: string }
  /** The ordering block, when the menu should offer one. */
  sort?: { heading: string; words: Record<SessionSort, string>; by: SessionSort; dir: 'asc' | 'desc' }
  /**
   * The per-STATE block: which states are kept, what each is called, and how many wear it.
   *
   * Counted over the fleet rather than over the filtered list, for the same reason the tasks are:
   * the count is what says a state has anything in it, and counting after the filter would report
   * the number the filter left — which for an unselected state is always zero.
   */
  states?: {
    heading: string
    words: Record<SessionState, string>
    counts: Partial<Record<SessionState, number>>
    kept: readonly SessionState[]
  }
  /**
   * The tasks in the fleet with their session counts, and which one the list is scoped to.
   *
   * Offered as a SECTION rather than as a separate screen: a task is a place you work out of, so
   * picking one should narrow the list you are already looking at rather than take you somewhere
   * else and make you come back.
   */
  tasks?: {
    counts: ReadonlyArray<{ name: string; count: number }>
    active: string | null
    heading: string
    allLabel: string
    /** What the "no task" bucket is called — the row that replaced the `unfiled` switch. */
    unfiled: string
    /** How many sessions are in it. A bucket with nothing in it draws no row. */
    unfiledCount?: number
    /** The finished ones, marked in the list so the menu states what it already knows. */
    done?: readonly string[]
  }
  /**
   * The project directories in the fleet, with their session counts.
   *
   * A second scope beside the tasks, and the answer to "where is that session I had open" — a task
   * is something you declared, a project is something every session already has. Picking one
   * narrows the list you are already looking at, which is what makes this a drill-down rather than
   * a separate screen you have to come back from.
   */
  projects?: { counts: ReadonlyArray<{ name: string; count: number }>; active: string | null; heading: string; allLabel: string }
}): AsideRow[] {
  const rows: AsideRow[] = [{ kind: 'heading', label: o.headings.actions }]
  for (const a of o.actions) {
    rows.push({ kind: 'action', action: a.action, label: o.actionWords[a.action], enabled: a.enabled })
  }
  rows.push({ kind: 'rule' }, { kind: 'heading', label: o.layout.heading })
  for (const value of LAYOUTS) {
    rows.push({
      kind: 'layout', value, label: o.layout.words[value], on: value === o.layout.value,
    })
  }
  // The CASCADE sits with the layout rather than with the groupings, because that is what it is: a
  // way of DRAWING the rows, orthogonal to what the bands stand for. It was a grouping, which made
  // "show me the directories" cost every band on the screen.
  rows.push({
    kind: 'toggle', toggle: 'cascade', label: o.toggleWords.cascade, on: o.toggles.cascade,
  })
  rows.push({ kind: 'rule' }, { kind: 'heading', label: o.headings.view })
  for (const g of GROUPINGS) {
    rows.push({ kind: 'group', value: g, label: o.groupWords[g], on: g === o.grouping })
  }
  rows.push({ kind: 'rule' }, { kind: 'heading', label: o.headings.show })
  // `active` leads because it is the STRICT one, with the widening ones beneath. It no longer
  // overrides them: all three write into one status selection and read their state back out of it,
  // so ticking `closed` while `active` is on widens the list and turns `active` off — a switch is
  // never lit over a list it does not describe. `named` sits with them because it is the same kind
  // of thing, and because it used to be the one widening nobody could see.
  const toggles: SessionToggle[] = ['active', 'history', 'named', 'done', 'detail']
  for (const t of toggles) {
    rows.push({ kind: 'toggle', toggle: t, label: o.toggleWords[t], on: o.toggles[t] })
  }

  // The tasks, last, and only when there are any: a heading over an empty section is a promise the
  // screen cannot keep.
  // ORDER, then STATE: the first is how the list is arranged and belongs beside the grouping, the
  // second is what it contains and belongs beside the switches that decide the same thing.
  if (o.sort) {
    rows.push({ kind: 'rule' }, { kind: 'heading', label: o.sort.heading })
    for (const by of SESSION_SORTS) {
      rows.push({
        kind: 'sort', value: by, label: o.sort.words[by], on: by === o.sort.by, dir: o.sort.dir,
      })
    }
  }

  if (o.states) {
    rows.push({ kind: 'rule' }, { kind: 'heading', label: o.states.heading })
    // The CHOICES, not every internal state: `exited`, `lost` and `closed` all mean "not running"
    // and drew three rows that read the same word. See `SESSION_STATE_CHOICES`.
    for (const value of SESSION_STATE_CHOICES) {
      const count = o.states.counts[value] ?? 0
      // A state nothing on this machine wears is not a filter, it is a row that does nothing.
      if (count === 0 && !o.states.kept.includes(value)) continue
      rows.push({
        kind: 'state', value, label: o.states.words[value], count,
        on: o.states.kept.includes(value),
      })
    }
  }

  if (o.tasks && o.tasks.counts.length > 0) {
    const done = o.tasks.done ?? []
    rows.push({ kind: 'rule' }, { kind: 'heading', label: o.tasks.heading })
    rows.push({
      kind: 'task', name: '', label: o.tasks.allLabel, count: 0,
      on: o.tasks.active === null, all: true,
    })
    for (const t of o.tasks.counts) {
      rows.push({
        kind: 'task', name: t.name, label: t.name, count: t.count, on: o.tasks.active === t.name,
        ...(done.includes(t.name) ? { done: true } : {}),
      })
    }
    // The "no task" bucket, last, and only when something is in it. It is what the `unfiled` switch
    // used to be — except it is a value on a dimension like any other, selectable under every
    // grouping rather than only while grouping by task.
    const unfiledCount = o.tasks.unfiledCount ?? 0
    if (unfiledCount > 0) {
      rows.push({
        kind: 'task', name: UNFILED, label: o.tasks.unfiled, count: unfiledCount,
        on: o.tasks.active === UNFILED,
      })
    }
  }

  if (o.projects && o.projects.counts.length > 0) {
    rows.push({ kind: 'rule' }, { kind: 'heading', label: o.projects.heading })
    rows.push({ kind: 'project', name: '', count: 0, on: o.projects.active === null })
    for (const p of o.projects.counts) {
      rows.push({ kind: 'project', name: p.name, count: p.count, on: o.projects.active === p.name })
    }
  }
  return rows
}

/**
 * A stable NAME for a menu row, so a cursor can survive the list being rebuilt — PURE.
 *
 * The cursor used to be an index into the SELECTABLE rows, and that list changes composition
 * constantly: which verbs are enabled depends on the selected session, so moving down the fleet
 * silently renumbered every row beneath the actions block and the menu cursor jumped — usually back
 * into the first section, which then opened. An index is not an identity.
 *
 * Keyed by kind and by what the row acts on, never by position.
 */
export function asideRowKey(row: AsideRow): string {
  switch (row.kind) {
    case 'action': return `action:${row.action}`
    case 'group': return `group:${row.value}`
    case 'layout': return `layout:${row.value}`
    case 'toggle': return `toggle:${row.toggle}`
    case 'task': return `task:${row.name}`
    case 'state': return `state:${row.value}`
    case 'sort': return `sort:${row.value}`
    case 'project': return `project:${row.name}`
    case 'heading': return `heading:${row.label}`
    case 'rule': return 'rule'
  }
}

/**
 * Where the cursor lands after the menu is rebuilt — PURE.
 *
 * The SAME row when it is still there and still selectable; otherwise the nearest selectable row to
 * where it was, so a verb that becomes unavailable moves the cursor by one place rather than to the
 * top of the menu.
 */
export function resolveAsideCursor(rows: readonly AsideRow[], wanted: string): number {
  const picks = asideSelectable(rows)
  if (picks.length === 0) return -1
  const exact = picks.find(i => asideRowKey(rows[i]!) === wanted)
  if (exact !== undefined) return exact
  // Not there any more: fall back to where it WAS, which for a disabled verb is the row that took
  // its place. Never the top — a cursor that jumps to the first section makes that section open.
  const previous = rows.findIndex(r => asideRowKey(r) === wanted)
  if (previous < 0) return picks[0]!
  return picks.reduce((best, i) =>
    Math.abs(i - previous) < Math.abs(best - previous) ? i : best, picks[0]!)
}

/** Index of the nth row the cursor may land on: never a heading, a rule, or a disabled action. */
export function asideSelectable(rows: readonly AsideRow[]): number[] {
  const out: number[] = []
  rows.forEach((r, i) => {
    if (r.kind === 'heading' || r.kind === 'rule') return
    if (r.kind === 'action' && !r.enabled) return
    out.push(i)
  })
  return out
}

// ---------------------------------------------------------------------------
// the project picker's table
// ---------------------------------------------------------------------------

/** One project row, already reduced to the four things a column can hold. */
export interface ProjectRow {
  name: string
  repo: string
  path: string
  /** Already-localized reason it is being offered ("you are here", "you worked here"). */
  why: string
}

export interface ProjectColumns {
  name: number
  repo: number
  path: number
  why: number
}

/** One section of the picker: the repository its rows belong to, or `''` for the loose folders. */
export interface ProjectSection {
  repo: string
  rows: ProjectRow[]
}

/**
 * Group the candidates by REPOSITORY, keeping the order they arrived in — PURE.
 *
 * First appearance decides section order, which is what preserves the host's ranking: the section
 * holding the directory you are standing in stays at the top, and re-sorting alphabetically here
 * would throw away the one piece of ordering the search actually earned.
 *
 * Loose folders — anything with no repository — go LAST, under their own empty-keyed section. They
 * are the long tail of a `$HOME` walk, and the sections above them are the answer most of the time.
 */
export function groupProjects(rows: readonly ProjectRow[]): ProjectSection[] {
  const byRepo = new Map<string, ProjectSection>()
  const loose: ProjectRow[] = []
  for (const r of rows) {
    if (!r.repo) { loose.push(r); continue }
    const found = byRepo.get(r.repo)
    if (found) found.rows.push(r)
    else byRepo.set(r.repo, { repo: r.repo, rows: [r] })
  }
  const out = [...byRepo.values()]
  if (loose.length > 0) out.push({ repo: '', rows: loose })
  return out
}

/**
 * The picker's rows as they are DRAWN — headings included, in one flat list.
 *
 * Flat because the cursor moves over it: with headings drawn separately, the selected index and the
 * drawn rows are two different countings of one list and they agree until the first section
 * boundary. `index` is the position in the ORIGINAL list, so what `enter` picks is never in doubt.
 *
 * Sections are only drawn when they earn themselves: one section is not a grouping, it is a heading
 * over the whole list.
 */
export type ProjectPickRow =
  | { kind: 'heading'; label: string }
  | { kind: 'project'; row: ProjectRow; index: number }

export function projectPickRows(
  rows: readonly ProjectRow[],
  /** Already-localized heading for the folders that belong to no repository. */
  looseLabel: string,
): { rows: ProjectPickRow[]; grouped: boolean } {
  const sections = groupProjects(rows)
  const named = sections.filter(s => s.repo !== '').length
  // A grouping needs at least one named repository AND something to separate it from.
  if (named === 0 || sections.length < 2) {
    return { rows: rows.map((row, index) => ({ kind: 'project' as const, row, index })), grouped: false }
  }
  const out: ProjectPickRow[] = []
  let index = 0
  const seen = new Map<ProjectRow, number>()
  rows.forEach((r, i) => seen.set(r, i))
  for (const section of sections) {
    out.push({ kind: 'heading', label: section.repo || looseLabel })
    for (const row of section.rows) {
      index = seen.get(row) ?? index
      out.push({ kind: 'project', row, index })
    }
  }
  return { rows: out, grouped: true }
}

/**
 * Column widths for a screenful of project candidates — PURE, and MEASURED across the page.
 *
 * The picker used to size each row against its own content, so every name started at a different
 * column and the eye had to re-find the path on every line. With twenty candidates that is not a
 * list, it is a paragraph per row — and this is the one control that decides where work happens.
 *
 * The PATH is the cell that survives everything: a machine with six directories called `portifolio`
 * renders six identical rows without it, so the name answers "what" and the path answers "which
 * one". The name is what the eye scans, so it goes first and is squeezed rather than dropped; the
 * repo and the provenance word are both derivable from the path and are given up before it.
 */
/** Cursor plus the kind glyph, both always drawn: `❯ ◆ `. */
export const PROJECT_LEAD = 4

export function projectColumns(rows: readonly ProjectRow[], width: number): ProjectColumns {
  const widest = (pick: (r: ProjectRow) => string) =>
    rows.reduce((n, r) => Math.max(n, pick(r).length), 0)

  const name = widest(r => r.name)
  const repo = widest(r => r.repo)
  const path = widest(r => r.path)
  const why = widest(r => r.why)

  // Two for the cursor, then a gap between each pair of cells that is actually drawn. Counted from
  // the cells because any of them can be zero — a fleet of candidates with no repo draws no repo
  // column, and paying its gap anyway narrows every name to reserve a space nothing occupies.
  // The NAME counts as a drawn cell even while its width is still being solved for — it is always
  // drawn. Leaving it out of the tally lost one GAP, so the table came out two columns wider than
  // the pane and every row was truncated by the frame it had just been measured against.
  const room = (r: number, p: number, w: number) => {
    const drawn = [1, r, p, w].filter(v => v > 0).length
    return PROJECT_LEAD + r + p + w + GAP * Math.max(0, drawn - 1)
  }

  const MIN_NAME = 10
  const MIN_PATH = 12
  // Two for the cursor and two for the glyph that says what kind of place this is. The glyph is
  // always drawn, so it is chrome rather than a column that can be given up.

  const ladder: Array<[number, number, number]> = [
    [repo, path, why],
    [repo, path, 0],
    [0, path, 0],
  ]
  for (const [r, p, w] of ladder) {
    const over = room(r, p, w)
    const left = width - over
    if (left >= MIN_NAME) return { name: Math.min(name, left), repo: r, path: p, why: w }
  }
  // Nothing fits whole. The name and the path SHARE what there is, because either alone is a row
  // that cannot be acted on: a name with no path does not say which directory, a path with no name
  // is a row nobody scans.
  const shared = Math.max(2, width - PROJECT_LEAD - GAP)
  const forPath = Math.min(path, Math.max(MIN_PATH, Math.floor(shared / 2)))
  return { name: Math.max(1, shared - forPath), repo: 0, path: forPath, why: 0 }
}

// ---------------------------------------------------------------------------
// the aside, split into its own panes
// ---------------------------------------------------------------------------

/** One titled block of the menu, ready to be drawn as its own framed pane. */
export interface AsideSection {
  /** Already-localized title, taken from the heading row that opened the block. */
  title: string
  /** The rows of this block, WITHOUT its heading or the rule that followed it. */
  rows: AsideRow[]
  /** Index into the flat `asideRows` list of each row above, so the cursor keeps ONE counting. */
  indexes: number[]
}

/**
 * Split the flat menu into its titled sections — PURE.
 *
 * The menu is authored as one flat list because the CURSOR moves over one list: with the sections
 * kept as separate arrays, the selected index and the drawn rows are two different countings of one
 * menu and they agree until the first section boundary. This takes that one list apart for DRAWING
 * only, and every row carries the index it had — so what `enter` runs is never in doubt.
 *
 * It exists because a single scrolling pane titled "menu" showed its first section and nothing
 * else: with the actions at the top and the pane four rows tall, every switch and every task was
 * below the fold, and the honest reading of that screen is that everything lives inside "Actions".
 */
export function asideSections(rows: readonly AsideRow[]): AsideSection[] {
  const out: AsideSection[] = []
  rows.forEach((row, index) => {
    if (row.kind === 'rule') return
    if (row.kind === 'heading') { out.push({ title: row.label, rows: [], indexes: [] }); return }
    const current = out[out.length - 1]
    if (!current) return
    current.rows.push(row)
    current.indexes.push(index)
  })
  return out.filter(s => s.rows.length > 0)
}

/**
 * How many rows each menu section gets — PURE, and the ONE answer for every terminal height.
 *
 * A section that is open is a framed pane holding all of its rows; a section that is not gives up
 * its frame and its contents and keeps its NAME, on one row. Nothing is ever hidden: what a
 * collapsed section costs is what is inside it, never the fact that it exists — which was the whole
 * complaint about the single scrolling pane, where the first section filled the box and the rest
 * were below a fold nothing announced.
 *
 * The section holding the cursor opens first, then the others in reading order while they fit
 * WHOLE. Opening one part-way was the middle ground and it was the worst of the three: a block cut
 * to its first two rows says no more than its heading did, and every one of them grew its own
 * little scrollbar. The active section is the single exception — it takes whatever is left even if
 * that is not all of it, because it is the one being read.
 *
 * So a tall terminal opens every section and a short one opens the one you are using, with no
 * second behaviour to learn and no dead air under the last pane.
 *
 * `null` when the band cannot even name every section and open one, and the caller falls back to
 * the single scrolling pane.
 */
export function asideFold(
  sections: readonly AsideSection[],
  band: number,
  active: number,
): number[] | null {
  if (sections.length === 0) return null
  const at = Math.max(0, Math.min(active, sections.length - 1))
  const collapsed = sections.length - 1
  if (band < collapsed + PANE_FRAME_Y + 1) return null

  const want = (i: number) => PANE_FRAME_Y + sections[i]!.rows.length
  const out: number[] = sections.map(() => 1)
  // The one being read, first and at whatever height is left to it.
  out[at] = Math.min(want(at), band - collapsed)
  let used = out.reduce((a, b) => a + b, 0)

  // Then the rest, in READING order rather than outward from the cursor: the menu must not
  // rearrange itself as the cursor moves, or the box you were aiming at is somewhere else by the
  // time you get there.
  for (let i = 0; i < sections.length; i++) {
    if (i === at) continue
    const extra = want(i) - out[i]!
    if (extra <= 0 || used + extra > band) continue
    out[i] = want(i)
    used += extra
  }

  // Whatever is left over goes to the OPEN section, so the column ends flush with the list beside
  // it. Air under a pane is a fault and air inside one is a pane — and the section you are using is
  // the one where the spare rows are worth having, since its contents are what grows.
  out[at] += band - used
  return out
}

// ---------------------------------------------------------------------------
// how far down a scrolling region is
// ---------------------------------------------------------------------------

/**
 * The scrollbar for a windowed list, one character per drawn row — PURE.
 *
 * A window with no scrollbar is a list whose length is a secret: you cannot tell whether the row
 * under the cursor is the last one or the tenth of ninety, and the only way to find out is to keep
 * pressing down until it stops moving. That is what people were doing.
 *
 * Returns an EMPTY array when everything fits. A bar that is always drawn says "there is more" on a
 * list that has no more, which is the same class of lie as a confident zero.
 */
/** The thumb: a heavy hairline, so it is the same width as the track and plainly darker. */
export const THUMB = '┃'

/** The track: the lightest vertical rule the box-drawing set has. */
export const TRACK = '│'

export function scrollBar(o: { offset: number; total: number; rows: number }): string[] {
  const rows = Math.max(0, o.rows)
  if (rows === 0 || o.total <= rows) return []

  // At least one cell, and never the whole track — a full-length thumb reads as "nothing to scroll"
  // on exactly the list that has the most of it.
  const thumb = Math.max(1, Math.min(rows - 1, Math.round((rows * rows) / o.total)))
  const span = Math.max(1, o.total - rows)
  const offset = Math.max(0, Math.min(o.offset, span))
  const top = Math.round((offset / span) * (rows - thumb))
  // A HAIRLINE, not a block. `█` fills its whole cell, so beside a border it reads as a second
  // wall rather than as a position — the bar is a fact about where you are, and it has to be
  // legible without competing with the frame it sits inside.
  return Array.from({ length: rows }, (_, i) => (i >= top && i < top + thumb ? THUMB : TRACK))
}

// ---------------------------------------------------------------------------
// the new-session wizard's last step
// ---------------------------------------------------------------------------

export interface KeyHelp {
  /** The keystroke as a person types it. */
  keys: string
  /** Already-localized: what it does. */
  what: string
}

/**
 * Every key the sessions screen answers, in one place — PURE.
 *
 * One place because there were already two and they were drifting: the footer names a handful of
 * keys chosen for width, and the keys themselves live in a long if-chain. Neither is a list anyone
 * can read. This is the list, and `ctrl+h` prints it.
 *
 * It is grouped in the order someone learns them — move, act, filter, arrange — rather than
 * alphabetically, because a reference sorted by character is a reference you can only use if you
 * already know what you are looking for.
 */
export function sessionKeyHelp(w: {
  move: string; open: string; attach: string; menu: string; section: string
  newSession: string; search: string; clear: string; kill: string; rename: string
  note: string; task: string; mark: string; onlyActive: string
  openTask: string; finishTask: string; recent: string; cascade: string
  group: string; layout: string; detail: string; menuFold: string
  reset: string; tabs: string; help: string; quit: string
  approve: string; prompt: string; reopenFell: string
}): KeyHelp[] {
  return [
    { keys: '↑ ↓ / j k', what: w.move },
    { keys: 'enter', what: w.menu },
    { keys: 'o', what: w.attach },
    // The two that act on a session WITHOUT entering it, listed right under the one that enters it:
    // they answer the same question ("this one needs me") in the two cheaper ways. `y` is kept as an
    // alias and left out of the list — the reference names ONE key per verb or it stops being read.
    { keys: 'a', what: w.approve },
    { keys: 'p', what: w.prompt },
    { keys: 'R', what: w.reopenFell },
    { keys: 'tab', what: w.open },
    { keys: '1-9 / ← →', what: w.section },
    { keys: 'n', what: w.newSession },
    { keys: 'ctrl+f', what: w.search },
    { keys: 'esc', what: w.clear },
    { keys: 'x', what: w.kill },
    { keys: 'r', what: w.rename },
    { keys: 'm', what: w.note },
    { keys: 't', what: w.task },
    { keys: 'T', what: w.openTask },
    { keys: 'F', what: w.finishTask },
    { keys: 'space', what: w.mark },
    // One row, three keys, ONE question. `c` leads and `l`/`e` are aliases of the same call: they
    // were three controls doing one visible thing, which is a keyboard that lies about how many
    // controls exist.
    { keys: 'c / l / e', what: w.onlyActive },
    { keys: 'C', what: w.recent },
    { keys: 'v', what: w.group },
    { keys: 'ctrl+g', what: w.layout },
    { keys: 'd', what: w.detail },
    // `b` leads: `ctrl+b` is tmux's default prefix, so inside a tmux the chord never reaches this
    // app at all. The plain letter is the one that always works, and the one the footer names.
    { keys: 'b / ctrl+b', what: w.menuFold },
    { keys: 'ctrl+r', what: w.reset },
    { keys: '[ ]', what: w.tabs },
    // `h` leads, because it is the letter a person tries first and it was free. `?` stays: it is
    // what every list-shaped TUI already answers, and a reference nobody can open is not a
    // reference. Both are listed, so the screen never teaches only the harder one.
    { keys: 'h / ?', what: w.help },
    { keys: 'q', what: w.quit },
  ]
}

/** The width the keystroke column needs, so the descriptions line up — PURE. */
export function keyHelpColumn(rows: readonly KeyHelp[]): number {
  return rows.reduce((n, r) => Math.max(n, r.keys.length), 0)
}

/** One drawn line of the key reference: the keystroke, then what it does. */
export interface KeyHelpLine {
  /** Empty on a continuation line, so the keystroke column is written exactly once per key. */
  keys: string
  what: string
}

/**
 * The reference as LINES that fit `width` — PURE, and the thing the screen scrolls.
 *
 * It used to be one row per key, truncated: at the width of the menu column that produced
 * `attach — or reo…` for half the list, which is a reference that names the keys and withholds
 * what they do. Wrapping is what makes the narrow case readable, and it is also what makes the
 * screen SCROLLABLE — once a row can be two lines, a row budget is no longer a line budget, and
 * paging has to be counted in the units that are actually drawn.
 *
 * A description too narrow to hold anything is not wrapped into single characters: below the point
 * where the keystroke column plus a word fits, the caller is expected to have given the reference
 * the whole screen instead. `wrapText` still guarantees termination there.
 */
export function keyHelpLines(rows: readonly KeyHelp[], width: number): KeyHelpLine[] {
  const keyCol = keyHelpColumn(rows)
  const room = Math.max(1, width - keyCol - 2)
  const out: KeyHelpLine[] = []
  for (const row of rows) {
    const wrapped = wrapText(row.what, room)
    if (wrapped.length === 0) { out.push({ keys: row.keys, what: '' }); continue }
    wrapped.forEach((what, i) => out.push({ keys: i === 0 ? row.keys : '', what }))
  }
  return out
}

// the card grid
// ---------------------------------------------------------------------------

/**
 * How the fleet is ARRANGED — the same rows, two shapes.
 *
 * The list is the right shape for scanning forty sessions and the wrong shape for reading one:
 * what a session is saying, which model it runs, the note left on it and how long it has been
 * going exist only in the detail pane, one selection at a time. A card carries them all at once.
 */
export type SessionLayout = 'list' | 'cards'

/**
 * The most cards one page may hold.
 *
 * A CAP rather than a page size: ten cards rarely fit — at 130x30 the pane carries six — and a
 * fixed ten would have to SCROLL inside the page, which is two mechanisms for reaching one card.
 * The page is what the grid can actually show, and on a terminal that can carry ten it is ten.
 */
export const CARD_PAGE_MAX = 10

/**
 * The layouts, in the order the menu lists them.
 *
 * A `const` array rather than a literal inside `asideRows`, for the same reason `SESSION_STATES`
 * is one: a layout added later shows up as a missing row rather than as a menu that silently
 * cannot reach it.
 */
export const LAYOUTS: readonly SessionLayout[] = ['list', 'cards'] as const

/** One column between two cards. The frames already separate them; a wider gutter is spent air. */
export const CARD_GAP = 1

/**
 * The narrowest card worth drawing, frame included.
 *
 * `PANE_FRAME_X` of that is border and padding, so the floor leaves 24 columns for a name — below
 * which every card is an ellipsis and the grid says less than the list it replaced.
 */
export const CARD_MIN_WIDTH = 28

/**
 * The widest a card is allowed to grow, so a fleet of three on a 200-column terminal draws three
 * readable cards rather than three billboards. The same bounded-growth rule the aside menu follows.
 */
export const CARD_MAX_WIDTH = 46

/**
 * Content lines a full card carries: name, state, usage, the context gauge, where, model, and what
 * it is filed under.
 *
 * SEVEN, and it got there twice for different reasons — the MODEL took a line of its own (it used
 * to ride the `where` line as ` · opus`, where a bare word after a folder name reads as another
 * folder), and the context GAUGE took one because it is a shape rather than a word and sharing a
 * row with `12.4k $0.83` made it read as one more figure in a run of figures.
 *
 * It is a CEILING, not a demand: `cardGrid` takes `min(fullHeight, what the band affords)` and
 * `fitCardLines` cuts from the bottom, so a short terminal draws exactly the cards it drew before
 * and loses the same trailing lines. What changes is only that a tall one may say more.
 */
export const CARD_LINES = 7

/** The fewest a card is worth: the name, the state, and one fact. Below that it is a list row. */
export const CARD_MIN_LINES = 3

export interface CardGrid {
  /** Cards across. */
  cols: number
  /** Rows of cards. */
  rows: number
  /** Columns per card, FRAME INCLUDED. */
  cardWidth: number
  /** Rows per card, FRAME INCLUDED. */
  cardHeight: number
  /** Columns between two cards. */
  gap: number
  /** How many cards one page holds — `cols * rows`, never above `CARD_PAGE_MAX`. */
  capacity: number
}

/**
 * The grid a region can carry — PURE, and `null` when it cannot carry one whole card.
 *
 * `null` is a real answer, not a failure: on a short or narrow terminal the screen falls back to
 * the list, which is the same degradation the aside menu makes when it is dropped rather than
 * squeezed. A grid drawn into a region too small for it is composited over the rows below.
 *
 * The shape is decided by the FLEET rather than by the cap: a 6x2 grid holding three sessions is
 * three cards and nine holes. So the rows are the fewest that can carry what will be shown, the
 * columns are the fewest that can place them in those rows, and every column left over is spent
 * making the cards WIDER rather than making more of them.
 */
export function cardGrid(o: {
  width: number
  height: number
  total: number
  /**
   * The most lines any card on screen will actually draw, when the caller has counted them.
   *
   * A card is as tall as the band affords and never taller than it has content for — the rule this
   * function already followed against the CONSTANT, and which the constant alone cannot keep: a
   * fleet whose richest session records no model, no task and no note draws four lines into a
   * six-line frame, and two rows of blank inside a frame are not a card, they are a box with a name
   * in it. Counted, those rows go back to the region and another band fits on the page.
   */
  lines?: number
  /**
   * Whether the grid will draw a group HEADING over its bands.
   *
   * A band's real cost is its cards plus the name over them, and sizing as though a band were only
   * its cards is what made the grouped grid page four times over: the ceiling was measured for a
   * region that then had to pay a row per band out of the same rows. Counted here, one row per
   * band, the cards give up a line and the page carries a group more.
   *
   * It is the ARITHMETIC of a band, not a rule of thumb — the same `+ PANE_FRAME_Y` this function
   * already pays for a frame, for the row a heading occupies.
   */
  headings?: boolean
}): CardGrid | null {
  const width = Math.max(0, o.width)
  const height = Math.max(0, o.height)
  const head = o.headings ? 1 : 0
  const floorHeight = PANE_FRAME_Y + CARD_MIN_LINES + head
  const fullHeight = PANE_FRAME_Y
    + Math.max(CARD_MIN_LINES, Math.min(CARD_LINES, o.lines ?? CARD_LINES))
  if (width < CARD_MIN_WIDTH || height < floorHeight) return null

  // How many the region could carry at the floor — the ceiling on everything below.
  const maxCols = Math.max(1, Math.floor((width + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP)))
  const maxRows = Math.max(1, Math.floor(height / floorHeight))
  const want = Math.max(1, Math.min(Math.max(0, o.total), CARD_PAGE_MAX))

  const rows = Math.max(1, Math.min(maxRows, Math.ceil(want / maxCols)))
  const cols = Math.max(1, Math.min(maxCols, Math.ceil(want / rows)))
  // The floor is unreachable — `cols <= maxCols` guarantees it — and stated anyway, because this is
  // the one line whose being wrong truncates every card by the frame it was measured against.
  const cardWidth = Math.max(
    CARD_MIN_WIDTH,
    Math.min(CARD_MAX_WIDTH, Math.floor((width - CARD_GAP * (cols - 1)) / cols)),
  )
  // As tall as the band affords, never taller than the card has content for: rows of blank inside
  // a frame are not a card, they are a box with a name in it. `- head` is the row the name over the
  // band takes — the cards of a headed grid are shorter by exactly what their headings cost, and
  // `rows <= maxRows` is what keeps the result at or above the floor.
  const cardHeight = Math.min(fullHeight, Math.floor(height / rows) - head)

  return {
    cols, rows, cardWidth, cardHeight, gap: CARD_GAP,
    capacity: Math.min(cols * rows, CARD_PAGE_MAX),
  }
}

/**
 * One horizontal BAND of a card page: a group's name, or a row of that group's cards.
 *
 * A band belongs to exactly ONE group. That is the whole model: a group opens a band with its name
 * and its cards fill the bands under it, and a group with one card leaves the rest of its band
 * EMPTY. The air to the right of a short group is not waste — it is what separates one group from
 * the next, and filling it with the following group's cards is precisely how the grid used to
 * ignore the grouping it was drawn under. (The control center's "air under a pane is a fault" rule
 * is about air OUTSIDE a region; this air is inside the band and is doing work.)
 */
export type CardBand =
  /** `muted` is the list's own reading: an absent key, a finished task, the history section. */
  | {
      kind: 'heading'
      label: string
      count: number
      muted: boolean
      /**
       * The cascade's node path, when there is one — what the band's title is BREADCRUMBED from.
       *
       * The grid has no indentation to spend, so where the list draws `session-monitor` two levels
       * in, the band draws `agentistics › .claude/worktrees › session-monitor`. Carried on the row
       * rather than re-derived, so the two layouts cannot name one branch different things.
       */
      path?: readonly string[]
    }
  /**
   * Indexes into the flat card sequence — at most `cols` of them, all from one group — and the rows
   * this band occupies, FRAME INCLUDED.
   *
   * The height is the BAND's, not the grid's, and that is the point: a single grid height is the
   * height of the richest card in the whole fleet, so one session carrying a note and a model made
   * every card on screen two rows taller than it had anything to put in them. Rows of blank inside a
   * frame are not a card, they are a box with a name in it.
   *
   * It is the band and not the card because the cards of one band stand side by side: giving each
   * its own height leaves the bottom edge of the row ragged, which is a worse thing to look at than
   * the one blank line a short card beside a rich one still keeps.
   */
  | { kind: 'cards'; items: number[]; height: number }

export interface CardPage {
  bands: CardBand[]
  /** Every card index on this page, in order — what the pager counts. */
  items: number[]
}

/** Rows a page's bands occupy: one per heading, its own height per row of cards — PURE. */
export function cardPageRows(bands: readonly CardBand[]): number {
  return bands.reduce((n, b) => n + (b.kind === 'heading' ? 1 : Math.max(1, b.height)), 0)
}

/**
 * The fleet split into pages of bands — PURE, and the ONE arithmetic the grid is drawn from.
 *
 * It walks the very `SessionRow[]` the LIST draws, so what a group is called, which ones are muted
 * and where the history section begins are decided once, in `sessionRows`, for both layouts. Working
 * the grouping out a second way here is a second implementation of it, and the two would disagree
 * the first time either changed.
 *
 * Two rules paying for themselves:
 *
 *  - **A heading is never placed without a row of cards under it.** They go onto a page together or
 *    neither does, so no page ever ends with a name and nothing named.
 *  - **A group that crosses a page boundary REPEATS its name at the top of the next page.** Within
 *    one page the name sits a band or two above and plainly governs the bands under it, so it is
 *    said once; across a break it is gone, and a card under no name does not say what it belongs
 *    to. The repeated heading carries the group's own count, not the count on this page — it is the
 *    same statement the list makes, and the pager already says how much of the fleet is on screen.
 *
 * `headed: false` — a grouping of `none`, or a band too short to spend a row on a name — packs the
 * whole fleet as one nameless group, which is exactly the dense grid this screen drew before.
 *
 * Each band is also SIZED here, to the tallest card in it and no taller, which is why the rows it
 * gives back turn into more bands on the page rather than into air.
 */
export function cardPages(o: {
  /** The rows the list would draw, headings and spacers included. */
  rows: readonly SessionRow[]
  cols: number
  /** Rows the grid region has, pager already paid for. */
  gridRows: number
  /** The TALLEST a band may be — the ceiling the region affords, from `cardGrid`. */
  cardHeight: number
  /**
   * How many lines each card has to draw, by card index — see `cardLines`.
   *
   * Absent, every band takes the ceiling, which is the uniform grid this screen drew before.
   */
  lines?: readonly number[]
  /** The most cards one page may hold — see `CARD_PAGE_MAX`. */
  capacity: number
  headed: boolean
}): CardPage[] {
  const cols = Math.max(1, o.cols)
  const cardHeight = Math.max(1, o.cardHeight)
  const cap = Math.max(1, o.capacity)
  const budget = Math.max(0, o.gridRows)
  /**
   * The rows a band of these cards needs: its tallest card's lines plus the frame, never below the
   * floor that makes a card a card, never above what the region affords.
   */
  const heightOf = (chunk: readonly number[]): number => {
    if (!o.lines) return cardHeight
    const most = chunk.reduce((n, i) => Math.max(n, o.lines![i] ?? 0), 0)
    return Math.min(cardHeight, Math.max(PANE_FRAME_Y + CARD_MIN_LINES, PANE_FRAME_Y + most))
  }

  type Head = { label: string; count: number; muted: boolean; path?: readonly string[] }
  const sections: Array<{ head: Head | null; items: number[] }> = []
  let index = 0
  for (const row of o.rows) {
    if (row.kind === 'spacer') continue
    if (row.kind === 'heading') {
      // Unheaded, every row joins ONE nameless section, so nothing wraps early and the layout is
      // byte-for-byte the one this screen drew before groups reached it.
      if (o.headed) {
        sections.push({
          head: {
            label: row.label, count: row.count, muted: row.muted === true,
            // Travels with the name, so a branch that crosses a page break repeats the WHOLE crumb.
            ...(row.path ? { path: row.path } : {}),
          },
          items: [],
        })
      }
      continue
    }
    const last = sections[sections.length - 1]
    if (last && (o.headed || last.head === null)) last.items.push(index)
    else sections.push({ head: null, items: [index] })
    index++
  }

  const pages: CardPage[] = []
  let bands: CardBand[] = []
  let items: number[] = []
  let used = 0
  const flush = () => {
    if (items.length > 0) pages.push({ bands, items })
    bands = []
    items = []
    used = 0
  }

  for (const section of sections) {
    // Whether THIS page already carries this section's name. Reset by every page break, which is
    // what makes a split group say its name again.
    let named = false
    for (let i = 0; i < section.items.length; i += cols) {
      const chunk = section.items.slice(i, i + cols)
      const height = heightOf(chunk)
      const cost = () => (section.head && !named ? 1 : 0) + height
      // A page break is the only way to make room, so it is only ever taken while there is
      // something to break away from — the loop always terminates.
      if (items.length > 0 && (used + cost() > budget || items.length + chunk.length > cap)) {
        flush()
        named = false
      }
      if (section.head && !named) {
        bands.push({ kind: 'heading', ...section.head })
        used += 1
        named = true
      }
      bands.push({ kind: 'cards', items: chunk, height })
      items.push(...chunk)
      used += height
    }
  }
  flush()
  return pages
}

/** Which page holds a card — PURE. `0` for an index no page carries, which is the first frame. */
export function pageOfCard(pages: readonly CardPage[], index: number): number {
  const at = pages.findIndex(p => p.items.includes(index))
  return at < 0 ? 0 : at
}

// ---------------------------------------------------------------------------
// what a card says
// ---------------------------------------------------------------------------

/**
 * The group each card belongs to, in the order the cards are drawn — PURE.
 *
 * Taken from the HEADING the list would have drawn above that row, never re-derived from the
 * session: `sessionRows` already decides what a group is called, including the history section, a
 * finished task's suffix and the localized word for an absent key. Working it out a second way is a
 * second implementation of the grouping, and the two would disagree the first time either changed.
 *
 * With grouping off there is no heading, and the card falls back to the project — the fact every
 * session already carries. A blank badge is a frame with a gap in it.
 *
 * Read ONLY where the grid draws no group headings: with a heading over the band, the same name on
 * every card under it is a column of one word, which is why the list drops its `task` cell while
 * grouping by task. One of the two says it, never both and never neither.
 */
export function cardBadges(rows: readonly SessionRow[]): string[] {
  const out: string[] = []
  let heading = ''
  for (const row of rows) {
    if (row.kind === 'heading') { heading = row.label; continue }
    if (row.kind !== 'session') continue
    out.push(heading || row.session.projectGroup || row.session.project)
  }
  return out
}

/** What a card line IS, so the component can colour it without parsing it back.
 *
 *  `gauge` is its own kind rather than a `fact` for exactly that reason: its colour depends on the
 *  LEVEL it is showing, which no other line's does, and the component must not have to re-derive
 *  that by parsing the text back out of the line. */
export type CardLineKind = 'title' | 'state' | 'fact' | 'say' | 'gauge'

export interface CardLine {
  key: string
  kind: CardLineKind
  text: string
  /**
   * What this line IS, already localized — drawn dim in front of the value.
   *
   * Only on the lines a reader cannot name from the value alone. A card is narrow and the list
   * solves this with a column HEADER the grid has no room for, so the naming moves onto the row:
   * `session-monitor` and `cockpit: canal de eventos` are a folder and a task, drawn identically,
   * and nothing on the card said which was which.
   *
   * Absent on the lines that say what they are: the name is the card's first line and its only bold
   * one, the state word is coloured and unique, and `51.7k $1.24 · há 10h` names its own units.
   * Rotulating those would spend the width that makes the ambiguous ones readable.
   */
  label?: string
  /** Drawn dim on the same row, after `text`. Given up first when the card is narrow. */
  tail?: string
  /** Only on a `gauge` line: how full, so the component colours it without parsing `text` back. */
  level?: ContextLevel
}

/** The already-localized words a card needs. This module owns no strings. */
export interface CardLabels {
  /** Said on a session whose terminal is currently handed over. */
  attached: string
  /** Short caveat for a harness with no probed approval markers. */
  blind: string
  /**
   * The names of the facts, from the very table the list's column header prints (`sessionsCols`).
   *
   * The same words on purpose: the two layouts are one screen in two shapes, and a card that called
   * the folder something the header does not would be a second vocabulary to learn.
   */
  worktree: string
  project: string
  task: string
  note: string
  model: string
  ago: (startedAt: number) => string
}

/** Columns between a card's label and its value. */
export const CARD_LABEL_GAP = 2

/**
 * Below this a labelled card says LESS than an unlabelled one: `worktree  sess…` names the field and
 * stops answering which one, which is the trade the labels exist to avoid.
 */
export const CARD_VALUE_MIN = 10

/**
 * The column the labels are drawn in, or `0` to draw none — PURE.
 *
 * All-or-nothing per CARD rather than per line, and that is the whole point: labels that come and go
 * down a card leave the values starting at different columns, which is the jumble `sessionColumns`
 * exists to prevent on the list. So either every fact is named and aligned, or none is.
 *
 * Dropping them is the right degradation because a label never removes a line — it only narrows the
 * value. A card too narrow to carry both keeps the values whole and gives up the naming, which is
 * exactly what the list does when it drops its header row.
 */
export function cardLabelWidth(lines: readonly CardLine[], width: number): number {
  const widest = lines.reduce((n, l) => Math.max(n, (l.label ?? '').length), 0)
  if (widest === 0) return 0
  return width - widest - CARD_LABEL_GAP >= CARD_VALUE_MIN ? widest : 0
}

/**
 * Everything a card can say about one session, most identifying first — PURE.
 *
 * The order IS the give-up order: `fitCardLines` cuts from the bottom, so the name and the state
 * are the two a card can never lose — the name because a card you cannot identify is not one you
 * can act on, the state because nothing else on the frame says whether this session is waiting for
 * you.
 *
 * A fact that was never recorded is an ABSENT line, never a zero: a harness that cannot report
 * usage would otherwise show every one of its sessions costing nothing, in the very place a person
 * looks to decide what to close. Same rule the detail pane and `sessionMetric` already follow.
 */
export function cardLines(
  s: ControlSession,
  labels: CardLabels,
  /**
   * The name of the band this card sits under, when there is one.
   *
   * A fact whose value IS that name is dropped: under a heading reading `agentistics`, a line
   * reading `project  agentistics` spends one of four rows saying what the row above already said,
   * and the row it costs is the one that would have carried the model or the task. The same rule
   * `sessionColumns` applies to its `task` cell while grouping by task, one line lower down.
   *
   * Matched on the drawn LABEL, so a composite heading (`agentistics · closed`) keeps the line: it
   * is not the same word, and dropping a fact because a heading merely contains it would be a card
   * withholding something nothing on screen says.
   */
  group = '',
): CardLine[] {
  const marks = [
    s.attached ? labels.attached : '',
    s.approvalBlind ? labels.blind : '',
  ].filter(Boolean)
  const tail = [s.harness, ...marks].filter(Boolean).join(' · ')

  const out: CardLine[] = [
    { key: 'title', kind: 'title', text: s.title },
    { key: 'state', kind: 'state', text: s.stateLabel, ...(tail ? { tail: ` · ${tail}` } : {}) },
  ]

  const usage = [sessionMetric(s), s.startedAt !== undefined ? labels.ago(s.startedAt) : '']
    .filter(Boolean).join(' · ')
  if (usage) out.push({ key: 'usage', kind: 'fact', text: usage })

  // The gauge gets its OWN line rather than joining the usage one. A card is read one line at a
  // time and the bar is the only thing on it that is a shape rather than a word — sharing a line
  // with `12.4k $0.83` would make it read as one more figure in a run of figures, which is exactly
  // the glance it exists to shortcut. It sits directly under the usage because it is the same
  // subject, and above `where` because it is a fact about the session rather than its address.
  if (s.context) {
    out.push({
      key: 'context',
      kind: 'gauge',
      text: sessionContext(s),
      level: contextLevel(s.context.fraction),
    })
  }

  // WHERE, and which checkout of it: with several worktrees of one repository open at once, the
  // folder name is the only thing telling them apart — and the label says WHICH of the two kinds of
  // place this is, since a worktree's name and a project's name are the same shape of word.
  const said = (text: string) => text !== '' && text !== group
  const worktree = worktreeName(s)
  const where = worktree || s.projectGroup || s.project
  if (said(where)) {
    out.push({
      key: 'where', kind: 'fact', text: where,
      label: worktree ? labels.worktree : labels.project,
    })
  }
  // The MODEL on its own line rather than trailing the folder: appended there it was a bare word
  // after a path, which reads as another path.
  if (said(s.model ?? '')) out.push({ key: 'model', kind: 'fact', text: s.model!, label: labels.model })

  if (said(s.task ?? '')) out.push({ key: 'task', kind: 'fact', text: s.task!, label: labels.task })
  if (s.note) out.push({ key: 'note', kind: 'fact', text: s.note, label: labels.note })

  // What it is SAYING, last, because it is the line a short card gives up first — and the only one
  // that would be invented if it were not there. Present only for a session agentop hosts.
  const say = s.lastLines?.[0]
  if (say) out.push({ key: 'say', kind: 'say', text: say })

  return out
}

/** The lines that fit, cut from the BOTTOM — so the name and the state are the two that survive. */
export function fitCardLines(lines: readonly CardLine[], rows: number): CardLine[] {
  return lines.slice(0, Math.max(0, rows))
}

/**
 * The state row's two halves, fitted — PURE.
 *
 * The state WORD is what a card may never give up, exactly as `sessionCells` keeps it for a row:
 * the harness is said again by the card's colour, the markers are said again by the detail pane,
 * but nothing else on the card says whether this session is waiting for you.
 */
export function cardStateCells(state: string, tail: string, width: number): {
  state: string
  tail: string
} {
  const room = Math.max(0, width)
  if (state.length + tail.length <= room) return { state, tail }
  if (state.length <= room) return { state, tail: '' }
  return { state: truncateCell(state, room), tail: '' }
}

// ---------------------------------------------------------------------------
// the card band, its pager, and where a click lands
// ---------------------------------------------------------------------------

/**
 * How the list pane's rows are split between the grid and its pager — PURE.
 *
 * The column HEADER is reclaimed: it names cells (`state`, `task`, `harness`) that a card does not
 * have, so drawing it over a grid would be a heading over nothing. The PAGER is a row like any
 * other and is paid for out of the same band — a row taken without being paid for is composited
 * onto the frame below it, which reads as a corrupted frame rather than a cramped one.
 *
 * The pager is given up before the grid: a page you cannot leave is worse than one you cannot
 * count, and the keys still turn the page.
 */
export function cardBand(o: { listRows: number; header: boolean }): {
  gridRows: number
  pager: boolean
} {
  const available = Math.max(0, o.listRows) + (o.header ? 1 : 0)
  const pager = available >= PANE_FRAME_Y + CARD_MIN_LINES + 1
  return { gridRows: Math.max(0, available - (pager ? 1 : 0)), pager }
}

/**
 * Which card a click landed on — PURE, and resolved against the very BANDS that were drawn.
 *
 * Against the bands rather than against a uniform `cols × cardHeight` grid, because with grouping on
 * the page is no longer uniform: a heading costs one row and a short group leaves the right of its
 * band empty. Re-deriving the geometry from `cols` alone answers with the card one row up, or with a
 * card that is not there.
 *
 * The gutter between two cards belongs to neither, a heading row belongs to no card, and the empty
 * right-hand end of a short group's band is not a card either: each returns `null`, because
 * answering a click the user did not make is worse than not answering at all.
 */
export function cardHit(o: {
  bands: readonly CardBand[]
  cardWidth: number
  gap: number
  x: number
  y: number
}): number | null {
  if (o.x < 0 || o.y < 0) return null
  let top = 0
  for (const band of o.bands) {
    if (band.kind === 'heading') {
      if (o.y === top) return null
      top += 1
      continue
    }
    const height = Math.max(1, band.height)
    if (o.y < top + height) {
      const stride = o.cardWidth + o.gap
      const col = Math.floor(o.x / stride)
      // The gap AFTER a card belongs to the gutter, not to the card in front of it.
      if (o.x - col * stride >= o.cardWidth) return null
      return band.items[col] ?? null
    }
    top += height
  }
  return null
}

/** Every band of cards, across every page, in drawing order — the sequence `↑`/`↓` walk. */
export function cardRows(pages: readonly CardPage[]): number[][] {
  return pages.flatMap(p => p.bands.flatMap(b => (b.kind === 'cards' ? [b.items] : [])))
}

/**
 * Where `↑`/`↓` land from a card — PURE.
 *
 * Stepping by `cols` was right while every band was full and is wrong the moment a group is shorter
 * than the grid is wide: `↓` from the only card of a one-card group jumped over the whole band
 * underneath it. So the move is band to band, keeping the COLUMN — and clamped to the last card of a
 * shorter band rather than falling off it.
 *
 * It walks every page, not just the open one, because the page FOLLOWS the cursor: stepping off the
 * bottom band is how you reach the next page, and there is no second position to keep in step.
 */
export function cardStep(pages: readonly CardPage[], index: number, dy: number): number {
  const rows = cardRows(pages)
  let at = -1
  let col = 0
  rows.forEach((row, i) => {
    const found = row.indexOf(index)
    if (found >= 0) { at = i; col = found }
  })
  if (at < 0) return index
  const target = rows[Math.max(0, Math.min(at + dy, rows.length - 1))]
  if (!target || target.length === 0) return index
  return target[Math.min(col, target.length - 1)] ?? index
}

export interface PagerCells {
  /** `''` when the row is too narrow to carry the arrows at all. */
  prev: string
  next: string
  label: string
  /** How many of how many. The first cell given up. */
  note: string
  /** Column each arrow is drawn at, or `-1` when it is not drawn. */
  prevAt: number
  nextAt: number
  /** What the row actually occupies — never more than the width it was measured against. */
  width: number
}

/** The glyphs, so the drawn row and the hit test cannot disagree about their width. */
const PAGER_PREV = '‹'

const PAGER_NEXT = '›'

/**
 * The pager row, fitted — PURE.
 *
 * Cells are given up in the order the row can afford to lose them: the COUNT first (the page label
 * already says where you are), then the arrows (the keys still work, and the footer names them),
 * and the page label last — a pager that cannot say which page this is has stopped being a pager.
 */
export function pagerCells(o: { label: string; note: string; width: number }): PagerCells {
  const width = Math.max(0, o.width)
  const none: PagerCells = {
    prev: '', next: '', label: '', note: '', prevAt: -1, nextAt: -1, width: 0,
  }
  if (width === 0) return none

  const arrows = 4 + o.label.length // "‹ label ›"
  if (arrows <= width) {
    const nextAt = 2 + o.label.length + 1
    const noteAt = nextAt + 3
    const withNote = noteAt + o.note.length <= width && o.note !== ''
    return {
      prev: PAGER_PREV, next: PAGER_NEXT, label: o.label,
      note: withNote ? o.note : '',
      prevAt: 0, nextAt,
      width: withNote ? noteAt + o.note.length : arrows,
    }
  }
  const label = o.label.length <= width ? o.label : o.label.slice(0, width)
  return { ...none, label, width: label.length }
}

/** Which arrow a click landed on, resolved against the very cells that were drawn. */
export function pagerHit(cells: PagerCells, x: number): 'prev' | 'next' | null {
  if (cells.prev !== '' && x === cells.prevAt) return 'prev'
  if (cells.next !== '' && x === cells.nextAt) return 'next'
  return null
}

// ---------------------------------------------------------------------------
// closing a session from its own row
// ---------------------------------------------------------------------------

/**
 * The control that closes a session from its own row.
 *
 * A bare `✕` at the end of a table reads as a TRUNCATION mark, not as a verb — which is what it was
 * reported as. A wastebasket would say it plainly, and it is what the design asked for, but it
 * cannot be measured here: `truncate` counts `s.length`, which is UTF-16 code UNITS, and there is no
 * width dependency anywhere in this package. `🗑` is a surrogate pair, so `.length` is 2, while its
 * DISPLAY width is 1 or 2 depending on the terminal and on whether it is given emoji presentation.
 * Neither number is reliably the other, and a glyph whose measure is wrong by one shears every row
 * under it.
 *
 * So it is bracketed ASCII: three characters, `.length === 3`, three columns, on every terminal.
 * The design named this trade itself — a pretty glyph that shears the table is worse than a plain
 * one that does not. Revisit it the day this package measures display width.
 */
export const CLOSE_CELL = '[x]'

/**
 * Columns reserved at the right edge of the list for the per-row close control — PURE.
 *
 * **Always zero: the control is gone.** Kept as a function rather than deleted so the width
 * arithmetic still has one place that says what the right edge costs, and so a future control there
 * has somewhere to declare itself instead of being sprinkled through the callers.
 *
 * Removed because it did not make sense where it sat. Every other verb on this screen is reached
 * from the menu or a key, and a table's last column is where a VALUE goes — so a control parked
 * there reads as a truncated cell until you happen to click it. It also put the most destructive
 * question on the screen exactly where a reader's eye lands after skimming a row.
 *
 * Nothing was taken away but the button: `x` still closes the selected session, and the menu still
 * offers it in words.
 */
export function closeCellWidth(_rows: readonly ControlSession[], _width: number): number {
  return 0
}

/** What one level of the cascade costs on the left of a row — a bar and a space, or the connector. */
export const TREE_CELL = 2

/**
 * The tree GUIDES for a drawn list — PURE, one string per row, all padded to one width.
 *
 * Indentation alone does not read as a tree. The cascade drew its branches two spaces further right
 * per level and nothing else, so a reader sees a list whose headings wander rightwards: which node
 * a row hangs off, and where a branch ends, are exactly the two facts the shape is supposed to
 * carry, and both were left to be inferred from a column position.
 *
 * The rules are the ones every tree in every file manager uses, and they are worth stating because
 * each is load-bearing:
 *
 *  - a ROOT gets nothing. Two roots are two trees, and a bar between them would claim a parent that
 *    does not exist;
 *  - a branch is `├─` while a sibling follows it at the same level and `└─` when it is the last —
 *    that is the only thing on screen saying where a subtree ENDS;
 *  - an ancestor that still has siblings coming keeps a `│` running down through everything under
 *    it, so a row three levels deep can be traced back to the node it belongs to;
 *  - SESSION rows are children of their heading, so they carry the same bars one level deeper. A
 *    heading connected to its parent above rows that are not is a tree drawn half way.
 *
 * Every prefix is padded to the widest, so the columns to their right stay in one grid — the table
 * is read across as much as down, and a ragged left edge would cost that.
 *
 * Returns `[]` when nothing is nested, which is every arrangement but the cascade: the caller then
 * pays no columns at all.
 */
export function treeGuides(rows: readonly SessionRow[]): string[] {
  const deepest = rows.reduce((n, r) => Math.max(n, r.kind === 'heading' ? r.depth ?? 0 : 0), 0)
  if (deepest === 0) return []

  /** Does another heading at exactly `depth` follow, before one that closes it? */
  const hasSibling = (from: number, depth: number): boolean => {
    for (let i = from + 1; i < rows.length; i++) {
      const r = rows[i]!
      if (r.kind !== 'heading') continue
      const d = r.depth ?? 0
      if (d < depth) return false
      if (d === depth) return true
    }
    return false
  }

  // `open[d]` — a node at depth `d` is still expecting siblings, so its bar keeps running.
  const open: boolean[] = []
  let head = 0
  const out = rows.map((row, i) => {
    if (row.kind === 'spacer') return ''
    if (row.kind === 'heading') {
      const depth = row.depth ?? 0
      open.length = depth
      open[depth] = hasSibling(i, depth)
      head = depth
      if (depth === 0) return ''
      // Level 0 is skipped: its siblings are other ROOTS, and a bar there would join two trees.
      const bars = open.slice(1, depth).map(more => (more ? '│ ' : '  ')).join('')
      return `${bars}${open[depth] ? '├─' : '└─'}`
    }
    // A session hangs off the last heading, one level deeper than it.
    if (head === 0) return ''
    return open.slice(1, head + 1).map(more => (more ? '│ ' : '  ')).join('')
  })

  // Only the SESSION rows are padded to one width, and that is the whole of the difference between
  // this and a plain indent: a heading is one string and may sit wherever its branch puts it, so
  // each level steps right — while the rows under them are a TABLE, read across as much as down,
  // and a ragged left edge would cost the grid. A heading that was padded too ended up starting a
  // column to the RIGHT of the branch hanging off it, which draws the hierarchy upside down.
  const width = out.reduce(
    (n, p, i) => (rows[i]!.kind === 'session' ? Math.max(n, p.length) : n),
    0,
  )
  return out.map((p, i) => (rows[i]!.kind === 'session' ? p.padEnd(width) : p))
}
