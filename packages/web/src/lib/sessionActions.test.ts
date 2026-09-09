import { describe, it, expect } from 'bun:test'
import { primaryAction, isWatchable } from './sessionActions'
import type { FleetRow, FleetVerb } from './fleet'

const verb = (action: FleetVerb['action'], enabled: boolean, label: string = action): FleetVerb => ({ action, label, enabled })

/** The eight verbs a live row carries, with each one's enabled state settable. */
function row(state: FleetRow['state'], enabled: Partial<Record<FleetVerb['action'], boolean>> = {}): FleetRow {
  const on = (a: FleetVerb['action']) => enabled[a] ?? false
  const verbs: FleetVerb[] = [
    verb('resume', on('resume'), 'Reopen'),
    verb('approve', on('approve'), 'Answer its question'),
    verb('prompt', on('prompt'), 'Send a prompt'),
    verb('rename', on('rename'), 'Rename'),
    verb('note', on('note'), 'Note'),
    verb('task', on('task'), 'Task'),
    verb('kill', on('kill'), 'Stop session'),
  ]
  return {
    id: 't', title: 't', harness: 'claude', cwd: '/x', project: 'x',
    state, stateLabel: state, actionable: true, attachCommand: 'agentop session attach t', verbs,
  }
}

describe('isWatchable', () => {
  it('is true for the states with a live pane', () => {
    expect(isWatchable('working')).toBe(true)
    expect(isWatchable('waiting')).toBe(true)
    expect(isWatchable('waiting-approval')).toBe(true)
  })
  it('is false for finished / gone / external states', () => {
    for (const s of ['exited', 'lost', 'closed', 'unknown'] as const) {
      expect(isWatchable(s)).toBe(false)
    }
  })
})

describe('primaryAction', () => {
  it('waiting-approval leads with approve, marked as a HUMAN action', () => {
    const p = primaryAction(row('waiting-approval', { approve: true, prompt: true, kill: true }))
    expect(p?.kind).toBe('approve')
    expect(p?.action).toBe('approve')
    expect(p?.human).toBe(true)
    expect(p?.verb?.label).toBe('Answer its question')
  })

  it('waiting-approval still leads with approve even when the verb is disabled (says why on press)', () => {
    const p = primaryAction(row('waiting-approval', { approve: false, prompt: true }))
    expect(p?.kind).toBe('approve')
    expect(p?.human).toBe(true)
    expect(p?.verb?.enabled).toBe(false)
  })

  it('waiting leads with a prompt (never approve — nothing is asking)', () => {
    const p = primaryAction(row('waiting', { approve: false, prompt: true }))
    expect(p?.kind).toBe('prompt')
    expect(p?.action).toBe('prompt')
    expect(p?.human).toBe(false)
    expect(p?.verb?.label).toBe('Send a prompt')
  })

  it('working leads with watch (open the terminal), no verb', () => {
    const p = primaryAction(row('working', { prompt: true, kill: true }))
    expect(p?.kind).toBe('watch')
    expect(p?.action).toBeUndefined()
    expect(p?.human).toBe(false)
  })

  it('a finished / closed session leads with reopen', () => {
    for (const s of ['exited', 'lost', 'closed'] as const) {
      const p = primaryAction(row(s, { resume: true }))
      expect(p?.kind).toBe('resume')
      expect(p?.action).toBe('resume')
      expect(p?.verb?.label).toBe('Reopen')
    }
  })

  it('an external (unknown) row has no lead action', () => {
    expect(primaryAction(row('unknown'))).toBeNull()
  })

  it('a finished row with no resume verb has no lead action', () => {
    const r = row('exited')
    r.verbs = r.verbs.filter(v => v.action !== 'resume')
    expect(primaryAction(r)).toBeNull()
  })

  it('never leads with a destructive verb', () => {
    for (const s of ['working', 'waiting', 'waiting-approval', 'exited', 'closed'] as const) {
      const p = primaryAction(row(s, { approve: true, prompt: true, resume: true, kill: true }))
      expect(p?.action).not.toBe('kill')
    }
  })
})
