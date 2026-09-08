import { describe, expect, test } from 'bun:test'
import { countPerKind, projectKind } from './projectKind'

describe('countPerKind', () => {
  const rows = [
    { source: 'repo' }, { source: 'repo' }, { source: 'repo' },
    { source: 'history' },
    { source: 'folder' }, { source: 'folder' },
  ]

  test('counts what MATCHED, which is not what a capped list holds', () => {
    // THE REPORTED CASE: the wizard's tabs read `Repositories 12 · Projects 12 · Folders 12` on a
    // machine with far more of each — they were counting the rows the per-kind CAP had returned.
    // A cap presented as a count is a number that can never be anything but 12.
    expect(countPerKind(rows, projectKind)).toEqual({ repo: 3, project: 1, folder: 2 })
  })

  test('a kind with nothing matching counts zero, not absent', () => {
    expect(countPerKind([{ source: 'folder' }], projectKind).repo).toBe(0)
  })

  test('an empty search counts zero of everything', () => {
    expect(countPerKind([], projectKind)).toEqual({ repo: 0, project: 0, folder: 0 })
  })
})

