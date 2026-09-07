import { test, expect } from 'bun:test'
import {
  workflowsStateOf, workflowCount, liveRunCount, workflowsPollMs, runStatusText,
  runStatusNote, runDurationText, unmeasuredRunText, WORKFLOW_POLL_MS,
  type WorkflowRunRow, type WorkflowsPayload,
} from './workflows'

const run = (over: Partial<WorkflowRunRow> = {}): WorkflowRunRow => ({
  runId: 'wf_a', name: 'n', status: 'completed', live: false, startedAt: '2026-09-06T10:00:00Z',
  durationMs: 1000, phases: [], agentCount: 1, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  totalTokens: 2, costUSD: 0.1, agents: [], ...over,
})

test('a harness that runs no workflows counts null, never zero', () => {
  const p: WorkflowsPayload = { ok: true, supported: false, message: 'codex does not…' }
  const s = workflowsStateOf(p)
  expect(s.phase).toBe('unsupported')
  expect(workflowCount(s)).toBe(null)
  expect(workflowCount(null)).toBe(null)
})

test('a real empty list counts zero — that is a different fact', () => {
  const s = workflowsStateOf({ ok: true, supported: true, rows: [], anyLive: false })
  expect(workflowCount(s)).toBe(0)
})

test('a refusal is failed, and carries the sentence', () => {
  const s = workflowsStateOf({ ok: false, message: 'no transcript' })
  expect(s).toEqual({ phase: 'failed', message: 'no transcript' })
})

test('polling happens only while a run is live', () => {
  const live = workflowsStateOf({ ok: true, supported: true, rows: [run({ live: true, status: 'running' })], anyLive: true })
  const done = workflowsStateOf({ ok: true, supported: true, rows: [run()], anyLive: false })
  expect(liveRunCount(live)).toBe(1)
  expect(workflowsPollMs(live)).toBe(WORKFLOW_POLL_MS)
  expect(workflowsPollMs(done)).toBe(null)
  expect(workflowsPollMs(null)).toBe(null)
})

// The regression this whole feature exists for: an unfinished run must never read as completed.
test('“no outcome” is said in its own words, not as a completion', () => {
  const ab = runStatusText('abandoned', true)
  expect(ab.text).not.toBe('concluiu')
  expect(runStatusNote('abandoned', true)).toContain('parou de dar sinal')
  expect(runStatusNote('completed', true)).toBe(null)
})

test('every status has a word and a colour in both languages', () => {
  for (const s of ['running', 'completed', 'partial', 'failed', 'abandoned', 'killed'] as const) {
    for (const pt of [true, false]) {
      const r = runStatusText(s, pt)
      expect(r.text.length).toBeGreaterThan(0)
      expect(r.color.length).toBeGreaterThan(0)
    }
  }
})

test('a duration nothing can say is an absence, never 0s', () => {
  expect(runDurationText(null, false, true)).toBe(null)
  expect(runDurationText(45_000, false, true)).toBe('45s')
  expect(runDurationText(125_000, false, false)).toBe('2m 5s')
  expect(runDurationText(3_725_000, false, false)).toBe('1h 2m')
})

test('a live run’s duration says it is still counting', () => {
  expect(runDurationText(45_000, true, false)).toBe('45s so far')
  expect(runDurationText(45_000, true, true)).toBe('há 45s')
})

test('unmeasured is told apart from unfinished', () => {
  expect(unmeasuredRunText(run({ totalTokens: null, live: true }), true)).toContain('ainda não')
  expect(unmeasuredRunText(run({ totalTokens: null, live: false }), true)).toContain('sem transcrições')
  expect(unmeasuredRunText(run(), true)).toBe(null)
})
