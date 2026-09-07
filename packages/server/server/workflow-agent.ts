import { calcCost } from '@agentistics/core'

/** How many command lines one agent's detail carries, and how long each may be. Bounded because
 *  an agent here ran 56 tool calls and some of them are multi-line shell scripts — the count is
 *  always exact, the LIST is what gets clipped, and the caller is told which. */
export const MAX_COMMANDS = 200
export const MAX_COMMAND_CHARS = 300

/**
 * One tool call as a line somebody can read.
 *
 * A `Bash` call IS its command; everything else is named by the tool plus the one field that says
 * what it acted on. A tool we have no field for is still reported BY NAME — dropping it would
 * under-report what the agent did, and the count beside the list would then disagree with it.
 */
export function commandLine(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' && v !== '' ? v : '')
  if (name === 'Bash') {
    const cmd = str(i.command)
    if (cmd !== '') return clip(cmd)
  }
  const what = str(i.file_path) || str(i.path) || str(i.pattern) || str(i.url) || str(i.description)
  return what === '' ? name : clip(`${name}: ${what}`)
}

function clip(s: string): string {
  return s.length > MAX_COMMAND_CHARS ? `${s.slice(0, MAX_COMMAND_CHARS)}…` : s
}

/** Aggregate one workflow subagent transcript (agent-<id>.jsonl lines) into token/cost totals.
 *  Also returns the agent's own PROMPT — the transcripts are named by an opaque hash, so the
 *  prompt is the only thing that ties one back to the `agent()` call that produced it
 *  (see workflow-match.ts). */
export function aggregateWorkflowAgent(lines: string[], opts: { withCommands?: boolean } = {}): {
  model: string; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number
  costUSD: number; prompt: string; startedAt: string
  /** Every tool call the agent made. Always exact, even when the list below is clipped or absent. */
  toolCalls: number
  /** How many times each tool was used — the shape of the work, at the cost of one counter. */
  tools: Record<string, number>
  /** The command lines, only when asked for: the LIST view reads every agent of every run, and a
   *  72-agent run would ship megabytes of shell per poll. The detail view asks for one agent. */
  commands: string[]
  /** True when `commands` was cut at `MAX_COMMANDS`, so the view can say so instead of implying
   *  the agent stopped there. */
  commandsClipped: boolean
} {
  let model = ''
  let prompt = '', startedAt = ''
  let tokensIn = 0, tokensOut = 0, cacheRead = 0, cacheWrite = 0
  let toolCalls = 0
  const tools: Record<string, number> = {}
  const commands: string[] = []
  let commandsClipped = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    let e: Record<string, unknown>
    try { e = JSON.parse(line) } catch { continue }
    if (!prompt && e.type === 'user') {
      const text = userText(e)
      if (text) { prompt = text; startedAt = typeof e.timestamp === 'string' ? e.timestamp : '' }
    }
    if (e.type !== 'assistant') continue
    const msg = e.message as Record<string, unknown> | undefined
    if (!msg) continue
    if (!model && typeof msg.model === 'string') model = msg.model
    // The tool calls ride along: these lines are already being parsed for usage, so the shape of
    // what the agent DID costs nothing extra to read.
    const content = msg.content
    if (Array.isArray(content)) {
      for (const part of content) {
        const c = part as Record<string, unknown>
        if (c?.type !== 'tool_use' || typeof c.name !== 'string') continue
        toolCalls += 1
        tools[c.name] = (tools[c.name] ?? 0) + 1
        if (!opts.withCommands) continue
        if (commands.length >= MAX_COMMANDS) { commandsClipped = true; continue }
        commands.push(commandLine(c.name, c.input))
      }
    }
    const u = (msg.usage ?? {}) as Record<string, number>
    tokensIn += u.input_tokens ?? 0
    tokensOut += u.output_tokens ?? 0
    cacheRead += u.cache_read_input_tokens ?? 0
    cacheWrite += u.cache_creation_input_tokens ?? 0
  }
  const costUSD = (tokensIn + tokensOut + cacheRead + cacheWrite) === 0 ? 0 : calcCost(
    { inputTokens: tokensIn, outputTokens: tokensOut, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite, webSearchRequests: 0, costUSD: 0 },
    model,
  )
  return {
    model, tokensIn, tokensOut, cacheRead, cacheWrite, costUSD, prompt, startedAt,
    toolCalls, tools, commands, commandsClipped,
  }
}

/** The text of a user envelope. A `tool_result` block is the transcript echoing a tool's OUTPUT
 *  back into the conversation, not something anyone prompted — it must never pass for the prompt. */
function userText(e: Record<string, unknown>): string {
  const content = (e.message as Record<string, unknown> | undefined)?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map(c => {
      const item = c as Record<string, unknown>
      return item.type === 'text' && typeof item.text === 'string' ? item.text : ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}
