/**
 * atMenu.ts — PURE: referencing an MCP server (and its tools) by typing `@` in the composer.
 *
 * The counterpart to `skillMenu.ts`'s `/` picker, and it follows the same shape for the same
 * reason: every decision that can be wrong here belongs in one tested module, not in JSX. It is a
 * SEPARATE module rather than more exports on `skillMenu.ts` because the two triggers answer
 * different questions — `/` is a command at the START OF A LINE; `@` is a reference at the START
 * OF A WORD, anywhere in the line — and `@` has a SECOND LEVEL `/` does not: a server, then
 * (optionally) one of its tools.
 *
 * FIVE DECISIONS live here:
 *
 * 1. WHEN THE PICKER IS OPEN, AT WHAT LEVEL. `@` triggers only at a word boundary — `user@domain`,
 *    `HEAD@{1}` are not invocations, the same reasoning `slashMisplaced` documents for `/`. Once
 *    open, a `:` in what was typed after the `@` switches the picker from listing SERVERS to
 *    listing that server's TOOLS — driven by the raw text, exactly as the user asked for it
 *    ("com : uma lista de ferramentas aparece").
 *
 * 2. THE SERVER LIST NEVER CLAIMS WHAT IT DOES NOT KNOW. `/api/mcp/tools` answers server NAMES
 *    instantly and their TOOL LISTS later (`GET /api/mcp/tools`'s own header explains why), so a
 *    server can be `ready` (its tool count is known), `pending` (asked, not yet answered — NEVER
 *    drawn as zero tools) or `unreachable` (asked, and it could not be — reported with its reason,
 *    never descended into).
 *
 * 3. THE FILTER, at both levels: substring, case-insensitive, on the name (and the tool's
 *    description too, same reasoning `filterSkills` gives for skills whose name alone does not say
 *    what they do).
 *
 * 4. WHAT A PICK WRITES. Selecting a SERVER with no `:` typed writes a bare `@name ` and closes —
 *    a reference to the server itself, nothing more to choose. Selecting a TOOL writes the
 *    fully-qualified `@server:tool ` and then REOPENS AN EMPTY TRIGGER FOR THE SAME SERVER
 *    (`@server:`), which is what lets "one or more" fall out of the same text-driven design rather
 *    than a second state machine: the reopened trigger is a perfectly ordinary `@server:` a person
 *    could have typed by hand, so the picker naturally stays open on that server's tool list ready
 *    for the next pick, and Escape (or moving on) leaves it exactly as typed — the same thing a
 *    dismissed `/partial` command does in `skillMenu.ts`. Nothing here compresses several tools
 *    into one token (`@serena:a,b`): each is its own reference, sent or not sent on its own.
 *
 * 5. INSERTION NEVER SENDS. Same rule `applySkill` states for the same reason: what reaches the
 *    session is what the person chose to send, and most of these tokens sit inside a longer
 *    message the person is still writing.
 */

import { mcpCheckText } from './mcpCheckText'

/** One tool, as the composer needs it — see `McpToolInfo` on the server. */
export interface MenuMcpTool {
  name: string
  description?: string
}

/** Mirrors `McpServerToolsView['status']` on the server — see its own header for why three. */
export type MenuMcpServerStatus = 'ready' | 'unreachable' | 'pending'

/**
 * One configured MCP server, shaped for the picker. Deliberately narrower than the wire type
 * (`McpServerToolsView`): the composer never needs `scope` or `transport` to reference a server by
 * name, and importing server types into the web bundle is not this module's job.
 */
export interface MenuMcpServer {
  name: string
  status: MenuMcpServerStatus
  /** Present only when `status === 'ready'`. */
  tools?: MenuMcpTool[]
  /** Present only when `status === 'unreachable'` — an `McpCheckOutcome`, read by `mcpCheckText`. */
  outcome?: string
  exitCode?: number
}

/**
 * Is the caret inside an `@` reference, and what has been typed into it?
 *
 * `before` is the draft text UP TO THE CARET. The trigger is the trailing run of non-whitespace
 * characters, and it counts ONLY when an `@` starts that run AND the character right before it is
 * whitespace or the start of the text — a word boundary. That is what keeps `user@domain` and
 * `HEAD@{1}` from opening a picker mid-word while `hi @serena` and a bare `@` at the start of the
 * message still do. A trailing space ends it, exactly like `/` — the space starts an argument (or
 * just more prose), and a picker still open there would take the arrow keys away from someone
 * writing past it.
 */
