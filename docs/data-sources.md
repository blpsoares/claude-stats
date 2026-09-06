# Data Sources

agentistics reads data exclusively from local files written by Claude Code. No data ever leaves your machine.

## File paths

| Source | Path | Description |
|--------|------|-------------|
| **Stats Cache** | `~/.claude/stats-cache.json` | Pre-computed aggregates: daily activity, tokens per model, streak |
| **Session Meta** | `~/.claude/usage-data/session-meta/*.json` | Detailed per-session metadata — preferred source |
| **Raw JSONL** | `~/.claude/projects/**/*.jsonl` | Raw conversation logs — used as fallback and for agent metrics |
| **Local Git** | `git log --numstat` | Commits, files, and line counts within each session's time window |

## Data flow

```
~/.claude/
  ├── stats-cache.json
  ├── usage-data/session-meta/
  └── projects/**/*.jsonl
         ↓
    server/data.ts  (buildApiResponse — main orchestrator)
    server/agent-metrics.ts  (extractAgentMetrics — parses Agent tool_use)
         ↓
    /api/data  →  useData()  →  useDerivedStats()  →  React components
```

## Session sources

Sessions can come from three sources, indicated by the `_source` field:

| Source | `_source` | Data quality |
|--------|-----------|-------------|
| Session-meta JSON | `'meta'` | Most complete — has all fields including cache tokens, tool breakdown, and agent metrics |
| Direct JSONL parse | `'jsonl'` | Good — parsed on the fly from raw conversation files |
| Subdirectory scan | `'subdir'` | Partial — limited fields, no git line counts or cache tokens |

`'meta'` sessions are always preferred. `'jsonl'` and `'subdir'` fill in sessions where metadata is not available.

## JSONL parsing pipeline

When session-meta is absent, `server/jsonl.ts` parses each `.jsonl` file line by line:

```
.jsonl file
  ├── Extracts start_time and duration (first + last message timestamps)
  ├── Counts user messages (excluding tool_result)
  ├── Counts assistant messages (type: 'assistant')
  ├── Maps tool_use → tool_counts { Bash: N, Read: N, Edit: N, ... }
  ├── Attributes output tokens per tool (tool_output_tokens)
  ├── Detects agent instruction file reads (CLAUDE.md, AGENTS.md, etc.)
  ├── Extracts tokens from usage field (input, output, cacheRead, cacheWrite)
  ├── Detects commits: regex /^git commit\b/ in Bash inputs
  ├── Detects pushes: regex /^git push\b/ in Bash inputs
  ├── Detects languages by file extension (Read, Edit, Write tool paths)
  ├── Counts files Claude directly modified (unique paths from Edit/Write/MultiEdit calls)
  ├── Counts tool errors (tool_result.is_error = true)
  ├── Captures first prompt (first 200 chars)
  ├── Records message hours (array 0–23)
  └── Returns SessionMeta object (files_modified = max(git-based, claude-direct-edits))
```

## SessionMeta structure

```typescript
interface SessionMeta {
  session_id: string               // Session UUID
  project_path: string             // Absolute project directory path
  start_time: string               // ISO 8601
  duration_minutes: number         // Total duration
  user_message_count: number       // Actual user messages
  assistant_message_count: number  // Model responses
  tool_counts: Record<string, number>         // e.g.: { Bash: 12, Read: 8 }
  tool_output_tokens: Record<string, number>  // Output tokens attributed per tool
  agent_file_reads: Record<string, number>    // Agent instruction file reads
  languages: string[]              // Detected coding languages
  git_commits: number              // Commits via AI assistant
  git_pushes: number               // Pushes via AI assistant
  input_tokens: number             // Tokens sent to the model
  output_tokens: number            // Tokens generated
  cache_read_tokens: number        // Tokens served from prompt cache
  cache_write_tokens: number       // Tokens written to prompt cache
  lines_added: number              // Lines added (git)
  lines_removed: number            // Lines removed (git)
  files_modified: number           // Unique files modified
  message_hours: number[]          // Message turn hours (0–23)
  first_prompt: string             // First 200 chars of the first user message
  tool_errors: number              // Total tool errors
  uses_task_agent: boolean         // Used Task/Agent sub-agent tool
  uses_mcp: boolean                // Used MCP tools
  model?: string                   // Model ID (if available)
  _source: 'meta' | 'jsonl' | 'subdir'
}
```

## Stats cache limitations

`~/.claude/stats-cache.json` is written by Claude Code and has **no project-level granularity**. Project breakdowns are computed by agentistics by summing individual sessions grouped by `project_path`.

`dailyModelTokens` in the stats cache stores per-day/per-model totals but not the input/output split per day. When filtering by date, the global model usage proportions (input% / output%) are used as an approximation for the split.

## Agent metrics

