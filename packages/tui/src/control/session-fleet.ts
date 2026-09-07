/**
 * session-fleet.ts — PURE fleet SEMANTICS: what a row IS, how rows are searched, grouped, ordered
 * and counted, and which one the cursor is on.
 *
 * Split out of `sessions.ts` so the WEB dashboard can import the same answers the terminal cockpit
 * resolves against. `sessions.ts` is where the terminal GEOMETRY lives, and geometry is what makes
 * it unimportable: it takes `PANE_FRAME_Y` from `chrome.ts`, `chrome.ts` takes `truncate` from
 * `../components/Primitives`, and that imports Ink — so one such import puts a terminal renderer in
 * the browser bundle, where Vite cannot resolve it.
 *
 * THE RULE THIS FILE HOLDS: nothing here may take a `width` or a row count, and nothing here may
 * import `./chrome`, `./surface` or `./i18n` at VALUE level. A measurement belongs one module over.
 * `session-purity.test.ts` asserts it over this module's own source, so the build fails rather than
 * the browser.
 *
 * `sessions.ts` re-exports every name below, so no existing importer changed.
 */


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
import type { ControlSession, SessionState } from './types'

// The status vocabulary and the two row predicates live in `session-dimensions.ts`, and the ordering
// in `session-order.ts`, because `keyOf` and `buildSessionTree` need them and the dependency has to
// run one way. Re-exported here because this is the module the rest of the control center imports
// from, and moving a name is not a reason to touch nine files.
export {
  DEFAULT_ORDER, SESSION_SORTS, sessionRank, sortSessions, usageOf,
  type SessionOrder, type SessionSort,
} from './session-order'
export { breadcrumb, buildSessionTree, CRUMB_SEP } from './session-tree'
export {
  ACTIVE_STATES, OFF_STATE, SESSION_STATES, SESSION_DIMENSIONS, DIMENSION_ORDER, GROUPINGS, UNFILED,
  GONE_PROJECT_KEY, FILTERS_VERSION, DEFAULT_FILTERS, DEFAULT_MARKED, DEFAULT_SHOW_NAMED,
  SHORTCUT_STATES,
  applyShortcut, bucketKey, dayKey, dimensionValueLabel, dimensionWordBook, migrateSessionFilters,
  sessionKept, sessionNamed,
  sessionRunning, shortcutOn, storedFilters, toggleValue,
  type DimensionContext, type DimensionWordBook, type DimensionWords, type SessionDimensionId,
  type SessionFilters,
  type SessionFilterState, type SessionGroupingId, type StatusShortcut,
} from './session-dimensions'

export { DEFAULT_SESSION_VIEW } from './types'
export type { ControlSession, SessionState, SessionViewPrefs } from './types'

/**
 * The rows matching what was typed — the SAME predicate for every kind of row.
 *
 * One function rather than a filter per state: a search that quietly skipped closed conversations
 * would be a search that cannot find the thing it was most likely opened to find. `searchText` is
 * composed by the host and already carries a closed conversation's opening prompt.
 */
export function filterSessions(
  list: readonly ControlSession[],
  query: string,
  transcriptHits?: ReadonlySet<string>,
  /** The scopes the search is looking in — see `search-scope.ts`. Absent means every scope. */
  active?: ReadonlySet<SearchScope>,
): ControlSession[] {
  if (query.trim() === '') return [...list]
  return list.filter(v => matchesQuery(v.searchFields, query, {
    transcript: transcriptOf(v, transcriptHits),
  }, active))
}

/**
 * Whether the transcript search named this row's conversation.
 *
 * Only an EXACT link counts — see the same rule, and the same reason, in `session-view.ts`.
 */
export function transcriptOf(v: ControlSession, hits?: ReadonlySet<string>): boolean {
  if (!hits || hits.size === 0) return false
  return (v.conversationId !== undefined && hits.has(v.conversationId))
    || (v.resume !== undefined && hits.has(v.resume.sessionId))
}

/** The scopes one row matched, in reading order — what a row prints beside itself. */
export function rowScopes(
  v: ControlSession,
  query: string,
  transcriptHits?: ReadonlySet<string>,
  active?: ReadonlySet<SearchScope>,
): SearchScope[] {
  return matchScopes(v.searchFields, query, { transcript: transcriptOf(v, transcriptHits) }, active)
}

/** How deep the search went: how many rows carry the query in each scope. */
export function searchDepth(
  list: readonly ControlSession[],
  query: string,
  transcriptHits?: ReadonlySet<string>,
  active?: ReadonlySet<SearchScope>,
): ScopeCounts {
  return scopeCounts(
    list.map(v => ({ fields: v.searchFields, transcript: transcriptOf(v, transcriptHits) })),
    query,
    active,
  )
}

export function attentionOf(list: readonly ControlSession[]): number {
  return list.filter(s => s.state === 'waiting' || s.state === 'waiting-approval').length
}

// ---------------------------------------------------------------------------
// grouping
// ---------------------------------------------------------------------------

