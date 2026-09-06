import { describe, expect, it } from 'bun:test'
import { mcpRunState } from './mcp-status'
import type { McpServer } from './mcp-config'

const stdio = (over: Partial<McpServer> = {}): McpServer => ({
  name: 'MongoDB', scope: 'user', transport: 'stdio', config: '{}',
  command: 'npx', args: ['-y', 'mongodb-mcp-server@2.1.0', '--readOnly'], ...over,
})

describe('mcpRunState — measured, and never a confident "offline"', () => {
  it('matches a process running exactly this command', () => {
    // Verified on a live machine: an MCP server's process carries its configured argv verbatim.
    const procs = [{ pid: 296574, argv: ['npx', '-y', 'mongodb-mcp-server@2.1.0', '--readOnly'] }]
    expect(mcpRunState(stdio(), procs, null)).toEqual({ state: 'running', pids: [296574] })
  })

  it('matches the sequence inside a wrapper’s argv, and nothing looser', () => {
    expect(mcpRunState(stdio({ command: 'bun', args: ['run', '/a/b.ts'] }),
      [{ pid: 1, argv: ['/usr/bin/env', 'bun', 'run', '/a/b.ts'] }], null).state).toBe('running')
    // A neighbouring process that merely mentions the package is NOT this server.
    expect(mcpRunState(stdio(), [{ pid: 2, argv: ['npm', 'exec', 'mongodb-mcp-server@2.1.0'] }], null).state).toBe('idle')
  })

  it('calls "nothing is running it" IDLE, never offline', () => {
    // A stdio MCP server exists only while a session that uses it runs, so nothing running it means
    // nobody is using it right now — not that it is broken.
    expect(mcpRunState(stdio(), [], null)).toEqual({ state: 'idle' })
  })

  it('says a remote server runs somewhere else rather than probing a third party', () => {
    expect(mcpRunState(stdio({ transport: 'http', url: 'https://x' }), [], null)).toEqual({ state: 'remote' })
  })

  it('says UNKNOWN, with the reason, when it could not look at all', () => {
    expect(mcpRunState(stdio(), [], 'not-linux')).toEqual({ state: 'unknown', reason: 'not-linux' })
    expect(mcpRunState(stdio(), [], 'container-isolated').state).toBe('unknown')
  })

  it('never claims to have looked when it could not — visibility outranks every other answer', () => {
    const procs = [{ pid: 1, argv: ['npx', '-y', 'mongodb-mcp-server@2.1.0', '--readOnly'] }]
    expect(mcpRunState(stdio(), procs, 'permission-denied').state).toBe('unknown')
  })

  it('blames the CONFIG, not the machine, for a server with no command', () => {
    expect(mcpRunState(stdio({ command: undefined }), [], null)).toEqual({ state: 'unrunnable' })
  })
})
