import { describe, expect, it } from 'bun:test'
import { boardCopy, statusLabel } from './copy'
import { COLUMN_ORDER } from './board'

describe('boardCopy', () => {
  it('carries the same keys in both languages', () => {
    // A key present in one language only renders as `undefined` — a blank label, which is worse
    // than the English one it replaced.
    const en = boardCopy('en')
    const pt = boardCopy('pt')
    expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort())
    expect(Object.keys(pt.status).sort()).toEqual(Object.keys(en.status).sort())
  })

  it('names every status the board can be in', () => {
    // The chip is the only way to set a status, so a status with no word here is a row nobody can
    // read and nobody can choose.
    for (const status of COLUMN_ORDER) {
      expect(boardCopy('en').status[status]).toBeTruthy()
      expect(boardCopy('pt').status[status]).toBeTruthy()
    }
  })

  it('leaves no sentence empty, at any depth', () => {
    // WALKED rather than skipped by key: `status` and `tabs` are nested records, and the old
    // version's `if (key === 'status') continue` meant every record added after it went unchecked —
    // `tabs` arrived empty-safe by luck, not by test.
    const strings = (v: unknown): string[] =>
      typeof v === 'string' ? [v] : (v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [])
    for (const lang of ['en', 'pt'] as const) {
      const all = strings(boardCopy(lang))
      expect(all.length).toBeGreaterThan(20)
      for (const value of all) expect(value.length).toBeGreaterThan(0)
    }
  })

  it('renders an unknown status as itself rather than as nothing', () => {
    expect(statusLabel('something_new', 'pt')).toBe('something_new')
  })

  it('uses the same word for the status as for the thing being counted', () => {
    // "Entregue" and not "Concluída": the board measures deliveries, and a status that used a
    // different word would make the count and the column read as two different things.
    expect(statusLabel('done', 'pt')).toBe('Entregue')
    expect(boardCopy('pt').deliveries).toBe('Entregas')
  })
})