/**
 * Grouping is a DIMENSION ID, plus the one arrangement that is not a dimension.
 *
 * It used to be a hand-written union sitting beside a differently-shaped set of filters, which is
 * the two-lists-of-one-fact defect `session-dimensions.ts` exists to remove. The alias is kept
 * because half the control center names this type.
 */
export type SessionGrouping = SessionGroupingId

export interface SessionGroup {
  key: string
  /** Display-ready. An empty key is a fact that was never recorded, and says so in words. */
  label: string
  sessions: ControlSession[]
  /** A TASK the user has marked finished. Only ever set while grouping by task. */
  done?: boolean
  /**
   * How far to INDENT this group's heading. Only the cascade sets it; every flat arrangement is
   * one level deep by construction, and an absent depth reads as zero.
   */
  depth?: number
  /**
   * The node labels from the root down to this group — what a card band's breadcrumb is built from.
   *
   * Only the cascade sets it. A flat band is named by one word and has nothing to trace back to.
   */
  path?: readonly string[]
}

/**
 * Group the fleet along one dimension.
 *
 * `unknownLabels` are supplied by the caller because they are LOCALIZED chrome and this module owns
 * no strings — the same split the rest of the control center keeps. An empty key never shares one
 * blank heading across dimensions: "harness unknown" and "no model recorded" are different facts,
 * and a heading that reads as a category when it is really an absence is how a list starts lying.
 */
export function groupSessions(
  list: readonly ControlSession[],
  by: SessionGrouping,
  /**
   * Every dimension's words, so a band and the chip that selects it read the SAME name.
   *
   * The whole book rather than one dimension's slice: the caller resolves its strings once, and a
   * screen that offers seven groupings would otherwise pick the slice itself on every render — one
   * more place to pick the wrong one.
   */
  words: DimensionWordBook,
  /** The tasks the user marked finished — a statement about the WORK, not about any session. */
  doneTasks: readonly string[] = [],
  order: SessionOrder = DEFAULT_ORDER,
  ctx: DimensionContext = {},
  /**
   * Draw the directory CASCADE inside each band — a VIEW, not a grouping.
   *
   * It used to be one of the groupings, which forced a choice nobody should have to make: the
   * cascade answers "which directory is this session in" and the grouping answers "what do these
   * bands stand for", and picking the tree meant giving up every other band. Composed instead: the
   * grouping decides the bands, and inside each one the sessions cascade by project and then by the
   * segments of their `cwd`.
   *
   * `tree` survives as a grouping id so a stored preference still parses; the menu no longer offers
   * it and `migrateSessionFilters` rewrites it to `none` + cascade.
   */
  cascade = false,
): SessionGroup[] {
  // The CASCADE returns the same shape, already in reading order, with `depth` and `path` on top —
  // which is what lets every consumer below keep working without knowing a tree exists. Dispatched
  // here rather than by each caller, for the same reason `none` is: three surfaces arrange a fleet,
  // and an arrangement one of them has not been told about is one that silently does not exist.
  if (by === 'tree' || (cascade && by === 'none')) {
    return buildSessionTree(list, words, doneTasks, order, ctx)
  }
  if (by === 'none') return [{ key: '', label: '', sessions: sortSessions(list, order) }]

  const groups = new Map<string, SessionGroup>()
  for (const s of list) {
    // The SAME `keyOf` the filter reads. Deriving the bucket here as well is how the chip
    // "status: waiting" and the band "waiting" come to show different sets with nothing failing.
    const key = bucketKey(s, by, ctx)
    const label = dimensionValueLabel(words[by], key)
    const found = groups.get(key)
    if (found) found.sessions.push(s)
    else {
      const done = by === 'task' && key !== UNFILED && doneTasks.includes(key)
      groups.set(key, { key, label, sessions: [s], ...(done ? { done: true } : {}) })
    }
  }

  // Groups ordered by their most urgent member, so the box holding a blocked session is the one at
  // the top — grouping must not bury the thing the screen exists to surface.
  const ordered = [...groups.values()]
    .map(g => ({ ...g, sessions: sortSessions(g.sessions, order) }))
    .sort((a, b) => {
      const byRank = sessionRank(a.sessions[0]!) - sessionRank(b.sessions[0]!)
      return byRank !== 0 ? byRank : a.label.localeCompare(b.label)
    })
  if (!cascade) return ordered
  // The bands stay exactly as they were — same keys, same order, same `done` marks — and each one's
  // sessions become the tree they were already in. The band is the parent node, so it keeps its
  // heading and its rows hang below it.
  return ordered.flatMap(g => cascadeInside(g, by, words, doneTasks, order, ctx))
}

/**
 * One band's sessions, expanded into the directory cascade beneath it — PURE.
 *
 * The cascade's own root is the PROJECT. Grouped BY project that root is the band's own name, so it
 * is dropped and its sessions hang directly under the band — the same rule the `where` column and
 * the closed block follow, and for the same reason: a heading repeating the heading above it says
 * nothing and costs a row. Under every other grouping the project IS new information (a task spans
 * two repositories, a harness spans everything) and stays as the first level.
 *
 * The band itself is emitted with `path`, which is what makes `sessionRows` draw it as a branch —
 * headings and counts included — when it has no sessions of its own.
 */
