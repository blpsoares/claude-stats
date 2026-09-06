import { describe, expect, it } from 'bun:test'
import { isoOf, parseKimiChat, toolDetailOf } from './kimi-chat'

/**
 * Fixtures are the SHAPE measured 2026-09-05 over the 10 largest wires on this machine, trimmed to
 * the fields that decide the answer. Where a rule exists because of a number, it is in the name.
 */

const T = 1785943919760
const AT = new Date(T).toISOString()

const line = (o: Record<string, unknown>): string => JSON.stringify({ time: T, ...o })

const userMsg = (text: string): string => line({
  type: 'context.append_message',
  message: { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } },
})

const injected = (variant: string, body: string): string => line({
  type: 'context.append_message',
  message: {
    role: 'user', content: [{ type: 'text', text: body }], toolCalls: [],
    origin: { kind: 'injection', variant },
  },
})

const loop = (event: Record<string, unknown>): string =>
  line({ type: 'context.append_loop_event', event })

const say = (text: string): string =>
  loop({ type: 'content.part', turnId: '0', step: 1, part: { type: 'text', text } })

describe('the pieces', () => {
  it('kimi stamps epoch MILLISECONDS; every other reader emits ISO', () => {
    expect(isoOf(1785943919760)).toBe(new Date(1785943919760).toISOString())
    expect(isoOf(1785943919760)).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(isoOf(0)).toBeUndefined()
    expect(isoOf('nope')).toBeUndefined()
  })

  it('a shell command is summarised past its `cd`', () => {
    expect(toolDetailOf({ command: 'cd /repo && bun test' })).toBe('bun test')
  })

  it('a write is named by its path, never by the file it carries', () => {
    expect(toolDetailOf({ path: 'frase.txt', content: 'x'.repeat(5000) })).toBe('frase.txt')
  })
})

describe('parseKimiChat', () => {
  it('reads the person and the assistant, oldest first', () => {
    expect(parseKimiChat([userMsg('salve'), say('Salve! Como posso ajudar você hoje?')])).toEqual([
      { role: 'user', text: 'salve', at: AT },
      { role: 'assistant', text: 'Salve! Como posso ajudar você hoje?', at: AT },
    ])
  })

  it('IGNORES turn.prompt — the same text, and a strict subset (15 against 22)', () => {
    const turns = parseKimiChat([
      line({ type: 'turn.prompt', input: [{ type: 'text', text: 'salve' }], origin: { kind: 'user' } }),
      userMsg('salve'),
    ])
    expect(turns).toHaveLength(1)
  })

  it('an entry KIMI ITSELF marks as injected is a note that names the variant, never the body', () => {
    // `origin.kind` is kimi's own declaration — the field codex has no equivalent for. Measured:
    // 15 `user`, 3 `todo_list_reminder`, 4 `permission_mode`.
    const turns = parseKimiChat([
      injected('todo_list_reminder', '<system-reminder>\nThe TodoList tool has not been updated…'),
      injected('permission_mode', '<system-reminder>\nAuto permission mode is active…'),
      injected('something_new', '<system-reminder>\n…'),
    ])
    expect(turns.map(t => t.system)).toEqual([
      'a reminder about the task list',
      'the permission mode was announced',
      'an injected something new',
    ])
    for (const t of turns) expect(t.text).toBe(t.system!)
  })

  it('an injected entry with no variant still says it was not the person', () => {
    const [turn] = parseKimiChat([line({
      type: 'context.append_message',
      message: { role: 'user', content: [{ type: 'text', text: 'x' }], origin: { kind: 'injection' } },
    })])
    expect(turn!.system).toBe('injected by the harness')
  })

  it('gathers tool.call onto the content.part above it', () => {
    const turns = parseKimiChat([
      say('vou escrever o arquivo'),
      loop({ type: 'tool.call', toolCallId: 'c1', name: 'Write', args: { path: 'frase.txt', content: 'oi' } }),
      loop({ type: 'tool.call', toolCallId: 'c2', name: 'Bash', args: { command: 'cat frase.txt' } }),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.tools).toEqual([
      { name: 'Write', detail: 'frase.txt' },
      { name: 'Bash', detail: 'cat frase.txt' },
    ])
  })

  it("kimi's tool names are ALREADY the shared ones, so no second reading is carried", () => {
    const [turn] = parseKimiChat([loop({ type: 'tool.call', name: 'Write', args: { path: 'a.ts' } })])
    expect(turn!.tools![0]!.canonical).toBeUndefined()
  })

  it('drops tool.result and the step brackets — the request already said what ran', () => {
    const turns = parseKimiChat([
      say('a'),
      loop({ type: 'step.begin', step: 1 }),
      loop({ type: 'tool.call', name: 'Write', args: { path: 'a.ts' } }),
      loop({ type: 'tool.result', toolCallId: 'c1', result: { output: 'Wrote 475 bytes to frase.txt' } }),
      loop({ type: 'step.end', finishReason: 'end_turn', usage: { output: 12 } }),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.tools).toHaveLength(1)
  })

  it('only the NEWEST batch of calls with no text after it is pending', () => {
    const turns = parseKimiChat([
      loop({ type: 'tool.call', name: 'Bash', args: { command: 'first' } }),
      userMsg('go on'),
      loop({ type: 'tool.call', name: 'Bash', args: { command: 'last' } }),
    ])
    expect(turns.map(t => t.pending)).toEqual([undefined, undefined, true])
  })

  it('caps at max, keeping the END of the conversation', () => {
    const lines = Array.from({ length: 20 }, (_, i) => say(`m${i}`))
    expect(parseKimiChat(lines, 'kimi', 3).map(t => t.text)).toEqual(['m17', 'm18', 'm19'])
  })

  it('a half line the tail window cut through is skipped, not parsed', () => {
    expect(parseKimiChat(['pe":"context.append_me', userMsg('oi')])).toHaveLength(1)
  })

  it('a turn with no recorded time gets none rather than an invented now', () => {
    const [turn] = parseKimiChat([JSON.stringify({
      type: 'context.append_message',
      message: { role: 'user', content: [{ type: 'text', text: 'oi' }], origin: { kind: 'user' } },
    })])
    expect(turn!.at).toBeUndefined()
  })
})
