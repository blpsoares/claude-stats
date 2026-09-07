# agentistics MCP Server

The agentistics MCP server exposes your usage analytics as tools that any MCP-compatible client can call — including Claude Code, Nay (the built-in chat), and any third-party agent that supports MCP.

## What is MCP?

[Model Context Protocol (MCP)](https://modelcontextprotocol.io/) is an open standard that lets AI models call structured tools defined by external servers. The agentistics MCP server translates the `/api/data` response into a set of typed tools so that AI agents can query your usage data programmatically.

## Starting the MCP server

The MCP server runs as a stdio process. It is **not** a separate HTTP server — it communicates via stdin/stdout with the MCP client (Claude Code, etc.) and makes HTTP calls internally to the agentistics API.

```bash
# agentistics must be running first (provides /api/data)
agentop server

# Then register the MCP (done automatically on first server start, but you can do it manually):
claude mcp add -s user agentistics \
  -e AGENTISTICS_API=http://localhost:47291 \
  -- bun run /path/to/agentistics/packages/mcp/agentistics-mcp.ts
```

The agentistics server registers the MCP automatically at startup via `claude mcp add -s user`. If the registration already exists with the correct URL, it is skipped.

### Verify registration

```bash
claude mcp list
# Should show: agentistics  bun run .../mcp/agentistics-mcp.ts
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENTISTICS_API` | `http://localhost:47291` | Base URL of the agentistics API server |

## Multi-harness scope

agentistics tracks multiple coding harnesses (Claude Code, Codex CLI, Gemini CLI, Copilot CLI). The MCP server reads the same `/api/data` endpoint, so by default its numbers reflect the **unified (all-harness)** view.

- **Per-harness filtering:** `agentistics_summary`, `agentistics_projects`, `agentistics_sessions`, and `agentistics_costs` accept an optional `harness` parameter (`claude` | `codex` | `gemini` | `copilot` | `antigravity`, or `all` — the default). When set, the tool scopes its result to that harness only.
- **Comparison:** `agentistics_harnesses` lists every harness present in the data with its sessions, messages, tokens, estimated cost, and last-active date — the quickest way to answer "which harness do I use most / costs most".
- **Caveats** match the dashboard: `currentStreak` is Claude-only (returned as `null` when scoping to a single non-Claude harness); harnesses that don't emit token usage (e.g. Gemini's local files) contribute 0 tokens/cost; the unified/`claude` cost breakdown comes from the Claude-complete stats-cache, while a specific non-Claude harness's cost breakdown is aggregated per-model from its sessions.
- **Per-session cost is priced per model.** Any `estimatedCostUSD` computed from a session (`agentistics_sessions`, `agentistics_projects`, `agentistics_summary`, `agentistics_harnesses`, `agentistics_repos`) charges each model at its own rate via `sessionCostUSD` from `@agentistics/core` — a session that used more than one model (an Antigravity parent with Gemini/Claude subagent children folded into its `model_usage` breakdown) is never priced as if the whole thing ran at the dominant model's rate. For a single-model session this coincides exactly with the flat calculation.

## Available tools

### `agentistics_summary`

All-time totals aggregated from sessions. Token counts and cost are computed directly from session records (not from the stats-cache snapshot), so they are always accurate even if the cache is stale.

**Parameters:** `harness` *(optional)* — `claude` | `codex` | `gemini` | `copilot` | `antigravity` | `all` (default `all`).

**Returns:**
```json
{
  "harness": "all",
  "totalInputTokens": 12500000,
  "totalOutputTokens": 890000,
  "totalCacheReadTokens": 45000000,
  "totalCacheWriteTokens": 1200000,
  "estimatedCostUSD": 18.42,
  "totalSessions": 142,
  "topModel": "claude-opus-4-8",
  "topProject": "my-app",
  "activeDays": 38,
  "currentStreak": 7
}
```

`currentStreak` is `null` when scoped to a single non-Claude harness (streak is Claude-only).

---

### `agentistics_harnesses`

Side-by-side comparison of every harness present in the data, sorted by total tokens. No parameters.

**Returns:**
```json
[
  {
    "harness": "claude",
    "sessions": 157,
    "messages": 38664,
    "inputTokens": 2467133,
    "outputTokens": 29339498,
    "cacheReadTokens": 5981874127,
    "cacheWriteTokens": 208186404,
    "totalTokens": 6221867162,
    "estimatedCostUSD": 3031.51,
    "lastActive": "2026-06-29T13:52:24.823Z"
  },
  { "harness": "codex", "sessions": 20, "estimatedCostUSD": 0.20, "...": "..." }
]
```

