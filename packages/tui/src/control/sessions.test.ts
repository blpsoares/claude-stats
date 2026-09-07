import { describe, expect, it } from 'bun:test'
import {
  attentionOf, detailLines, groupSessions, rowWidth, treeGuides, selectableIndexes, sessionActions, sessionCells,
  selectedRow, idAtRow, searchArrangement,
  sessionRows, sortSessions, summaryCells, actionLabels, enabledActionIndexes,
  sessionColumns, sessionsCockpit, asideRows, asideSelectable, projectCounts, projectColumns,
  projectPickRows, groupProjects, asideSections, asideFold, scrollBar, THUMB, TRACK, sessionNamed,
  sessionHandle, worktreeName, sessionRunning, asideRowKey, resolveAsideCursor,
  sessionAge, sessionKeyHelp, keyHelpColumn, closeCellWidth, canClose,
  DEFAULT_ORDER, usageOf, planSubmit,
  cardGrid, cardPages, pageOfCard, CARD_PAGE_MAX, CARD_MIN_WIDTH, CARD_GAP, CARD_LINES,
  cardBadges, cardLines, fitCardLines, cardStateCells, cardLabelWidth, CARD_VALUE_MIN,
  cardBand, cardHit, cardStep, cardRows, cardPageRows, pagerCells, pagerHit,
  contextBar, contextLevel, sessionContext,
  askRows, fitApprovalPreview, APPROVAL_PREVIEW_MAX, QUESTION_ROWS, CARD_MIN_LINES,
  type CardBand, type CardLine, type SessionRow,
  dimensionWordBook,
  GROUPINGS,
  CLOSE_CELL,
  buildSessionTree,
} from './sessions'
import type { ControlSession, SessionState } from './types'
import { PANE_FRAME_Y } from './chrome.ts'
import { controlStrings } from './i18n'

/** The layout block every aside fixture carries — it is a required option, like the groupings. */
const LAYOUT = {
  heading: 'LAYOUT',
  words: { list: 'list', cards: 'cards' } as const,
  value: 'list' as const,
}

const UNKNOWN = dimensionWordBook({
  labels: {
    day: 'day',
    status: 'state', harness: 'harness', model: 'model', project: 'project', repo: 'repository',
    task: 'task', marked: 'marked',
  },
  unfiled: {
    day: 'no date',
    status: 'state unrecorded', harness: 'harness unknown', model: 'no model recorded',
    project: 'no directory', task: 'no task', repo: 'no repository', marked: 'not marked',
  },
  states: {
    working: 'working', waiting: 'waiting', 'waiting-approval': 'needs approval',
    exited: 'ended', lost: 'lost', closed: 'closed', unknown: 'unknown',
  },
  goneProject: 'directory no longer exists',
  marked: 'marked',
})

const session = (id: string, over: Partial<ControlSession> = {}): ControlSession => ({
  id,
  title: id,
  harness: 'claude',
  cwd: `/repo/${id}`,
  project: id,
  state: 'waiting' as SessionState,
  stateLabel: 'waiting',
  actionable: true,
  attached: false,
  searchFields: { name: id, folder: '', harness: '', note: '', task: '', prompt: '' },
  ...over,
})

describe('sortSessions', () => {
  it('puts what is waiting on a person above what is running', () => {
    const list = [
      session('w', { state: 'working', stateLabel: 'working' }),
      session('x', { state: 'exited', stateLabel: 'exited' }),
      session('a', { state: 'waiting-approval', stateLabel: 'needs approval' }),
      session('k'),
    ]
    expect(sortSessions(list).map(s => s.id)).toEqual(['a', 'k', 'w', 'x'])
  })

  it('puts an external session last, whatever its age', () => {
    const list = [
      session('e', { state: 'unknown', stateLabel: 'external', actionable: false, startedAt: 999 }),
      session('w', { state: 'working', stateLabel: 'working', startedAt: 1 }),
    ]
    expect(sortSessions(list).map(s => s.id)).toEqual(['w', 'e'])
  })

  it('breaks a tie on the newest', () => {
    const list = [session('old', { startedAt: 1 }), session('new', { startedAt: 2 })]
    expect(sortSessions(list).map(s => s.id)).toEqual(['new', 'old'])
  })
})

describe('selectedRow — the cursor follows the session by IDENTITY', () => {
  // The rows a `groupSessions('none', …)` would draw for these sessions, flattened. No headings, so
  // every row is selectable — a spacer/heading in the middle is exercised separately below.
  const rowsOf = (...ids: string[]): SessionRow[] =>
    ids.map(id => ({ kind: 'session', session: session(id) }))

  it('returns the index of the glued id even after the list reorders under the cursor', () => {
    // The user selected 'b' (at position 1). A poll reorders the fleet so 'b' is now last.
    const before = rowsOf('a', 'b', 'c')
    const after = rowsOf('c', 'a', 'b')
    const sel = selectableIndexes(after)
    // Glued to 'b', the resolved row is wherever 'b' now IS — position 2 — not the old position 1.
    expect(selectedRow(after, sel, 'b', 1)).toBe(2)
    // And the session at that row is provably 'b', not whoever slid into position 1.
    expect(idAtRow(after, sel, selectedRow(after, sel, 'b', 1))).toBe('b')
    // Sanity: the OLD, position-based reading would have selected 'a' — the wrong session.
    expect(idAtRow(after, sel, 1)).toBe('a')
    void before
  })

  it('falls back to the clamped numeric position only when the glued id is gone', () => {
    const rows = rowsOf('a', 'b', 'c')
    const sel = selectableIndexes(rows)
    // 'z' ended and is no longer in the list — the cursor holds its last position, clamped.
    expect(selectedRow(rows, sel, 'z', 1)).toBe(1)
    // A position past the end clamps rather than pointing at nothing.
    expect(selectedRow(rows, sel, 'z', 9)).toBe(2)
  })

  it('with no glue id, behaves as the plain clamped cursor', () => {
    const rows = rowsOf('a', 'b', 'c')
    const sel = selectableIndexes(rows)
    expect(selectedRow(rows, sel, undefined, 0)).toBe(0)
    expect(selectedRow(rows, sel, undefined, 5)).toBe(2)
  })

  it('returns -1 on an empty list', () => {
    expect(selectedRow([], [], 'a', 0)).toBe(-1)
    expect(selectedRow([], [], undefined, 3)).toBe(-1)
  })

  it('resolves the id through headings and spacers, not raw row indices', () => {
    // A grouped list: heading, sessions, spacer, heading, session. `selectable` skips the chrome.
    const rows: SessionRow[] = [
      { kind: 'heading', label: 'live', count: 2 },
      { kind: 'session', session: session('a') },
      { kind: 'session', session: session('b') },
      { kind: 'spacer' },
      { kind: 'heading', label: 'closed', count: 1 },
      { kind: 'session', session: session('c') },
    ]
    const sel = selectableIndexes(rows)
    // 'c' is the third selectable row (index 2 into `selectable`), at raw row 5.
    expect(selectedRow(rows, sel, 'c', 0)).toBe(2)
    expect(idAtRow(rows, sel, 2)).toBe('c')
  })

  it('a mark that moves a row to the top carries the selection with it', () => {
    // Simulates bug (4): the fleet is [a,b,c]; the user marks 'c', which the marked band lifts to
    // the top → [c,a,b]. Glued to 'c', the resolved index follows it to row 0 — the cursor tracks
    // the row, never the position it used to hold.
    const after = rowsOf('c', 'a', 'b') // the marked band lifted 'c' from position 2
    const sel = selectableIndexes(after)
    expect(selectedRow(after, sel, 'c', 2)).toBe(0)
    expect(idAtRow(after, sel, selectedRow(after, sel, 'c', 2))).toBe('c')
  })
})

describe('searchArrangement — search is flat and newest-first, and only while searching', () => {
  const userOrder = { by: 'name', dir: 'asc' } as const

  it('forces a flat, recent-desc list while a query is active', () => {
    const eff = searchArrangement(true, 'task', true, userOrder)
    expect(eff.grouping).toBe('none')
    expect(eff.cascade).toBe(false)
    expect(eff.order).toEqual({ by: 'recent', dir: 'desc' })
  })

  it("returns the user's own arrangement untouched when there is no query — so exiting restores it", () => {
    const eff = searchArrangement(false, 'task', true, userOrder)
    expect(eff.grouping).toBe('task')
    expect(eff.cascade).toBe(true)
    expect(eff.order).toBe(userOrder)
  })
})

describe('attentionOf', () => {
  it('counts both waiting states and nothing else', () => {
    const list = [
      session('a', { state: 'waiting-approval' }),
      session('b', { state: 'waiting' }),
      session('c', { state: 'working' }),
      session('d', { state: 'unknown' }),
    ]
    expect(attentionOf(list)).toBe(2)
  })
})

describe('groupSessions', () => {
  const list = [
    session('a', { harness: 'claude', model: 'opus', project: 'x', state: 'working' }),
    session('b', { harness: 'codex', project: 'x', state: 'waiting-approval' }),
    session('c', { harness: 'claude', model: 'opus', project: 'y', state: 'working' }),
  ]

  it('does not make a PROJECT out of a directory that no longer exists', () => {
    // Reported from a real machine: the worktree `.claude/worktrees/member-connect-rotate` was
    // removed with its session still registered, so every `git -C` failed and the row grouped under
    // the last segment of a path that names nothing — a project of its own, standing beside
    // `Agentistics`, which is the project it was a worktree of.
    const gone = [
      session('w', { project: 'member-connect-rotate', dirGone: 'gone' }),
      session('v', { project: 'billing-basis', dirGone: 'gone' }),
      session('m', { project: 'agentistics' }),
    ]
    const g = groupSessions(gone, 'project', UNKNOWN)
    const labels = g.map(x => x.label).sort()
    expect(labels).toEqual(['agentistics', 'directory no longer exists'])
    // Both missing rows are in ONE bucket: what they have in common is that nobody knows where
    // they were, and that is a single fact rather than two project names.
    expect(g.find(x => x.label === 'directory no longer exists')!.sessions.map(s => s.id).sort())
      .toEqual(['v', 'w'])
  })

  it('still groups a gone directory under the project the registry recorded for it', () => {
    // The recovery case: `ManagedSession.repo` was written at spawn, so the row keeps the project
    // it belonged to and never reaches the bucket at all.
    const g = groupSessions(
      [session('w', { project: 'member-connect-rotate', projectGroup: 'agentistics', dirGone: 'gone' })],
      'project',
      UNKNOWN,
    )
    expect(g.map(x => x.label)).toEqual(['agentistics'])
  })

  it('keeps "gone" and "no directory recorded" as two different headings', () => {
    // A row with no cwd at all is a different absence from a row whose recorded path is not there,
    // and one heading for both would read as a category that neither of them is.
    const g = groupSessions(
      [session('n', { project: '' }), session('w', { project: 'x', dirGone: 'gone' })],
      'project',
      UNKNOWN,
    )
    expect(g.map(x => x.label).sort()).toEqual(['directory no longer exists', 'no directory'])
  })

  it('returns one unnamed group when grouping is off', () => {
    const g = groupSessions(list, 'none', UNKNOWN)
    expect(g).toHaveLength(1)
    expect(g[0]!.label).toBe('')
    expect(g[0]!.sessions).toHaveLength(3)
  })

  it('groups by harness', () => {
    const g = groupSessions(list, 'harness', UNKNOWN)
    expect(g.map(x => x.key).sort()).toEqual(['claude', 'codex'])
  })

  it('orders groups by their most urgent member, never alphabetically first', () => {
    // The blocked session is in `codex`, which sorts after `claude` — grouping must not bury the
    // thing the screen exists to surface.
    const g = groupSessions(list, 'harness', UNKNOWN)
    expect(g[0]!.key).toBe('codex')
  })

  it('names an absent fact in that dimension own words', () => {
    const g = groupSessions(list, 'model', UNKNOWN)
    expect(g.find(x => x.key === '')!.label).toBe('no model recorded')
    const h = groupSessions([session('u', { harness: '' })], 'harness', UNKNOWN)
    expect(h[0]!.label).toBe('harness unknown')
  })
})

describe('sessionRows / selectableIndexes', () => {
  it('draws a heading per named group, with air between them', () => {
    const groups = groupSessions(
      [session('a', { harness: 'claude' }), session('b', { harness: 'codex' })],
      'harness',
      UNKNOWN,
    )
    const rows = sessionRows(groups)
    expect(rows.map(r => r.kind)).toEqual(['heading', 'session', 'spacer', 'heading', 'session'])
  })

  it('never lets the cursor land on a heading or a blank', () => {
    // The cursor moves over ONE list; counting rows and sessions separately is what makes a
    // selection and its highlight disagree at the first group boundary.
    const rows = sessionRows(groupSessions(
      [session('a', { harness: 'claude' }), session('b', { harness: 'codex' })], 'harness', UNKNOWN,
    ))
    expect(selectableIndexes(rows)).toEqual([1, 4])
    for (const i of selectableIndexes(rows)) expect(rows[i]!.kind).toBe('session')
  })

  it('draws no heading when grouping is off and nothing is closed', () => {
    const rows = sessionRows(groupSessions([session('a')], 'none', UNKNOWN))
    expect(rows.map(r => r.kind)).toEqual(['session'])
  })

  it('always gives closed conversations their own section, even with grouping off', () => {
    // A conversation that is over is not a session that is running. Putting the two in one
    // undifferentiated run made the list read as if everything on it were open.
    const rows = sessionRows(groupSessions(
      [session('live'), session('old', { state: 'closed', stateLabel: 'closed' })],
      'none',
      UNKNOWN,
    ), 'closed')
    expect(rows.map(r => r.kind)).toEqual(['session', 'spacer', 'heading', 'session'])
    const heading = rows.find(r => r.kind === 'heading')
    expect(heading).toMatchObject({ label: 'closed', count: 1, muted: true })
  })

  it('keeps a named group WHOLE — closed rows continue under its own heading', () => {
    // They used to get a second heading, `billing · closed`, which repeats the group's name to say
    // what every one of those rows already says in its `state` cell, and splits one group into two
    // bands. The ungrouped case above keeps its heading: there the word is all there is.
    const rows = sessionRows(groupSessions(
      [
        session('live', { task: 'billing' }),
        session('old', { state: 'closed', stateLabel: 'closed', task: 'billing' }),
      ],
      'task',
      UNKNOWN,
    ), 'closed')
    expect(rows.filter(r => r.kind === 'heading').map(r => r.label)).toEqual(['billing'])
    expect(rows.find(r => r.kind === 'heading')).toMatchObject({ count: 2 })
  })

  it('lists the closed rows MOST RECENTLY OFF first', () => {
    // A block of finished conversations is read from the top: the one that ended twenty minutes ago
    // is the one being looked for. A row with no measured end sorts last — unknown is not recent.
    const off = (id: string, endedAt?: number) =>
      session(id, { state: 'closed', stateLabel: 'closed', task: 'billing', ...(endedAt !== undefined ? { endedAt } : {}) })
    const rows = sessionRows(groupSessions(
      [off('old', 1_000), off('never'), off('fresh', 9_000)], 'task', UNKNOWN,
    ), 'closed')
    expect(rows.flatMap(r => (r.kind === 'session' ? [r.session.id] : []))).toEqual(['fresh', 'old', 'never'])
  })

  it('marks an absence bucket as muted, so it does not read as a category', () => {
    const rows = sessionRows(groupSessions([session('a')], 'task', UNKNOWN), 'closed')
    expect(rows.find(r => r.kind === 'heading')).toMatchObject({ label: 'no task', muted: true })
  })
})

