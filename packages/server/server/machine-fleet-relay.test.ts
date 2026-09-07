import { describe, it, expect, beforeEach } from 'bun:test'
import {
  requestMachineFleet, requestMachineAction, acceptMachineFleetReply, abandonMachineFleet,
  resetMachineFleetRelay,
} from './machine-fleet-relay'

beforeEach(() => { resetMachineFleetRelay() })

const row = { id: 's1', title: 't', harness: 'claude', state: 'working', stateLabel: 'working', project: 'p', cwd: '/p' }
const okReply = { rows: [row], attention: 1, withheld: 0 }

describe('requestMachineFleet', () => {
  it('sends a correlated question and resolves with the matching answer', async () => {
    let sent: Record<string, unknown> | null = null
    const p = requestMachineFleet('m1', payload => { sent = payload })
    expect(sent!.type).toBe('fleet-request')
    expect(typeof sent!.rid).toBe('string')
    acceptMachineFleetReply('m1', sent!.rid, okReply)
    expect(await p).toEqual({ rows: [row], attention: 1, withheld: 0 })
  })

  it('a timeout resolves to null — a silent machine is a SENTENCE, never a hung request', async () => {
    const p = requestMachineFleet('m1', () => {}, 20)
    expect(await p).toBeNull()
  })

  it('a second asker joins the open question instead of asking the machine twice', async () => {
    // Two dashboards polling one machine is the normal case; a second request would ask it to
    // build the same fleet again.
    let sends = 0
    let rid = ''
    const a = requestMachineFleet('m1', p => { sends++; rid = p.rid as string })
    const b = requestMachineFleet('m1', () => { sends++ })
    expect(sends).toBe(1)
    acceptMachineFleetReply('m1', rid, okReply)
    expect(await a).toEqual(await b)
  })

  it('a send that throws resolves as silence at once, not after the timeout', async () => {
    // The socket died between the presence check and the send. Same answer, sooner.
    const p = requestMachineFleet('m1', () => { throw new Error('socket closed') }, 60_000)
    expect(await p).toBeNull()
  })
})

describe('acceptMachineFleetReply', () => {
  it('drops a reply nobody asked for', async () => {
    // An unsolicited reply is not a fact about anything, and accepting it would let a member push
    // a fleet into whatever read next.
    expect(acceptMachineFleetReply('m1', 'whatever', okReply)).toBe(false)
  })

  it('drops a reply carrying the wrong rid', async () => {
    let rid = ''
    const p = requestMachineFleet('m1', x => { rid = x.rid as string }, 40)
    expect(acceptMachineFleetReply('m1', rid + 'x', okReply)).toBe(false)
    expect(acceptMachineFleetReply('m1', 42, okReply)).toBe(false)
    expect(await p).toBeNull()   // still unanswered → the timeout is what settles it
  })

  it('never lets one machine answer for another', async () => {
    // The machine id comes from the authenticated socket; this is the assertion that makes that
    // matter.
    let rid = ''
    const p = requestMachineFleet('m1', x => { rid = x.rid as string }, 40)
    expect(acceptMachineFleetReply('m2', rid, okReply)).toBe(false)
    expect(await p).toBeNull()
  })

  it('a second reply to an already-answered question is dropped', async () => {
    let rid = ''
    const p = requestMachineFleet('m1', x => { rid = x.rid as string })
    expect(acceptMachineFleetReply('m1', rid, okReply)).toBe(true)
    expect(acceptMachineFleetReply('m1', rid, { rows: [], attention: 9, withheld: 9 })).toBe(false)
    expect((await p)!.attention).toBe(1)
  })

  it('a malformed reply degrades to an empty fleet rather than crashing the route', async () => {
    let rid = ''
    const p = requestMachineFleet('m1', x => { rid = x.rid as string })
    acceptMachineFleetReply('m1', rid, { rows: 'not an array', attention: -5, withheld: null, unavailable: 7 })
    const r = (await p)!
    expect(r.rows).toEqual([])
    expect(r.attention).toBe(0)
    expect(r.withheld).toBe(0)
    expect(r.unavailable).toBeUndefined()
  })

  it('a reply that is not an object at all resolves to null', async () => {
    let rid = ''
    const p = requestMachineFleet('m1', x => { rid = x.rid as string })
    acceptMachineFleetReply('m1', rid, 'nope')
    expect(await p).toBeNull()
  })
})

