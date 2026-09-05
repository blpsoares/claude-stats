import { expect, it, test, describe } from 'bun:test'
import type { Filters } from '@agentistics/core'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { filterFleet, fleetFilterOptions, ignoredDimensions, SESSION_FILTER_DIMS } from './fleetFilter'

const BASE: Filters = {
  // 'all' is the neutral default — `ignoredDimensions` reads a SET date range as one it cannot
  // answer, so a base fixture with '7d' baked in would flag every test that does not override it.
  dateRange: 'all' as Filters['dateRange'],
  customStart: '', customEnd: '', projects: [], models: [],
}

const f = (o: Partial<Filters>): Filters => ({ ...BASE, ...o })

function row(o: Partial<ControlSession> & { id: string }): ControlSession {
  return {
    title: o.id, harness: 'claude', cwd: '/w', project: 'w',
    searchFields: {} as ControlSession['searchFields'],
    state: 'working', stateLabel: 'working', actionable: true, attached: false,
    ...o,
  } as ControlSession
}

describe('filterFleet', () => {
  test('nothing set keeps everything, and reports itself as not narrowed', () => {
    const out = filterFleet({
      rows: [row({ id: 'a' }), row({ id: 'b', state: 'exited' })],
      filters: BASE, activeOnly: false,
    })
    expect(out.rows).toHaveLength(2)
    expect(out.withheld).toBe(0)
    expect(out.narrowed).toBe(false)
  })

  test('activeOnly keeps what is running and counts what it withheld', () => {
    const out = filterFleet({
      rows: [
        row({ id: 'a', state: 'working' }),
        row({ id: 'b', state: 'waiting' }),
        row({ id: 'c', state: 'exited' }),
        row({ id: 'd', state: 'lost' }),
      ],
      filters: BASE, activeOnly: true,
    })
    expect(out.rows.map(r => r.id)).toEqual(['a', 'b'])
    expect(out.withheld).toBe(2)
    expect(out.narrowed).toBe(true)
  })

  test('harness filter, from either shape the Filters type allows', () => {
    const rows = [row({ id: 'a', harness: 'claude' }), row({ id: 'b', harness: 'codex' })]
    expect(filterFleet({ rows, filters: { ...BASE, harnesses: ['codex'] }, activeOnly: false }).rows.map(r => r.id))
      .toEqual(['b'])
    expect(filterFleet({ rows, filters: { ...BASE, harness: 'claude' }, activeOnly: false }).rows.map(r => r.id))
      .toEqual(['a'])
  })

  test('project matches the name, the group, or the exact cwd', () => {
    const rows = [
      row({ id: 'byName', project: 'agentistics' }),
      row({ id: 'byGroup', project: 'wt-1', projectGroup: 'agentistics' }),
      row({ id: 'byCwd', project: 'x', cwd: '/home/me/agentistics' }),
      row({ id: 'other', project: 'unrelated' }),
    ]
    const out = filterFleet({
      rows, filters: { ...BASE, projects: ['agentistics', '/home/me/agentistics'] }, activeOnly: false,
    })
    expect(out.rows.map(r => r.id).sort()).toEqual(['byCwd', 'byGroup', 'byName'])
  })

  test('a project filter never matches by PREFIX', () => {
    // A prefix test on `$HOME` would match every session on the machine.
    const out = filterFleet({
      rows: [row({ id: 'a', cwd: '/home/me/deep/project', project: 'project' })],
      filters: { ...BASE, projects: ['/home/me'] }, activeOnly: false,
    })
    expect(out.rows).toHaveLength(0)
  })

  test('a row with no model is withheld by a model filter rather than assumed to match', () => {
    // Unknown is not "some other model", but a filter cannot say anything about it either way, and
    // letting it through would put rows in a list the filter says is only one model.
    const out = filterFleet({
      rows: [row({ id: 'known', model: 'claude-opus-5' }), row({ id: 'unknown' })],
      filters: { ...BASE, models: ['claude-opus-5'] }, activeOnly: false,
    })
    expect(out.rows.map(r => r.id)).toEqual(['known'])
  })

  test('repo filter matches the row own repo', () => {
    const rows = [row({ id: 'a', repo: 'org/one' }), row({ id: 'b', repo: 'org/two' }), row({ id: 'c' })]
    const out = filterFleet({ rows, filters: { ...BASE, repos: ['org/one'] }, activeOnly: false })
    expect(out.rows.map(r => r.id)).toEqual(['a'])
  })

  test('the metric-only dimensions are IGNORED — see the module header', () => {
    // A date range would hide a session that started eight days ago and is still working; a tag
    // resolves against stored sessions a live row is not in yet.
    const rows = [row({ id: 'a' })]
    const out = filterFleet({
      rows,
      filters: {
        ...BASE, dateRange: '24h' as Filters['dateRange'],
        tags: ['t1'], users: ['u'], machines: ['m'], teams: ['x'], presence: 'offline',
      },
      activeOnly: false,
    })
    expect(out.rows).toHaveLength(1)
    expect(out.narrowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The repository vocabularies, and what the bar may offer
// ---------------------------------------------------------------------------

function repoRow(id: string, repo: string, extra: Record<string, unknown> = {}): never {
  return {
    id, title: id, harness: 'claude', cwd: `/home/me/${id}`, project: id, projectGroup: id,
    state: 'working', stateLabel: 'working', repo, actionable: true, attached: false,
    named: false, searchFields: [], ...extra,
  } as never
}

describe('filterFleet — repository', () => {
  const rows = [repoRow('a', 'blpsoares/agentistics'), repoRow('b', 'blpsoares/aipe')]

  it('matches a CANONICAL remote key against the row\'s SHORT name', () => {
    // The whole bug: the dashboard's chips are `github.com/org/repo` and a fleet row carries
    // `org/repo`, so `repos.has(r.repo)` was never true and filtering by repository returned an
    // empty list every single time.
    const out = filterFleet({ rows, filters: { ...BASE, repos: ['github.com/blpsoares/agentistics'] }, activeOnly: false })
    expect(out.rows.map(r => r.id)).toEqual(['a'])
  })

  it('still matches a short key given directly', () => {
    const out = filterFleet({ rows, filters: { ...BASE, repos: ['blpsoares/aipe'] }, activeOnly: false })
    expect(out.rows.map(r => r.id)).toEqual(['b'])
  })

  it('a row with no repository is withheld by a repo filter, never kept', () => {
    const out = filterFleet({ rows: [repoRow('c', '')], filters: { ...BASE, repos: ['github.com/x/y'] }, activeOnly: false })
    expect(out.rows).toEqual([])
  })
})

describe('fleetFilterOptions', () => {
  it('offers only what the fleet actually contains', () => {
    // An option is a promise that something might be behind it. The bar used to be handed the
    // DASHBOARD's harness list, so it offered antigravity against a fleet that had none — picking
    // it emptied the list, which is indistinguishable from a broken filter.
    const rows = [
      repoRow('a', 'blpsoares/agentistics', { harness: 'claude', model: 'opus' }),
      repoRow('b', '', { harness: 'codex', project: '', model: undefined }),
    ]
    const o = fleetFilterOptions(rows)
    expect(o.harnesses).toEqual(['claude', 'codex'])
    expect(o.repos).toEqual(['blpsoares/agentistics'])
    expect(o.models).toEqual(['opus'])
    expect(o.projects).toEqual(['a'])
  })

  it('drops empty values rather than offering a blank chip', () => {
    const o = fleetFilterOptions([repoRow('a', '', { harness: '', project: '', model: '' })])
    expect(o).toEqual({
      harnesses: [], repos: [], projects: [], models: [],
      harnessesAll: [], reposAll: [], projectsAll: [], modelsAll: [],
    })
  })

  it('the WHOLE fleet is offered even when the active-only switch hides every row of a harness', () => {
    // The reported case: six assistants in the history, one of them running. Narrowing the OPTIONS
    // to what is running made the harness dimension vanish, so the workspace looked like it had
    // never heard of the other five — while Compare listed all six two clicks away.
    const rows = [
      repoRow('live', 'org/r', { harness: 'claude', state: 'waiting' }),
      repoRow('old', 'org/r', { harness: 'codex', state: 'closed' }),
      repoRow('older', 'org/r', { harness: 'kimi', state: 'exited' }),
    ]
    const o = fleetFilterOptions(rows, true)
    expect(o.harnesses).toEqual(['claude'])
    expect(o.harnessesAll).toEqual(['claude', 'codex', 'kimi'])
  })

  it('with the switch off the two agree — there is nothing being withheld to mark', () => {
    const rows = [
      repoRow('live', 'org/r', { harness: 'claude', state: 'waiting' }),
      repoRow('old', 'org/r', { harness: 'codex', state: 'closed' }),
    ]
    const o = fleetFilterOptions(rows, false)
    expect(o.harnesses).toEqual(o.harnessesAll)
  })

  it('is stable and deduped, so the chips do not shuffle between polls', () => {
    const rows = [repoRow('b', 'z/b'), repoRow('a', 'a/a'), repoRow('c', 'z/b')]
    expect(fleetFilterOptions(rows).repos).toEqual(['a/a', 'z/b'])
  })
})

describe('ignoredDimensions', () => {
  it('names a date range the fleet cannot answer', () => {
    expect(ignoredDimensions(f({ dateRange: '7d' as Filters['dateRange'] }), 'en'))
      .toBe('The date range does not narrow a live fleet.')
  })
  it('names several at once, in one sentence', () => {
    const s = ignoredDimensions(f({ dateRange: '7d' as Filters['dateRange'], tags: ['t1'] }), 'en')!
    expect(s).toContain('date range')
    expect(s).toContain('tags')
  })
  it('is null when nothing set is ignored', () => {
    expect(ignoredDimensions(f({ harnesses: ['claude'] }), 'en')).toBeNull()
    expect(ignoredDimensions(f({ dateRange: 'all' as Filters['dateRange'] }), 'en')).toBeNull()
  })
})

describe('fleetFilterOptions — the activeOnly promise', () => {
  const rows = [
    repoRow('a', 'o/a', { harness: 'claude', state: 'working' }),
    repoRow('b', 'o/b', { harness: 'codex', state: 'closed' }),
  ]

  it('offers only harnesses the CURRENT view can show', () => {
    // With the switch on — how this workspace opens — a harness whose rows are all closed is
    // withheld from the list, so picking it cannot empty it. Measured on a real machine: codex and
    // copilot each had exactly one row, both closed, and both were offered.
    expect(fleetFilterOptions(rows, true).harnesses).toEqual(['claude'])
  })

  it('brings them back when the switch is off', () => {
    // The options are re-derived from the rows the switch stops withholding — nothing to remember.
    expect(fleetFilterOptions(rows, false).harnesses).toEqual(['claude', 'codex'])
    expect(fleetFilterOptions(rows).harnesses).toEqual(['claude', 'codex'])
  })

  it('withholds that harness\'s repos and models too, not just its name', () => {
    const mixed = [
      repoRow('a', 'o/live', { harness: 'claude', state: 'working', model: 'opus' }),
      repoRow('b', 'o/dead', { harness: 'codex', state: 'exited', model: 'gpt' }),
    ]
    const o = fleetFilterOptions(mixed, true)
    expect(o.repos).toEqual(['o/live'])
    expect(o.models).toEqual(['opus'])
  })
})

describe('SESSION_FILTER_DIMS', () => {
  it('offers every dimension filterFleet honours — a filter nobody can reach is not a filter', () => {
    // The four `Filters` keys this module reads, plus the fleet's own switch.
    expect([...SESSION_FILTER_DIMS].sort()).toEqual(
      ['activeOnly', 'harnesses', 'models', 'projects', 'repos'],
    )
  })

  it('includes activeOnly, which is ALSO a chip and was therefore a one-way switch', () => {
    // It could be turned off from the chip's x and never back on: the menu entry that would have
    // done it was gated out by this very list, and a one-way switch reads as a broken filter.
    expect(SESSION_FILTER_DIMS).toContain('activeOnly')
  })

  it('offers nothing filterFleet ignores — a control that does nothing is worse than none', () => {
    const rows = [
      repoRow('a', 'org/r', { harness: 'claude', project: 'p', model: 'opus', state: 'waiting' }),
      repoRow('b', 'org/other', { harness: 'codex', project: 'q', model: 'gpt', state: 'waiting' }),
    ]
    // Each dimension must actually narrow, or it has no business being in the menu.
    expect(filterFleet({ rows, filters: { harnesses: ['claude'] } as never, activeOnly: false }).rows).toHaveLength(1)
    expect(filterFleet({ rows, filters: { repos: ['org/r'] } as never, activeOnly: false }).rows).toHaveLength(1)
    expect(filterFleet({ rows, filters: { projects: ['p'] } as never, activeOnly: false }).rows).toHaveLength(1)
    expect(filterFleet({ rows, filters: { models: ['opus'] } as never, activeOnly: false }).rows).toHaveLength(1)
  })
})
