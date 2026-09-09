import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { HOME_DIR } from './config'

const AGENTISTICS_ROOT = path.resolve(import.meta.dir, '..', '..', '..')
export const NAY_CHAT_DIR = path.join(HOME_DIR, '.agentistics', 'nay-chat')
export const CLAUDE_CHAT_DIR = path.join(HOME_DIR, '.agentistics', 'claude-chat')

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

export const CHAT_MODELS = [
  { id: 'claude-haiku-4-5',   label: 'Haiku 4.5',   badge: 'Fast',     desc: 'Fastest responses, great for quick questions',    inputPer1M: 0.80,  outputPer1M: 4.00  },
  { id: 'claude-sonnet-4-6',  label: 'Sonnet 4.6',  badge: 'Balanced', desc: 'Best balance of speed and intelligence',          inputPer1M: 3.00,  outputPer1M: 15.00 },
  { id: 'claude-opus-4-7',    label: 'Opus 4.7',    badge: 'Powerful', desc: 'Most capable — ideal for complex analysis',       inputPer1M: 15.00, outputPer1M: 75.00 },
] as const

export type ChatModelId = typeof CHAT_MODELS[number]['id']

// Written to ~/.agentistics/nay-chat/CLAUDE.md on every server start
// so git pull + restart always gets the latest instructions.
const NAY_CLAUDE_MD = `# agentistics — Nay chat

This workspace connects to the agentistics analytics dashboard via MCP tools.
The agentistics server must be running at http://localhost:47291.

---

## Your identity — read this first

You are **Nay**, the built-in analytics assistant for **agentistics**.
You are NOT a generic AI assistant. When asked "who are you?", "what are you?", "quem é você?", or similar, always introduce yourself as:

> **Nay** — assistente de analytics integrada ao agentistics. Analiso uso do Claude Code: custos, tokens, sessões, projetos e métricas de produtividade. Posso criar layouts personalizados no dashboard e gerar relatórios em PDF.

Never describe yourself as "Claude" or "an AI assistant created by Anthropic" in response to identity questions.

---

## CRITICAL behavior rules

**Rule 1 — Never answer from memory or from the conversation history.**
For EVERY question, regardless of what was discussed before, call the relevant tools to get fresh data.
Even if a prior message mentions "embark was the most expensive", call agentistics_projects again to answer a follow-up question about tokens.

**Rule 2 — Never describe what you are about to do. Never ask for permission.**
Call tools immediately. Do not write "I will analyze...", "Let me check...", "Aguarde...", "Com base no relatório acima...". Just call the tool and respond with the actual result.
All tools in this workspace are pre-approved — never ask "may I", "please confirm", "preciso de sua permissão", or any similar phrasing. Just act.

**Rule 3 — Never reference "the Nay agent" or "the report above" as a source.**
You have direct tool access. Use it. If you need data, call the tool.

**Rule 4 — Add a navigation button ONLY when you actually called a tool and are presenting its data.**

Add ONE button when the response contains data fetched from a tool:
- Costs for a specific project → [→ Ver custos](/costs?projects=PROJECT_PATH)
- Sessions for a specific project → [→ Ver projetos](/?projects=PROJECT_PATH)
- Multiple projects → [→ Ver custos](/costs?projects=PATH1|PATH2)
- Generic cost breakdown → [→ Ver custos](/costs)
- Generic projects overview → [→ Ver projetos](/)
- A repository rather than a folder → [→ Ver repositórios](/repositories)
- Created/modified a layout → [→ Abrir layout](/custom)
- General dashboard stats → [→ Dashboard](/)

Do NOT add any button when:
- The response is conversational (greetings, clarifications, questions, confirmations)
- No tool was called
- The user asked about you / your capabilities / preferences

The PROJECT_PATH must be the exact \`path\` field returned by agentistics_projects. At most ONE button per response.

---

## "How much have I spent talking to you?" — Nay's own sessions

Your conversation sessions (chats with you, Nay) are stored in the project at path:
\`~/.agentistics/nay-chat\`

When the user asks "how much have I spent talking to you?", "quanto gastei conversando com você?", "what did our conversation cost?", or similar questions about the cost of Nay specifically:
1. Call agentistics_projects
2. Find the project whose \`path\` contains \`nay-chat\`
3. Report the cost, tokens, and sessions for that project only

For questions about total Claude Code usage across ALL projects, use agentistics_summary or all projects from agentistics_projects.

---

## Tool call protocol

| Question type | Tools to call |
|--------------|--------------|
| Any metrics question | agentistics_summary first, then specific tool |
| "Which project spent most tokens/money?" | agentistics_projects |
| "Most expensive session?" | agentistics_sessions |
| "Cost breakdown by model?" | agentistics_costs |
| "Build a layout" | agentistics_component_catalog then agentistics_build_layout |
| "Generate/export a PDF report" | agentistics_export_pdf |
| "What tags exist / cost of tag X?" | agentistics_tags, then agentistics_tag_detail |
| "Cost/usage by repository?" | agentistics_repos |
| "Am I connected to a team/central?" | agentistics_team_status |
| "Who's on the team? (central only)" | agentistics_team_members |
| Any follow-up question | Call tools again — never rely on prior conversation |

---

## Available MCP tools

| Tool | Purpose |
|------|---------|
| agentistics_summary | All-time totals: tokens, cost, sessions, streak, cache hit rate |
| agentistics_projects | Per-project breakdown with token/cost/session counts |
| agentistics_sessions | Recent sessions with duration, model, cost |
| agentistics_costs | Model pricing breakdown and cache savings |
| agentistics_component_catalog | Available dashboard components and their IDs |
| agentistics_get_layouts | Current custom page layouts |
| agentistics_build_layout | Create a complete layout with ordered components |
| agentistics_add_component | Add a single component to an existing layout |
| agentistics_remove_component | Remove a component by its instance ID |
| agentistics_create_layout | Create a new empty named layout |
| agentistics_set_active_layout | Switch which layout is shown on /custom |
| agentistics_delete_layout | Delete a layout permanently |
| agentistics_export_pdf | Generate PDF — returns a [⬇ Download PDF](pdf:URL) button link |
| agentistics_tags | List all tags with aggregate sessions/cost/tokens |
| agentistics_tag_detail | Full detail for one tag: breakdown + top projects/models/harnesses/repos/members |
| agentistics_repos | Repository breakdown by normalized git remote |
| agentistics_team_status | This machine's team mode (solo/central/member) and central connections |
| agentistics_team_members | Team roster (central only): presence, latency, last seen |

---

## PDF report generation

When the user asks for a PDF report, ask what date range they want if not specified:
> "Qual período? 7 dias, 30 dias, 90 dias, ou tudo?"

Then call agentistics_export_pdf with the matching range ("7d", "30d", "90d", or "all").
The tool returns a \`[⬇ Download PDF](pdf:URL)\` link — include it exactly as returned. Do not modify or reformat it.

---

## Layout building rules

The custom page uses a 12-column grid. Component default sizes (from the catalog):
- KPI cards (kpi.*): w=3, h=3 — fit 4 per row
- Wide charts (activity.chart, tools.metrics, tools.agents, sessions.*): w=8–12, h=6–8
- Medium panels (costs.budget, costs.cache, activity.heatmap, activity.hours): w=6–8, h=6–7
- Full-width (costs.models, sessions.highlights, sessions.recent): w=12, h=6–8
- Projects panels: projects.top w=7 h=7, projects.languages w=5 h=6

Always call agentistics_component_catalog before building any layout to get the exact IDs and default sizes.
Order componentIds thoughtfully: KPI cards first, then charts, then tables.

---

## Response format

- Bold key numbers. Use tables for comparisons. Always include units ($, k tokens, %).
- Under 200 words unless a detailed breakdown is explicitly requested.
- Match the language the user writes in (Portuguese or English).
- Never fabricate numbers — if a tool returns no data, say so.
- Add a navigation button only when presenting tool data (see Rule 4). Never add buttons for conversational replies.

Available routes: / (home), /projects, /costs, /tools, /custom

Filter query params (append to route when result is project-specific):
- ?projects=PATH — filter by one project path (exact value from agentistics_projects)
- ?projects=PATH1|PATH2 — filter by multiple projects (pipe-separated)
`

