import { test, expect } from 'bun:test'
import { highlight, languageOf, tokenizeLine } from './codeHighlight'

const kinds = (line: string, lang = 'ts', block = false) =>
  tokenizeLine(line, lang, block).tokens.map(t => t.kind)
const textOf = (line: string, lang = 'ts') =>
  tokenizeLine(line, lang, false).tokens.map(t => t.text).join('')

test('a language is decided by EXTENSION, never by sniffing the content', () => {
  // A file's name is a fact; guessing from its first line is how a shell script gets drawn as
  // Python for somebody who is about to read it.
  expect(languageOf('a/b/x.tsx')).toBe('ts')
  expect(languageOf('script.sh')).toBe('sh')
  expect(languageOf('data.json')).toBe('json')
  expect(languageOf('notes.md')).toBeNull()
  expect(languageOf('LICENSE')).toBeNull()
})

test('an unknown language is PLAIN, not guessed — mis-colouring says something false', () => {
  const out = highlight('anything at all\nsecond line', null)
  expect(out).toHaveLength(2)
  expect(out[0]).toEqual([{ kind: 'plain', text: 'anything at all' }])
})

test('nothing is ever lost: the tokens rejoin into the original line', () => {
  for (const line of [
    'const x = "a b" // note',
    'if (a<=b) { return c*2 }',
    "s = 'it\\'s'",
    '  indented(1, 2)',
    '',
  ]) expect(textOf(line), line).toBe(line)
})

test('comments, strings, numbers and keywords are told apart', () => {
  expect(kinds('// just a comment')).toEqual(['comment'])
  // Adjacent tokens of one kind are MERGED — ` a ` is one plain run, not three — because each one
  // becomes a span, and a file is thousands of lines.
  expect(kinds('const a = 42')).toEqual(['keyword', 'plain', 'punct', 'plain', 'number'])
  expect(tokenizeLine('const s = "hi"', 'ts', false).tokens.some(t => t.kind === 'string')).toBe(true)
})

test('a BLOCK comment carries across lines — a per-line lexer would draw half of it as code', () => {
  const out = highlight('/* one\ntwo\nthree */ const a = 1', 'ts')
  expect(out[0]!.every(t => t.kind === 'comment')).toBe(true)
  expect(out[1]!.every(t => t.kind === 'comment')).toBe(true)
  // The line that CLOSES it goes back to code after the close.
  expect(out[2]!.some(t => t.kind === 'keyword')).toBe(true)
})

test('a hash is a comment in shell and python, and is not in TypeScript', () => {
  expect(kinds('# note', 'sh')).toEqual(['comment'])
  expect(kinds('# note', 'py')).toEqual(['comment'])
  expect(kinds('# note', 'ts')[0]).not.toBe('comment')
})

test('empty input is ONE line, so the gutter still starts at 1', () => {
  expect(highlight('', 'ts')).toHaveLength(1)
})

test('a file keeps its line count exactly, which is what the gutter numbers', () => {
  const src = 'a\nb\nc\n'
  expect(highlight(src, 'ts')).toHaveLength(src.split('\n').length)
})
