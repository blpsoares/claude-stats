import { test, expect } from 'bun:test'
import { initializeFrame, readInitialize, stdioOutcome } from './mcp-check'

test('the handshake is one line of JSON-RPC, named and versioned', () => {
  const f = initializeFrame()
  expect(f.endsWith('\n')).toBe(true)
  const m = JSON.parse(f.trim())
  expect(m.method).toBe('initialize')
  expect(m.id).toBe(1)
  expect(m.params.clientInfo.name).toBe('agentistics')
})

/**
 * A server that logs to stdout before answering is the COMMON case, not the exception — the one
 * this was written against prints four INFO lines first. A reader that required the first line to
 * be the response would call every such server broken.
 */
test('finds the reply after whatever the server logged first', () => {
  const out = [
    'INFO 2026-09-07 serena.cli:start_mcp_server - Starting MCP server …',
    'warnings.warn(',
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'serena', version: '0.1' } } }),
  ].join('\n')
  expect(readInitialize(out)).toEqual({
    serverName: 'serena', serverVersion: '0.1', protocolVersion: '2024-11-05',
  })
})

test('ignores every message that is not the answer to OUR id', () => {
  const out = [
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 7, result: { serverInfo: { name: 'other' } } }),
  ].join('\n')
  expect(readInitialize(out)).toBe(null)
})

test('an error reply is not a handshake', () => {
  const out = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } })
  expect(readInitialize(out)).toBe(null)
})

test('a server that answers a DIFFERENT protocol version still answered', () => {
  const out = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } })
  expect(readInitialize(out)).toEqual({ protocolVersion: '2025-06-18' })
})

test('says nothing about noise, and never throws on it', () => {
  expect(readInitialize('')).toBe(null)
  expect(readInitialize('not json\n{oops')).toBe(null)
  expect(readInitialize('[1,2,3]')).toBe(null)
})

/**
 * THE ORDER OF THESE QUESTIONS IS THE POINT. Many stdio servers exit as soon as their input
 * closes — which is exactly what this check does to them — so a process that ANSWERED and then
 * exited is `answers`. The answer is the thing being asked about.
 */
test('an answer outranks the exit that follows it', () => {
  expect(stdioOutcome({
    spawnFailed: false, handshake: { serverName: 's' }, exited: true, exitCode: 0, timedOut: false,
  })).toEqual({ outcome: 'answers', handshake: { serverName: 's' } })
})

/**
 * The measured case: `serena` with the tutorial's placeholder path starts, registers its tools and
 * quits in two milliseconds — no error anywhere. It is its OWN outcome, because "ran and quit" and
 * "could not be found" are fixed in two different places.
 */
test('ran and quit without answering is `exited`, and carries the code', () => {
  expect(stdioOutcome({ spawnFailed: false, handshake: null, exited: true, exitCode: 0, timedOut: false }))
    .toEqual({ outcome: 'exited', exitCode: 0 })
})

test('a command that is not on the machine is `not-found`, before anything else', () => {
  expect(stdioOutcome({ spawnFailed: true, handshake: null, exited: true, timedOut: true }))
    .toEqual({ outcome: 'not-found' })
})

test('alive and silent is a timeout, and so is observing nothing at all', () => {
  expect(stdioOutcome({ spawnFailed: false, handshake: null, exited: false, timedOut: true }))
    .toEqual({ outcome: 'timeout' })
  // Nothing observed: a verdict would be invented, so it says the honest thing — no answer came.
  expect(stdioOutcome({ spawnFailed: false, handshake: null, exited: false, timedOut: false }))
    .toEqual({ outcome: 'timeout' })
})