describe('the CASCADE arrangement', () => {
  const ROOT = '/home/d/agentistics'
  const inRepo = (id: string, cwd: string, over: Partial<ControlSession> = {}) => session(id, {
    cwd, project: cwd.split('/').pop() ?? cwd, projectGroup: 'agentistics', projectRoot: ROOT,
    ...over,
  })

  it('draws INSIDE any grouping — the bands stay, the directories cascade under them', () => {
    // The whole point of the cascade becoming a view: picking it must not cost the bands. Grouped
    // by task, each task keeps its heading and its sessions cascade by project and then by folder.
    const list = [
      inRepo('a', `${ROOT}/packages/tui`, { task: 'ui' }),
      inRepo('b', `${ROOT}/packages/web`, { task: 'ui' }),
      inRepo('c', ROOT, { task: 'ci' }),
    ]
    const bands = groupSessions(list, 'task', UNKNOWN, [], DEFAULT_ORDER, {}, true)
    const labels = bands.map(g => `${'  '.repeat(g.depth ?? 0)}${g.label}`)
    // Each task band, the project under it, then the folders. `packages` is a node rather than a
    // compressed chain because two worktrees branch off it — which falls out of the tree's own rule.
    expect(labels).toEqual([
      'ci', '  agentistics',
      'ui', '  agentistics', '    packages', '      tui', '      web',
    ])
    // Nothing was dropped or duplicated on the way.
    expect(bands.flatMap(g => g.sessions.map(x => x.id)).sort()).toEqual(['a', 'b', 'c'])
  })

  it('drops the cascade root when the band ALREADY names that project', () => {
    // Grouped by project the cascade's root is the band's own name. Repeating it would be a heading
    // that says what the heading above it just said — the rule the `where` column follows too.
    const list = [inRepo('a', `${ROOT}/packages/tui`), inRepo('b', ROOT)]
    const bands = groupSessions(list, 'project', UNKNOWN, [], DEFAULT_ORDER, {}, true)
    expect(bands.map(g => g.label)).toEqual(['agentistics', 'packages/tui'])
    // The session sitting in the checkout itself hangs off the band, not off a repeated root.
    expect(bands[0]!.sessions.map(x => x.id)).toEqual(['b'])
    expect(bands[1]!.sessions.map(x => x.id)).toEqual(['a'])
  })

  it('is the plain cascade when there are no bands to draw it inside', () => {
    const list = [inRepo('a', `${ROOT}/packages/tui`), inRepo('b', ROOT)]
    expect(groupSessions(list, 'none', UNKNOWN, [], DEFAULT_ORDER, {}, true))
      .toEqual(buildSessionTree(list, UNKNOWN))
  })

  it('changes nothing at all while it is off', () => {
    const list = [inRepo('a', `${ROOT}/packages/tui`), inRepo('b', ROOT)]
    expect(groupSessions(list, 'task', UNKNOWN, [], DEFAULT_ORDER, {}, false))
      .toEqual(groupSessions(list, 'task', UNKNOWN))
  })

  it('is served by the tree module, so there is ONE cascade', () => {
    // `groupSessions` special-cases `none` in its first line; `tree` joins it there rather than
    // being dispatched by each of the three callers that arrange a fleet.
    const list = [inRepo('a', `${ROOT}/packages/tui`), inRepo('b', ROOT)]
    expect(groupSessions(list, 'tree', UNKNOWN)).toEqual(buildSessionTree(list, UNKNOWN))
  })

  it('draws a heading for a branch that holds no session of its own', () => {
    // `push` skips a group with no sessions, which would silently delete the branch names the
    // cascade IS. The count is what is actually drawn beneath it, never a stored subtree total.
    const rows = sessionRows(groupSessions(
      [inRepo('a', `${ROOT}/packages/tui`), inRepo('b', `${ROOT}/packages/server`)],
      'tree',
      UNKNOWN,
    ))
    // An absent depth reads as zero — the root indents by nothing, exactly like every flat band.
    expect(rows.filter(r => r.kind === 'heading').map(r => [r.label, r.count, r.depth ?? 0])).toEqual([
      ['agentistics', 2, 0],
      ['packages', 2, 1],
      ['server', 1, 2],
      ['tui', 1, 2],
    ])
  })

  it('counts only what is drawn under it, so a marked band never inflates a branch', () => {
    // The marked band takes rows out of every group. A heading claiming two over one row is the
    // same class of lie as a confident zero.
    const rows = sessionRows(
      groupSessions(
        [inRepo('a', `${ROOT}/packages/tui`), inRepo('b', `${ROOT}/packages/server`)],
        'tree',
        UNKNOWN,
      ),
      undefined, undefined, undefined,
      { ids: new Set(['a']), label: 'marked' },
    )
    expect(rows.filter(r => r.kind === 'heading').map(r => [r.label, r.count])).toEqual([
      ['marked', 1],
      ['agentistics', 1],
      ['packages', 1],
      ['server', 1],
    ])
  })

  it('draws no heading for a branch whose whole subtree was taken by the marked band', () => {
    const rows = sessionRows(
      groupSessions([inRepo('a', `${ROOT}/packages/tui`)], 'tree', UNKNOWN),
      undefined, undefined, undefined,
      { ids: new Set(['a']), label: 'marked' },
    )
    expect(rows.filter(r => r.kind === 'heading').map(r => r.label)).toEqual(['marked'])
  })

  it('carries the breadcrumb path onto the heading row, for the card band', () => {
    const rows = sessionRows(groupSessions(
      [inRepo('a', `${ROOT}/packages/tui`)], 'tree', UNKNOWN,
    ))
    expect(rows.filter(r => r.kind === 'heading').map(r => r.path)).toEqual([
      ['agentistics'],
      ['agentistics', 'packages/tui'],
    ])
  })

  it('keeps closed rows inside the branch they belong to, breadcrumb included', () => {
    const rows = sessionRows(groupSessions(
      [inRepo('a', `${ROOT}/packages/tui`, { state: 'closed', stateLabel: 'closed' })],
      'tree',
      UNKNOWN,
    ), 'closed')
    const head = rows.filter(r => r.kind === 'heading')
    // The branch keeps its own name and the closed rows sit inside it — a suffixed twin would be a
    // second band for the same directory.
    expect(head.map(r => r.label)).toEqual(['agentistics', 'packages/tui'])
    // The crumb ends on the SAME words the heading reads, or the card band and the list would name
    // one branch two different ways.
    expect(head[1]!.path).toEqual(['agentistics', 'packages/tui'])
  })

  it('never lets the cursor land on a branch heading', () => {
    const rows = sessionRows(groupSessions(
      [inRepo('a', `${ROOT}/packages/tui`)], 'tree', UNKNOWN,
    ))
    for (const i of selectableIndexes(rows)) expect(rows[i]!.kind).toBe('session')
  })
})

describe('sessionCells', () => {
  const s = session('a', { title: 'refactor auth', harness: 'claude', project: 'agentistics', stateLabel: 'waiting' })

  it('keeps every cell when the row fits', () => {
    const c = sessionCells(s, 80)
    expect(c).toEqual({ state: 'waiting', title: 'refactor auth', harness: 'claude', where: 'agentistics' })
    expect(rowWidth(c)).toBeLessThanOrEqual(80)
  })

  it('gives up the directory first', () => {
    const c = sessionCells(s, 30)
    expect(c.where).toBe('')
    expect(c.harness).toBe('claude')
    expect(c.title).toBe('refactor auth')
  })

  it('gives up the harness second', () => {
    const c = sessionCells(s, 24)
    expect(c.harness).toBe('')
    expect(c.title).toBe('refactor auth')
  })

  it('keeps the state word to the very end, truncating the title instead', () => {
    // The state is the one cell nothing else on the frame repeats. A row reduced to a coloured
    // glyph would announce "waiting for you" in colour alone.
    const c = sessionCells(s, 14)
    expect(c.state).toBe('waiting')
    expect(c.title.length).toBeGreaterThan(0)
    expect(rowWidth(c)).toBeLessThanOrEqual(14)
  })

  it('never renders wider than it was given, even absurdly narrow', () => {
    for (const w of [1, 2, 3, 5, 8, 12, 20, 40]) {
      expect(rowWidth(sessionCells(s, w))).toBeLessThanOrEqual(Math.max(w, s.stateLabel.length))
    }
  })
})

describe('detailLines', () => {
  const labels = {
    where: 'where', model: 'model', note: 'note', started: 'started',
    external: 'started outside agentop', closed: 'not running', doing: 'saying', task: 'task', metrics: 'usage', metricsAll: 'in + out + cache',
    context: 'window', conversation: 'conversation',
    alsoLabel: 'named here', alsoHarness: 'named inside',
  }
  const ago = () => '5m ago'

  it('always states where the session is', () => {
    const l = detailLines(session('a', { cwd: '/repo/a' }), labels, ago)
    expect(l[0]).toMatchObject({ label: 'where', value: '/repo/a' })
  })

  it('omits a fact that was never recorded rather than showing it empty', () => {
    const l = detailLines(session('a'), labels, ago)
    expect(l.map(x => x.key)).not.toContain('model')
    expect(l.map(x => x.key)).not.toContain('note')
    expect(l.map(x => x.key)).not.toContain('started')
  })

  it('says an external session cannot be driven from here', () => {
    const l = detailLines(session('e', { actionable: false }), labels, ago)
    expect(l.find(x => x.key === 'external')).toMatchObject({ note: true })
  })

  it('carries the approval caveat only where the host supplied one', () => {
    // An absent caveat is silence, never a reassurance — so it is present exactly when true.
    expect(detailLines(session('a'), labels, ago).map(x => x.key)).not.toContain('blind')
    const blind = detailLines(session('a', { approvalBlind: 'no markers for x' }), labels, ago)
    expect(blind.find(x => x.key === 'blind')).toMatchObject({ note: true, value: 'no markers for x' })
  })
})

describe('sessionActions', () => {
  const words = {
    attach: 'Attach', resume: 'Reopen', rename: 'Rename', note: 'Note', task: 'Task',
    kill: 'Stop', openTask: 'Open whole task', reopenFell: 'Reopen what fell',
    finishTask: 'Finish task', approve: 'Answer', prompt: 'Send',
    new: 'New', search: 'Search', group: 'Group',
  }
  const of = (s?: ControlSession) => sessionActions(s).map(a => a.action)
  const on = (s?: ControlSession) => sessionActions(s).filter(a => a.enabled).map(a => a.action)

  it('always offers the SAME set, whatever is selected', () => {
    // A menu that loses five of its nine items reads as a broken feature, not as a row that cannot
    // take them. The shape stays constant; what changes is which ones are live.
    const shape = of(session('m'))
    expect(of(undefined).length).toBe(shape.length)
    expect(of(session('e', { state: 'unknown', actionable: false })).length).toBe(shape.length)
    expect(shape).toContain('rename')
    expect(shape).toContain('kill')
  })

  it('enables only what needs no selection when nothing is selected', () => {
    expect(on(undefined)).toEqual(['new', 'search', 'group'])
  })

  it('enables attach and the metadata verbs on a session agentop runs', () => {
    const a = on(session('m'))
    expect(a).toContain('attach')
    expect(a).toContain('rename')
    expect(a).toContain('kill')
    expect(a).not.toContain('resume')
  })

  it('offers reopen in attach position on a row agentop does not run, and dims the rest', () => {
    const external = session('e', {
      state: 'unknown', actionable: false, resume: { sessionId: 's1', title: 'auth' },
    })
    expect(of(external)[0]).toBe('resume')
    expect(on(external)).toContain('resume')
    // Still PRESENT, so the menu keeps its shape — just not runnable here.
    expect(of(external)).toContain('rename')
    expect(on(external)).not.toContain('rename')
  })

  it('dims reopen too when the harness cannot reopen by id', () => {
    const external = session('e', { state: 'unknown', actionable: false })
    expect(of(external)).toContain('resume')
    expect(on(external)).toEqual(['new', 'search', 'group'])
  })

  it('enables the whole task only once the session is filed under one', () => {
    expect(on(session('m'))).not.toContain('openTask')
    expect(on(session('m', { task: 'XPTO' }))).toContain('openTask')
  })

  it('never lets the cursor land on a verb that cannot run', () => {
    const external = session('e', { state: 'unknown', actionable: false })
    const offered = sessionActions(external)
    for (const i of enabledActionIndexes(offered)) expect(offered[i]!.enabled).toBe(true)
  })

  it('labels every verb it offers, in the caller language', () => {
    for (const l of actionLabels(sessionActions(session('m', { task: 'X' })), words)) {
      expect(l.length).toBeGreaterThan(0)
    }
  })
})

describe('detailLines — the two non-actionable rows say different things', () => {
  const labels = {
    where: 'where', model: 'model', note: 'note', started: 'started',
    external: 'started outside agentop', closed: 'not running', doing: 'saying',
    task: 'task', metrics: 'usage', metricsAll: 'in + out + cache', context: 'window', conversation: 'conversation',
    alsoLabel: 'named here', alsoHarness: 'named inside',
  }
  const ago = () => '5m ago'

  it('says a closed conversation is not running, never that it started elsewhere', () => {
    // One sentence for both said "started outside agentop" about a conversation agentop may well
    // have started and that is simply over.
    const l = detailLines(session('c', { state: 'closed', actionable: false }), labels, ago)
    expect(l.find(x => x.key === 'closed')?.value).toBe('not running')
    expect(l.map(x => x.key)).not.toContain('external')
  })

  it('still says a foreign session started elsewhere', () => {
    const l = detailLines(session('e', { state: 'unknown', actionable: false }), labels, ago)
    expect(l.map(x => x.key)).toContain('external')
    expect(l.map(x => x.key)).not.toContain('closed')
  })

  it('leads with what the session is saying, when it is saying anything', () => {
    const l = detailLines(session('m', { lastLines: ['● done'] }), labels, ago)
    expect(l[0]).toMatchObject({ label: 'saying', value: '● done', say: true })
  })

  it('prefers role-tagged chat turns over the raw screen tail, and tags them', () => {
    const l = detailLines(session('m', {
      lastLines: ['this must not appear'],
      chatTurns: [
        { role: 'user', text: 'fix the bug' },
        { role: 'assistant', text: 'done' },
      ],
    }), labels, ago)
    expect(l[0]).toMatchObject({ label: 'saying', value: 'fix the bug', role: 'user', say: false })
    expect(l[1]).toMatchObject({ label: '', value: 'done', role: 'assistant', say: true })
    expect(l.map(x => x.value)).not.toContain('this must not appear')
  })

  it('draws a pending tool-activity turn dim, in neither role colour', () => {
    const l = detailLines(session('m', {
      chatTurns: [
        { role: 'user', text: 'fix the bug' },
        { role: 'assistant', text: 'Running Bash', pending: true },
      ],
    }), labels, ago)
    expect(l[1]).toMatchObject({ value: 'Running Bash', note: true, say: false, role: undefined })
  })

  it('collapses a multi-line chat turn onto one detail line', () => {
    const l = detailLines(session('m', {
      chatTurns: [{ role: 'assistant', text: 'line one\n  line two\nline three' }],
    }), labels, ago)
    expect(l[0]?.value).toBe('line one line two line three')
  })

  it('falls back to the raw screen tail when there are no chat turns', () => {
    const l = detailLines(session('m', { lastLines: ['● done'], chatTurns: [] }), labels, ago)
    expect(l[0]?.value).toBe('● done')
    expect(l[0]?.role).toBeUndefined()
  })

  it('shows usage only where the conversation recorded any', () => {
    expect(detailLines(session('m'), labels, ago).map(x => x.key)).not.toContain('metrics')
    const l = detailLines(session('m', { tokens: '41.4K', cost: 'USD 0.26' }), labels, ago)
    // The token figure says what it counts; the cost does not need to.
    expect(l.find(x => x.key === 'metrics')?.value).toBe('41.4K (in + out + cache)  ·  USD 0.26')
    // A row with only a cost claims no breakdown it is not showing.
    expect(detailLines(session('m', { cost: 'USD 0.26' }), labels, ago)
      .find(x => x.key === 'metrics')?.value).toBe('USD 0.26')
  })
})

describe('summaryCells', () => {
  const full = {
    group: 'GROUP task',
    hiding: '− closed conversations, sessions with no task',
    count: '18 sessions',
    waiting: '3 waiting on you',
    width: 200,
  }

  const rendered = (c: ReturnType<typeof summaryCells>) =>
    [c.group, c.hiding, c.count, c.waiting].filter(Boolean)
      .reduce((n, p) => n + p.length, 0)
      + 3 * Math.max(0, [c.group, c.hiding, c.count, c.waiting].filter(Boolean).length - 1)

  it('keeps everything when the row fits', () => {
    expect(summaryCells(full)).toEqual({
      group: full.group, hiding: full.hiding, count: full.count, waiting: full.waiting, fell: '',
    })
  })

  it('gives up what is HIDDEN first — the panel one keypress away states it in full', () => {
    const c = summaryCells({ ...full, width: 40 })
    expect(c.hiding).toBe('')
    expect(c.group).toBe('GROUP task')
  })

  it('keeps the grouping to the very end, because it explains the arrangement', () => {
    const c = summaryCells({ ...full, width: 12 })
    expect(c.group).toContain('GROUP')
    expect(c.count).toBe('')
    expect(c.waiting).toBe('')
  })

  it('NEVER renders wider than it was given, at any width', () => {
    // The whole point. A row that wraps takes two of the screen's rows while its budget counted
    // one, which pushes the action row, the detail pane and the footer off the bottom — and that
    // reads as "the entire screen vanished", not as "one row is too wide".
    for (let w = 0; w <= 220; w++) {
      expect(rendered(summaryCells({ ...full, width: w }))).toBeLessThanOrEqual(Math.max(w, 0) || 0)
    }
  })
})

