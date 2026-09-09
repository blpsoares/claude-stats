/**
 * mcp-tools.ts — what tools does a configured MCP server actually offer?
 *
 * ## Why this needs its own question
 *
 * `mcp-check.ts` answers "does this server answer at all?" by speaking `initialize` and stopping.
 * That is enough to tell a person their configuration works, but it is not enough for the web
 * composer's `@<server>` / `@<server>:<tool>` references — those need the server's TOOL NAMES, and
 * `initialize`'s reply carries none. The next line of the protocol, `tools/list`, does.
 *
 * This module never reimplements the handshake: it imports `initializeFrame` / `readInitialize` /
 * `stdioOutcome` / `CHECK_TIMEOUT_MS` from `mcp-check.ts` and extends the same one-shot exchange
 * with two more pipelined frames. A server that cannot even say hello is exactly as unreachable for
 * this question as it is for that one, and the two must never disagree about it.
 *
 * ## Never a confident zero
 *
 * A server that could not be reached has an UNKNOWN tool list, not an empty one. `McpToolsProbe`
 * therefore has two shapes rather than a `tools: []` default, and the cache stores whichever shape
 * the probe actually returned — a failed spawn is remembered as a failure, never quietly reread as
 * "a server with nothing to offer". Composer autocomplete is the one caller of this module today,
 * and an empty menu reads to a person exactly like "this server has no tools" — the one sentence
 * this file may never say by accident.
 */

import { CHECK_TIMEOUT_MS, initializeFrame, readInitialize, stdioOutcome, type McpCheckOutcome } from './mcp-check'
import type { McpScope, McpServer, McpTransport } from './mcp-config'

/** One tool, as `tools/list` names it. */
export interface McpToolInfo {
  name: string
  description?: string
}

/**
 * The `tools/list` request frame, as a line of JSON-RPC over stdio. `id: 2` — `initialize` is
 * always `id: 1` — so a reply can be told apart from the handshake's even when both arrive in one
 * captured chunk of stdout.
 */
export function toolsListFrame(): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`
}

/**
 * The notification the protocol expects between `initialize`'s reply and any other request. Sent
 * unconditionally, pipelined right after `initializeFrame()` — see `fetchStdioTools` for why
 * waiting for the actual reply first is not needed here.
 */
export function initializedNotification(): string {
  return `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
}

/**
 * What `tools/list`'s reply said, out of whatever the process printed.
 *
 * `answered` is the fact this file is built around: it is `true` the moment a line addresses OUR
 * request (`id: 2`), success or error, and `false` when nothing ever did. That is what lets the
 * caller tell "the server said hello and truly has no tools" (`answered: true, tools: []`) apart
 * from "the server never got this far" (`answered: false`) — a single `McpToolInfo[]` return could
 * not carry that difference, and losing it is exactly the confident-zero bug this module exists to
 * avoid.
 *
 * Total: unparseable JSON, a non-object result, a non-array `tools`, or a tool with a non-string
 * name are all read as "nothing usable here" rather than thrown on — mirroring `readInitialize`'s
 * own line-by-line scan, including scanning past noise the server logged first.
 */
export function readToolsList(out: string): { answered: boolean; tools: McpToolInfo[] } {
  for (const line of out.split('\n')) {
    const t = line.trim()
    if (t === '' || t[0] !== '{') continue
    let msg: Record<string, unknown>
    try { msg = JSON.parse(t) as Record<string, unknown> } catch { continue }
    if (msg.id !== 2) continue

    const result = msg.result
    if (typeof result !== 'object' || result === null) return { answered: true, tools: [] }
    const tools = (result as Record<string, unknown>).tools
    if (!Array.isArray(tools)) return { answered: true, tools: [] }

    const list: McpToolInfo[] = []
    for (const item of tools) {
      if (typeof item !== 'object' || item === null) continue
      const rec = item as Record<string, unknown>
      if (typeof rec.name !== 'string' || rec.name === '') continue
      list.push({
        name: rec.name,
        ...(typeof rec.description === 'string' && rec.description !== '' ? { description: rec.description } : {}),
      })
    }
    return { answered: true, tools: list }
  }
  return { answered: false, tools: [] }
}

/** What asking one server for its tools found. Two shapes on purpose — see the header comment. */
export type McpToolsProbe =
  | { reachable: true; tools: McpToolInfo[] }
  | { reachable: false; outcome: McpCheckOutcome; exitCode?: number }

/**
 * Start the server exactly as configured, speak `initialize` + the `initialized` notification +
 * `tools/list`, and report what came back.
 *
 * All three frames are written and stdin is closed BEFORE reading anything back — stdio is FIFO,
 * so a well-behaved server processes them in the order they were sent regardless of when it
 * chooses to answer the first one. This is deliberately the same shape `checkStdio` uses (write,
 * close stdin, read until EOF or the timeout), extended by two more frames, rather than a
 * request/reply-per-turn protocol client: the latter would duplicate `checkStdio`'s process
 * lifecycle handling for no capability this question needs.
 *
 * The `initialize` half of the read is judged by `stdioOutcome` — the EXACT function
 * `/api/mcp/check` judges it by — so a server this reports as unreachable is unreachable by the
 * same standard the check panel already uses. Only once that judges `answers` does a missing
 * `tools/list` reply become this function's own concern.
 */
