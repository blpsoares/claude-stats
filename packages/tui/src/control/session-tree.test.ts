import { describe, expect, it } from 'bun:test'
import { GONE_PROJECT_KEY, dimensionWordBook } from './session-dimensions'
import { breadcrumb, buildSessionTree } from './session-tree'
import { groupSessions } from './sessions'
import type { ControlSession, SessionState } from './types'

const WORDS = dimensionWordBook({
  labels: {
    day: 'day',
    status: 'state', harness: 'harness', model: 'model', project: 'project', repo: 'repository',
    task: 'task', marked: 'marked',
  },
  unfiled: {
    day: 'no date',
    status: 'state unrecorded', harness: 'harness unknown', model: 'no model', project: 'no dir',
    repo: 'no repository', task: 'no task', marked: 'not marked',
  },
  states: {
    working: 'working', waiting: 'waiting', 'waiting-approval': 'needs approval',
    exited: 'ended', lost: 'lost', closed: 'closed', unknown: 'unknown',
  },
  goneProject: 'directory no longer exists',
  marked: 'marked',
})

const ROOT = '/home/d/agentistics'

/**
 * A session in a repository, at `cwd`, whose project is `agentistics`.
 *
 * `projectGroup` is what `bucketKey(s, 'project')` reads — the main checkout's NAME — and
 * `projectRoot` is its PATH. The two travel together everywhere the host stamps them, and the tree
 * is only correct while they agree.
 */
const inRepo = (id: string, cwd: string, over: Partial<ControlSession> = {}): ControlSession => ({
  id,
  title: id,
  harness: 'claude',
  cwd,
  project: cwd.split('/').pop() ?? cwd,
  projectGroup: 'agentistics',
  projectRoot: ROOT,
  state: 'waiting' as SessionState,
  stateLabel: 'waiting',
  actionable: true,
  attached: false,
  searchFields: { name: id, folder: '', harness: '', note: '', task: '', prompt: '' },
  ...over,
})

/** A session with no repository at all — the honest no-branch case. */
const loose = (id: string, cwd: string, over: Partial<ControlSession> = {}): ControlSession => ({
  id,
  title: id,
  harness: 'claude',
  cwd,
  project: cwd.split('/').pop() ?? cwd,
  state: 'waiting' as SessionState,
  stateLabel: 'waiting',
  actionable: true,
  attached: false,
  searchFields: { name: id, folder: '', harness: '', note: '', task: '', prompt: '' },
  ...over,
})

const tree = (list: readonly ControlSession[]) => buildSessionTree(list, WORDS)
/** Every node as `depth:label(ids)`, in the order it is drawn — the whole shape in one line each. */
const shape = (list: readonly ControlSession[]) =>
  tree(list).map(g => `${g.depth}:${g.label}(${g.sessions.map(s => s.id).join(',')})`)

describe('the root is the PROJECT, never the filesystem', () => {
  it('hangs a session in the main checkout directly off its project', () => {
    expect(shape([inRepo('a', ROOT)])).toEqual(['0:agentistics(a)'])
  })

  it('branches on the segments of cwd BELOW the project root', () => {
    expect(shape([inRepo('a', `${ROOT}/packages/tui`)]))
      .toEqual(['0:agentistics()', '1:packages/tui(a)'])
  })

  it('files a worktree INSIDE the checkout under the segments that lead to it', () => {
    expect(shape([inRepo('a', `${ROOT}/.claude/worktrees/session-monitor`)]))
      .toEqual(['0:agentistics()', '1:.claude/worktrees/session-monitor(a)'])
  })

  it('gives a worktree OUTSIDE the checkout ONE branch named after its own folder', () => {
    // `git worktree add ../sessions-cascade` resolves to the same project — the common git dir is
    // the main checkout's — but its cwd is not below it. There is no relative path to state, and
    // synthesising one would draw a directory that does not exist.
    expect(shape([inRepo('a', '/home/d/sessions-cascade', { project: 'sessions-cascade' })]))
      .toEqual(['0:agentistics()', '1:sessions-cascade(a)'])
  })

  it('hangs a directory in NO repository straight off its own root, with no branch', () => {
    expect(shape([loose('a', '/tmp/scratch')])).toEqual(['0:scratch(a)'])
  })

  it('leaves a GONE directory in its own bucket and never resurrects a path for it', () => {
    // The bucket is `bucketKey(s, 'project')`'s, unchanged: the cascade may not invent a name for a
    // path that resolves to nothing, which is how a removed worktree became a project of its own.
    const gone = [loose('a', `${ROOT}/.claude/worktrees/member-connect-rotate`, { dirGone: 'gone' })]
    const groups = tree(gone)
    expect(groups.map(g => g.key)).toEqual([GONE_PROJECT_KEY])
    expect(groups[0]!.label).toBe('directory no longer exists')
    expect(groups[0]!.depth).toBe(0)
  })
})

