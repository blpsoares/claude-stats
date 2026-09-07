import { describe, expect, it } from 'bun:test'
import type { HarnessProcess } from '../live-sessions'
import type { BackendSession, ManagedSession, SessionBackend } from './types'
import { createSessionsPoller } from './sessions-host'

const NOW = 1_786_600_000_000

const managed = (id: string, over: Partial<ManagedSession> = {}): ManagedSession => ({
  id, harness: 'claude', cwd: '/repo/a', createdAt: '2026-08-13T10:00:00.000Z', ...over,
})

const backendSession = (id: string, over: Partial<BackendSession> = {}): BackendSession => ({
  id,
  createdMs: NOW - 600_000,
  attached: false,
  alive: true,
  // Quiet enough that movement cannot fire, recent enough that a probed marker is still trusted.
  lastActivityMs: NOW - 30_000,
  ...over,
})

function fakeBackend(o: {
  sessions: BackendSession[]
  frames?: Record<string, string[]>
  unavailable?: string
  onCapture?: (id: string) => void
}): SessionBackend {
  return {
    id: 'tmux',
    async unavailable() { return o.unavailable },
    async spawn() {},
    async list() { return o.sessions },
    async capture(id) { o.onCapture?.(id); return o.frames?.[id] ?? [] },
    async captureTerminal(id) {
      const lines = o.frames?.[id] ?? []
      return { lines, info: { cols: 80, rows: lines.length, cursorX: 0, cursorY: 0, alive: true, historySize: 0 } }
    },
    async kill() { return true },
    attachCommand(id) { return ['tmux', 'attach', id] },
    async detachHint() { return 'Ctrl-b then d' },
    async sendText() { return true },
    async sendTextRaw() { return true },
    async sendKey() { return true },
  }
}

const poller = (o: {
  backend: SessionBackend
  registry?: ManagedSession[]
  processes?: HarnessProcess[]
  now?: () => number
  touchSessions?: (ids: readonly string[], atMs: number) => Promise<unknown>
  heartbeatMs?: number
}) => createSessionsPoller({
  backend: o.backend,
  readRegistry: async () => o.registry ?? [],
  scanProcesses: async () => ({ procs: o.processes ?? [] }),
  now: o.now ?? (() => NOW),
  ...(o.touchSessions ? { touchSessions: o.touchSessions } : {}),
  ...(o.heartbeatMs !== undefined ? { heartbeatMs: o.heartbeatMs } : {}),
})

