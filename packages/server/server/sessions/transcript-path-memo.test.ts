import { describe, expect, test } from 'bun:test'
import { createTranscriptPathMemo, resolveMemoizedPath, TRANSCRIPT_MISS_TTL_MS } from './transcript-path-memo'

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

describe('a remembered path is verified — a transcript DOES move', () => {
  const ID = 'c1'
  const HERE = '/p/a/c1.jsonl'
  const THERE = '/p/b/c1.jsonl'
  const never = async () => null
  const noFiles = async () => false
  const onlyThere = async (p: string) => p === THERE

  test('THE REPORTED CASE: the file moved, so the memo is dropped and the scan finds it', async () => {
    // Measured 2026-09-08: a live session's cwd changed, Claude Code re-filed the whole 2.4 MB
    // transcript under another project directory, and the chat panel drew "no messages yet" over
    // it — because the memo answered the old path and nothing ever checked it was still there.
    const m = createTranscriptPathMemo()
    m.remember(ID, HERE)
    const got = await resolveMemoizedPath(m, ID, {
      exists: onlyThere, scan: async () => THERE, now: 0,
    })
    expect(got).toBe(THERE)
    expect(m.get(ID)).toBe(THERE)
  })

  test('a remembered path that is still there costs one stat and no scan', async () => {
    const m = createTranscriptPathMemo()
    m.remember(ID, HERE)
    let scans = 0
    const got = await resolveMemoizedPath(m, ID, {
      exists: async () => true,
      scan: async () => { scans++; return null },
      now: 0,
    })
    expect(got).toBe(HERE)
    expect(scans).toBe(0)
  })

  test('a STALE hit never buys the miss TTL — the scan runs on that very call', async () => {
    // Forgetting alone would be half a fix: if the stale path could leave a miss standing, the
    // conversation would stay unreadable for the length of the TTL after every move.
    const m = createTranscriptPathMemo(30_000)
    m.remember(ID, HERE)
    let scans = 0
    await resolveMemoizedPath(m, ID, {
      exists: noFiles, scan: async () => { scans++; return null }, now: 0,
    })
    expect(scans).toBe(1)
  })

  test('THE DELETION CASE: Claude Code removes transcripts after 30 days, and it reads the same', async () => {
    // No cwd change needed to reach this. A long-lived server that once resolved a conversation
    // holds a path to a file that is eventually deleted under it.
    const m = createTranscriptPathMemo()
    m.remember(ID, HERE)
    const got = await resolveMemoizedPath(m, ID, { exists: noFiles, scan: never, now: 0 })
    expect(got).toBeNull()
    expect(m.get(ID)).toBeUndefined()
  })

  test('the DIRECT path is preferred to a scan and is remembered', async () => {
    const m = createTranscriptPathMemo()
    let scans = 0
    const got = await resolveMemoizedPath(m, ID, {
      exists: noFiles,
      direct: async () => HERE,
      scan: async () => { scans++; return THERE },
      now: 0,
    })
    expect(got).toBe(HERE)
    expect(scans).toBe(0)
    expect(m.get(ID)).toBe(HERE)
  })

  test('a fresh miss still withholds the scan — the old guarantee is intact', async () => {
    const m = createTranscriptPathMemo(30_000)
    let scans = 0
    const scan = async () => { scans++; return null }
    await resolveMemoizedPath(m, ID, { exists: noFiles, scan, now: 0 })
    await resolveMemoizedPath(m, ID, { exists: noFiles, scan, now: 1_000 })
    expect(scans).toBe(1)
    await resolveMemoizedPath(m, ID, { exists: noFiles, scan, now: 30_000 })
    expect(scans).toBe(2)
  })
})
