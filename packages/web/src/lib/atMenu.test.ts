import { test, expect } from 'bun:test'
import {
  applyAtServer, applyAtTool, atLevel, atQuery, atServerStatusText, atToolViewReason,
  emptyAtServerReason, emptyAtToolReason, filterAtServers, filterAtTools, findAtServer,
  resolveAtToolView, type MenuMcpServer, type MenuMcpTool,
} from './atMenu'

const tool = (name: string, description = ''): MenuMcpTool => ({ name, description })
const server = (
  name: string, status: MenuMcpServer['status'], extra: Partial<MenuMcpServer> = {},
): MenuMcpServer => ({ name, status, ...extra })

// ---------------------------------------------------------------------------------------------
// atQuery — the trigger, and its word-boundary rule.
// ---------------------------------------------------------------------------------------------

test('a bare @ at the start of the message opens with an empty query', () => {
  expect(atQuery('@')).toBe('')
})

test('typing after the @ is the query', () => {
  expect(atQuery('@serena')).toBe('serena')
  expect(atQuery('@serena:find')).toBe('serena:find')
})

test('an @ preceded by whitespace still triggers — it is a new word', () => {
  expect(atQuery('hi @serena')).toBe('serena')
  expect(atQuery('line one\n@serena')).toBe('serena')
})

test('an @ MID-WORD is not a trigger — an email address, a git ref', () => {
  expect(atQuery('user@domain')).toBeNull()
  expect(atQuery('HEAD@{1}')).toBeNull()
})

test('a trailing space ends the reference, same rule as the slash picker', () => {
  expect(atQuery('@serena ')).toBeNull()
  expect(atQuery('@serena: ')).toBeNull()
})

test('no @ at all is simply closed', () => {
  expect(atQuery('')).toBeNull()
  expect(atQuery('hello there')).toBeNull()
})

// ---------------------------------------------------------------------------------------------
// atLevel — the two-level split on the FIRST colon.
// ---------------------------------------------------------------------------------------------

test('no colon is the server level, filtering by the whole query', () => {
  expect(atLevel('')).toEqual({ level: 'server', serverText: '', toolText: '' })
  expect(atLevel('ser')).toEqual({ level: 'server', serverText: 'ser', toolText: '' })
})

test('a colon switches to the tool level for the name typed before it', () => {
  expect(atLevel('serena:')).toEqual({ level: 'tool', serverText: 'serena', toolText: '' })
  expect(atLevel('serena:find')).toEqual({ level: 'tool', serverText: 'serena', toolText: 'find' })
})

test('a second colon is just more filter text, never a third level', () => {
  expect(atLevel('serena:a:b')).toEqual({ level: 'tool', serverText: 'serena', toolText: 'a:b' })
})

// ---------------------------------------------------------------------------------------------
// filterAtServers / findAtServer
// ---------------------------------------------------------------------------------------------

test('the server filter is case-insensitive substring, and blank means everything', () => {
  const list = [server('serena', 'ready'), server('agentistics', 'ready')]
  expect(filterAtServers(list, 'SER').map(s => s.name)).toEqual(['serena'])
  expect(filterAtServers(list, '')).toHaveLength(2)
})

test('finding an exact server is case-insensitive too — the list is what taught the case', () => {
  const list = [server('Serena', 'ready')]
  expect(findAtServer(list, 'serena')?.name).toBe('Serena')
  expect(findAtServer(list, 'nope')).toBeNull()
})

// ---------------------------------------------------------------------------------------------
// filterAtTools / resolveAtToolView — never a confident zero.
// ---------------------------------------------------------------------------------------------

test('the tool filter reads name AND description', () => {
  const tools = [tool('find_symbol', 'Locate a symbol'), tool('write_memory', 'Persist a note')]
  expect(filterAtTools(tools, 'locate').map(t => t.name)).toEqual(['find_symbol'])
  expect(filterAtTools(tools, '')).toHaveLength(2)
})

test('a pending server never resolves as zero tools — it resolves as PENDING', () => {
  const list = [server('serena', 'pending')]
  expect(resolveAtToolView(list, 'serena', '')).toEqual({ kind: 'pending' })
})

test('an unreachable server carries its reason and is never descended into', () => {
  const list = [server('serena', 'unreachable', { outcome: 'not-found' })]
  expect(resolveAtToolView(list, 'serena', '')).toEqual({ kind: 'unreachable', outcome: 'not-found' })
})

test('a typo in the server name is UNKNOWN, not an empty tool list', () => {
  const list = [server('serena', 'ready', { tools: [] })]
  expect(resolveAtToolView(list, 'serenaa', '')).toEqual({ kind: 'unknown-server' })
})

test('a ready server resolves its (filtered) tool list', () => {
  const list = [server('serena', 'ready', { tools: [tool('find_symbol'), tool('write_memory')] })]
  expect(resolveAtToolView(list, 'serena', 'find')).toEqual({ kind: 'tools', tools: [tool('find_symbol')] })
  expect(resolveAtToolView(list, 'serena', '')).toEqual({
    kind: 'tools', tools: [tool('find_symbol'), tool('write_memory')],
  })
})

