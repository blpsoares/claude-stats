import { describe, expect, it } from 'bun:test'
import { parseCopilotChat, toolDetailOf } from './copilot-chat'

/**
 * Fixtures are the SHAPE measured 2026-09-05 over the 11 largest sessions on this machine, trimmed
 * to the fields that decide the answer. Where a rule exists because of a number, it is in the name.
 */

const AT = '2026-06-30T14:53:11.560Z'
const line = (type: string, data: Record<string, unknown>): string =>
  JSON.stringify({ type, data, id: 'x', timestamp: AT })

describe('toolDetailOf', () => {
  it('a shell command is summarised past its `cd`', () => {
    expect(toolDetailOf({ command: 'cd /repo && bun test', description: 'run tests' }))
      .toBe('bun test')
  })

  it('a read is named by its path', () => {
    expect(toolDetailOf({ path: '/repo/packages' })).toBe('/repo/packages')
  })
})

describe('parseCopilotChat', () => {
  it('reads the person and the assistant, oldest first', () => {
    const turns = parseCopilotChat([
      line('user.message', { content: 'salve mano' }),
      line('assistant.message', { content: 'Salve, meu mano! 👊', toolRequests: [] }),
    ])
    expect(turns).toEqual([
      { role: 'user', text: 'salve mano', at: AT },
      { role: 'assistant', text: 'Salve, meu mano! 👊', at: AT },
    ])
  })

  it('reads `content` and NEVER `transformedContent`', () => {
    // `transformedContent` is the same message wrapped by the harness in `<current_datetime>` and
    // `<system_reminder>` blocks. It is longer and looks more complete, and putting it on screen
    // is the defect `chat-envelope.ts` exists to prevent: the harness's reminders inside the
    // reader's own bubble.
    const [turn] = parseCopilotChat([line('user.message', {
      content: 'salve mano',
      transformedContent: '<current_datetime>2026-06-30T11:53:11.488-03:00</current_datetime>\n\nsalve mano\n\n<system_reminder>\n<sql_tables>Available tables: todos</sql_tables>\n</system_reminder>',
    })])
    expect(turn!.text).toBe('salve mano')
  })

  it('one assistant turn is ONE line — text, tools and thinking together', () => {
    // Unlike codex, kimi and agy, copilot puts the requests on the message itself, so nothing has
    // to be gathered across lines.
    const [turn] = parseCopilotChat([line('assistant.message', {
      content: 'vou procurar o diretório',
      reasoningText: 'The user wants the package location.',
      toolRequests: [
        { toolCallId: 't1', name: 'view', arguments: { path: '/repo/packages' }, type: 'function' },
        { toolCallId: 't2', name: 'bash', arguments: { command: 'find /repo -type d', description: 'Localizar' }, type: 'function' },
      ],
    })])
    expect(turn).toEqual({
      role: 'assistant',
      text: 'vou procurar o diretório',
      tools: [
        { name: 'view', canonical: 'Read', detail: '/repo/packages' },
        { name: 'bash', canonical: 'Bash', detail: 'find /repo -type d' },
      ],
      thinking: 'The user wants the package location.',
      at: AT,
    })
  })

  it("keeps COPILOT's own tool name for display, with the shared one beside it", () => {
    const [turn] = parseCopilotChat([line('assistant.message', {
      content: '', toolRequests: [{ name: 'view', arguments: { path: '/a' } }],
    })])
    expect(turn!.tools![0]).toEqual({ name: 'view', canonical: 'Read', detail: '/a' })
  })

  it('an unmapped tool carries no second reading', () => {
    const [turn] = parseCopilotChat([line('assistant.message', {
      content: '', toolRequests: [{ name: 'report_intent', arguments: { intent: 'Explorando docs' } }],
    })])
    expect(turn!.tools![0]).toEqual({ name: 'report_intent', detail: 'Explorando docs' })
  })

  it('only `reasoningText` is a thought — the opaque and encrypted halves are not', () => {
    const [turn] = parseCopilotChat([line('assistant.message', {
      content: 'ok', toolRequests: [],
      reasoningOpaque: '6sGm+sK0rp4ZxWx34c3hwmYpIY',
      encryptedContent: 'gAAAA',
    })])
    expect(turn!.thinking).toBeUndefined()
  })

  it('the system prompt is a note that names it, never its body', () => {
    // The measured one opens "You are the GitHub Copilot CLI…" and runs for pages.
    const [turn] = parseCopilotChat([line('system.message', {
      role: 'system', content: 'You are the GitHub Copilot CLI, a terminal assistant…'.repeat(80),
    })])
    expect(turn).toEqual({ role: 'user', text: 'the system prompt was set', system: 'the system prompt was set', at: AT })
  })

  it('the session events worth a line get one, and the bracketing does NOT', () => {
    const turns = parseCopilotChat([
      line('session.start', { sessionId: 'a', context: { cwd: '/repo' } }),
      line('assistant.turn_start', { turnId: '0' }),
      line('tool.execution_start', { toolCallId: 't1' }),
      line('tool.execution_complete', { toolCallId: 't1', output: 'x'.repeat(9000) }),
      line('assistant.turn_end', { turnId: '0' }),
      line('session.usage_checkpoint', {}),
      line('session.model_change', { model: 'gpt-5.3-codex' }),
      line('abort', {}),
      line('session.error', { message: 'boom' }),
    ])
    expect(turns.map(t => t.system)).toEqual([
      'the model was changed', 'the turn was aborted', 'the session reported an error',
    ])
  })

  it('only the NEWEST message with calls and no text is pending', () => {
    const turns = parseCopilotChat([
      line('assistant.message', { content: '', toolRequests: [{ name: 'bash', arguments: { command: 'first' } }] }),
      line('user.message', { content: 'go on' }),
      line('assistant.message', { content: '', toolRequests: [{ name: 'bash', arguments: { command: 'last' } }] }),
    ])
    expect(turns.map(t => t.pending)).toEqual([undefined, undefined, true])
  })

  it('caps at max, keeping the END of the conversation', () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      line('assistant.message', { content: `m${i}`, toolRequests: [] }))
    expect(parseCopilotChat(lines, 'copilot', 3).map(t => t.text)).toEqual(['m17', 'm18', 'm19'])
  })

  it('a half line the tail window cut through is skipped, not parsed', () => {
    expect(parseCopilotChat(['ype":"user.mess', line('user.message', { content: 'oi' })])).toHaveLength(1)
  })

  it('a turn with no recorded time gets none rather than an invented now', () => {
    const [turn] = parseCopilotChat([JSON.stringify({
      type: 'user.message', data: { content: 'oi' },
    })])
    expect(turn!.at).toBeUndefined()
  })
})
