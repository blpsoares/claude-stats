import { describe, expect, it, test } from 'bun:test'
import { agoLabel, isDoc, liveEvents, writeStatus, toolDisplayName } from './artifactTabs'

test('a document is decided by extension or by a known name', () => {
  for (const p of ['docs/spec.md', 'a/b/NOTES.txt', 'README', 'CHANGELOG.md', 'x/plan.mdx']) {
    expect(isDoc(p), p).toBe(true)
  }
})

test('code is not a document, however its path reads', () => {
  // Deciding "is this a spec" from a path's WORDS would file this under documentation.
  for (const p of ['packages/server/spec-runner.ts', 'src/readme.tsx', 'a/docs.ts', 'x.json']) {
    expect(isDoc(p), p).toBe(false)
  }
})

test('the feed names the KIND of each thing, in the transcript order', () => {
  const out = liveEvents([
    { role: 'assistant', thinking: 'weighing two options\nmore', tools: [
      { name: 'Read', detail: 'src/a.ts' },
      { name: 'Bash', detail: 'bun test', writes: ['out.log'] },
      { name: 'Edit', detail: 'src/b.ts' },
      { name: 'Agent', detail: 'review the diff' },
    ], text: 'Doing the thing.' },
  ])
  // The Bash call is TWO events: it ran, and then its file appeared. Collapsing them would lose
  // either what was run or what it produced.
  expect(out.map(e => e.kind)).toEqual(['thought', 'read', 'ran', 'wrote', 'wrote', 'delegated'])
  expect(out[0]!.text).toBe('weighing two options')
})

test('a subagent is DELEGATED, never "ran" — it starts work somewhere else', () => {
  const out = liveEvents([{ tools: [{ name: 'Agent', detail: 'audit the routes' }] }])
  expect(out).toEqual([{ kind: 'delegated', text: 'audit the routes', live: false }])
})

test('the pending turn is marked live, so the panel can say what is happening NOW', () => {
  const out = liveEvents([{ pending: true, tools: [{ name: 'Bash', detail: 'bun run build' }] }])
  expect(out[0]).toMatchObject({ kind: 'ran', live: true })
})

test('NO PROSE, from either side — this tab is what the harness DID', () => {
  // The assistant's own text buried the tool calls under paragraphs, and what it said is the
  // conversation, one tab away and rendered properly there.
  expect(liveEvents([{ role: 'user', text: 'do the thing' }])).toEqual([])
  expect(liveEvents([{ role: 'assistant', text: 'I will now do the thing.' }])).toEqual([])
})

test('reasoning stays — it is the harness working, not a message', () => {
  // It is the only signal for the stretch between two tool calls where nothing else happens.
  const out = liveEvents([{ role: 'assistant', thinking: 'weighing two options', text: 'ok' }])
  expect(out.map(e => e.kind)).toEqual(['thought'])
})

test('an empty conversation produces an empty feed rather than a placeholder row', () => {
  expect(liveEvents([])).toEqual([])
  expect(liveEvents([{ role: 'assistant', text: '   ' }])).toEqual([])
})

test('an event carries the time of the turn that produced it', () => {
  const out = liveEvents([{ at: '2026-09-04T12:00:00Z', tools: [{ name: 'Bash', detail: 'ls' }] }])
  expect(out[0]!.at).toBe('2026-09-04T12:00:00Z')
})

test('a turn with NO recorded time produces events with none — nothing is invented', () => {
  const out = liveEvents([{ tools: [{ name: 'Bash', detail: 'ls' }] }])
  expect(out[0]!.at).toBeUndefined()
})

test('the ago label is the shortest true form, and empty when there is no time', () => {
  const now = Date.parse('2026-09-04T12:00:00Z')
  expect(agoLabel('2026-09-04T11:59:57Z', now, false)).toBe('now')
  expect(agoLabel('2026-09-04T11:59:30Z', now, false)).toBe('30s')
  expect(agoLabel('2026-09-04T11:45:00Z', now, false)).toBe('15m')
  expect(agoLabel('2026-09-04T09:00:00Z', now, false)).toBe('3h')
  expect(agoLabel('2026-09-01T12:00:00Z', now, false)).toBe('3d')
  expect(agoLabel(undefined, now, false)).toBe('')
  expect(agoLabel('not a date', now, false)).toBe('')
})

describe('writeStatus', () => {
  const disk = new Set(['/repo/a.ts'])

  it('a listed file opens', () => {
    expect(writeStatus('/repo/a.ts', disk)).toBe('open')
  })

  it('scratch is named as scratch, not as missing — the reader is told which', () => {
    for (const p of ['/tmp/msg.txt', '/var/tmp/x.log', '/var/folders/ab/cd/T/y']) {
      expect(writeStatus(p, disk), p).toBe('temp')
    }
  })

  it('a project file called tmp.ts is NOT scratch', () => {
    // A rule matching "tmp" anywhere in the path would mislabel real work.
    expect(writeStatus('/repo/src/tmp.ts', disk)).toBe('gone')
  })

  it('anything else the server did not list is gone', () => {
    expect(writeStatus('/repo/deleted.ts', disk)).toBe('gone')
  })
})

// --- a call that matched no verb is still something that happened -----------
//
// MEASURED on a real subagent: 95 tool calls, every one `mcp__playwright__*`, and the panel said
// "This subagent recorded no actions." The chain ended after Bash/write/read/delegate, so anything
// else produced no row — and `toolDetail` on the server looks for `command`/`file_path`/`query`/…,
// none of which an MCP call carries, so there was no text either.

test('an MCP call produces a row, named by its tool', () => {
  const evs = liveEvents([{ tools: [{ name: 'mcp__playwright__browser_click', ref: 't1' }] }] as never)
  expect(evs).toHaveLength(1)
  expect(evs[0]!.kind).toBe('used')
  expect(evs[0]!.text).toBe('playwright · browser_click')
  expect(evs[0]!.ref).toBe('t1')
})

test('the tool name keeps BOTH halves — server and tool', () => {
  expect(toolDisplayName('mcp__playwright__browser_click')).toBe('playwright · browser_click')
  expect(toolDisplayName('mcp__MongoDB__find')).toBe('MongoDB · find')
  // A mapping, never a filter: a name it does not know passes through as itself.
  expect(toolDisplayName('ToolSearch')).toBe('ToolSearch')
  expect(toolDisplayName('Bash')).toBe('Bash')
})

test('a detail is preferred over the tool name when the call carries one', () => {
  const evs = liveEvents([{ tools: [{ name: 'ToolSearch', detail: 'select:Read,Edit' }] }] as never)
  expect(evs[0]!.text).toBe('select:Read,Edit')
})

// The fallback must not double up on calls the chain already spoke for.
test('a call that already produced a row does not get a second one', () => {
  expect(liveEvents([{ tools: [{ name: 'Bash', detail: 'ls -la' }] }] as never)).toHaveLength(1)
  expect(liveEvents([{ tools: [{ name: 'Read', detail: '/a/b.ts' }] }] as never)).toHaveLength(1)
  expect(liveEvents([{ tools: [{ name: 'Agent', detail: 'sweep' }] }] as never)).toHaveLength(1)
})

// A Bash call with NO detail said nothing at all before; it is still a shell command that ran.
test('a Bash call with no detail is still a row', () => {
  const evs = liveEvents([{ tools: [{ name: 'Bash' }] }] as never)
  expect(evs).toHaveLength(1)
  expect(evs[0]!.text).toBe('Bash')
})
