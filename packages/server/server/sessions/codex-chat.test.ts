import { describe, expect, it } from 'bun:test'
import { parseCodexChat, reasoningText, shellCommandOf, toolDetailOf } from './codex-chat'

/**
 * Every fixture is the SHAPE measured 2026-09-05 over the 14 largest rollouts on this machine,
 * trimmed to the fields that decide the answer. Where a rule exists because of a number, the number
 * is in the test's name.
 */

const AT = '2026-07-07T22:04:06.000Z'
const line = (payload: Record<string, unknown>, type = 'response_item'): string =>
  JSON.stringify({ timestamp: AT, type, payload })

const msg = (role: string, text: string): string =>
  line({ type: 'message', role, content: [{ type: 'input_text', text }] })

const call = (name: string, args: Record<string, unknown>): string =>
  line({ type: 'function_call', name, arguments: JSON.stringify(args) })

describe('the pieces', () => {
  it('a shell envelope yields the COMMAND, never the stdout it also carries', () => {
    const raw = '<user_shell_command>\n<command>\nls -la\n</command>\n<result>\nExit code: 0\nOutput:\na\nb\n</result>\n</user_shell_command>'
    expect(shellCommandOf(raw)).toBe('ls -la')
  })

  it('reasoning reads the summary and NEVER the encrypted field', () => {
    expect(reasoningText({
      summary: [{ type: 'summary_text', text: '**Crafting a Dockerfile**' }],
      encrypted_content: 'gAAAAABqTXfW6j_9rnbI',
    })).toBe('**Crafting a Dockerfile**')
    // 12 of the 17 measured carry only the encrypted half. An absent thought is absent.
    expect(reasoningText({ summary: [], encrypted_content: 'gAAAA' })).toBe('')
  })

  it('`arguments` is a JSON STRING, and the detail is the command inside it', () => {
    expect(toolDetailOf(JSON.stringify({ cmd: 'pwd', workdir: '/x', max_output_tokens: 12000 })))
      .toBe('pwd')
    expect(toolDetailOf('not json')).toBeNull()
    expect(toolDetailOf(undefined)).toBeNull()
  })

  it('a shell command is SUMMARISED past its `cd`, never truncated at the first segment', () => {
    // Measured on a real rollout: five consecutive calls all opened `cd /home/…/embark`, so the
    // chips were a column of identical `cd` rows. `commandSummary` shows the segment that acts.
    expect(toolDetailOf(JSON.stringify({ cmd: 'cd /home/me/embark && cat package.json' })))
      .toBe('cat package.json')
  })
})