function cascadeInside(
  g: SessionGroup,
  by: SessionGrouping,
  words: DimensionWordBook,
  doneTasks: readonly string[],
  order: SessionOrder,
  ctx: DimensionContext,
): SessionGroup[] {
  const sub = buildSessionTree(g.sessions, words, doneTasks, order, ctx)
  // Keys are prefixed by the band's own, so two folders of the same name under two bands stay two
  // nodes — the same rule `buildSessionTree` applies to its own paths.
  const keyed = (x: SessionGroup) => `${g.key}\u0000${x.key}`
  const roots = sub.filter(x => (x.depth ?? 0) === 0)
  // Grouped by project there is exactly one root and it is this band. More than one would mean the
  // band and the project dimension disagreed about which project a row is in, which cannot happen —
  // both call `bucketKey(s, 'project')` — and if it ever did, keeping the roots is the honest answer.
  if (by === 'project' && roots.length === 1) {
    const root = roots[0]!
    return [
      { ...g, sessions: root.sessions, depth: 0, path: [g.label] },
      ...sub.filter(x => x !== root).map(x => ({
        ...x,
        key: keyed(x),
        depth: x.depth ?? 0,
        path: [g.label, ...(x.path ?? []).slice(1)],
      })),
    ]
  }
  return [
    { ...g, sessions: [], depth: 0, path: [g.label] },
    ...sub.map(x => ({
      ...x,
      key: keyed(x),
      depth: (x.depth ?? 0) + 1,
      path: [g.label, ...(x.path ?? [])],
    })),
  ]
}

/**
 * The groups flattened into the rows the screen actually draws, headings included.
 *
 * One list rather than nested loops because the CURSOR moves over it: with headings drawn separately
 * the selected index and the drawn rows are two different countings of one screen, and they agree
 * until the first group boundary.
 */
export type SessionRow =
  | {
      kind: 'heading'
      label: string
      count: number
      muted?: boolean
      /** How far to indent — the cascade's branch depth. Absent is flat, which is every other
       *  arrangement. */
      depth?: number
      /**
       * The node labels from the root down to this heading, for the card band's breadcrumb.
       *
       * Its LAST element is whatever this heading actually reads, suffix included — so the grid and
       * the list can never name one branch two different ways.
       */
      path?: readonly string[]
    }
  /** A blank line between sections. Air INSIDE a list is what makes its sections readable. */
  | { kind: 'spacer' }
  | { kind: 'session'; session: ControlSession }

/**
 * Flatten the groups into the rows actually drawn — headings and the air between them included.
 *
 * Two things happen here that grouping alone does not give you:
 *
 *  - **History is always its own section.** A conversation that is CLOSED is not a session that is
 *    running, and putting the two in one undifferentiated run made the list read as if seven things
 *    were open when three of them had been over for a day. Even with grouping off, the closed rows
 *    get their own heading.
 *  - **A blank line before each heading.** The sections were distinguishable only by reading every
 *    row's first word, which is not a visual hierarchy — it is a list that happens to be sorted.
 *
 * One flat list rather than nested loops because the CURSOR moves over it: with headings drawn
 * separately, the selected index and the drawn rows are two different countings of one screen, and
 * they agree right up until the first group boundary.
 */
