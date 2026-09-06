import { isLocalModelId, LOCAL_MODEL_PRICE } from './local-models'
export interface DailyActivity {
  date: string
  messageCount: number
  sessionCount: number
  toolCallCount: number
}

export interface DailyModelTokens {
  date: string
  tokensByModel: Record<string, number>
}

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
}

export interface LongestSession {
  sessionId: string
  duration: number
  messageCount: number
  timestamp: string
}

export interface StatsCache {
  version: number
  lastComputedDate: string
  dailyActivity: DailyActivity[]
  dailyModelTokens: DailyModelTokens[]
  modelUsage: Record<string, ModelUsage>
  totalSessions: number
  totalMessages: number
  longestSession: LongestSession
  firstSessionDate: string
  hourCounts: Record<string, number>
  totalSpeculationTimeSavedMs: number
}

export type HarnessId = 'claude' | 'codex' | 'gemini' | 'copilot' | 'antigravity' | 'kimi'

export interface HarnessCapabilities {
  tokens: boolean
  cost: boolean
  model: boolean
  tools: boolean
  agents: boolean
  gitLines: boolean
  /** Runs of the harness's multi-agent orchestration tool (Claude Code's Workflow tool).
   *  Gates the repo-detail "Dynamic Workflows" tab. */
  dynamicWorkflows: boolean
  /** The harness writes per-event timestamps (or its own measured turn durations), so
   *  `SessionMeta.active_minutes` can be computed — see `activeTime.ts` and
   *  docs/harness-contract.md. False means the UI shows only wall-clock elapsed time. */
  activeTime: boolean
  /**
   * The harness records how full the context window was on its LAST turn, so
   * `SessionMeta.context_tokens` can be filled — the measurement behind the context gauge.
   *
   * This is a narrower question than `tokens`, and the difference is the whole trap: a cumulative
   * total is not a context size. A long session with compaction sums to far more than was ever in
   * the window at once, so a harness that reports only running totals gets `false` here even
   * though `tokens` is `true`. What qualifies is a PER-TURN prompt size (or a gauge the harness
   * measures itself), which is why codex and kimi qualify on their per-turn records while copilot,
   * whose only token report is a cumulative one written at shutdown, does not.
   */
  contextWindow: boolean
}

/** Single source of truth for which metrics each harness can produce.
 *  Drives "N/A vs real 0" rendering and what the unified view aggregates. */
export const HARNESS_CAPABILITIES: Record<HarnessId, HarnessCapabilities> = {
  // `activeTime` — where each harness's per-turn time comes from (docs/harness-contract.md):
  //   claude  → `system`/`turn_duration`.durationMs when present, timestamps otherwise
  //   codex   → `task_complete`.duration_ms (measured by Codex itself)
  //   copilot → `assistant.turn_start` → `assistant.turn_end` brackets
  //   gemini / antigravity / kimi → reconstructed from per-message timestamps (no measured field)
  claude:  { tokens: true,  cost: true,  model: true,  tools: true,  agents: true,  gitLines: true,  dynamicWorkflows: true,  activeTime: true,  contextWindow: true },
  codex:   { tokens: true,  cost: true,  model: true,  tools: true,  agents: false, gitLines: false, dynamicWorkflows: false, activeTime: true,  contextWindow: true },
  // Gemini's chat files carry `toolCalls: [{ name, args }]` per message, and a shell call puts its
  // command in `args.command` — so tools and commits are real. `gitLines` stays false: the calls
  // name the file they touched but carry no diff counters.
  gemini:  { tokens: true,  cost: true,  model: true,  tools: true,  agents: false, gitLines: false, dynamicWorkflows: false, activeTime: true,  contextWindow: false },
  // `tools` was false while `tool.execution_start` had been carrying the tool name and its
  // arguments all along — the flag was out of date, not the data missing. Verified against a real
  // events.jsonl before flipping it.
  copilot: { tokens: true,  cost: true,  model: true,  tools: true,  agents: false, gitLines: true,  dynamicWorkflows: false, activeTime: true,  contextWindow: false },
  // Antigravity (agy): tokens + model come from the `gen_metadata` protobuf blobs in
  // ~/.gemini/antigravity-cli/conversations/<id>.db (decoded by adapters/antigravity-protobuf.ts)
  // and cost is derived from them via calcCost().
  // `gitLines` is FALSE on purpose. agy has no git integration, and the transcript only lets us
  // count ADDED lines (write_to_file's CodeContent / a replace's ReplacementContent). Removals
  // need the replaced blob (`TargetContent`), which agy does not write for its normal edit path —
  // measured on real data, lines_removed is structurally 0. Reporting a confident 0 removals is
  // exactly the misleading-zero this flag exists to prevent, so the UI shows N/A instead. The
  // per-session lines_added / lines_removed fields are still populated (and files_modified, which
  // this flag does NOT gate, stays real).
  antigravity: { tokens: true, cost: true, model: true, tools: true, agents: false, gitLines: false, dynamicWorkflows: false, activeTime: true, contextWindow: true },
  // Kimi Code CLI. Tokens and model are real (usage.record events in each agent's wire.jsonl).
  // Kimi ROUTES to other providers and stamps the provider's own model on each usage record
  // (`google/gemini-3.5-flash-lite`), so in practice the model is one MODEL_PRICING already knows
  // and the cost is a real calculation. Kimi's own `kimi-*` models are not in the table yet: like
  // any unknown id on any harness they would take the shared fallback price, so add them here when
  // Moonshot publishes verified rates. `gitLines` is false because Kimi records the Edit/Write
  // strings but no diff counters.
  // Kimi's wire carries `tool.call` with `args`, and its own tool schema declares Bash's
  // `command` — so tools and commits are both real, read from what it actually ran.
  kimi: { tokens: true, cost: true, model: true, tools: true, agents: false, gitLines: false, dynamicWorkflows: false, activeTime: true, contextWindow: true },
}