export function atQuery(before: string): string | null {
  const m = /(?:^|\s)@([^\s]*)$/.exec(before)
  return m ? m[1]! : null
}

/** The `@` query split into its two levels — see the header, decision 1. */
export interface AtQueryLevel {
  level: 'server' | 'tool'
  /** The server-name filter (level `server`) or the exact name typed (level `tool`). */
  serverText: string
  /** Only meaningful at level `tool`. */
  toolText: string
}

/**
 * Split an `@` query on its FIRST `:` — everything before names the server, everything after
 * filters its tools. First and not last: a tool name is never expected to carry a colon of its
 * own, but treating a second one as more filter text is a harmless miss rather than a crash.
 */
export function atLevel(query: string): AtQueryLevel {
  const at = query.indexOf(':')
  if (at < 0) return { level: 'server', serverText: query, toolText: '' }
  return { level: 'tool', serverText: query.slice(0, at), toolText: query.slice(at + 1) }
}

/** Narrow the server list by name, case-insensitive. A blank query is "the picker just opened". */
export function filterAtServers(servers: readonly MenuMcpServer[], query: string): MenuMcpServer[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...servers]
  return servers.filter(s => s.name.toLowerCase().includes(q))
}

/**
 * The exact server a typed `:` refers to, case-insensitive (the picker's own list is what taught
 * the person the name; matching its exact case back would refuse a name it just showed them in a
 * different one). `null` when nothing configured carries that name.
 */
export function findAtServer(servers: readonly MenuMcpServer[], name: string): MenuMcpServer | null {
  const q = name.toLowerCase()
  return servers.find(s => s.name.toLowerCase() === q) ?? null
}

/** Narrow a server's tool list by name AND description — half of these are named for a library. */
export function filterAtTools(tools: readonly MenuMcpTool[], query: string): MenuMcpTool[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...tools]
  return tools.filter(t =>
    t.name.toLowerCase().includes(q) || (t.description ?? '').toLowerCase().includes(q))
}

/**
 * What the tool level actually has to show, once a `:` names a server.
 *
 * FOUR SHAPES, because each sends a reader somewhere different — the same reasoning
 * `McpCheckOutcome` gives for not collapsing its six into a boolean. `unknown-server` is its own
 * case rather than falling through to an empty tool list: a typo in the name and a server with
 * genuinely zero tools must not read as the same thing.
 */
export type AtToolView =
  | { kind: 'unknown-server' }
  | { kind: 'pending' }
  | { kind: 'unreachable'; outcome?: string; exitCode?: number }
  | { kind: 'tools'; tools: MenuMcpTool[] }

export function resolveAtToolView(
  servers: readonly MenuMcpServer[], serverName: string, toolQuery: string,
): AtToolView {
  const server = findAtServer(servers, serverName)
  if (server === null) return { kind: 'unknown-server' }
  if (server.status === 'pending') return { kind: 'pending' }
  if (server.status === 'unreachable') {
    return {
      kind: 'unreachable',
      ...(server.outcome !== undefined ? { outcome: server.outcome } : {}),
      ...(server.exitCode !== undefined ? { exitCode: server.exitCode } : {}),
    }
  }
  return { kind: 'tools', tools: filterAtTools(server.tools ?? [], toolQuery) }
}

/**
 * The SERVER row's own subtitle — decision 2. Reuses `mcpCheckText` for the unreachable reason
 * rather than re-stating the six-outcome table a second time: this file only decides which of the
 * three states applies, never what a `McpCheckOutcome` means in words.
 */
export function atServerStatusText(server: MenuMcpServer, lang: 'pt' | 'en'): string {
  if (server.status === 'pending') return lang === 'pt' ? 'perguntando…' : 'asking…'
  if (server.status === 'ready') {
    const n = server.tools?.length ?? 0
    return lang === 'pt'
      ? `${n} ferramenta${n === 1 ? '' : 's'}`
      : `${n} tool${n === 1 ? '' : 's'}`
  }
  // Reuses `mcpCheckText`'s six-outcome table rather than re-stating it: this module only decides
  // WHICH of the three states applies, never what an `McpCheckOutcome` means in words.
  return mcpCheckText(
    { outcome: server.outcome ?? 'uncheckable', ...(server.exitCode !== undefined ? { exitCode: server.exitCode } : {}) },
    lang === 'pt',
  ).text
}