export function sessionRows(
  groups: readonly SessionGroup[],
  closedLabel?: string,
  /** Already-localized word marking a finished task's heading, e.g. "finished". */
  doneLabel?: string,
  /**
   * Already-localized word for the sessions the machine took at once, e.g. "fell together".
   *
   * Absent — on a machine where nothing fell, and in the tests that predate the section — leaves
   * those rows exactly where they used to be, in the history block. The section is an addition to
   * the reading order, never a change to which rows are listed.
   */
  fellLabel?: string,
  /**
   * The rows the user MARKED, and what to call their band.
   *
   * Marking a row exists for exactly one purpose — finding it again — and a glyph on a line that
   * stays wherever the ordering left it does not serve it. So marked rows become a BAND AT THE TOP,
   * in the same shape as every other band here.
   *
   * Three rules, and the third is the one that makes the feature work:
   *  - the band is absent when nothing is marked (a band with a title and no rows is a box with a
   *    name in it);
   *  - it applies under EVERY arrangement, `none` included — marking is the user's, and it outranks
   *    the grouping;
   *  - a marked row appears in the band and NOWHERE ELSE. The same session in two places is the
   *    reason someone was hunting for it.
   *
   * It lives here rather than in a component because `cardPages` walks these very rows: the card
   * grid gets the band for free, and cannot disagree with the list about which group a row is in.
   */
  marked?: { ids: ReadonlySet<string>; label: string },
): SessionRow[] {
  const out: SessionRow[] = []
  const isMarked = (s: ControlSession) => marked?.ids.has(s.id) ?? false

  /**
   * The cascade's extras for a heading, if this group has any.
   *
   * The crumb's last element is replaced by the heading's ACTUAL words, so a suffixed block
   * (`packages/tui · closed`) reads the same in the card band as it does in the list.
   */
  const branch = (g: SessionGroup | undefined, head: string) => (g?.path
    ? { ...(g.depth ? { depth: g.depth } : {}), path: [...g.path.slice(0, -1), head] }
    : {})

  const push = (
    label: string,
    sessions: readonly ControlSession[],
    muted?: boolean,
    group?: SessionGroup,
  ) => {
    if (sessions.length === 0) return
    // Air BETWEEN bands, never between a node and its own first child: inside the cascade that blank
    // reads as the end of the block, which is the one thing the guides exist to say correctly. The
    // last row being a heading shallower than this group's depth is exactly "this hangs off that".
    const last = out[out.length - 1]
    const nested = last?.kind === 'heading' && (last.depth ?? 0) < (group?.depth ?? 0)
    if (out.length > 0 && !nested) out.push({ kind: 'spacer' })
    if (label !== '') {
      out.push({
        kind: 'heading', label, count: sessions.length, ...(muted ? { muted } : {}),
        ...branch(group, label),
      })
    }
    for (const session of sessions) out.push({ kind: 'session', session })
  }

  // "Live" is a stricter question than "not closed": a session whose command has EXITED is not
  // running either, and leaving it among the working ones is what made a finished session sit in
  // the live list looking like something you could still talk to. `lost` joins it — the backend has
  // no idea what happened to it, so it is certainly not something you are working in.
  const isLive = (s: ControlSession) =>
    s.state !== 'closed' && s.state !== 'exited' && s.state !== 'lost'
  // A row the machine TOOK, carved out of the history block it would otherwise sit in. It is not
  // history: it is work that was open a moment ago and is one action away from being open again,
  // and burying it among conversations that ended days ago is what made "reopen what I lost" a
  // matter of reading forty rows first.
  const hasFell = Boolean(fellLabel)
  const isFell = (s: ControlSession) => hasFell && s.fell === true && !isLive(s)

  // The marked band leads, drawn from every group so a mark outranks the arrangement. It is ONE
  // band rather than the live/fell/closed split the groups get: a marked conversation that is over
  // is still the one you marked, and filing it under history is putting it back where it was hard
  // to find.
  if (marked) {
    push(marked.label, groups.flatMap(g => g.sessions.filter(isMarked)))
  }

  /**
   * How many sessions this BRANCH will actually draw beneath it — the cascade's heading-only count.
   *
   * Counted over the descendants that follow, and only the ones surviving the marked band, rather
   * than read off a subtree total stored at build time. A heading claiming two over one drawn row is
   * the same class of lie as a confident zero, and the band above takes rows out of every group.
   *
   * Depth-first order is what makes this local: the descendants of a node are exactly the groups
   * following it until one comes back up to its own level.
   */
  const drawnBelow = (at: number): number => {
    const depth = groups[at]!.depth ?? 0
    let n = 0
    for (let i = at + 1; i < groups.length; i++) {
      if ((groups[i]!.depth ?? 0) <= depth) break
      n += groups[i]!.sessions.filter(s => !isMarked(s)).length
    }
    return n
  }

  groups.forEach((g, at) => {
    // Everything the band above took is gone from here — the same row twice is the bug, not the
    // feature. A group left empty by this simply draws nothing: `push` skips it.
    const rest = g.sessions.filter(s => !isMarked(s))
    const live = rest.filter(isLive)
    const fell = rest.filter(isFell)
    // Most recently off FIRST. A block of nineteen finished conversations is read from the top, and
    // the one that ended twenty minutes ago is the one being looked for — the arrangement's own
    // ordering has no opinion about it, since every row in here shares a state. A row with no
    // measured end sorts last rather than to the top: unknown is not recent.
    const closed = rest.filter(s => !isLive(s) && !isFell(s))
      .slice()
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    // An empty KEY is an absence ("no task"), not a category, and is drawn as one. A FINISHED task
    // says so in its heading and is muted with it: the sessions are still listed and still
    // attachable, so the screen must say why they are set apart rather than merely dimming them.
    const head = g.done && doneLabel ? `${g.label} · ${doneLabel}` : g.label
    // A cascade BRANCH holding no session of its own is still a row: it is the name of the branch,
    // and `push` — which skips an empty group, correctly, for every flat arrangement — would delete
    // exactly the structure this arrangement is. Its count is what is drawn below it.
    if (rest.length === 0 && g.path && head !== '') {
      const below = drawnBelow(at)
      // Nothing left under it either: the branch is not merely empty, it is not there. A heading
      // with a name and nothing named is the box-with-a-name-in-it the marked band already refuses.
      if (below > 0) {
        const last = out[out.length - 1]
        const nested = last?.kind === 'heading' && (last.depth ?? 0) < (g.depth ?? 0)
        if (out.length > 0 && !nested) out.push({ kind: 'spacer' })
        out.push({ kind: 'heading', label: head, count: below, ...branch(g, head) })
      }
      return
    }
    // Inside a NAMED group the closed rows simply continue under its heading, most recently off
    // first. They used to get a second heading of their own — `ads-propostas · off  19` under
    // `ads-propostas  1` — which repeats the group's name to say a thing every one of those rows
    // already says in its own `state` cell, and splits one project into two bands a screen apart.
    // In the UNGROUPED arrangement the heading is kept: there is no group name above them, so that
    // word is the only thing separating what is running from what is over.
    const inlineClosed = g.label !== '' && closed.length > 0
    push(head, inlineClosed ? [...live, ...closed] : live, g.key === '' || Boolean(g.done), g)
    if (fell.length > 0) {
      // NOT muted: everything else set apart on this screen is set apart because it is over, and
      // this block is the opposite — it is the one thing on the list asking to be acted on.
      const label = fellLabel ?? ''
      push(g.label !== '' && label ? `${g.label} · ${label}` : label, fell, undefined, g)
    }
    if (closed.length > 0 && !inlineClosed) {
      push(closedLabel ?? '', closed, true, g)
    }
  })
  return out
}