describe('sessionColumns', () => {
  const rows = [
    session('a', { stateLabel: 'needs approval', title: 'migrate the auth store', harness: 'claude', project: 'agentistics' }),
    session('b', { stateLabel: 'exited', title: 'release notes', harness: 'codex', project: 'aipe' }),
  ]
  const drawn = (c: ReturnType<typeof sessionColumns>) =>
    2 + c.state + (c.title ? 2 + c.title : 0) + (c.harness ? 2 + c.harness : 0) + (c.where ? 2 + c.where : 0)

  it('sizes every column to the widest row on screen, so the cells line up', () => {
    // Two spaces between unpadded cells started every title at a different column, because the
    // state words differ by ten characters. Nothing after them ever lined up.
    const c = sessionColumns(rows, 100)
    expect(c.state).toBe('needs approval'.length)
    expect(c.title).toBe('migrate the auth store'.length)
    expect(c.harness).toBe('claude'.length)
  })

  it('gives the title what it NEEDS, not the whole remainder', () => {
    // Stretching it to the leftover pushed the harness and the directory to the far edge with a
    // field of blank between — the old misalignment wearing a different shape.
    expect(sessionColumns(rows, 200).title).toBe('migrate the auth store'.length)
  })

  it('gives up the directory first, then the harness', () => {
    // The directory goes while the harness still fits, and the harness only once the title has
    // already been squeezed to almost nothing — the state word outlives both.
    expect(sessionColumns(rows, 46).where).toBe(0)
    expect(sessionColumns(rows, 46).harness).toBeGreaterThan(0)
    expect(sessionColumns(rows, 24).harness).toBe(0)
    expect(sessionColumns(rows, 24).state).toBe("needs approval".length)
  })

  it('never asks for more columns than it was given, at any width', () => {
    for (let w = 4; w <= 160; w++) {
      expect(drawn(sessionColumns(rows, w))).toBeLessThanOrEqual(Math.max(w, 2 + 'needs approval'.length + 3))
    }
  })

  it('draws NO usage column when nothing on screen has any', () => {
    // A fleet whose harnesses report no usage must not pay for the column, nor for the gap before
    // it — reserving a space nothing occupies narrows every title on the screen.
    expect(sessionColumns(rows, 100).metrics).toBe(0)
    expect(sessionColumns(rows, 100).title).toBe('migrate the auth store'.length)
  })

  it('sizes the usage column to the widest row that has any', () => {
    const withUse = [
      session('a', { stateLabel: 'waiting', title: 'one', tokens: '51.7k', cost: '$1.20' }),
      session('b', { stateLabel: 'waiting', title: 'two' }),
    ]
    expect(sessionColumns(withUse, 120).metrics).toBe('51.7k $1.20'.length)
  })

  it('gives up usage AFTER the directory and the harness, and never before the name', () => {
    const withUse = [
      session('a', { stateLabel: 'needs approval', title: 'migrate the auth store', tokens: '51.7k', cost: '$1.20' }),
    ]
    // The widths are MEASURED rather than guessed: the point is the ORDER cells are surrendered in,
    // and pinning it to three hand-picked numbers tests the arithmetic of this particular fixture.
    const lost = (pick: (c: ReturnType<typeof sessionColumns>) => number) => {
      for (let w = 200; w >= 4; w--) if (pick(sessionColumns(withUse, w)) === 0) return w
      return 0
    }
    const where = lost(c => c.where)
    const harness = lost(c => c.harness)
    const metrics = lost(c => c.metrics)
    // Each is given up at a NARROWER width than the one before it — the directory first, the
    // harness next, usage last.
    expect(where).toBeGreaterThan(harness)
    expect(harness).toBeGreaterThan(metrics)
    // And the state word and a usable name outlive all three.
    const bare = sessionColumns(withUse, metrics)
    expect(bare.metrics).toBe(0)
    expect(bare.state).toBe('needs approval'.length)
    expect(bare.title).toBeGreaterThan(0)
  })

  it('never asks for more columns than it was given, WITH usage, at any width', () => {
    const withUse = [
      session('a', { stateLabel: 'needs approval', title: 'migrate the auth store', tokens: '51.7k', cost: '$1.20' }),
      session('b', { stateLabel: 'exited', title: 'release notes', harness: 'codex', project: 'aipe' }),
    ]
    const wide = (c: ReturnType<typeof sessionColumns>) =>
      2 + c.state + (c.title ? 2 + c.title : 0) + (c.task ? 2 + c.task : 0)
      + (c.metrics ? 2 + c.metrics : 0)
      + (c.harness ? 2 + c.harness : 0) + (c.where ? 2 + c.where : 0)
    for (let w = 4; w <= 200; w++) {
      expect(wide(sessionColumns(withUse, w)))
        .toBeLessThanOrEqual(Math.max(w, 2 + 'needs approval'.length + 3))
    }
  })
})

describe('sessionsCockpit', () => {
  const at = (width: number, height: number, detailWanted = 4) =>
    sessionsCockpit({ width, height, asideLabel: 16, detailWanted })

  it('gives the aside its measured width and the list the rest', () => {
    const l = at(120, 30)
    // The label plus the cursor, the state dot and a trailing count — sizing to the label alone
    // truncated every long verb in the menu.
    expect(l.aside).toBe(20)
    expect(l.list).toBe(120 - 20 - 1)
  })

  it('DROPS the aside on a narrow terminal rather than squeezing the sessions', () => {
    // At forty columns an aside leaves nothing for the sessions, and the sessions are what the
    // screen is. The letters keep working, so a narrow terminal loses the menu, not the feature.
    const l = at(40, 30)
    expect(l.aside).toBe(0)
    expect(l.list).toBe(40)
  })

  it('bounds the aside so one long label cannot eat the screen', () => {
    expect(sessionsCockpit({ width: 200, height: 30, asideLabel: 90, detailWanted: 4 }).aside)
      .toBeLessThanOrEqual(34)
  })

  it('draws no detail pane when nothing is selected to describe', () => {
    const l = at(120, 30, 0)
    expect(l.detail).toBe(0)
    expect(l.band).toBe(30)
  })

  it('caps the detail pane at half the screen, however much it wants to say', () => {
    const l = at(120, 30, 100)
    expect(l.detail).toBe(15)
    expect(l.band).toBe(15)
  })

  it('never invents a row or a column, at any size', () => {
    for (let w = 1; w <= 200; w += 7) {
      for (let h = 1; h <= 60; h += 3) {
        const l = at(w, h)
        expect(l.band + l.detail).toBe(Math.max(1, h))
        expect(l.list + (l.aside > 0 ? l.aside + 1 : 0)).toBe(Math.max(1, w))
        expect(l.list).toBeGreaterThanOrEqual(1)
      }
    }
  })
})

describe('asideRows', () => {
  const words = {
    attach: 'Attach', resume: 'Reopen', rename: 'Rename', note: 'Note', task: 'Task',
    kill: 'Stop', openTask: 'Open whole task', reopenFell: 'Reopen what fell',
    finishTask: 'Finish task', approve: 'Answer', prompt: 'Send',
    new: 'New', search: 'Search', group: 'Group',
  }
  const groupWords = { day: 'day', repo: 'repo', none: 'flat', tree: 'cascade', task: 'tasks', harness: 'harness', model: 'model', project: 'project', status: 'state', marked: 'marked' }
  const toggleWords = { history: 'closed', named: 'named', done: 'done tasks', active: 'only active', detail: 'detail', cascade: 'cascade' }
  const headings = { actions: 'ACTIONS', view: 'VIEW', show: 'SHOW' }

  const build = (o: Partial<Parameters<typeof asideRows>[0]> = {}) => asideRows({
    actions: sessionActions(session('m')),
    actionWords: words,
    grouping: 'none',
    groupWords,
    toggles: { history: false, named: false, done: false, active: false, detail: false, cascade: false },
    toggleWords,
    headings,
    layout: LAYOUT,
    ...o,
  })

  it('puts what you came to do above what you set once and leave', () => {
    const rows = build()
    const firstHeading = rows.findIndex(r => r.kind === 'heading')
    const firstAction = rows.findIndex(r => r.kind === 'action')
    const firstGroup = rows.findIndex(r => r.kind === 'group')
    expect(firstHeading).toBeLessThan(firstAction)
    expect(firstAction).toBeLessThan(firstGroup)
  })

  it('states every row own state, so nothing must be pressed to be discovered', () => {
    const rows = build({ grouping: 'task', toggles: { history: true, named: false, done: false, active: false, detail: false, cascade: false } })
    expect(rows.find(r => r.kind === 'group' && r.value === 'task')).toMatchObject({ on: true })
    expect(rows.find(r => r.kind === 'group' && r.value === 'none')).toMatchObject({ on: false })
    expect(rows.find(r => r.kind === 'toggle' && r.toggle === 'history')).toMatchObject({ on: true })
  })

  it('offers the named-row switch under every grouping', () => {
    // It replaced `unfiled`, which was offered only while grouping by task — a switch that appeared
    // and disappeared for one dimension. The task-less bucket is a row in the task section now, and
    // this one is about a widening that applies whatever the list is arranged by.
    for (const grouping of GROUPINGS) {
      expect(build({ grouping }).some(r => r.kind === 'toggle' && r.toggle === 'named')).toBe(true)
    }
  })

  it('never lets the cursor land on a heading, a rule, or a disabled verb', () => {
    const rows = build({ actions: sessionActions(session('e', { state: 'unknown', actionable: false })) })
    for (const i of asideSelectable(rows)) {
      const r = rows[i]!
      expect(r.kind).not.toBe('heading')
      expect(r.kind).not.toBe('rule')
      if (r.kind === 'action') expect(r.enabled).toBe(true)
    }
    // The disabled verbs are still PRESENT — the menu keeps its shape.
    expect(rows.some(r => r.kind === 'action' && r.action === 'rename' && !r.enabled)).toBe(true)
  })
})

describe('finished tasks', () => {
  const fleet = [
    session('a', { task: 'ship the cockpit', title: 'a' }),
    session('b', { task: 'ship the cockpit', title: 'b' }),
    session('c', { task: 'pricing audit', title: 'c' }),
  ]
  const group = (done: string[]) =>
    groupSessions(fleet, 'task', UNKNOWN, done)

  it('marks only the task the user finished, and only while grouping by task', () => {
    const g = group(['ship the cockpit'])
    expect(g.find(x => x.key === 'ship the cockpit')?.done).toBe(true)
    expect(g.find(x => x.key === 'pricing audit')?.done).toBeUndefined()
    // The same names mean nothing on another dimension: a PROJECT called after a finished task is
    // not a finished project.
    const byProject = groupSessions(fleet, 'project', UNKNOWN, ['a'])
    expect(byProject.every(x => x.done === undefined)).toBe(true)
  })

  it('says so in the heading and mutes it, rather than only dimming the rows', () => {
    const rows = sessionRows(group(['ship the cockpit']), 'closed', 'finished')
    const head = rows.find(r => r.kind === 'heading' && r.label.startsWith('ship the cockpit'))
    expect(head).toBeDefined()
    expect((head as { label: string }).label).toBe('ship the cockpit · finished')
    expect((head as { muted?: boolean }).muted).toBe(true)
  })

  it('leaves the heading alone when the caller has no word for it', () => {
    // The module owns no strings, so an absent label is silence rather than an invented English one.
    const rows = sessionRows(group(['ship the cockpit']), 'closed')
    const head = rows.find(r => r.kind === 'heading') as { label: string }
    expect(head.label).not.toContain('·')
  })
})

describe('projectCounts', () => {
  it('counts sessions per project, busiest first, ties by name', () => {
    const counts = projectCounts([
      session('a', { project: 'agentistics' }),
      session('b', { project: 'agentistics' }),
      session('c', { project: 'zuke' }),
      session('d', { project: 'aipe' }),
    ])
    expect(counts).toEqual([
      { name: 'agentistics', count: 2 },
      { name: 'aipe', count: 1 },
      { name: 'zuke', count: 1 },
    ])
  })

  it('omits a session with no project rather than inventing a bucket for it', () => {
    expect(projectCounts([session('a', { project: '' })])).toEqual([])
  })
})

describe('the task cell', () => {
  const filed = [
    session('a', { stateLabel: 'waiting', title: 'migrate the auth store', task: 'billing' }),
    session('b', { stateLabel: 'waiting', title: 'flaky test hunt' }),
  ]

  it('is a column of its own, sized to the widest task on screen', () => {
    expect(sessionColumns(filed, 140).task).toBe('billing'.length)
  })

  it('is ABSENT while grouping by task, where the heading already says it', () => {
    // A column repeating the word in the heading above every row under it is not information.
    expect(sessionColumns(filed, 140, { groupedByTask: true }).task).toBe(0)
  })

  it('draws no column when nothing on screen is filed', () => {
    expect(sessionColumns([session('b', { stateLabel: 'waiting', title: 'x' })], 140).task).toBe(0)
  })

  it('outlives the usage, the harness and the directory as the row narrows', () => {
    const rows = [session('a', {
      stateLabel: 'needs approval', title: 'migrate the auth store', task: 'billing',
      tokens: '51.7k', cost: '$1.24', harness: 'claude', project: 'agentistics',
    })]
    const lost = (pick: (c: ReturnType<typeof sessionColumns>) => number) => {
      for (let w = 220; w >= 4; w--) if (pick(sessionColumns(rows, w)) === 0) return w
      return 0
    }
    expect(lost(c => c.where)).toBeGreaterThan(lost(c => c.harness))
    expect(lost(c => c.harness)).toBeGreaterThan(lost(c => c.metrics))
    expect(lost(c => c.metrics)).toBeGreaterThan(lost(c => c.task))
  })
})

describe('sessionsCockpit budget', () => {
  const at = (height: number, detailWanted = 4) =>
    sessionsCockpit({ width: 120, height, asideLabel: 16, detailWanted })

  it('pays for every pane FRAME out of its own arithmetic', () => {
    // The screen draws three framed panes. A budget that hands out content rows and then lets the
    // component pay for the borders overspends by two rows per pane, and Ink COMPOSITES the
    // overflow rather than clipping it — which reads as a corrupted frame, not a cramped one.
    for (let h = 4; h <= 60; h++) {
      const l = at(h)
      expect(l.band + l.detail).toBeLessThanOrEqual(h)
      // Whatever the pane hands to content, plus its frame, is what the band was given.
      expect(l.listRows + (l.summary ? 1 : 0)).toBeLessThanOrEqual(Math.max(1, l.band - 2))
    }
  })

  it('gives up the summary row before the last session row', () => {
    // The summary describes the list; a list with no rows left has nothing to describe.
    const tall = at(40)
    expect(tall.summary).toBe(true)
    const short = at(8)
    expect(short.listRows).toBeGreaterThanOrEqual(1)
    if (!short.summary) expect(short.listRows).toBeGreaterThanOrEqual(1)
  })

  it('always leaves at least one row for a session', () => {
    for (let h = 1; h <= 60; h++) expect(at(h).listRows).toBeGreaterThanOrEqual(1)
  })
})

