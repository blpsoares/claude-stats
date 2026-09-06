import { describe, expect, it } from 'bun:test'
import { STEP_POLL_MS, stepNotice, stepOpenable, stepPollMs, stepUrl, type StepState } from './stepDetail'
import type { LiveEvent } from './artifactTabs'

const ev = (over: Partial<LiveEvent>): LiveEvent => ({ kind: 'ran', text: 'bun test', live: false, ...over })
const ready = (over: Partial<Extract<StepState, { phase: 'ready' }>['step']>): StepState => ({
  phase: 'ready',
  step: {
    ok: true, name: 'Bash', input: 'bun test', inputTruncated: false,
    output: 'ok', outputTruncated: false, isError: false, running: false, ...over,
  },
})

describe('stepOpenable — a row that cannot open does not offer to', () => {
  it('opens a tool call through the server', () => {
    expect(stepOpenable(ev({ ref: 'toolu_1' }))).toBe('remote')
  })

  it('opens reasoning with no request at all — the text is already here', () => {
    expect(stepOpenable(ev({ kind: 'thought', full: 'a long thought' }))).toBe('local')
  })

  it('refuses a row with nothing behind it, so no chevron is drawn', () => {
    // A transcript with no tool_use id gives the row nothing to resolve, and a control whose only
    // outcome is "this step is not in this transcript" is worse than no control.
    expect(stepOpenable(ev({}))).toBe(null)
    expect(stepOpenable(ev({ ref: '' }))).toBe(null)
  })
})

describe('stepPollMs — real time means running, and only running', () => {
  it('polls a running step', () => {
    expect(stepPollMs(ready({ running: true, output: null }))).toBe(STEP_POLL_MS)
  })

  it('never polls a finished step — the answer cannot change', () => {
    expect(stepPollMs(ready({}))).toBe(null)
  })

  it('never puts a refusal on a timer', () => {
    expect(stepPollMs({ phase: 'failed', message: 'gone' })).toBe(null)
    expect(stepPollMs({ phase: 'loading' })).toBe(null)
    expect(stepPollMs({ phase: 'local', text: 'x' })).toBe(null)
  })
})

describe('stepNotice — a cut output is SAID', () => {
  it('says nothing when there is nothing to say', () => {
    expect(stepNotice(ready({}), false)).toBe(null)
  })

  it('reports a cut, naming which half was cut', () => {
    expect(stepNotice(ready({ outputTruncated: true }), false)).toContain('the output')
    expect(stepNotice(ready({ inputTruncated: true, outputTruncated: true }), false))
      .toContain('the call and the output')
  })

  it('running outranks a cut — the cut is temporary while it runs', () => {
    expect(stepNotice(ready({ running: true, outputTruncated: true }), false)).toContain('Still running')
  })
})

describe('stepUrl', () => {
  it('escapes both parameters', () => {
    expect(stepUrl('closed:a b', 'toolu_1', 'en'))
      .toBe('/api/fleet/step?id=closed%3Aa%20b&ref=toolu_1&lang=en')
  })
})

describe('stepUrl — a subagent step comes from the subagent’s own transcript', () => {
  it('names the agent when there is one', () => {
    expect(stepUrl('row1', 'toolu_1', 'en', 'a23c9')).toBe(
      '/api/fleet/step?id=row1&ref=toolu_1&agent=a23c9&lang=en')
  })
})
