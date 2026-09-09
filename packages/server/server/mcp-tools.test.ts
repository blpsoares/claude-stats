import { test, expect } from 'bun:test'
import {
  toolsListFrame, initializedNotification, readToolsList, toolsCacheKey, toolsView,
  McpToolsCache, type McpToolsProbe,
} from './mcp-tools'

test('the tools/list frame is one line of JSON-RPC, id 2 so it cannot be mistaken for the handshake', () => {
  const f = toolsListFrame()
  expect(f.endsWith('\n')).toBe(true)
  const m = JSON.parse(f.trim())
  expect(m.method).toBe('tools/list')
  expect(m.id).toBe(2)
  expect(m.id).not.toBe(1) // 1 is `initializeFrame`'s id — see mcp-check.ts
})

test('the initialized notification carries no id — it is a notification, not a request', () => {
  const f = initializedNotification()
  expect(f.endsWith('\n')).toBe(true)
  const m = JSON.parse(f.trim())
  expect(m.method).toBe('notifications/initialized')
  expect(m.id).toBeUndefined()
})

test('a reply with tools, one of them missing a description', () => {
  const out = JSON.stringify({
    jsonrpc: '2.0', id: 2,
    result: { tools: [{ name: 'find_symbol', description: 'Find a symbol' }, { name: 'list_dir' }] },
  })
  expect(readToolsList(out)).toEqual({
    answered: true,
    tools: [{ name: 'find_symbol', description: 'Find a symbol' }, { name: 'list_dir' }],
  })
})

test('a reply that genuinely has no tools is answered, and the list is empty', () => {
  const out = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } })
  expect(readToolsList(out)).toEqual({ answered: true, tools: [] })
})

test('scans past whatever the server logged before the reply, like readInitialize does', () => {
  const out = [
    'INFO starting…',
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 's' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'a' }] } }),
  ].join('\n')
  expect(readToolsList(out)).toEqual({ answered: true, tools: [{ name: 'a' }] })
})

test('malformed or unexpected content in the matched reply yields an empty list, never a throw', () => {
  // result.tools is not an array
  expect(readToolsList(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: 'nope' } })))
    .toEqual({ answered: true, tools: [] })
  // result itself is missing
  expect(readToolsList(JSON.stringify({ jsonrpc: '2.0', id: 2 })))
    .toEqual({ answered: true, tools: [] })
  // an error reply still answers our request — it is not a handshake failure, it is a real "no"
  expect(readToolsList(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'nope' } })))
    .toEqual({ answered: true, tools: [] })
  // a tool entry with a non-string / empty name is dropped rather than crashing the parse
  expect(readToolsList(JSON.stringify({
    jsonrpc: '2.0', id: 2, result: { tools: [{ name: 42 }, { name: '' }, { name: 'ok' }] },
  }))).toEqual({ answered: true, tools: [{ name: 'ok' }] })
})

test('never throws on garbage input, and reports unanswered rather than guessing', () => {
  expect(readToolsList('')).toEqual({ answered: false, tools: [] })
  expect(readToolsList('not json\n{oops')).toEqual({ answered: false, tools: [] })
  expect(readToolsList('[1,2,3]')).toEqual({ answered: false, tools: [] })
})

test('ignores a reply addressed to a different id, including the handshake\'s own', () => {
  const out = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'a' }] } })
  expect(readToolsList(out)).toEqual({ answered: false, tools: [] })
})

test('the cache key includes scope and projectPath, so two directories never collide', () => {
  expect(toolsCacheKey({ name: 'serena', scope: 'user' })).not.toBe(
    toolsCacheKey({ name: 'serena', scope: 'local', projectPath: '/a' }),
  )
  expect(toolsCacheKey({ name: 'serena', scope: 'local', projectPath: '/a' })).not.toBe(
    toolsCacheKey({ name: 'serena', scope: 'local', projectPath: '/b' }),
  )
})

test('toolsView never carries a command, args or env — only what the wire needs', () => {
  const view = toolsView(
    { name: 'serena', scope: 'user', transport: 'stdio' },
    { reachable: true, tools: [{ name: 'find_symbol' }] },
  )
  expect(view).toEqual({
    name: 'serena', scope: 'user', transport: 'stdio', status: 'ready',
    tools: [{ name: 'find_symbol' }],
  })
  expect(Object.keys(view)).not.toContain('command')
  expect(Object.keys(view)).not.toContain('args')
  expect(Object.keys(view)).not.toContain('config')
})

test('toolsView on a failed probe reports the outcome, and no tools key at all', () => {
  const view = toolsView(
    { name: 'broken', scope: 'user', transport: 'stdio' },
    { reachable: false, outcome: 'exited', exitCode: 1 },
  )
  expect(view).toEqual({
    name: 'broken', scope: 'user', transport: 'stdio', status: 'unreachable', outcome: 'exited', exitCode: 1,
  })
  expect('tools' in view).toBe(false)
})