/** Index of the nth selectable row, so the cursor never lands on a heading or a blank. */
export function selectableIndexes(rows: readonly SessionRow[]): number[] {
  const out: number[] = []
  rows.forEach((r, i) => { if (r.kind === 'session') out.push(i) })
  return out
}

/**
 * The session id at a selectable POSITION, or undefined when the position names no row.
 *
 * `at` indexes `selectable` (the session rows), not `rows` (which also holds headings and spacers);
 * this is the one place that resolves the two so no call site has to do the double indirection by
 * hand and get it subtly wrong.
 */
export function idAtRow(
  rows: readonly SessionRow[],
  selectable: readonly number[],
  at: number,
): string | undefined {
  const row = rows[selectable[at] ?? -1]
  return row?.kind === 'session' ? row.session.id : undefined
}

/**
 * WHICH row the selection is on — resolved by IDENTITY, not by a raw position.
 *
 * The list re-sorts under the cursor constantly: the fleet polls every five seconds, and marking a
 * row lifts it to the top band. A selection kept as a bare index therefore names a DIFFERENT session
 * one frame later — and a destructive verb (`x` kills, and the loss is silent) fired in that frame
 * hits the wrong one. That is exactly why the MARK set is kept by id; the cursor must be too.
 *
 * Given the id the cursor is glued to, this returns that session's CURRENT index, wherever the sort
 * left it. Only when the glued id is no longer in the list — the session ended, a filter dropped it —
 * does it fall back to the last numeric position, clamped into range, which is what keeps the cursor
 * sensible on the row that slid into its place. `-1` on an empty list, as before.
 */
export function selectedRow(
  rows: readonly SessionRow[],
  selectable: readonly number[],
  glueId: string | undefined,
  cursor: number,
): number {
  if (selectable.length === 0) return -1
  if (glueId !== undefined) {
    const found = selectable.findIndex(r => {
      const row = rows[r]
      return row?.kind === 'session' && row.session.id === glueId
    })
    if (found >= 0) return found
  }
  return Math.min(Math.max(0, cursor), selectable.length - 1)
}

/**
 * The arrangement to DRAW while a search is active — one flat list, newest first.
 *
 * Grouping a search spreads its hits across bands and cascades and makes you sweep the whole screen
 * for them; the answer to "where did that session go" is a single flat list ordered by last
 * activity. This applies ONLY while a query is present: with none, it returns the user's own
 * grouping, cascade and order untouched — which is what makes leaving the search restore the
 * arrangement with nothing to undo, because the stored state was never changed to begin with.
 */
export function searchArrangement(
  querying: boolean,
  grouping: SessionGrouping,
  cascade: boolean,
  order: SessionOrder,
): { grouping: SessionGrouping; cascade: boolean; order: SessionOrder } {
  if (!querying) return { grouping, cascade, order }
  return { grouping: 'none', cascade: false, order: { by: 'recent', dir: 'desc' } }
}

// ---------------------------------------------------------------------------
// the row
// ---------------------------------------------------------------------------

export interface DetailLine {
  key: string
  /** Empty for a full-width sentence rather than a labelled fact. */
  label: string
  value: string
  /** A caveat rather than a fact — rendered dim. */
  note?: boolean
  /** A line the assistant itself wrote, rendered in the text colour rather than as a label. */
  say?: boolean
  /**
   * Who wrote this line, when it is known EXACTLY — from a chat turn read off the session's own
   * transcript (`ChatTurn`), never guessed from the screen. Absent for a raw `lastLines` fallback
   * line, which carries `say` but no verified author.
   */
  role?: 'user' | 'assistant'
}

