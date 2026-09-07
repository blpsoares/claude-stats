/**
 * streams.test.ts — the client half of the terminal channel, against a real SSE server.
 *
 * `Bun.serve` rather than a mocked `fetch`: what broke here was the interaction between a live,
 * SILENT stream and a second surface joining it, and a mock that replays on demand cannot express
 * "the server has sent nothing since".
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { TerminalStreams, type TerminalEvent } from './streams'

/**
 * A stream that sends `open` and one `frame`, then goes quiet — which is exactly what a session
 * WAITING ON A PERSON does. Its screen is a permission prompt and does not change, sometimes for
 * hours.
 */
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    if (!url.pathname.endsWith('/api/fleet/stream')) return new Response('no', { status: 404 })
    if (url.searchParams.get('id') === 'missing') return new Response('{}', { status: 404 })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        controller.enqueue(enc.encode('event: open\ndata: {"id":"s1","viewLines":200,"historyLimit":50000}\n\n'))
        controller.enqueue(enc.encode('event: frame\ndata: {"seq":1,"content":"hello","alive":true,"lines":1}\n\n'))
        // …and then nothing, deliberately. The connection stays open.
      },
    })
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
  },
})

afterAll(() => { server.stop(true) })

const base = () => `http://127.0.0.1:${server.port}`

function collect(): { events: TerminalEvent[]; listener: (e: TerminalEvent) => void } {
  const events: TerminalEvent[] = []
  return { events, listener: e => { events.push(e) } }
}

async function settle(ms = 120): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('TerminalStreams', () => {
  it('delivers the screen to the first watcher', async () => {
    const streams = new TerminalStreams(base)
    const first = collect()
    streams.watch('s1', first.listener)
    await settle()
    expect(first.events.map(e => e.event)).toEqual(['open', 'frame'])
    streams.dispose()
  })

  it('replays the screen to a watcher that JOINS a stream already open', async () => {
    // The bug this exists to prevent: the second surface saw nothing until the next CHANGE, and a
    // session waiting on a person never changes — so an editor tab opened on one of those sat on
    // "Connecting…" for ever, which is precisely how it was reported.
    const streams = new TerminalStreams(base)
    const first = collect()
    streams.watch('s1', first.listener)
    await settle()

    const second = collect()
    streams.watch('s1', second.listener)
    // Synchronously, without waiting for anything from the network.
    expect(second.events.map(e => e.event)).toEqual(['open', 'frame'])
    expect(second.events[1]!.data).toContain('hello')
    streams.dispose()
  })

  it('shares ONE connection between surfaces, and keeps it while any remain', async () => {
    const streams = new TerminalStreams(base)
    const a = collect()
    const b = collect()
    streams.watch('s1', a.listener)
    await settle()
    streams.watch('s1', b.listener)

    // Dropping one leaves the other watching — and still able to hand the screen to a newcomer,
    // which is only true if the connection was never closed.
    streams.unwatch('s1', a.listener)
    const c = collect()
    streams.watch('s1', c.listener)
    expect(c.events.map(e => e.event)).toEqual(['open', 'frame'])
    streams.dispose()
  })

  it('reports a refusal instead of retrying into silence', async () => {
    // 404 is an ANSWER — the session is not one this machine manages — and a client that retried it
    // would spin for ever saying nothing.
    const streams = new TerminalStreams(base)
    const one = collect()
    streams.watch('missing', one.listener)
    await settle()
    expect(one.events.map(e => e.event)).toEqual(['error'])
    streams.dispose()
  })

  it('forgets a session once the last watcher leaves', async () => {
    const streams = new TerminalStreams(base)
    const one = collect()
    streams.watch('s1', one.listener)
    await settle()
    streams.unwatch('s1', one.listener)
    one.events.length = 0
    // A fresh watch opens a fresh connection: the replay must not outlive the stream it came from,
    // or a reopened panel would show a screen from before it was closed.
    streams.watch('s1', one.listener)
    expect(one.events).toEqual([])
    await settle()
    expect(one.events.map(e => e.event)).toEqual(['open', 'frame'])
    streams.dispose()
  })
})