describe('single-child chains are compressed', () => {
  it('joins a chain that never branches into ONE node', () => {
    expect(shape([inRepo('a', `${ROOT}/.claude/worktrees/session-monitor`)]))
      .toEqual(['0:agentistics()', '1:.claude/worktrees/session-monitor(a)'])
  })

  it('splits the shared prefix into a node the moment a second worktree exists', () => {
    const rows = [
      inRepo('a', `${ROOT}/.claude/worktrees/session-monitor`),
      inRepo('b', `${ROOT}/.claude/worktrees/billing-basis`),
    ]
    expect(shape(rows)).toEqual([
      '0:agentistics()',
      '1:.claude/worktrees()',
      '2:billing-basis(b)',
      '2:session-monitor(a)',
    ])
  })

  it('never compresses the project root into its only child', () => {
    // The root is the PROJECT and the branches are directories under it — two different kinds of
    // thing. Joining them would produce a heading that reads as a folder called `agentistics/…`.
    const groups = tree([inRepo('a', `${ROOT}/packages/tui`)])
    expect(groups[0]!.label).toBe('agentistics')
    expect(groups[0]!.path).toEqual(['agentistics'])
  })
})

describe('reading order', () => {
  it('is depth-first: a node, then everything under it', () => {
    const rows = [
      inRepo('root', ROOT),
      inRepo('deep', `${ROOT}/packages/tui`),
      loose('other', '/tmp/aipe'),
    ]
    expect(shape(rows)).toEqual([
      '0:agentistics(root)',
      '1:packages/tui(deep)',
      '0:aipe(other)',
    ])
  })

  it('orders roots by their most urgent member, never alphabetically first', () => {
    // The same rule `groupSessions` applies to its bands: grouping must not bury the one thing the
    // screen exists to surface.
    const rows = [
      inRepo('calm', ROOT, { state: 'working', stateLabel: 'working' }),
      loose('blocked', '/tmp/aipe', { state: 'waiting-approval', stateLabel: 'needs approval' }),
    ]
    expect(tree(rows).map(g => g.label)).toEqual(['aipe', 'agentistics'])
  })

  it('orders BRANCHES by the most urgent member of their subtree', () => {
    const rows = [
      inRepo('calm', `${ROOT}/packages/aaa`, { state: 'working', stateLabel: 'working' }),
      inRepo('blocked', `${ROOT}/packages/zzz`, { state: 'waiting-approval', stateLabel: 'needs approval' }),
    ]
    expect(shape(rows)).toEqual([
      '0:agentistics()',
      '1:packages()',
      '2:zzz(blocked)',
      '2:aaa(calm)',
    ])
  })

  it('carries the path from the root down to each node', () => {
    const rows = [
      inRepo('a', `${ROOT}/.claude/worktrees/session-monitor`),
      inRepo('b', `${ROOT}/.claude/worktrees/billing-basis`),
    ]
    expect(tree(rows).map(g => g.path)).toEqual([
      ['agentistics'],
      ['agentistics', '.claude/worktrees'],
      ['agentistics', '.claude/worktrees', 'billing-basis'],
      ['agentistics', '.claude/worktrees', 'session-monitor'],
    ])
  })
})

