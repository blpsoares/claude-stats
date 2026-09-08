import { describe, expect, it } from 'bun:test'
import {
  mcpAddArgs, mcpRemoveArgs, mergeScopes, parseMcpPaste, scopeNeedsProject,
  serversFromClaudeJson, serversFromMcpJson, validMcpName, type McpServer,
} from './mcp-config'

describe('reading the scopes that actually exist', () => {
  const doc = {
    numStartups: 12,
    mcpServers: {
      MongoDB: { command: 'npx', args: ['-y', 'mongodb-mcp-server@2.1.0'], env: { MDB_MCP_CONNECTION_STRING: 'mongodb://user:pw@host/db' } },
      notion: { type: 'http', url: 'https://mcp.notion.com/sse' },
    },
    projects: {
      '/home/p/agentistics': { mcpServers: { playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@0.0.79'] } } },
      '/home/p/other': { mcpServers: { elsewhere: { command: 'x' } } },
    },
  }

  it('reads user scope, and a project’s LOCAL scope when one is asked for', () => {
    // Both were invisible: the old reader looked in ~/.claude/settings.json, which has no
    // `mcpServers` key at all, and in <project>/.claude/settings.json, which does not either.
    const all = serversFromClaudeJson(doc, '/home/p/agentistics')
    expect(all.map(s => `${s.scope}:${s.name}`).sort())
      .toEqual(['local:playwright', 'user:MongoDB', 'user:notion'])
  })

  it('never lists another directory’s local servers', () => {
    const all = serversFromClaudeJson(doc, '/home/p/agentistics')
    expect(all.find(s => s.name === 'elsewhere')).toBeUndefined()
  })

  it('reports env VARIABLE NAMES and never their values', () => {
    // One configured server here holds a database URI with credentials in it.
    const mongo = serversFromClaudeJson(doc).find(s => s.name === 'MongoDB')!
    expect(mongo.envKeys).toEqual(['MDB_MCP_CONNECTION_STRING'])
    expect(JSON.stringify(mongo)).not.toContain('mongodb://')
  })

  it('shows the CONFIG for reading and editing, with the env values stripped out of it', () => {
    // The panel shows what is actually configured; a value that crosses this boundary is on a
    // screen and in a response body forever. The KEY is kept, so an edit can see it and set it.
    const mongo = serversFromClaudeJson(doc).find(s => s.name === 'MongoDB')!
    expect(mongo.config).toContain('mongodb-mcp-server@2.1.0')
    expect(mongo.config).toContain('MDB_MCP_CONNECTION_STRING')
    expect(mongo.config).not.toContain('user:pw')
    expect(JSON.parse(mongo.config).env).toEqual({ MDB_MCP_CONNECTION_STRING: '' })
  })

  it('leaves a server with no env alone', () => {
    const s = serversFromMcpJson({ mcpServers: { plain: { command: 'x', args: ['-y'] } } }, '/repo')
    expect(JSON.parse(s[0]!.config)).toEqual({ command: 'x', args: ['-y'] })
  })

  it('tells a stdio server from a remote one, with or without a `type`', () => {
    const all = serversFromClaudeJson(doc)
    expect(all.find(s => s.name === 'MongoDB')?.transport).toBe('stdio')
    expect(all.find(s => s.name === 'notion')?.transport).toBe('http')
  })

  it('reads <repo>/.mcp.json as the PROJECT scope', () => {
    const s = serversFromMcpJson({ mcpServers: { shared: { command: 'x' } } }, '/repo')
    expect(s).toEqual([{
      name: 'shared', scope: 'project', transport: 'stdio', command: 'x', projectPath: '/repo',
      config: '{\n  "command": "x"\n}',
    }])
  })

  it('survives junk rather than throwing', () => {
    expect(serversFromClaudeJson(null)).toEqual([])
    expect(serversFromClaudeJson({ mcpServers: [] })).toEqual([])
    expect(serversFromMcpJson('nope', '/repo')).toEqual([])
  })
})

describe('mergeScopes — the definition that WINS is the one listed', () => {
  const s = (name: string, scope: McpServer['scope']): McpServer =>
    ({ name, scope, transport: 'stdio', command: 'x', config: '{}' })

  it('keeps the narrowest scope for a name', () => {
    // Claude Code resolves local → project → user, so listing all three would show configurations
    // that are not in effect while implying they are.
    expect(mergeScopes([s('a', 'user'), s('a', 'local'), s('a', 'project')])).toEqual([s('a', 'local')])
    expect(mergeScopes([s('a', 'user'), s('a', 'project')])).toEqual([s('a', 'project')])
  })

  it('keeps different names apart, in name order', () => {
    expect(mergeScopes([s('b', 'user'), s('a', 'user')]).map(x => x.name)).toEqual(['a', 'b'])
  })
})

describe('parseMcpPaste — three shapes, and a refusal for anything else', () => {
  it('takes the whole config block people copy from a README', () => {
    const r = parseMcpPaste('{"mcpServers":{"sentry":{"type":"http","url":"https://x"}}}')
    expect(r).toEqual({ ok: true, servers: [{ name: 'sentry', json: '{"type":"http","url":"https://x"}' }] })
  })

  it('takes one named entry', () => {
    const r = parseMcpPaste('{"sentry":{"command":"npx"}}')
    expect(r.ok && r.servers[0]!.name).toBe('sentry')
  })

  it('takes a bare config when a name is supplied, and refuses one without', () => {
    expect(parseMcpPaste('{"command":"npx"}', 'mine').ok).toBe(true)
    // Reading a bare config as a map of names would produce a server called `command`.
    expect(parseMcpPaste('{"command":"npx"}')).toEqual({ ok: false, reason: 'bad-name' })
  })

  it('takes several at once', () => {
    const r = parseMcpPaste('{"mcpServers":{"a":{"command":"x"},"b":{"url":"https://y"}}}')
    expect(r.ok && r.servers.map(s => s.name)).toEqual(['a', 'b'])
  })

  it('REFUSES rather than repairs, with the reason', () => {
    expect(parseMcpPaste('not json')).toEqual({ ok: false, reason: 'not-json' })
    expect(parseMcpPaste('[]')).toEqual({ ok: false, reason: 'not-an-object' })
    expect(parseMcpPaste('{}')).toEqual({ ok: false, reason: 'no-servers' })
    expect(parseMcpPaste('{"a":{"nope":1}}')).toEqual({ ok: false, reason: 'bad-entry' })
    expect(parseMcpPaste('{"a\\nb":{"command":"x"}}')).toEqual({ ok: false, reason: 'bad-name' })
  })

  it('refuses a name the CLI would read as something else', () => {
    expect(validMcpName('-s')).toBe(false)
    expect(validMcpName('a b')).toBe(true)
    expect(validMcpName('')).toBe(false)
    expect(validMcpName('x'.repeat(200))).toBe(false)
  })
})

describe('the commands — read from the tool’s own --help, never guessed', () => {
  it('adds with add-json, so a paste is never taken apart and put back together', () => {
    expect(mcpAddArgs({ name: 'sentry', json: '{"url":"https://x"}' }, 'user'))
      .toEqual(['mcp', 'add-json', 'sentry', '{"url":"https://x"}', '-s', 'user'])
  })

  it('removes the EXACT inverse — same name, same scope', () => {
    expect(mcpRemoveArgs('sentry', 'project')).toEqual(['mcp', 'remove', 'sentry', '-s', 'project'])
  })

  it('knows which scopes are resolved against a directory', () => {
    // Running one of these in the wrong directory silently configures the wrong project.
    expect(scopeNeedsProject('user')).toBe(false)
    expect(scopeNeedsProject('local')).toBe(true)
    expect(scopeNeedsProject('project')).toBe(true)
  })
})
