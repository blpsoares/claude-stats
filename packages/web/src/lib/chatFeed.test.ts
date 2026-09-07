import { describe, it, expect } from 'bun:test'
import {
  feedDue,
  feedExpired,
  firstFrameStale,
  newEntry,
  warmToDrop,
  stampsToDrop,
  MAX_STAMPS,
  FOREGROUND_POLL_MS,
  WARM_POLL_MS,
  WARM_TTL_MS,
  STALE_FRAME_MS,
  type FeedEntry,
} from './chatFeed'

const NOW = 1_000_000

function entry(over: Partial<FeedEntry> = {}): FeedEntry {
  return { ...newEntry(), ...over }
}

describe('feedDue — a watched conversation', () => {
  it('is read at once when it has never been read', () => {
    expect(feedDue(entry({ watchers: 1 }), NOW, true)).toBe(true)
  })

  it('keeps the cadence the view has always had', () => {
    const e = entry({ watchers: 1, triedAt: NOW - FOREGROUND_POLL_MS + 1 })
    expect(feedDue(e, NOW, true)).toBe(false)
    expect(feedDue({ ...e, triedAt: NOW - FOREGROUND_POLL_MS }, NOW, true)).toBe(true)
  })

  it('is read even in a hidden tab — the browser throttles that timer by itself', () => {
    // Suppressing it here would add a second rule on top of the browser's, and the visibility
    // handler that asks the moment the tab comes back is what actually closes the gap.
    expect(feedDue(entry({ watchers: 1, triedAt: NOW - FOREGROUND_POLL_MS }), NOW, false)).toBe(true)
  })
})

describe('feedDue — a conversation nobody has open', () => {
  it('is read at a slower cadence than a watched one', () => {
    const left = entry({ watchers: 0, leftAt: NOW - 1000, triedAt: NOW - FOREGROUND_POLL_MS })
    expect(feedDue(left, NOW, true)).toBe(false)
    expect(feedDue({ ...left, triedAt: NOW - WARM_POLL_MS }, NOW, true)).toBe(true)
  })

  it('is NOT read while the document is hidden', () => {
    // A hidden tab has no reader to be surprised by a stale first frame, and a background poll
    // nobody asked for is exactly the kind of thing that quietly costs a machine.
    const e = entry({ watchers: 0, leftAt: NOW - 1000, triedAt: NOW - WARM_POLL_MS })
    expect(feedDue(e, NOW, false)).toBe(false)
  })

  it('is NOT read once the warm window has closed', () => {
    const e = entry({ watchers: 0, leftAt: NOW - WARM_TTL_MS, triedAt: NOW - WARM_POLL_MS })
    expect(feedDue(e, NOW, true)).toBe(false)
  })

  it('is NOT read when the session has ended — its transcript is final', () => {
    const e = entry({ watchers: 0, leftAt: NOW - 1000, triedAt: NOW - WARM_POLL_MS, ended: true })
    expect(feedDue(e, NOW, true)).toBe(false)
  })

  it('IS still read while watched, even after it ended — the view asked for it', () => {
    const e = entry({ watchers: 1, leftAt: null, triedAt: NOW - FOREGROUND_POLL_MS, ended: true })
    expect(feedDue(e, NOW, true)).toBe(true)
  })
})

describe('feedExpired', () => {
  it('never expires something on screen', () => {
    expect(feedExpired(entry({ watchers: 1, leftAt: NOW - WARM_TTL_MS * 10, ended: true }), NOW)).toBe(false)
  })

  it('drops an ended conversation AT ONCE — an entry nothing reads is pure memory', () => {
    // It holds the last answer's bytes (90-106 KB on the largest sessions here) and nothing would
    // ever re-read it. What a reopened conversation needs is the read STAMP, and that outlives the
    // entry in its own map.
    expect(feedExpired(entry({ watchers: 0, leftAt: NOW, ended: true }), NOW)).toBe(true)
  })

  it('expires exactly at the warm TTL', () => {
    expect(feedExpired(entry({ watchers: 0, leftAt: NOW - WARM_TTL_MS + 1 }), NOW)).toBe(false)
    expect(feedExpired(entry({ watchers: 0, leftAt: NOW - WARM_TTL_MS }), NOW)).toBe(true)
  })
})

describe('warmToDrop', () => {
  it('keeps the most recently left and drops the rest', () => {
    const list = [
      ['a', entry({ watchers: 0, leftAt: 100 })],
      ['b', entry({ watchers: 0, leftAt: 300 })],
      ['c', entry({ watchers: 0, leftAt: 200 })],
    ] as const
    expect(warmToDrop(list, 2)).toEqual(['a'])
  })

  it('never drops a conversation something is showing, however long ago it was left', () => {
    const list = [
      ['open', entry({ watchers: 1, leftAt: 1 })],
      ['x', entry({ watchers: 0, leftAt: 300 })],
      ['y', entry({ watchers: 0, leftAt: 200 })],
    ] as const
    expect(warmToDrop(list, 1)).toEqual(['y'])
  })

  it('drops nothing while it is within the budget', () => {
    expect(warmToDrop([['a', entry({ watchers: 0, leftAt: 1 })]], 2)).toEqual([])
  })
})

describe('firstFrameStale', () => {
  it('an UNKNOWN age is stale', () => {
    // A frame this session never saw read is a frame of unknown age, and presenting one as current
    // is the whole defect: the reader is shown their own last message and then, with nothing said,
    // every reply that landed while they were away.
    expect(firstFrameStale(null, NOW)).toBe(true)
    expect(firstFrameStale(undefined, NOW)).toBe(true)
  })

  it('a frame from between two polls is not announced as stale', () => {
    expect(firstFrameStale(NOW - STALE_FRAME_MS + 1, NOW)).toBe(false)
    expect(firstFrameStale(NOW - STALE_FRAME_MS, NOW)).toBe(true)
  })
})

describe('stampsToDrop', () => {
  it('forgets nothing while the map is within budget', () => {
    expect(stampsToDrop([['a', 1], ['b', 2]], 2)).toEqual([])
  })

  it('forgets the LEAST recently read first', () => {
    // A map that only ever grows is a leak whether its rows are small or not — the same reason
    // `sessionScratch` caps the cached conversations it holds.
    expect(stampsToDrop([['old', 10], ['new', 30], ['mid', 20]], 1)).toEqual(['old', 'mid'])
  })

  it('keeps far more stamps than there are cached conversations', () => {
    // A stamp is a number; the frame it describes is hundreds of KB. They do not deserve the same
    // budget, and a stamp for a conversation the cache has released is still the right answer.
    expect(MAX_STAMPS).toBeGreaterThan(10)
  })
})
