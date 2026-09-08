// packages/server/server/adapters/antigravity-parse.ts
//
// PURE parser for the Antigravity CLI (agy). No fs, no side effects — raw file
// contents in, SessionMeta out.
//
// On-disk shape (~/.gemini/antigravity-cli/):
//   history.jsonl                       — one JSON per line, GLOBAL (all conversations):
//     {"display":"<prompt or /slash>","timestamp":1785172407299,"workspace":"/abs/path",
//      "conversationId":"<uuid>","type":"slash_command"?}
//     `workspace` is the cwd → the project path. `conversationId` is absent on the very
//     first lines (before a conversation exists). `type:"slash_command"` marks a slash
//     command, which must NOT count as the session's first user prompt.
//     history.jsonl is a CLI *prompt history*: it rotates and can be cleared, so it is only
//     ever a supplementary hint — never a reason to drop a conversation (see the child-set
//     helpers below).
//   brain/<conversation-id>/.system_generated/logs/transcript.jsonl (and transcript_full.jsonl)
//     {"step_index":0,"source":"USER_EXPLICIT"|"MODEL"|"SYSTEM",
//      "type":"USER_INPUT"|"PLANNER_RESPONSE"|"VIEW_FILE"|"SEARCH_WEB"|"RUN_COMMAND"|
//             "CHECKPOINT"|"CONVERSATION_HISTORY"|"ERROR_MESSAGE"|"INVOKE_SUBAGENT"|...,
//      "status":"DONE","created_at":"2026-07-27T17:13:27Z",
//      "content"?:string,"thinking"?:string,"error"?:string,"error_code"?:number,
//      "tool_calls"?:[{"name":"view_file","args":{}}]}
//   conversations/<conversation-id>.db — SQLite; the `gen_metadata` table holds the token /
//     model protobuf blobs. Read by the (impure) adapter, decoded by antigravity-protobuf.ts,
//     and handed to this parser as `options.tokens` — this module stays pure.

import type { ModelUsage, SessionMeta, TurnEvent } from '@agentistics/core'
import { activeMinutesOf, emptyModelUsage, sessionModelUsage, charCount } from '@agentistics/core'
import { canonicalTool, countGitCommands } from '../harness-activity'

/** One parsed line of the global history.jsonl. */
export interface AntigravityHistoryEntry {
  display: string
  timestamp: number
  workspace: string
  conversationId?: string
  isSlashCommand: boolean
}

/** Row of conversation_summaries.db (all fields optional — the table is often empty). */
export interface AntigravityConversationSummary {
  conversation_id: string
  parent_conversation_id?: string
  nesting_depth?: number
  title?: string
  preview?: string
  workspace_uris?: string
}

/** Token/model totals for one conversation, summed from its `gen_metadata` rows. */
export interface AntigravityTokenTotals {
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  /** Dominant model id (most `gen_metadata` rows) — the session's single display label. */
  modelId: string
  /** Per-model split of the same rows. Always sums back to the three totals above; it is what
   *  makes a multi-model session (a parent with folded subagent children) cost-exact. */
  byModel?: Record<string, { inputTokens: number; cachedTokens: number; outputTokens: number }>
  /** Number of `gen_metadata` rows that decoded — used by the reconciliation test. */
  rowCount?: number
  /**
   * Field `1.9.10.1` of the LAST decoded row — how full the window was at that generation.
   *
   * agy is the one harness that measures this directly rather than leaving it to be reconstructed:
   * the field is a gauge, never a sum, precisely because it is a level, not a quantity. Everything
   * else on this interface is summed across rows; this one is read off the last.
   */
  contextTokens?: number
  /**
   * Field `1.9.10.4` of the LAST decoded row — the window agy DECLARES for the call (128.000, and
   * 256.000 on some rows).
   *
   * This is Codex's `model_context_window` rule applied to agy: a harness stating the window for
   * the session it is running outranks any table, and it is the ONLY way an agy session gets a
   * context bar — Google publishes no citable input limit, so `CONTEXT_WINDOWS` has no row for
   * these models and never will until it can be cited.
   */
  contextWindow?: number
}

/** Optional inputs for {@link parseAntigravityTranscript}. */
export interface AntigravityParseOptions {
  /** Parsed global history — used only for the first_prompt / workspace fallbacks. */
  historyEntries?: AntigravityHistoryEntry[]
  /** Conversation ids proven to be `invoke_subagent` children (see buildAntigravityChildSet). */
  childIds?: ReadonlySet<string>
  /** Token/model totals decoded from conversations/<id>.db by the adapter. */
  tokens?: AntigravityTokenTotals | null
  /** Optional conversation_summaries.db row for this conversation. */
  summary?: AntigravityConversationSummary | null
  /** Parse a conversation that has no genuine user turn anyway. Used for `invoke_subagent`
   *  CHILDREN: a child is dispatched by its parent, so demanding a human prompt would throw its
   *  (real, already-billed) tokens away. Never set for top-level conversations. */
  allowNoUserTurn?: boolean
}

