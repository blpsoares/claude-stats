import { test, expect } from 'bun:test'
import { parseWorkflowProgress, agentIdOfFile } from './workflow-progress'

// The shape measured on a real record.
const record = {
  workflowProgress: [
    { type: 'workflow_phase', index: 1, title: 'Contract' },
    { type: 'workflow_phase', index: 2, title: 'Critique' },
    { type: 'workflow_agent', index: 1, label: 'contract:fleet-first-data', phaseIndex: 1, phaseTitle: 'Contract', agentId: 'ad4ec8653fb256469' },
    { type: 'workflow_agent', index: 2, label: 'critique:fleet-first-data', phaseIndex: 2, phaseTitle: 'Critique', agentId: 'a6b4157c455143bc5' },
  ],
}

test('an agent is placed exactly, by the id its file is named after', () => {
  const p = parseWorkflowProgress(record)
  expect(p.byAgent.get('ad4ec8653fb256469')).toEqual({ label: 'contract:fleet-first-data', phase: 'Contract' })
  expect(agentIdOfFile('agent-ad4ec8653fb256469.jsonl')).toBe('ad4ec8653fb256469')
})

test('phases keep the order the run declared them in', () => {
  expect(parseWorkflowProgress(record).phases).toEqual(['Contract', 'Critique'])
})

test('a phase named only by an agent still counts, after the declared ones', () => {
  const p = parseWorkflowProgress({
    workflowProgress: [
      { type: 'workflow_phase', title: 'A' },
      { type: 'workflow_agent', label: 'x', phaseTitle: 'B', agentId: 'a1' },
    ],
  })
  expect(p.phases).toEqual(['A', 'B'])
})

test('a phase declared twice is one phase', () => {
  const p = parseWorkflowProgress({
    workflowProgress: [
      { type: 'workflow_phase', title: 'A' },
      { type: 'workflow_phase', title: 'A' },
    ],
  })
  expect(p.phases).toEqual(['A'])
})

// Empty is the signal to fall back to the heuristic matcher, so it must never be a half-answer.
test('anything unexpected yields empty rather than a half-read placement', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { workflowProgress: 'no' }, { workflowProgress: [1, null, {}] }]) {
    const p = parseWorkflowProgress(bad)
    expect(p.phases).toEqual([])
    expect(p.byAgent.size).toBe(0)
  }
})

test('an entry with no label settles nothing the file name does not, so it is not a placement', () => {
  const p = parseWorkflowProgress({
    workflowProgress: [{ type: 'workflow_agent', phaseTitle: 'A', agentId: 'a1' }],
  })
  expect(p.byAgent.size).toBe(0)
})

test('an agent with no phase is still placed — the label is the useful half', () => {
  const p = parseWorkflowProgress({
    workflowProgress: [{ type: 'workflow_agent', label: 'solo', agentId: 'a1' }],
  })
  expect(p.byAgent.get('a1')).toEqual({ label: 'solo', phase: '' })
  expect(p.phases).toEqual([])
})

test('a file name that is not an agent transcript yields null', () => {
  expect(agentIdOfFile('journal.jsonl')).toBe(null)
  expect(agentIdOfFile('agent-.jsonl')).toBe(null)
  expect(agentIdOfFile('agent-abc.json')).toBe(null)
})
