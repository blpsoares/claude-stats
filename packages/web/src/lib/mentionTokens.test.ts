import { test, expect } from 'bun:test'
import { knownServers, mentionTokens } from './mentionTokens'

const known = new Set(['serena', 'agentistics', 'makenotion/notion-mcp-server', 'computer-use-mcp'])
const slice = (d: string, s: ReadonlySet<string> | null = known) =>
  mentionTokens(d, s).map(t => d.slice(t.start, t.end))

test('marks a bare server reference', () => {
  expect(slice('@agentistics')).toEqual(['@agentistics'])
})

test('marks a server:tool reference', () => {
  expect(slice('@serena:find_symbol')).toEqual(['@serena:find_symbol'])
})

test('marks several in one message, wherever they are', () => {
  // A mention is one word inside a message, not the whole message.
  expect(slice('usa @serena:find_symbol e depois @agentistics ok')).toEqual([
    '@serena:find_symbol', '@agentistics',
  ])
})

test('marks a server whose name carries a slash or a dash', () => {
  expect(slice('@makenotion/notion-mcp-server')).toEqual(['@makenotion/notion-mcp-server'])
  expect(slice('@computer-use-mcp')).toEqual(['@computer-use-mcp'])
})

test('leaves a server this machine does not have as plain text', () => {
  // The mark is read at a glance and believed, so it may never appear over something unverified.
  expect(slice('@naoexiste e @nada:coisa')).toEqual([])
})

test('an email address is not a mention', () => {
  expect(slice('me@agentistics escreve')).toEqual([])
})

test('marks nothing at all while the server list has not arrived', () => {
  // "I could not check" is not "this is real".
  expect(slice('@serena:find_symbol', null)).toEqual([])
})

test('an empty list is a real answer: this machine has no servers', () => {
  expect(slice('@serena', new Set())).toEqual([])
})

test('the trailing empty trigger is not a reference', () => {
  // `@serena:` with nothing after the colon is the picker's scaffolding — see dropEmptyAtTrigger.
  expect(slice('@serena:')).toEqual(['@serena'])
})

test('knownServers carries null through rather than inventing an empty set', () => {
  expect(knownServers(null)).toBeNull()
  expect(knownServers([{ name: 'serena' }])?.has('serena')).toBe(true)
})