/** A parsed conversation plus the file paths it touched. The path SET (not just its size) is
 *  needed so folding a subagent child into its parent unions the files instead of double-counting
 *  a file both touched. */
export interface AntigravityParsed {
  session: SessionMeta
  modifiedFiles: string[]
}

/** Tool names that mean "this session searched the web". */
const WEB_SEARCH_TOOLS = new Set(['search_web', 'web_search'])
/** Tool names that mean "this session fetched a URL". */
const WEB_FETCH_TOOLS = new Set(['read_url_content', 'read_url', 'fetch_url', 'browser_navigate'])

/** Tool names that write to a file. Their `TargetFile` arg feeds files_modified / line deltas. */
const EDIT_TOOLS = new Set([
  'replace_file_content',
  'multi_replace_file_content',
  'write_to_file',
  'edit_file',
  'create_file',
])

/** Transcript step types that are replays of earlier turns rather than new activity.
 *  Counting them would double-count every turn of a resumed conversation. */
const REPLAY_TYPES = new Set(['CONVERSATION_HISTORY'])

/** Pure: parse the global history.jsonl into entries. Malformed lines are skipped. */
export function parseAntigravityHistory(content: string): AntigravityHistoryEntry[] {
  const out: AntigravityHistoryEntry[] = []
  for (const raw of String(content ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let parsed: any
    try { parsed = JSON.parse(line) } catch { continue }
    if (!parsed || typeof parsed !== 'object') continue
    const workspace = typeof parsed.workspace === 'string' ? parsed.workspace : ''
    const display = typeof parsed.display === 'string' ? parsed.display : ''
    const timestamp = typeof parsed.timestamp === 'number' ? parsed.timestamp : 0
    const conversationId = typeof parsed.conversationId === 'string' && parsed.conversationId
      ? parsed.conversationId
      : undefined
    out.push({
      display,
      timestamp,
      workspace,
      conversationId,
      isSlashCommand: parsed.type === 'slash_command' || display.startsWith('/'),
    })
  }
  return out
}

/** Pure: workspace (project path) per conversationId, from history entries.
 *  Last non-empty workspace wins — a conversation is bound to one cwd in practice. */
export function buildAntigravityWorkspaceMap(
  entries: AntigravityHistoryEntry[],
): Map<string, string> {
  const map = new Map<string, string>()
  for (const e of entries) {
    if (!e.conversationId || !e.workspace) continue
    map.set(e.conversationId, e.workspace)
  }
  return map
}

/** Pure: the first genuine (non-slash) user prompt recorded in history for a conversation. */
export function firstHistoryPrompt(
  entries: AntigravityHistoryEntry[],
  conversationId: string,
): string {
  for (const e of entries) {
    if (e.conversationId !== conversationId) continue
    if (e.isSlashCommand) continue
    if (e.display.trim()) return e.display
  }
  return ''
}

/** Strip agy's `<USER_REQUEST>` wrapper and the trailing `<ADDITIONAL_METADATA>` /
 *  `<USER_SETTINGS_CHANGE>` blocks from a USER_INPUT content string. */
export function extractUserRequest(content: string): string {
  const text = String(content ?? '')
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(text)
  if (m) return (m[1] ?? '').trim()
  // No wrapper: drop any metadata blocks and keep the rest.
  return text
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .trim()
}

/** `/model`, `/usage foo` → true. A path like `/home/padawan is where…` → false. */
function isSlashCommandPrompt(text: string): boolean {
  const t = text.trim()
  if (t.includes('\n')) return false
  return /^\/[a-zA-Z][\w-]*(\s|$)/.test(t)
}

// ---------------------------------------------------------------------------
// Subagent children — INTRINSIC detection (never "absent from history.jsonl")
// ---------------------------------------------------------------------------

/** Matches the conversation ids agy prints inside an INVOKE_SUBAGENT step's content:
 *    { "conversationId":  "8922cd26-...", "logAbsoluteUri": "file://…" } */
const CONVERSATION_ID_RE = /"conversationId"\s*:\s*"([^"]{4,})"/g

/**
 * Pure: conversation ids this transcript SPAWNED as `invoke_subagent` children.
 *
 * The parent records an `INVOKE_SUBAGENT` step whose content lists one JSON object per child
 * (`conversationId` + `logAbsoluteUri`), and/or an `invoke_subagent` tool_call. Those ids are
 * the authoritative, intrinsic parent→child link: unlike history.jsonl they live in the
 * conversation's own transcript and never rotate away.
 */
