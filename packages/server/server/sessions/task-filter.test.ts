import { describe, expect, it } from 'bun:test'
import { filterIsEmpty, scopeMetas, sessionInScope } from './task-filter'
import type { SessionMeta } from '@agentistics/core'

const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  session_id: 's1', project_path: '/repo/a', start_time: '2026-09-05T10:00:00.000Z',
  harness: 'claude',
  ...over,
} as SessionMeta)

describe('filterIsEmpty', () => {
  it('is true for absent, empty, and all-empty-arrays', () => {
    expect(filterIsEmpty(undefined)).toBe(true)
    expect(filterIsEmpty({})).toBe(true)
    expect(filterIsEmpty({ harnesses: [], projects: [], repos: [] })).toBe(true)
  })

  it('is false as soon as one side of the window is set', () => {
    expect(filterIsEmpty({ from: '2026-09-01' })).toBe(false)
    expect(filterIsEmpty({ to: '2026-09-01' })).toBe(false)
  })
})

describe('sessionInScope', () => {
  it('lets everything through when nothing is narrowed', () => {
    expect(sessionInScope(meta(), undefined)).toBe(true)
    expect(sessionInScope(meta(), {})).toBe(true)
  })

  it('uses the UTC day, the same rule tagSessionDay and billing use', () => {
    // At UTC-3 a local-clock day would place this on the 4th and drift it across a boundary.
    const m = meta({ start_time: '2026-09-05T02:00:00.000Z' })
    expect(sessionInScope(m, { from: '2026-09-05', to: '2026-09-05' })).toBe(true)
    expect(sessionInScope(m, { from: '2026-09-06' })).toBe(false)
  })

  it('is inclusive on both ends', () => {
    const m = meta({ start_time: '2026-09-05T23:59:59.000Z' })
    expect(sessionInScope(m, { from: '2026-09-05', to: '2026-09-05' })).toBe(true)
  })

  it('EXCLUDES a session with no usable start time from a windowed view', () => {
    // A filtered view that quietly keeps unplaceable rows reports a figure wider than the window
    // it names.
    const m = meta({ start_time: '' })
    expect(sessionInScope(m, { from: '2026-01-01' })).toBe(false)
    // …and keeps it when there is no window at all.
    expect(sessionInScope(m, { harnesses: ['claude'] })).toBe(true)
  })

  it('narrows by harness, and reads a missing harness as claude', () => {
    expect(sessionInScope(meta({ harness: 'codex' }), { harnesses: ['claude'] })).toBe(false)
    expect(sessionInScope(meta({ harness: undefined }), { harnesses: ['claude'] })).toBe(true)
  })

  it('narrows by project on the cwd the session actually ran in', () => {
    // `current_cwd` wins: in this repo's mandated worktree setup it is the specific one, and the
    // project picker lists what the fleet shows.
    const m = meta({ project_path: '/repo/a', current_cwd: '/repo/a/worktrees/x' })
    expect(sessionInScope(m, { projects: ['/repo/a/worktrees/x'] })).toBe(true)
    expect(sessionInScope(m, { projects: ['/repo/b'] })).toBe(false)
  })

  it("lets a repo filter name the empty 'no linked repository' bucket", () => {
    expect(sessionInScope(meta({ git_remote: undefined }), { repos: [''] })).toBe(true)
    expect(sessionInScope(meta({ git_remote: 'github.com/o/r' }), { repos: [''] })).toBe(false)
    expect(sessionInScope(meta({ git_remote: 'github.com/o/r' }), { repos: ['github.com/o/r'] })).toBe(true)
  })

  it('applies every dimension together, not whichever matches', () => {
    const m = meta({ harness: 'codex', git_remote: 'github.com/o/r' })
    // Right repo, wrong harness — out.
    expect(sessionInScope(m, { harnesses: ['claude'], repos: ['github.com/o/r'] })).toBe(false)
  })
})

describe('scopeMetas', () => {
  it('returns the same map untouched when nothing is narrowed', () => {
    const metas = new Map([['a', meta()]])
    const out = scopeMetas(metas, undefined)
    expect(out.metas).toBe(metas)
    expect(out.excluded).toBe(0)
  })

  it('COUNTS what it left out, so the surface can say the numbers are scoped', () => {
    const metas = new Map([
      ['a', meta({ session_id: 'a', harness: 'claude' })],
      ['b', meta({ session_id: 'b', harness: 'codex' })],
      ['c', meta({ session_id: 'c', harness: 'gemini' })],
    ])
    const out = scopeMetas(metas, { harnesses: ['claude'] })
    expect([...out.metas.keys()]).toEqual(['a'])
    expect(out.excluded).toBe(2)
  })
})
