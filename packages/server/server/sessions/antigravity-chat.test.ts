import { describe, expect, it } from 'bun:test'
import { parseAntigravityChat, userRequestText } from './antigravity-chat'

/**
 * Every fixture below is the SHAPE measured on the live conversation
 * `01d0814f-ef39-4838-8461-c50e540e552a` (agy 1.1.22, 2026-09-05), trimmed to the fields that
 * decide the answer. Where a rule exists because of a number, the number is in the test's name.
 */

const line = (o: Record<string, unknown>): string => JSON.stringify(o)

const userInput = (idx: number, text: string): string => line({
  step_index: idx,
  source: 'USER_EXPLICIT',
  type: 'USER_INPUT',
  status: 'DONE',
  created_at: '2026-09-05T17:22:28Z',
  content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-09-05T14:22:28-03:00.\n</ADDITIONAL_METADATA>`,
})

const planner = (idx: number, o: Record<string, unknown> = {}): string => line({
  step_index: idx,
  source: 'MODEL',
  type: 'PLANNER_RESPONSE',
  status: 'DONE',
  created_at: '2026-09-05T17:22:30Z',
  ...o,
})

describe('userRequestText', () => {
  it('keeps the request and drops the metadata block the harness appends', () => {
    const raw = '<USER_REQUEST>\nacabamos?\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-09-05T14:22:28-03:00.\n</ADDITIONAL_METADATA>'
    expect(userRequestText(raw)).toBe('acabamos?')
  })

  it('an unwrapped input still yields its text — a turn that happened is never erased', () => {
    expect(userRequestText('só isso\n<ADDITIONAL_METADATA>\nx\n</ADDITIONAL_METADATA>')).toBe('só isso')
  })
})

describe('parseAntigravityChat', () => {
  it('reads a person turn and a model turn, oldest first', () => {
    const turns = parseAntigravityChat([
      userInput(0, 'acabamos?'),
      planner(1, { content: 'Sim, finalizamos.' }),
    ])
    expect(turns).toEqual([
      { role: 'user', text: 'acabamos?', at: '2026-09-05T17:22:28Z' },
      { role: 'assistant', text: 'Sim, finalizamos.', at: '2026-09-05T17:22:30Z' },
    ])
  })

  it('carries thinking apart from the answer', () => {
    const [turn] = parseAntigravityChat([planner(0, { content: 'ok', thinking: 'Executing Session Kill' })])
    expect(turn).toMatchObject({ role: 'assistant', text: 'ok', thinking: 'Executing Session Kill' })
  })

  it('keeps AGY\'s own tool name for display, with the shared one carried beside it', () => {
    const [turn] = parseAntigravityChat([planner(0, {
      tool_calls: [{
        name: 'run_command',
        args: {
          CommandLine: 'agentop session kill 29bce',
          Cwd: '/home/mithrandir/agentistics',
          toolSummary: 'End session via agentop cli',
        },
      }],
    })])
    // The first version emitted `name: 'Bash'` and nothing else, so an Antigravity conversation
    // rendered Claude Code's tool names for actions agy never took. `name` is what agy called it;
    // `canonical` is what `sessionArtifacts.ts` selects on.
    expect(turn!.tools).toEqual([{
      name: 'run_command', canonical: 'Bash', detail: 'agentop session kill 29bce',
    }])
  })

  it('names a write by its file, never by the file contents it carries', () => {
    const [turn] = parseAntigravityChat([planner(0, {
      tool_calls: [{
        name: 'write_to_file',
        args: { TargetFile: '/repo/src/a.ts', CodeContent: 'x'.repeat(5000), toolSummary: 'Create a file' },
      }],
    })])
    expect(turn!.tools).toEqual([{
      name: 'write_to_file', canonical: 'Write', detail: '/repo/src/a.ts',
    }])
  })

  it('NO tool is renamed on the way to the screen — the whole list speaks one vocabulary', () => {
    // The tell that exposed the bug: five mapped names rendered as Claude's beside `manage_task`
    // and `schedule`, which nothing maps, so one list spoke two vocabularies at once.
    const [turn] = parseAntigravityChat([planner(0, {
      tool_calls: [
        { name: 'run_command', args: { CommandLine: 'ls' } },
        { name: 'view_file', args: { AbsolutePath: '/a' } },
        { name: 'grep_search', args: { Query: 'x' } },
        { name: 'manage_task', args: { Action: 'complete' } },
        { name: 'schedule', args: { Prompt: 'later' } },
      ],
    })])
    expect(turn!.tools!.map(t => t.name))
      .toEqual(['run_command', 'view_file', 'grep_search', 'manage_task', 'schedule'])
  })

  it('truncates a detail longer than 200 characters rather than shipping it whole', () => {
    const [turn] = parseAntigravityChat([planner(0, {
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'x'.repeat(400) } }],
    })])
    expect(turn!.tools![0]!.detail!.length).toBe(201)
    expect(turn!.tools![0]!.detail!.endsWith('…')).toBe(true)
  })

  it('an unmapped tool carries NO canonical field — there is no second reading to state', () => {
    const [turn] = parseAntigravityChat([planner(0, {
      tool_calls: [{ name: 'manage_task', args: { Action: 'complete', TaskId: 't-1' } }],
    })])
    expect(turn!.tools![0]!.name).toBe('manage_task')
    expect(turn!.tools![0]!.canonical).toBeUndefined()
  })

  it('drops the EXECUTION steps — the request above them already said what ran', () => {
    // 1094 planner steps against 909 executions on the measured file: keeping both draws every
    // action twice, and the execution's `content` is the whole stdout.
    const turns = parseAntigravityChat([
      planner(0, { tool_calls: [{ name: 'run_command', args: { CommandLine: 'ls' } }] }),
      line({ step_index: 1, source: 'MODEL', type: 'RUN_COMMAND', status: 'DONE', exit_code: 0, content: 'a\nb\nc' }),
      line({ step_index: 2, source: 'MODEL', type: 'VIEW_FILE', status: 'DONE', content: '…5000 lines…' }),
      line({ step_index: 3, source: 'MODEL', type: 'CODE_ACTION', status: 'DONE', content: '[diff_block_start]…' }),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.tools).toEqual([{ name: 'run_command', canonical: 'Bash', detail: 'ls' }])
  })

  it('skips CONVERSATION_HISTORY — it is a replay of turns already in the file', () => {
    const turns = parseAntigravityChat([
      userInput(0, 'oi'),
      line({ step_index: 1, source: 'SYSTEM', type: 'CONVERSATION_HISTORY', status: 'DONE', content: 'oi' }),
    ])
    expect(turns).toEqual([{ role: 'user', text: 'oi', at: '2026-09-05T17:22:28Z' }])
  })

  it('a system step is an unattributed note that NAMES the kind and never carries the body', () => {
    // agy's checkpoint is the whole truncated conversation and its error paragraph runs 206–633
    // characters across all 77 measured — neither is a line in a chat.
    const turns = parseAntigravityChat([
      line({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: 'x'.repeat(900) }),
      line({ step_index: 1, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', content: '{{ CHECKPOINT 33 }}…' }),
      line({ step_index: 2, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', error: 'y'.repeat(600) }),
    ])
    expect(turns.map(t => t.system)).toEqual([
      'a system message', 'the conversation was truncated', 'the harness reported an error',
    ])
    for (const t of turns) expect(t.text).toBe(t.system!)
  })

  it('a step type nobody has mapped is named by its own type, never silently dropped', () => {
    const [turn] = parseAntigravityChat([
      line({ step_index: 0, source: 'SYSTEM', type: 'BRAND_NEW_THING', status: 'DONE', content: 'x' }),
    ])
    expect(turn!.system).toBe('a brand new thing step')
  })

  it('USER_INPUT that did not come from the person is a note, never the reader’s bubble', () => {
    const [turn] = parseAntigravityChat([line({
      step_index: 0, source: 'SYSTEM', type: 'USER_INPUT', status: 'DONE',
      content: '<USER_REQUEST>\ncontinue\n</USER_REQUEST>',
    })])
    expect(turn).toMatchObject({ system: 'input from the harness' })
  })

  it('only the NEWEST tool call with no text after it is pending', () => {
    const turns = parseAntigravityChat([
      planner(0, { tool_calls: [{ name: 'run_command', args: { CommandLine: 'a' } }] }),
      planner(1, { content: 'done' }),
      planner(2, { tool_calls: [{ name: 'run_command', args: { CommandLine: 'b' } }] }),
    ])
    expect(turns.map(t => t.pending)).toEqual([undefined, undefined, true])
  })

  it('dedupes by step_index, keeping the LATER write', () => {
    const turns = parseAntigravityChat([
      planner(7, { content: 'half' }),
      planner(7, { content: 'whole' }),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]!.text).toBe('whole')
  })

  it('a half line the tail window cut through is skipped, not parsed', () => {
    const turns = parseAntigravityChat(['dex":9,"type":"PLAN', userInput(10, 'oi')])
    expect(turns).toHaveLength(1)
  })

  it('caps at max, keeping the END of the conversation', () => {
    const lines = Array.from({ length: 20 }, (_, i) => planner(i, { content: `m${i}` }))
    const turns = parseAntigravityChat(lines, 'antigravity', 3)
    expect(turns.map(t => t.text)).toEqual(['m17', 'm18', 'm19'])
  })

  it('a planner step with nothing in it is not a turn', () => {
    expect(parseAntigravityChat([planner(0, {}), planner(1, { content: '   ' })])).toEqual([])
  })

  it('a turn with no recorded time gets none rather than an invented now', () => {
    const [turn] = parseAntigravityChat([line({
      step_index: 0, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'oi',
    })])
    expect(turn!.at).toBeUndefined()
  })
})
