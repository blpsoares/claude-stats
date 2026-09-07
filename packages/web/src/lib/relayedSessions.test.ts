import { describe, expect, it } from 'bun:test'
import { relayedToSession, relayedToSessions } from './relayedSessions'

const row = {
  id: 's1', title: 'AGENTISTICS SESSIONS', harness: 'claude',
  state: 'waiting', stateLabel: 'needs you',
  project: 'agentistics', cwd: '~/agentistics',
  task: 'sessions', note: 'careful', model: 'claude-opus-5', named: true,
  verbs: [{ action: 'rename', label: 'Rename', enabled: true }],
}

describe('relayedToSession', () => {
  it('passes the row through — the list draws the same fields it always did', () => {
    const s = relayedToSession(row)
    expect(s.title).toBe('AGENTISTICS SESSIONS')
    expect(s.stateLabel).toBe('needs you')
    expect(s.project).toBe('agentistics')
    expect(s.model).toBe('claude-opus-5')
    expect(s.named).toBe(true)
  })

  it('builds search from what ARRIVED, and leaves the prompt empty', () => {
    // The opening prompt does not cross the wire. Searching by it would silently match nothing.
    const s = relayedToSession(row)
    expect(s.searchFields).toEqual({
      name: 'AGENTISTICS SESSIONS', folder: '~/agentistics', harness: 'claude',
      note: 'careful', task: 'sessions', prompt: '',
    })
  })

  it('is actionable only when the MACHINE offered a verb it will accept', () => {
    expect(relayedToSession(row).actionable).toBe(true)
    expect(relayedToSession({ ...row, verbs: [{ action: 'kill', label: 'Kill', enabled: false }] }).actionable).toBe(false)
    expect(relayedToSession({ ...row, verbs: [] }).actionable).toBe(false)
    const { verbs: _drop, ...noVerbs } = row
    expect(relayedToSession(noVerbs).actionable).toBe(false)
  })

  it('is never attached — a central has no terminal on that host', () => {
    expect(relayedToSession(row).attached).toBe(false)
  })

  it('leaves a withheld field ABSENT rather than inventing one', () => {
    const { note: _n, task: _t, model: _m, ...bare } = row
    const s = relayedToSession(bare)
    expect(s.note).toBeUndefined()
    expect(s.task).toBeUndefined()
    expect(s.model).toBeUndefined()
    expect(s.searchFields.note).toBe('')
  })

  it('maps a list', () => {
    expect(relayedToSessions([row, { ...row, id: 's2' }]).map(s => s.id)).toEqual(['s1', 's2'])
  })
})
