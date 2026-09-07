import { expect, test } from 'bun:test'
import { capClosedConversations, HARNESS_FLOOR } from './closed-cap'

const conv = (id: string, harness: string, at: number) =>
  ({ sessionId: id, harness, lastActivityMs: at })

/** 320 claude conversations, then a handful of everything else — the shape measured on the report. */
function fleet() {
  const out = []
  let t = 10_000
  for (let i = 0; i < 320; i++) out.push(conv(`c${i}`, 'claude', t--))
  for (let i = 0; i < 15; i++) out.push(conv(`a${i}`, 'antigravity', t--))
  for (let i = 0; i < 12; i++) out.push(conv(`k${i}`, 'kimi', t--))
  return out
}

test('a list under the cap is returned whole', () => {
  const l = [conv('a', 'claude', 2), conv('b', 'codex', 1)]
  expect(capClosedConversations(l, 300).length).toBe(2)
})

test('no harness with conversations is erased by the cap', () => {
  const out = capClosedConversations(fleet(), 300)
  const by = new Map<string, number>()
  for (const c of out) by.set(c.harness, (by.get(c.harness) ?? 0) + 1)
  expect(by.get('antigravity')).toBe(15)   // all it has, which is under the floor
  expect(by.get('kimi')).toBe(12)          // it has fewer than the floor: it keeps all of them
  expect(by.get('claude')).toBe(300)       // the recency cut is untouched
})

test('the global newest-first order survives — no block of old rows stapled to the end', () => {
  const out = capClosedConversations(fleet(), 300)
  const times = out.map(c => c.lastActivityMs)
  expect([...times].sort((a, b) => b - a)).toEqual(times)
})

test('one harness alone does not inflate the cap — the rescue is not a quota', () => {
  const l = [...Array(50)].map((_, i) => conv(`c${i}`, 'claude', 100 - i))
  expect(capClosedConversations(l, 10).length).toBe(10)
})

test('a harness the cut merely TRUNCATED is left as the ordering decided it', () => {
  // codex is represented — two rows of its fourteen — so nothing is added back for it.
  const l = [
    ...[...Array(10)].map((_, i) => conv(`c${i}`, 'claude', 100 - i)),
    ...[...Array(14)].map((_, i) => conv(`x${i}`, 'codex', 89 - i)),
  ]
  const out = capClosedConversations(l, 12)
  expect(out.filter(c => c.harness === 'codex').length).toBe(2)
  expect(out.length).toBe(12)
})

test('a floor of zero is the old behaviour exactly', () => {
  const out = capClosedConversations(fleet(), 300, 0)
  expect(out.length).toBe(300)
  expect(out.every(c => c.harness === 'claude')).toBe(true)
})