Agent metrics are extracted from raw JSONL by `server/agent-metrics.ts`. They are only available for sessions whose JSONL files are accessible (`_source: 'meta'`-only sessions may have incomplete agent data if the underlying JSONL was removed).

### Two transcript shapes, and only one of them holds the numbers

Claude Code made the `Agent` tool **asynchronous on 2026-08-14**, and the shape of the result it
writes into the parent transcript changed with it. Both are read.

**Legacy (until 2026-08-13)** — the numbers were inline, and the reader took them from there:

| Field | Source in JSONL |
|---|---|
| `agentType` | `toolUseResult.agentType` |
| `description` | `tool_use.input.description` |
| `totalTokens` | `toolUseResult.totalTokens` |
| `totalDurationMs` | `toolUseResult.totalDurationMs` |
| `totalToolUseCount` | `toolUseResult.totalToolUseCount` |
| `inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens` | `toolUseResult.usage.*` |
| `toolStats` | `toolUseResult.toolStats` |
| `costUSD` | Calculated via `calcCost()` |
| `status` | `toolUseResult.status` |

**Current (2026-08-14 onward)** — the parent's result carries no numbers at all, only a name:

```json
{ "agentId": "a23c974fb8aab9fbf", "description": "Task 1: backup-plan.ts", "isAsync": true,
  "status": "async_launched", "resolvedModel": "claude-haiku-4-5-20251001",
  "outputFile": "/tmp/.../tasks/a23c974fb8aab9fbf.output", "canReadOutputFile": true }
```

The numbers moved into the subagent's **own transcript**, at
`~/.claude/projects/<project>/<session-id>/subagents/agent-<agentId>.jsonl`, with an
`agent-<agentId>.meta.json` beside it carrying `agentType`, `description` and the parent's
`toolUseId`. `server/subagent-parse.ts` (pure) sums one such transcript and
`server/subagent-metrics.ts` finds it, follows nested subagents and memoizes the result.

Three rules that fall out of the new shape:

- **`outputFile` is not used.** It points into the run's scratch directory under `/tmp`, holds the
  agent's text answer rather than its accounting, and is routinely already gone. The durable file is
  the one under `subagents/`.
- **Each model is priced at its own rate.** A subagent commonly runs `haiku` under an `opus` parent
  (four distinct models were measured across 440 subagent transcripts on one machine), so pricing an
  invocation with the parent's model id bills a cheap agent as an expensive one.
- **A nested subagent counts inside the invocation that spawned it.** Only a top-level `Agent`
  `tool_use` becomes an `AgentInvocation`, so a subtree left out here is left out of the session's
  agent totals entirely. The walk is cycle-safe.

### An invocation whose transcript is gone reports N/A, never zero

Claude Code deletes transcripts after `cleanupPeriodDays`. When a subagent's transcript cannot be
read, the invocation is still listed — the parent recorded that it happened — and is marked
`AgentInvocation.unmeasured: true`. Consumers **must read that flag before any figure on the
record**: an unmeasured invocation carries zeros because the type has no other value to carry.
`SessionAgentMetrics.totalTokens` / `totalDurationMs` / `totalCostUSD` exclude them and
`unmeasuredInvocations` counts them, so a surface can say the totals cover fewer invocations than it
is showing. This is the same rule `HARNESS_CAPABILITIES` applies to a metric a harness cannot
produce, applied to one row.

### What is NOT tracked for Skills and Tasks

- **Skills** (`/commit`, `/review-pr`, etc.) do not produce individual `tool_use` events in JSONL — only a `skill_listing` attachment appears. Skill invocations can only be inferred indirectly from subsequent tool calls.
- **Tasks** (`TaskCreate` / `TaskUpdate`) have subject/description/status but no token or duration breakdown.

## Git data

Git stats are computed by running:

```bash
git -C <project_path> log --numstat --after="<session_start>" --before="<session_end>"
```

This produces: commits count, files modified, lines added, lines removed.

Git stats are only available for sessions whose `project_path` is an accessible git repository at query time.

### Workspace folder fallback

`getProjectGitStats` in `server/git.ts` first tries the project path as a single git repo. If that fails (the path is not itself a git repo), it falls back to scanning one level of subdirectories and aggregating stats across all git repos found there. This handles workspace folders (e.g. `~/zuke`) that contain multiple sub-repos.

### files_modified counting

`server/jsonl.ts` tracks a `claudeFilesModified` Set of unique file paths from Edit, Write, and MultiEdit tool calls. The final `files_modified` value is `Math.max(gitFileStats.filesModified, claudeFilesModified.size)`, whichever is higher. This ensures files Claude edited in non-git directories are still counted.

The FILES KPI in `useData.ts` always prefers session-level `files_modified` (which captures direct Claude edits). It only falls back to project-level `git_stats.files_modified` when sessions show 0.