/** Display order for harness lists, and the single source of truth for "every harness".
 *
 *  Declared as a Record so the compiler REQUIRES an entry per HarnessId. The five places that used
 *  to hardcode `['claude', 'codex', ...]` were plain arrays, which TypeScript happily accepts with a
 *  member missing — adding a harness left it silently absent from the Compare page, the filter bar,
 *  the data-source list and, worse, the consolidate store, so its sessions were never persisted. */
const HARNESS_SORT: Record<HarnessId, number> = {
  claude: 0, codex: 1, gemini: 2, copilot: 3, antigravity: 4, kimi: 5,
}

export const HARNESS_ORDER: HarnessId[] = (Object.keys(HARNESS_SORT) as HarnessId[])
  .sort((a, b) => HARNESS_SORT[a] - HARNESS_SORT[b])

export interface SessionMeta {
  session_id: string
  project_path: string
  /** The directory the session is in NOW, when it differs from `project_path` — a session that
   *  moved into a git worktree (or any subdirectory) keeps `project_path` at the directory it was
   *  opened in, so that it stays grouped under the same project. Live-session detection matches a
   *  running process by its cwd, and without this the moved session looks closed while it is open. */
  current_cwd?: string
  start_time: string
  end_time?: string
  /** WALL CLOCK: last event − first event. A session reopened over three weeks reports ~500h here,
   *  which is true and says nothing about how long it was worked on. Use `active_minutes` for that. */
  duration_minutes: number
  /** Time the session was actually being worked on: Σ per-turn duration (human prompt → the
   *  harness's last event for that turn), preferring a duration the harness measured itself.
   *  Computed by `computeActiveTime()` in activeTime.ts — one rule for every harness.
   *  `undefined` when the transcript carries no usable timing (old sessions whose raw file was
   *  already deleted, or a harness with `activeTime: false`); the UI shows "—", never a guess. */
  active_minutes?: number
  user_message_count: number
  assistant_message_count: number
  tool_counts: Record<string, number>
  tool_output_tokens: Record<string, number>
  agent_file_reads: Record<string, number>
  languages: string[]
  git_commits: number
  git_pushes: number
  input_tokens: number
  output_tokens: number
  /** Only populated for `_source: 'jsonl' | 'subdir'` — parsed directly from JSONL usage. */
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  /**
   * How many tokens were in the context window on the session's LAST turn — the measurement behind
   * the context gauge. Gated by `HARNESS_CAPABILITIES.contextWindow`.
   *
   * A GAUGE, never a sum, and that distinction is the whole reason it is its own field rather than
   * something derived from the four counters above. Those are cumulative over the session; this is
   * the size of one prompt. On a long session they diverge by an order of magnitude, and using the
   * total would report a context far past full on a session that never filled it.
   */
  context_tokens?: number
  /**
   * The window that measurement should be read against, WHEN THE HARNESS ITSELF STATES IT.
   *
   * Codex writes `model_context_window` into every `token_count` event, and a harness naming the
   * window for the session it is running outranks any table lookup — it knows the deployment, the
   * tier and any per-session cap, none of which a model id can express. Absent for every other
   * harness, where `resolveContextWindow(model)` answers instead.
   */
  context_window?: number
  first_prompt: string
  /** Human-readable session title. Claude writes an `ai-title` (or legacy `summary`) line into
   *  the transcript; we surface it as the session's display name. Falls back to `first_prompt`
   *  in the UI when absent (older sessions, non-Claude harnesses). */
  title?: string
  /**
   * The name the USER gave this session in the session manager, and their own note.
   *
   * A third thing, deliberately separate from `title` (which the harness generates from the
   * transcript) and from `first_prompt`: it is the one label nothing upstream may overwrite, which
   * is the entire reason to be able to set it. Stamped from `~/.agentistics/managed-sessions.json`
   * and only ever when the link is UNAMBIGUOUS — see `linkManagedSessions`.
   */
  user_label?: string
  user_note?: string
  user_interruptions: number
  user_response_times: number[]
  tool_errors: number
  tool_error_categories: Record<string, number>
  uses_task_agent: boolean
  uses_mcp: boolean
  uses_web_search: boolean
  uses_web_fetch: boolean
  lines_added: number
  lines_removed: number
  files_modified: number
  message_hours: number[]
  user_message_timestamps: string[]
  model?: string
  /** Per-model token breakdown for sessions whose generations span MORE THAN ONE model, e.g. an
   *  Antigravity parent conversation with its `invoke_subagent` children folded in (the parent can
   *  run Opus while its subagents run Gemini Flash). When present it is the authoritative cost
   *  basis — its per-model sums always add up to `input_tokens` / `output_tokens` /
   *  `cache_read_input_tokens` / `cache_creation_input_tokens`, and `model` stays the session's own
   *  dominant model (a single label for a multi-model session is a display convenience only).
   *  Absent for single-model sessions: then `model` alone prices the session. */
  model_usage?: Record<string, ModelUsage>
  harness: HarnessId
  /** Owning user in team mode. Undefined for local/Solo sessions. */
  user?: string
  /** Normalized git remote of the session's repo (`host/org/repo`, no protocol) — the
   *  "group by repository" key. Set server-side from the local repo's `remote.origin.url`
   *  (or authoritatively from a repo-bound token on CI ingest). Empty/undefined when the
   *  project is not a git repo or has no origin remote. See `normalizeGitRemote`. */
  git_remote?: string
  /** Primary team of the owning machine (teamIds[0]) — central read-time tag; kept for
   *  single-value consumers. */
  teamId?: string
  /** ALL teams the owning machine belongs to (central read-time tag). A session is visible/filtered
   *  by ANY of these — a machine can be in several teams. Falls back to [teamId] on legacy data. */
  teamIds?: string[]
  /** Stable machine identity (the member token's sha256 hash) — central read-time tag, used to
   *  filter by an individual machine. Matches `machine.id` from /api/iam/machines. */
  memberId?: string
  /** True when this session was produced by a CI runner (Claude Code GitHub Actions), stamped
   *  authoritatively by the central on ingest via a repo-bound token. Powers the Actions view. */
  ci?: boolean
  _source?: 'meta' | 'jsonl' | 'subdir'
  agentMetrics?: SessionAgentMetrics
  /** Number of MCP tool calls recorded in this session (Copilot adapter). */
  mcp_tool_call_count?: number
  /** Unique MCP tool names called in this session (Copilot adapter). */
  mcp_tool_names?: string[]
}