/** What the SERVER level says when nothing matches — see `emptyPickerReason`'s own reasoning. */
export function emptyAtServerReason(configured: number, query: string, lang: 'pt' | 'en'): string {
  const pt = lang === 'pt'
  if (configured === 0) {
    return pt
      ? 'Nenhum servidor MCP configurado para esta sessão.'
      : 'No MCP server configured for this session.'
  }
  const q = query.trim()
  if (q === '') {
    return pt
      ? `Nenhum dos ${configured} servidores.`
      : `None of the ${configured} configured servers.`
  }
  return pt
    ? `Nenhum dos ${configured} servidores tem "${q}" no nome.`
    : `None of the ${configured} servers has "${q}" in its name.`
}

/** What the TOOL level says for a genuinely reachable server whose tool list matched nothing. */
export function emptyAtToolReason(server: string, total: number, query: string, lang: 'pt' | 'en'): string {
  const pt = lang === 'pt'
  if (total === 0) {
    return pt
      ? `"${server}" não relatou nenhuma ferramenta.`
      : `"${server}" reported no tools.`
  }
  const q = query.trim()
  if (q === '') {
    return pt ? `Nenhuma das ${total} ferramentas.` : `None of the ${total} tools.`
  }
  return pt
    ? `Nenhuma das ${total} ferramentas de "${server}" tem "${q}" no nome ou na descrição.`
    : `None of ${server}'s ${total} tools has "${q}" in its name or description.`
}

/**
 * The sentence for the three non-`tools` shapes of `AtToolView` — `null` for `tools`, whose caller
 * either draws the (possibly filtered-empty) list or falls to `emptyAtToolReason` itself.
 */
export function atToolViewReason(view: AtToolView, server: string, lang: 'pt' | 'en'): string | null {
  const pt = lang === 'pt'
  switch (view.kind) {
    case 'unknown-server':
      return pt ? `Nenhum servidor chamado "${server}".` : `No server named "${server}".`
    case 'pending':
      return pt
        ? `Perguntando a "${server}" quais ferramentas ele tem…`
        : `Asking "${server}" what tools it has…`
    case 'unreachable':
      return mcpCheckText(
        { outcome: view.outcome ?? 'uncheckable', ...(view.exitCode !== undefined ? { exitCode: view.exitCode } : {}) },
        pt,
      ).text
    case 'tools':
      return null
  }
}

/** The draft and caret after an insertion — same contract as `SkillInsertion`. */
export interface AtInsertion {
  text: string
  caret: number
}

/**
 * Rule 4: a bare server reference, no colon typed — closes the picker.
 *
 * Falls back to APPENDING when the trigger has already vanished (the same race `applySkill`
 * guards against): a pick can only be dismissed between the click and this call by something the
 * user did, and losing it to that race would be the worse of the two answers.
 */
export function applyAtServer(draft: string, caret: number, name: string): AtInsertion {
  const at = Math.max(0, Math.min(caret, draft.length))
  const before = draft.slice(0, at)
  const after = draft.slice(at)
  const query = atQuery(before)
  const inserted = `@${name} `
  if (query === null) {
    const head = draft.replace(/\s+$/, '')
    const text = head === '' ? inserted : `${head} ${inserted}`
    return { text, caret: text.length }
  }
  const start = before.length - query.length - 1
  return { text: draft.slice(0, start) + inserted + after, caret: start + inserted.length }
}

/**
 * A tool picked at the tool level — decision 4. Writes the fully-qualified token and REOPENS an
 * empty `@server:` trigger right after it, which is the whole mechanism behind "choose one or
 * more": the reopened text is exactly what a person would have typed to keep browsing that same
 * server's tools, so the picker stays open on it for free.
 */
export function applyAtTool(draft: string, caret: number, server: string, tool: string): AtInsertion {
  const at = Math.max(0, Math.min(caret, draft.length))
  const before = draft.slice(0, at)
  const after = draft.slice(at)
  const query = atQuery(before)
  const inserted = `@${server}:${tool} @${server}:`
  if (query === null) {
    const head = draft.replace(/\s+$/, '')
    const text = head === '' ? inserted : `${head} ${inserted}`
    return { text, caret: text.length }
  }
  const start = before.length - query.length - 1
  const text = draft.slice(0, start) + inserted + after
  return { text, caret: start + inserted.length }
}
