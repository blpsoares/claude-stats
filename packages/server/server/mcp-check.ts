/**
 * mcp-check.ts — PURE: does a configured MCP server actually answer?
 *
 * ## What this is NOT
 *
 * It is not a connection. agentistics does not run MCP servers — Claude Code does, once, when a
 * session starts. A server "connected" from here would be connected to nothing any assistant can
 * use, and a button offering that would be a lie told in the one place a person goes to find out
 * whether their configuration works.
 *
 * It is a CHECK: start the thing exactly as configured, speak the handshake the protocol opens
 * with, and report what came back. Every outcome is something a reader can act on, and none of them
 * claims the server is now available anywhere.
 *
 * ## Why the panel needed one
 *
 * The MCP tab listed CONFIGURATION and nothing else, so a server that had never worked looked
 * exactly like one that worked perfectly. Measured on the machine this was reported from: `serena`
 * was configured, listed, and had its `--project` still set to the tutorial's placeholder
 * (`/caminho/do/seu/projeto`). It starts, registers its 23 tools, and EXITS in two milliseconds —
 * no error, no warning, nothing on any screen. "Fico no escuro e não sei os que estão disponíveis"
 * is the exact shape of that.
 *
 * `exited` is therefore its own outcome and not folded into a failure: a process that ran and quit
 * is a different thing to fix from one that could not be found.
 */

/** The opening frame of the protocol, as a line of JSON-RPC over stdio. */
export function initializeFrame(): string {
  return `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      // The version this handshake is written against. A server that speaks a different oneanswers
      // with its own, and that is still an answer — see `readInitialize`.
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'agentistics', version: '1' },
    },
  })}\n`
}

export interface McpHandshake {
  /** What the server calls itself, when it says. */
  serverName?: string
  serverVersion?: string
  /** The protocol version IT answered with, which may differ from the one asked for. */
  protocolVersion?: string
}

/**
 * The `initialize` reply, out of whatever the process printed.
 *
 * Scanned LINE BY LINE rather than parsed whole: a server that logs to stdout before answering is
 * common (the one this was written against prints four INFO lines first), and a reader that
 * required the first line to be the response would call every one of those broken.
 *
 * `null` means no line was an `initialize` result. That is not "it failed" — the caller decides
 * that from whether the process is still alive.
 */
export function readInitialize(out: string): McpHandshake | null {
  for (const line of out.split('\n')) {
    const t = line.trim()
    if (t === '' || t[0] !== '{') continue
    let msg: Record<string, unknown>
    try { msg = JSON.parse(t) as Record<string, unknown> } catch { continue }
    if (msg.id !== 1) continue
    const result = msg.result
    if (typeof result !== 'object' || result === null) continue
    const r = result as Record<string, unknown>
    const info = (typeof r.serverInfo === 'object' && r.serverInfo !== null)
      ? r.serverInfo as Record<string, unknown>
      : {}
    return {
      ...(typeof info.name === 'string' ? { serverName: info.name } : {}),
      ...(typeof info.version === 'string' ? { serverVersion: info.version } : {}),
      ...(typeof r.protocolVersion === 'string' ? { protocolVersion: r.protocolVersion } : {}),
    }
  }
  return null
}

/**
 * What a check found. Every one of these sends a reader somewhere different, which is the whole
 * reason there are six of them rather than a boolean.
 */
export type McpCheckOutcome =
  /** It answered the handshake. As close to "this works" as anything here can honestly say. */
  | 'answers'
  /** It ran and quit without answering — a bad flag, a path that does not exist. */
  | 'exited'
  /** The command is not on this machine. */
  | 'not-found'
  /** It stayed up and said nothing within the budget. */
  | 'timeout'
  /** An http/sse/ws server whose endpoint did not respond. */
  | 'unreachable'
  /** Nothing here can check it — no command and no url. */
  | 'uncheckable'