export function collectSubagentChildIds(transcript: string): string[] {
  const out: string[] = []
  for (const raw of String(transcript ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (!line.includes('INVOKE_SUBAGENT') && !line.includes('invoke_subagent')) continue
    let step: any
    try { step = JSON.parse(line) } catch { continue }
    if (!step || typeof step !== 'object') continue

    const isInvokeStep = step.type === 'INVOKE_SUBAGENT'
    const hasInvokeCall = Array.isArray(step.tool_calls)
      && step.tool_calls.some((c: any) => c && c.name === 'invoke_subagent')
    if (!isInvokeStep && !hasInvokeCall) continue

    const content = typeof step.content === 'string' ? step.content : ''
    CONVERSATION_ID_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = CONVERSATION_ID_RE.exec(content)) !== null) {
      const id = (m[1] ?? '').trim()
      if (id) out.push(id)
    }
    // Structured variant, if agy ever emits one.
    const ids = step.subagent_conversation_ids
    if (Array.isArray(ids)) {
      for (const id of ids) if (typeof id === 'string' && id.trim()) out.push(id.trim())
    }
  }
  return [...new Set(out)]
}

/**
 * Pure: the set of conversation ids that are `invoke_subagent` CHILDREN.
 *
 * Two intrinsic sources, both independent of history.jsonl:
 *  1. every parent transcript's INVOKE_SUBAGENT step (always present in the parent's own log);
 *  2. conversation_summaries.db rows with a `parent_conversation_id` or `nesting_depth > 0`
 *     (authoritative when the table has rows — it is frequently empty, hence "when present").
 *
 * A conversation is dropped as a session ONLY when it appears here. Being missing from
 * history.jsonl proves nothing: that file rotates, and losing a real transcript's metrics must
 * never be the default failure mode.
 */
export function buildAntigravityChildSet(
  transcripts: Iterable<readonly [string, string]>,
  summaries: readonly AntigravityConversationSummary[] = [],
): Set<string> {
  const children = new Set<string>()
  for (const entry of transcripts) {
    if (!entry) continue
    const [parentId, transcript] = entry
    for (const childId of collectSubagentChildIds(transcript)) {
      if (childId && childId !== parentId) children.add(childId)
    }
  }
  for (const s of summaries) {
    if (!s || typeof s.conversation_id !== 'string' || !s.conversation_id) continue
    const parent = typeof s.parent_conversation_id === 'string' ? s.parent_conversation_id.trim() : ''
    const depth = typeof s.nesting_depth === 'number' ? s.nesting_depth : 0
    if (parent || depth > 0) children.add(s.conversation_id)
    // A summary row that explicitly says depth 0 / no parent is authoritative the other way:
    // it un-marks a conversation only if nothing else claimed it as a child, which is already
    // the default — so nothing to do here.
  }
  return children
}

/**
 * Pure: child conversation id → its PARENT conversation id.
 *
 * Same two intrinsic sources as {@link buildAntigravityChildSet}, and the reason it exists:
 * knowing a conversation is a child is not enough — a child's `gen_metadata` rows live in its OWN
 * conversations/<child>.db, so the adapter must know WHICH parent to fold that spend into.
 * The parent transcript wins over the summaries row when both claim a link (the transcript is the
 * conversation's own log and never rotates).
 */
export function buildAntigravityParentMap(
  transcripts: Iterable<readonly [string, string]>,
  summaries: readonly AntigravityConversationSummary[] = [],
): Map<string, string> {
  const parentOf = new Map<string, string>()
  for (const s of summaries) {
    if (!s || typeof s.conversation_id !== 'string' || !s.conversation_id) continue
    const parent = typeof s.parent_conversation_id === 'string' ? s.parent_conversation_id.trim() : ''
    if (parent && parent !== s.conversation_id) parentOf.set(s.conversation_id, parent)
  }
  for (const entry of transcripts) {
    if (!entry) continue
    const [parentId, transcript] = entry
    for (const childId of collectSubagentChildIds(transcript)) {
      if (childId && childId !== parentId) parentOf.set(childId, parentId)
    }
  }
  return parentOf
}

/** Pure: `file:///abs/path` → `/abs/path`. Returns '' when the URI is not a local file. */
export function fileUriToPath(uri: string): string {
  const raw = String(uri ?? '').trim()
  if (!raw.startsWith('file://')) return ''
  let path = raw.slice('file://'.length)
  // file:///abs → /abs ; file://host/abs is not something agy emits, but be safe.
  if (!path.startsWith('/')) {
    const slash = path.indexOf('/')
    path = slash === -1 ? '' : path.slice(slash)
  }
  try { return decodeURIComponent(path) } catch { return path }
}