describe('projectColumns', () => {
  const rows = [
    { name: 'session-monitor', repo: 'blpsoares/agentistics', path: '~/agentistics/…/worktrees/session-monitor', why: 'you worked here' },
    { name: 'embark', repo: '', path: '~/orgs/opvibes/embark', why: 'git repo' },
    { name: 'scratch', repo: '', path: '~/scratch', why: '' },
  ]
  const drawn = (c: ReturnType<typeof projectColumns>) => {
    const cells = [c.name, c.repo, c.path, c.why].filter(n => n > 0)
    return 2 + cells.reduce((a, b) => a + b, 0) + 2 * Math.max(0, cells.length - 1)
  }

  it('never draws a row wider than the pane it was measured against', () => {
    // Two columns too wide is not a cosmetic miss: the frame truncates every row of the table it
    // just measured, which is what the per-row sizing produced in the first place.
    for (let w = 20; w <= 200; w++) expect(drawn(projectColumns(rows, w))).toBeLessThanOrEqual(w)
  })

  it('sizes each column to the widest row ON THE PAGE, so the cells line up', () => {
    const c = projectColumns(rows, 160)
    expect(c.name).toBe('session-monitor'.length)
    expect(c.repo).toBe('blpsoares/agentistics'.length)
    expect(c.path).toBe('~/agentistics/…/worktrees/session-monitor'.length)
  })

  it('gives up the reason first, then the repo, and never the path', () => {
    const lost = (pick: (c: ReturnType<typeof projectColumns>) => number) => {
      for (let w = 200; w >= 20; w--) if (pick(projectColumns(rows, w)) === 0) return w
      return 0
    }
    expect(lost(c => c.why)).toBeGreaterThan(lost(c => c.repo))
    // The path answers "which one" — a machine with six directories of the same name renders six
    // identical rows without it. It is never given up, only shortened.
    for (let w = 20; w <= 200; w++) expect(projectColumns(rows, w).path).toBeGreaterThan(0)
    for (let w = 20; w <= 200; w++) expect(projectColumns(rows, w).name).toBeGreaterThan(0)
  })
})

describe('projectPickRows', () => {
  const row = (name: string, repo = '', path = `~/${name}`) => ({ name, repo, path, why: '' })

  it('groups by repository, keeping the order the search ranked them in', () => {
    // First appearance decides section order. Sorting alphabetically here would throw away the one
    // piece of ordering the search actually earned — the directory you are standing in is first.
    const sections = groupProjects([
      row('web', 'org/mono'), row('loose'), row('api', 'org/mono'), row('other', 'aaa/first'),
    ])
    expect(sections.map(s => s.repo)).toEqual(['org/mono', 'aaa/first', ''])
    expect(sections[0]!.rows.map(r => r.name)).toEqual(['web', 'api'])
  })

  it('does not group when there is nothing to separate', () => {
    // One section is not a grouping, it is a heading over the whole list.
    const only = projectPickRows([row('a'), row('b')], 'loose')
    expect(only.grouped).toBe(false)
    expect(only.rows.every(r => r.kind === 'project')).toBe(true)

    const oneRepo = projectPickRows([row('a', 'org/x'), row('b', 'org/x')], 'loose')
    expect(oneRepo.grouped).toBe(false)
  })

  it('keeps each row pointing at its ORIGINAL index, so enter picks what is highlighted', () => {
    const rows = [row('web', 'org/mono'), row('loose'), row('api', 'org/mono')]
    const { rows: drawn, grouped } = projectPickRows(rows, 'loose')
    expect(grouped).toBe(true)
    const picks = drawn.flatMap(r => (r.kind === 'project' ? [r] : []))
    // Drawn out of order, but every row still names the position it came from.
    expect(picks.map(p => p.row.name)).toEqual(['web', 'api', 'loose'])
    expect(picks.map(p => p.index)).toEqual([0, 2, 1])
  })
})

describe('the worktree cell', () => {
  const wt = [
    session('a', { stateLabel: 'waiting', title: 'one', worktree: true, project: 'session-monitor' }),
    session('b', { stateLabel: 'waiting', title: 'two', project: 'agentistics' }),
  ]

  it('draws nothing when no row on screen is a worktree', () => {
    const plain = [session('b', { stateLabel: 'waiting', title: 'two' })]
    expect(sessionColumns(plain, 140).worktree).toBe(0)
  })

  it('carries the worktree NAME, not the word "worktree"', () => {
    // Grouped by project the heading already says which project, so a cell repeating one word on
    // every such row told you the kind and never which one. Three checkouts are told apart here.
    expect(worktreeName(wt[0]!)).toBe('session-monitor')
    expect(worktreeName(wt[1]!)).toBe('')
    expect(sessionColumns(wt, 140).worktree).toBe('session-monitor'.length)
  })

  it('is given up before the name, and after nothing else', () => {
    const lost = (pick: (c: ReturnType<typeof sessionColumns>) => number) => {
      for (let w = 200; w >= 4; w--) if (pick(sessionColumns(wt, w)) === 0) return w
      return 0
    }
    expect(lost(c => c.worktree)).toBeLessThan(lost(c => c.where))
  })
})

describe('sessionHandle', () => {
  it('is the prefix `agentop session attach` resolves against', () => {
    expect(sessionHandle(session('3f5f4dd461'))).toBe('3f5f4')
  })

  it('names EVERY row, because every session has an id', () => {
    // This used to be empty for external and closed rows, protecting `attach` from a handle it
    // cannot resolve. It protected one command at the cost of the column: a table where some rows
    // have no id reads as data missing, and those rows cannot be referred to at all.
    //
    // A row that names a CONVERSATION shows the conversation's id — not attachable, but exactly
    // what reopening resolves, which is the one verb such a row offers.
    expect(sessionHandle(session('closed:abcdef-1234', {
      resume: { sessionId: 'abcdef-1234', title: 'x' },
    }))).toBe('abcde')

    // With nothing else to go on, the trailing distinguishing part of the synthetic id. It resolves
    // no command and still tells two rows apart, which is the column's other job — and for two
    // assistants open in ONE directory the start time is the only thing that does.
    const a = sessionHandle(session('external:claude:/repo:1786770001'))
    const b = sessionHandle(session('external:claude:/repo:1786770002'))
    expect(a).not.toBe('')
    expect(a).not.toBe(b)
  })
})

describe('asideSections', () => {
  const rows: Parameters<typeof asideSections>[0] = [
    { kind: 'heading', label: 'ACTIONS' },
    { kind: 'action', action: 'attach', label: 'Attach', enabled: true },
    { kind: 'action', action: 'kill', label: 'Stop', enabled: true },
    { kind: 'rule' },
    { kind: 'heading', label: 'VIEW' },
    { kind: 'group', value: 'repo', label: 'repository', on: true },
    { kind: 'rule' },
    { kind: 'heading', label: 'EMPTY' },
  ]

  it('keeps every row pointing at its index in the FLAT menu', () => {
    // The cursor moves over one list. Sections that carried their own indexes would be a second
    // counting of the same menu, agreeing until the first boundary.
    const s = asideSections(rows)
    expect(s.map(x => x.title)).toEqual(['ACTIONS', 'VIEW'])
    expect(s[0]!.indexes).toEqual([1, 2])
    expect(s[1]!.indexes).toEqual([5])
  })

  it('drops a heading with nothing under it, rather than drawing a title over nothing', () => {
    expect(asideSections(rows).some(s => s.title === 'EMPTY')).toBe(false)
  })
})

describe('asideFold', () => {
  const sec = (n: number, title: string) => ({
    title,
    rows: Array.from({ length: n }, () => ({ kind: 'rule' as const })) as never[],
    indexes: Array.from({ length: n }, (_, i) => i),
  })
  const five = [sec(10, 'a'), sec(6, 'b'), sec(3, 'c'), sec(4, 'd'), sec(5, 'e')]
  const whole = five.reduce((n, s) => n + s.rows.length + 2, 0)
  const sum = (ns: readonly number[]) => ns.reduce((a: number, b: number) => a + b, 0)

  it('opens every section when the band can hold them all', () => {
    expect(asideFold(five, whole, 0)).toEqual([12, 8, 5, 6, 7])
  })

  it('leaves NO air under the last pane — it opens what the leftover can pay for', () => {
    // Collapsing everything but the active one and stopping there left fourteen blank rows under
    // the menu on a tall terminal. Air under a pane is a fault; air inside one is a pane.
    const band = whole - 6
    const got = asideFold(five, band, 0)!
    expect(sum(got)).toBe(band)
    expect(got.filter(n => n > 1).length).toBeGreaterThan(1)
  })

  it('keeps every section NAMED however short the band', () => {
    const got = asideFold(five, 8, 2)!
    expect(got).toHaveLength(5)
    expect(got.every(n => n >= 1)).toBe(true)
    expect(got[2]).toBe(8 - 4)
  })

  it('opens the section holding the cursor, whichever it is', () => {
    for (let at = 0; at < five.length; at++) {
      expect(asideFold(five, 9, at)![at]).toBeGreaterThan(1)
    }
  })

  it('spends the band EXACTLY, at any height or cursor', () => {
    // Not merely "no more than": a column that stops short of the list beside it leaves air under
    // the last pane, which the control center's own rule calls a fault.
    for (let band = 1; band <= 60; band++) {
      for (let at = 0; at < five.length; at++) {
        const got = asideFold(five, band, at)
        if (got) expect(sum(got)).toBe(band)
      }
    }
  })

  it('refuses when it cannot name them all and still open one', () => {
    expect(asideFold(five, 6, 0)).toBeNull()
  })

  it('leaves a section closed only when it genuinely does not fit', () => {
    // The others are walked in READING order and opened when they fit, so the menu does not
    // reorder itself; a closed box next to visible space would just be a row nobody is using.
    for (let band = 9; band <= 60; band++) {
      for (let at = 0; at < five.length; at++) {
        const got = asideFold(five, band, at)
        if (!got) continue
        const left = band - sum(got)
        got.forEach((n, i) => {
          if (i === at || n > 1) return
          expect(2 + five[i]!.rows.length - 1).toBeGreaterThan(left)
        })
      }
    }
  })
})

describe('scrollBar', () => {
  it('draws nothing at all when everything fits', () => {
    // A bar that is always there says "there is more" on the list that has no more, which is the
    // same class of lie as a confident zero.
    expect(scrollBar({ offset: 0, total: 5, rows: 10 })).toEqual([])
    expect(scrollBar({ offset: 0, total: 10, rows: 10 })).toEqual([])
  })

  it('puts the thumb at the top at the top, and at the bottom at the bottom', () => {
    const top = scrollBar({ offset: 0, total: 100, rows: 10 })
    const bottom = scrollBar({ offset: 90, total: 100, rows: 10 })
    expect(top[0]).toBe(THUMB)
    expect(top[top.length - 1]).toBe(TRACK)
    expect(bottom[bottom.length - 1]).toBe(THUMB)
    expect(bottom[0]).toBe(TRACK)
  })

  it('never fills the whole track, however long the list', () => {
    // A full-length thumb reads as "nothing to scroll" on exactly the list that has the most of it.
    for (const total of [11, 12, 20, 100, 5000]) {
      const bar = scrollBar({ offset: 0, total, rows: 10 })
      expect(bar).toHaveLength(10)
      expect(bar.filter(c => c === THUMB).length).toBeLessThan(10)
      expect(bar.filter(c => c === THUMB).length).toBeGreaterThanOrEqual(1)
    }
  })

  it('clamps an offset past the end instead of drawing off the track', () => {
    const bar = scrollBar({ offset: 9999, total: 100, rows: 10 })
    expect(bar).toHaveLength(10)
    expect(bar[bar.length - 1]).toBe(THUMB)
  })
})

describe('what a row that is no longer running offers', () => {
  const lost = session('a', {
    stateLabel: 'lost', state: 'lost' as SessionState, actionable: true, named: true,
    resume: { sessionId: 'c1', title: 'the work' },
  })

  it('offers REOPEN rather than attach — attaching to nothing is a button that only errors', () => {
    const offered = sessionActions(lost)
    expect(offered[0]!.action).toBe('resume')
    expect(offered[0]!.enabled).toBe(true)
    expect(offered.some(a => a.action === 'attach')).toBe(false)
  })

  it('keeps the verbs that edit what the user wrote', () => {
    // A reboot loses every backend session while the registry keeps every name. Losing rename,
    // note and task there is how a rename disappears.
    const by = Object.fromEntries(sessionActions(lost).map(a => [a.action, a.enabled]))
    expect(by.rename).toBe(true)
    expect(by.note).toBe(true)
    expect(by.task).toBe(true)
    expect(by.kill).toBe(true)
  })

  it('still offers attach on a row that IS running', () => {
    const live = session('b', { stateLabel: 'waiting', state: 'waiting' as SessionState })
    expect(sessionActions(live)[0]!.action).toBe('attach')
  })
})

describe('sessionNamed', () => {
  it('is what the user MARKED, never what the host derived', () => {
    // `title` always has a value — the host derives one when there is no label — so it can say
    // nothing about whether anyone chose it.
    expect(sessionNamed(session('a', { title: 'claude in agentistics' }))).toBe(false)
    expect(sessionNamed(session('a', { title: 'x', named: true }))).toBe(true)
  })
})

describe('grouping by project', () => {
  it('files a WORKTREE under the project it belongs to, not under its own folder', () => {
    // Three worktrees of one repository are three places to work on ONE project. Keying on the
    // directory name files them as three projects, which is the split the repository dimension
    // exists to avoid — and it is the default grouping, so it is the first thing anyone sees.
    const g = groupSessions([
      session('a', { project: 'session-monitor', projectGroup: 'agentistics' }),
      session('b', { project: 'agentistics' }),
      session('c', { project: 'billing-basis', projectGroup: 'agentistics' }),
    ], 'project', UNKNOWN)
    expect(g).toHaveLength(1)
    expect(g[0]!.key).toBe('agentistics')
    expect(g[0]!.sessions).toHaveLength(3)
  })

  it('falls back to the directory when the session belongs to no repository', () => {
    const g = groupSessions([session('a', { project: 'scratch' })], 'project', UNKNOWN)
    expect(g[0]!.key).toBe('scratch')
  })
})

describe('sessionRunning', () => {
  it('is the three states that mean something is alive on the other end', () => {
    const at = (state: SessionState) => sessionRunning(session('a', { state }))
    expect(at('working')).toBe(true)
    expect(at('waiting')).toBe(true)
    expect(at('waiting-approval')).toBe(true)
    // An EXTERNAL session wears `unknown`, and it is running: the row exists because a live
    // assistant process was found. What cannot be read there is the activity, not the existence —
    // and treating the one as the other hid every session started outside agentop from the one
    // filter meant to show what is happening.
    expect(at('unknown')).toBe(true)
    expect(at('exited')).toBe(false)
    expect(at('lost')).toBe(false)
    expect(at('closed')).toBe(false)
  })
})

describe('the only-active toggle', () => {
  const build = (showUnfiled: boolean) => asideRows({
    actions: sessionActions(session('m')),
    actionWords: {
      attach: 'A', resume: 'R', rename: 'N', note: 'O', task: 'T', kill: 'K',
      openTask: 'OT', reopenFell: 'RF', finishTask: 'FT', approve: 'AP', prompt: 'PR',
      new: 'NW', search: 'S', group: 'G',
    },
    grouping: 'project',
    groupWords: {
      day: 'day',
      repo: 'repository', none: 'flat', tree: 'cascade', task: 'task', harness: 'harness', model: 'model',
      project: 'project', status: 'state', marked: 'marked',
    },
    layout: LAYOUT,
    toggles: { history: false, named: false, done: false, active: true, detail: false, cascade: false },
    toggleWords: {
      history: 'closed', named: 'named', done: 'done tasks',
      active: 'only active', detail: 'detail', cascade: 'cascade',
    },
    headings: { actions: 'ACTIONS', view: 'VIEW', show: 'SHOW' },
    ...(showUnfiled ? { tasks: TASK_SECTION } : {}),
  })
  const TASK_SECTION = {
    counts: [{ name: 't', count: 1 }],
    active: null,
    heading: 'TASKS',
    allLabel: 'all',
    unfiled: 'no task',
  }

  it('leads the SHOW block, because it overrides the three under it', () => {
    // A switch that appears to do nothing is one people conclude is broken. Listed first it reads
    // as what it is: the strict answer, with the widening ones beneath.
    for (const unfiled of [false, true]) {
      const rows = build(unfiled)
      const show = rows.findIndex(r => r.kind === 'heading' && r.label === 'SHOW')
      expect(rows[show + 1]).toMatchObject({ kind: 'toggle', toggle: 'active', on: true })
    }
  })
})

