/**
 * mentionTokens.ts — PURE: the `@server` and `@server:tool` references inside a draft.
 *
 * A mention that is not marked reads as loose text — reported with a screenshot of `@agentistics`
 * sitting in the composer looking exactly like the words around it, with nothing to say it had been
 * picked from a list of real servers.
 *
 * IT PAINTS ONLY WHAT IT CAN VOUCH FOR. A mention is marked when its SERVER is one the machine
 * actually has; an `@someone` in prose, or a server that is not configured, is left as the plain
 * text it is. This is the same rule `commandToken.ts` follows and for the same reason: the mark is
 * read at a glance and believed, so it may never appear over something unverified. When the server
 * list has not arrived yet (`null`), nothing is marked at all — "I could not check" is not "this is
 * real".
 *
 * The TOOL half is deliberately not checked. A server's tools are probed lazily and are `pending`
 * for the first few seconds (see `mcp-tools.ts`), so gating the mark on them would make a mention
 * flicker into existence some seconds after it was inserted — and the thing being vouched for here
 * is the reference's shape and its server, both of which are known immediately.
 *
 * UNLIKE a command, a mention can appear anywhere and any number of times: it is one word inside a
 * message, not the whole message. So this scans the draft rather than only its head.
 */

/** One reference found in the draft, as a half-open range over it. */
export interface MentionToken {
  start: number
  end: number
}

/**
 * `@name` or `@name:tool`.
 *
 * The server part allows the characters a configured name really uses — this machine has
 * `makenotion/notion-mcp-server` and `computer-use-mcp`, so `/`, `-` and `.` all have to be in.
 * A preceding character, when there is one, must be whitespace: `me@host` is an address and
 * `a@b:c` is not a reference, which is the same word-boundary rule the picker's own trigger uses.
 */
const MENTION = /(^|\s)@([A-Za-z0-9][A-Za-z0-9_./-]*)(:([A-Za-z0-9][A-Za-z0-9_.-]*))?/g

export function mentionTokens(
  draft: string,
  knownServers: ReadonlySet<string> | null,
): MentionToken[] {
  if (knownServers === null || knownServers.size === 0) return []
  const out: MentionToken[] = []
  for (const m of draft.matchAll(MENTION)) {
    const lead = m[1] ?? ''
    const server = m[2] ?? ''
    if (!knownServers.has(server)) continue
    const start = (m.index ?? 0) + lead.length
    out.push({ start, end: start + m[0].length - lead.length })
  }
  return out
}

/**
 * The set `mentionTokens` takes, from whatever the machine reported.
 *
 * `null` in, `null` out — a list that has not arrived cannot be turned into an empty one without
 * claiming this machine has no MCP servers.
 */
export function knownServers(
  servers: readonly { name: string }[] | null,
): ReadonlySet<string> | null {
  return servers === null ? null : new Set(servers.map(s => s.name))
}
