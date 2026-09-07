import { expect, test } from 'bun:test'
import { prCaption } from './prCaption'

test('names the window only when the list is actually capped', () => {
  expect(prCaption({ shown: 30, limit: 30, lang: 'pt' })).toContain('30 pull requests mais recentes')
  expect(prCaption({ shown: 4, limit: 30, lang: 'pt' })).not.toContain('30')
  expect(prCaption({ shown: 30, limit: 30, lang: 'en' })).toContain('30 most recent')
  expect(prCaption({ shown: 4, limit: 30, lang: 'en' })).not.toContain('30')
})

test('says the list is the repository\'s in every shape', () => {
  for (const lang of ['pt', 'en'] as const) {
    for (const limit of [undefined, 30]) {
      for (const shown of [1, 30]) {
        const s = prCaption({ shown, limit, lang })
        expect(lang === 'pt' ? s.includes('repositório') : s.includes('repository')).toBe(true)
        expect(lang === 'pt' ? s.includes('não só desta') : s.includes('not only this one')).toBe(true)
      }
    }
  }
})

test('an absent limit never claims a window — an older server sends none', () => {
  expect(prCaption({ shown: 30, limit: undefined, lang: 'pt' })).not.toContain('mais recentes')
  expect(prCaption({ shown: 30, limit: 0, lang: 'en' })).not.toContain('most recent')
})