/**
 * Everything the pane can say about one session, most identifying first.
 *
 * Pure and separate from the component because the LAYOUT needs the count before anything is drawn:
 * a detail pane sized to a constant leaves dead rows under it when it has less to say, and the
 * control center's own rule calls air under a pane a fault. Here the pane asks for exactly what it
 * has, and the list absorbs the difference — a list with room to grow is a list, not air.
 *
 * The labels arrive already localized, for the same reason `groupSessions` takes its headings: this
 * module owns no strings.
 */
export function detailLines(s: ControlSession, labels: {
  where: string
  model: string
  note: string
  started: string
  external: string
  /** Said on a conversation that is not running — a different fact from "started elsewhere". */
  closed: string
  doing: string
  task: string
  metrics: string
  /**
   * What the usage figure COUNTS, in words — `in + out + cache`.
   *
   * The number is every token the conversation recorded (input, output, cache read and cache
   * write; `conversations.ts` sums the four), and read beside a cost it is naturally taken for the
   * in/out pair alone — which is the reading that makes it look ten times too big, since a cached
   * read dwarfs the input on every long session. The row is the only surface with room to say so.
   */
  metricsAll: string
  /** Heads the spelled-out gauge: `45%  ·  455.4k / 1M`. */
  context: string
  /**
   * Heads the conversation this row continues from — the id `--resume` takes.
   *
   * Worth a row of its own because it is the one fact that turns "this session is somewhere" into
   * something a person can act on outside agentop, and because it is only ever shown when it was
   * RECORDED: a row without it is a row where nobody knows, and `conversationBlind` says so.
   */
  conversation: string
  /**
   * Labels for the OTHER name, when a session is named in both places.
   *
   * Two of them, because which one is the other depends on which one won — and a single label
   * saying "also called" would leave a person unable to tell whether the name on the row is the one
   * they typed here or the one they typed inside the session. That distinction is the entire point:
   * it is what says both renames landed.
   */
  alsoLabel: string
  alsoHarness: string
  /**
   * How to LEAVE an attached session, already localized, and the real keystroke the backend
   * reported — never an assumed `Ctrl-b`.
   *
   * Said HERE, on the row you would attach to, because it used to be printed once as the terminal
   * was handed over and then scrolled away under whatever the session drew next. A user who cannot
   * get out is stranded in a buffer that hides their shell, and "read it before you press enter" is
   * not a thing anyone does.
   */
  detach?: { label: string; keys: string }
}, ago: (startedAt: number) => string): DetailLine[] {
  const out: DetailLine[] = []

  // WHAT IT IS SAYING comes first, because it is the reason someone selected the row. Everything
  // below is context for it. `chatTurns` — role-tagged, read from the session's own transcript —
  // is preferred whenever it is available; `lastLines` (the raw screen tail) is the fallback for
  // every harness that has no exact way to read its own transcript live. See `chat-tail.ts`.
  if (s.chatTurns?.length) {
    s.chatTurns.forEach((turn, i) => {
      out.push({
        key: `chat${i}`,
        label: i === 0 ? labels.doing : '',
        // A turn is the transcript's own text, which can span several lines — collapsed to one so
        // it truncates the same way every other detail line does rather than breaking the pane's
        // one-fact-per-row shape.
        value: turn.text.replace(/\s*\n\s*/g, ' '),
        // A `pending` turn is not something either side SAID — it is "a tool call is running and
        // nothing has followed it yet", drawn dim like every other status line on this pane rather
        // than in either role's colour, which would claim an author for a note neither of them wrote.
        say: turn.role === 'assistant' && !turn.pending,
        role: turn.pending ? undefined : turn.role,
        note: turn.pending === true,
      })
    })
  } else if (s.lastLines?.length) {
    s.lastLines.forEach((line, i) => {
      out.push({ key: `say${i}`, label: i === 0 ? labels.doing : '', value: line, say: true })
    })
  }

  // The name that did NOT win, right under what it is saying and above everything else, because it
  // answers "did my rename work" — which is the question someone has the moment they notice the row
  // saying something other than what they typed. The label names WHICH place it came from.
  if (s.titleOther) {
    out.push({
      key: 'also',
      // `titleSource` is where the WINNER came from, so the loser is the other place.
      label: s.titleSource === 'harness' ? labels.alsoLabel : labels.alsoHarness,
      value: s.titleOther,
    })
  }
  out.push({ key: 'where', label: labels.where, value: s.cwd })
  if (s.task) out.push({ key: 'task', label: labels.task, value: s.task })
  if (s.model) out.push({ key: 'model', label: labels.model, value: s.model })
  // Tokens and cost only where the conversation actually recorded them. Absent is never rendered as
  // zero — the same N/A-versus-a-confident-0 rule the dashboard applies to harness capabilities.
  if (s.tokens || s.cost) {
    // The parenthetical rides the TOKEN figure, so a row carrying only a cost never claims a
    // breakdown it is not showing.
    const tokens = s.tokens ? `${s.tokens} (${labels.metricsAll})` : ''
    out.push({
      key: 'metrics',
      label: labels.metrics,
      value: [tokens, s.cost].filter(Boolean).join('  ·  '),
    })
  }
  // The gauge SPELLED OUT: the bar on the row is a glance, and this is the only place the two
  // numbers behind it are legible. Without them a percentage is unauditable — you cannot tell a
  // reading against the right window from one against the wrong one, which is the single most
  // useful thing to be able to check about this feature.
  if (s.context) {
    out.push({
      key: 'context',
      label: labels.context,
      value: `${s.context.label}  ·  ${s.context.used} / ${s.context.window}`,
    })
  }
  // Where it continues from. Under the metrics because it is the fact you copy rather than read.
  if (s.conversationId) {
    out.push({ key: 'conv', label: labels.conversation, value: s.conversationId })
  }
  if (s.note) out.push({ key: 'note', label: labels.note, value: s.note })
  if (s.startedAt !== undefined) {
    out.push({ key: 'started', label: labels.started, value: ago(s.startedAt) })
  }
  // The two caveats, last and dim. Each is a statement the state word cannot make on its own, and
  // each is present only where it is TRUE — an absent caveat is not a reassurance, it is silence.
  // The two non-actionable rows are non-actionable for DIFFERENT reasons, and one sentence for both
  // said "started outside agentop" about a conversation that agentop may well have started and that
  // is simply over.
  // Only where attaching is actually offered: on a closed or external row it would answer a
  // question the screen is not letting anyone ask.
  if (labels.detach && s.actionable && s.state !== 'closed') {
    out.push({ key: 'detach', label: labels.detach.label, value: labels.detach.keys })
  }
  if (s.state === 'closed') out.push({ key: 'closed', label: '', value: labels.closed, note: true })
  else if (!s.actionable) out.push({ key: 'external', label: '', value: labels.external, note: true })
  // The directory first: it is the caveat that explains the others — a path that resolves to
  // nothing is why the project may be a bucket and why reopening will fail.
  if (s.dirGone) out.push({ key: 'gone', label: '', value: s.dirGone, note: true })
  if (s.approvalBlind) out.push({ key: 'blind', label: '', value: s.approvalBlind, note: true })
  if (s.conversationBlind) {
    out.push({ key: 'convblind', label: '', value: s.conversationBlind, note: true })
  }
  return out
}