describe('createSessionsPoller', () => {
  it('reports a quiet session as waiting and counts it', async () => {
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames: { a: ['❯ '] } }),
      registry: [managed('a')],
    })
    const snap = await p.poll()
    expect(snap.sessions[0]!.activity).toBe('waiting')
    expect(snap.attention).toBe(1)
  })

  it('does NOT count a working session that goes quiet for a single poll — the reported false positive', async () => {
    // The field report: the fleet said "waiting on you" about a session that had already gone back to
    // work. It reproduces at the poller: a session working (its probed footer moving), then ONE poll
    // where the frame is momentarily quiet — a repaint settling, a sub-turn finishing — reads `waiting`
    // raw. Before this fix the counter jumped to 1 on that single frame and a person was summoned.
    const frames: Record<string, string[]> = { a: ['· Working… (12s · ↓ 1.7k tokens)'] }
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames }),
      registry: [managed('a')],
    })
    // Establish the confirmed working state.
    expect((await p.poll()).attention).toBe(0)
    // The marker goes away and the frame stops moving for exactly one poll.
    frames.a = ['❯ ']
    const blip = await p.poll()
    expect(blip.sessions[0]!.activity).toBe('working') // held — not summoned on one frame
    expect(blip.attention).toBe(0)
    expect(blip.rang).toEqual([])
  })

  it('the waiting count DROPS on the sample after work resumes', async () => {
    // The transition the acceptance names: waiting -> back to working -> the count falls on the next
    // sample. Clearing attention is the cheap direction, so it is believed at once.
    const frames: Record<string, string[]> = { a: ['❯ '] }
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames }),
      registry: [managed('a')],
    })
    // Two quiet polls confirm waiting.
    await p.poll()
    expect((await p.poll()).attention).toBe(1)
    // The session resumes — a moving footer.
    frames.a = ['back at it · esc to interrupt']
    expect((await p.poll()).attention).toBe(0) // fell on the very next sample
  })

  it('reports a session working from its probed MAIN-agent marker', async () => {
    const p = poller({
      backend: fakeBackend({
        sessions: [backendSession('a')],
        frames: { a: ['  ⏸ manual mode on · Jitterbugging… (37s · ↓ 1.7k tokens) · ← 6 agents'] },
      }),
      registry: [managed('a')],
    })
    expect((await p.poll()).sessions[0]!.activity).toBe('working')
    expect((await p.poll()).attention).toBe(0)
  })

  it('a session whose ONLY marker is the interruptible one needs a person, and says a subagent runs', async () => {
    // claude prints `esc to interrupt` whenever ANYTHING is interruptible — a background subagent
    // included — so a session that has finished its own turn and is waiting for the person to type
    // still carried it. Reported exactly that way: the fleet said `working` about sessions that were
    // waiting. The main agent's own spinner is what says it is producing; the bare interruptible
    // marker says only that something else is.
    const p = poller({
      backend: fakeBackend({
        sessions: [backendSession('a')],
        frames: { a: ['  ⏸ manual mode on · esc to interrupt · ← 6 agents'] },
      }),
      registry: [managed('a')],
    })
    await p.poll()
    const snap = await p.poll()
    expect(snap.sessions[0]!.activity).toBe('waiting')
    expect(snap.sessions[0]!.background).toBe(true)
    expect(snap.attention).toBe(1)
  })

  it('a SINGLE frame change never reaches the row — that is what a repaint looks like', async () => {
    // On claude, which prints `esc to interrupt` whenever it is working, movement WITHOUT that
    // marker is most likely a repaint: a tmux advisory line, a plugin notice, a status clock. Each
    // one used to flip the row to `working` for a poll and back, so the row alternated between
    // `working` and `needs you` continuously with a notification each time — reported exactly that
    // way. `confirmActivities`' `corroborated` set is where this lives.
    const frames: Record<string, string[]> = { a: ['one'] }
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames }),
      registry: [managed('a')],
    })
    expect((await p.poll()).sessions[0]!.activity).toBe('waiting')
    frames.a = ['two']
    expect((await p.poll()).sessions[0]!.activity).toBe('waiting')
    // The frame has stopped changing — the repaint is over and the row never moved.
    expect((await p.poll()).sessions[0]!.activity).toBe('waiting')
  })

  it('a SUSTAINED change is real work, and reaches the row', async () => {
    // Two polls in a row that both moved. That is not a repaint, and it is what an assistant
    // drawing output actually looks like on a harness whose marker is off screen.
    const frames: Record<string, string[]> = { a: ['one'] }
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames }),
      registry: [managed('a')],
    })
    expect((await p.poll()).sessions[0]!.activity).toBe('waiting')
    frames.a = ['two']
    expect((await p.poll()).sessions[0]!.activity).toBe('waiting')
    frames.a = ['three']
    expect((await p.poll()).sessions[0]!.activity).toBe('working')
    // …and going quiet still takes two polls to be believed, unchanged.
    expect((await p.poll()).sessions[0]!.activity).toBe('working')
    expect((await p.poll()).sessions[0]!.activity).toBe('waiting')
  })

  it('a harness with NO working marker still believes movement at once', async () => {
    // Codex draws an identical screen streaming and idle, so movement is the only signal it has.
    // Requiring corroboration there would mean it never reads as working at all.
    const frames: Record<string, string[]> = { a: ['one'] }
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames }),
      registry: [managed('a', { harness: 'codex' })],
    })
    expect((await p.poll()).sessions[0]!.activity).toBe('waiting')
    frames.a = ['two']
    expect((await p.poll()).sessions[0]!.activity).toBe('working')
  })

  it('the harness saying so is believed at once', async () => {
    // `esc to interrupt` is claude's own statement that it is working — evidence, not a repaint.
    const frames: Record<string, string[]> = { a: ['idle'] }
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames }),
      registry: [managed('a')],
    })
    expect((await p.poll()).sessions[0]!.activity).toBe('waiting')
    frames.a = ['esc to interrupt']
    expect((await p.poll()).sessions[0]!.activity).toBe('working')
  })

  it('never captures a dead pane', async () => {
    const captured: string[] = []
    const p = poller({
      backend: fakeBackend({
        sessions: [backendSession('a', { alive: false })],
        onCapture: id => captured.push(id),
      }),
      registry: [managed('a')],
    })
    expect((await p.poll()).sessions[0]!.activity).toBe('exited')
    expect(captured).toEqual([])
  })

  it('rings once on the transition into waiting, not on every poll', async () => {
    const frames: Record<string, string[]> = { a: ['· Working… (3s · ↓ 12 tokens)'] }
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames }),
      registry: [managed('a')],
    })
    expect((await p.poll()).rang).toEqual([])

    // The turn ends. The poll that OBSERVES the ending sees a frame that changed since the last
    // one, which is movement — so the session still reads `working` for this one interval. That is
    // not a defect to design around: the alternative is to stop trusting movement, which is the
    // only working signal codex has at all. The bell is therefore at most one interval late, and
    // never early, which is the right way round for a signal a person acts on.
    frames.a = ['done']
    expect((await p.poll()).sessions[0]!.activity).toBe('working')

    // Next poll: the frame is unchanged, so the RAW reading is `waiting` — but it has been seen only
    // once, so the fleet still shows `working` and the bell does NOT ring. The bell fires on the
    // CONFIRMED transition, never on a single frame: that is what stops a one-frame quiet ringing a
    // person for a session that is still working.
    const held = await p.poll()
    expect(held.sessions[0]!.activity).toBe('working')
    expect(held.rang).toEqual([])

    // The poll after that confirms the quiet — waiting is now believed, and the bell rings once.
    const settled = await p.poll()
    expect(settled.sessions[0]!.activity).toBe('waiting')
    expect(settled.rang).toEqual(['a'])

    // And it does not ring again while it stays there.
    expect((await p.poll()).rang).toEqual([])
  })

  it('reports the backend own reason instead of an empty list', async () => {
    const p = poller({ backend: fakeBackend({ sessions: [], unavailable: 'tmux is not installed' }) })
    const snap = await p.poll()
    expect(snap.unavailable).toBe('tmux is not installed')
    expect(snap.sessions).toEqual([])
  })

  it('keeps the previous snapshot when a poll throws, rather than reporting zero', async () => {
    let fail = false
    const backend = fakeBackend({ sessions: [backendSession('a')], frames: { a: ['x'] } })
    const broken: SessionBackend = {
      ...backend,
      async list() {
        if (fail) throw new Error('boom')
        return [backendSession('a')]
      },
    }
    const p = poller({ backend: broken, registry: [managed('a')] })
    await p.poll()
    fail = true
    const snap = await p.poll()
    expect(snap.sessions).toHaveLength(1)
    expect(snap.unavailable).toContain('boom')
  })

  it('includes external processes the backend does not host', async () => {
    const p = poller({
      backend: fakeBackend({ sessions: [] }),
      processes: [{ harness: 'codex', cwd: '/repo/z', startedMs: NOW - 1000 }],
    })
    const snap = await p.poll()
    expect(snap.sessions).toHaveLength(1)
    expect(snap.sessions[0]!.status).toBe('external')
    expect(snap.attention).toBe(0)
  })
})