export async function fetchStdioTools(
  command: string, args: readonly string[], cwd?: string,
): Promise<McpToolsProbe> {
  let proc: Bun.Subprocess<'pipe', 'pipe', 'ignore'>
  try {
    proc = Bun.spawn({
      cmd: [command, ...args],
      stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
      ...(cwd ? { cwd } : {}),
    })
  } catch {
    return { reachable: false, outcome: 'not-found' }
  }

  try {
    proc.stdin.write(initializeFrame())
    proc.stdin.write(initializedNotification())
    proc.stdin.write(toolsListFrame())
    proc.stdin.end()
  } catch {
  }

  let timedOut = false
  const out = await Promise.race([
    new Response(proc.stdout).text().catch(() => ''),
    new Promise<string>(r => setTimeout(() => { timedOut = true; r('') }, CHECK_TIMEOUT_MS)),
  ])
  // The LOSING side of that race keeps reading — a `tools/list` timeout is exactly the case where
  // the server never closed its own stdout, so without this the process (measured: a real
  // `mongodb-mcp-server` left running for minutes, one per failed probe on every cache-failure-TTL
  // retry) outlives the request that spawned it. `checkStdio` gets away without this because its
  // callers so far have all been servers that answer or exit quickly; this one is asked on every
  // composer keystroke and a slow server is the exact case that must not leak.
  try { proc.kill() } catch {
  }

  const handshake = readInitialize(out)
  const exitCode = typeof proc.exitCode === 'number' ? proc.exitCode : undefined
  const check = stdioOutcome({
    spawnFailed: false, handshake, exited: proc.exitCode !== null,
    ...(exitCode !== undefined ? { exitCode } : {}), timedOut,
  })
  if (check.outcome !== 'answers') {
    return {
      reachable: false, outcome: check.outcome,
      ...(check.exitCode !== undefined ? { exitCode: check.exitCode } : {}),
    }
  }

  const reply = readToolsList(out)
  if (reply.answered) return { reachable: true, tools: reply.tools }

  // It said hello and then never answered `tools/list` — hung, crashed mid-reply, or silently
  // ignores a capability it never declared. Reported the same way an unanswered `initialize` is:
  // a fact about THIS run, never a cached "zero tools".
  return {
    reachable: false, outcome: timedOut ? 'timeout' : 'exited',
    ...(exitCode !== undefined ? { exitCode } : {}),
  }
}

/**
 * One server, whichever transport it uses.
 *
 * http/sse/ws are reported `uncheckable`, the same code `mcp-check.ts` uses for a server with
 * neither a command nor a url: those transports need a session and headers this process holds no
 * client for (see `checkUrl`'s own comment — it answers reachability only, never a handshake), and
 * listing tools needs the handshake. That is a statement about what THIS PROCESS can ask, never a
 * claim that the server has no tools.
 */
export async function fetchServerTools(
  server: Pick<McpServer, 'command' | 'args' | 'projectPath' | 'url'>,
): Promise<McpToolsProbe> {
  if (server.command) return fetchStdioTools(server.command, server.args ?? [], server.projectPath)
  return { reachable: false, outcome: 'uncheckable' }
}

/** How long a real answer is kept, and how long a failure is — see `McpToolsCache`'s own comment. */
export const TOOLS_CACHE_TTL_MS = 5 * 60_000
export const TOOLS_FAILURE_TTL_MS = 30_000

interface CacheEntry {
  probe: McpToolsProbe
  expiresAt: number
}

/**
 * Per-server memo for `fetchServerTools`.
 *
 * The composer can open on every keystroke, and spawning a language-server-backed MCP server (the
 * one this repo has measured takes noticeably long to answer even a bare `initialize`) on every one
 * of them would be its own outage — hence a cache at all. But a FAILED probe is kept for a much
 * shorter window than a real answer (`TOOLS_FAILURE_TTL_MS` vs `TOOLS_CACHE_TTL_MS`), and it is
 * kept as a FAILURE: `probe.reachable` on a cache hit is exactly what it was on the miss that filled
 * it. A cache that quietly turned "could not ask" into "asked, got nothing" the moment it got old
 * enough would be the exact bug this module was written to not have.
 */
export class McpToolsCache {
  private readonly entries = new Map<string, CacheEntry>()

  constructor(
    private readonly successTtlMs: number = TOOLS_CACHE_TTL_MS,
    private readonly failureTtlMs: number = TOOLS_FAILURE_TTL_MS,
  ) {
  }

  async get(key: string, fetcher: () => Promise<McpToolsProbe>, now: number = Date.now()): Promise<McpToolsProbe> {
    const cached = this.entries.get(key)
    if (cached && cached.expiresAt > now) return cached.probe
    const probe = await this.run(key, fetcher, now)
    return probe
  }

