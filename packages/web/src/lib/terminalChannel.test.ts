import { describe, expect, it } from 'bun:test'
import {
  INITIAL_CHANNEL,
  canSend,
  channelReducer,
  pendingCount,
  type ChannelState,
} from './terminalChannel'

const open: ChannelState = { ...INITIAL_CHANNEL, armed: true, phase: 'open' }

/** Drive a sequence of actions from a start state. */
function run(start: ChannelState, ...actions: Parameters<typeof channelReducer>[1][]): ChannelState {
  return actions.reduce((s, a) => channelReducer(s, a), start)
}

describe('consent (mirrors #269) — raw typing is an explicit, revocable opt-in', () => {
  it('starts disarmed, idle, with nothing pending', () => {
    expect(INITIAL_CHANNEL).toEqual({ armed: false, phase: 'idle', pending: [], error: null, undelivered: false })
    expect(canSend(INITIAL_CHANNEL)).toBe(false)
  })

  it('cannot send while disarmed even if a channel were open', () => {
    const s = channelReducer({ ...INITIAL_CHANNEL, phase: 'open' }, { type: 'send', id: 1 })
    expect(pendingCount(s)).toBe(0)
    expect(canSend(s)).toBe(false)
  })

  it('disarm revokes consent and drops everything (a session you stopped driving keeps nothing)', () => {
    const busy = run(open, { type: 'send', id: 1 }, { type: 'send', id: 2 })
    expect(pendingCount(busy)).toBe(2)
    expect(channelReducer(busy, { type: 'disarm' })).toEqual(INITIAL_CHANNEL)
  })
})

describe('channel lifecycle', () => {
  it('can only send while armed AND open', () => {
    expect(canSend({ ...INITIAL_CHANNEL, armed: true, phase: 'connecting' })).toBe(false)
    expect(canSend({ ...INITIAL_CHANNEL, armed: true, phase: 'closed' })).toBe(false)
    expect(canSend(open)).toBe(true)
  })
})

describe('honest delivery (A6) — a key is never accounted delivered until its ack lands', () => {
  it('send records the transport-assigned id, in order', () => {
    const s = run(open, { type: 'send', id: 1 }, { type: 'send', id: 2 })
    expect(s.pending).toEqual([1, 2])
  })

  it('an OK ack for the expected id pops that key (verifiable pairing, not inferred FIFO)', () => {
    const s = run(open, { type: 'send', id: 1 }, { type: 'send', id: 2 }, { type: 'ack', id: 1, ok: true })
    expect(s.pending).toEqual([2])
    expect(s.undelivered).toBe(false)
    expect(s.error).toBeNull()
  })

  it('a FAILED ack pops the key and surfaces the verbatim reason, marking undelivered', () => {
    const s = run(open, { type: 'send', id: 1 }, { type: 'ack', id: 1, ok: false, reason: 'session gone' })
    expect(s.pending).toEqual([])
    expect(s.undelivered).toBe(true)
    expect(s.error).toBe('session gone')
  })

  it('an ack whose id is NOT the expected head is a verifiable fault, never silently accepted', () => {
    // With an ordered channel + sequential server this cannot happen; if it does (reconnect, a lost
    // message), the mismatch is DETECTED and surfaced — the whole point of an id over inferred FIFO.
    const s = run(open, { type: 'send', id: 1 }, { type: 'send', id: 2 }, { type: 'ack', id: 2, ok: true })
    expect(s.undelivered).toBe(true)
    expect(s.error).toBe('delivery confirmation out of order')
    // The expected key is NOT popped on a mismatch — the accounting stays honest.
    expect(s.pending).toEqual([1, 2])
  })

  it('a stale/duplicate ack with no pending keys is ignored', () => {
    const s = run(open, { type: 'send', id: 1 }, { type: 'ack', id: 1, ok: true }, { type: 'ack', id: 1, ok: true })
    expect(s.pending).toEqual([])
    expect(s.undelivered).toBe(false)
  })

  it('the channel dropping WITH keys in flight is an honest failure, not silence (A6)', () => {
    const s = run(open, { type: 'send', id: 1 }, { type: 'send', id: 2 }, { type: 'closed', reason: 'network lost' })
    expect(s.phase).toBe('closed')
    expect(s.undelivered).toBe(true)
    expect(s.error).toBe('network lost')
    // The in-flight keys are known-not-delivered; they are not left looking pending forever.
    expect(s.pending).toEqual([])
  })

  it('the channel dropping with NOTHING in flight is a clean close, no false alarm', () => {
    const s = run(open, { type: 'send', id: 1 }, { type: 'ack', id: 1, ok: true }, { type: 'closed' })
    expect(s.phase).toBe('closed')
    expect(s.undelivered).toBe(false)
    expect(s.error).toBeNull()
  })

  it('reopening the channel clears a prior failure so a fresh attempt starts honest', () => {
    const dropped = run(open, { type: 'send', id: 1 }, { type: 'closed', reason: 'network lost' })
    const back = run(dropped, { type: 'connecting' }, { type: 'open' })
    expect(back.phase).toBe('open')
    expect(back.undelivered).toBe(false)
    expect(back.error).toBeNull()
    expect(canSend(back)).toBe(true)
  })

  it('a late ack arriving after the channel closed cannot resurrect send-ability', () => {
    const s = run(open, { type: 'send', id: 1 }, { type: 'closed', reason: 'x' }, { type: 'ack', id: 1, ok: true })
    expect(canSend(s)).toBe(false)
    expect(s.phase).toBe('closed')
  })
})
