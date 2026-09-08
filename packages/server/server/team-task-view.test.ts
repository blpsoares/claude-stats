import { describe, expect, it } from 'bun:test'
import type { SessionMeta, SharedTask } from '@agentistics/core'
import { centralTaskBoard, centralTaskRow, type TeamTaskInput } from './team-task-view'

const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  session_id: 'c1', memberId: 'm1', project_path: '/repo', start_time: '2026-09-05T10:00:00.000Z',
  harness: 'claude', git_remote: 'github.com/org/repo',
  input_tokens: 100, output_tokens: 50,
  cache_read_input_tokens: 800, cache_creation_input_tokens: 50,
  user_message_count: 3,
  ...over,
} as SessionMeta)

const shared = (over: Partial<SharedTask> = {}): SharedTask => ({
  task: {
    id: 't1', title: 'ship it', status: 'in_progress',
    createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-05T10:00:00.000Z',
  },
  comments: [], subtasks: [], files: [], sessionIds: ['c1'], sessionsWithheld: 0,
  ...over,
})

const input = (over: Partial<TeamTaskInput> = {}): TeamTaskInput =>
  ({ memberId: 'm1', user: 'laptop', shared: shared(), ...over })

const metasOf = (...ms: SessionMeta[]) =>
  new Map(ms.map(m => [m.session_id, m] as [string, SessionMeta]))

describe('centralTaskRow', () => {
  it('resolves the totals through the same rollup the machine uses', () => {
    const row = centralTaskRow(input(), metasOf(meta()), () => 2)
    expect(row.rollup.tokens).toBe(1000)
    expect(row.rollup.rounds).toBe(3)
    expect(row.rollup.costUSD).toBe(2)
    expect(row.harnesses).toEqual(['claude'])
    expect(row.repos).toEqual(['github.com/org/repo'])
  })

  it('carries the shortfall the machine reported', () => {
    const row = centralTaskRow(
      input({ shared: shared({ sessionIds: [], sessionsWithheld: 3 }) }),
      metasOf(meta()), () => 2,
    )
    expect(row.sessionsWithheld).toBe(3)
    // Nothing arrived, so nothing can be measured — `null`, never a free delivery.
    expect(row.rollup.costUSD).toBeNull()
    expect(row.rollup.tokens).toBeNull()
  })

  it('keeps a named session the central does not hold as USED but unmeasured', () => {
    // A push still in flight is a gap in what arrived, not a rule somebody set — the two are
    // counted apart so the board can say which it is.
    const row = centralTaskRow(
      input({ shared: shared({ sessionIds: ['c1', 'gone'] }) }),
      metasOf(meta()), () => 2,
    )
    expect(row.sessionsMissing).toBe(1)
    expect(row.sessionsWithheld).toBe(0)
    expect(row.rollup.sessionsUsed).toBe(2)
    expect(row.rollup.sessionsLinked).toBe(1)
  })

  it('counts the board that hangs off the delivery', () => {
    const row = centralTaskRow(input({
      shared: shared({
        comments: [{ id: 'c', author: 'a', body: 'b', createdAt: '2026-09-02T10:00:00.000Z' }],
        subtasks: [
          { id: 's1', title: 'a', done: true, status: 'done', createdAt: 'x', updatedAt: 'x' },
          { id: 's2', title: 'b', done: false, status: 'todo', createdAt: 'x', updatedAt: 'x' },
        ],
      }),
    }), metasOf(meta()), () => 1)
    expect(row.counts).toEqual({ comments: 1, subtasks: 2, subtasksDone: 1, files: 0 })
  })
})