/** Count the lines of a content blob (a trailing newline does not add an empty line). */
function countLines(text: unknown): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  return text.replace(/\n+$/, '').split('\n').length
}

/** The `file://` URIs named by a CODE_ACTION step's prose ("Created file file:///…"). */
const FILE_URI_RE = /file:\/\/(\/[^\s"'`)\]]+)/g

// ---------------------------------------------------------------------------

/** Pure: parse one conversation's transcript into a SessionMeta.
 *
 *  @param transcript   raw contents of transcript_full.jsonl (or transcript.jsonl)
 *  @param conversationId  the brain/<id> directory name — the stable session id
 *  @param projectPath  cwd resolved from history.jsonl's `workspace`
 *  @param options      history entries, the intrinsic subagent child set, decoded token totals
 *                      and the optional conversation_summaries row
 *  Returns null when the conversation has no genuine user turn (bootstrap/empty) or is a
 *  proven `invoke_subagent` child.
 */
export function parseAntigravityTranscript(
  transcript: string,
  conversationId: string,
  projectPath: string,
  options: AntigravityParseOptions = {},
): SessionMeta | null {
  return parseAntigravityTranscriptDetailed(transcript, conversationId, projectPath, options)
    ?.session ?? null
}

/** Same as {@link parseAntigravityTranscript} but also returns the set of files the conversation
 *  touched, so a parent can UNION its subagent children's files instead of summing counts. */
export function parseAntigravityTranscriptDetailed(
  transcript: string,
  conversationId: string,
  projectPath: string,
  options: AntigravityParseOptions = {},
): AntigravityParsed | null {
  const historyEntries = options.historyEntries ?? []
  // Only an INTRINSIC signal drops a conversation — never "not named in history.jsonl".
  if (options.childIds?.has(conversationId)) return null

  const lines = String(transcript ?? '').split('\n')

  // Summed in the SAME branch that increments the count beside it — see `promptChars.ts`.
  let userChars = 0, userCharMsgs = 0, assistantChars = 0, assistantCharMsgs = 0
  let userMessages = 0
  let assistantMessages = 0
  let firstPrompt = ''
  let hasGenuineUserTurn = false
  let toolErrors = 0
  const toolErrorCategories: Record<string, number> = {}
  const toolCounts: Record<string, number> = {}
  let gitCommits = 0, gitPushes = 0
  const messageHours: number[] = []
  const userMessageTimestamps: string[] = []
  const timestamps: number[] = []
  // Per-turn timeline for computeActiveTime() (docs/harness-contract.md). agy records no duration
  // of its own, so turns are reconstructed: a genuine USER_INPUT (never a slash command) opens
  // one, every later step advances the clock.
  const turnEvents: TurnEvent[] = []
  const modifiedFiles = new Set<string>()
  let linesAdded = 0
  let linesRemoved = 0
  // step_index is the transcript's own ordering key; dedupe on it so a replayed /
  // re-appended step is never counted twice.
  const seenSteps = new Set<number>()
  let usesMcp = false
  let usesWebSearch = false
  let usesWebFetch = false
  let usesTaskAgent = false

  const noteError = (category: string) => {
    toolErrors++
    toolErrorCategories[category] = (toolErrorCategories[category] ?? 0) + 1
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    let step: any
    try { step = JSON.parse(line) } catch { continue }
    if (!step || typeof step !== 'object') continue

    const type = typeof step.type === 'string' ? step.type : ''
    // Replayed history: context re-injection, not new activity.
    if (REPLAY_TYPES.has(type)) continue

    const idx = typeof step.step_index === 'number' ? step.step_index : null
    if (idx !== null) {
      if (seenSteps.has(idx)) continue
      seenSteps.add(idx)
    }

    const createdAt = typeof step.created_at === 'string' ? step.created_at : ''
    const ms = createdAt ? Date.parse(createdAt) : NaN
    let turnEvent: TurnEvent | null = null
    if (!isNaN(ms)) {
      timestamps.push(ms)
      turnEvent = { ts: ms }
      turnEvents.push(turnEvent)
    }

    if (type === 'USER_INPUT') {
      const text = extractUserRequest(typeof step.content === 'string' ? step.content : '')
      if (!text) continue
      // A slash command is a CLI action, not a prompt — never the first_prompt.
      const slash = isSlashCommandPrompt(text)
      if (!slash) {
        hasGenuineUserTurn = true
        if (turnEvent) turnEvent.userPrompt = true
        if (!firstPrompt) firstPrompt = text.slice(0, 200)
      }
      userMessages++
      { const n = charCount(text); if (n > 0) { userChars += n; userCharMsgs++ } }
      if (createdAt) userMessageTimestamps.push(createdAt)
      if (!isNaN(ms)) messageHours.push(new Date(ms).getHours())
      continue
    }

    if (type === 'PLANNER_RESPONSE') {
      // A planner step with prose content is a reply to the user; a tool-only planner
      // step is an intermediate action.
      if (typeof step.content === 'string' && step.content.trim()) {
        assistantMessages++
        { const n = charCount(step.content); if (n > 0) { assistantChars += n; assistantCharMsgs++ } }
        if (!isNaN(ms)) messageHours.push(new Date(ms).getHours())
      }
    }

    // Errors. Every step carries status "DONE" even when it failed, so the dedicated
    // ERROR_MESSAGE step is the primary signal. The three checks are MUTUALLY EXCLUSIVE so a
    // single failed step can never increment the counter twice.
    if (type === 'ERROR_MESSAGE') {
      const code = typeof step.error_code === 'number' ? String(step.error_code) : ''
      noteError(code ? `error_${code}` : 'error_message')
    } else if (typeof step.exit_code === 'number' && step.exit_code !== 0) {
      noteError('exit_code')
    } else if (step.status === 'ERROR' || step.status === 'FAILED') {
      noteError('status_error')
    }

    // Sub-agent dispatch: agy's `invoke_subagent` is this harness's Task/Agent tool. The step
    // itself is the signal (the child's own metrics are folded in by the adapter).
    if (type === 'INVOKE_SUBAGENT') usesTaskAgent = true

    // A CODE_ACTION step only names the file it wrote in prose ("Created file file:///…").
    if (type === 'CODE_ACTION') {
      const target = typeof step.TargetFile === 'string' ? step.TargetFile : ''
      if (target) modifiedFiles.add(target)
      const content = typeof step.content === 'string' ? step.content : ''
      FILE_URI_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = FILE_URI_RE.exec(content)) !== null) {
        const path = fileUriToPath(`file://${m[1]}`)
        if (path) modifiedFiles.add(path)
      }
    }

    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : []

    // A shell command appears TWICE in an agy transcript: the model ASKS for it (a `run_command`
    // tool_call on a PLANNER_RESPONSE step) and then it RUNS (a RUN_COMMAND step of its own, which
    // is the one carrying the command text and the exit code). They are one command. Only the
    // execution is counted — the same trap as Kimi's duplicated usage records, and the same answer:
    // pick the single event that is the fact, never both. The request is skipped in the tool_calls
    // loop below; counting the request instead would report commands that were never run.
    if (type === 'RUN_COMMAND') {
      toolCounts.Bash = (toolCounts.Bash ?? 0) + 1
      const cmd = typeof step.content === 'string' ? step.content : ''
      if (cmd) {
        const g = countGitCommands(cmd)
        gitCommits += g.commits
        gitPushes += g.pushes
      }
    }

    for (const call of calls) {
      const name = call && typeof call.name === 'string' ? call.name : ''
      if (!name) continue
      const shared = canonicalTool('antigravity', name)
      // See the RUN_COMMAND block above: this is the REQUEST for a command, and its execution is
      // counted there. Counting it here as well doubled every shell call agy made.
      if (shared !== 'Bash') toolCounts[shared] = (toolCounts[shared] ?? 0) + 1
      if (name === 'invoke_subagent') usesTaskAgent = true
      if (WEB_SEARCH_TOOLS.has(name)) usesWebSearch = true
      if (WEB_FETCH_TOOLS.has(name)) usesWebFetch = true
      if (name.startsWith('mcp_') || name.startsWith('mcp__') || name === 'call_mcp_tool') usesMcp = true

      const args = call.args && typeof call.args === 'object' ? call.args : null
      if (!args) continue
      const target = typeof args.TargetFile === 'string' ? args.TargetFile.trim() : ''
      // A write is either a known edit tool or any call carrying both a TargetFile and a
      // content payload — the latter keeps new agy edit tools from silently going uncounted.
      const chunks: any[] = Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : [args]
      const hasPayload = chunks.some(ch => ch && typeof ch === 'object'
        && (typeof ch.CodeContent === 'string'
          || typeof ch.ReplacementContent === 'string'
          || typeof ch.TargetContent === 'string'))
      if (!target || (!EDIT_TOOLS.has(name) && !hasPayload)) continue
      modifiedFiles.add(target)
      // Line deltas: agy stores no precomputed counter, so count newlines of the before/after
      // blobs. `write_to_file` only has the new content (CodeContent) — pure addition.
      for (const ch of chunks) {
        if (!ch || typeof ch !== 'object') continue
        if (typeof ch.CodeContent === 'string') linesAdded += countLines(ch.CodeContent)
        if (typeof ch.ReplacementContent === 'string') linesAdded += countLines(ch.ReplacementContent)
        if (typeof ch.TargetContent === 'string') linesRemoved += countLines(ch.TargetContent)
      }
    }
  }

  if (!firstPrompt) {
    const fromHistory = firstHistoryPrompt(historyEntries, conversationId)
    if (fromHistory) {
      firstPrompt = fromHistory.slice(0, 200)
      hasGenuineUserTurn = true
    }
  }

  // Bootstrap / slash-command-only / empty conversation → not a real session.
  // (A subagent child is parsed with allowNoUserTurn: it is dispatched, not prompted.)
  if (!hasGenuineUserTurn && !options.allowNoUserTurn) return null

  // conversation_summaries.db (often empty) is an optional enrichment only.
  const summary = options.summary ?? null
  let resolvedPath = projectPath
  if (!resolvedPath && summary && typeof summary.workspace_uris === 'string') {
    try {
      const uris = JSON.parse(summary.workspace_uris)
      if (Array.isArray(uris) && typeof uris[0] === 'string') resolvedPath = fileUriToPath(uris[0])
    } catch { /* malformed JSON: keep the empty path */ }
  }
  const title = summary && typeof summary.title === 'string' && summary.title.trim()
    ? summary.title.trim()
    : (summary && typeof summary.preview === 'string' && summary.preview.trim()
      ? summary.preview.trim()
      : undefined)

  const startMs = timestamps.length > 0 ? Math.min(...timestamps) : NaN
  const endMs = timestamps.length > 0 ? Math.max(...timestamps) : NaN
  const startTime = isNaN(startMs) ? '' : new Date(startMs).toISOString()
  const endTime = isNaN(endMs) ? undefined : new Date(endMs).toISOString()
  const durationMinutes = isNaN(startMs) || isNaN(endMs)
    ? 0
    : Math.max(0, (endMs - startMs) / 60000)

  // Tokens/model come from conversations/<id>.db (gen_metadata protobuf), decoded by the
  // adapter. A missing/locked/corrupt DB degrades to zeros — never a throw, never a guess.
  const tokens = options.tokens ?? null
  // A per-model split is only carried when the conversation really spans several models — for a
  // single-model conversation `model` alone prices it exactly.
  const byModel = tokens?.byModel ?? undefined
  const modelUsage = byModel && Object.keys(byModel).length > 1
    ? toModelUsageMap(byModel)
    : undefined

  const session: SessionMeta = {
    session_id: conversationId,
    project_path: resolvedPath,
    start_time: startTime,
    end_time: endTime,
    duration_minutes: durationMinutes,
    active_minutes: activeMinutesOf(turnEvents),
    user_message_count: userMessages,
    user_chars: userChars,
    user_char_messages: userCharMsgs,
    assistant_message_count: assistantMessages,
    assistant_chars: assistantChars,
    assistant_char_messages: assistantCharMsgs,
    tool_counts: toolCounts,
    tool_output_tokens: {},
    agent_file_reads: {},
    languages: [],
    git_commits: gitCommits,
    git_pushes: gitPushes,
    input_tokens: tokens?.inputTokens ?? 0,
    // gen_metadata field 1.4.3 is the TOTAL output (thinking + completion) — never add thinking.
    output_tokens: tokens?.outputTokens ?? 0,
    cache_read_input_tokens: tokens?.cachedTokens ?? 0,
    // agy does not record cache WRITES separately.
    cache_creation_input_tokens: 0,
    // The `1.9.10.1` gauge off the last generation — absent when no row carried one.
    ...(tokens?.contextTokens ? { context_tokens: tokens.contextTokens } : {}),
    // The window agy DECLARES (`1.9.10.4`), which outranks CONTEXT_WINDOWS exactly as Codex's
    // `model_context_window` does — and is the only reason an agy session can draw a bar.
    ...(tokens?.contextWindow ? { context_window: tokens.contextWindow } : {}),
    first_prompt: firstPrompt,
    title,
    user_interruptions: 0,
    user_response_times: [],
    tool_errors: toolErrors,
    tool_error_categories: toolErrorCategories,
    // agy's invoke_subagent is this harness's Task/Agent tool.
    uses_task_agent: usesTaskAgent,
    uses_mcp: usesMcp,
    uses_web_search: usesWebSearch,
    uses_web_fetch: usesWebFetch,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
    files_modified: modifiedFiles.size,
    message_hours: messageHours,
    user_message_timestamps: userMessageTimestamps,
    model: tokens?.modelId || undefined,
    ...(modelUsage ? { model_usage: modelUsage } : {}),
    harness: 'antigravity',
    _source: 'jsonl',
  }

  return { session, modifiedFiles: [...modifiedFiles] }
}