describe('the heartbeat', () => {
  it('stamps every ALIVE session on the first poll, so a fleet already up is on record', () => {
    // `-Infinity` as the initial mark is what makes this true. A control center opened onto a fleet
    // that was already running would otherwise carry no evidence of life until a minute in, and
    // would sit out a fall that happened in that minute.
    const calls: Array<{ ids: readonly string[]; atMs: number }> = []
    const p = poller({
      backend: fakeBackend({
        sessions: [backendSession('a'), backendSession('dead', { alive: false })],
      }),
      registry: [managed('a'), managed('dead')],
      touchSessions: async (ids, atMs) => { calls.push({ ids, atMs }) },
    })
    return p.poll().then(() => {
      expect(calls).toHaveLength(1)
      // A dead pane is not alive. Stamping it would put a session that ended on its own into the
      // same cluster as the ones a reboot took.
      expect(calls[0]!.ids).toEqual(['a'])
      expect(calls[0]!.atMs).toBe(NOW)
    })
  })

  it('does not write on every poll — the poll runs every five seconds', async () => {
    let n = 0
    let clock = NOW
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')] }),
      registry: [managed('a')],
      touchSessions: async () => { n++ },
      now: () => clock,
      heartbeatMs: 60_000,
    })
    await p.poll()
    expect(n).toBe(1)
    clock += 5_000
    await p.poll()
    clock += 5_000
    await p.poll()
    expect(n).toBe(1)
    clock += 60_000
    await p.poll()
    expect(n).toBe(2)
  })

  it('keeps polling when the registry cannot be written', async () => {
    // A registry that cannot be written costs the crash group, not the fleet on screen.
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames: { a: ['x'] } }),
      registry: [managed('a')],
      touchSessions: async () => { throw new Error('read-only filesystem') },
    })
    const snap = await p.poll()
    expect(snap.unavailable).toBeUndefined()
    expect(snap.sessions).toHaveLength(1)
  })
})

