import { test, expect } from 'bun:test'
import {
  workflowsStateOf, workflowCount, liveRunCount, workflowsPollMs, runStatusText,
  runStatusNote, runDurationText, unmeasuredRunText, WORKFLOW_POLL_MS,
  groupAgentsByPhase, labelCaveat, agentOpenable, agentDetailUrl, agentDetailStateOf,
  agentIsRunning, runningCommandIndex, runOpensByDefault, agentOpensByDefault,
  placementKnown, declaredPhases,
  type WorkflowRunRow, type WorkflowsPayload, type WorkflowAgentRow,
} from './workflows'

const ag = (over: Partial<WorkflowAgentRow> = {}): WorkflowAgentRow => ({
  agentId: 'a1', label: 'x', labelSource: 'record', phase: 'A', toolCalls: 3, model: 'opus',
  tokens: null, totalTokens: null, costUSD: null, ...over,
})

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

// --- phases -----------------------------------------------------------------

test('agents are grouped under their phase, in the run’s recorded order', () => {
  const r = run({
    phases: [{ title: 'Contract', agentCount: 2 }, { title: 'Critique', agentCount: 1 }],
    agents: [
      ag({ agentId: 'a1', label: 'critique:x', phase: 'Critique' }),
      ag({ agentId: 'a2', label: 'contract:x', phase: 'Contract' }),
      ag({ agentId: 'a3', label: 'contract:y', phase: 'Contract' }),
    ],
  })
  const g = groupAgentsByPhase(r)
  expect(g.map(x => x.title)).toEqual(['Contract', 'Critique'])
  expect(g[0]!.agents.map(a => a.label)).toEqual(['contract:x', 'contract:y'])
  expect(g[1]!.agents.map(a => a.label)).toEqual(['critique:x'])
})

// The counts on the card must never disagree with what is listed under it.
test('an agent nothing could place is kept, in its own last group', () => {
  const r = run({
    phases: [{ title: 'A', agentCount: 1 }],
    agents: [ag({ agentId: 'a1', phase: 'A' }), ag({ agentId: 'a2', phase: '', labelSource: 'none' })],
  })
  const g = groupAgentsByPhase(r)
  expect(g.map(x => x.title)).toEqual(['A', ''])
  expect(g.flatMap(x => x.agents).length).toBe(2)
})

test('a phase that ran nothing is still shown — that it ran nothing is information', () => {
  const r = run({ phases: [{ title: 'A', agentCount: 0 }, { title: 'B', agentCount: 1 }], agents: [ag({ phase: 'B' })] })
  const g = groupAgentsByPhase(r)
  expect(g.map(x => x.title)).toEqual(['A', 'B'])
  expect(g[0]!.agents).toEqual([])
})

test('a phase only the agents name is added after the declared ones', () => {
  const r = run({ phases: [{ title: 'A', agentCount: 0 }], agents: [ag({ phase: 'Z' })] })
  expect(groupAgentsByPhase(r).map(x => x.title)).toEqual(['A', 'Z'])
})

test('a run with no phases at all puts every agent in the unplaced group', () => {
  const r = run({ phases: [], agents: [ag({ phase: '' }), ag({ agentId: 'a2', phase: '' })] })
  const g = groupAgentsByPhase(r)
  expect(g.length).toBe(1)
  expect(g[0]!.title).toBe('')
  expect(g[0]!.agents.length).toBe(2)
})

// A guessed label and a recorded one look identical on screen.
test('only a label the run recorded goes without a caveat', () => {
  expect(labelCaveat(ag({ labelSource: 'record' }), true)).toBe(null)
  expect(labelCaveat(ag({ labelSource: 'matched' }), true)).toContain('deduzido')
  expect(labelCaveat(ag({ labelSource: 'none' }), true)).toContain('não registrou')
})

test('an agent with no id cannot be opened, so the row must not offer it', () => {
  expect(agentOpenable(ag())).toBe(true)
  expect(agentOpenable(ag({ agentId: undefined }))).toBe(false)
  expect(agentOpenable(ag({ agentId: '' }))).toBe(false)
})

test('the detail url carries the run AND the agent, both escaped', () => {
  const u = agentDetailUrl('closed:a b', 'wf_1', 'a1', true)
  expect(u).toContain('id=closed%3Aa%20b')
  expect(u).toContain('run=wf_1')
  expect(u).toContain('agent=a1')
})

test('a refused detail keeps its sentence', () => {
  expect(agentDetailStateOf({ ok: false, message: 'gone' })).toEqual({ phase: 'failed', message: 'gone' })
})

// --- following a run while it happens ---------------------------------------

test('a pending agent counts as running only while the run itself is live', () => {
  const a = ag({ pending: true })
  expect(agentIsRunning(a, true)).toBe(true)
  // A killed run leaves the same dangling call behind; nothing in it is happening now.
  expect(agentIsRunning(a, false)).toBe(false)
  expect(agentIsRunning(ag({ pending: false }), true)).toBe(false)
  expect(agentIsRunning(ag({ pending: undefined }), true)).toBe(false)
})

test('the highlighted line is the pending one, and nothing when it would be a guess', () => {
  expect(runningCommandIndex(2, 5, true)).toBe(2)
  expect(runningCommandIndex(2, 5, false)).toBe(null)   // the run is over
  expect(runningCommandIndex(null, 5, true)).toBe(null) // nothing pending
  // Past the end of a clipped list: the line exists but is not on screen, and highlighting the
  // last visible one instead would point at the wrong command.
  expect(runningCommandIndex(7, 5, true)).toBe(null)
  expect(runningCommandIndex(-1, 5, true)).toBe(null)
})

test('a live run opens by itself; a finished one does not', () => {
  expect(runOpensByDefault(run({ live: true, status: 'running' }))).toBe(true)
  expect(runOpensByDefault(run({ live: false }))).toBe(false)
})

test('inside a live run, the working agent is the one that opens', () => {
  expect(agentOpensByDefault(ag({ pending: true }), true)).toBe(true)
  expect(agentOpensByDefault(ag({ pending: false }), true)).toBe(false)
  // Nothing to open when there is no transcript to ask for.
  expect(agentOpensByDefault(ag({ pending: true, agentId: undefined }), true)).toBe(false)
})

test('placement is unknown while a run is going, and the plan is still nameable', () => {
  const live = run({
    live: true, status: 'running',
    phases: [{ title: 'Recon', agentCount: 0 }, { title: 'Build', agentCount: 0 }],
    agents: [ag({ phase: '', labelSource: 'none' }), ag({ agentId: 'a2', phase: '', labelSource: 'none' })],
  })
  expect(placementKnown(live)).toBe(false)
  expect(declaredPhases(live)).toEqual(['Recon', 'Build'])
})

test('placement is known as soon as one agent carries a phase', () => {
  expect(placementKnown(run({ agents: [ag({ phase: 'A' }), ag({ agentId: 'a2', phase: '' })] }))).toBe(true)
  expect(placementKnown(run({ agents: [] }))).toBe(false)
})