// ---------------------------------------------------------------------------
// Sub-agent rollup — every gen_metadata row counted exactly once
// ---------------------------------------------------------------------------

/** Convert the adapter's per-model token split into the shared `ModelUsage` shape. */
function toModelUsageMap(
  byModel: Record<string, { inputTokens: number; cachedTokens: number; outputTokens: number }>,
): Record<string, ModelUsage> {
  const out: Record<string, ModelUsage> = {}
  for (const [model, t] of Object.entries(byModel)) {
    if (!model) continue
    out[model] = {
      inputTokens: t.inputTokens ?? 0,
      outputTokens: t.outputTokens ?? 0,
      cacheReadInputTokens: t.cachedTokens ?? 0,
      // agy records no cache WRITES.
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
    }
  }
  return out
}

/** The per-model usage of one parsed conversation — its `model_usage` when it spans several
 *  models, else a single entry under its own `model`. Empty when it has no model at all. */
function ownModelUsage(s: SessionMeta): Record<string, ModelUsage> {
  const out: Record<string, ModelUsage> = {}
  for (const [model, u] of sessionModelUsage(s)) {
    const e = out[model] ?? (out[model] = emptyModelUsage())
    e.inputTokens += u.inputTokens
    e.outputTokens += u.outputTokens
    e.cacheReadInputTokens += u.cacheReadInputTokens
    e.cacheCreationInputTokens += u.cacheCreationInputTokens
  }
  return out
}

