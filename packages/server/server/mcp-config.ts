/**
 * mcp-config.ts — PURE: where an MCP server is configured, what shape it has, and the exact
 * commands that add or remove one.
 *
 * ## Three scopes, and they are the user's choice
 *
 * Claude Code keeps MCP servers in three places, and which one a server belongs in is a decision
 * about REACH, not a detail:
 *
 *   user     ~/.claude.json → mcpServers                    every project on this machine
 *   local    ~/.claude.json → projects[<cwd>].mcpServers    this directory, this machine only
 *   project  <repo>/.mcp.json → mcpServers                  this repository, shared with the team
 *
 * The reader used to look in `~/.claude/settings.json` and `<project>/.claude/settings.json`, and
 * neither holds MCP servers at all — measured on this machine, `~/.claude/settings.json` has no
 * `mcpServers` key, while `~/.claude.json` has five under `mcpServers` and more under 92 project
 * entries. So the two scopes that matter were invisible and two that do not exist were read.
 *
 * ## WHY THE WRITES ARE THE HARNESS'S OWN COMMAND
 *
 * `~/.claude.json` is rewritten by every running `claude` — it carries `numStartups`, `lastCost`,
 * per-project state — so a read-modify-write from here would either lose our bytes or clobber
 * theirs. That is the same reason `rename-spec.ts` refuses to write the harness's session file and
 * types `/rename` instead. So an install is `claude mcp add-json <name> <json> -s <scope>` and a
 * removal is `claude mcp remove <name> -s <scope>`, both read from the tool's own `--help` and
 * never guessed, run with the repository as the CWD when the scope is a per-directory one.
 *
 * That also gives the CLAUDE.md guarantees for free and by construction: the merge preserves every
 * key we did not write because the owner performs it, a document it cannot merge is refused by the
 * owner rather than repaired by us, adding twice changes nothing, and the removal is the exact
 * inverse of the addition — the same name in the same scope. Where the `claude` CLI is not
 * installed the action is REFUSED in a sentence, never approximated by writing the file ourselves.
 */

/** Where a server is configured — and how far it reaches. */
export type McpScope = 'user' | 'local' | 'project'

/** How the client talks to the server. `stdio` is a process here; the rest run somewhere else. */
export type McpTransport = 'stdio' | 'http' | 'sse' | 'ws'

export interface McpServer {
  name: string
  scope: McpScope
  transport: McpTransport
  /** stdio only: the command and its arguments, exactly as configured. */
  command?: string
  args?: string[]
  /** stdio only: the NAMES of the environment variables set for it — never their values. */
  envKeys?: string[]
  /** http/sse/ws only. */
  url?: string
  /** The directory a `local` or `project` server belongs to. */
  projectPath?: string
  /**
   * The server's own configuration, as JSON, WITH EVERY ENV VALUE REMOVED.
   *
   * The panel shows it so a person can read and edit what is actually configured — asked for
   * directly. The values are stripped for the same reason `envKeys` exists: one server configured
   * here holds a database URI with credentials in it, and a value that crosses this boundary is on
   * a screen and in a response body forever. The KEYS are kept with empty strings, so an edit
   * shows which variables exist and can set them, and `claude mcp add-json` receives whatever the
   * person actually typed.
   */
  config: string
}

/**
 * The env is reported as KEY NAMES ONLY.
 *
 * Measured: one configured server here holds `MDB_MCP_CONNECTION_STRING`, which is a database URI
 * with credentials in it. The panel needs to say a variable is set; nothing needs its value, and a
 * value that crosses this boundary is on a screen and in a response body forever.
 */
function envKeysOf(v: unknown): string[] | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const keys = Object.keys(v as Record<string, unknown>)
  return keys.length > 0 ? keys : undefined
}

function transportOf(cfg: Record<string, unknown>): McpTransport {
  const t = typeof cfg.type === 'string' ? cfg.type.toLowerCase() : ''
  if (t === 'http' || t === 'sse' || t === 'ws') return t
  if (t === 'stdio') return 'stdio'
  // No `type` at all is the older shape, and a `url` is what tells the two apart.
  return typeof cfg.url === 'string' && cfg.url !== '' ? 'http' : 'stdio'
}

/** One `mcpServers` map → the servers in it. Anything unparseable is skipped, never thrown on. */
export function serversFromMap(
  map: unknown, scope: McpScope, projectPath?: string,
): McpServer[] {
  if (typeof map !== 'object' || map === null || Array.isArray(map)) return []
  const out: McpServer[] = []
  for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
    if (name === '' || typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const cfg = raw as Record<string, unknown>
    const transport = transportOf(cfg)
    const args = Array.isArray(cfg.args)
      ? (cfg.args as unknown[]).filter((a): a is string => typeof a === 'string')
      : undefined
    // Env VALUES are dropped, KEYS kept — see `McpServer.config`.
    const shown: Record<string, unknown> = { ...cfg }
    if (envKeysOf(cfg.env)) {
      shown.env = Object.fromEntries(envKeysOf(cfg.env)!.map(k => [k, '']))
    }
    out.push({
      name,
      scope,
      transport,
      config: JSON.stringify(shown, null, 2),
      ...(typeof cfg.command === 'string' ? { command: cfg.command } : {}),
      ...(args && args.length > 0 ? { args } : {}),
      ...(envKeysOf(cfg.env) ? { envKeys: envKeysOf(cfg.env)! } : {}),
      ...(typeof cfg.url === 'string' ? { url: cfg.url } : {}),
      ...(projectPath ? { projectPath } : {}),
    })
  }
  return out
}