describe('resolveAsideCursor', () => {
  const rows: Parameters<typeof resolveAsideCursor>[0] = [
    { kind: 'heading', label: 'ACTIONS' },
    { kind: 'action', action: 'attach', label: 'Attach', enabled: true },
    { kind: 'action', action: 'kill', label: 'Stop', enabled: true },
    { kind: 'rule' },
    { kind: 'heading', label: 'VIEW' },
    { kind: 'group', value: 'project', label: 'project', on: true },
    { kind: 'toggle', toggle: 'active', label: 'only active', on: true },
  ]

  it('keeps the cursor on the SAME row when the list is rebuilt around it', () => {
    // The cursor used to be an index into the selectable rows, and which verbs are enabled depends
    // on the selected session — so moving down the fleet renumbered every row beneath the actions
    // block and the menu cursor jumped, usually into the first section, which then opened.
    const shorter: typeof rows = [
      { kind: 'heading', label: 'ACTIONS' },
      { kind: 'action', action: 'resume', label: 'Reopen', enabled: true },
      { kind: 'rule' },
      { kind: 'heading', label: 'VIEW' },
      { kind: 'group', value: 'project', label: 'project', on: true },
      { kind: 'toggle', toggle: 'active', label: 'only active', on: true },
    ]
    expect(asideRowKey(rows[6]!)).toBe('toggle:active')
    expect(resolveAsideCursor(shorter, 'toggle:active')).toBe(5)
    expect(asideRowKey(shorter[5]!)).toBe('toggle:active')
  })

  it('lands on the NEAREST selectable row when its own row is gone', () => {
    // A verb that becomes unavailable moves the cursor one place, never to the top of the menu —
    // the top is in the first section, and landing there opens it.
    const without: typeof rows = rows.filter(r => !(r.kind === 'action' && r.action === 'kill'))
    const at = resolveAsideCursor(without, 'action:kill')
    expect(at).toBeGreaterThan(0)
    expect(without[at]!.kind).not.toBe('heading')
  })

  it('never lands on a heading, a rule, or a disabled verb', () => {
    const disabled: typeof rows = rows.map(r =>
      r.kind === 'action' && r.action === 'kill' ? { ...r, enabled: false } : r)
    const at = resolveAsideCursor(disabled, 'action:kill')
    const row = disabled[at]!
    expect(row.kind).not.toBe('heading')
    expect(row.kind).not.toBe('rule')
    if (row.kind === 'action') expect(row.enabled).toBe(true)
  })

  it('reports -1 when there is nothing to land on at all', () => {
    expect(resolveAsideCursor([{ kind: 'heading', label: 'X' }], 'action:attach')).toBe(-1)
  })
})

describe('sortSessions', () => {
  const rows = [
    session('a', { title: 'zebra', state: 'exited' as SessionState, startedAt: 300, tokens: '1.2M' }),
    session('b', { title: 'alpha', state: 'waiting' as SessionState, startedAt: 100, tokens: '9.9k' }),
    session('c', { title: 'mango', state: 'waiting-approval' as SessionState, startedAt: 200, tokens: '5' }),
  ]
  const ids = (o: Parameters<typeof sortSessions>[1]) => sortSessions(rows, o).map(s => s.id)

  it('puts what is blocked on you first by default', () => {
    expect(ids(DEFAULT_ORDER)).toEqual(['c', 'b', 'a'])
  })

  it('reads the SUFFIX when ordering by usage', () => {
    // `9.9k` above `1.2M` would point the column that exists to show what is expensive at the
    // cheapest row on the screen.
    expect(usageOf(session('x', { tokens: '1.2M' }))).toBe(1_200_000)
    expect(usageOf(session('x', { tokens: '9.9k' }))).toBe(9_900)
    expect(usageOf(session('x'))).toBe(0)
    expect(ids({ by: 'usage', dir: 'desc' })).toEqual(['a', 'b', 'c'])
  })

  it('orders by name in the direction the key is USEFUL in, and flips', () => {
    // `desc` names the useful direction for every key — most urgent, A to Z, largest, newest — so
    // there is one convention rather than a per-key argument about which way its "descending" runs.
    expect(ids({ by: 'name', dir: 'desc' })).toEqual(['b', 'c', 'a'])
    expect(ids({ by: 'name', dir: 'asc' })).toEqual(['a', 'c', 'b'])
  })

  it('orders by start time, newest first', () => {
    expect(ids({ by: 'started', dir: 'desc' })).toEqual(['a', 'c', 'b'])
    expect(ids({ by: 'started', dir: 'asc' })).toEqual(['b', 'c', 'a'])
  })

  it('keeps STATE as the tiebreak of every other key', () => {
    // A screen sorted by name that buries a session waiting on approval among nine idle ones has
    // lost the thing it is for.
    const tied = [
      session('x', { title: 'same', state: 'exited' as SessionState }),
      session('y', { title: 'same', state: 'waiting-approval' as SessionState }),
    ]
    expect(sortSessions(tied, { by: 'name', dir: 'desc' }).map(s => s.id)).toEqual(['y', 'x'])
  })

  it('never mutates what it was given', () => {
    const before = rows.map(s => s.id)
    sortSessions(rows, { by: 'name', dir: 'asc' })
    expect(rows.map(s => s.id)).toEqual(before)
  })
})

describe('planSubmit', () => {
  const harness = { id: 'claude', supportsModel: true }

  it('NAMES every refusal instead of returning silently', () => {
    // The component's version was `if (!spawn || !draft.harness || !draft.cwd) return`. The final
    // enter of a six-step wizard did nothing at all, with no way to tell a dead key from a slow
    // one — and the prompt just typed was still on screen, about to be thrown away.
    expect(planSubmit({ draft: { harness, cwd: '/r' }, hasSpawn: false, attach: false }))
      .toEqual({ ok: false, reason: 'no-host' })
    expect(planSubmit({ draft: { cwd: '/r' }, hasSpawn: true, attach: false }))
      .toEqual({ ok: false, reason: 'no-harness', step: 'harness' })
    expect(planSubmit({ draft: { harness }, hasSpawn: true, attach: false }))
      .toEqual({ ok: false, reason: 'no-cwd', step: 'where' })
  })

  it('sends a refusal BACK to the step that takes the missing answer', () => {
    // A refusal with nowhere to go is a dead end; with a step it is a way back.
    const noCwd = planSubmit({ draft: { harness }, hasSpawn: true, attach: false })
    expect(noCwd.ok).toBe(false)
    if (!noCwd.ok) expect(noCwd.step).toBe('where')
  })

  it('carries only what was actually answered', () => {
    // An empty model is not a model called "".
    const plan = planSubmit({
      draft: { harness, cwd: '/r', prompt: 'do the thing', model: '', task: 'auth' },
      hasSpawn: true,
      attach: true,
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.req).toEqual({
        harness: 'claude', cwd: '/r', attach: true, prompt: 'do the thing', task: 'auth',
      })
      expect('model' in plan.req).toBe(false)
    }
  })

  it('keeps the prompt in the request, which is the expensive thing on that screen', () => {
    const plan = planSubmit({
      draft: { harness, cwd: '/r', prompt: 'p' }, hasSpawn: true, attach: false,
    })
    if (plan.ok) expect(plan.req.prompt).toBe('p')
  })
})

describe('sessionAge', () => {
  const ago = (s: number) => `${s}s`

  it('says nothing for a row that is running', () => {
    // A live session's age is idle curiosity; the column exists for the "reopen this or not"
    // decision, and a running row spends it on nothing.
    const live = session('a', { state: 'waiting' as SessionState, startedAt: 0 })
    expect(sessionAge(live, 60_000, ago)).toBe('')
  })

  it('says how long ago a row that is DOWN went off', () => {
    const down = session('a', { state: 'lost' as SessionState, endedAt: 0 })
    expect(sessionAge(down, 60_000, ago)).toBe('60s')
  })

  it('never answers with the START time, which is a different fact', () => {
    // The column is read as "how long has this been off". A row that began three days ago and was
    // alive until ten minutes ago must not report three days, so there is no fallback at all.
    const down = session('a', { state: 'lost' as SessionState, startedAt: 0 })
    expect(sessionAge(down, 60_000, ago)).toBe('')
  })

  it('says nothing when nobody recorded it', () => {
    // Absent is absent. An instant nobody has is not "1970", and rendering it as fifty-six years
    // is worse than a blank.
    const down = session('a', { state: 'lost' as SessionState })
    expect(sessionAge(down, 60_000, ago)).toBe('')
  })

  it('never reports a negative age', () => {
    const down = session('a', { state: 'exited' as SessionState, endedAt: 90_000 })
    expect(sessionAge(down, 60_000, ago)).toBe('0s')
  })

  it('uses endedAt when available for a closed row', () => {
    const closed = session('a', { state: 'closed' as SessionState, startedAt: 0, endedAt: 40_000 })
    expect(sessionAge(closed, 60_000, ago)).toBe('20s')
  })
})

describe('sessionKeyHelp', () => {
  const words = Object.fromEntries(
    ['move', 'open', 'attach', 'menu', 'section', 'newSession', 'search', 'clear', 'kill',
      'rename', 'note', 'task', 'openTask', 'finishTask', 'recent', 'cascade',
      'mark', 'onlyActive', 'closed', 'exited', 'group', 'layout',
      'detail', 'menuFold', 'reset', 'tabs', 'help', 'quit',
      'approve', 'prompt', 'reopenFell'].map(k => [k, `does ${k}`]),
  ) as Parameters<typeof sessionKeyHelp>[0]

  it('describes every key it lists, with no blanks', () => {
    const rows = sessionKeyHelp(words)
    expect(rows.length).toBeGreaterThan(15)
    for (const r of rows) {
      expect(r.keys.length).toBeGreaterThan(0)
      expect(r.what.length).toBeGreaterThan(0)
    }
  })

  it('names each keystroke once', () => {
    // Two rows claiming the same key is the reference disagreeing with itself.
    const keys = sessionKeyHelp(words).map(r => r.keys)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('sizes the keystroke column to its widest row', () => {
    const rows = sessionKeyHelp(words)
    expect(keyHelpColumn(rows)).toBe(Math.max(...rows.map(r => r.keys.length)))
    expect(keyHelpColumn([])).toBe(0)
  })
})

describe('cardGrid', () => {
  // Two columns too wide is not a cosmetic miss: the frame truncates every card it just measured.
  // Two rows too tall is worse — Ink composites the overflow onto the rows below rather than
  // clipping it, which reads as a corrupted frame rather than a cramped one.
  it('never draws a grid wider or taller than the region it was measured against', () => {
    for (let w = 10; w <= 200; w++) {
      for (let h = 2; h <= 44; h++) {
        const g = cardGrid({ width: w, height: h, total: 40 })
        if (!g) continue
        expect(g.cols * g.cardWidth + CARD_GAP * (g.cols - 1)).toBeLessThanOrEqual(w)
        expect(g.rows * g.cardHeight).toBeLessThanOrEqual(h)
        expect(g.cardWidth).toBeGreaterThanOrEqual(CARD_MIN_WIDTH)
      }
    }
  })

  it('gives up rather than drawing a card that cannot hold one', () => {
    expect(cardGrid({ width: CARD_MIN_WIDTH - 1, height: 40, total: 9 })).toBeNull()
    expect(cardGrid({ width: 120, height: 4, total: 9 })).toBeNull()
  })

  // Ten is the CAP, not the promise: a page holds what the grid can actually show, so there is
  // never a card on the page that the reader has to scroll to reach.
  it('never offers a page above the cap', () => {
    for (let w = 28; w <= 200; w++) {
      const g = cardGrid({ width: w, height: 44, total: 200 })
      if (g) expect(g.capacity).toBeLessThanOrEqual(CARD_PAGE_MAX)
    }
  })

  // A grid shaped for ten cards while the fleet has three is nine empty holes and three cards.
  it('shapes itself to the fleet, not to the cap', () => {
    const g = cardGrid({ width: 180, height: 40, total: 3 })!
    expect(g.cols * g.rows).toBeLessThanOrEqual(4)
    expect(g.capacity).toBeLessThanOrEqual(3)
  })

  it('spends surplus width on wider cards rather than on more columns than the page can use', () => {
    const g = cardGrid({ width: 200, height: 40, total: 4 })!
    expect(g.cols).toBeLessThanOrEqual(4)
    expect(g.cardWidth).toBeGreaterThan(CARD_MIN_WIDTH)
  })

  // A band's real cost is its cards PLUS the name over them. Sizing as though a band were only its
  // cards is what made the grouped grid page four times over: the ceiling was measured for a region
  // that then had to pay a row per band out of the very same rows.
  it('charges a heading row to every band when the grid will draw them', () => {
    for (let w = CARD_MIN_WIDTH; w <= 200; w += 7) {
      for (let h = 2; h <= 44; h++) {
        const g = cardGrid({ width: w, height: h, total: 40, headings: true })
        if (!g) continue
        expect(g.rows * (g.cardHeight + 1)).toBeLessThanOrEqual(h)
        expect(g.cardHeight).toBeGreaterThanOrEqual(PANE_FRAME_Y + CARD_MIN_LINES)
      }
    }
  })

  // Same region, one more group on the page and one line less on each card.
  it('trades a line of card for another band', () => {
    const plain = cardGrid({ width: 100, height: 18, total: 9, lines: CARD_LINES })!
    const headed = cardGrid({ width: 100, height: 18, total: 9, lines: CARD_LINES, headings: true })!
    expect(headed.cardHeight).toBe(plain.cardHeight - 1)
  })

  // The degradation ladder is unchanged: a region that cannot carry a headed band is asked again
  // without headings, and only then does the screen fall back to the list.
  it('refuses a region too short for a band with a name over it', () => {
    const floor = PANE_FRAME_Y + CARD_MIN_LINES
    expect(cardGrid({ width: 120, height: floor, total: 9, headings: true })).toBeNull()
    expect(cardGrid({ width: 120, height: floor, total: 9 })).not.toBeNull()
  })
})

describe('cardPages', () => {
  /** `n` sessions under one heading, in the shape `sessionRows` hands over. */
  const grouped = (...groups: Array<[string, number]>): SessionRow[] => {
    const out: SessionRow[] = []
    let n = 0
    for (const [label, count] of groups) {
      if (out.length > 0) out.push({ kind: 'spacer' })
      out.push({ kind: 'heading', label, count })
      for (let i = 0; i < count; i++) out.push({ kind: 'session', session: session(`s${n++}`) })
    }
    return out
  }
  const flat = (n: number): SessionRow[] =>
    Array.from({ length: n }, (_, i) => ({ kind: 'session', session: session(`s${i}`) }))

  const pack = (rows: SessionRow[], o: Partial<Parameters<typeof cardPages>[0]> = {}) =>
    cardPages({ rows, cols: 3, gridRows: 24, cardHeight: 7, capacity: 9, headed: true, ...o })

  // The whole point of the change: a band belongs to ONE group, so a short group leaves the rest of
  // its band empty rather than being padded out with the next group's cards.
  it('gives every group its own bands', () => {
    const pages = pack(grouped(['agentistics', 2], ['aipe', 1]))
    expect(pages).toHaveLength(1)
    expect(pages[0]!.bands).toEqual([
      { kind: 'heading', label: 'agentistics', count: 2, muted: false },
      { kind: 'cards', items: [0, 1], height: 7 },
      { kind: 'heading', label: 'aipe', count: 1, muted: false },
      { kind: 'cards', items: [2], height: 7 },
    ] satisfies CardBand[])
  })

  it('carries a cascade branch PATH onto its band, so the card grid can breadcrumb it', () => {
    // The band title is the whole path in the grid, where the list indents instead. It travels on
    // the row rather than being re-derived, for the same reason `cardBadges` reads the heading: a
    // second derivation of the arrangement disagrees with the first the moment either changes.
    const rows: SessionRow[] = [
      { kind: 'heading', label: 'session-monitor', count: 1, depth: 2, path: ['agentistics', '.claude/worktrees', 'session-monitor'] },
      { kind: 'session', session: session('a') },
    ]
    expect(pack(rows)[0]!.bands[0]).toEqual({
      kind: 'heading',
      label: 'session-monitor',
      count: 1,
      muted: false,
      path: ['agentistics', '.claude/worktrees', 'session-monitor'],
    })
  })

  it('repeats the whole crumb when a branch crosses a page break', () => {
    // A card under no name does not say what it belongs to, and half a crumb says it wrongly.
    const rows: SessionRow[] = [
      { kind: 'heading', label: 'tui', count: 4, depth: 1, path: ['agentistics', 'packages/tui'] },
      ...Array.from({ length: 4 }, (_, i) => ({ kind: 'session' as const, session: session(`s${i}`) })),
    ]
    const pages = pack(rows, { cols: 2, gridRows: 8, capacity: 2 })
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) {
      expect(page.bands[0]).toMatchObject({ path: ['agentistics', 'packages/tui'] })
    }
  })

  // A group wider than the grid wraps into more bands of its OWN — never into the next group's.
  it('wraps a long group into further bands under one name', () => {
    const [page] = pack(grouped(['agentistics', 7]), { gridRows: 40, capacity: 9 })
    expect(page!.bands.filter(b => b.kind === 'heading')).toHaveLength(1)
    expect(page!.bands.filter(b => b.kind === 'cards').map(b => b.items))
      .toEqual([[0, 1, 2], [3, 4, 5], [6]])
  })

  // A name with nothing named under it is a row spent saying nothing, and it is the row the page
  // needed for the card that would have answered it.
  it('never ends a page with a heading and no cards', () => {
    for (let gridRows = 8; gridRows <= 40; gridRows++) {
      for (const pages of [pack(grouped(['a', 3], ['b', 2], ['c', 4]), { gridRows })]) {
        for (const page of pages) {
          expect(page.bands.at(-1)?.kind).toBe('cards')
          expect(page.items.length).toBeGreaterThan(0)
        }
      }
    }
  })

  // A card under no name does not say what it belongs to — the same orphan the grouping exists to
  // prevent, wearing a page break instead of a band break.
  it('repeats a split group name at the top of the next page', () => {
    const pages = pack(grouped(['agentistics', 6]), { gridRows: 14, cardHeight: 7 })
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) expect(page.bands[0]).toMatchObject({ kind: 'heading', label: 'agentistics' })
  })

  // Every card is on exactly one page, in order — a packer that drops one loses a session from a
  // screen whose whole job is showing them all.
  it('places every card exactly once, in order', () => {
    for (let cols = 1; cols <= 5; cols++) {
      for (let gridRows = 9; gridRows <= 40; gridRows += 3) {
        const pages = pack(grouped(['a', 4], ['b', 1], ['c', 7]), { cols, gridRows })
        expect(pages.flatMap(p => p.items)).toEqual(Array.from({ length: 12 }, (_, i) => i))
      }
    }
  })

  // Every page must fit the band it was measured against: Ink composites the overflow onto the rows
  // below rather than clipping it, which reads as a corrupted frame rather than a cramped one.
  it('never packs a page taller than the region or wider than the cap', () => {
    for (let cols = 1; cols <= 5; cols++) {
      for (let cardHeight = 5; cardHeight <= 8; cardHeight++) {
        for (let gridRows = cardHeight + 1; gridRows <= 44; gridRows++) {
          const pages = pack(grouped(['a', 5], ['b', 1], ['c', 9], ['d', 2]),
            { cols, gridRows, cardHeight, capacity: Math.min(cols * 3, CARD_PAGE_MAX) })
          for (const page of pages) {
            expect(cardPageRows(page.bands)).toBeLessThanOrEqual(gridRows)
            expect(page.items.length).toBeLessThanOrEqual(Math.min(cols * 3, CARD_PAGE_MAX))
          }
        }
      }
    }
  })

  // With no grouping the screen must draw exactly what it drew before groups reached it: one dense
  // run of cards, `cols` at a time, and no row spent on a name.
  it('packs one dense nameless run when it is not drawing headings', () => {
    const pages = cardPages({
      rows: grouped(['a', 2], ['b', 3]), cols: 3, gridRows: 24, cardHeight: 7, capacity: 9,
      headed: false,
    })
    expect(pages[0]!.bands).toEqual([
      { kind: 'cards', items: [0, 1, 2], height: 7 },
      { kind: 'cards', items: [3, 4], height: 7 },
    ] as CardBand[])
  })

  it('is the plain grid when the rows carry no heading at all', () => {
    const pages = cardPages({
      rows: flat(5), cols: 2, gridRows: 21, cardHeight: 7, capacity: 6, headed: true,
    })
    expect(pages[0]!.bands.every(b => b.kind === 'cards')).toBe(true)
    expect(pages[0]!.items).toEqual([0, 1, 2, 3, 4])
  })

  it('has no pages at all for an empty fleet', () => {
    expect(pack([])).toEqual([])
    expect(pack([{ kind: 'heading', label: 'a', count: 0 }])).toEqual([])
  })

  // One height for the whole grid is the height of the RICHEST card in the fleet, so a single
  // session carrying a model, a task and a note made every other card two rows taller than it had
  // anything to put in them. Rows of blank inside a frame are a box with a name in it.
  it('sizes each band to its own tallest card', () => {
    // Six cards: the first band's are rich, the second band's have two facts each.
    const [page] = cardPages({
      rows: grouped(['rich', 2], ['plain', 2]),
      cols: 2, gridRows: 40, cardHeight: 8, capacity: 8, headed: true,
      lines: [6, 5, 2, 2],
    })
    const heights = page!.bands.flatMap(b => (b.kind === 'cards' ? [b.height] : []))
    // The rich band takes its tallest card; the plain band gives the rows back.
    expect(heights).toEqual([PANE_FRAME_Y + 6, PANE_FRAME_Y + CARD_MIN_LINES])
  })

  // A band is never squeezed below what makes a card a card, and never grows past what the region
  // can afford — the ceiling `cardGrid` measured.
  it('keeps every band between the card floor and the region’s ceiling', () => {
    for (let cardHeight = 5; cardHeight <= 8; cardHeight++) {
      const pages = cardPages({
        rows: grouped(['a', 3], ['b', 2]),
        cols: 2, gridRows: 44, cardHeight, capacity: 6, headed: true,
        lines: [9, 1, 0, 4, 2],
      })
      for (const page of pages) {
        for (const b of page.bands) {
          if (b.kind !== 'cards') continue
          expect(b.height).toBeGreaterThanOrEqual(
            Math.min(cardHeight, PANE_FRAME_Y + CARD_MIN_LINES))
          expect(b.height).toBeLessThanOrEqual(cardHeight)
        }
      }
    }
  })

  // The rows a short band gives back become another band on the page, not air under the pager.
  it('spends the rows a short band gives back on more bands', () => {
    const rows = grouped(['a', 1], ['b', 1], ['c', 1], ['d', 1])
    const uniform = cardPages({
      rows, cols: 2, gridRows: 20, cardHeight: 8, capacity: 8, headed: true,
    })
    const measured = cardPages({
      rows, cols: 2, gridRows: 20, cardHeight: 8, capacity: 8, headed: true,
      lines: [3, 3, 3, 3],
    })
    // Four groups of one, so every band costs a heading plus a card: at the ceiling that is 9 rows
    // and two fit; measured it is 6 and three do.
    expect(uniform[0]!.items).toHaveLength(2)
    expect(measured[0]!.items).toHaveLength(3)
  })

  // Without the counts every band takes the ceiling — the uniform grid, unchanged.
  it('is the uniform grid when the caller counted nothing', () => {
    const [page] = pack(grouped(['a', 2]))
    expect(page!.bands.flatMap(b => (b.kind === 'cards' ? [b.height] : []))).toEqual([7])
  })
})