// ---------------------------------------------------------------------------------------------
// atServerStatusText — the row subtitle, three states, three sentences.
// ---------------------------------------------------------------------------------------------

test('a ready server states its tool count, singular handled', () => {
  expect(atServerStatusText(server('s', 'ready', { tools: [tool('a')] }), 'en')).toBe('1 tool')
  expect(atServerStatusText(server('s', 'ready', { tools: [tool('a'), tool('b')] }), 'en')).toBe('2 tools')
  expect(atServerStatusText(server('s', 'ready', { tools: [] }), 'pt')).toBe('0 ferramentas')
})

test('a pending server says it is still being asked, in both languages', () => {
  expect(atServerStatusText(server('s', 'pending'), 'en')).toContain('asking')
  expect(atServerStatusText(server('s', 'pending'), 'pt')).toContain('perguntando')
})

test('an unreachable server states its reason, reusing the six-outcome table', () => {
  const text = atServerStatusText(server('s', 'unreachable', { outcome: 'not-found' }), 'en')
  expect(text).toBe('The command is not on this machine.')
})

// ---------------------------------------------------------------------------------------------
// atToolViewReason — the sentence for everything that is not a tool list.
// ---------------------------------------------------------------------------------------------

test('a tools view carries no reason — the caller draws the list', () => {
  expect(atToolViewReason({ kind: 'tools', tools: [] }, 's', 'en')).toBeNull()
})

test('the other three shapes each get their own sentence', () => {
  const un = atToolViewReason({ kind: 'unknown-server' }, 'serenaa', 'en')
  const pe = atToolViewReason({ kind: 'pending' }, 'serena', 'en')
  const nr = atToolViewReason({ kind: 'unreachable', outcome: 'timeout' }, 'serena', 'en')
  expect(un).toContain('serenaa')
  expect(pe).toContain('serena')
  expect(nr).toContain('did not answer in time')
  expect(new Set([un, pe, nr]).size).toBe(3)
})

// ---------------------------------------------------------------------------------------------
// emptyAtServerReason / emptyAtToolReason
// ---------------------------------------------------------------------------------------------

test('no servers configured is a different sentence from none matching', () => {
  expect(emptyAtServerReason(0, '', 'en')).toContain('No MCP server')
  expect(emptyAtServerReason(3, 'zzz', 'en')).toContain('3')
  expect(emptyAtServerReason(3, 'zzz', 'en')).toContain('zzz')
})

test('a server with genuinely zero tools reads differently from a filter matching nothing', () => {
  expect(emptyAtToolReason('serena', 0, '', 'en')).toContain('reported no tools')
  expect(emptyAtToolReason('serena', 5, 'zzz', 'en')).toContain('zzz')
  expect(emptyAtToolReason('serena', 5, 'zzz', 'en')).toContain('serena')
})

// ---------------------------------------------------------------------------------------------
// applyAtServer — rule 4: bare mention, closes.
// ---------------------------------------------------------------------------------------------

test('picking a server with no colon typed inserts the bare mention and closes', () => {
  const out = applyAtServer('hi @ser', 7, 'serena')
  expect(out.text).toBe('hi @serena ')
  expect(out.caret).toBe(out.text.length)
})

test('picking a server keeps what comes after the caret', () => {
  const out = applyAtServer('@ser tail', 4, 'serena')
  expect(out.text).toBe('@serena  tail')
})

test('a vanished trigger falls back to appending, never throwing away the pick', () => {
  const out = applyAtServer('already sent', 0, 'serena')
  expect(out.text).toBe('already sent @serena ')
})

// ---------------------------------------------------------------------------------------------
// applyAtTool — decision 4: fully-qualified token, and the reopened trigger.
// ---------------------------------------------------------------------------------------------

test('picking a tool writes the fully-qualified token, never a compressed form', () => {
  const out = applyAtTool('@serena:find', 12, 'serena', 'find_symbol')
  expect(out.text.startsWith('@serena:find_symbol @serena:')).toBe(true)
})

test('the trigger REOPENS for the same server — this is how "one or more" works', () => {
  const first = applyAtTool('@serena:', 8, 'serena', 'find_symbol')
  expect(atQuery(first.text.slice(0, first.caret))).toBe('serena:')
  const level = atLevel(atQuery(first.text.slice(0, first.caret))!)
  expect(level).toEqual({ level: 'tool', serverText: 'serena', toolText: '' })
})

test('a second pick on the reopened trigger appends its own token — never a,b compression', () => {
  const first = applyAtTool('@serena:', 8, 'serena', 'find_symbol')
  const second = applyAtTool(first.text, first.caret, 'serena', 'write_memory')
  expect(second.text).toBe('@serena:find_symbol @serena:write_memory @serena:')
  expect(second.text).not.toContain(',')
})

test('what comes after the caret survives a tool pick, exactly as a server pick preserves it', () => {
  const out = applyAtTool('@serena: tail', 8, 'serena', 'find_symbol')
  expect(out.text).toBe('@serena:find_symbol @serena: tail')
})
