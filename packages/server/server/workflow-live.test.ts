import { test, expect } from 'bun:test'
import { workflowRunState, workflowRunLive, recordedRunState, RUN_STALE_MS } from './workflow-live'

const NOW = Date.UTC(2026, 8, 6, 12, 0, 0)
const base = { recorded: null, usage: null, sessionLive: true, lastTouchedMs: 0, launchedMs: 0, now: NOW }

// The regression. A run in flight has not reported back, and the old reader turned that absence
// into 'completed' — the reason a running workflow could never be shown as running.
test('a launched run that has not reported back is running, never completed', () => {
  const s = workflowRunState({ ...base, lastTouchedMs: NOW - 10_000 })
  expect(s).toBe('running')
  expect(s).not.toBe('completed')
  expect(workflowRunLive(s)).toBe(true)
})

test('a run launched moments ago is running even before any agent has written', () => {
  expect(workflowRunState({ ...base, lastTouchedMs: 0, launchedMs: NOW - 3_000 })).toBe('running')
})

test('a launched run that stopped moving is abandoned, not completed', () => {
  const s = workflowRunState({ ...base, lastTouchedMs: NOW - RUN_STALE_MS - 1 })
  expect(s).toBe('abandoned')
  expect(s).not.toBe('completed')
})

test('the session being gone settles it however fresh the files look', () => {
  expect(workflowRunState({ ...base, sessionLive: false, lastTouchedMs: NOW })).toBe('abandoned')
})

test('a run with no launch time and no writes is abandoned, never running', () => {
  expect(workflowRunState({ ...base, lastTouchedMs: 0, launchedMs: 0 })).toBe('abandoned')
})

test('a clock slightly ahead of ours still reads as fresh', () => {
  expect(workflowRunState({ ...base, lastTouchedMs: NOW + 30_000 })).toBe('running')
})

// The finished arithmetic is preserved exactly, so a run that already had a status keeps it.
test('a reported run keeps the status the old reader gave it', () => {
  const done = { ...base, sessionLive: false, lastTouchedMs: 0 }
  expect(workflowRunState({ ...done, usage: { agentsError: 0, agentsDone: 4 } })).toBe('completed')
  expect(workflowRunState({ ...done, usage: { agentsError: 2, agentsDone: 3 } })).toBe('partial')
  expect(workflowRunState({ ...done, usage: { agentsError: 2, agentsDone: 0 } })).toBe('failed')
})

test('a report outranks freshness — a finished run is not running', () => {
  const s = workflowRunState({ ...base, usage: { agentsError: 0, agentsDone: 1 }, lastTouchedMs: NOW })
  expect(s).toBe('completed')
  expect(workflowRunLive(s)).toBe(false)
})

// 'unknown' is not 'false'. The dashboard's data build cannot see processes, and if not-looking
// counted as the session being gone, every running workflow on the repo page would read abandoned.
test('a caller that cannot see the session lets movement decide', () => {
  const unknown = { ...base, sessionLive: 'unknown' as const }
  expect(workflowRunState({ ...unknown, lastTouchedMs: NOW - 10_000 })).toBe('running')
  expect(workflowRunState({ ...unknown, lastTouchedMs: NOW - RUN_STALE_MS - 1 })).toBe('abandoned')
})

// The run's own end-of-run record is a fact; everything else here is an inference over files.
test('the run’s own record outranks fresh files and a live session', () => {
  expect(workflowRunState({ ...base, recorded: 'killed', lastTouchedMs: NOW })).toBe('killed')
  expect(workflowRunState({ ...base, recorded: 'failed', lastTouchedMs: NOW })).toBe('failed')
})

test('only a killed run can be reported killed — the files cannot tell', () => {
  // Same evidence, minus the record: indistinguishable from a run that merely stopped.
  expect(workflowRunState({ ...base, sessionLive: false })).toBe('abandoned')
})

test('an unrecognised recorded word becomes null, never a guess', () => {
  expect(recordedRunState('exploded')).toBe(null)
  expect(recordedRunState(undefined)).toBe(null)
  expect(recordedRunState('killed')).toBe('killed')
  // A word we do not know must not decide the state; the inference rules take over.
  expect(workflowRunState({ ...base, recorded: recordedRunState('exploded'), lastTouchedMs: NOW - 1000 })).toBe('running')
})
