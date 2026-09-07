import { describe, expect, test } from 'bun:test'
import { createInputChannel, type InputChannelDeps } from './input-channel'
import type { InputAck } from './input-protocol'

/** A recording harness: what the channel sent, in what order, and every ack it emitted. */
function harness(over: Partial<InputChannelDeps> = {}) {
  const sent: string[] = []
  const keys: string[] = []
  const acks: InputAck[] = []
  const deps: InputChannelDeps = {
    async sendText(text) { sent.push(text); return true },
    async sendKey(key) { keys.push(key); return true },
    emit(ack) { acks.push(ack) },
    ...over,
  }
  return { deps, sent, keys, acks }
}

const textMsg = (seq: number, data: string) => JSON.stringify({ seq, kind: 'text', data })
const keyMsg = (seq: number, name: string) => JSON.stringify({ seq, kind: 'key', name })

/** Let the internal promise chain settle. */
const settle = () => new Promise<void>(r => setTimeout(r, 0))

describe('createInputChannel — ordering', () => {
  test('a burst of 40 one-char text messages is sent in exact order despite random send delays', async () => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789!@#$'.split('') // 40 distinct chars
    expect(chars.length).toBe(40)
    const sent: string[] = []
    const acks: InputAck[] = []
    const deps: InputChannelDeps = {
      // A random delay per send is the whole point: if the channel did not await the previous send,
      // a slow one would land after a fast follower and the order would scramble.
      async sendText(text) {
        await new Promise(r => setTimeout(r, Math.random() * 5))
        sent.push(text)
        return true
      },
      async sendKey() { return true },
      emit(a) { acks.push(a) },
    }
    const ch = createInputChannel(deps)
    chars.forEach((c, i) => ch.submit(textMsg(i, c)))

    // Wait for all 40 acks.
    for (let i = 0; i < 200 && acks.length < 40; i++) await settle()

    expect(sent).toEqual(chars)
    expect(acks.map(a => a.seq)).toEqual(chars.map((_, i) => i))
    expect(acks.every(a => a.ok)).toBe(true)
  })
})

describe('createInputChannel — confirmations', () => {
  test('every submit gets exactly one ack, mapped by seq', async () => {
    const { deps, acks } = harness()
    const ch = createInputChannel(deps)
    ch.submit(textMsg(10, 'a'))
    ch.submit(keyMsg(11, 'C-c'))
    ch.submit(textMsg(12, 'b'))
    for (let i = 0; i < 50 && acks.length < 3; i++) await settle()
    expect(acks).toEqual([
      { seq: 10, ok: true },
      { seq: 11, ok: true },
      { seq: 12, ok: true },
    ])
  })

  test('a text message routes to sendText, a key message routes to sendKey', async () => {
    const { deps, sent, keys } = harness()
    const ch = createInputChannel(deps)
    ch.submit(textMsg(1, 'x'))
    ch.submit(keyMsg(2, 'C-c'))
    for (let i = 0; i < 50; i++) await settle()
    expect(sent).toEqual(['x'])
    expect(keys).toEqual(['C-c'])
  })
})

describe('createInputChannel — honest failure', () => {
  test('a backend send that returns false acks as failure, never silent success', async () => {
    const { deps, acks } = harness({ async sendText() { return false } })
    const ch = createInputChannel(deps)
    ch.submit(textMsg(1, 'a'))
    for (let i = 0; i < 50 && acks.length < 1; i++) await settle()
    expect(acks).toEqual([{ seq: 1, ok: false, reason: 'send_failed' }])
  })

  test('a backend send that THROWS acks as failure and the chain keeps going', async () => {
    let calls = 0
    const acks: InputAck[] = []
    const deps: InputChannelDeps = {
      async sendText() { calls++; if (calls === 1) throw new Error('backend down'); return true },
      async sendKey() { return true },
      emit(a) { acks.push(a) },
    }
    const ch = createInputChannel(deps)
    ch.submit(textMsg(1, 'a')) // throws
    ch.submit(textMsg(2, 'b')) // must still be processed
    for (let i = 0; i < 50 && acks.length < 2; i++) await settle()
    expect(acks).toEqual([
      { seq: 1, ok: false, reason: 'send_failed' },
      { seq: 2, ok: true },
    ])
  })

  test('a malformed message is acked with its parse reason and no send happens', async () => {
    const { deps, sent, keys, acks } = harness()
    const ch = createInputChannel(deps)
    ch.submit('{not json')
    ch.submit(JSON.stringify({ seq: 4, kind: 'key', name: 'C-x' })) // outside the allowlist
    for (let i = 0; i < 50 && acks.length < 2; i++) await settle()
    expect(acks).toEqual([
      { seq: null, ok: false, reason: 'bad_json' },
      { seq: 4, ok: false, reason: 'bad_key' },
    ])
    expect(sent).toEqual([])
    expect(keys).toEqual([])
  })
})