describe('parseCodexChat', () => {
  it('reads the person and the assistant, oldest first', () => {
    expect(parseCodexChat([msg('user', 'Salve'), msg('assistant', 'Salve.')])).toEqual([
      { role: 'user', text: 'Salve', at: AT },
      { role: 'assistant', text: 'Salve.', at: AT },
    ])
  })

  it('IGNORES the event_msg copy — every message is written twice', () => {
    // Measured: the user's `response_item` precedes its `event_msg` and the assistant's follows it,
    // so reading both draws each turn twice AND in an inconsistent order.
    const turns = parseCodexChat([
      msg('user', 'Salve'),
      line({ type: 'user_message', message: 'Salve' }, 'event_msg'),
      line({ type: 'agent_message', message: 'Salve.' }, 'event_msg'),
      msg('assistant', 'Salve.'),
    ])
    expect(turns.map(t => t.text)).toEqual(['Salve', 'Salve.'])
  })

  it('gathers the tool calls onto the assistant message they belong to', () => {
    // One turn is several lines here: reasoning → message → function_call, function_call.
    const turns = parseCodexChat([
      msg('assistant', 'Vou checar o estado local do plugin.'),
      call('exec_command', { cmd: 'rg --files .', workdir: '/repo' }),
      call('exec_command', { cmd: 'find /repo -maxdepth 4', workdir: '/repo' }),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.text).toBe('Vou checar o estado local do plugin.')
    // In FILE order, both on the one turn.
    expect(turns[0]!.tools).toEqual([
      { name: 'exec_command', canonical: 'Bash', detail: 'rg --files .' },
      { name: 'exec_command', canonical: 'Bash', detail: 'find /repo -maxdepth 4' },
    ])
  })

  it("keeps CODEX's own tool name for display, with the shared one beside it", () => {
    const [turn] = parseCodexChat([msg('assistant', 'x'), call('exec_command', { cmd: 'ls' })])
    expect(turn!.tools![0]).toEqual({ name: 'exec_command', canonical: 'Bash', detail: 'ls' })
  })

  it('attaches the reasoning to the assistant turn below it, not to a turn of its own', () => {
    const turns = parseCodexChat([
      line({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking hard' }] }),
      msg('assistant', 'the answer'),
    ])
    expect(turns).toEqual([
      { role: 'assistant', text: 'the answer', at: AT, thinking: 'thinking hard' },
    ])
  })

  it('a reasoning with nothing to attach to still becomes a turn carrying the thought', () => {
    const turns = parseCodexChat([
      msg('user', 'oi'),
      line({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'hmm' }] }),
    ])
    expect(turns).toHaveLength(2)
    expect(turns[1]).toMatchObject({ role: 'assistant', text: '', thinking: 'hmm' })
  })

  it('a reasoning carrying only the ENCRYPTED half contributes nothing', () => {
    const turns = parseCodexChat([
      msg('assistant', 'a'),
      line({ type: 'reasoning', summary: [], encrypted_content: 'gAAAA' }),
    ])
    expect(turns).toEqual([{ role: 'assistant', text: 'a', at: AT }])
  })

  it('the `developer` role is ALWAYS the harness — 19 of 19 measured', () => {
    const turns = parseCodexChat([
      msg('developer', '<permissions instructions>\nFilesystem sandboxing…'),
      msg('developer', '<collaboration_mode>\n…'),
      msg('developer', '<model_switch>\nThe user was previously…'),
      msg('developer', 'something nobody has tagged'),
    ])
    expect(turns.map(t => t.system)).toEqual([
      'the harness stated its permissions',
      'the collaboration mode changed',
      'the model was switched',
      'instructions from the harness',
    ])
  })

  it('a `user` envelope the harness wrote is a note, never the reader’s bubble', () => {
    const turns = parseCodexChat([
      msg('user', '<environment_context>\n  <cwd>/repo</cwd>\n'),
      msg('user', '<turn_aborted>\n'),
    ])
    expect(turns.map(t => t.system)).toEqual([
      'the environment was described to the assistant', 'the turn was aborted',
    ])
  })

  it('a `<user_shell_command>` IS the person and is unwrapped to what they ran', () => {
    const [turn] = parseCodexChat([
      msg('user', '<user_shell_command>\n<command>\nls -la\n</command>\n<result>\nExit code: 0\n</result>\n</user_shell_command>'),
    ])
    // Same call `chat-envelope.ts` makes for Claude's `<bash-input>`: dropping it would erase a
    // turn that happened.
    expect(turn).toEqual({ role: 'user', text: 'ls -la', at: AT })
  })

  it('the harness loading a FILE into the user role is a note, though nothing tags it', () => {
    // Codex has no `isMeta`; the payload is indistinguishable in shape from a typed message, so
    // the opening line is the only signal. 11 of the 32 untagged user messages measured were these.
    const turns = parseCodexChat([
      msg('user', '# AGENTS.md instructions for /home/me/embark\n\n<INSTRUCTIONS>\n…a whole file…'),
      msg('user', '# Context from my IDE setup:\n…'),
    ])
    expect(turns.map(t => t.system))
      .toEqual(['project instructions were loaded', 'context from the editor'])
    // Never the body: an AGENTS.md dump is a whole file.
    expect(turns[0]!.text).toBe('project instructions were loaded')
  })

  it('a message merely STARTING with # is the person’s — the table is not a prefix guess', () => {
    const [turn] = parseCodexChat([msg('user', '# why does this heading break the build?')])
    expect(turn).toEqual({ role: 'user', text: '# why does this heading break the build?', at: AT })
  })

  it('an UNRECOGNISED tag stays the person’s — the safe direction', () => {
    const [turn] = parseCodexChat([msg('user', '<Foo /> renders twice, why?')])
    expect(turn).toEqual({ role: 'user', text: '<Foo /> renders twice, why?', at: AT })
    expect(turn!.system).toBeUndefined()
  })

  it('drops the function_call_output — the request above already said what ran', () => {
    const turns = parseCodexChat([
      msg('assistant', 'running it'),
      call('exec_command', { cmd: 'ls' }),
      line({ type: 'function_call_output', call_id: 'c1', output: 'a\nb\nc'.repeat(500) }),
      line({ type: 'ghost_snapshot' }),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.tools).toHaveLength(1)
  })

  it('only the NEWEST batch of calls with no text after it is pending', () => {
    const turns = parseCodexChat([
      call('exec_command', { cmd: 'first' }),
      msg('user', 'go on'),
      call('exec_command', { cmd: 'last' }),
    ])
    expect(turns.map(t => t.pending)).toEqual([undefined, undefined, true])
  })

  it('caps at max, keeping the END of the conversation', () => {
    const lines = Array.from({ length: 20 }, (_, i) => msg('assistant', `m${i}`))
    expect(parseCodexChat(lines, 'codex', 3).map(t => t.text)).toEqual(['m17', 'm18', 'm19'])
  })

  it('a half line the tail window cut through is skipped, not parsed', () => {
    expect(parseCodexChat(['tamp":"x","type":"resp', msg('user', 'oi')])).toHaveLength(1)
  })

  it('a turn with no recorded time gets none rather than an invented now', () => {
    const [turn] = parseCodexChat([JSON.stringify({
      type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'oi' }] },
    })])
    expect(turn!.at).toBeUndefined()
  })
})