export interface AgentInvocation {
  toolUseId: string
  /**
   * The subagent's own transcript id, when the harness names one.
   *
   * Present since Claude Code made the `Agent` tool asynchronous (2026-08-14): the parent's result
   * carries no numbers any more, only this id, and the numbers live in
   * `<project>/<session-id>/subagents/agent-<agentId>.jsonl`. Absent on every record written before
   * that, and on any harness that names no such file.
   */
  agentId?: string
  agentType: string
  description: string
  status: 'completed' | 'failed'
  /**
   * `true` when the numbers below could NOT be established for this invocation.
   *
   * Read it BEFORE reading any figure here: an unmeasured invocation carries zeros because the type
   * has no other value to carry, and a zero rendered as a fact is the confident-0 this repository
   * forbids everywhere else. A surface must render N/A for these, exactly as it does for a metric a
   * harness cannot produce (`HARNESS_CAPABILITIES`). Absent means measured.
   */
  unmeasured?: true
  totalTokens: number
  totalDurationMs: number
  totalToolUseCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  toolStats: {
    readCount: number
    searchCount: number
    bashCount: number
    editFileCount: number
    linesAdded: number
    linesRemoved: number
    otherToolCount: number
  }
  costUSD: number
}

export interface SessionAgentMetrics {
  invocations: AgentInvocation[]
  totalInvocations: number
  /**
   * How many of them carry no established numbers — so a surface can say that the totals beside it
   * cover fewer invocations than it is showing, instead of implying the rest cost nothing.
   *
   * Optional because a record stored before this existed has no such count; absent is not zero.
   */
  unmeasuredInvocations?: number
  totalTokens: number
  totalDurationMs: number
  totalCostUSD: number
}

export interface WorkflowAgent {
  label: string
  phase: string
  model: string
  status: 'completed' | 'failed' | 'skipped'
  tokensIn: number
  tokensOut: number
  cacheRead: number
  cacheWrite: number
  costUSD: number
  toolStats?: {
    readCount: number; searchCount: number; bashCount: number
    editFileCount: number; linesAdded: number; linesRemoved: number; otherToolCount: number
  }
}

/** Every token a workflow run (or one of its agents) was billed for. Cache reads and writes are
 *  the bulk of a subagent's consumption — a "tokens" figure that leaves them out is not a rounder
 *  number, it is a different number, and it contradicts the cost shown next to it. */
export function workflowTokens(
  t: { tokensIn: number; tokensOut: number; cacheRead?: number; cacheWrite?: number },
): number {
  return t.tokensIn + t.tokensOut + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0)
}

export interface WorkflowPhase {
  title: string
  agentCount: number
}

export interface WorkflowRun {
  runId: string
  name: string
  sessionId: string
  /** Owning user in team mode (set by the central on ingest). Undefined for local runs. */
  user?: string
  status: 'completed' | 'failed' | 'partial'
  startedAt: string        // ISO; '' if unknown
  durationMs: number
  phases: WorkflowPhase[]
  agents: WorkflowAgent[]
  /** `cacheRead`/`cacheWrite` are optional only because a doc written by an older central (or an
   *  older consolidate store) predates them — read them through `workflowTokens()`, never bare, or
   *  the headline understates a cache-heavy run by orders of magnitude while the cost beside it
   *  (which always priced the cache) says otherwise. */
  totals: {
    agentCount: number; tokensIn: number; tokensOut: number; costUSD: number
    durationMs: number; toolUses: number; cacheRead?: number; cacheWrite?: number
  }
}

