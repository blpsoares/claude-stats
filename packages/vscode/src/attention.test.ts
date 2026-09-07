import { describe, expect, it } from 'bun:test'
import { readAttention, type AttentionMemory } from './attention'
import type { FleetRow, SessionState } from './protocol'

function row(id: string, state: SessionState): FleetRow {
  return {
    id,
    title: id,
    harness: 'claude',
    cwd: `/w/${id}`,
    project: 'w',
    state,
    stateLabel: state,
    actionable: true,
    attachCommand: `agentop session attach ${id}`,
    verbs: [],
  }
}

describe('readAttention', () => {
  it('announces nothing on the first read, however much is blocked', () => {
    // Opening the editor on a machine with three blocked sessions must not fire three toasts.
    const out = readAttention(null, [
      row('a', 'waiting-approval'),
      row('b', 'waiting-approval'),
      row('c', 'waiting-approval'),
    ])
    expect(out.announce).toEqual([])
    expect(out.count).toBe(3)
  })

  it('announces the transition into a blocked state, once', () => {
    const first = readAttention(null, [row('a', 'working')])
    const second = readAttention(first.memory, [row('a', 'waiting-approval')])
    expect(second.announce.map(r => r.id)).toEqual(['a'])
    // …and not again on the next poll, with nothing having changed.
    const third = readAttention(second.memory, [row('a', 'waiting-approval')])
    expect(third.announce).toEqual([])
  })

  it('announces again when the session came back and blocked a second time', () => {
    const a = readAttention(null, [row('x', 'waiting-approval')])
    const b = readAttention(a.memory, [row('x', 'working')])
    const c = readAttention(b.memory, [row('x', 'waiting-approval')])
    expect(c.announce.map(r => r.id)).toEqual(['x'])
  })

  it('announces a row that arrives already blocked, once there is a baseline', () => {
    // A session started from another window, or by a hook, that is blocked by the time we see it.
    const first = readAttention(null, [row('a', 'working')])
    const second = readAttention(first.memory, [row('a', 'working'), row('new', 'waiting-approval')])
    expect(second.announce.map(r => r.id)).toEqual(['new'])
  })

  it('never announces plain waiting — that is where every turn ends', () => {
    const first = readAttention(null, [row('a', 'working')])
    const second = readAttention(first.memory, [row('a', 'waiting')])
    expect(second.announce).toEqual([])
    // It still counts toward the badge: it IS waiting on a person.
    expect(second.count).toBe(1)
  })

  it('counts the level, blocked and merely waiting alike', () => {
    const out = readAttention(null, [
      row('a', 'waiting'),
      row('b', 'waiting-approval'),
      row('c', 'working'),
      row('d', 'lost'),
      row('e', 'unknown'),
    ])
    expect(out.count).toBe(2)
  })

  it('keeps "not read yet" and "read, and empty" apart', () => {
    // An empty memory is a real answer: the fleet was empty. Treating it as `null` would re-announce
    // the whole fleet the next time anything appeared.
    const empty: AttentionMemory = new Map()
    expect(readAttention(empty, [row('a', 'waiting-approval')]).announce.map(r => r.id)).toEqual(['a'])
    expect(readAttention(null, [row('a', 'waiting-approval')]).announce).toEqual([])
  })

  it('forgets a row that is gone, so its return is a fresh transition', () => {
    const a = readAttention(null, [row('x', 'waiting-approval')])
    const b = readAttention(a.memory, [])
    expect(b.memory.has('x')).toBe(false)
    expect(readAttention(b.memory, [row('x', 'waiting-approval')]).announce.map(r => r.id)).toEqual(['x'])
  })
})
