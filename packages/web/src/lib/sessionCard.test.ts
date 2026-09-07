import { describe, it, expect } from 'bun:test'
import { bandFact, bandRepeats, type SessionGrouping } from './sessionCard'

describe('bandFact', () => {
  it('names the fact each dimension bands by', () => {
    expect(bandFact('repo')).toBe('repo')
    expect(bandFact('project')).toBe('project')
    expect(bandFact('harness')).toBe('harness')
    expect(bandFact('model')).toBe('model')
  })

  it('states no fact for the bands that are not one of the card fields', () => {
    for (const g of ['none', 'status', 'marked'] as SessionGrouping[]) {
      expect(bandFact(g)).toBeNull()
    }
  })
})

describe('bandRepeats', () => {
  it('drops the fact the band states, by value', () => {
    expect(bandRepeats('repo', 'repo', 'org/app', 'org/app')).toBe(true)
    expect(bandRepeats('project', 'project', 'agentistics', 'agentistics')).toBe(true)
  })

  it('keeps a fact the band names on another dimension', () => {
    expect(bandRepeats('repo', 'project', 'agentistics', 'org/app')).toBe(false)
    expect(bandRepeats('model', 'repo', 'org/app', 'claude-opus-5')).toBe(false)
  })

  it('keeps a value the band does not state, even on the banded dimension', () => {
    // `CardMeta` prefers the live fleet row's project and the band reads the stored path; when the
    // two disagree the card's value is a fact the heading never carried.
    expect(bandRepeats('project', 'project', 'issue-217-session-card', 'agentistics')).toBe(false)
  })

  it('keeps everything for a card outside any band', () => {
    expect(bandRepeats('repo', 'repo', 'org/app', undefined)).toBe(false)
    expect(bandRepeats('none', 'repo', 'org/app', 'org/app')).toBe(false)
  })

  it('never drops an empty value (there is nothing to drop)', () => {
    expect(bandRepeats('repo', 'repo', '', '')).toBe(false)
  })
})
