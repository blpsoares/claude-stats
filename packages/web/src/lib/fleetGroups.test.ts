import { expect, test, describe } from 'bun:test'
import { GONE_PROJECT_KEY, type ControlSession } from '@agentistics/tui/control/session-fleet'
import { projectGroups, showsProjectHeadings } from './fleetGroups'

function row(o: Partial<ControlSession> & { id: string }): ControlSession {
  return {
    title: o.id, harness: 'claude', cwd: '/w', project: 'w',
    searchFields: {} as ControlSession['searchFields'],
    state: 'working', stateLabel: 'working', actionable: true, attached: false,
    ...o,
  } as ControlSession
}

describe('projectGroups', () => {
  test('one band per project, named by the project', () => {
    const out = projectGroups([
      row({ id: 'a', project: 'agentistics' }),
      row({ id: 'b', project: 'aipe' }),
      row({ id: 'c', project: 'agentistics' }),
    ], 'en')
    expect(out.map(g => g.label).sort()).toEqual(['agentistics', 'aipe'])
    expect(out.find(g => g.label === 'agentistics')!.sessions).toHaveLength(2)
  })

  test('the band holding the most urgent session comes first', () => {
    const out = projectGroups([
      row({ id: 'a', project: 'quiet', state: 'working' }),
      row({ id: 'b', project: 'blocked', state: 'waiting-approval' }),
    ], 'en')
    expect(out[0]!.label).toBe('blocked')
  })

  test('a session with no project gets a band said in WORDS, never a blank heading', () => {
    const en = projectGroups([row({ id: 'a', project: '' })], 'en')
    const pt = projectGroups([row({ id: 'a', project: '' })], 'pt')
    expect(en[0]!.label).toBe('No project')
    expect(pt[0]!.label).toBe('Sem projeto')
  })

  test('a directory that is GONE is its own band, not the no-project one', () => {
    const out = projectGroups([
      row({ id: 'a', project: 'x', dirGone: 'the folder is gone' }),
      row({ id: 'b', project: '' }),
    ], 'en')
    const labels = out.map(g => g.label)
    expect(labels).toContain('Folder is gone')
    expect(labels).toContain('No project')
    expect(new Set(labels).size).toBe(2)
  })

  test('an empty fleet yields no bands', () => {
    expect(projectGroups([], 'en')).toEqual([])
  })
})

describe('showsProjectHeadings', () => {
  // The rule the whole feature turns on: a heading naming the ONLY project in the band repeats what
  // the band above it already said and costs a row — the same reason the cascade drops its root when
  // the grouping is already the project.
  test('one project draws no heading', () => {
    expect(showsProjectHeadings(projectGroups([
      row({ id: 'a', project: 'agentistics' }),
      row({ id: 'b', project: 'agentistics' }),
    ], 'en'))).toBe(false)
  })

  test('two projects draw headings', () => {
    expect(showsProjectHeadings(projectGroups([
      row({ id: 'a', project: 'agentistics' }),
      row({ id: 'b', project: 'aipe' }),
    ], 'en'))).toBe(true)
  })

  test('nothing at all draws no heading', () => {
    expect(showsProjectHeadings([])).toBe(false)
  })
})

describe("the grouping key is the TUI's own", () => {
  test('projectGroup outranks the directory name, and GONE has its own key', () => {
    const out = projectGroups([
      row({ id: 'a', project: 'worktree-x', projectGroup: 'agentistics' }),
      row({ id: 'b', project: 'worktree-y', projectGroup: 'agentistics' }),
    ], 'en')
    expect(out).toHaveLength(1)
    expect(out[0]!.label).toBe('agentistics')
    expect(out[0]!.key).not.toBe(GONE_PROJECT_KEY)
  })
})