  /**
   * WHAT IS KNOWN RIGHT NOW, WITHOUT WAITING — and a probe started for what is not.
   *
   * `get` blocks until the server answers, which is right for a health check somebody pressed and
   * wrong for the composer. Measured on one machine's five configured servers: the one that runs
   * from `bun` answered in 236ms with 19 tools, and the other four — three spawned through `npx`,
   * one an HTTP/SSE endpoint — did not answer inside three minutes between them. A composer that
   * opens on a keystroke cannot await that, and `@` does not need to: the server NAMES come from
   * the config and are known instantly. Only the tool list behind `:` needs the probe.
   *
   * So this returns the cached answer or `null`, and starts the fetch that will fill it. The caller
   * says "not asked yet" rather than "no tools", and the next open has the answer.
   */
  peek(key: string, fetcher: () => Promise<McpToolsProbe>, now: number = Date.now()): McpToolsProbe | null {
    const cached = this.entries.get(key)
    if (cached && cached.expiresAt > now) return cached.probe
    if (!this.inFlight.has(key)) {
      // Never awaited, and never allowed to reject into a caller that has already returned.
      const run = this.run(key, fetcher, now).catch(() => undefined).finally(() => this.inFlight.delete(key))
      this.inFlight.set(key, run)
    }
    return null
  }

  private readonly inFlight = new Map<string, Promise<unknown>>()

  private async run(key: string, fetcher: () => Promise<McpToolsProbe>, now: number): Promise<McpToolsProbe> {
    const probe = await fetcher()
    const ttl = probe.reachable ? this.successTtlMs : this.failureTtlMs
    this.entries.set(key, { probe, expiresAt: now + ttl })
    return probe
  }

  /** Tests only, and a config write that might make a previously-unreachable server answer now. */
  clear(): void {
    this.entries.clear()
  }
}

const defaultCache = new McpToolsCache()

/**
 * The cache key for one configured server. `scope` + `projectPath` are part of it because the same
 * NAME can be configured differently in `local` vs `project` vs `user` scope, or for two different
 * directories' `local` scope — `mcp-check.ts`'s own `/api/mcp/check` route looks a server up by
 * name AND scope for the same reason.
 */
export function toolsCacheKey(server: Pick<McpServer, 'name' | 'scope' | 'projectPath'>): string {
  return `${server.scope}:${server.projectPath ?? ''}:${server.name}`
}

/**
 * What is already known about a server's tools, without waiting for it to answer.
 *
 * `null` means NOT ASKED YET, which is a third thing beside "reachable with these tools" and
 * "unreachable for this reason" — and the composer must say so rather than showing an empty list.
 * A probe is started, so the next call has the answer.
 */
export function peekServerTools(
  server: Pick<McpServer, 'name' | 'scope' | 'projectPath' | 'command' | 'args' | 'url'>,
  cache: McpToolsCache = defaultCache,
): McpToolsProbe | null {
  return cache.peek(toolsCacheKey(server), () => fetchServerTools(server))
}

/** `fetchServerTools`, memoized. The default cache is process-wide; tests pass their own. */
export async function getServerTools(
  server: Pick<McpServer, 'name' | 'scope' | 'projectPath' | 'command' | 'args' | 'url'>,
  cache: McpToolsCache = defaultCache,
): Promise<McpToolsProbe> {
  return cache.get(toolsCacheKey(server), () => fetchServerTools(server))
}

/** Tests only. */
export function resetMcpToolsCache(): void {
  defaultCache.clear()
}

/** What the route hands back for one server — never the server's command, args, or env. */
export interface McpServerToolsView {
  name: string
  scope: McpScope
  transport: McpTransport
  /**
   * THREE STATES, not two. `'pending'` is "nobody has asked this server yet", and it is a different
   * fact from "asked, and it offers nothing" — the composer must say so rather than draw an empty
   * list. The server names are known from the config either way, so `@` works immediately and only
   * the tool list behind `:` waits.
   */
  status: 'ready' | 'unreachable' | 'pending'
  tools?: McpToolInfo[]
  outcome?: McpCheckOutcome
  exitCode?: number
}

/**
 * A server plus its probe, shaped for the wire. Deliberately narrow: no `command`, `args`, `envKeys`
 * or `config` — this route answers "what tools", not "how is it configured", and `mcp-config.ts`'s
 * own env-stripping rule exists precisely because a value from that configuration must never cross
 * this boundary.
 */
export function toolsView(
  server: Pick<McpServer, 'name' | 'scope' | 'transport'>,
  probe: McpToolsProbe | null,
): McpServerToolsView {
  const base = { name: server.name, scope: server.scope, transport: server.transport }
  // `null` is the probe that has not come back yet — see `McpServerToolsView.status`.
  if (probe === null) return { ...base, status: 'pending' }
  if (probe.reachable) return { ...base, status: 'ready', tools: probe.tools }
  return {
    ...base, status: 'unreachable',
    outcome: probe.outcome,
    ...(probe.exitCode !== undefined ? { exitCode: probe.exitCode } : {}),
  }
}
