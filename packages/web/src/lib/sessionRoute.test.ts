import { expect, test } from 'bun:test'
import { sessionPath } from './sessionRoute'

test('an external id keeps its directory inside ONE path segment', () => {
  // Raw interpolation made this three segments and matched no route — a blank page.
  const id = 'external:antigravity:/home/mithrandir/agentistics:1788625485620'
  const path = sessionPath(id)
  expect(path.slice('/sessions/'.length)).not.toContain('/')
  expect(decodeURIComponent(path.slice('/sessions/'.length))).toBe(id)
})

test('a closed id round-trips too', () => {
  const id = 'closed:731e8d13-db8a-465b-81fc-3c520aba76d4'
  expect(decodeURIComponent(sessionPath(id).slice('/sessions/'.length))).toBe(id)
})

test('a plain managed id is unchanged in practice', () => {
  expect(sessionPath('a61d428316')).toBe('/sessions/a61d428316')
})

test('a windows-shaped cwd survives as well', () => {
  const id = 'external:claude:C:\\Users\\u\\proj:12'
  expect(decodeURIComponent(sessionPath(id).slice('/sessions/'.length))).toBe(id)
})
