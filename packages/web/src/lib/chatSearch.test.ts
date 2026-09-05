import { test, expect } from 'bun:test'
import { findChatMatches, foldForSearch, matchLabel, stepMatch } from './chatSearch'

test('folding preserves LENGTH, so an offset into it is an offset into the original', () => {
  for (const s of ['sessão', 'AÇÃO', 'Ínterim', 'plain ascii', 'ünïcödé', '📦 emoji', 'İstanbul']) {
    expect(foldForSearch(s).length).toBe(s.length)
  }
})

test('accents and case fold, because nobody types the tilde while hunting', () => {
  expect(foldForSearch('Sessão')).toBe('sessao')
  expect(foldForSearch('AÇÃO')).toBe('acao')
})

test('a match is found across an accent difference', () => {
  const turns = [{ text: 'abriu a sessão do harness' }]
  expect(findChatMatches(turns, 'sessao')).toEqual([{ turnIndex: 0, start: 8, end: 14 }])
})

test('the range lands on the ORIGINAL text, accents included', () => {
  const turns = [{ text: 'abriu a sessão do harness' }]
  const [m] = findChatMatches(turns, 'sessao')
  expect(turns[0]!.text.slice(m!.start, m!.end)).toBe('sessão')
})

test('every occurrence counts, not every turn', () => {
  const turns = [{ text: 'erro erro' }, { text: 'sem nada' }, { text: 'erro' }]
  const m = findChatMatches(turns, 'erro')
  expect(m).toHaveLength(3)
  expect(m.map(x => x.turnIndex)).toEqual([0, 0, 2])
})

test('overlaps are not double-counted — "aa" in "aaa" is one hit', () => {
  expect(findChatMatches([{ text: 'aaa' }], 'aa')).toHaveLength(1)
})

test('a blank query matches NOTHING, never everything', () => {
  for (const q of ['', '   ', '\n\t']) {
    expect(findChatMatches([{ text: 'qualquer coisa' }], q)).toEqual([])
  }
})

test('turns with no text are skipped rather than throwing', () => {
  expect(findChatMatches([{}, { text: '' }, { text: 'x' }], 'x')).toHaveLength(1)
})

test('stepping wraps at both ends — a result list is a ring', () => {
  expect(stepMatch(2, 3, 1)).toBe(0)
  expect(stepMatch(0, 3, -1)).toBe(2)
  expect(stepMatch(0, 3, 1)).toBe(1)
})

test('stepping an empty list is 0, so a caller can index blindly', () => {
  expect(stepMatch(0, 0, 1)).toBe(0)
  expect(stepMatch(5, 0, -1)).toBe(0)
})

test('"nothing typed" and "nothing found" are different sentences', () => {
  expect(matchLabel('', 0, 0, 'pt')).toBe('')
  expect(matchLabel('zzz', 0, 0, 'pt')).toBe('nada encontrado')
  expect(matchLabel('zzz', 0, 0, 'en')).toBe('no matches')
  expect(matchLabel('erro', 12, 2, 'en')).toBe('3 / 12')
})
