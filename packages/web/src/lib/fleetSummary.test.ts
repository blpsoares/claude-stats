import { expect, test, describe } from 'bun:test'
import { formatUptime, summarizeFleet } from './fleetSummary'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'

const NOW = 1_700_000_000_000

function row(o: Partial<ControlSession> & { id: string }): ControlSession {
  return {
    title: o.id, harness: 'claude', cwd: '/w', project: 'w',
    searchFields: {} as ControlSession['searchFields'],
    state: 'working', stateLabel: 'working', actionable: true, attached: false,
    ...o,
  } as ControlSession
}

describe('summarizeFleet', () => {
  test('counts running, waiting and off', () => {
    const s = summarizeFleet([
      row({ id: 'a', state: 'working' }),
      row({ id: 'b', state: 'waiting' }),
      row({ id: 'c', state: 'waiting-approval' }),
      row({ id: 'd', state: 'exited' }),
      row({ id: 'e', state: 'lost' }),
    ], NOW)
    expect(s.total).toBe(5)
    expect(s.running).toBe(3)
    expect(s.waiting).toBe(2)
    expect(s.off).toBe(2)
  })

  test('slices by harness, busiest first, ties broken by name so polls do not shuffle it', () => {
    const s = summarizeFleet([
      row({ id: 'a', harness: 'codex', state: 'working' }),
      row({ id: 'b', harness: 'claude', state: 'working' }),
      row({ id: 'c', harness: 'claude', state: 'exited' }),
      row({ id: 'd', harness: 'agy', state: 'exited' }),
    ], NOW)
    expect(s.harnesses.map(h => h.harness)).toEqual(['claude', 'agy', 'codex'])
    expect(s.harnesses[0]).toEqual({ harness: 'claude', count: 2, running: 1 })
  })

  test('sums uptime over RUNNING sessions only', () => {
    const s = summarizeFleet([
      row({ id: 'a', state: 'working', startedAt: NOW - 60_000 }),
      row({ id: 'b', state: 'exited', startedAt: NOW - 999_000 }),
    ], NOW)
    expect(s.activeMs).toBe(60_000)
  })

  test('no running session with a start time yields NO figure, never a zero', () => {
    // The distinction the surface renders as a sentence: "nothing has been up for any time" and
    // "nothing here records when they started" are different statements.
    const s = summarizeFleet([row({ id: 'a', state: 'working' })], NOW)
    expect(s.activeMs).toBeUndefined()
    expect(s.activeUnknown).toBe(1)
  })

  test('a start time in the future contributes zero rather than subtracting', () => {
    // Clock skew: a fleet uptime that goes DOWN when a session starts is worse than a short one.
    const s = summarizeFleet([
      row({ id: 'a', state: 'working', startedAt: NOW + 500_000 }),
      row({ id: 'b', state: 'working', startedAt: NOW - 10_000 }),
    ], NOW)
    expect(s.activeMs).toBe(10_000)
  })

  test('counts distinct projects, folding a worktree into its main checkout', () => {
    const s = summarizeFleet([
      row({ id: 'a', project: 'wt-1', projectGroup: 'agentistics' }),
      row({ id: 'b', project: 'wt-2', projectGroup: 'agentistics' }),
      row({ id: 'c', project: 'other' }),
    ], NOW)
    expect(s.projects).toBe(2)
  })

  test('an empty fleet summarizes to zeros, and to no uptime figure at all', () => {
    const s = summarizeFleet([], NOW)
    expect(s.total).toBe(0)
    expect(s.harnesses).toEqual([])
    expect(s.activeMs).toBeUndefined()
  })
})

describe('formatUptime', () => {
  test('at most two units, so a long total stays readable', () => {
    expect(formatUptime(48_000)).toBe('48s')
    expect(formatUptime(12 * 60_000)).toBe('12m')
    expect(formatUptime((3 * 60 + 12) * 60_000)).toBe('3h 12m')
    expect(formatUptime((50 * 60 + 30) * 60_000)).toBe('2d 2h')
  })

  test('the second unit is what keeps 2h and 2h 59m apart', () => {
    expect(formatUptime(2 * 3600_000)).toBe('2h 0m')
    expect(formatUptime(2 * 3600_000 + 59 * 60_000)).toBe('2h 59m')
  })
})

describe('summarizeFleet — how many of those projects are repositories', () => {
  test('counts the projects that carry a git remote, beside the total', () => {
    const s = summarizeFleet([
      row({ id: 'a', project: 'app', repo: 'org/app' }),
      row({ id: 'b', project: 'docs' }),
      row({ id: 'c', project: 'api', repo: 'org/api' }),
    ], NOW)
    expect(s.projects).toBe(3)
    expect(s.projectRepos).toBe(2)
  })

  test('counts a project ONCE however many of its sessions are open', () => {
    // Three sessions in one repository is one project, not three — the card counts places, and
    // a fleet that fans out inside one checkout would otherwise read as a fleet spread wide.
    const s = summarizeFleet([
      row({ id: 'a', project: 'app', repo: 'org/app' }),
      row({ id: 'b', project: 'app', repo: 'org/app' }),
      row({ id: 'c', project: 'app', repo: 'org/app' }),
    ], NOW)
    expect(s.projects).toBe(1)
    expect(s.projectRepos).toBe(1)
  })

  test('folds a worktree into its main checkout on BOTH counts', () => {
    // `projectGroup` is what makes a worktree and its checkout one project; the repo count has to
    // agree with the project count or the card can read "2 of 1 are repositories".
    const s = summarizeFleet([
      row({ id: 'a', project: 'app', projectGroup: 'app', repo: 'org/app' }),
      row({ id: 'b', project: 'app-fix', projectGroup: 'app', repo: 'org/app' }),
    ], NOW)
    expect(s.projects).toBe(1)
    expect(s.projectRepos).toBe(1)
  })

  test('a project is a repository if ANY of its sessions knows the remote', () => {
    // `repo` is resolved per row and a `lost` row whose directory is gone carries none
    // (`resolveRepoFacts` reports `missing`). One row knowing it is the fact; the others not
    // knowing it is an absence, and an absence must not unmake it.
    const s = summarizeFleet([
      row({ id: 'a', project: 'app', repo: 'org/app' }),
      row({ id: 'b', project: 'app' }),
    ], NOW)
    expect(s.projects).toBe(1)
    expect(s.projectRepos).toBe(1)
  })

  test('never counts more repositories than projects', () => {
    const s = summarizeFleet([
      row({ id: 'a', project: 'app', repo: 'org/app' }),
      row({ id: 'b', project: 'docs' }),
    ], NOW)
    expect(s.projectRepos).toBeLessThanOrEqual(s.projects)
  })

  test('is zero, not undefined, when nothing carries a project', () => {
    const s = summarizeFleet([row({ id: 'a', project: '' })], NOW)
    expect(s.projects).toBe(0)
    expect(s.projectRepos).toBe(0)
  })
})