/**
 * `~/.claude.json` → the `user` servers and the `local` servers of one directory.
 *
 * Only the directory asked for: the file holds 92 project entries here, and listing every
 * machine-local server of every project a person ever opened is not what a panel about THIS session
 * is answering.
 */
export function serversFromClaudeJson(doc: unknown, projectPath?: string): McpServer[] {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return []
  const d = doc as Record<string, unknown>
  const user = serversFromMap(d.mcpServers, 'user')
  if (!projectPath) return user
  const projects = d.projects
  if (typeof projects !== 'object' || projects === null) return user
  const entry = (projects as Record<string, unknown>)[projectPath]
  if (typeof entry !== 'object' || entry === null) return user
  return [...user, ...serversFromMap((entry as Record<string, unknown>).mcpServers, 'local', projectPath)]
}

/** `<repo>/.mcp.json` → its `project` servers. */
export function serversFromMcpJson(doc: unknown, projectPath: string): McpServer[] {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return []
  return serversFromMap((doc as Record<string, unknown>).mcpServers, 'project', projectPath)
}

/**
 * Merge the scopes into ONE list, keeping the narrowest definition of each name.
 *
 * Claude Code resolves a name in scope order (local beats project beats user), so a panel that
 * showed all three would be listing configurations that are not in effect while claiming they are.
 * The one that WINS is the one listed, and its scope is on the row.
 */
export function mergeScopes(all: readonly McpServer[]): McpServer[] {
  const rank: Record<McpScope, number> = { local: 0, project: 1, user: 2 }
  const best = new Map<string, McpServer>()
  for (const s of all) {
    const cur = best.get(s.name)
    if (!cur || rank[s.scope] < rank[cur.scope]) best.set(s.name, s)
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// ---- adding one, from pasted JSON ---------------------------------------------------------------

/**
 * A server name, as it will be passed as an argv element to `claude mcp`.
 *
 * Bounded and charset-checked. It is never interpolated into a shell — the spawn takes an argv —
 * but a name with a newline or a leading dash would be read by the CLI as something it is not.
 */
const NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 ._@/-]{0,127}$/

export function validMcpName(name: string): boolean {
  return NAME_SHAPE.test(name)
}

export interface PastedServer {
  name: string
  /** The server's own config object, re-serialized — what `claude mcp add-json` takes. */
  json: string
}

export type PasteResult =
  | { ok: true; servers: PastedServer[] }
  /** A stable code the caller turns into a sentence. Never a repaired document. */
  | { ok: false; reason: 'not-json' | 'not-an-object' | 'no-servers' | 'bad-name' | 'bad-entry' }

/**
 * What somebody pasted, turned into servers to add.
 *
 * THREE SHAPES ARE ACCEPTED, because all three are what people actually copy from a README:
 *   {"mcpServers": {"name": {...}}}   the whole config block
 *   {"name": {...}}                   one named entry
 *   {"command": "npx", ...}           a bare config, which needs `fallbackName`
 *
 * It REFUSES rather than repairs — the CLAUDE.md rule for anything written outside our own
 * directories. A shape this cannot read is reported with its reason, because "we could not read
 * that" and "that server does not work" send a reader to two different places.
 */
export function parseMcpPaste(text: string, fallbackName?: string): PasteResult {
  let doc: unknown
  try { doc = JSON.parse(text) } catch { return { ok: false, reason: 'not-json' } }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { ok: false, reason: 'not-an-object' }
  }
  const d = doc as Record<string, unknown>

  const isConfig = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      && (typeof (v as Record<string, unknown>).command === 'string'
        || typeof (v as Record<string, unknown>).url === 'string')

  // Shape 3 first: a bare config is unambiguous, and reading it as a map of names would produce a
  // server called `command`.
  if (isConfig(d)) {
    if (!fallbackName) return { ok: false, reason: 'bad-name' }
    if (!validMcpName(fallbackName)) return { ok: false, reason: 'bad-name' }
    return { ok: true, servers: [{ name: fallbackName, json: JSON.stringify(d) }] }
  }

  const nested = d['mcpServers']
  const map: Record<string, unknown> = isConfigMap(nested) ? nested as Record<string, unknown> : d
  const entries = Object.entries(map)
  if (entries.length === 0) return { ok: false, reason: 'no-servers' }

  const servers: PastedServer[] = []
  for (const [name, cfg] of entries) {
    if (!validMcpName(name)) return { ok: false, reason: 'bad-name' }
    if (!isConfig(cfg)) return { ok: false, reason: 'bad-entry' }
    servers.push({ name, json: JSON.stringify(cfg) })
  }
  return { ok: true, servers }
}

function isConfigMap(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ---- the commands ------------------------------------------------------------------------------

/**
 * `claude mcp add-json <name> <json> -s <scope>` — read from the tool's own `--help`.
 *
 * `add-json` rather than `add` precisely because the feature asked for is "paste the server's
 * JSON": `add` would need the paste taken apart into flags and put back together, which is a second
 * chance to change what somebody pasted.
 */
export function mcpAddArgs(server: PastedServer, scope: McpScope): string[] {
  return ['mcp', 'add-json', server.name, server.json, '-s', scope]
}

/** The EXACT inverse: the same name, in the same scope the install wrote. */
export function mcpRemoveArgs(name: string, scope: McpScope): string[] {
  return ['mcp', 'remove', name, '-s', scope]
}

/**
 * Does this scope's command have to run inside the repository?
 *
 * `user` is machine-wide and runs anywhere. `local` and `project` are both resolved against the
 * process's CWD, so running them in the wrong directory silently configures the wrong project —
 * which is why the caller must have a directory before it may offer either.
 */
export function scopeNeedsProject(scope: McpScope): boolean {
  return scope !== 'user'
}