---

### `agentistics_projects`

Per-project breakdown with aggregated token and cost data, sorted by total tokens descending.

**Parameters:** `harness` *(optional)* — scope to one harness, or `all` (default). When scoped, projects with no sessions in that harness are omitted and `sessions` reflects that harness's count.

**Returns:** array of projects
```json
[
  {
    "name": "my-app",
    "path": "/home/user/projects/my-app",
    "sessions": 34,
    "messages": 820,
    "inputTokens": 3200000,
    "outputTokens": 220000,
    "totalTokens": 3420000,
    "estimatedCostUSD": 5.21,
    "lastActive": "2025-01-15T14:30:00Z",
    "languages": ["TypeScript", "CSS"]
  }
]
```

> **Note:** Token/cost data is aggregated from session records grouped by `project_path`. Projects are matched by exact path.

---

### `agentistics_sessions`

Recent sessions with duration, model, and cost.

**Parameters:**
| Name | Type | Default | Description |
|------|------|---------|-------------|
| `limit` | number | 20 | Max sessions to return (1–50) |
| `harness` | string | `all` | Scope to one harness (`claude` \| `codex` \| `gemini` \| `copilot` \| `antigravity`) |

**Returns:** array of sessions sorted by start time descending (each row includes its `harness`)
```json
[
  {
    "id": "abc123",
    "harness": "claude",
    "project": "/home/user/projects/my-app",
    "startedAt": "2025-01-15T14:30:00Z",
    "durationMinutes": 47,
    "messages": 34,
    "inputTokens": 85000,
    "outputTokens": 6200,
    "cacheReadTokens": 310000,
    "cacheWriteTokens": 12000,
    "totalTokens": 413200,
    "estimatedCostUSD": 0.348,
    "model": "claude-sonnet-4-6"
  }
]
```

---

### `agentistics_costs`

Model pricing breakdown and cache analysis.

**Parameters:** `harness` *(optional)* — `all`/`claude` (default) uses the Claude-complete stats-cache; a specific non-Claude harness is aggregated per-model from its sessions.

**Returns:** array of models sorted by total tokens descending
```json
[
  {
    "model": "claude-sonnet-4-6",
    "inputTokens": 8200000,
    "outputTokens": 610000,
    "cacheReadTokens": 31000000,
    "cacheWriteTokens": 1200000,
    "totalTokens": 41010000,
    "estimatedCostUSD": 12.80
  }
]
```

---

### `agentistics_component_catalog`

Lists all dashboard components available for placement on the custom `/custom` page. **Always call this before building a layout.**

**Parameters:**
| Name | Type | Description |
|------|------|-------------|
| `category` | string | Optional filter: `kpi`, `activity`, `costs`, `projects`, `tools`, `sessions` |

**Returns:** array of components with grid sizes and descriptions
```json
[
  {
    "id": "kpi.cost",
    "label": "Estimated cost",
    "category": "kpi",
    "defaultW": 3,
    "defaultH": 3,
    "minW": 2,
    "minH": 2,
    "description": "Estimated USD cost"
  },
  {
    "id": "activity.chart",
    "label": "Activity chart (full)",
    "category": "activity",
    "defaultW": 8,
    "defaultH": 7,
    "minW": 4,
    "minH": 4,
    "description": "Full activity chart with all metrics"
  }
]
```

---

### `agentistics_get_layouts`

Returns all saved custom layouts and which one is currently active.

**Returns:**
```json
{
  "activeLayout": "overview",
  "layouts": [
    {
      "name": "overview",
      "isActive": true,
      "componentCount": 5,
      "components": [
        { "instanceId": "1", "componentId": "kpi.cost", "x": 0, "y": 0, "w": 3, "h": 3 }
      ]
    }
  ]
}
```

---

### `agentistics_build_layout`

Creates a complete layout in one call: creates it, adds all requested components with auto-positioning, and optionally activates it. Ideal for building a themed dashboard from scratch.

Components are positioned using first-fit shelf packing on a 12-column grid. After placement, any component with empty space to its right (no right neighbour in its row range) is extended to fill the full row width.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | yes | Layout name |
| `componentIds` | string[] | yes | Ordered list of component IDs from the catalog |
| `activate` | boolean | no | Set as active layout after creating (default: true) |