export interface McpCheckResult {
  outcome: McpCheckOutcome
  handshake?: McpHandshake
  /** For `exited`: what it exited with, when that is known. */
  exitCode?: number
  /** For `unreachable` / an http check that answered: the status. */
  status?: number
}

/**
 * The verdict, from what the run produced. Pure so the ordering of these questions is testable —
 * it matters: a process that ANSWERED and then exited is `answers`, because the answer is the
 * thing being asked about. Many stdio servers exit as soon as their input closes, which is exactly
 * what this check does to them.
 */
export function stdioOutcome(input: {
  spawnFailed: boolean
  handshake: McpHandshake | null
  exited: boolean
  exitCode?: number
  timedOut: boolean
}): McpCheckResult {
  if (input.spawnFailed) return { outcome: 'not-found' }
  if (input.handshake) return { outcome: 'answers', handshake: input.handshake }
  if (input.exited) {
    return { outcome: 'exited', ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}) }
  }
  if (input.timedOut) return { outcome: 'timeout' }
  // Neither answered, nor exited, nor ran out of time: nothing observed, and a verdict would be
  // invented. `timeout` is the honest floor — it says "no answer came", which is what happened.
  return { outcome: 'timeout' }
}

/** How long a server gets to say hello. Generous: some load a language server first. */
export const CHECK_TIMEOUT_MS = 12_000

// ---- the run ------------------------------------------------------------------------------------

/**
 * Start the server exactly as configured and see whether it answers.
 *
 * EXACTLY AS CONFIGURED, including its `cwd` for a `local`/`project` scope: a server whose command
 * is relative, or whose `--project .` means something, must be run where Claude Code would run it
 * or the check answers about a different thing than the one being asked about.
 *
 * The env VALUES are not held by this process (`mcp-config.ts` keeps only the names), so a server
 * that needs a secret can legitimately fail here and work for the assistant. That is stated by the
 * caller rather than guessed at here.
 *
 * stdin is CLOSED after the frame: a well-behaved stdio server answers first and exits second, and
 * leaving it open would turn every one of them into a timeout.
 */
export async function checkStdio(
  command: string, args: readonly string[], cwd?: string,
): Promise<McpCheckResult> {
  let proc: Bun.Subprocess<'pipe', 'pipe', 'ignore'>
  try {
    proc = Bun.spawn({
      cmd: [command, ...args],
      stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
      ...(cwd ? { cwd } : {}),
    })
  } catch {
    return stdioOutcome({ spawnFailed: true, handshake: null, exited: true, timedOut: false })
  }

  try {
    proc.stdin.write(initializeFrame())
    proc.stdin.end()
  } catch {
    // It died before it could be written to — the same fact as exiting without answering.
  }

  let timedOut = false
  const out = await Promise.race([
    new Response(proc.stdout).text().catch(() => ''),
    new Promise<string>(r => setTimeout(() => { timedOut = true; r('') }, CHECK_TIMEOUT_MS)),
  ])
  const handshake = readInitialize(out)
  // Never left running: this spawns a process the user did not ask to keep.
  try { proc.kill() } catch { /* already gone */ }
  const exitCode = typeof proc.exitCode === 'number' ? proc.exitCode : undefined
  return stdioOutcome({
    spawnFailed: false, handshake, exited: proc.exitCode !== null,
    ...(exitCode !== undefined ? { exitCode } : {}), timedOut,
  })
}

/**
 * An http/sse/ws server: is the endpoint there?
 *
 * Deliberately NOT a handshake. These transports need a session, headers and often a token this
 * process does not hold — so the honest question is reachability, and `answers` is not claimed for
 * them. Any status at all proves something is listening; 404 and 401 both mean "reached".
 */
export async function checkUrl(url: string): Promise<McpCheckResult> {
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { accept: 'text/event-stream, application/json' },
    })
    return { outcome: 'answers', status: res.status }
  } catch {
    return { outcome: 'unreachable' }
  }
}
