import { describe, expect, it } from 'bun:test'
import { machineSilenceSentence, parseRelayActResult } from './relayAct'

describe('parseRelayActResult', () => {
  it("passes the MACHINE's own sentence through untouched", () => {
    // Every refusal in this product is worded by the thing that made it. A central composing its
    // own would describe refusals it does not make.
    const out = parseRelayActResult({ reply: { ok: false, message: 'a sessão não está rodando' } }, 'pt')
    expect(out).toEqual({ ok: false, message: 'a sessão não está rodando' })
  })

  it('reports success only when the machine said so', () => {
    expect(parseRelayActResult({ reply: { ok: true, message: 'renomeada' } }, 'pt').ok).toBe(true)
  })

  it('a SILENCE is never a success — that is the whole reason this is not `parseActResult`', () => {
    // On a `kill`, reading a silence as ok would tell someone their session is gone while it runs.
    for (const reason of ['offline', 'refused', 'silent', 'not-owner']) {
      const out = parseRelayActResult({ reason }, 'pt')
      expect(out.ok).toBe(false)
      expect(out.message.length).toBeGreaterThan(0)
    }
  })

  it('the four silences get four DIFFERENT sentences', () => {
    // Each sends the reader somewhere else: the switch on that machine, whether it is running, its
    // agentop version, or nowhere at all.
    const said = ['offline', 'refused', 'silent', 'not-owner'].map(r => machineSilenceSentence(r, 'pt'))
    expect(new Set(said).size).toBe(4)
  })

  it('an unknown reason still gets a sentence rather than nothing', () => {
    // A silence nobody anticipated is still a silence; saying nothing leaves a control that appears
    // to do nothing, which is the failure this family of sentences exists to prevent.
    const out = parseRelayActResult({ reason: 'something-new' }, 'en')
    expect(out.ok).toBe(false)
    expect(out.message.length).toBeGreaterThan(0)
  })

  it('a malformed body is a refusal, never a silent success', () => {
    for (const body of [null, undefined, 'nope', 42, {}, { reply: null }, { reply: 'x' }]) {
      const out = parseRelayActResult(body, 'en')
      expect(out.ok).toBe(false)
      expect(out.message.length).toBeGreaterThan(0)
    }
  })

  it('a reply with ok but no message still says something', () => {
    const out = parseRelayActResult({ reply: { ok: true } }, 'en')
    expect(out.ok).toBe(true)
    expect(out.message.length).toBeGreaterThan(0)
  })

  it('both languages answer, and differ', () => {
    expect(machineSilenceSentence('offline', 'pt')).not.toBe(machineSilenceSentence('offline', 'en'))
  })
})