function sumRecords(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...a }
  for (const [k, v] of Object.entries(b ?? {})) out[k] = (out[k] ?? 0) + v
  return out
}

/** The model carrying the most tokens (in+out+cache) in a per-model usage map, or '' if empty. */
function dominantModelOf(usage: Record<string, ModelUsage>): string {
  let best = ''
  let bestTokens = -1
  for (const [model, u] of Object.entries(usage)) {
    const total = (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
      + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0)
    if (total > bestTokens) { bestTokens = total; best = model }
  }
  return best
}

/**
 * Pure: fold an `invoke_subagent` CHILD conversation into its PARENT.
 *
 * agy stores a child's generations in its own conversations/<child>.db, so without this the
 * child's tokens/cost exist on disk but in no session at all. A child is not an independent user
 * session (it has no human prompt), so — exactly like Claude Code, where an Agent tool call's
 * tokens belong to the session that spawned it — its spend and its work are reported INSIDE the
 * parent. The rules, all deliberate:
 *
 *  - tokens: SUMMED (input / output / cache read / cache write).
 *  - `model_usage`: unioned per model, so the merged session stays cost-exact even when parent and
 *    child ran different models (Opus parent + Gemini Flash subagents is the normal case).
 *  - `model`: the PARENT's own dominant model, never the child's, WHEN the parent generated any
 *    tokens itself. One label cannot honestly describe a multi-model session; the parent's own
 *    model is the defensible choice there and the per-model breakdown carries the truth. But a
 *    pure orchestrator — a parent that only dispatches subagents and never generates a token of
 *    its own — has no such label, and leaving `model` empty is not neutral: every caller that
 *    prices or aggregates a session keys off `model` first (`sessionModelUsage`'s own fallback
 *    included) and treats "no model" as "no session", dropping real, merged-in child spend from
 *    every total that does not separately consult `model_usage`. So a parentless model falls back
 *    to the DOMINANT model of the merged usage — real attribution (it is where the tokens actually
 *    went), not a guess.
 *  - work: tool_counts / tool_errors (+categories) / lines added+removed SUMMED, files UNIONED
 *    (a file both touched is one file), capability flags OR-ed, uses_task_agent forced true.
 *  - message counts, message_hours and user_message_timestamps are NOT merged: a child's
 *    "USER_INPUT" is the parent's dispatch, not a human turn, and counting it would invent user
 *    activity that never happened.
 *  - the time window is extended to cover the child, and the duration recomputed from it.
 */
