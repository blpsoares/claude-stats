import { describe, expect, it } from 'bun:test'
import { rowMenuEntries } from './rowMenu'

const verbs = [
  { action: 'rename', label: 'Rename', enabled: true },
  { action: 'interrupt', label: 'Stop the turn', enabled: true },
  { action: 'kill', label: 'End session', enabled: true },
  { action: 'resume', label: 'Reopen', enabled: false, reason: 'No conversation to reopen.' },
  { action: 'note', label: 'Note', enabled: true },
]

describe('rowMenuEntries', () => {
  it('offers rename, stop and reopen, in that order', () => {
    expect(rowMenuEntries(verbs, 'working').map(e => e.action)).toEqual(['rename', 'interrupt', 'resume'])
  })

  it('stops a running turn with interrupt and a stopped one with kill', () => {
    expect(rowMenuEntries(verbs, 'working')[1]!.action).toBe('interrupt')
    expect(rowMenuEntries(verbs, 'waiting')[1]!.action).toBe('kill')
  })

  it('keeps a refused verb, disabled, with its reason — never drops it', () => {
    const resume = rowMenuEntries(verbs, 'working').find(e => e.action === 'resume')!
    expect(resume.enabled).toBe(false)
    expect(resume.reason).toBe('No conversation to reopen.')
  })

  it('omits a verb the row does not carry at all', () => {
    expect(rowMenuEntries([{ action: 'rename', label: 'Rename', enabled: true }], 'lost')
      .map(e => e.action)).toEqual(['rename'])
  })

  it('is empty for a row with no verbs, so the caller can decline to open a menu', () => {
    expect(rowMenuEntries([], 'external')).toEqual([])
  })
})
