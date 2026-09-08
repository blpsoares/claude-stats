import { test, expect } from 'bun:test'
import { MAX_BROADCAST, broadcastReport, planBroadcast } from './broadcast-plan'
import type { BroadcastCandidate } from './broadcast-plan'

const row = (id: string, o: Partial<BroadcastCandidate> = {}): BroadcastCandidate => ({
  id, title: id.toUpperCase(), running: true, blocked: false, ...o,
})

test('sends to the running rows that were ticked', () => {
  const p = planBroadcast({ text: 'ship it', ids: ['a', 'b'], rows: [row('a'), row('b'), row('c')] })
  expect(p.ok).toBe(true)
  if (!p.ok) throw new Error('expected ok')
  expect(p.targets.map(t => t.id)).toEqual(['a', 'b'])
  expect(p.skipped).toEqual([])
})

/**
 * A prompt to a row that is not running has nowhere to go, and one to a row sitting on a dialog
 * goes into the dialog's filter where the submit takes whatever is highlighted. Both are REPORTED:
 * a count that shrinks between what was ticked and what was sent is what makes somebody re-send.
 */
test('names what it will not send to, rather than dropping it', () => {
  const p = planBroadcast({
    text: 'go',
    ids: ['live', 'dead', 'asking'],
    rows: [row('live'), row('dead', { running: false }), row('asking', { blocked: true })],
  })
  expect(p.ok).toBe(true)
  if (!p.ok) throw new Error('expected ok')
  expect(p.targets.map(t => t.id)).toEqual(['live'])
  expect(p.skipped).toEqual([
    { id: 'dead', title: 'DEAD', reason: 'not-running' },
    { id: 'asking', title: 'ASKING', reason: 'dialog-open' },
  ])
})

test('an id nobody knows is its own reason, and keeps the id as its label', () => {
  const p = planBroadcast({ text: 'go', ids: ['ghost'], rows: [row('a')] })
  expect(p.ok).toBe(false)
  if (p.ok) throw new Error('expected refusal')
  expect(p.reason).toBe('none-eligible')
  expect(p.skipped).toEqual([{ id: 'ghost', title: 'ghost', reason: 'unknown' }])
})

/** Refused, not "sent to nobody" — the mistake has to be visible. */
test('an empty prompt is refused', () => {
  expect(planBroadcast({ text: '   ', ids: ['a'], rows: [row('a')] }))
    .toEqual({ ok: false, reason: 'no-text', skipped: [] })
})

/**
 * Unlike `selectFell`, there is NO "all" here. Reopening what a crash took has a defensible one;
 * typing into every session on the machine does not.
 */
test('an empty selection is refused and never read as everything', () => {
  expect(planBroadcast({ text: 'go', ids: [], rows: [row('a'), row('b')] }))
    .toEqual({ ok: false, reason: 'no-selection', skipped: [] })
})

test('the same row ticked twice is one target', () => {
  const p = planBroadcast({ text: 'go', ids: ['a', 'a'], rows: [row('a')] })
  if (!p.ok) throw new Error('expected ok')
  expect(p.targets).toHaveLength(1)
})

/** A blast radius, not a performance limit: beyond this the list stops being read before pressing. */
test('refuses more than the cap', () => {
  const rows = Array.from({ length: MAX_BROADCAST + 1 }, (_, i) => row(`s${i}`))
  const p = planBroadcast({ text: 'go', ids: rows.map(r => r.id), rows })
  expect(p.ok).toBe(false)
  if (p.ok) throw new Error('expected refusal')
  expect(p.reason).toBe('too-many')
  // Exactly at the cap is fine.
  const at = rows.slice(0, MAX_BROADCAST)
  expect(planBroadcast({ text: 'go', ids: at.map(r => r.id), rows }).ok).toBe(true)
})

/**
 * The cap counts TARGETS, not the selection: rows that were going to be skipped anyway cost
 * nothing, and refusing over them would be refusing over something that was not going to happen.
 */
test('rows that would be skipped do not count against the cap', () => {
  const live = Array.from({ length: MAX_BROADCAST }, (_, i) => row(`l${i}`))
  const dead = Array.from({ length: 20 }, (_, i) => row(`d${i}`, { running: false }))
  const p = planBroadcast({
    text: 'go', ids: [...live, ...dead].map(r => r.id), rows: [...live, ...dead],
  })
  expect(p.ok).toBe(true)
})

/**
 * PER SESSION, always. A broadcast is the one action here where partial success is NORMAL — one
 * takes it, one is mid-dialog by the time its turn comes, one has just died — and collapsing that
 * into "sent to 5 sessions" makes exactly the failures invisible that re-reading each screen at
 * write time exists to produce.
 */
test('the report keeps every outcome, and counts both sides', () => {
  const r = broadcastReport(
    [
      { id: 'a', title: 'A', ok: true, message: 'sent' },
      { id: 'b', title: 'B', ok: false, message: 'that session is not asking anything right now' },
    ],
    [{ id: 'c', title: 'C', reason: 'not-running' }],
  )
  expect(r.sent).toBe(1)
  expect(r.failed).toBe(1)
  expect(r.skipped).toHaveLength(1)
  expect(r.outcomes.find(o => o.id === 'b')!.message).toContain('not asking')
})