describe('abandonMachineFleet', () => {
  it('resolves an open question at once when the socket drops', async () => {
    // Nobody is going to answer; making the asker wait out the timeout for an impossible answer is
    // the whole reason this exists.
    const p = requestMachineFleet('m1', () => {}, 60_000)
    abandonMachineFleet('m1')
    expect(await p).toBeNull()
  })

  it('is harmless for a machine with nothing open', () => {
    expect(() => abandonMachineFleet('nobody')).not.toThrow()
  })

  it('a new question after an abandon works normally', async () => {
    const first = requestMachineFleet('m1', () => {}, 60_000)
    abandonMachineFleet('m1')
    await first
    let rid = ''
    const second = requestMachineFleet('m1', x => { rid = x.rid as string })
    acceptMachineFleetReply('m1', rid, okReply)
    expect((await second)!.attention).toBe(1)
  })
})

describe('requestMachineAction', () => {
  const act = { action: 'rename', id: 's1', text: 'new name' }

  it('sends the verb and resolves with the MACHINE\'s own sentence', async () => {
    let sent: Record<string, unknown> | null = null
    const p = requestMachineAction('m1', act, x => { sent = x })
    expect(sent!.op).toBe('act')
    expect(sent!.action).toBe('rename')
    expect(sent!.id).toBe('s1')
    acceptMachineFleetReply('m1', sent!.rid, { ok: true, message: 'renamed' })
    expect(await p).toEqual({ ok: true, message: 'renamed' })
  })

  it('NEVER joins an open action — two acts are two acts, even with the same verb', async () => {
    // Collapsing them would report one person's result to somebody who asked for something else.
    let sends = 0
    let rid = ''
    const a = requestMachineAction('m1', act, x => { sends++; rid = x.rid as string })
    const b = requestMachineAction('m1', act, () => { sends++ })
    expect(sends).toBe(1)
    // The second is REFUSED outright rather than queued: a keystroke arriving a minute late is
    // worse than one that plainly did not happen.
    expect(await b).toBeNull()
    acceptMachineFleetReply('m1', rid, { ok: true, message: 'renamed' })
    expect((await a)!.ok).toBe(true)
  })

  it('a read and an action do not compete for one slot', async () => {
    // Keying "one in flight" by machine alone would have a dashboard's background read block the
    // button the user just pressed.
    let readRid = '', actRid = ''
    const r = requestMachineFleet('m1', x => { readRid = x.rid as string })
    const a = requestMachineAction('m1', act, x => { actRid = x.rid as string })
    expect(readRid).not.toBe('')
    expect(actRid).not.toBe('')
    expect(readRid).not.toBe(actRid)
    acceptMachineFleetReply('m1', actRid, { ok: true, message: 'done' })
    acceptMachineFleetReply('m1', readRid, okReply)
    expect((await a)!.message).toBe('done')
    expect((await r)!.attention).toBe(1)
  })

  it('an answer with no sentence is a FAILURE, never a silent success', async () => {
    // Every refusal in this product is worded by the thing that made it; an answer this central
    // cannot render must not be shown as "it worked".
    for (const junk of [{ ok: true }, { ok: true, message: '' }, { message: 5 }, 'nope', null]) {
      let rid = ''
      const p = requestMachineAction('m1', act, x => { rid = x.rid as string })
      acceptMachineFleetReply('m1', rid, junk)
      expect(await p).toBeNull()
    }
  })

  it('ok is trusted only as a literal boolean', async () => {
    let rid = ''
    const p = requestMachineAction('m1', act, x => { rid = x.rid as string })
    acceptMachineFleetReply('m1', rid, { ok: 'yes', message: 'hm' })
    expect(await p).toEqual({ ok: false, message: 'hm' })
  })

  it('a dropped socket settles an open ACTION too', async () => {
    const p = requestMachineAction('m1', act, () => {}, 60_000)
    abandonMachineFleet('m1')
    expect(await p).toBeNull()
  })
})