describe('pageOfCard', () => {
  const pages = [
    { bands: [], items: [0, 1] },
    { bands: [], items: [2, 3] },
  ]

  it('finds the page holding a card, and opens the first for one no page holds', () => {
    expect(pageOfCard(pages, 3)).toBe(1)
    expect(pageOfCard(pages, 0)).toBe(0)
    // A cursor past the end for one frame — which is the frame someone presses a key on.
    expect(pageOfCard(pages, 99)).toBe(0)
    expect(pageOfCard([], 0)).toBe(0)
  })
})

describe('cardBadges', () => {
  it('names each card with the heading the list would have drawn above it', () => {
    const rows: SessionRow[] = [
      { kind: 'heading', label: 'agentistics', count: 2 },
      { kind: 'session', session: session('a') },
      { kind: 'spacer' },
      { kind: 'heading', label: 'agentistics · closed', count: 1, muted: true },
      { kind: 'session', session: session('b') },
    ]
    expect(cardBadges(rows)).toEqual(['agentistics', 'agentistics · closed'])
  })

  // With grouping off there is no heading at all, and a card with a blank badge is a frame with a
  // gap in it. The project is the fact every session already carries.
  it('falls back to the project when there is no heading', () => {
    const rows: SessionRow[] = [
      { kind: 'session', session: session('a', { project: 'notes', projectGroup: 'agentistics' }) },
    ]
    expect(cardBadges(rows)).toEqual(['agentistics'])
  })
})

describe('cardLines', () => {
  const labels = {
    attached: 'attached', blind: 'approval unknown', ago: () => '22min ago',
    worktree: 'worktree', project: 'project', task: 'task', note: 'note', model: 'model',
  }
  const base = session('a1b2c3', { title: 'migrate the auth store', harness: 'claude' })

  // The complaint this whole change answers: `session-monitor` is a folder and
  // `cockpit: event channel` is a task, drawn identically, with nothing on the card saying which is
  // which. The list solves it with a column header the grid has no room for.
  it('names every fact a reader cannot name from its value', () => {
    const lines = cardLines({
      ...base, project: 'session-monitor', projectGroup: 'agentistics', worktree: true,
      model: 'opus', task: 'billing', note: 'blocked on the CSV encoding',
    }, labels)
    const label = (key: string) => lines.find(l => l.key === key)?.label
    expect(label('where')).toBe('worktree')
    expect(label('model')).toBe('model')
    expect(label('task')).toBe('task')
    expect(label('note')).toBe('note')
    // And leaves alone the ones that say what they are.
    expect(label('title')).toBeUndefined()
    expect(label('state')).toBeUndefined()
    expect(label('usage')).toBeUndefined()
  })

  // A worktree and a project are the same shape of word, so the label is what tells them apart.
  it('says which KIND of place the folder is', () => {
    expect(cardLines({ ...base, project: 'notes' }, labels).find(l => l.key === 'where'))
      .toMatchObject({ text: 'notes', label: 'project' })
    expect(cardLines(
      { ...base, project: 'notes', projectGroup: 'agentistics', worktree: true }, labels,
    ).find(l => l.key === 'where')).toMatchObject({ text: 'notes', label: 'worktree' })
  })

  // Appended to the folder it was a bare word after a path, which reads as another path.
  it('gives the model a line of its own, and none when there is no model', () => {
    expect(cardLines({ ...base, model: 'opus' }, labels).find(l => l.key === 'model')?.text)
      .toBe('opus')
    expect(cardLines(base, labels).some(l => l.key === 'model')).toBe(false)
    expect(cardLines({ ...base, model: 'opus' }, labels).find(l => l.key === 'where')?.text)
      .not.toContain('opus')
  })

  // The ORDER is the give-up order — `fitCardLines` cuts from the bottom — so it is the thing worth
  // pinning: the name and the state can never be lost, and a card as tall as `CARD_LINES` reaches
  // the note. What the assistant is saying sits below that and is what a full card gives up.
  it('composes its facts in the order a short card gives them up', () => {
    const full = cardLines({
      ...base, tokens: '51.7k', cost: '$1.24', model: 'opus', task: 'billing', note: 'a note',
      lastLines: ['running the migration'],
    }, labels)
    expect(full.map(l => l.key))
      .toEqual(['title', 'state', 'usage', 'where', 'model', 'task', 'note', 'say'])
    expect(fitCardLines(full, CARD_LINES).map(l => l.key))
      .toEqual(['title', 'state', 'usage', 'where', 'model', 'task', 'note'])
  })

  // The gauge takes the slot right after the usage it belongs with, so on a card as tall as
  // `CARD_LINES` it displaces the LAST fact rather than any of the identifying ones.
  it('places the gauge under the usage without costing the name, state or place', () => {
    const full = cardLines({
      ...base, tokens: '51.7k', cost: '$1.24', model: 'opus', task: 'billing', note: 'a note',
      context: { fraction: 0.87, label: '87%', used: '174k', window: '200k' },
      lastLines: ['running the migration'],
    }, labels)
    expect(full.map(l => l.key))
      .toEqual(['title', 'state', 'usage', 'context', 'where', 'model', 'task', 'note', 'say'])
    expect(fitCardLines(full, CARD_LINES).map(l => l.key))
      .toEqual(['title', 'state', 'usage', 'context', 'where', 'model', 'task'])
  })

  it('always carries the name and the state, in that order', () => {
    const lines = cardLines(base, labels)
    expect(lines[0]).toMatchObject({ kind: 'title', text: 'migrate the auth store' })
    // The helper's default state is `waiting` / `waiting`.
    expect(lines[1]).toMatchObject({ kind: 'state', text: 'waiting' })
  })

  // A harness that cannot report usage would otherwise show every one of its sessions costing
  // nothing, which is a confident wrong number in the place a person looks to decide what to close.
  it('omits the usage line entirely when nothing was recorded', () => {
    expect(cardLines(base, labels).some(l => l.key === 'usage')).toBe(false)
    const priced = cardLines({ ...base, tokens: '51.7k', cost: '$1.24' }, labels)
    expect(priced.find(l => l.key === 'usage')?.text).toBe('51.7k $1.24')
  })

  it('omits what it is saying when the host reported nothing', () => {
    expect(cardLines(base, labels).some(l => l.kind === 'say')).toBe(false)
    const talking = cardLines({ ...base, lastLines: ['running the migration'] }, labels)
    expect(talking.find(l => l.kind === 'say')?.text).toBe('running the migration')
  })

  it('marks an attached session and one whose approvals cannot be read', () => {
    const line = cardLines({ ...base, attached: true, approvalBlind: 'no markers' }, labels)[1]!
    expect(line.tail).toContain('attached')
    expect(line.tail).toContain('approval unknown')
  })
})

describe('fitCardLines', () => {
  const line = (key: string, kind: 'title' | 'state' | 'fact'): CardLine => ({ key, kind, text: key })

  it('cuts from the bottom and never gives up the name or the state', () => {
    const lines = [line('t', 'title'), line('s', 'state'), line('a', 'fact'), line('b', 'fact')]
    expect(fitCardLines(lines, 2).map(l => l.key)).toEqual(['t', 's'])
    expect(fitCardLines(lines, 0)).toEqual([])
    expect(fitCardLines(lines, 9)).toHaveLength(4)
  })
})

describe('cardStateCells', () => {
  // The state is the one cell nothing else on a card repeats — the same rule `sessionCells` keeps
  // for the row. The tail (harness, markers) is said again by the colour and by the detail pane.
  it('gives up the tail before the state word', () => {
    expect(cardStateCells('needs approval', ' · claude', 40))
      .toEqual({ state: 'needs approval', tail: ' · claude' })
    expect(cardStateCells('needs approval', ' · claude', 16))
      .toEqual({ state: 'needs approval', tail: '' })
    expect(cardStateCells('needs approval', ' · claude', 8).tail).toBe('')
    expect(cardStateCells('needs approval', ' · claude', 8).state.length).toBeLessThanOrEqual(8)
  })
})

describe('cardBand', () => {
  // The column header names cells that a card does not have, so its row is reclaimed rather than
  // drawn blank — and the pager is a ROW, which has to be paid for out of the same band or it is
  // composited onto the frame below it.
  it('reclaims the header row and pays for the pager', () => {
    expect(cardBand({ listRows: 18, header: true })).toEqual({ gridRows: 18, pager: true })
    expect(cardBand({ listRows: 18, header: false })).toEqual({ gridRows: 17, pager: true })
  })

  it('gives up the pager before it gives up the grid', () => {
    const tight = cardBand({ listRows: 5, header: false })
    expect(tight.pager).toBe(false)
    expect(tight.gridRows).toBe(5)
  })
})

describe('cardLabelWidth', () => {
  const lines: CardLine[] = [
    { key: 'title', kind: 'title', text: 'migrate the auth store' },
    { key: 'where', kind: 'fact', text: 'session-monitor', label: 'worktree' },
    { key: 'task', kind: 'fact', text: 'billing', label: 'task' },
  ]

  // One column for every label on the card, so the values all start in the same place — the jumble
  // `sessionColumns` prevents on the list, prevented on the card.
  it('sizes the column to the widest label the card actually carries', () => {
    expect(cardLabelWidth(lines, 40)).toBe('worktree'.length)
  })

  // `worktree  sess…` names the field and stops answering which one, which is the trade the labels
  // exist to avoid. All-or-nothing per card: labels that come and go leave a ragged column.
  it('gives up the labels rather than squeeze the values below what they need', () => {
    expect(cardLabelWidth(lines, 'worktree'.length + 2 + CARD_VALUE_MIN)).toBe(8)
    expect(cardLabelWidth(lines, 'worktree'.length + 2 + CARD_VALUE_MIN - 1)).toBe(0)
  })

  it('spends nothing on a card with no labelled line', () => {
    expect(cardLabelWidth([lines[0]!], 40)).toBe(0)
    expect(cardLabelWidth([], 40)).toBe(0)
  })
})

