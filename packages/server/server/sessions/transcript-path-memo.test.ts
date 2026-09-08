import { describe, expect, test } from 'bun:test'
import { createTranscriptPathMemo, TRANSCRIPT_MISS_TTL_MS } from './transcript-path-memo'

describe('transcript path memo — a miss is a fact about the MOMENT', () => {
  const ID = 'c1'

  test('a found path is remembered', () => {
    const m = createTranscriptPathMemo()
    m.remember(ID, '/p/c1.jsonl')
    expect(m.get(ID)).toBe('/p/c1.jsonl')
  })

  test('THE REPORTED CASE: a miss does not answer forever', () => {
    // A session created from the wizard has no transcript for the first seconds of its life, and
    // the chat view's first poll lands inside that window. Caching that `null` for the process made
    // the conversation unreadable until the server restarted: messages stuck at "not read yet",
    // replies never arriving, the whole conversation visible in the terminal tab all along.
    const m = createTranscriptPathMemo(1000)
    m.missed(ID, 0)
    expect(m.mayScan(ID, 500)).toBe(false)
    expect(m.mayScan(ID, 1000)).toBe(true)
  })

  test('an id never seen may always be scanned for', () => {
    expect(createTranscriptPathMemo().mayScan('never', 0)).toBe(true)
  })

  test('finding it settles the question — no miss survives to gate a later scan', () => {
    const m = createTranscriptPathMemo(10_000)
    m.missed(ID, 0)
    m.remember(ID, '/p/c1.jsonl')
    expect(m.mayScan(ID, 1)).toBe(true)
    expect(m.get(ID)).toBe('/p/c1.jsonl')
  })

  test('the default TTL is far longer than one chat poll and far shorter than a session', () => {
    // The number is the only thing standing between "one scan per poll" and "one scan per miss",
    // so it is pinned rather than left to drift.
    expect(TRANSCRIPT_MISS_TTL_MS).toBe(30_000)
  })
})
