import { test, expect } from 'bun:test'
import { aggregateWorkflowAgent, commandLine, MAX_COMMANDS } from './workflow-agent'

const LINES = [
  JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 } } }),
  JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 200, output_tokens: 80 } } }),
  JSON.stringify({ type: 'user', message: { content: 'hi' } }),
]

test('sums usage across assistant messages and keeps first model', () => {
  const r = aggregateWorkflowAgent(LINES)
  expect(r.model).toBe('claude-sonnet-5')
  expect(r.tokensIn).toBe(300)
  expect(r.tokensOut).toBe(130)
  expect(r.cacheRead).toBe(10)
  expect(r.cacheWrite).toBe(5)
  expect(r.costUSD).toBeGreaterThan(0)
})

test('empty input yields zeros', () => {
  const r = aggregateWorkflowAgent([])
  expect(r).toEqual({
    model: '', tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0, prompt: '', startedAt: '',
    toolCalls: 0, tools: {}, commands: [], commandsClipped: false,
  })
})

test('captures the first user message as the prompt — it is what identifies the agent', () => {
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-08-04T14:55:52.619Z', message: { content: 'TAREFA: mapeie a camada de mouse' } }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 2 } } }),
    JSON.stringify({ type: 'user', message: { content: 'segunda mensagem, nao e o prompt' } }),
  ]
  const r = aggregateWorkflowAgent(lines)
  expect(r.prompt).toBe('TAREFA: mapeie a camada de mouse')
  expect(r.startedAt).toBe('2026-08-04T14:55:52.619Z')
})

test('a block-array user message is flattened into the prompt text', () => {
  const lines = [
    JSON.stringify({ type: 'user', timestamp: 't0', message: { content: [{ type: 'text', text: 'parte A' }, { type: 'text', text: 'parte B' }] } }),
  ]
  expect(aggregateWorkflowAgent(lines).prompt).toBe('parte A\nparte B')
})

test('a tool_result echoed back as a user message never becomes the prompt', () => {
  const lines = [
    JSON.stringify({ type: 'user', timestamp: 't0', message: { content: [{ type: 'tool_result', content: 'saida do bash' }] } }),
    JSON.stringify({ type: 'user', timestamp: 't1', message: { content: 'o prompt de verdade' } }),
  ]
  expect(aggregateWorkflowAgent(lines).prompt).toBe('o prompt de verdade')
})

const WITH_TOOLS = [
  JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [
    { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
    { type: 'tool_use', name: 'Read', input: { file_path: '/x/AGENTS.md' } },
    { type: 'text', text: 'not a tool' },
  ] } }),
  JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', usage: {}, content: [
    { type: 'tool_use', name: 'Bash', input: { command: 'cat a.ts' } },
  ] } }),
]

// The COUNT is always exact; the list is what the caller opts into.
test('tool calls are counted always, and the commands only when asked for', () => {
  const bare = aggregateWorkflowAgent(WITH_TOOLS)
  expect(bare.toolCalls).toBe(3)
  expect(bare.tools).toEqual({ Bash: 2, Read: 1 })
  expect(bare.commands).toEqual([])

  const full = aggregateWorkflowAgent(WITH_TOOLS, { withCommands: true })
  expect(full.toolCalls).toBe(3)
  expect(full.commands).toEqual(['ls -la', 'Read: /x/AGENTS.md', 'cat a.ts'])
  expect(full.commandsClipped).toBe(false)
})

test('a bash call IS its command; everything else is named by what it acted on', () => {
  expect(commandLine('Bash', { command: 'git status' })).toBe('git status')
  expect(commandLine('Read', { file_path: '/a/b.ts' })).toBe('Read: /a/b.ts')
  expect(commandLine('Grep', { pattern: 'foo' })).toBe('Grep: foo')
  // A tool with no field we know is still reported BY NAME — dropping it would make the list
  // disagree with the count beside it.
  expect(commandLine('StructuredOutput', {})).toBe('StructuredOutput')
  expect(commandLine('Bash', {})).toBe('Bash')
})

test('a long command is clipped with a marker, never silently cut', () => {
  const line = commandLine('Bash', { command: 'x'.repeat(500) })
  expect(line.endsWith('…')).toBe(true)
  expect(line.length).toBeLessThan(500)
})

test('the list is clipped and SAYS so, while the count stays exact', () => {
  const many = [JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', usage: {}, content:
    Array.from({ length: MAX_COMMANDS + 5 }, (_, i) => ({ type: 'tool_use', name: 'Bash', input: { command: `c${i}` } })),
  } })]
  const r = aggregateWorkflowAgent(many, { withCommands: true })
  expect(r.toolCalls).toBe(MAX_COMMANDS + 5)
  expect(r.commands.length).toBe(MAX_COMMANDS)
  expect(r.commandsClipped).toBe(true)
})