describe('a node with no sessions of its own', () => {
  it('is still a group, so the branch keeps its name', () => {
    // `sessionRows` skips a group with no sessions, so a heading-only node has to arrive as one
    // rather than being quietly dropped — the branch names in the cascade are the cascade.
    const groups = tree([inRepo('a', `${ROOT}/packages/tui`)])
    expect(groups[0]!.sessions).toEqual([])
    expect(groups[0]!.label).toBe('agentistics')
  })

  it('holds no session that belongs to a descendant', () => {
    // A session belongs to exactly ONE node — the deepest one on its path. Repeating it up the
    // chain is the duplication the cross-check below refuses.
    const groups = tree([inRepo('a', `${ROOT}/packages/tui`)])
    expect(groups.flatMap(g => g.sessions.map(s => s.id))).toEqual(['a'])
  })
})

describe('the tree loses nothing and duplicates nothing', () => {
  /**
   * A fleet with every case in it at once: the main checkout, two depths of branch, two worktrees
   * sharing a prefix, a worktree outside the checkout, a directory in no repository, and a gone one.
   */
  const FLEET: ControlSession[] = [
    inRepo('root', ROOT),
    inRepo('tui', `${ROOT}/packages/tui`, { state: 'working', stateLabel: 'working' }),
    inRepo('server', `${ROOT}/packages/server`),
    inRepo('mon', `${ROOT}/.claude/worktrees/session-monitor`),
    inRepo('bill', `${ROOT}/.claude/worktrees/billing-basis`, { state: 'closed', stateLabel: 'closed' }),
    inRepo('out', '/home/d/sessions-cascade', { project: 'sessions-cascade' }),
    loose('aipe', '/home/d/aipe', { state: 'waiting-approval', stateLabel: 'needs approval' }),
    loose('nodir', '', { project: '' }),
    loose('gone', `${ROOT}/.claude/worktrees/member-connect-rotate`, { dirGone: 'gone' }),
  ]

  const ids = (list: readonly string[]) => [...list].sort()

  it('holds exactly the sessions the flat project arrangement holds', () => {
    // THE invariant. An arrangement that loses or duplicates a session is the one failure mode that
    // must be impossible: the cascade and "group by project" are two readings of one fleet, and the
    // root key is literally the same `bucketKey` call, so they cannot legitimately disagree.
    const cascade = buildSessionTree(FLEET, WORDS).flatMap(g => g.sessions.map(s => s.id))
    const flat = groupSessions(FLEET, 'project', WORDS).flatMap(g => g.sessions.map(s => s.id))
    expect(ids(cascade)).toEqual(ids(flat))
    // A multiset, not a set: `toEqual` on sorted arrays already refuses a duplicate, and this says
    // so out loud.
    expect(cascade).toHaveLength(FLEET.length)
  })

  it('files every session under the same ROOT the flat arrangement puts it in', () => {
    const flat = new Map(
      groupSessions(FLEET, 'project', WORDS).flatMap(g => g.sessions.map(s => [s.id, g.key] as const)),
    )
    for (const g of buildSessionTree(FLEET, WORDS)) {
      for (const s of g.sessions) expect(g.path?.[0]).toBe(rootLabelOf(flat.get(s.id)!))
    }
  })

  const rootLabelOf = (key: string) =>
    groupSessions(FLEET, 'project', WORDS).find(g => g.key === key)!.label
})

describe('breadcrumb', () => {
  it('joins the path with the separator the card band uses', () => {
    expect(breadcrumb(['agentistics', '.claude/worktrees', 'session-monitor'], 60))
      .toBe('agentistics › .claude/worktrees › session-monitor')
  })

  it('gives up the LEFTMOST segments first, because the last one identifies the node', () => {
    const crumb = breadcrumb(['agentistics', '.claude/worktrees', 'session-monitor'], 30)
    expect(crumb.length).toBeLessThanOrEqual(30)
    expect(crumb.endsWith('session-monitor')).toBe(true)
    expect(crumb.startsWith('…')).toBe(true)
  })

  it('cuts INTO the last segment only when the last segment alone does not fit', () => {
    const crumb = breadcrumb(['agentistics', 'session-monitor'], 8)
    expect(crumb.length).toBeLessThanOrEqual(8)
    expect(crumb.endsWith('monitor')).toBe(true)
  })

  it('says nothing rather than something misleading at no width at all', () => {
    expect(breadcrumb(['agentistics'], 0)).toBe('')
    expect(breadcrumb([], 40)).toBe('')
  })
})