describe('centralTaskBoard', () => {
  it('lists a machine that shares nothing, empty', () => {
    // "This machine has no deliveries" and "this machine shares none of them" are different facts.
    const board = centralTaskBoard({
      tasks: [input()],
      machines: [{ memberId: 'm1', user: 'laptop' }, { memberId: 'm2', user: 'desktop' }],
      metas: metasOf(meta()),
      costOf: () => 1,
    })
    expect(board.map(b => b.user)).toEqual(['desktop', 'laptop'])
    expect(board.find(b => b.memberId === 'm2')!.rows).toEqual([])
  })

  it('still shows a delivery from a machine the roster no longer lists', () => {
    const board = centralTaskBoard({
      tasks: [input({ memberId: 'gone', user: 'old-laptop' })],
      machines: [],
      metas: metasOf(meta()),
      costOf: () => 1,
    })
    expect(board).toHaveLength(1)
    expect(board[0]!.user).toBe('old-laptop')
  })

  it('orders deliveries most recently updated first, inside each machine', () => {
    const board = centralTaskBoard({
      tasks: [
        input({ shared: shared({ task: { ...shared().task, id: 'old', updatedAt: '2026-09-01T00:00:00.000Z' } }) }),
        input({ shared: shared({ task: { ...shared().task, id: 'new', updatedAt: '2026-09-08T00:00:00.000Z' } }) }),
      ],
      machines: [{ memberId: 'm1', user: 'laptop' }],
      metas: metasOf(meta()),
      costOf: () => 1,
    })
    expect(board[0]!.rows.map(r => r.task.id)).toEqual(['new', 'old'])
  })
})

/**
 * The team boundary. A delivery carries a title, a description and comment bodies, so the board is
 * scoped by the same rule `/api/data` applies to the sessions it is measured from — and these
 * assert the fail-closed direction, which is the one an authorization bug gets wrong.
 */
describe('centralTaskBoard scoping', () => {
  const laptop = input({ memberId: 'm1', user: 'laptop' })
  const other = input({ memberId: 'm2', user: 'someone-elses' })
  const machines = [
    { memberId: 'm1', user: 'laptop', teamIds: ['team-a'] },
    { memberId: 'm2', user: 'someone-elses', teamIds: ['team-b'] },
  ]
  const board = (scope: Parameters<typeof centralTaskBoard>[0]['scope']) => centralTaskBoard({
    tasks: [laptop, other], machines, metas: metasOf(meta()), costOf: () => 1, scope,
  })

  it('shows every machine to an owner (no scope)', () => {
    expect(board(null).map(b => b.memberId).sort()).toEqual(['m1', 'm2'])
  })

  it('withholds a machine of a team the viewer does not manage — band and rows alike', () => {
    const out = board({ teams: new Set(['team-a']), owned: new Set() })
    expect(out.map(b => b.memberId)).toEqual(['m1'])
    // Not merely an empty band: the other machine's deliveries are never built, so no title of
    // theirs can reach this viewer through any field.
    expect(JSON.stringify(out)).not.toContain('someone-elses')
  })

  it('shows a machine the viewer OWNS even when it belongs to no team', () => {
    const loose = [{ memberId: 'm1', user: 'laptop', teamIds: [] }]
    const out = centralTaskBoard({
      tasks: [laptop], machines: loose, metas: metasOf(meta()), costOf: () => 1,
      scope: { teams: new Set(), owned: new Set(['m1']) },
    })
    expect(out.map(b => b.memberId)).toEqual(['m1'])
  })

  it('withholds a delivery from a machine the roster cannot attribute', () => {
    // A revoked or legacy identity carries no team. An owner still sees it; a scoped viewer must
    // not, or an unattributable board would be readable by everybody.
    const out = centralTaskBoard({
      tasks: [input({ memberId: 'gone', user: 'old' })], machines: [],
      metas: metasOf(meta()), costOf: () => 1,
      scope: { teams: new Set(['team-a']), owned: new Set() },
    })
    expect(out).toEqual([])
    expect(centralTaskBoard({
      tasks: [input({ memberId: 'gone', user: 'old' })], machines: [],
      metas: metasOf(meta()), costOf: () => 1, scope: null,
    })).toHaveLength(1)
  })

  it('gives a principal with no team and no machine nothing at all', () => {
    expect(board({ teams: new Set(), owned: new Set() })).toEqual([])
  })
})

describe('a delivery may only name its own machine\'s sessions', () => {
  it('treats another machine\'s session as missing, never as its own measurement', () => {
    // `sessionIds` arrives from the member. Resolving it against every session on the central
    // would let one machine read a neighbour's cost and tokens back off its own board.
    const row = centralTaskRow(
      input({ memberId: 'm1', shared: shared({ sessionIds: ['c1', 'c2'] }) }),
      metasOf(meta({ session_id: 'c1', memberId: 'm1' }), meta({ session_id: 'c2', memberId: 'm2' })),
      () => 2,
    )
    expect(row.rollup.sessionsLinked).toBe(1)
    expect(row.sessionsMissing).toBe(1)
    expect(row.rollup.costUSD).toBe(2)
  })
})