// MCP settings written dynamically so the cwd path and port are always correct.
export function buildNaySettings(port: number) {
  return {
    mcpServers: {
      agentistics: {
        command: 'bun',
        args: ['run', 'packages/mcp/agentistics-mcp.ts'],
        cwd: AGENTISTICS_ROOT,
        env: { AGENTISTICS_API: `http://localhost:${port}` },
      },
    },
    permissions: {
      allow: [
        'WebFetch(domain:localhost)',
        // Allow all agentistics MCP tools without prompting (non-interactive --print mode)
        'mcp__agentistics__agentistics_summary',
        'mcp__agentistics__agentistics_projects',
        'mcp__agentistics__agentistics_sessions',
        'mcp__agentistics__agentistics_costs',
        'mcp__agentistics__agentistics_component_catalog',
        'mcp__agentistics__agentistics_get_layouts',
        'mcp__agentistics__agentistics_build_layout',
        'mcp__agentistics__agentistics_add_component',
        'mcp__agentistics__agentistics_remove_component',
        'mcp__agentistics__agentistics_create_layout',
        'mcp__agentistics__agentistics_set_active_layout',
        'mcp__agentistics__agentistics_delete_layout',
        'mcp__agentistics__agentistics_export_pdf',
        'mcp__agentistics__agentistics_tags',
        'mcp__agentistics__agentistics_tag_detail',
        'mcp__agentistics__agentistics_repos',
        'mcp__agentistics__agentistics_team_status',
        'mcp__agentistics__agentistics_team_members',
      ],
    },
  }
}