/**
 * How long ago a row that is not running WENT OFF — PURE, and EMPTY for one that is.
 *
 * It used to measure from `startedAt`, under a heading that said `started`, which is the wrong
 * question on the only rows that draw it: a block of finished conversations is read by which of
 * them ended most recently, and "started 96h ago" says nothing about whether that one is the work
 * of this morning or of last week. `endedAt` is that instant, and there is NO FALLBACK to the
 * start time — a start age printed under a heading naming the end is a wrong number rather than a
 * missing one, and this column has always been allowed to be blank.
 *
 * `now` is passed in rather than read: this is called on every repaint and a clock inside it would
 * make the column's width depend on the second it was measured in.
 */
export function sessionAge(s: ControlSession, now: number, ago: (seconds: number) => string): string {
  if (sessionRunning(s) || s.endedAt === undefined) return ''
  return ago(Math.max(0, Math.round((now - s.endedAt) / 1000)))
}

/** Does this row want a person? The one predicate the dot, the counter and the bell all read. */
export function sessionNotify(s: ControlSession): boolean {
  return s.state === 'waiting' || s.state === 'waiting-approval'
}

/** How much of a session id a row shows. Enough to be unambiguous in practice, and to type. */
export const ID_CELL = 5

/**
 * The handle: the leading characters of whatever identity this row actually has.
 *
 * **Every session has an id, so every row shows one.** This returned `''` for external and closed
 * rows, reasoning that a synthetic id is a handle `agentop session attach` cannot resolve. That
 * protected one command at the cost of the column: a table where some rows have no id reads as data
 * missing, and the reader cannot refer to those rows at all — not in a note, not out loud, not to
 * an assistant.
 *
 * The identity is taken in order of how resolvable it is:
 *
 *  1. **A row agentop hosts** — its own id. `attach`, `kill` and `rename` take a prefix of it.
 *  2. **A row naming a CONVERSATION** (`resume`) — the conversation id. Not attachable, but it is
 *     exactly what reopening resolves, so it is a handle for the one verb the row offers.
 *  3. **Anything else** — the trailing distinguishing part of the synthetic id. It resolves no
 *     command and still tells two rows apart, which is the column's other job.
 */
export function sessionHandle(s: ControlSession): string {
  if (!s.id.startsWith('external:') && !s.id.startsWith('closed:')) return s.id.slice(0, ID_CELL)
  const conversation = s.resume?.sessionId
  if (conversation) return conversation.slice(0, ID_CELL)
  // `external:<harness>:<cwd>:<startedMs>` — the start time is what separates two assistants open in
  // one directory, which is precisely the pair a reader needs to tell apart.
  return s.id.slice(s.id.lastIndexOf(':') + 1).slice(-ID_CELL)
}