export function mergeAntigravityChild(
  parent: AntigravityParsed,
  child: AntigravityParsed,
): AntigravityParsed {
  const p = parent.session
  const c = child.session

  const usage = ownModelUsage(p)
  for (const [model, u] of Object.entries(ownModelUsage(c))) {
    const e = usage[model] ?? (usage[model] = emptyModelUsage())
    e.inputTokens += u.inputTokens
    e.outputTokens += u.outputTokens
    e.cacheReadInputTokens += u.cacheReadInputTokens
    e.cacheCreationInputTokens += u.cacheCreationInputTokens
  }

  const files = new Set<string>([...parent.modifiedFiles, ...child.modifiedFiles])
  const startMs = [p.start_time, c.start_time].map(t => (t ? Date.parse(t) : NaN))
    .filter(n => !isNaN(n))
  const endMs = [p.end_time ?? p.start_time, c.end_time ?? c.start_time]
    .map(t => (t ? Date.parse(t) : NaN)).filter(n => !isNaN(n))
  const start = startMs.length > 0 ? Math.min(...startMs) : NaN
  const end = endMs.length > 0 ? Math.max(...endMs) : NaN

  const session: SessionMeta = {
    ...p,
    start_time: isNaN(start) ? p.start_time : new Date(start).toISOString(),
    end_time: isNaN(end) ? p.end_time : new Date(end).toISOString(),
    duration_minutes: isNaN(start) || isNaN(end)
      ? p.duration_minutes
      : Math.max(0, (end - start) / 60000),
    // active_minutes is NOT summed (it comes through the `...p` spread): a subagent runs INSIDE
    // the parent turn that dispatched it, so its time is already inside the parent's turn span.
    // Adding it would count the same wall-clock twice.
    input_tokens: (p.input_tokens ?? 0) + (c.input_tokens ?? 0),
    output_tokens: (p.output_tokens ?? 0) + (c.output_tokens ?? 0),
    cache_read_input_tokens: (p.cache_read_input_tokens ?? 0) + (c.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens:
      (p.cache_creation_input_tokens ?? 0) + (c.cache_creation_input_tokens ?? 0),
    tool_counts: sumRecords(p.tool_counts ?? {}, c.tool_counts ?? {}),
    tool_errors: (p.tool_errors ?? 0) + (c.tool_errors ?? 0),
    tool_error_categories: sumRecords(p.tool_error_categories ?? {}, c.tool_error_categories ?? {}),
    lines_added: (p.lines_added ?? 0) + (c.lines_added ?? 0),
    lines_removed: (p.lines_removed ?? 0) + (c.lines_removed ?? 0),
    files_modified: files.size,
    uses_mcp: !!p.uses_mcp || !!c.uses_mcp,
    uses_web_search: !!p.uses_web_search || !!c.uses_web_search,
    uses_web_fetch: !!p.uses_web_fetch || !!c.uses_web_fetch,
    uses_task_agent: true,
    // Keep the parent's own label when it has one; a pure orchestrator falls back to the
    // dominant merged model rather than losing its label (and its tokens) entirely. The honest
    // multi-model picture, when there is one, lives in model_usage regardless.
    model: p.model || dominantModelOf(usage) || undefined,
    ...(Object.keys(usage).length > 1 ? { model_usage: usage } : {}),
  }
  return { session, modifiedFiles: [...files] }
}

/**
 * Pure: fold every `invoke_subagent` child into its parent and return the surviving sessions.
 *
 * THE INVARIANT: every `gen_metadata` row that exists on disk is counted EXACTLY ONCE. A child is
 * merged into the nearest ANCESTOR that was parsed (so a grandchild lands on the root), and a
 * child whose whole ancestor chain is missing stays a session of its own rather than having its
 * (real) spend silently dropped. Parent-less conversations are returned untouched.
 *
 * @param parsedById every conversation, children included (children parsed with allowNoUserTurn)
 * @param parentOf   child id → parent id, from {@link buildAntigravityParentMap}
 */
export function rollUpAntigravitySessions(
  parsedById: ReadonlyMap<string, AntigravityParsed>,
  parentOf: ReadonlyMap<string, string>,
): SessionMeta[] {
  /** Nearest ancestor of `id` that was parsed — null when the chain dies out (or loops). */
  const anchorOf = (id: string): string | null => {
    const seen = new Set<string>([id])
    let cur = parentOf.get(id)
    while (cur && !seen.has(cur)) {
      if (parsedById.has(cur)) return cur
      seen.add(cur)
      cur = parentOf.get(cur)
    }
    return null
  }

  // Fold children into their anchors. Iterate deepest-first so a grandchild is merged before its
  // parent is itself merged upward — anchorOf already skips missing links, but merging in depth
  // order keeps the merged time window / flags correct for chains.
  const depthOf = (id: string): number => {
    const seen = new Set<string>([id])
    let d = 0
    let cur = parentOf.get(id)
    while (cur && !seen.has(cur)) { d++; seen.add(cur); cur = parentOf.get(cur) }
    return d
  }

  const merged = new Map<string, AntigravityParsed>(parsedById)
  const folded = new Set<string>()
  const children = [...parsedById.keys()]
    .filter(id => parentOf.has(id))
    .sort((a, b) => depthOf(b) - depthOf(a))

  for (const childId of children) {
    const anchor = anchorOf(childId)
    if (!anchor || anchor === childId) continue  // orphan → survives as its own session
    const child = merged.get(childId)
    const parent = merged.get(anchor)
    if (!child || !parent) continue
    merged.set(anchor, mergeAntigravityChild(parent, child))
    folded.add(childId)
  }

  const out: SessionMeta[] = []
  for (const [id, parsed] of merged) {
    if (folded.has(id)) continue
    out.push(parsed.session)
  }
  return out
}