**Grid sizing guidelines (from the catalog defaults):**
- KPI cards (`kpi.*`): w=3, h=3 — 4 per row
- Wide charts (`activity.chart`, `tools.*`, `sessions.*`): w=8–12, h=6–8
- Medium panels (`costs.budget`, `costs.cache`, `activity.heatmap`): w=6, h=7
- Full-width (`costs.models`, `sessions.highlights`): w=12, h=6–8
- Projects: `projects.top` w=7, `projects.languages` w=5

Order `componentIds` thoughtfully: KPI cards first, then charts, then tables.

---

### `agentistics_add_component`

Adds a single component to an existing layout. Auto-positioned after existing items unless `x`/`y` are specified.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `layoutName` | string | no | Target layout (defaults to active layout) |
| `componentId` | string | yes | Component ID from the catalog |
| `x` | number | no | Column 0–11 (auto-placed if omitted) |
| `y` | number | no | Row (auto-placed if omitted) |
| `w` | number | no | Width in grid columns (defaults to catalog default) |
| `h` | number | no | Height in grid rows (defaults to catalog default) |

---

### `agentistics_remove_component`

Removes a component by its instance ID from a layout. Get instance IDs from `agentistics_get_layouts`.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `layoutName` | string | no | Layout name (defaults to active layout) |
| `itemId` | string | yes | Instance ID of the item to remove |

---

### `agentistics_create_layout`

Creates a new empty named layout without adding any components.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | yes | Layout name |

---

### `agentistics_set_active_layout`

Switches the `/custom` page to display a different layout.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | yes | Layout name to activate |

---

### `agentistics_delete_layout`

Permanently deletes a layout. Cannot be undone. Cannot delete the last remaining layout.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | yes | Layout name to delete |

---

### `agentistics_export_pdf`

Generates a PDF report download link. Returns a `[⬇ Download PDF](pdf:URL)` link that the Nay chat renders as a styled download button. Clicking it opens the PDF export modal pre-configured with the requested date range.

**Parameters:**
| Name | Type | Default | Description |
|------|------|---------|-------------|
| `range` | string | `"all"` | Date range: `"7d"`, `"30d"`, `"90d"`, or `"all"` |

**Returns:** a markdown button link
```
[⬇ Download PDF — last 30d](pdf:http://localhost:47292/?export=pdf&range=30d)
```

The Nay chat detects the `pdf:` protocol and renders it as an orange download button. Clicking opens the PDF export modal where you can review and download the report.

---

## Using the MCP from Claude Code

Once registered, you can invoke agentistics tools directly from any Claude Code session:

```
# In a Claude Code chat (not Nay), you can ask:
"What's my total spend so far this month according to agentistics?"
"Build me a layout in agentistics with cost KPIs and the activity chart"
"Generate a PDF of my last 30 days usage"
```

Claude Code will automatically use the registered MCP tools. No explicit configuration needed per-project — the registration is at user scope (`~/.claude.json`).

## Using the MCP from a custom agent

```typescript
// Example: calling agentistics tools from a Claude agent
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic()

const response = await client.beta.messages.create({
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  tools: [/* your agentistics MCP tools */],
  messages: [{ role: 'user', content: 'What project spent the most tokens?' }],
})
```

## MCP server implementation

The server lives at `packages/mcp/agentistics-mcp.ts`. It uses the `@modelcontextprotocol/sdk` to expose tools over stdio, fetching data from the agentistics HTTP API (`AGENTISTICS_API`).

Key design decisions:
- **No direct file access** — all data goes through the agentistics API so the same parsing/aggregation logic applies everywhere
- **Cost calculation** — the MCP has its own inline `calcCostUSD` that mirrors `src/lib/types.ts` to avoid bundling the frontend module; totals in `agentistics_summary` are aggregated from sessions (not from the stats-cache snapshot) for accuracy
- **Auto-position algorithm** — `agentistics_build_layout` uses first-fit shelf packing on a 12-column grid, then `fillGaps` extends items that have empty space to their right (no right neighbour in the same row range)
- **PDF links** — `agentistics_export_pdf` returns a `[label](pdf:URL)` markdown link; the Nay chat component detects the `pdf:` protocol and renders it as a download button

## See also

- [Nay chat](./nay.md) — how the built-in AI assistant uses these tools
- [Data sources](./data-sources.md) — what `/api/data` returns and how it's computed