export interface PriceEntry {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface RatesCache {
  fetchedAt: number
  brlRate: number
  pricing: Record<string, PriceEntry>
  pricingSource: 'live' | 'fallback'
}

export interface SessionIndex {
  sessionId: string
  fullPath: string
  fileMtime: number
  firstPrompt: string
  summary: string
  messageCount: number
  created: string
  modified: string
  gitBranch: string
  projectPath: string
  isSidechain: boolean
}

export interface ProjectGitStats {
  commits: number
  lines_added: number
  lines_removed: number
  files_modified: number
  since: string
}

export interface Project {
  path: string
  name: string
  sessions: SessionIndex[]
  git_stats?: ProjectGitStats
  /** Normalized git remote (`host/org/repo`, no protocol) of this project's repo, when known.
   *  Drives the group-by-repository dimension (Repositories page). See `normalizeGitRemote`. */
  gitRemote?: string
  /** Team/central only: display names of the members who own sessions in this project.
   *  Lets the frontend scope the project filter to the selected members deterministically,
   *  instead of re-matching paths against user-filtered sessions. Absent/empty on solo. */
  users?: string[]
}

export interface HealthIssue {
  id: string
  severity: 'error' | 'warning' | 'info'
  title: string
  description: string
  guide?: string
  auto_fixed?: boolean
}

/** Team/central only: a member's live connection status, keyed by resolved display name. */
export interface MemberPresence {
  /** True when the member has a live reverse-channel socket OR a recent heartbeat push. */
  online: boolean
  /** ISO timestamp of the member's last contact (push/whoami), or null if never seen. */
  lastSeenAt: string | null
  /** Round-trip latency in ms from the last WebSocket ping/pong, or null when no live socket. */
  latencyMs: number | null
}

/**
 * A git worktree is not a project of its own — it is a checkout of one. Claude Code puts them under
 * `<project>/.claude/worktrees/<name>`, so every worktree showed up in the project list as if it
 * were a separate codebase, splitting one project's metrics across a handful of near-identical
 * paths and offering each of them as a taggable source.
 *
 * Returns the owning project's path, or the input unchanged when it is not a worktree. The
 * double-slash variant appears because the project directory name is decoded heuristically and a
 * leading dot can be lost along the way (`/proj//claude/worktrees/x`).
 */
export function canonicalProjectPath(path: string): string {
  if (!path) return path
  const m = /^(.*?)\/{1,2}\.?claude\/worktrees\//.exec(path)
  return m && m[1] ? m[1] : path
}

/** An assistant process running right now with no session on disk to attribute it to. Not every
 *  assistant persists a conversation the moment it launches — agy writes nothing until a turn
 *  completes — so a freshly-opened one would otherwise be missing from "open now" entirely. */
export interface LiveProcess {
  harness: HarnessId
  /** Working directory the assistant was launched in. */
  cwd: string
  /** Process start time (epoch ms). */
  startedMs?: number
  /** Set when the process named a session id we have no record of. */
  sessionId?: string
  /** Central only: the member (display name) this process is running on. Absent on a solo machine,
   *  where every process is by definition local. */
  user?: string
}

export interface AppData {
  statsCache: StatsCache
  sessions: SessionMeta[]
  projects: Project[]
  allSessions: SessionIndex[]
  healthIssues?: HealthIssue[]
  homeDir?: string
  harnesses: HarnessId[]
  /** Team/central only: each member's own raw statsCache, keyed by resolved display name.
   *  Lets the central reproduce the member's authoritative totals (deep Claude history that
   *  only exists aggregated in statsCache, never as individual sessions). Absent on solo. */
  userStatsCaches?: Record<string, StatsCache>
  /** Team/central only: the SAME caches un-grouped — one entry per machine, keyed by machine id
   *  (`memberId`, the token hash). `userStatsCaches` sums a member's machines under one display
   *  name and so cannot serve a machine/team filter; without this the machine dimension falls back
   *  to a per-session sum, which only covers the sessions still stored individually and therefore
   *  reports far less than the same scope selected by member. Absent on solo. */
  machineStatsCaches?: Record<string, StatsCache>
  /** Team/central only: machine id → its owner (resolved display name) and teams. Resolves a
   *  machine/team/member selection to the exact set of `machineStatsCaches` keys to merge. */
  machineOwners?: Record<string, { user: string; teamIds: string[] }>
  /** Team/central only: live presence per member (resolved display name → status). */
  presence?: Record<string, MemberPresence>
  /** Team/central only: central policy — whether offline members' data is shown by default. */
  includeOfflineData?: boolean
  workflows?: WorkflowRun[]
  /** session_ids open in a live `claude` process right now (computed per-request, not cached).
   *  Empty/absent when live detection is unavailable (e.g. non-Linux host). */
  liveSessionIds?: string[]
  /** Assistants running right now that have no persisted session yet (e.g. an agy that has not
   *  completed its first turn). Carries no metrics — there is nothing measured yet. */
  liveProcesses?: LiveProcess[]
  /** Why this machine cannot observe running assistants AT ALL. Set only when detection is
   *  structurally impossible here (not Linux, no /proc, a container that cannot see the host's
   *  processes, or one whose uid may not read their cwd). An empty list then means "we cannot
   *  know" rather than "nobody is working", and the UI must say which — the same
   *  N/A-versus-a-confident-0 rule `HARNESS_CAPABILITIES` applies to metrics. */
  liveUnavailable?: LiveUnavailableReason
}

/** Why live-session detection cannot work in this configuration. */
export type LiveUnavailableReason =
  /** Not a Linux host — /proc is the only process source this reads. */
  | 'not-linux'
  /** /proc is absent or unreadable. */
  | 'no-proc'
  /** A container that cannot see the host's processes (no `pid: host`). */
  | 'container-isolated'
  /** The host's processes are visible but their cwd may not be read (uid mismatch). */
  | 'permission-denied'
  /** This exposure profile has revoked local host power (`CAPS.localProcesses`). */
  | 'capability-off'

/**
 * Drops any `dailyActivity`/`dailyModelTokens` entry whose `date` is missing or not a string.
 * `stats-cache.json` is written by Claude Code itself (or restored from an archive snapshot) —
 * an interrupted write or a stale schema can leave one entry without a usable date, and every
 * consumer downstream (`.sort((a,b) => a.date.localeCompare(b.date))`, `Map` keyed by `d.date`,
 * `parseISO(d.date)`) assumes a valid string. One bad entry must not be able to throw and take
 * the whole `/api/data` response — or the whole dashboard render — down with it. Mutates and
 * returns the same object; never throws.
 */
export function sanitizeStatsCache(sc: StatsCache): StatsCache {
  sc.dailyActivity = (sc.dailyActivity ?? []).filter(d => typeof d?.date === 'string' && d.date.length > 0)
  sc.dailyModelTokens = (sc.dailyModelTokens ?? []).filter(d => typeof d?.date === 'string' && d.date.length > 0)
  return sc
}

/** An empty statsCache with all zero/neutral fields. Pure. */
export function emptyStatsCache(): StatsCache {
  return {
    version: 1,
    lastComputedDate: '',
    dailyActivity: [],
    dailyModelTokens: [],
    modelUsage: {},
    totalSessions: 0,
    totalMessages: 0,
    longestSession: { sessionId: '', duration: 0, messageCount: 0, timestamp: '' },
    firstSessionDate: '',
    hourCounts: {},
    totalSpeculationTimeSavedMs: 0,
  }
}

/**
 * Merge (sum) several statsCaches into one. Pure. Used by the central to combine the
 * selected members' per-member statsCaches so KPIs match each machine exactly.
 * - dailyActivity / dailyModelTokens / modelUsage / hourCounts: summed by key
 * - totals: summed; longestSession: max by duration
 * - firstSessionDate: earliest non-empty; lastComputedDate: latest
 */
export function mergeStatsCaches(caches: StatsCache[]): StatsCache {
  const out = emptyStatsCache()
  const daily = new Map<string, DailyActivity>()
  const dmt = new Map<string, Record<string, number>>()

  for (const c of caches) {
    if (!c) continue
    for (const d of c.dailyActivity ?? []) {
      const cur = daily.get(d.date) ?? { date: d.date, messageCount: 0, sessionCount: 0, toolCallCount: 0 }
      cur.messageCount += d.messageCount ?? 0
      cur.sessionCount += d.sessionCount ?? 0
      cur.toolCallCount += d.toolCallCount ?? 0
      daily.set(d.date, cur)
    }
    for (const d of c.dailyModelTokens ?? []) {
      const cur = dmt.get(d.date) ?? {}
      for (const [m, t] of Object.entries(d.tokensByModel ?? {})) cur[m] = (cur[m] ?? 0) + t
      dmt.set(d.date, cur)
    }
    for (const [m, u] of Object.entries(c.modelUsage ?? {})) {
      const cur = out.modelUsage[m] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0 }
      cur.inputTokens += u.inputTokens ?? 0
      cur.outputTokens += u.outputTokens ?? 0
      cur.cacheReadInputTokens += u.cacheReadInputTokens ?? 0
      cur.cacheCreationInputTokens += u.cacheCreationInputTokens ?? 0
      cur.webSearchRequests += u.webSearchRequests ?? 0
      cur.costUSD += u.costUSD ?? 0
      out.modelUsage[m] = cur
    }
    for (const [h, n] of Object.entries(c.hourCounts ?? {})) out.hourCounts[h] = (out.hourCounts[h] ?? 0) + n
    out.totalSessions += c.totalSessions ?? 0
    out.totalMessages += c.totalMessages ?? 0
    out.totalSpeculationTimeSavedMs += c.totalSpeculationTimeSavedMs ?? 0
    if ((c.longestSession?.duration ?? 0) > out.longestSession.duration) out.longestSession = c.longestSession
    if (c.firstSessionDate && (!out.firstSessionDate || c.firstSessionDate < out.firstSessionDate)) out.firstSessionDate = c.firstSessionDate
    if (c.lastComputedDate && c.lastComputedDate > out.lastComputedDate) out.lastComputedDate = c.lastComputedDate
    out.version = Math.max(out.version, c.version ?? 1)
  }