describe('cardHit', () => {
  const grid = cardGrid({ width: 100, height: 21, total: 10 })!
  const bands: CardBand[] = [
    { kind: 'heading', label: 'agentistics', count: 3, muted: false },
    { kind: 'cards', items: [0, 1, 2], height: grid.cardHeight },
    { kind: 'heading', label: 'aipe', count: 1, muted: false },
    // Shorter than the band above it — the bands of one page do NOT share a height.
    { kind: 'cards', items: [3], height: grid.cardHeight - 1 },
  ]
  const hit = (x: number, y: number) =>
    cardHit({ bands, cardWidth: grid.cardWidth, gap: grid.gap, x, y })

  // Resolved against the bands that were DRAWN, never against a uniform grid: a heading costs a row
  // and re-deriving the geometry from `cols` answers with the card one row up.
  it('answers with the card whose own cells were clicked, headings paid for', () => {
    expect(hit(0, 1)).toBe(0)
    expect(hit(grid.cardWidth - 1, grid.cardHeight)).toBe(0)
    expect(hit(grid.cardWidth + grid.gap, 1)).toBe(1)
    // The second group's band starts after the first band AND its own heading row.
    expect(hit(0, 1 + grid.cardHeight + 1)).toBe(3)
  })

  // The gutter belongs to neither card, a heading belongs to no card, and the empty right-hand end
  // of a short group's band is not a card either — each is a click the user did not make.
  it('answers nothing for the gutter, the headings and a short band’s empty end', () => {
    expect(hit(grid.cardWidth, 1)).toBeNull()
    expect(hit(0, 0)).toBeNull()
    expect(hit(0, 1 + grid.cardHeight)).toBeNull()
    expect(hit(grid.cardWidth + grid.gap, 1 + grid.cardHeight + 1)).toBeNull()
    expect(hit(0, 99)).toBeNull()
    expect(hit(-1, 1)).toBeNull()
  })

  it('never answers with a card the page does not hold', () => {
    const height = cardPageRows(bands)
    for (let y = 0; y < height + 2; y++) {
      for (let x = 0; x < grid.cols * (grid.cardWidth + grid.gap) + 2; x++) {
        const found = hit(x, y)
        if (found !== null) expect([0, 1, 2, 3]).toContain(found)
      }
    }
  })
})

describe('cardStep', () => {
  // Stepping by `cols` was right while every band was full, and jumped clean over the band below a
  // one-card group the moment grouping arrived.
  const pages = [
    {
      bands: [
        { kind: 'heading', label: 'a', count: 1, muted: false },
        { kind: 'cards', items: [0], height: 7 },
        { kind: 'heading', label: 'b', count: 3, muted: false },
        { kind: 'cards', items: [1, 2, 3], height: 7 },
      ] as CardBand[],
      items: [0, 1, 2, 3],
    },
    { bands: [{ kind: 'cards', items: [4, 5], height: 7 }] as CardBand[], items: [4, 5] },
  ]

  it('steps band to band, keeping the column', () => {
    expect(cardStep(pages, 0, 1)).toBe(1)
    expect(cardStep(pages, 2, -1)).toBe(0)
    expect(cardStep(pages, 2, 1)).toBe(5)
  })

  // The page FOLLOWS the cursor, so stepping off the bottom band is how the next page is reached.
  it('walks across the page boundary and clamps at the ends', () => {
    expect(cardStep(pages, 1, 1)).toBe(4)
    expect(cardStep(pages, 0, -1)).toBe(0)
    expect(cardStep(pages, 5, 1)).toBe(5)
    // A shorter band takes the cursor at its last card rather than dropping it.
    expect(cardStep(pages, 3, 1)).toBe(5)
    expect(cardStep(pages, 99, 1)).toBe(99)
  })

  it('lists the bands of cards across every page, in drawing order', () => {
    expect(cardRows(pages)).toEqual([[0], [1, 2, 3], [4, 5]])
  })
})

describe('pagerCells', () => {
  it('keeps the arrows and the page, and gives up the count first', () => {
    const wide = pagerCells({ label: '2 / 5', note: 'showing 6 of 47', width: 40 })
    expect(wide.note).toBe('showing 6 of 47')
    const tight = pagerCells({ label: '2 / 5', note: 'showing 6 of 47', width: 12 })
    expect(tight.note).toBe('')
    expect(tight.label).toBe('2 / 5')
    expect(tight.nextAt).toBeGreaterThan(tight.prevAt)
  })

  // A row wider than the pane wraps, and a wrapped row takes two of the screen's rows while the
  // budget counted one — which pushes everything under it off the bottom.
  it('never draws wider than the row it was measured against', () => {
    for (let w = 0; w <= 60; w++) {
      const c = pagerCells({ label: '10 / 10', note: 'showing 10 of 100', width: w })
      expect(c.width).toBeLessThanOrEqual(w)
    }
  })

  it('resolves a click to the arrow that was drawn there', () => {
    const c = pagerCells({ label: '2 / 5', note: '', width: 20 })
    expect(pagerHit(c, c.prevAt)).toBe('prev')
    expect(pagerHit(c, c.nextAt)).toBe('next')
    expect(pagerHit(c, c.prevAt + 1)).toBeNull()
  })
})

describe('asideRows — the layout section', () => {
  const rowsFor = (value: 'list' | 'cards') => asideRows({
    actions: sessionActions(session('m')),
    actionWords: {
      attach: 'A', resume: 'R', rename: 'N', note: 'O', task: 'T', kill: 'K',
      openTask: 'OT', reopenFell: 'RF', finishTask: 'FT', approve: 'AP', prompt: 'PR',
      new: 'NW', search: 'S', group: 'G',
    },
    grouping: 'project',
    groupWords: {
      day: 'day',
      repo: 'repository', none: 'flat', tree: 'cascade', task: 'task', harness: 'harness', model: 'model',
      project: 'project', status: 'state', marked: 'marked',
    },
    layout: { ...LAYOUT, value },
    toggles: { history: false, named: false, done: false, active: true, detail: false, cascade: false },
    toggleWords: {
      history: 'closed', named: 'named', done: 'done', active: 'active',
      detail: 'detail', cascade: 'cascade',
    },
    headings: { actions: 'ACTIONS', view: 'VIEW', show: 'SHOW' },
  })

  it('offers both layouts and marks the one in force', () => {
    const rows = rowsFor('cards').filter(r => r.kind === 'layout')
    expect(rows).toHaveLength(2)
    expect(rows.map(r => (r as { value: string }).value)).toEqual(['list', 'cards'])
    expect(rows.map(r => (r as { on: boolean }).on)).toEqual([false, true])
  })

  // The cursor is a NAME, not a position: the menu is rebuilt on every poll, and an index would be
  // pointing at a different row by the next one.
  it('keys a layout row by what it selects', () => {
    const row = rowsFor('list').find(r => r.kind === 'layout')!
    expect(asideRowKey(row)).toBe('layout:list')
  })

  it('lets the cursor land on a layout row', () => {
    const rows = rowsFor('list')
    const index = rows.findIndex(r => r.kind === 'layout')
    expect(asideSelectable(rows)).toContain(index)
  })
})

describe('the sessions that fell together', () => {
  const fallen = (id: string) =>
    session(id, { state: 'lost' as SessionState, stateLabel: 'lost', fell: true })
  const history = (id: string) =>
    session(id, { state: 'closed' as SessionState, stateLabel: 'closed' })
  const live = (id: string) => session(id, { state: 'working' as SessionState, stateLabel: 'working' })

  const headings = (rows: SessionRow[]) =>
    rows.filter(r => r.kind === 'heading').map(r => (r as { label: string }).label)

  it('is its own section, between what is running and what is history', () => {
    const rows = sessionRows(
      groupSessions([live('w'), fallen('f'), history('c')], 'none', UNKNOWN),
      'closed', 'finished', 'fell together',
    )
    expect(headings(rows)).toEqual(['fell together', 'closed'])
    // In reading order: the live rows, then what fell, then history.
    const ids = rows.flatMap(r => (r.kind === 'session' ? [r.session.id] : []))
    expect(ids).toEqual(['w', 'f', 'c'])
  })

  it('is NOT muted — it is the one block on this screen asking to be acted on', () => {
    const rows = sessionRows(
      groupSessions([fallen('f'), history('c')], 'none', UNKNOWN),
      'closed', 'finished', 'fell together',
    )
    const fell = rows.find(r => r.kind === 'heading' && r.label === 'fell together')
    const closed = rows.find(r => r.kind === 'heading' && r.label === 'closed')
    expect((fell as { muted?: boolean }).muted).toBeUndefined()
    expect((closed as { muted?: boolean }).muted).toBe(true)
  })

  it('leaves the rows exactly where they were when nothing fell', () => {
    // The section is an addition to the reading order, never a change to which rows are listed. A
    // machine with no fall on record must draw the same screen it drew before this existed.
    const before = sessionRows(groupSessions([fallen('f')], 'none', UNKNOWN), 'closed', 'finished')
    expect(headings(before)).toEqual(['closed'])
  })

  it('never claims a RUNNING row fell, whatever the flag says', () => {
    // A row can be marked and then come back — a reopen leaves the flag on the retired row, not the
    // new one, but a stale snapshot could still pair the two. Something running is not something
    // lost, and the live section is decided before the mark is consulted.
    const rows = sessionRows(
      groupSessions([session('w', { state: 'working' as SessionState, stateLabel: 'working', fell: true })], 'none', UNKNOWN),
      'closed', 'finished', 'fell together',
    )
    expect(headings(rows)).toEqual([])
  })

  it('says which group a fallen row belongs to, so a heading read alone is never ambiguous', () => {
    const rows = sessionRows(
      groupSessions([fallen('f')], 'project', UNKNOWN),
      'closed', 'finished', 'fell together',
    )
    expect(headings(rows)).toEqual(['f · fell together'])
  })
})

describe('sessionActions — the fleet verb', () => {
  const of = (s: ControlSession | undefined, fleet?: { fell?: number }) =>
    sessionActions(s, fleet).find(a => a.action === 'reopenFell')

  it('is offered only when something actually fell', () => {
    expect(of(session('a'), { fell: 3 })?.enabled).toBe(true)
    expect(of(session('a'), { fell: 0 })?.enabled).toBe(false)
    expect(of(session('a'))?.enabled).toBe(false)
  })

  it('never disappears — the row keeps its shape, and the dim verb says why nothing happens', () => {
    expect(of(undefined)).toBeDefined()
  })
})

describe('sessionActions — approve and prompt', () => {
  const find = (s: ControlSession, a: 'approve' | 'prompt') =>
    sessionActions(s).find(x => x.action === a)!

  const blocked = session('b', {
    state: 'waiting-approval' as SessionState, stateLabel: 'needs approval', canApprove: true,
  })

  it('offers approve only where the HOST said it can work', () => {
    expect(find(blocked, 'approve').enabled).toBe(true)
    // Blocked, but nobody has read this harness's dialog: there is no key to send, so the verb is
    // dim rather than present and guessing.
    expect(find(session('b2', {
      state: 'waiting-approval' as SessionState, stateLabel: 'needs approval',
    }), 'approve').enabled).toBe(false)
    // Not blocked at all. Sending the confirm key here is a blank turn.
    expect(find(session('w', { state: 'working' as SessionState }), 'approve').enabled).toBe(false)
  })

  it('offers prompt on anything RUNNING, blocked included', () => {
    // A session sitting on a dialog is still refused — but by the HOST, which re-reads the screen.
    // Deciding it here would decide it from a list up to a poll old.
    expect(find(blocked, 'prompt').enabled).toBe(true)
    expect(find(session('w', { state: 'working' as SessionState }), 'prompt').enabled).toBe(true)
    expect(find(session('e', { state: 'exited' as SessionState }), 'prompt').enabled).toBe(false)
    expect(find(session('x', {
      state: 'unknown' as SessionState, actionable: false,
    }), 'prompt').enabled).toBe(false)
  })
})

describe('askRows', () => {
  it('is the question floor when there is no evidence to show', () => {
    expect(askRows({ preview: 0, detail: 0 })).toBe(QUESTION_ROWS)
  })

  it('BUDGETS the dialog, plus the rule between it and the question', () => {
    // Ink composites what does not fit, so an unbudgeted preview does not crowd the two answers —
    // it draws over whatever sits under them.
    expect(askRows({ preview: 4, detail: 0 })).toBe(QUESTION_ROWS + 5)
  })

  it('never asks for more preview than a confirmation will ever draw', () => {
    expect(askRows({ preview: 99, detail: 0 })).toBe(QUESTION_ROWS + APPROVAL_PREVIEW_MAX + 1)
  })

  it('still gives the facts their rows when they need more', () => {
    expect(askRows({ preview: 0, detail: 20 })).toBe(20)
  })

  it('never goes negative on nonsense input', () => {
    expect(askRows({ preview: -5, detail: -5 })).toBe(QUESTION_ROWS)
  })
})

describe('fitApprovalPreview', () => {
  const DIALOG = ['context', 'Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Enter to confirm']

  it('cuts from the TOP, so the options and the footer survive', () => {
    // The bottom is the part being answered. Cutting the other way round leaves a question with its
    // answers off screen, which is the one thing a confirmation may not do.
    expect(fitApprovalPreview(DIALOG, 2)).toEqual(['  2. No', 'Enter to confirm'])
  })

  it('shows a short dialog whole', () => {
    expect(fitApprovalPreview(['a', 'b'], 6)).toEqual(['a', 'b'])
  })

  it('is capped however many rows it is offered', () => {
    const long = Array.from({ length: 30 }, (_, i) => `l${i}`)
    expect(fitApprovalPreview(long, 99)).toHaveLength(APPROVAL_PREVIEW_MAX)
  })

  it('draws nothing when there is no room, rather than one useless line', () => {
    expect(fitApprovalPreview(DIALOG, 0)).toEqual([])
    expect(fitApprovalPreview(DIALOG, -3)).toEqual([])
  })
})

describe('summaryCells — the fall', () => {
  const full = {
    group: 'GROUP task',
    hiding: '− closed conversations',
    count: '18 sessions',
    waiting: '3 waiting on you',
    fell: '4 sessions fell 2m ago — R reopens them',
    width: 200,
  }

  const rendered = (c: ReturnType<typeof summaryCells>) => {
    const kept = [c.group, c.hiding, c.count, c.waiting, c.fell].filter(Boolean)
    return kept.reduce((n, p) => n + p.length, 0) + 3 * Math.max(0, kept.length - 1)
  }

  it('outlives the cells that merely DESCRIBE the list', () => {
    // Everything beside it says what the list contains; this says what is one keypress from coming
    // back. It is also usually absent, so it costs nothing on an ordinary machine.
    const c = summaryCells({ ...full, width: 55 })
    expect(c.fell).toBe(full.fell)
    expect(c.hiding).toBe('')
    expect(c.count).toBe('')
  })

  it('is given up before the grouping, which explains the arrangement', () => {
    const c = summaryCells({ ...full, width: 12 })
    expect(c.fell).toBe('')
    expect(c.group).toContain('GROUP')
  })

  it('NEVER renders wider than it was given, at any width', () => {
    for (let w = 0; w <= 240; w++) {
      expect(rendered(summaryCells({ ...full, width: w }))).toBeLessThanOrEqual(Math.max(w, 0) || 0)
    }
  })
})

describe('detailLines — named in two places', () => {
  const labels = {
    where: 'where', model: 'model', note: 'note', started: 'started',
    external: 'external', closed: 'closed', doing: 'saying', task: 'task', metrics: 'usage', metricsAll: 'in + out + cache',
    context: 'window', conversation: 'conversation',
    alsoLabel: 'named here', alsoHarness: 'named inside',
  }
  const ago = () => '5m ago'
  const row = (over: Partial<ControlSession>) =>
    detailLines(session('a', over), labels, ago).find(l => l.key === 'also')

  it('names the OTHER name, and which place it came from', () => {
    // The label says where the LOSER came from, which is the fact that matters: without it someone
    // who renamed in both places cannot tell whether the name on the row is the one they typed here
    // or the one they typed inside the session — and one of the two renames reads as failed.
    expect(row({ titleSource: 'harness', titleOther: 'Principal' }))
      .toMatchObject({ label: 'named here', value: 'Principal' })
    expect(row({ titleSource: 'label', titleOther: 'principal do cockpit' }))
      .toMatchObject({ label: 'named inside', value: 'principal do cockpit' })
  })

  it('says nothing at all on an ordinary row', () => {
    expect(row({})).toBeUndefined()
  })

  it('sits right under what the session is SAYING, above every other fact', () => {
    // It answers "did my rename work", which is the question someone has the moment they notice the
    // row saying something other than what they typed.
    const lines = detailLines(
      session('a', { titleSource: 'harness', titleOther: 'Principal', lastLines: ['thinking'] }),
      labels, ago,
    )
    expect(lines.map(l => l.key).slice(0, 3)).toEqual(['say0', 'also', 'where'])
  })
})

