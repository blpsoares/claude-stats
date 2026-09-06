import { describe, expect, it } from 'bun:test'
import {
  MAX_STEP_OUTPUT, findStepInTranscript, renderToolInput, renderToolOutput, validStepRef,
} from './step-detail'

const line = (o: unknown) => JSON.stringify(o)

const use = (id: string, name: string, input: unknown) => line({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
})

const result = (id: string, content: unknown, extra: Record<string, unknown> = {}) => line({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] },
})

describe('findStepInTranscript — a step is a PAIR, matched by id', () => {
  it('pairs a call with the result that names it', () => {
    const t = [use('toolu_1', 'Bash', { command: 'bun test' }), result('toolu_1', '5740 pass')].join('\n')
    const step = findStepInTranscript(t, 'toolu_1')
    expect(step?.name).toBe('Bash')
    expect(step?.input).toBe('bun test')
    expect(step?.output).toBe('5740 pass')
    expect(step?.running).toBe(false)
  })

  it('never pairs by position — a neighbouring result belongs to its own call', () => {
    const t = [
      use('toolu_1', 'Bash', { command: 'first' }),
      use('toolu_2', 'Bash', { command: 'second' }),
      result('toolu_2', 'output of the second'),
      result('toolu_1', 'output of the first'),
    ].join('\n')
    expect(findStepInTranscript(t, 'toolu_1')?.output).toBe('output of the first')
    expect(findStepInTranscript(t, 'toolu_2')?.output).toBe('output of the second')
  })

  it('reports a step with no result yet as RUNNING, not as empty output', () => {
    // The state the whole "in real time" request is about: rendering it as "no output" would be a
    // confident wrong answer at the exact moment somebody is watching.
    const step = findStepInTranscript(use('toolu_1', 'Bash', { command: 'sleep 30' }), 'toolu_1')
    expect(step?.running).toBe(true)
    expect(step?.output).toBe(null)
  })

  it('carries the harness’s own error mark', () => {
    const t = [use('t1', 'Bash', { command: 'false' }), result('t1', 'boom', { is_error: true })].join('\n')
    expect(findStepInTranscript(t, 't1')?.isError).toBe(true)
  })

  it('answers null for an id this transcript does not hold', () => {
    expect(findStepInTranscript(use('t1', 'Bash', { command: 'x' }), 't2')).toBe(null)
  })

  it('survives a corrupt line rather than losing the step behind it', () => {
    const t = ['{ not json at all t1', use('t1', 'Bash', { command: 'x' }), result('t1', 'ok')].join('\n')
    expect(findStepInTranscript(t, 't1')?.output).toBe('ok')
  })

  it('refuses a ref that is not one — it decides how much of a 4 MB file is scanned', () => {
    expect(validStepRef('toolu_01ABC-def_9')).toBe(true)
    expect(validStepRef('a'.repeat(201))).toBe(false)
    expect(validStepRef('../../etc/passwd')).toBe(false)
    expect(findStepInTranscript(use('t1', 'Bash', { command: 'x' }), '')).toBe(null)
  })

  it('keeps the END of a long output, and says it cut it', () => {
    // A reader draws conclusions from the end of a log; a silently cut one is worse than a short one.
    const long = `${'x'.repeat(MAX_STEP_OUTPUT)}THE-FAILURE`
    const t = [use('t1', 'Bash', { command: 'bun test' }), result('t1', long)].join('\n')
    const step = findStepInTranscript(t, 't1')
    expect(step?.outputTruncated).toBe(true)
    expect(step?.output?.endsWith('THE-FAILURE')).toBe(true)
  })
})

describe('renderToolInput — the call, as something a person reads', () => {
  it('a shell call IS its command, whole (not the first line the row already showed)', () => {
    expect(renderToolInput('Bash', { command: 'cd x\nbun test' })).toBe('cd x\nbun test')
  })

  it('an edit shows BOTH texts — a diff is what "what did it write" means', () => {
    const out = renderToolInput('Edit', { file_path: '/a/b.ts', old_string: 'before', new_string: 'after' })
    expect(out).toContain('/a/b.ts')
    expect(out).toContain('before')
    expect(out).toContain('after')
  })

  it('a write shows the content under its path', () => {
    expect(renderToolInput('Write', { file_path: '/a/b.ts', content: 'hello' })).toBe('/a/b.ts\n\nhello')
  })

  it('shows an unknown shape as its own JSON rather than guessing a field', () => {
    expect(renderToolInput('Mystery', { alpha: 1, beta: 2 })).toBe('{\n  "alpha": 1,\n  "beta": 2\n}')
  })
})

describe('renderToolOutput — nothing dropped in silence', () => {
  it('names a non-text block instead of skipping it', () => {
    // A screenshot dropped in silence reads as a call that produced nothing.
    expect(renderToolOutput([{ type: 'text', text: 'saw this' }, { type: 'image' }], null))
      .toBe('saw this\n[image]')
  })

  it('falls back to the structured record when there is no content block', () => {
    expect(renderToolOutput(undefined, { stdout: 'out', stderr: 'err' })).toBe('out\nerr')
  })
})