// Called at server startup — idempotent, safe to run on every restart.
// Creates the general-purpose Claude chat working directory.
export async function ensureClaudeChat(): Promise<void> {
  await mkdir(CLAUDE_CHAT_DIR, { recursive: true })
}

export async function ensureNayChat(port: number): Promise<void> {
  const claudeMd = NAY_CLAUDE_MD.replace(
    /http:\/\/localhost:\d+/g,
    `http://localhost:${port}`,
  )
  const dotClaude = path.join(NAY_CHAT_DIR, '.claude')
  await mkdir(dotClaude, { recursive: true })
  await writeFile(path.join(NAY_CHAT_DIR, 'CLAUDE.md'), claudeMd)
  await writeFile(
    path.join(dotClaude, 'settings.json'),
    JSON.stringify(buildNaySettings(port), null, 2),
  )
  await registerMcpGlobally(port)
}

// Registers the agentistics MCP via `claude mcp add -s user` so that
// claude --print mode (which reads ~/.claude.json user scope) can find the tools.
// Safe to call on every restart — skips if already registered with the same port.
export async function registerMcpGlobally(port: number): Promise<void> {
  const apiUrl = `http://localhost:${port}`
  const mcpScript = path.join(AGENTISTICS_ROOT, 'packages', 'mcp', 'agentistics-mcp.ts')

  // Check if already registered with the correct URL *and* script path —
  // a stale path with a matching URL must still trigger re-registration.
  try {
    const dotClaudeJson = path.join(HOME_DIR, '.claude.json')
    const raw = await Bun.file(dotClaudeJson).text()
    const json = JSON.parse(raw) as Record<string, unknown>
    const servers = json['mcpServers'] as Record<string, { env?: Record<string, string>; args?: string[] }> | undefined
    const existing = servers?.['agentistics']
    const urlOk = existing?.env?.['AGENTISTICS_API'] === apiUrl
    const pathOk = Array.isArray(existing?.args) && existing.args.some(a => a.includes(mcpScript))
    if (urlOk && pathOk) return // already up to date
  } catch { /* read or parse failed — proceed with registration */ }

  // Use the official CLI to register at user scope.
  //
  // A MISSING `claude` binary is a normal state, not a failure: every container image ships
  // without it (the central and the Docker machine both), and so does any host that runs
  // agentistics without Claude Code installed. It used to throw ENOENT out of here into the
  // boot's `.catch(err => console.error(…, err))`, which Bun renders as a ten-line stack with a
  // source snippet — a startup that looks broken while everything except nay-chat is fine.
  // Anything else (a permission error, a crashing CLI) still propagates and is still loud.
  try {
    const proc = Bun.spawn(
      ['claude', 'mcp', 'add', '-s', 'user', 'agentistics',
        '-e', `AGENTISTICS_API=${apiUrl}`,
        '--', 'bun', 'run', mcpScript],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    await proc.exited
  } catch (err) {
    if ((err as { code?: string })?.code === 'ENOENT') {
      console.info('[nay-chat] the Claude CLI is not on PATH — nay-chat stays unavailable; everything else runs normally.')
      return
    }
    throw err
  }
}

export type ChatAttachment = {
  name: string
  mimeType: string
  data: string   // base64 for images, plain text for text files
  isImage: boolean
}

export interface StreamViaClaudioOpts {
  cwd?: string
  thinkingBudget?: number
  attachments?: ChatAttachment[]
  signal?: AbortSignal
}

export async function streamViaClaude(
  message: string,
  history: ChatMessage[],
  model: ChatModelId,
  onChunk: (text: string) => void,
  onTool: (name: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
  onSessionId?: (id: string) => void,
  resumeSessionId?: string | null,
  opts?: StreamViaClaudioOpts,
): Promise<void> {
  // When resuming a session, just pass the new message — history is in the JSONL
  // When starting a new session, fall back to the old inline-history approach
  let prompt: string
  const args = ['claude', '--print', '--output-format', 'stream-json', '--verbose']

  if (opts?.thinkingBudget && opts.thinkingBudget > 0) {
    args.push('--budget-tokens', String(opts.thinkingBudget))
  }

  args.push('--model', model)

  const imageAttachments = opts?.attachments?.filter(a => a.isImage) ?? []
  const textAttachments = opts?.attachments?.filter(a => !a.isImage) ?? []

  // Inject text-file contents into the message
  let augmentedMessage = message
  for (const att of textAttachments) {
    const ext = att.name.split('.').pop() ?? ''
    augmentedMessage = `[Attached file: ${att.name}]\n\`\`\`${ext}\n${att.data}\n\`\`\`\n\n${augmentedMessage}`
  }

  if (resumeSessionId) {
    args.push('--resume', resumeSessionId)
    prompt = augmentedMessage
  } else {
    const recent = history.filter(h => h.content.trim()).slice(-8)
    prompt = ''
    for (const h of recent) {
      prompt += `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}\n\n`
    }
    prompt += augmentedMessage.length > 0 && recent.length > 0 ? `User: ${augmentedMessage}` : augmentedMessage
  }

  // When images are attached, switch to stream-json input so we can send base64 image blocks
  if (imageAttachments.length > 0) {
    args.push('--input-format', 'stream-json')
  }

  const cwd = opts?.cwd ?? NAY_CHAT_DIR

  try {
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', stdin: 'pipe', cwd })
    opts?.signal?.addEventListener('abort', () => { try { proc.kill() } catch { /* already dead */ } }, { once: true })

    if (imageAttachments.length > 0) {
      // Build a multimodal content array
      type ContentBlock =
        | { type: 'text'; text: string }
        | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

      const content: ContentBlock[] = []
      // For non-resume sessions, prepend history as a text block
      if (!resumeSessionId) {
        const recent = history.filter(h => h.content.trim()).slice(-8)
        if (recent.length > 0) {
          let histText = ''
          for (const h of recent) {
            histText += `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}\n\n`
          }
          content.push({ type: 'text', text: histText.trimEnd() })
        }
      }
      for (const att of imageAttachments) {
        content.push({ type: 'image', source: { type: 'base64', media_type: att.mimeType, data: att.data } })
      }
      content.push({ type: 'text', text: augmentedMessage })

      const event = JSON.stringify({ type: 'user', message: { role: 'user', content } })
      proc.stdin.write(event + '\n')
    } else {
      proc.stdin.write(prompt)
    }
    proc.stdin.end()

    const decoder = new TextDecoder()
    let lineBuffer = ''
    let emittedLength = 0
    let gotResult = false
    const seenTools = new Set<string>()

    for await (const raw of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
      lineBuffer += decoder.decode(raw, { stream: true })
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>
          if (event.type === 'assistant') {
            const msg = event.message as { content?: Array<{ type: string; text?: string; name?: string }> } | undefined
            for (const block of msg?.content ?? []) {
              if (block.type === 'text' && typeof block.text === 'string') {
                const delta = block.text.slice(emittedLength)
                if (delta) { onChunk(delta); emittedLength = block.text.length }
              } else if (block.type === 'tool_use' && typeof block.name === 'string') {
                if (!seenTools.has(block.name)) {
                  seenTools.add(block.name)
                  onTool(block.name)
                }
              }
            }
          } else if (event.type === 'result') {
            gotResult = true
            const ev = event as { subtype?: string; error?: unknown; session_id?: string }
            if (ev.subtype === 'error') {
              onError(String(ev.error ?? 'claude CLI error'))
              return
            }
            if (ev.session_id && onSessionId) onSessionId(ev.session_id)
          }
        } catch { /* ignore malformed lines */ }
      }
    }

    const exit = await proc.exited
    if (exit !== 0 && !gotResult) {
      const errText = await new Response(proc.stderr).text()
      onError(`claude CLI exited with code ${exit}: ${errText.slice(0, 300)}`)
      return
    }
    onDone()
  } catch (err) {
    onError(`claude not found or failed to start: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function execCommand(
  command: string,
  onChunk: (text: string, isStderr: boolean) => void,
  onDone: (exitCode: number) => void,
  onError: (err: string) => void,
): Promise<void> {
  try {
    const proc = Bun.spawn(['bash', '-c', command], {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'inherit',
    })

    const decoder = new TextDecoder()

    void (async () => {
      for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
        onChunk(decoder.decode(chunk, { stream: true }), false)
      }
    })()

    void (async () => {
      for await (const chunk of proc.stderr as unknown as AsyncIterable<Uint8Array>) {
        onChunk(decoder.decode(chunk, { stream: true }), true)
      }
    })()

    const code = await proc.exited
    onDone(code)
  } catch (err) {
    onError(err instanceof Error ? err.message : String(err))
  }
}
