/**
 * mcp-status.ts — PURE: what can HONESTLY be said about whether an MCP server is up.
 *
 * The ask was "listar todos os MCPs com STATUS REAL: rodando / configurado / offline", with the
 * rule beside it: "Status que não pode ser medido é dito em palavras, nunca um 'offline'
 * confiante." So the states here are exactly the ones this machine can establish, and the word
 * "offline" is deliberately not among them.
 *
 * - `running`  — a process ON THIS MACHINE is running exactly this server's command. Measured, not
 *   inferred: an MCP server's process carries its configured argv verbatim (verified on a live
 *   machine — `npx -y mongodb-mcp-server@2.1.0 --readOnly` and `bun run …/agentistics-mcp.ts` both
 *   appear in `/proc` exactly as configured), so the match is an exact contiguous argv sequence
 *   rather than a fuzzy name test that would report a neighbouring process as this one.
 * - `idle`     — we could look, and nothing is running it. This is the NORMAL state and is why
 *   "offline" would be a lie: a stdio MCP server exists only while a session that uses it runs, so
 *   nothing running it means nobody is using it right now, not that it is broken.
 * - `remote`   — an http/sse/ws server runs somewhere else entirely. There is no local process to
 *   look for, and probing the URL would be this machine making a request to a third party to
 *   populate a status column. Said in words instead.
 * - `unrunnable` — the config names no command at all. A fact about the CONFIG, kept apart from
 *   `idle`, which would blame the machine for it.
 * - `unknown`  — we could not look at all, with the reason: not Linux, no `/proc`, a container that
 *   cannot see the host, or one whose uid cannot read it. Same `LiveUnavailableReason` the live
 *   sessions panel reports, for the same reason and in the same words.
 */

import type { LiveUnavailableReason } from '@agentistics/core'
import type { McpServer } from './mcp-config'

export type McpRunState =
  | { state: 'running'; pids: number[] }
  | { state: 'idle' }
  | { state: 'remote' }
  /** The config names no command, so nothing on any machine can run it. */
  | { state: 'unrunnable' }
  | { state: 'unknown'; reason: LiveUnavailableReason }

/** One process, as much of it as this module reads. */
export interface ProcArgv {
  pid: number
  argv: readonly string[]
}

/** Is `needle` a contiguous run inside `hay`? */
function containsSequence(hay: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let all = true
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) { all = false; break }
    }
    if (all) return true
  }
  return false
}

/**
 * What this server is doing, given every process this machine could see.
 *
 * `unavailable` is passed through FIRST: with no visibility, every other answer would be a claim
 * about a machine we could not look at.
 */
export function mcpRunState(
  server: McpServer,
  procs: readonly ProcArgv[],
  unavailable: LiveUnavailableReason | null,
): McpRunState {
  if (server.transport !== 'stdio') return { state: 'remote' }
  if (unavailable) return { state: 'unknown', reason: unavailable }
  // A stdio server with no command cannot be run by anything, so it cannot be matched either. That
  // is a fact about the CONFIG, and `idle` would blame the machine for it.
  if (!server.command) return { state: 'unrunnable' }
  const needle = [server.command, ...(server.args ?? [])]
  const pids = procs.filter(p => containsSequence(p.argv, needle)).map(p => p.pid)
  return pids.length > 0 ? { state: 'running', pids } : { state: 'idle' }
}