// ---------------------------------------------------------------------------
// the context gauge
// ---------------------------------------------------------------------------

/** A session carrying a gauge at `pct` percent full. */
const gauged = (id: string, pct: number, over: Partial<ControlSession> = {}): ControlSession =>
  session(id, {
    context: {
      fraction: pct / 100,
      label: `${Math.floor(pct)}%`,
      used: `${pct}k`,
      window: '100k',
    },
    ...over,
  })

describe('contextBar', () => {
  it('fills in proportion, rounding DOWN', () => {
    expect(contextBar(0, 6)).toBe('░░░░░░')
    expect(contextBar(0.5, 6)).toBe('███░░░')
    expect(contextBar(1, 6)).toBe('██████')
  })

  it('never reads full while the window has room left', () => {
    // 99% must not draw six of six. The shape is what gets believed at a glance, so a bar that
    // rounds up is the one telling the lie — and it is the reassuring direction, which is worse.
    expect(contextBar(0.99, 6)).toBe('█████░')
  })

  it('SATURATES past the window instead of drawing outside its cell', () => {
    // A session really can exceed the window this reading was computed against. An overflowing bar
    // would be wider than the column it was measured for and shear every row under it — the exact
    // failure the pure-layout rule exists to prevent.
    expect(contextBar(1.06, 6)).toBe('██████')
    expect(contextBar(44.3, 6)).toBe('██████')
    expect(contextBar(1.06, 6).length).toBe(6)
  })

  it('is exactly `width` columns for every fraction and every width', () => {
    for (let w = 0; w <= 20; w++) {
      for (const f of [-1, 0, 0.001, 0.3333, 0.5, 0.9999, 1, 2, 99, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(contextBar(f, w).length, `w=${w} f=${f}`).toBe(w)
      }
    }
  })

  it('draws nothing at zero width rather than one stray glyph', () => {
    expect(contextBar(0.5, 0)).toBe('')
  })
})

describe('contextLevel', () => {
  it('warns at 80% and calls it full at exactly 100%', () => {
    expect(contextLevel(0)).toBe('ok')
    expect(contextLevel(0.79)).toBe('ok')
    expect(contextLevel(0.8)).toBe('warn')
    expect(contextLevel(0.99)).toBe('warn')
    expect(contextLevel(1)).toBe('full')
    expect(contextLevel(1.06)).toBe('full')
  })
})

describe('sessionContext', () => {
  it('is EMPTY for a row with no reading — never a confident 0%', () => {
    // The three reasons a row has no gauge (harness cannot report it, model has no verified
    // window, no conversation behind the row) all render the same nothing, on purpose.
    expect(sessionContext(session('a'))).toBe('')
  })

  it('is the bar, a space, then the percentage', () => {
    expect(sessionContext(gauged('a', 50))).toBe('███░░░ 50%')
  })
})

describe('sessionColumns — the context cell', () => {
  it('is ZERO when no row on screen has a reading', () => {
    // Never a column of blanks: the heading would name a cell nothing occupies, and every title on
    // the screen would pay for the space.
    expect(sessionColumns([session('a'), session('b')], 200).context).toBe(0)
  })

  it('is drawn as soon as ONE row has a reading', () => {
    const c = sessionColumns([session('a'), gauged('b', 50)], 200)
    expect(c.context).toBe(sessionContext(gauged('b', 50)).length)
  })

  it('sizes to the widest cell on screen, heading included', () => {
    const rows = [gauged('a', 5), gauged('b', 100)]
    // `100%` is a column wider than `5%`, and the heading must fit over both.
    const c = sessionColumns(rows, 200, { headings: { context: 'window' } })
    expect(c.context).toBeGreaterThanOrEqual(sessionContext(gauged('b', 100)).length)
    expect(c.context).toBeGreaterThanOrEqual('window'.length)
  })

  it('outlives the metrics cell under width pressure', () => {
    // The ordering decision stated in SessionColumns: usage is what a session has spent, the gauge
    // is what it has left, and on a narrow terminal the second is the one being acted on.
    const rows = [gauged('a', 50, { tokens: '12.4k', cost: '$0.83', harness: 'claude' })]
    let sawGaugeWithoutMetrics = false
    for (let w = 20; w <= 200; w++) {
      const c = sessionColumns(rows, w)
      if (c.metrics > 0) expect(c.context, `w=${w}`).toBeGreaterThan(0)
      if (c.context > 0 && c.metrics === 0) sawGaugeWithoutMetrics = true
    }
    expect(sawGaugeWithoutMetrics).toBe(true)
  })

  it('never lets a row exceed its width, at any width', () => {
    // The rule the whole module exists for: a row one column too wide wraps and shears every row
    // under it, and Ink composites rather than clipping.
    const rows = [
      gauged('alpha', 45, { tokens: '455.4k', cost: '$12.30', task: 'context gauge', harness: 'claude' }),
      gauged('beta', 106, { tokens: '1.2M', cost: '$3.00', worktree: true, project: 'wt' }),
      session('gamma', { title: 'a very long session title indeed', harness: 'antigravity' }),
    ]
    for (let w = 20; w <= 240; w++) {
      const c = sessionColumns(rows, w, { headings: { context: 'window' } })
      const cells = [c.id, c.state, c.title, c.where, c.harness, c.metrics, c.context, c.task, c.worktree, c.age]
      const drawn = cells.filter(n => n > 0).length
      const total = 2 + cells.reduce((n, v) => n + v, 0) + 2 * (drawn - 1)
      expect(total, `width=${w} → ${total}`).toBeLessThanOrEqual(w)
    }
  })
})

describe('cardLines — the gauge', () => {
  const labels = {
    attached: 'attached', blind: 'blind', ago: () => '5m ago',
    worktree: 'worktree', project: 'project', task: 'task', note: 'note', model: 'model',
  }

  it('gets its OWN line, carrying its level', () => {
    const lines = cardLines(gauged('a', 95), labels)
    const gauge = lines.find(l => l.key === 'context')
    expect(gauge?.kind).toBe('gauge')
    expect(gauge?.level).toBe('warn')
    expect(gauge?.text).toBe(sessionContext(gauged('a', 95)))
  })

  it('is absent — not a zero line — for a row with no reading', () => {
    expect(cardLines(session('a'), labels).some(l => l.key === 'context')).toBe(false)
  })

  it('sits under the usage line and above where', () => {
    const lines = cardLines(
      gauged('a', 50, { tokens: '9k', startedAt: 1, model: 'claude-opus-5' }),
      labels,
    )
    const keys = lines.map(l => l.key)
    expect(keys.indexOf('context')).toBeGreaterThan(keys.indexOf('usage'))
    expect(keys.indexOf('context')).toBeLessThan(keys.indexOf('where'))
  })

  it('is cut before the name and the state on a short card', () => {
    const lines = cardLines(gauged('a', 50, { tokens: '9k' }), labels)
    expect(fitCardLines(lines, 2).map(l => l.kind)).toEqual(['title', 'state'])
  })
})

describe('detailLines — the gauge spelled out', () => {
  const labels = {
    where: 'where', model: 'model', note: 'note', started: 'started',
    external: 'external', closed: 'closed', doing: 'saying', task: 'task', metrics: 'usage', metricsAll: 'in + out + cache',
    context: 'context window', conversation: 'conversation',
    alsoLabel: 'named here', alsoHarness: 'named inside',
  }

  it('prints both numbers, so a reading can be audited', () => {
    const l = detailLines(gauged('a', 45), labels, () => '5m ago')
    const line = l.find(x => x.key === 'context')
    expect(line?.label).toBe('context window')
    expect(line?.value).toBe('45%  ·  45k / 100k')
  })

  it('is absent for a row with no reading', () => {
    const l = detailLines(session('a'), labels, () => '5m ago')
    expect(l.some(x => x.key === 'context')).toBe(false)
  })
})

describe('the header count', () => {
  const en = controlStrings('en')
  const pt = controlStrings('pt')

  it('says how many are ON SCREEN and out of how many, NAMING both', () => {
    // The header read the fleet's length, so with `only active` on it announced 44 over a screen
    // showing ten — a number describing a screen nobody is looking at.
    //
    // `N of M sessions` then read as "N of your M OPEN sessions", which neither number is: M counts
    // every session this machine has a record of, closed ones included. With the header's memory
    // budget (`ram 4/18`) on the same screen, a machine looked like it was contradicting itself about
    // how many sessions were open. Both numbers are named now.
    expect(en.sessionsCount(10, 44)).toBe('10 on screen · 44 known')
    expect(pt.sessionsCount(10, 44)).toBe('10 na tela · 44 conhecidas')
  })

  it('drops the second number when it says nothing new', () => {
    // Nothing is being withheld, so "9 of 9" is noise where "9" is the fact.
    expect(en.sessionsCount(9, 9)).toBe('9 sessions')
    expect(pt.sessionsCount(9, 9)).toBe('9 sessões')
    expect(en.sessionsCount(1, 1)).toBe('1 session')
    expect(pt.sessionsCount(1, 1)).toBe('1 sessão')
  })

  it('is honest about an empty screen over a fleet that is not', () => {
    // The case that matters most: the filter emptied the list, and the row must not read as an
    // empty machine.
    expect(en.sessionsCount(0, 44)).toBe('0 on screen · 44 known')
    expect(pt.sessionsCount(0, 44)).toBe('0 na tela · 44 conhecidas')
  })

  it('the WAITING cell names both populations once they disagree', () => {
    // Same defect as the count cell above, one cell over, and it outlived the fix: `attention` is
    // counted over the WHOLE fleet — the header carries it on every tab and must — while this row
    // sits directly above a FILTERED list. Measured on a real machine with a search active: the
    // row read "2 waiting on you" over zero such rows.
    expect(en.sessionsWaitingSplit(0, 2)).toBe('none on screen · 2 waiting on you')
    expect(pt.sessionsWaitingSplit(0, 2)).toBe('nenhuma na tela · 2 esperando por você')
    expect(en.sessionsWaitingSplit(1, 3)).toBe('1 on screen · 3 waiting on you')
    expect(pt.sessionsWaitingSplit(1, 3)).toBe('1 na tela · 3 esperando por você')
  })

  it('keeps the short sentence when the screen shows everything that is waiting', () => {
    // The split is an explanation, and an explanation for a discrepancy that does not exist is
    // noise — the same reason `sessionsCount` drops its second number at `9 of 9`.
    expect(en.sessionsWaitingCount(2)).toBe('2 waiting on you')
    expect(pt.sessionsWaitingCount(1)).toBe('1 esperando por você')
  })
})

describe('the wizard name step', () => {
  const harness = { id: 'claude', supportsModel: true }

  it('carries a name the user typed', () => {
    const plan = planSubmit({
      draft: { harness, cwd: '/r', label: 'a refatoração do token' }, hasSpawn: true, attach: false,
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) expect(plan.req.label).toBe('a refatoração do token')
  })

  it('carries NO name when the step was skipped', () => {
    // Enter on an untouched field means "no name of my own", and the row derives one from the
    // harness and the folder. An empty string is not a name called "".
    const plan = planSubmit({ draft: { harness, cwd: '/r', label: '' }, hasSpawn: true, attach: false })
    if (plan.ok) expect('label' in plan.req).toBe(false)
  })
})

describe('the per-row close control', () => {
  const live = session('a', { state: 'waiting' as SessionState })
  const closed = session('b', { state: 'closed' as SessionState, actionable: false })
  const gone = session('c', { state: 'exited' as SessionState })

  it('is offered only on a row agentop can actually stop', () => {
    // An external process is someone else's to stop, and a closed conversation has nothing running
    // to end. A control that is visible and refuses is worse than one that is absent.
    expect(canClose(live)).toBe(true)
    expect(canClose(closed)).toBe(false)
    expect(canClose(gone)).toBe(false)
    expect(canClose(session('d', { state: 'unknown' as SessionState, actionable: false }))).toBe(false)
  })

  it('is measurable ASCII, because this package counts code units and not columns', () => {
    // `truncate` counts `s.length` — UTF-16 code UNITS — and nothing here measures display width.
    // A wastebasket is a surrogate pair (`.length === 2`) whose column width is 1 or 2 depending on
    // the terminal, so it cannot be reserved correctly; the reservation would be wrong by one and
    // shear every row under it. Bracketed ASCII is three of each.
    expect(CLOSE_CELL).toBe('[x]')
    expect([...CLOSE_CELL].length).toBe(CLOSE_CELL.length)
    expect(CLOSE_CELL.codePointAt(0)!).toBeLessThan(128)
  })

  it('costs the table NOTHING, at any width and whatever is on screen', () => {
    // The control is gone. It did not make sense where it sat: every other verb on this screen is
    // reached from the menu or a key, and a table's last column is where a VALUE goes — so a button
    // parked there reads as a truncated cell, and it put the most destructive question on the row
    // exactly where the eye lands after skimming it.
    //
    // Asserted across the whole range rather than at one width, so the reservation cannot creep back
    // for "just the wide terminal".
    for (const width of [0, 30, 40, 120, 400]) {
      expect(closeCellWidth([live], width)).toBe(0)
      expect(closeCellWidth([closed, gone], width)).toBe(0)
      expect(closeCellWidth([], width)).toBe(0)
    }
  })
})

describe('treeGuides', () => {
  const head = (label: string, depth: number): SessionRow =>
    ({ kind: 'heading', label, count: 1, depth, path: [label] })
  const row = (id: string): SessionRow => ({ kind: 'session', session: session(id) })

  it('draws nothing at all when nothing is nested', () => {
    // Every flat arrangement — and then the guide column costs no width.
    expect(treeGuides([head('a', 0), row('x'), head('b', 0), row('y')])).toEqual([])
  })

  it('gives a root no connector, because two roots are two trees', () => {
    const guides = treeGuides([head('proj', 0), head('pkg', 1), row('x')])
    expect(guides[0]!.trim()).toBe('')
  })

  it('closes the last branch with └─ and keeps the others open with ├─', () => {
    const guides = treeGuides([
      head('proj', 0), head('one', 1), row('x'), head('two', 1), row('y'),
    ])
    expect(guides[1]!.trimEnd()).toBe('├─')
    expect(guides[3]!.trimEnd()).toBe('└─')
  })

  it('runs an ancestor bar down through everything under it', () => {
    // `deep` hangs off `one`, which still has `two` coming — so the rows under `deep` have to carry
    // `one`'s bar, or a row three levels down cannot be traced back to the node it belongs to.
    const guides = treeGuides([
      head('proj', 0), head('one', 1), head('deep', 2), row('x'), head('two', 1), row('y'),
    ])
    expect(guides[2]!.trimEnd()).toBe('│ └─')
    expect(guides[3]!.trimEnd()).toBe('│')
  })

  it('gives a session the same bars as its heading, one level deeper', () => {
    const guides = treeGuides([head('proj', 0), head('one', 1), row('x'), head('two', 1)])
    expect(guides[2]!.trimEnd()).toBe('│')
  })

  it('pads the SESSION guides to one width and leaves the headings free', () => {
    // The rows are a table and their left edge has to be straight; a heading is one string, and
    // padding it would start it to the RIGHT of the branch hanging off it — the hierarchy upside
    // down. So each heading steps right by its own depth while the rows below share a column.
    const rows = [head('proj', 0), head('one', 1), head('deep', 2), row('x'), head('two', 1), row('y')]
    const guides = treeGuides(rows)
    const sessions = guides.filter((_g, i) => rows[i]!.kind === 'session')
    expect(new Set(sessions.map(g => g.length)).size).toBe(1)
    expect(guides[0]).toBe('')
    expect(guides[1]!.length).toBeLessThan(guides[2]!.length)
  })

  it('leaves a spacer blank', () => {
    const guides = treeGuides([head('proj', 0), head('one', 1), { kind: 'spacer' }, row('x')])
    expect(guides[2]!.trim()).toBe('')
  })
})
