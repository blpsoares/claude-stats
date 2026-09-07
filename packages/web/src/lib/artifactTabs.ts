/**
 * artifactTabs.ts — PURE: what the artifacts panel's three tabs contain.
 *
 * FILES is everything the session wrote that is still a readable file with content — the server
 * decides that, because only it can look at the disk.
 *
 * DOCS is the subset somebody would READ rather than run: specs, plans, notes, READMEs. It is a
 * subset and never a separate list, so a document cannot be in one tab and missing from the other.
 * The rule is the EXTENSION plus a small set of names, because that is what can be decided without
 * opening the file — guessing at "is this a spec" from a path's words would file
 * `packages/server/spec-runner.ts` under documentation.
 *
 * LIVE is the activity, in order: what the session read, wrote, ran, thought and delegated. It is
 * built from the same turns the conversation renders, so it can never claim something the
 * transcript does not show. Each entry says WHICH KIND it is, because "read a file" and "ran a
 * command" are different events and a single grey list of strings is a log, not a view.
 */

/** Extensions whose files are read rather than executed. */
const DOC_EXT = new Set(['md', 'mdx', 'txt', 'rst', 'adoc'])

/** Names that are documentation whatever their extension. */
const DOC_NAME = new Set(['README', 'CHANGELOG', 'LICENSE', 'AGENTS', 'CLAUDE', 'NOTES', 'TODO'])

/** Is this path a document — something written to be read? */
export function isDoc(path: string): boolean {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (DOC_EXT.has(ext)) return true
  // A KNOWN NAME counts only when it carries no extension of its own. `src/readme.tsx` is a React
  // component whose file happens to be called readme, and filing it under documentation is the
  // same guess-from-the-path this rule exists to refuse.
  if (dot > 0) return false
  return DOC_NAME.has(name.toUpperCase())
}

/** One thing the session did, in the order it did it. */
export interface LiveEvent {
  kind: 'wrote' | 'read' | 'ran' | 'thought' | 'delegated'
  /** When the turn that produced it was recorded, ISO — absent on a transcript that carries none. */
  at?: string
  /** The path, the command, or the first line of what was said — already trimmed for a row. */
  text: string
  /** True while the turn that produced it has not finished. */
  live: boolean
  /**
   * The harness's own `tool_use` id, so this row can be OPENED — `/api/fleet/step` pairs it with the
   * `tool_result` that names the same id and returns the whole call and its output.
   *
   * Absent on a transcript that carries no id, and a row with no `ref` and no `full` simply does not
   * open: a control whose only outcome is a refusal is worse than no control.
   */
  ref?: string
  /**
   * The whole text, when it is ALREADY HERE and no request is needed.
   *
   * Reasoning is the case: the transcript hands over the complete thinking and the row shows its
   * first line, so opening it costs nothing and must not pretend to be a fetch.
   */
  full?: string
}

export interface LiveTurn {
  at?: string
  role?: string
  text?: string
  thinking?: string
  pending?: boolean
  /** `ref` is the harness's `tool_use` id — the exact key `/api/fleet/step` opens the call with. */
  tools?: { name: string; detail?: string; writes?: string[]; ref?: string }[]
}

/** Tools that READ rather than change anything. */
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead', 'WebFetch', 'WebSearch'])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** One line of a longer text, for a row that has one line to give. */
function firstLine(s: string, max = 160): string {
  const line = s.trim().split('\n').find(l => l.trim() !== '')?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/**
 * The activity feed, newest LAST — the transcript's own order, which is what makes it readable as
 * a sequence rather than a set.
 *
 * PROSE IS NOT AN ACTION. The assistant's own text was included at first, on the theory that a turn
 * explaining what it is about to do is part of "what is happening". It is not what this tab is for
 * — asked directly: "no live eu quero apenas as acoes do harness, mensagens nao contam" — and it
 * made the feed unreadable by burying the tool calls under paragraphs. What the assistant SAID is
 * the conversation, one tab away and rendered properly there; what it DID is here.
 *
 * Reasoning stays, because it is not a message: it is the harness working, and it is the only
 * signal for the stretch between two tool calls where nothing else is happening.
 */
export function liveEvents(turns: readonly LiveTurn[]): LiveEvent[] {
  const out: LiveEvent[] = []
  for (const t of turns) {
    const live = t?.pending === true
    const at = t?.at
    const ev = (kind: LiveEvent['kind'], text: string, more?: Partial<LiveEvent>): LiveEvent => ({
      kind, text, live, ...(at ? { at } : {}), ...(more ?? {}),
    })
    // Reasoning opens with no request: the whole text is already here. Everything else is a `ref`
    // the step reader resolves — see `LiveEvent.ref`.
    if (t?.thinking) out.push(ev('thought', firstLine(t.thinking), { full: t.thinking }))
    for (const c of t?.tools ?? []) {
      // Every event a call produces carries THAT call's id, so opening the `wrote` row of a shell
      // command shows the command that wrote it — the two rows are one step seen from both ends.
      const ref = c.ref ? { ref: c.ref } : undefined
      // A command that writes is BOTH events, in the order they happen: it ran, and then the file
      // appeared. Collapsing them would lose either what was run or what it produced, and the feed
      // is asked for both.
      if (c.name === 'Bash' && c.detail) out.push(ev('ran', c.detail, ref))
      for (const w of c.writes ?? []) out.push(ev('wrote', w, ref))
      if (WRITE_TOOLS.has(c.name) && c.detail) out.push(ev('wrote', c.detail, ref))
      else if (READ_TOOLS.has(c.name) && c.detail) out.push(ev('read', c.detail, ref))
      // A subagent is a delegation, not a command — it is the one tool call that starts more work
      // somewhere else, and reading it as "ran" hides that.
      else if (c.name === 'Agent' || c.name === 'Task') out.push(ev('delegated', c.detail ?? c.name, ref))
    }
  }
  return out
}

/**
 * "How long ago", in the shortest form that is still true.
 *
 * Relative rather than a clock time because the question the feed answers is "is this happening
 * NOW or did it happen a while back", and `14:32` makes the reader do that subtraction themselves.
 * An absent timestamp yields an empty string: nothing is invented, and the row simply carries no
 * time — the same rule the gauge follows when it cannot know a context window.
 */
export function agoLabel(at: string | undefined, now: number, pt: boolean): string {
  if (!at) return ''
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 10) return pt ? 'agora' : 'now'
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

/**
 * Can this written path be OPENED from the feed, and if not, why not?
 *
 * A `wrote` row that does nothing when clicked is the control-that-reads-as-broken this codebase
 * argues against, and simply hiding the link leaves the reader with no idea why one path is a link
 * and its neighbour is not. So the reason is shown ON the row.
 *
 * `temp` is decided by the PATH, which is the only thing that can be known here — the server lists
 * what is readable, and a file under the system temp directory never is, because the read guard
 * admits one root (see `artifact-list.ts` for why that was tried and reverted). `gone` is anything
 * else the server did not list: it was written and is no longer there, or it never landed.
 */
export type WriteStatus = 'open' | 'temp' | 'gone'

export function writeStatus(path: string, onDisk: ReadonlySet<string>): WriteStatus {
  if (onDisk.has(path)) return 'open'
  // `/tmp/...`, `/var/folders/...` (macOS) and a `T`/`TMPDIR`-shaped path all read as scratch. Kept
  // to prefixes rather than a regex over the whole path: a file called `tmp.ts` in the project is
  // not scratch, and a rule that matched it would mislabel real work.
  if (/^\/(tmp|var\/tmp|var\/folders)\//.test(path)) return 'temp'
  return 'gone'
}