describe('the sessions that fell together', () => {
  it('marks the rows and reports the group when the backend has lost them', async () => {
    const p = poller({
      backend: fakeBackend({ sessions: [] }),
      registry: [
        managed('a', { lastSeenMs: NOW - 10_000 }),
        managed('b', { lastSeenMs: NOW - 10_000 }),
      ],
    })
    const snap = await p.poll()
    expect(snap.fell?.entries.map(e => e.id)).toEqual(['a', 'b'])
    expect(snap.sessions.every(v => v.fell === true)).toBe(true)
  })

  it('says nothing when there is nothing to say', async () => {
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames: { a: ['x'] } }),
      registry: [managed('a', { lastSeenMs: NOW })],
    })
    const snap = await p.poll()
    expect(snap.fell).toBeUndefined()
    expect(snap.sessions[0]!.fell).toBeUndefined()
  })

  it('keeps the group when a poll fails, alongside the sessions it describes', async () => {
    let fail = false
    const backend = fakeBackend({ sessions: [] })
    const broken: SessionBackend = {
      ...backend,
      async list() {
        if (fail) throw new Error('boom')
        return []
      },
    }
    const p = poller({ backend: broken, registry: [managed('a', { lastSeenMs: NOW })] })
    await p.poll()
    fail = true
    const snap = await p.poll()
    expect(snap.fell?.entries.map(e => e.id)).toEqual(['a'])
    expect(snap.unavailable).toContain('boom')
  })
})

describe('the dialog a blocked session is showing', () => {
  const DIALOG = [
    '● running the migration',
    '│ Do you want to proceed?  │',
    '│ ❯ 1. Yes                 │',
    '│ Enter to confirm · Esc to cancel │',
  ]

  it('carries the bottom of the screen, verbatim, only while it is asking', async () => {
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames: { a: DIALOG } }),
      registry: [managed('a')],
    })
    const snap = await p.poll()
    expect(snap.sessions[0]!.activity).toBe('waiting-approval')
    // The options and the highlight, which nothing else on the screen carries: `lastLines` cuts at
    // the last rule and would hand back the conversation above the dialog.
    expect(snap.sessions[0]!.approvalLines?.join('\n')).toContain('❯ 1. Yes')
  })

  it('carries nothing on a session that is not blocked', async () => {
    const p = poller({
      backend: fakeBackend({ sessions: [backendSession('a')], frames: { a: ['❯ '] } }),
      registry: [managed('a')],
    })
    expect((await p.poll()).sessions[0]!.approvalLines).toBeUndefined()
  })
})

describe('persisting the harness /rename name', () => {
  const index = (byManagedId: Record<string, Record<string, unknown>>) => async () => ({
    byManagedId: new Map(Object.entries(byManagedId)),
    byPid: new Map(), byConversation: new Map(),
  } as never)

  it('persists a name a person typed, exactly once, and only when it CHANGES', async () => {
    const calls: { id: string; name: string; since?: number }[] = []
    const p = createSessionsPoller({
      backend: fakeBackend({ sessions: [backendSession('m1')], frames: { m1: ['x'] } }),
      readRegistry: async () => [managed('m1')],
      scanProcesses: async () => ({ procs: [] }),
      now: () => NOW,
      loadHarnessSessions: index({ m1: { name: 'MAIN', nameSince: 7, tmux: 'agentop-m1:@0.%0' } }),
      recordHarnessName: async (id, name, since) => { calls.push({ id, name, ...(since !== undefined ? { since } : {}) }) },
    })
    await p.poll()
    expect(calls).toEqual([{ id: 'm1', name: 'MAIN', since: 7 }])

    // Registry now already holds the name — the next poll must not write again.
    calls.length = 0
    const p2 = createSessionsPoller({
      backend: fakeBackend({ sessions: [backendSession('m1')], frames: { m1: ['x'] } }),
      readRegistry: async () => [managed('m1', { harnessName: 'MAIN', harnessNameSince: 7 })],
      scanProcesses: async () => ({ procs: [] }),
      now: () => NOW,
      loadHarnessSessions: index({ m1: { name: 'MAIN', nameSince: 7, tmux: 'agentop-m1:@0.%0' } }),
      recordHarnessName: async (id, name, since) => { calls.push({ id, name, ...(since !== undefined ? { since } : {}) }) },
    })
    await p2.poll()
    expect(calls).toEqual([])
  })

  it('never persists a name the harness invented for itself', async () => {
    const calls: unknown[] = []
    const p = createSessionsPoller({
      backend: fakeBackend({ sessions: [backendSession('m1')], frames: { m1: ['x'] } }),
      readRegistry: async () => [managed('m1')],
      scanProcesses: async () => ({ procs: [] }),
      now: () => NOW,
      loadHarnessSessions: index({ m1: { name: 'agentistics-77', nameSource: 'derived', tmux: 'agentop-m1:@0.%0' } }),
      recordHarnessName: async (...a) => { calls.push(a) },
    })
    await p.poll()
    expect(calls).toEqual([])
  })
})
