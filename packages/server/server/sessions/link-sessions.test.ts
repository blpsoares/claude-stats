import { describe, expect, it } from 'bun:test'
import type { SessionMeta } from '@agentistics/core'
import type { ManagedSession } from './types'
import { LINK_WINDOW_MS, applySessionLabels, linkManagedSessions } from './link-sessions'

const T0 = Date.parse('2026-08-13T10:00:00.000Z')

const managed = (over: Partial<ManagedSession> = {}): ManagedSession => ({
  id: 'm1',
  harness: 'claude',
  cwd: '/repo/a',
  createdAt: new Date(T0).toISOString(),
  label: 'refactor auth',
  ...over,
})

const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  session_id: 's1',
  harness: 'claude',
  project_path: '/repo/a',
  start_time: new Date(T0 + 60_000).toISOString(),
  first_prompt: '',
  ...over,
} as SessionMeta)

describe('linkManagedSessions', () => {
  it('links the one conversation a managed session could have produced', () => {
    const links = linkManagedSessions([managed()], [meta()])
    expect(links.get('s1')?.id).toBe('m1')
  })

  it('links through a worktree, where the session records two directories', () => {
    // The managed session holds the directory it was STARTED in; the conversation records the
    // worktree it moved into. Matching only the more specific one would match neither end.
    const s = meta({ project_path: '/repo/a', current_cwd: '/repo/a/.claude/worktrees/x' })
    expect(linkManagedSessions([managed({ cwd: '/repo/a' })], [s]).get('s1')?.id).toBe('m1')
  })

  it('never links across harnesses', () => {
    expect(linkManagedSessions([managed({ harness: 'codex' })], [meta()]).size).toBe(0)
  })

  it('never links a conversation that predates the start', () => {
    const s = meta({ start_time: new Date(T0 - 1000).toISOString() })
    expect(linkManagedSessions([managed()], [s]).size).toBe(0)
  })

  it('never links a conversation outside the window', () => {
    const s = meta({ start_time: new Date(T0 + LINK_WINDOW_MS + 1000).toISOString() })
    expect(linkManagedSessions([managed()], [s]).size).toBe(0)
  })

  it('refuses when one managed session could be either of two conversations', () => {
    // Two assistants opened in one repository minutes apart is ordinary. Taking "the closest" would
    // be a coin flip dressed as a rule, on a store whose entire value is being trustworthy.
    const a = meta({ session_id: 's1', start_time: new Date(T0 + 60_000).toISOString() })
    const b = meta({ session_id: 's2', start_time: new Date(T0 + 90_000).toISOString() })
    expect(linkManagedSessions([managed()], [a, b]).size).toBe(0)
  })

  it('refuses when two managed sessions could claim the same conversation', () => {
    const m1 = managed({ id: 'm1', createdAt: new Date(T0).toISOString() })
    const m2 = managed({ id: 'm2', createdAt: new Date(T0 + 1000).toISOString() })
    expect(linkManagedSessions([m1, m2], [meta()]).size).toBe(0)
  })

  it('ignores a managed session with an unusable creation time', () => {
    expect(linkManagedSessions([managed({ createdAt: '' })], [meta()]).size).toBe(0)
  })

  it('ignores a conversation with an unusable start time', () => {
    expect(linkManagedSessions([managed()], [meta({ start_time: '' })]).size).toBe(0)
  })
})

describe('applySessionLabels', () => {
  it('stamps the user label and note onto the session they belong to', () => {
    const sessions = [meta()]
    applySessionLabels(sessions, linkManagedSessions([managed({ note: 'wip' })], sessions))
    expect(sessions[0]!.user_label).toBe('refactor auth')
    expect(sessions[0]!.user_note).toBe('wip')
  })

  it('touches nothing it cannot attribute', () => {
    const sessions = [meta({ session_id: 'other' })]
    applySessionLabels(sessions, linkManagedSessions([managed()], [meta()]))
    expect(sessions[0]!.user_label).toBeUndefined()
  })

  it('leaves a session alone when the managed one carries no label at all', () => {
    const sessions = [meta()]
    const m = managed()
    delete m.label
    applySessionLabels(sessions, linkManagedSessions([m], sessions))
    expect(sessions[0]!.user_label).toBeUndefined()
  })

  it('a /rename made inside the harness wins when agentop never labelled the session', () => {
    // The bug this whole change exists to fix: a rename typed inside Claude was invisible on the
    // web dashboard because the old code only ever looked at `m.label`.
    const sessions = [meta()]
    const m = managed({ harnessName: 'principal do cockpit', label: undefined })
    delete m.label
    applySessionLabels(sessions, linkManagedSessions([m], sessions))
    expect(sessions[0]!.user_label).toBe('principal do cockpit')
  })

  it('the NEWER rename wins when both sides named the session and both timestamps are known', () => {
    const sessions = [meta()]
    const m = managed({
      label: 'old agentop name', labelSince: T0 + 1000,
      harnessName: 'newer harness name', harnessNameSince: T0 + 2000,
    })
    applySessionLabels(sessions, linkManagedSessions([m], sessions))
    expect(sessions[0]!.user_label).toBe('newer harness name')
  })

  it('falls back to the harness name when timestamps cannot be compared — same judgement call pickTitle makes for the CLI', () => {
    const sessions = [meta()]
    const m = managed({ label: 'agentop label', harnessName: 'harness name' })
    applySessionLabels(sessions, linkManagedSessions([m], sessions))
    expect(sessions[0]!.user_label).toBe('harness name')
  })
})