  out.dailyActivity = Array.from(daily.values()).sort((a, b) => a.date.localeCompare(b.date))
  out.dailyModelTokens = Array.from(dmt.entries()).map(([date, tokensByModel]) => ({ date, tokensByModel })).sort((a, b) => a.date.localeCompare(b.date))
  return out
}

export type DateRange = '7d' | '30d' | '90d' | 'all'

export interface Filters {
  dateRange: DateRange
  customStart: string
  customEnd: string
  projects: string[]   // empty = all projects
  repos?: string[]     // empty/undefined = all repos; [''] targets the "no linked repo" bucket
  users?: string[]     // empty/undefined = all users (member = user; scoped to users with machines)
  teams?: string[]     // central: empty/undefined = all teams; matches session.teamId
  machines?: string[]  // central: empty/undefined = all machines; matches session.memberId (token hash)
  tags?: string[]      // central: empty/undefined = all; a tag narrows to its resolved sessions (tag ids)
  models: string[]     // empty = all models
  harness?: HarnessId
  harnesses?: HarnessId[]  // multi-select harness filter; empty/undefined = all harnesses
  presence?: 'online' | 'offline'  // team/central: filter members by live status; undefined = policy default
}

export type Lang = 'pt' | 'en'
export type Theme = 'dark' | 'light'

