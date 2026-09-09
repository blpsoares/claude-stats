# Nay — AI Chat Assistant

Nay is an AI chat assistant built into the agentistics dashboard. It connects directly to your usage data via MCP tools and can answer questions about your spending, projects, sessions, and layouts without you having to leave the dashboard.

## How it works

Nay runs as a floating chat panel (bottom-right corner of any page). When you send a message, the dashboard calls Claude Code CLI (`claude --print`) in a sandboxed workspace at `~/.agentistics/nay-chat/`. Claude has access to 13 MCP tools that talk directly to the agentistics API, so every answer is backed by your real data.

```
Your message
  → /api/chat-tty (POST)
    → claude --print --output-format stream-json
      → agentistics MCP tools → /api/data, /api/rates, etc.
    → streamed JSON events (text chunks + tool calls)
  → rendered in the chat panel
```

## Requirements

- **Claude Code CLI** installed and authenticated (`claude --version`)
- **agentistics server running** — Nay calls MCP tools that talk to the local API
- **Claude subscription** — Nay uses your Claude Code session quota (see [usage warning](#subscription-and-quota-usage) below)

## Subscription and quota usage

> **Important:** Every Nay conversation counts against your Claude Code subscription usage.
>
> Nay runs `claude --print` under the hood, which is the same Claude Code process used for coding. Each message sends your conversation history + tool results to the API, and this is billed/counted exactly like a regular Claude Code session.
>
> - **Claude Max / Pro subscribers**: usage comes out of your monthly session quota
> - **API key users**: each message is billed at standard Claude API rates for the selected model
>
> Prefer **Haiku 4.5** for quick data queries (cheapest). Use **Sonnet 4.6** for analysis and layout building. **Opus 4.7** for complex multi-step reasoning.

## Model selection

The first time you open Nay, a model picker screen appears. You can change the model at any time by starting a new conversation (clear chat → model picker reappears).

| Model | Speed | Best for | Input / Output |
|-------|-------|----------|----------------|
| Haiku 4.5 | Fastest | Quick data lookups | $0.80 / $4.00 per 1M |
| Sonnet 4.6 | Balanced | Analysis, layout building | $3.00 / $15.00 per 1M |
| Opus 4.7 | Most capable | Complex reasoning | $15.00 / $75.00 per 1M |

## Nay's identity

Nay presents herself as **Nay**, the agentistics analytics assistant — not as "Claude" or "an AI by Anthropic". When asked "who are you?", she introduces herself as:

> *Nay — assistente de analytics integrada ao agentistics. Analiso uso do Claude Code: custos, tokens, sessões, projetos e métricas de produtividade.*

This is enforced via the `CLAUDE.md` written to `~/.agentistics/nay-chat/` on every server start.

## What Nay can answer

| Question | What it calls |
|----------|--------------|
| "How much did I spend this month?" | `agentistics_summary`, `agentistics_costs` |
| "Which project cost the most?" | `agentistics_projects` |
| "What were my most expensive sessions?" | `agentistics_sessions` |
| "Build me a cost overview layout" | `agentistics_component_catalog`, `agentistics_build_layout` |
| "Show me my cache hit rate" | `agentistics_summary` |
| "Generate a PDF of my last 30 days" | `agentistics_export_pdf` |
| "How much have I spent talking to you?" | `agentistics_projects` filtered to `nay-chat` |

### "How much have I spent talking to you?"

When the user asks about the cost of conversations with Nay specifically, Nay calls `agentistics_projects` and filters to the project at path `~/.agentistics/nay-chat`. This is where Nay's own sessions are stored and tracked.

For general Claude Code usage across all projects, Nay uses `agentistics_summary` or the full project list.

## PDF report generation

Nay can generate a PDF report through a conversational flow:

1. User asks: "Generate a PDF" or "Export a report"
2. Nay asks for the date range if not specified: "Qual período? 7 dias, 30 dias, 90 dias, ou tudo?"
3. User answers (e.g., "30 days")
4. Nay calls `agentistics_export_pdf` with `range: "30d"`
5. A styled **Download PDF** button appears in the chat

The button uses the `pdf:URL` link protocol, which the Nay chat renders as an orange download button. Clicking it opens the PDF export modal pre-configured with the requested settings.

## Navigation buttons

Nay ends data responses with a navigation button that links to the relevant dashboard page. If the response is about a specific project, the link includes a `?projects=...` filter parameter.

Examples:
- `→ Ver custos` → `/costs`
- `→ Ver projetos` → `/?projects=/home/user/my-project`
- `→ Abrir layout` → `/custom`

These are rendered as purple inline buttons in the chat.

## Terminal commands

You can also run shell commands directly from Nay:

```
/run ls -la ~/.claude/
/bash git log --oneline -5
/sh df -h
```

Code blocks in Nay responses with bash/shell language tags include a **Run** button to execute the command inline.

## Floating window (detach)

Nay can be detached from the side panel into a free-floating window:

- Click the **⧉** (ExternalLink) icon in the Nay panel header to detach
- The floating window can be dragged and resized
- Click **−** (Minus) in the floating header to minimize
- When minimized, a small **Nay mini FAB** appears above the main corner button — click it to restore the floating window
- Click the re-attach icon to dock Nay back into the panel

### FAB layout when Nay is detached

| State | Corner button | Mini FAB |
|-------|--------------|----------|
| Floating, visible | Shows ⧉ icon (opens panel for Claude) | — |
| Floating, minimized | Shows ⧉ icon (opens panel for Claude) | Nay logo circle, above corner button |

## Workspace setup

On every server start, `ensureNayChat()` writes two files to `~/.agentistics/nay-chat/`:

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Instructions for Nay: identity, tool call protocol, PDF generation flow, "talking to me" context, response format, navigation buttons |
| `.claude/settings.json` | MCP server registration + permissions (allows all 13 agentistics tools without prompting) |

It also registers the agentistics MCP at user scope via `claude mcp add -s user` so that `claude --print` mode can find the tools. This registration is idempotent — it skips if the URL is already correct.

## Behavior rules (enforced via CLAUDE.md)

1. **Identity** — always presents as Nay, not as Claude or a generic AI
2. **Never answer from memory** — calls tools for every question, even follow-ups
3. **Never describe what it's about to do** — calls tools immediately, no "Let me check..."
4. **Never reference "the Nay agent"** — it has direct tool access, uses it
5. **Navigation button only when data was fetched** — no button for conversational replies
6. **"Talking to me" = nay-chat project** — cost queries about Nay specifically filter to `~/.agentistics/nay-chat`
7. **PDF flow** — asks for date range before calling `agentistics_export_pdf`

## See also

- [MCP tools reference](./mcp.md) — full list of tools Nay uses
- [Architecture](./architecture.md) — how `chat-tty.ts` streams Claude output
