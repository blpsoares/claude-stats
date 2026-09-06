import { describe, expect, it } from 'bun:test'
import type { SessionActivity } from './types'
import { EMPTY_CONFIRM_MEMORY, confirmActivities, type ConfirmMemory } from './attention-confirm'

/** Drive one poll: feed a raw reading per session, get the CONFIRMED reading back. */
function step(
  memory: ConfirmMemory,
  raw: Record<string, SessionActivity>,
): { out: Record<string, SessionActivity>; memory: ConfirmMemory } {
  const r = confirmActivities(memory, new Map(Object.entries(raw)))
  return { out: Object.fromEntries(r.activities), memory: r.memory }
}

describe('confirmActivities', () => {
  it('believes a first sighting as read — nothing prior to contradict it', () => {
    const { out } = step(EMPTY_CONFIRM_MEMORY, { a: 'waiting', b: 'working' })
    expect(out).toEqual({ a: 'waiting', b: 'working' })
  })

  it('does NOT flip to waiting on a single quiet poll — the reported false positive', () => {
    // A session confirmed working, then ONE poll reads quiet. That single reading is not yet a fact:
    // the fleet must not assert a person is needed on the strength of one frame.
    let m = EMPTY_CONFIRM_MEMORY
    ;({ memory: m } = step(m, { a: 'working' }))
    ;({ memory: m } = step(m, { a: 'working' }))
    const { out } = step(m, { a: 'waiting' })
    expect(out.a).toBe('working') // held, not the raw 'waiting'
  })

  it('believes waiting only once it is seen on two consecutive polls', () => {
    let m = EMPTY_CONFIRM_MEMORY
    ;({ memory: m } = step(m, { a: 'working' }))
    let r = step(m, { a: 'waiting' })
    expect(r.out.a).toBe('working') // first waiting reading — held
    r = step(r.memory, { a: 'waiting' })
    expect(r.out.a).toBe('waiting') // confirmed on the second
  })

  it('clears waiting the moment work resumes — the asymmetry, believed at once', () => {
    // Confirm a waiting state, then the session moves. A screen that moved is unambiguous proof of
    // work, and clearing attention fast is the cheap direction — so it is adopted on the NEXT sample.
    let m = EMPTY_CONFIRM_MEMORY
    ;({ memory: m } = step(m, { a: 'waiting' }))
    ;({ memory: m } = step(m, { a: 'waiting' })) // confirmed waiting
    const { out } = step(m, { a: 'working' })
    expect(out.a).toBe('working')
  })

  it('the count drops on the sample after work resumes', () => {
    const count = (o: Record<string, SessionActivity>) =>
      Object.values(o).filter(a => a === 'waiting' || a === 'waiting-approval').length
    let m = EMPTY_CONFIRM_MEMORY
    let r = step(m, { a: 'waiting', b: 'waiting' })
    r = step(r.memory, { a: 'waiting', b: 'waiting' }) // both confirmed waiting
    expect(count(r.out)).toBe(2)
    r = step(r.memory, { a: 'working', b: 'waiting' }) // a resumes
    expect(count(r.out)).toBe(1) // fell on the very next sample
  })

  it('does not flicker on waiting -> (repaint) -> waiting', () => {
    // The event-plan flicker, on the fleet: a cosmetic repaint moves the frame for one poll.
    let m = EMPTY_CONFIRM_MEMORY
    ;({ memory: m } = step(m, { a: 'waiting' }))
    let r = step(m, { a: 'waiting' }) // confirmed waiting
    expect(r.out.a).toBe('waiting')
    r = step(r.memory, { a: 'working' }) // the repaint — one frame
    expect(r.out.a).toBe('working') // movement is believed at once (cheap direction)
    r = step(r.memory, { a: 'waiting' }) // back to quiet
    // Held at working for this poll (single new waiting reading), then confirmed next — never a
    // duplicate needs-you spike from a one-frame twitch.
    expect(r.out.a).toBe('working')
    r = step(r.memory, { a: 'waiting' })
    expect(r.out.a).toBe('waiting')
  })

  it('adopts exited immediately — a dead session is not held as working', () => {
    let m = EMPTY_CONFIRM_MEMORY
    ;({ memory: m } = step(m, { a: 'working' }))
    ;({ memory: m } = step(m, { a: 'working' }))
    const { out } = step(m, { a: 'exited' })
    expect(out.a).toBe('exited')
  })

  it('escalates waiting -> waiting-approval only once confirmed', () => {
    let m = EMPTY_CONFIRM_MEMORY
    ;({ memory: m } = step(m, { a: 'waiting' }))
    ;({ memory: m } = step(m, { a: 'waiting' })) // confirmed waiting
    let r = step(m, { a: 'waiting-approval' })
    expect(r.out.a).toBe('waiting') // one reading — held at the last confirmed needs-you state
    r = step(r.memory, { a: 'waiting-approval' })
    expect(r.out.a).toBe('waiting-approval')
  })

  it('forgets sessions that leave the fleet — memory cannot grow unbounded', () => {
    let m = EMPTY_CONFIRM_MEMORY
    ;({ memory: m } = step(m, { a: 'working', b: 'working' }))
    const r = step(m, { a: 'working' }) // b is gone
    expect(r.memory.confirmed.has('b')).toBe(false)
    expect(r.memory.lastRaw.has('b')).toBe(false)
  })
})

describe('corroboration', () => {
  it('an UNCORROBORATED working reading waits for a second poll', () => {
    // Movement alone on a harness that prints a working marker: most likely a repaint.
    const a = confirmActivities(EMPTY_CONFIRM_MEMORY, new Map([['s', 'waiting']]), new Set(['s']))
    const b = confirmActivities(a.memory, new Map([['s', 'working']]), new Set())
    expect(b.activities.get('s')).toBe('waiting')
    const c = confirmActivities(b.memory, new Map([['s', 'working']]), new Set())
    expect(c.activities.get('s')).toBe('working')
  })

  it('a CORROBORATED working reading is believed at once', () => {
    const a = confirmActivities(EMPTY_CONFIRM_MEMORY, new Map([['s', 'waiting']]), new Set(['s']))
    const b = confirmActivities(a.memory, new Map([['s', 'working']]), new Set(['s']))
    expect(b.activities.get('s')).toBe('working')
  })

  it('omitting the set keeps every existing caller exactly as it was', () => {
    // The parameter is optional so that callers and their tests are untouched by its addition.
    const a = confirmActivities(EMPTY_CONFIRM_MEMORY, new Map([['s', 'waiting']]))
    const b = confirmActivities(a.memory, new Map([['s', 'working']]))
    expect(b.activities.get('s')).toBe('working')
  })
})
