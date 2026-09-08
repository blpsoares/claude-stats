import { describe, expect, it } from 'bun:test'
import {
  agentIdFromFile, pageOfAgents, parseSubagentMeta, parseTaskOutcomes, subagentCost, subagentStatus,
  summarizeSubagent,
} from './subagents'

const line = (o: unknown) => JSON.stringify(o)

describe('agentIdFromFile', () => {
  it('takes a transcript and leaves everything else alone', () => {
    expect(agentIdFromFile('agent-a23c974fb8aab9fbf.jsonl')).toBe('a23c974fb8aab9fbf')
    expect(agentIdFromFile('agent-a23c974fb8aab9fbf.meta.json')).toBe(null)
    expect(agentIdFromFile('notes.jsonl')).toBe(null)
    expect(agentIdFromFile('agent-../../etc/passwd.jsonl')).toBe(null)
  })
})

describe('parseSubagentMeta — someone else’s format', () => {
  it('reads the identity the harness recorded', () => {
    const m = parseSubagentMeta('a1', JSON.stringify({
      agentType: 'general-purpose', description: 'Task 1', toolUseId: 'toolu_1',
      spawnDepth: 1, model: 'haiku',
    }))
    expect(m).toEqual({
      agentId: 'a1', agentType: 'general-purpose', description: 'Task 1',
      toolUseId: 'toolu_1', model: 'haiku', spawnDepth: 1,
    })
  })

  it('yields "not known" rather than throwing on junk', () => {
    expect(parseSubagentMeta('a1', 'not json')).toEqual({ agentId: 'a1' })
    expect(parseSubagentMeta('a1', '[]')).toEqual({ agentId: 'a1' })
    expect(parseSubagentMeta('a1', JSON.stringify({ description: 7 }))).toEqual({ agentId: 'a1' })
  })
})

describe('summarizeSubagent — the FOUR counters, or nothing', () => {
  const usage = (o: Record<string, number>) => line({
    type: 'assistant', timestamp: '2026-09-04T14:00:00.000Z',
    message: { model: 'claude-haiku-4-5-20251001', usage: o, content: [{ type: 'text', text: 'hi' }] },
  })

  it('sums every counter across the transcript’s calls', () => {
    const t = [
      usage({ input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 }),
      usage({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 }),
    ].join('\n')
    const s = summarizeSubagent(t)
    // A subagent's cache read dwarfs its input — an in+out reading here is 0,7 % of the volume.
    expect(s.tokens).toEqual({ input: 3, output: 4, cacheRead: 1000, cacheWrite: 10 })
    expect(s.model).toBe('claude-haiku-4-5-20251001')
  })

  it('reports NO usage as null, never as a zero breakdown', () => {
    // An agent that has been launched and not answered yet has not spent nothing; it is unmeasured.
    const s = summarizeSubagent(line({ type: 'user', message: { role: 'user', content: 'go' } }))
    expect(s.tokens).toBe(null)
  })

  it('counts tool calls and turns, and brackets the time', () => {
    const t = [
      line({ type: 'assistant', timestamp: 'A', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash' }] } }),
      line({ type: 'assistant', timestamp: 'B', message: { content: [{ type: 'tool_use', id: 'y', name: 'Read' }] } }),
    ].join('\n')
    const s = summarizeSubagent(t)
    expect(s.toolCalls).toBe(2)
    expect(s.turns).toBe(2)
    expect(s.startedAt).toBe('A')
    expect(s.lastAt).toBe('B')
  })

  it('survives a corrupt line', () => {
    const t = ['{oops', usage({ input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })].join('\n')
    expect(summarizeSubagent(t).tokens?.input).toBe(1)
  })
})

describe('parseTaskOutcomes — the parent RECORDS the outcome', () => {
  it('reads the id and status out of a notification', () => {
    const raw = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>' },
    })
    expect(parseTaskOutcomes(raw).get('a1')).toBe('completed')
  })

  it('takes the LAST notification — an agent can stop, resume and stop again', () => {
    const n = (id: string, s: string) => JSON.stringify({
      message: { content: `<task-notification><task-id>${id}</task-id><status>${s}</status></task-notification>` },
    })
    expect(parseTaskOutcomes([n('a1', 'completed'), n('a1', 'failed')].join('\n')).get('a1')).toBe('failed')
  })

  it('ignores every line that is not one', () => {
    expect(parseTaskOutcomes('{"type":"assistant"}\nnot json').size).toBe(0)
  })
})

describe('subagentStatus — recorded, never inferred', () => {
  it('reads what the parent recorded', () => {
    expect(subagentStatus('completed', true)).toBe('finished')
    expect(subagentStatus('failed', true)).toBe('failed')
  })

  it('keeps STOPPED apart from both its neighbours', () => {
    // Measured on one transcript: 116 completed, 4 failed, 4 stopped. An agent somebody stopped did
    // not fail and did not finish, and both of those are wrong about whose decision it was.
    expect(subagentStatus('stopped', true)).toBe('stopped')
    expect(subagentStatus('cancelled', false)).toBe('stopped')
  })

  it('is RUNNING only while the session is live', () => {
    expect(subagentStatus(undefined, true)).toBe('running')
  })

  it('says UNKNOWN when the session ended without recording an outcome', () => {
    // "We never saw how this one finished" is a different fact from "it finished".
    expect(subagentStatus(undefined, false)).toBe('unknown')
  })

  it('never maps a status it has no word for onto success', () => {
    expect(subagentStatus('something_new', true)).toBe('unknown')
  })
})

describe('subagentCost — a price needs both halves', () => {
  it('prices the four counters, cache included', () => {
    const withCache = subagentCost({ input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }, 'claude-haiku-4-5-20251001')
    expect(withCache).toBeGreaterThan(0)
  })

  it('withholds a price rather than inventing one', () => {
    expect(subagentCost(null, 'claude-haiku-4-5-20251001')).toBe(null)
    expect(subagentCost({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, null)).toBe(null)
  })
})

describe('pageOfAgents — the page is chosen before anything is opened', () => {
  const f = (agentId: string, mtimeMs: number) => ({ agentId, mtimeMs })

  it('orders by LAST ACTIVITY, newest first', () => {
    // From the file's mtime, not `startedAt`: that one is inside the transcript, so ordering by it
    // would mean reading every transcript to decide which twenty to read.
    const p = pageOfAgents([f('old', 100), f('new', 300), f('mid', 200)], 10, 0)
    expect(p.files.map(x => x.agentId)).toEqual(['new', 'mid', 'old'])
  })

  it('reports the total and whether there are older ones behind the page', () => {
    const all = Array.from({ length: 57 }, (_, i) => f(`a${i}`, i))
    const first = pageOfAgents(all, 20, 0)
    expect(first.files).toHaveLength(20)
    expect(first.total).toBe(57)
    expect(first.hasMore).toBe(true)
    const last = pageOfAgents(all, 20, 40)
    expect(last.files).toHaveLength(17)
    expect(last.hasMore).toBe(false)
  })

  it('clamps a nonsense request instead of returning an empty page', () => {
    // It comes from a query string, and an empty page for a typo reads as "this session ran none".
    const all = [f('a', 1), f('b', 2)]
    expect(pageOfAgents(all, 10, -5).files).toHaveLength(2)
    expect(pageOfAgents(all, 0, 0).files).toHaveLength(1)
    expect(pageOfAgents(all, 10, 99)).toEqual({ files: [], total: 2, hasMore: false })
  })
})
