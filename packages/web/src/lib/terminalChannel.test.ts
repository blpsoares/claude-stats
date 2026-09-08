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

/**
 * A chunk THIS CLIENT refused never reached the wire, so it has no seq and no ack coming.
 *
 * Reporting it as a `send` + `ack` pair under a synthetic id was the first attempt and it poisons
 * the FIFO: `send` appends to the TAIL while `ack` only ever answers `pending[0]`, so with any real
 * key in flight — the common case, an ack being a round trip and typing not — the synthetic ack
 * mismatches, `pending` is deliberately left intact, and that id sticks at the head forever. Every
 * later server ack then mismatches too, `pending` grows without bound, and the status line latches
 * on "out of order" while every keystroke is in fact landing.
 */
describe('a client-side refusal never enters the in-flight accounting', () => {
  it('says what happened without touching pending, mid-flight', () => {
    const s = run(open,
      { type: 'send', id: 1 },                    // a real key, still unacked
      { type: 'refused', reason: 'mixed_chunk' }, // the user pastes something refused here
    )
    expect(pendingCount(s)).toBe(1)
    expect(s.pending).toEqual([1])
    expect(s.undelivered).toBe(true)
    expect(s.error).toBe('mixed_chunk')
  })

  it('leaves the FIFO able to drain — the defect was that it could not', () => {
    const s = run(open,
      { type: 'send', id: 1 },
      { type: 'refused', reason: 'too_long' },
      { type: 'ack', id: 1, ok: true },           // the real key's ack still matches pending[0]
      { type: 'send', id: 2 },
      { type: 'ack', id: 2, ok: true },
    )
    expect(s.pending).toEqual([])
    expect(pendingCount(s)).toBe(0)
  })

  it('is ignored when the channel cannot send at all', () => {
    const s = channelReducer(INITIAL_CHANNEL, { type: 'refused', reason: 'mixed_chunk' })
    expect(s).toEqual(INITIAL_CHANNEL)
  })
})