// ---------------------------------------------------------------------------------------------
// McpToolsCache — the one thing this whole module exists to get right: a failed probe is cached
// as a failure, never quietly reread later as "asked, got zero tools".
// ---------------------------------------------------------------------------------------------

test('a successful probe is served from cache within its TTL, without calling the fetcher again', async () => {
  const cache = new McpToolsCache(1000, 1000)
  let calls = 0
  const fetcher = async (): Promise<McpToolsProbe> => { calls++; return { reachable: true, tools: [{ name: 'a' }] } }
  const first = await cache.get('k', fetcher, 0)
  const second = await cache.get('k', fetcher, 500)
  expect(first).toEqual({ reachable: true, tools: [{ name: 'a' }] })
  expect(second).toEqual({ reachable: true, tools: [{ name: 'a' }] })
  expect(calls).toBe(1)
})

test('a failed probe stays a failure on a cache hit — never becomes a confident zero', async () => {
  const cache = new McpToolsCache(1000, 1000)
  const fetcher = async (): Promise<McpToolsProbe> => ({ reachable: false, outcome: 'timeout' })
  const first = await cache.get('k', fetcher, 0)
  const second = await cache.get('k', fetcher, 500)
  expect(first).toEqual({ reachable: false, outcome: 'timeout' })
  expect(second).toEqual({ reachable: false, outcome: 'timeout' })
  // Never reinterpreted as a reachable server with an empty tool list.
  expect(second).not.toEqual({ reachable: true, tools: [] })
})

test('a failure expires sooner than a success, so a fixed machine is retried without waiting the full window', async () => {
  const cache = new McpToolsCache(10_000, 100)
  let calls = 0
  const fetcher = async (): Promise<McpToolsProbe> => {
    calls++
    return calls === 1 ? { reachable: false, outcome: 'exited' } : { reachable: true, tools: [{ name: 'a' }] }
  }
  const first = await cache.get('k', fetcher, 0)
  expect(first).toEqual({ reachable: false, outcome: 'exited' })
  // Still within the failure TTL: cached failure, no re-fetch.
  const stillCached = await cache.get('k', fetcher, 50)
  expect(stillCached).toEqual({ reachable: false, outcome: 'exited' })
  expect(calls).toBe(1)
  // Past the failure TTL: re-fetches and now gets the real answer.
  const recovered = await cache.get('k', fetcher, 200)
  expect(recovered).toEqual({ reachable: true, tools: [{ name: 'a' }] })
  expect(calls).toBe(2)
})

test('two different keys never share an entry', async () => {
  const cache = new McpToolsCache(1000, 1000)
  const a = await cache.get('a', async () => ({ reachable: true, tools: [{ name: 'x' }] }), 0)
  const b = await cache.get('b', async () => ({ reachable: false, outcome: 'not-found' }), 0)
  expect(a).toEqual({ reachable: true, tools: [{ name: 'x' }] })
  expect(b).toEqual({ reachable: false, outcome: 'not-found' })
})

test('clear() drops every entry, forcing a re-fetch', async () => {
  const cache = new McpToolsCache(10_000, 10_000)
  let calls = 0
  const fetcher = async (): Promise<McpToolsProbe> => { calls++; return { reachable: true, tools: [] } }
  await cache.get('k', fetcher, 0)
  cache.clear()
  await cache.get('k', fetcher, 1)
  expect(calls).toBe(2)
})

test('a server nobody has asked yet is PENDING, which is not offering no tools', () => {
  // The composer opens on a keystroke and cannot wait for a server that spawns through `npx`.
  // Measured: one server answered in 236ms with 19 tools, four others did not answer inside three
  // minutes between them. So the route reports what it knows and says the rest is still being asked.
  const view = toolsView({ name: 'serena', scope: 'user', transport: 'stdio' }, null)
  expect(view.status).toBe('pending')
  expect(view.tools).toBeUndefined()
  expect(view.outcome).toBeUndefined()
})

test('peek returns null and starts exactly one probe per key', async () => {
  const cache = new McpToolsCache()
  let calls = 0
  const fetcher = async (): Promise<McpToolsProbe> => { calls++; return { reachable: true, tools: [] } }
  expect(cache.peek('k', fetcher)).toBeNull()
  expect(cache.peek('k', fetcher)).toBeNull()
  await new Promise(r => setTimeout(r, 10))
  expect(calls).toBe(1)
  // Once it has landed, peek answers without asking again.
  expect(cache.peek('k', fetcher)?.reachable).toBe(true)
  expect(calls).toBe(1)
})
