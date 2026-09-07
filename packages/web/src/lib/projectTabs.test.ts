import { describe, expect, it } from 'bun:test'
import { projectKind, takePerKind, type ProjectKind } from '@agentistics/core'
import { KIND_TABS, kindEmpty, kindHint, kindLabel } from './projectTabs'

describe('the tabs', () => {
  it('opens on All, and offers exactly three kinds beside it', () => {
    expect(KIND_TABS[0]).toBe('all')
    expect(KIND_TABS).toEqual(['all', 'repo', 'project', 'folder'])
  })

  it('names every tab in both languages, and hints every one', () => {
    for (const t of KIND_TABS) {
      expect(kindLabel(t, true).length).toBeGreaterThan(0)
      expect(kindLabel(t, false).length).toBeGreaterThan(0)
      expect(kindHint(t, true).length).toBeGreaterThan(0)
      expect(kindHint(t, false).length).toBeGreaterThan(0)
    }
  })
})

/**
 * Three different things empty this list and they send a reader to three different actions. One
 * shared "no folder found" named none of them — the same rule `liveEmptyNotice` applies.
 */
describe('kindEmpty — never one shared empty box', () => {
  it('blames the SEARCH when there is one, and quotes it back', () => {
    const s = kindEmpty('all', 'portif', true, false)
    expect(s).toContain('"portif"')
    expect(s).toContain('fewer letters')
  })

  it('names the TAB when the search is what is narrowing inside one', () => {
    expect(kindEmpty('repo', 'portif', true, false)).toContain('under repositories')
    expect(kindEmpty('all', 'portif', true, false)).not.toContain('under')
  })

  it('sends the reader to another TAB when there is no search and other rows exist', () => {
    const s = kindEmpty('folder', '', true, false)
    expect(s).toContain('The other tabs have items')
    // And it says what this tab would have held, so the emptiness is readable.
    expect(s).toContain(kindHint('folder', false))
  })

  it('says the MACHINE has nothing when nothing is offered anywhere', () => {
    expect(kindEmpty('all', '', false, false)).toContain('Nothing to open here yet')
    // Not the tab sentence: with no rows at all, "the other tabs have items" would be false.
    expect(kindEmpty('repo', '', false, false)).not.toContain('other tabs')
  })

  it('answers in Portuguese too', () => {
    expect(kindEmpty('all', '', false, true)).toContain('Nada para abrir aqui ainda')
    expect(kindEmpty('repo', 'x', true, true)).toContain('repositórios')
  })
})

/**
 * The picker's buckets and the server's per-kind budget read the SAME function, so a row cannot be
 * counted under one kind here and budgeted under another there.
 */
describe('projectKind — the division the tabs are built on', () => {
  it('a recorded remote is proof, whatever the source says', () => {
    expect(projectKind({ source: 'history', remote: 'github.com/o/r' })).toBe('repo')
    expect(projectKind({ source: 'cwd', remote: 'o/r' })).toBe('repo')
  })

  it('a walked `.git` is proof too — a fresh clone has no recorded remote', () => {
    expect(projectKind({ source: 'repo', remote: '' })).toBe('repo')
    expect(projectKind({ source: 'repo' })).toBe('repo')
  })

  it('history with no git is a PROJECT: a place someone works', () => {
    expect(projectKind({ source: 'history', remote: '' })).toBe('project')
  })

  it('everything else is a folder', () => {
    expect(projectKind({ source: 'folder', remote: '' })).toBe('folder')
    expect(projectKind({ source: 'typed' })).toBe('folder')
    expect(projectKind({ source: 'cwd' })).toBe('folder')
  })

  it('the kinds are MUTUALLY EXCLUSIVE — that is what makes the division clear', () => {
    const seen = new Set<ProjectKind>()
    for (const c of [
      { source: 'history', remote: 'o/r' }, { source: 'history', remote: '' },
      { source: 'folder', remote: '' },
    ]) seen.add(projectKind(c))
    expect([...seen].sort()).toEqual(['folder', 'project', 'repo'])
  })
})

/**
 * The measured bug: `portif` ranked twenty rows, FIFTEEN of them plain folders, and the three
 * repositories the person wanted were what the global cap spent its budget on.
 */
describe('takePerKind — a folder named like your repo cannot push your repo off the list', () => {
  const row = (source: string, remote = '') => ({ source, remote })

  it('keeps up to N of EACH kind rather than N overall', () => {
    const ranked = [
      ...Array.from({ length: 15 }, () => row('folder')),
      row('history', 'o/r'), row('history', 'o/r2'), row('history', ''),
    ]
    const kept = takePerKind(ranked, c => projectKind(c), 3)
    expect(kept.filter(c => projectKind(c) === 'folder')).toHaveLength(3)
    expect(kept.filter(c => projectKind(c) === 'repo')).toHaveLength(2)
    expect(kept.filter(c => projectKind(c) === 'project')).toHaveLength(1)
  })

  it('NEVER reorders — ranking is the search\'s job and this only caps', () => {
    const ranked = [row('history', 'o/a'), row('folder'), row('history', 'o/b')]
    expect(takePerKind(ranked, c => projectKind(c), 9)).toEqual(ranked)
  })

  it('a limit of zero or below keeps nothing, rather than everything', () => {
    expect(takePerKind([row('folder')], c => projectKind(c), 0)).toEqual([])
    expect(takePerKind([row('folder')], c => projectKind(c), -1)).toEqual([])
  })
})