/**
 * What a worktree row is CALLED — its own directory name, or `''` when it is not one.
 *
 * The folder cell shows the PROJECT once the project grouping keys on the main checkout, so this is
 * the cell that says which checkout of it you are looking at. The NAME rather than the word
 * "worktree": a cell repeating one word on every such row told you the kind and never which one,
 * and three checkouts of one repository are told apart by exactly this.
 */
export function worktreeName(s: ControlSession): string {
  return s.worktree ? s.project : ''
}

/**
 * How full is "too full" — the threshold the row changes colour at.
 *
 * Two of them rather than one, because they answer different questions: `warn` is "start thinking
 * about wrapping this up", `full` is "the window this was measured against is exceeded and the
 * reading past it is no longer a proportion of anything". `full` is deliberately 1 exactly, not
 * 0.95: past it the number is not a warning, it is a different kind of statement.
 */
export const CONTEXT_WARN = 0.8

export const CONTEXT_FULL = 1

export type ContextLevel = 'ok' | 'warn' | 'full'

export function contextLevel(fraction: number): ContextLevel {
  if (fraction >= CONTEXT_FULL) return 'full'
  if (fraction >= CONTEXT_WARN) return 'warn'
  return 'ok'
}

/**
 * How many sessions each PROJECT directory has — PURE, and counted over the whole fleet.
 *
 * Same rule as `taskCounts`: the count is what says a project has work in it, and counting after
 * the filters would report the number the filter left.
 */
export function projectCounts(list: readonly ControlSession[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const s of list) {
    if (!s.project) continue
    counts.set(s.project, (counts.get(s.project) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name))
}

/**
 * How many sessions each task has — PURE, and counted over the WHOLE fleet.
 *
 * Over the whole fleet rather than the filtered list, because the count is what tells you a task
 * has work in it: computing it after the filters would make picking a task report the number the
 * filter left, which is the one number nobody is asking for.
 */
export function taskCounts(list: readonly ControlSession[]): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const s of list) {
    if (!s.task) continue
    counts.set(s.task, (counts.get(s.task) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name))
}

/** What the wizard has collected so far. Only two of them are required to start anything. */
export interface SessionDraft {
  harness?: { id: string; supportsModel?: boolean }
  cwd?: string
  task?: string
  /** The name the user typed for this session. Absent means "no name of my own" — the row derives one. */
  label?: string
  prompt?: string
  model?: string
  effort?: string
}

export type SubmitPlan =
  | { ok: true; req: { harness: string; cwd: string; attach: boolean } & Record<string, unknown> }
  /** `step` is where the missing answer is given, so a refusal is a way BACK rather than a dead end. */
  | { ok: false; reason: 'no-host' | 'no-harness' | 'no-cwd'; step?: 'harness' | 'where' }

/**
 * What pressing the last `enter` of the wizard should do — PURE.
 *
 * It exists because the component's version returned SILENTLY when it had nothing to spawn with:
 * `if (!spawn || !draft.harness || !draft.cwd) return`. The final keystroke of a six-step wizard
 * did nothing at all, with no way to tell a dead key from a slow one — and the prompt someone had
 * just typed was still on screen, about to be thrown away by whatever they pressed next.
 *
 * Every refusal now NAMES itself and, where there is one, names the step that takes the missing
 * answer. The caller reports it and stays put; nothing typed is discarded.
 */
export function planSubmit(o: {
  draft: SessionDraft
  hasSpawn: boolean
  attach: boolean
}): SubmitPlan {
  if (!o.hasSpawn) return { ok: false, reason: 'no-host' }
  if (!o.draft.harness) return { ok: false, reason: 'no-harness', step: 'harness' }
  if (!o.draft.cwd) return { ok: false, reason: 'no-cwd', step: 'where' }
  return {
    ok: true,
    req: {
      harness: o.draft.harness.id,
      cwd: o.draft.cwd,
      attach: o.attach,
      // Only what was actually answered travels: an empty model is not a model called "".
      ...(o.draft.model ? { model: o.draft.model } : {}),
      ...(o.draft.effort ? { effort: o.draft.effort } : {}),
      ...(o.draft.prompt ? { prompt: o.draft.prompt } : {}),
      ...(o.draft.task ? { task: o.draft.task } : {}),
      ...(o.draft.label ? { label: o.draft.label } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// what every key on this screen does
// ---------------------------------------------------------------------------

/**
 * Can this row be closed at all?
 *
 * Only a session agentop HOSTS: an external process is someone else's to stop, and a closed
 * conversation has nothing running to end. A row that cannot take it draws no glyph — a control
 * that is visible and refuses is worse than one that is absent.
 */
export function canClose(s: ControlSession): boolean {
  return s.actionable && s.state !== 'closed' && s.state !== 'exited'
}

// ---------------------------------------------------------------------------
// the cascade's own lines
// ---------------------------------------------------------------------------