export const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  // Current models — verified against platform.claude.com/docs/en/about-claude/pricing 2026-07-27.
  'claude-fable-5':             { input: 10,   output: 50,   cacheRead: 1.00, cacheWrite: 12.50 },
  'claude-mythos-5':            { input: 10,   output: 50,   cacheRead: 1.00, cacheWrite: 12.50 },
  'claude-opus-5':              { input: 5,    output: 25,   cacheRead: 0.50, cacheWrite: 6.25  },
  'claude-opus-4-8':            { input: 5,    output: 25,   cacheRead: 0.50, cacheWrite: 6.25  },
  'claude-opus-4-7':            { input: 5,    output: 25,   cacheRead: 0.50, cacheWrite: 6.25  },
  // Sonnet 5 is on introductory pricing ($2/$10) through 2026-08-31, then $3/$15. The introductory
  // rate is what applies today; revisit on that date.
  'claude-sonnet-5':            { input: 2,    output: 10,   cacheRead: 0.20, cacheWrite: 2.50  },
  'claude-opus-4-6':            { input: 5,    output: 25,   cacheRead: 0.50, cacheWrite: 6.25  },
  'claude-sonnet-4-6':          { input: 3,    output: 15,   cacheRead: 0.30, cacheWrite: 3.75  },
  'claude-haiku-4-5-20251001':  { input: 1,    output: 5,    cacheRead: 0.10, cacheWrite: 1.25  },
  // Legacy models
  'claude-opus-4-5-20251101':   { input: 5,    output: 25,   cacheRead: 0.50, cacheWrite: 6.25  },
  'claude-opus-4-1-20250805':   { input: 15,   output: 75,   cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-opus-4-20250514':     { input: 15,   output: 75,   cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-sonnet-4-5-20250929': { input: 3,    output: 15,   cacheRead: 0.30, cacheWrite: 3.75  },
  'claude-sonnet-4-20250514':   { input: 3,    output: 15,   cacheRead: 0.30, cacheWrite: 3.75  },
  'claude-haiku-3-5-20241022':  { input: 0.80, output: 4,    cacheRead: 0.08, cacheWrite: 1.00  },
  'claude-3-haiku-20240307':    { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.30  },
  // Google (Gemini CLI, Antigravity CLI) — verified from ai.google.dev/gemini-api/docs/pricing
  // (3.6/lite rows re-checked 2026-07-27; the rest 2026-06-22).
  // Gemini has no separate cache-write charge; cacheWrite is set to the input rate
  // and is unused in practice.
  // Key order is irrelevant: getModelPrice matches exactly first, then takes the LONGEST key that
  // is a prefix of the id (so `gemini-3.5-flash-lite-x` beats `gemini-3.5-flash` no matter where
  // the rows sit). Antigravity reports suffixed ids like `gemini-3.6-flash-tiered`, which the
  // prefix match resolves correctly.
  'gemini-3.6-flash':       { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.5  },
  'gemini-3.5-flash-lite':  { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3  },
  'gemini-3.5-flash':       { input: 1.5, output: 9,   cacheRead: 0.15, cacheWrite: 1.5  },
  'gemini-3.1-flash-lite':  { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0.25 },
  'gemini-3.1-pro':         { input: 2,   output: 12,  cacheRead: 0.20, cacheWrite: 2    },
  'gemini-3-flash-preview': { input: 0.5, output: 3,   cacheRead: 0.05, cacheWrite: 0.5  },
  'gemini-3-flash':         { input: 0.5, output: 3,   cacheRead: 0.05, cacheWrite: 0.5  },
  'gemini-2.5-flash':       { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3  },
  // OpenAI (Codex CLI, Copilot CLI) — verified against developers.openai.com/api/docs/pricing.
  // 5.6 rows added and 5.5/5.4 rows re-checked 2026-07-27; the rest dated 2026-06-20.
  // `gpt-5` and `gpt-5-mini` are no longer on the page — they are kept as legacy rows for old
  // sessions. They are also why the 5.6 rows matter: without them `gpt-5.6-terra` prefix-matched
  // `gpt-5` and was priced at 1.25/10 instead of 2.5/15, halving every Codex session's cost.
  // OpenAI has no separate cache-write charge; cacheWrite is set to the input rate
  // and is unused in practice (the Codex parser always sets cache_creation tokens to 0).
  'gpt-5.6-sol':    { input: 5,    output: 30, cacheRead: 0.50,  cacheWrite: 5    },
  'gpt-5.6-terra':  { input: 2.5,  output: 15, cacheRead: 0.25,  cacheWrite: 2.5  },
  'gpt-5.6-luna':   { input: 1,    output: 6,  cacheRead: 0.10,  cacheWrite: 1    },
  'gpt-5.5':        { input: 5,    output: 30, cacheRead: 0.50,  cacheWrite: 5    },
  'gpt-5.4-mini':   { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
  'gpt-5.4':        { input: 2.5,  output: 15, cacheRead: 0.25,  cacheWrite: 2.5  },
  'gpt-5-mini':     { input: 0.25, output: 2,  cacheRead: 0.025, cacheWrite: 0.25 },
  'gpt-5':          { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
}

/**
 * Price for a model id. Resolution order — deliberate, and independent of key order:
 *  1. exact match;
 *  2. the LONGEST pricing key the id starts with — a provider suffix on a known model
 *     (`gemini-3.6-flash-tiered`, `claude-opus-4-6-thinking`) resolves to that model, and the most
 *     specific key always wins (`gemini-3.5-flash-lite-preview` → Lite, not plain Flash);
 *  3. the reverse case — a TRUNCATED id that is a prefix of a key (`claude-haiku-4-5` →
 *     `claude-haiku-4-5-20251001`). The match must land on a `-` boundary, and among the
 *     candidates the SHORTEST key wins, so a truncated family id can never be resolved to a
 *     cheaper `-lite`/variant price than the plain model it names (`gemini-3.5` →
 *     `gemini-3.5-flash`, never `gemini-3.5-flash-lite`);
 *  4. otherwise the Sonnet-class fallback.
 */
/** The `YYYY-MM-DD` day a session belongs to, from a `start_time` of unknown shape.
 *
 *  `SessionMeta.start_time` is a STRING by contract, but an adapter can get that wrong: Kimi wrote
 *  an epoch NUMBER, it reached the consolidate store as written, and the first consumer to call
 *  `.slice(0, 10)` on it threw — turning one malformed session into a 500 for the entire /api/data
 *  response, and a dashboard that would not load at all.
 *
 *  Fixing the adapter is the real fix (see `isoFromKimiTime`). This is the second line: a single bad
 *  row must never be able to blank the product for every other row. Returns '' when there is no day
 *  to be had, which every caller already treats as "skip this session". */
export function sessionDay(startTime: unknown): string {
  if (typeof startTime === 'string') return startTime.slice(0, 10)
  if (typeof startTime === 'number' && Number.isFinite(startTime) && startTime > 0) {
    const d = new Date(startTime)
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
  }
  return ''
}

/** Coerce a session's timestamps to the STRING shape `SessionMeta` declares, in place.
 *
 *  `start_time` is a string by contract, but an adapter can get it wrong — Kimi wrote an epoch
 *  NUMBER — and once that reaches the consolidate store it is on disk, so fixing the adapter does
 *  not repair what was already written. Every later consumer then calls a string method on it
 *  (`.slice`, `.localeCompare`) and throws, which is how one malformed session produced a 500 for
 *  the entire /api/data response.
 *
 *  Normalising at the boundary — where sessions ENTER the pipeline — is what keeps that from being
 *  a hunt through every call site. Anything unusable becomes '', which the pipeline already treats
 *  as "no start time". */
export function normalizeSessionTimes<T extends { start_time?: unknown; end_time?: unknown }>(s: T): T {
  const iso = (v: unknown): string | undefined => {
    if (typeof v === 'string') return v
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      const d = new Date(v)
      return Number.isNaN(d.getTime()) ? '' : d.toISOString()
    }
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString()
    return v === undefined ? undefined : ''
  }
  const start = iso(s.start_time)
  if (start !== undefined) (s as { start_time?: unknown }).start_time = start
  const end = iso(s.end_time)
  if (end !== undefined) (s as { end_time?: unknown }).end_time = end
  return s
}

export function getModelPrice(modelId: string) {
  if (MODEL_PRICING[modelId]) return MODEL_PRICING[modelId]
  // A model served off the user's own machine costs nothing. Checked BEFORE the table so no
  // partial-prefix match can price it, and before the fallback, which would otherwise invent
  // spending that grows with every local session. See local-models.ts.
  if (isLocalModelId(modelId)) return LOCAL_MODEL_PRICE
  const id = String(modelId ?? '')
  let forwardKey = ''
  let reverseKey = ''
  for (const key of Object.keys(MODEL_PRICING)) {
    if (id.startsWith(key)) {
      // Most specific (longest) prefix wins.
      if (key.length > forwardKey.length) forwardKey = key
    } else if (id && key.startsWith(id) && key[id.length] === '-') {
      // Truncated id: least specific (shortest) candidate wins — never a `-lite`/variant price.
      if (!reverseKey || key.length < reverseKey.length) reverseKey = key
    }
  }
  const hit = forwardKey || reverseKey
  if (hit) return MODEL_PRICING[hit]!
  return { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
}

/** Empty per-model usage accumulator. */
export function emptyModelUsage(): ModelUsage {
  return {
    inputTokens: 0, outputTokens: 0,
    cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    webSearchRequests: 0, costUSD: 0,
  }
}

/**
 * Per-model token usage of ONE session, as `[modelId, usage]` pairs.
 *
 * Multi-model sessions (an Antigravity parent with its folded subagent children) carry the
 * authoritative breakdown in `model_usage`; everything else is a single entry keyed by `model`
 * (or `fallbackModel` when the session has none). Returns `[]` when the session cannot be priced
 * at all — the caller then falls back to a blended rate.
 */
export function sessionModelUsage(
  s: Pick<SessionMeta, 'model' | 'model_usage' | 'input_tokens' | 'output_tokens'
    | 'cache_read_input_tokens' | 'cache_creation_input_tokens'>,
  fallbackModel?: string,
): [string, ModelUsage][] {
  const breakdown = s.model_usage
  if (breakdown && typeof breakdown === 'object') {
    const entries = Object.entries(breakdown).filter(([m, u]) => m && u)
    if (entries.length > 0) return entries as [string, ModelUsage][]
  }
  const model = s.model || fallbackModel || ''
  if (!model) return []
  return [[model, {
    inputTokens: s.input_tokens ?? 0,
    outputTokens: s.output_tokens ?? 0,
    cacheReadInputTokens: s.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: s.cache_creation_input_tokens ?? 0,
    webSearchRequests: 0,
    costUSD: 0,
  }]]
}

/** Cost of ONE session, priced per model (see {@link sessionModelUsage}).
 *  Returns null when the session has no model at all — the caller decides the blended fallback. */
export function sessionCostUSD(
  s: Parameters<typeof sessionModelUsage>[0],
  fallbackModel?: string,
): number | null {
  const entries = sessionModelUsage(s, fallbackModel)
  if (entries.length === 0) return null
  return entries.reduce((sum, [model, u]) => sum + calcCost(u, model), 0)
}

export function calcCost(usage: ModelUsage, modelId: string): number {
  const price = getModelPrice(modelId)
  return (
    (usage.inputTokens / 1_000_000) * price.input +
    (usage.outputTokens / 1_000_000) * price.output +
    (usage.cacheReadInputTokens / 1_000_000) * price.cacheRead +
    (usage.cacheCreationInputTokens / 1_000_000) * price.cacheWrite
  )
}

export function formatModel(modelId: string): string {
  const map: Record<string, string> = {
    'claude-opus-4-7': 'Opus 4.7',
    'claude-opus-4-6': 'Opus 4.6',
    'claude-opus-4-5-20251101': 'Opus 4.5',
    'claude-sonnet-4-6': 'Sonnet 4.6',
    'claude-sonnet-4-5-20250929': 'Sonnet 4.5',
    'claude-haiku-4-5-20251001': 'Haiku 4.5',
    'gpt-5.5': 'GPT-5.5',
    'gpt-5.4': 'GPT-5.4',
    'gpt-5.4-mini': 'GPT-5.4 mini',
    'gpt-5': 'GPT-5',
    'gpt-5-mini': 'GPT-5 mini',
    'gemini-3.6-flash': 'Gemini 3.6 Flash',
    'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
    'gemini-3.5-flash': 'Gemini 3.5 Flash',
    'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite',
    'gemini-3.1-pro': 'Gemini 3.1 Pro',
    'gemini-3-flash-preview': 'Gemini 3 Flash',
    'gemini-3-flash': 'Gemini 3 Flash',
    'gemini-2.5-flash': 'Gemini 2.5 Flash',
  }
  return map[modelId] ?? modelId
}

/**
 * Display form of a project path: the FULL path, always.
 *
 * It used to collapse the home directory to `~`, which reads fine on a single machine and is
 * actively misleading anywhere else: on a central the same `~/app` can be three different people's
 * folders, and `~` is resolved against the CENTRAL's home, not the machine the session came from.
 * The username is part of what identifies a path, so it is never hidden.
 */
export function formatProjectName(projectPath: string): string {
  if (!projectPath) return 'Unknown'
  return projectPath.replace(/\\/g, '/')
}

/**
 * Just the project's folder name — for places where the full path does not fit and would be
 * ellipsized into uselessness ("/home/mithrandir/agenti…"). The path itself belongs in the
 * tooltip, never dropped: two machines can each have a `web` folder.
 */
export function projectFolder(projectPath: string): string {
  const norm = formatProjectName(projectPath).replace(/\/+$/, '')
  if (norm === 'Unknown') return norm
  return norm.slice(norm.lastIndexOf('/') + 1) || norm
}

export function getModelColor(modelId: string): string {
  if (modelId.includes('opus')) return '#D97706'
  if (modelId.includes('sonnet')) return '#6366f1'
  if (modelId.includes('haiku')) return '#10b981'
  if (modelId.startsWith('gpt-')) return '#10a37f' // OpenAI green
  if (modelId.startsWith('gemini')) return '#4285f4' // Google blue
  return '#8b5cf6'
}

/**
 * Normalize a git remote URL into a stable, protocol-less grouping key of the form
 * `host/org/repo` (e.g. `github.com/org/repo`). Pure — the single source of truth for
 * how the "group by repository" dimension is keyed across the whole app.
 *
 * Collapses the many shapes a single repo's remote can take into one canonical value:
 *   - `https://github.com/org/repo.git`            → `github.com/org/repo`
 *   - `git@github.com:org/repo.git`                → `github.com/org/repo`   (scp-style)
 *   - `ssh://git@github.com:22/org/repo`           → `github.com/org/repo`
 *   - `https://x-access-token:ghs_…@github.com/o/r`→ `github.com/o/r`        (CI creds stripped)
 *
 * Rules: strip the scheme, embedded credentials, and any `:port`; lowercase the host (hosts
 * are case-insensitive) while preserving the path case; drop a trailing `.git` and slashes.
 * Returns `''` for anything without a host + path (local paths, `file://`, junk) so callers
 * can treat "no usable remote" uniformly.
 */
export function normalizeGitRemote(raw: string | undefined | null): string {
  if (!raw) return ''
  let s = String(raw).trim()
  if (!s) return ''

  // scp-style `user@host:org/repo` (no scheme) — the colon separates host from path.
  const scp = s.match(/^[^/@]+@([^/:]+):(.+)$/)
  if (scp && !s.includes('://')) {
    s = `${scp[1]}/${scp[2]}`
  } else {
    s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '') // scheme://
    s = s.replace(/^[^/@]*@/, '')                       // user[:pass]@
  }

  // Drop a numeric :port immediately after the host.
  s = s.replace(/^([^/]+):(\d+)\//, '$1/')

  const slash = s.indexOf('/')
  if (slash <= 0) return '' // no host or no path → not a groupable remote
  const host = s.slice(0, slash).toLowerCase()
  const path = s.slice(slash + 1).replace(/\/+$/, '').replace(/\.git$/i, '')
  if (!host || !path) return ''
  return `${host}/${path}`
}

/** Short display label for a normalized remote: `org/repo` (drops the host). Pure. */
export function repoShortName(remote: string): string {
  if (!remote) return ''
  const parts = remote.split('/').filter(Boolean)
  return parts.length <= 1 ? remote : parts.slice(1).join('/')
}
