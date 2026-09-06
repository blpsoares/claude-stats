import { describe, expect, it } from 'bun:test'
import { HARNESS_ORDER } from '@agentistics/core'
import { rulesFor } from './attention-rules'
import type { HarnessProcess } from '../live-sessions'
import type { ManagedSession, SessionActivity } from './types'
import type { ReconciledSession } from './session-ref'
import {
  attentionCount, bellTransitions, buildSessionViews, collapseSupersededSessions,
  needsAttention, type SessionView, dedupeExternalProcesses, externalId
} from './session-view'

const managed = (id: string, over: Partial<ManagedSession> = {}): ManagedSession => ({
  id, harness: 'claude', cwd: '/repo/a', createdAt: '2026-08-13T10:00:00.000Z', ...over,
})

const row = (id: string, over: Partial<ReconciledSession> = {}): ReconciledSession => ({
  id,
  managed: managed(id),
  backend: { id, createdMs: 1000, attached: false, alive: true, lastActivityMs: 1000 },
  status: 'running',
  ...over,
})

const proc = (over: Partial<HarnessProcess> = {}): HarnessProcess =>
  ({ harness: 'claude', cwd: '/repo/other', startedMs: 5000, ...over })

describe('needsAttention', () => {
  it('counts both waiting states and nothing else', () => {
    expect(needsAttention('waiting')).toBe(true)
    expect(needsAttention('waiting-approval')).toBe(true)
    expect(needsAttention('working')).toBe(false)
    expect(needsAttention('exited')).toBe(false)
    expect(needsAttention(undefined)).toBe(false)
  })
})

describe('buildSessionViews', () => {
  it('carries the registry metadata onto the view', () => {
    const reconciled = [row('a', { managed: managed('a', { label: 'auth', note: 'wip', model: 'opus' }) })]
    const [v] = buildSessionViews({ reconciled, activity: new Map([['a', 'waiting']]), processes: [] })
    expect(v).toMatchObject({
      id: 'a', harness: 'claude', cwd: '/repo/a', label: 'auth', note: 'wip', model: 'opus',
      status: 'running', activity: 'waiting', approvalDetection: true,
    })
  })

  it('carries chat turns onto the view, keyed by session id — and leaves them off a session with none', () => {
    const reconciled = [row('a'), row('b')]
    const chatTails = new Map([
      ['a', [{ role: 'user' as const, text: 'hi' }, { role: 'assistant' as const, text: 'hello' }]],
    ])
    const [a, b] = buildSessionViews({ reconciled, activity: new Map(), processes: [], chatTails })
    expect(a!.chatTurns).toEqual([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }])
    expect(b!.chatTurns).toBeUndefined()
  })

  it('reports approval detection exactly where rules exist, for every harness', () => {
    // Written as an INVARIANT rather than against one harness that happens to be unprobed today:
    // this test used to name gemini, and it broke the day gemini was probed — asserting a fact
    // about the world instead of about the code, which is the wrong thing for a test to pin.
    for (const harness of HARNESS_ORDER) {
      const reconciled = [row('a', { managed: managed('a', { harness }) })]
      const [v] = buildSessionViews({ reconciled, activity: new Map(), processes: [] })
      expect(v!.approvalDetection).toBe(rulesFor(harness) !== undefined)
    }
  })

  it('leaves the harness absent for a session the registry has forgotten', () => {
    // `unregistered` means the backend hosts it and the registry does not know it. Which harness it
    // runs is genuinely unknown, and defaulting it to claude would file it under a harness it may
    // not be — in a list whose entire value is being trustworthy.
    const reconciled: ReconciledSession[] = [{
      id: 'u',
      backend: { id: 'u', createdMs: 1000, attached: false, alive: true, lastActivityMs: 1000 },
      status: 'unregistered',
    }]
    const [v] = buildSessionViews({ reconciled, activity: new Map(), processes: [] })
    expect(v!.harness).toBeUndefined()
    expect(v!.approvalDetection).toBe(false)
  })

  it('lists an external process, with no activity claimed for it', () => {
    const views = buildSessionViews({ reconciled: [], activity: new Map(), processes: [proc()] })
    expect(views).toHaveLength(1)
    expect(views[0]!.status).toBe('external')
    expect(views[0]!.activity).toBeUndefined()
    expect(views[0]!.cwd).toBe('/repo/other')
  })

  it('gives an external process a stable id across polls', () => {
    const once = buildSessionViews({ reconciled: [], activity: new Map(), processes: [proc()] })
    const again = buildSessionViews({ reconciled: [], activity: new Map(), processes: [proc()] })
    expect(once[0]!.id).toBe(again[0]!.id)
  })

  it('separates two external processes of the same harness in the same directory', () => {
    // Keyed on the start time as well as harness+cwd: two assistants open in one repo are two rows,
    // and the start time is the only thing that both distinguishes them and survives a poll.
    const views = buildSessionViews({
      reconciled: [],
      activity: new Map(),
      processes: [proc({ startedMs: 1 }), proc({ startedMs: 2 })],
    })
    expect(views).toHaveLength(2)
    expect(views[0]!.id).not.toBe(views[1]!.id)
  })

  it('drops an external process already covered by a managed session', () => {
    // The same running assistant must not appear as a managed row AND an external one — the bug
    // resolveLiveSnapshot already had to fix once.
    const views = buildSessionViews({
      reconciled: [row('a')],
      activity: new Map([['a', 'working']]),
      processes: [proc({ cwd: '/repo/a' })],
    })
    expect(views).toHaveLength(1)
    expect(views[0]!.id).toBe('a')
  })

  it('keeps an external process of a DIFFERENT harness in the same directory', () => {
    const views = buildSessionViews({
      reconciled: [row('a')],
      activity: new Map([['a', 'working']]),
      processes: [proc({ cwd: '/repo/a', harness: 'codex' })],
    })
    expect(views).toHaveLength(2)
  })

  it('sorts what needs answering to the top', () => {
    const reconciled = [row('w'), row('k'), row('ap'), row('x', { status: 'exited' })]
    const activity = new Map<string, SessionActivity>([
      ['w', 'working'], ['k', 'waiting'], ['ap', 'waiting-approval'], ['x', 'exited'],
    ])
    const views = buildSessionViews({ reconciled, activity, processes: [proc()] })
    expect(views.map(v => v.id).slice(0, 4)).toEqual(['ap', 'k', 'w', 'x'])
    expect(views[4]!.status).toBe('external')
  })
})

describe('attentionCount', () => {
  it('counts only the sessions waiting on someone', () => {
    const reconciled = [row('a'), row('b'), row('c')]
    const activity = new Map<string, SessionActivity>([
      ['a', 'waiting-approval'], ['b', 'working'], ['c', 'waiting'],
    ])
    expect(attentionCount(buildSessionViews({ reconciled, activity, processes: [] }))).toBe(2)
  })
})

describe('bellTransitions', () => {
  const views = (activity: SessionActivity) =>
    buildSessionViews({ reconciled: [row('a')], activity: new Map([['a', activity]]), processes: [] })

  it('rings when a session enters attention', () => {
    expect(bellTransitions(new Map([['a', 'working']]), views('waiting'))).toEqual(['a'])
  })

  it('does not ring again while it stays there', () => {
    expect(bellTransitions(new Map([['a', 'waiting']]), views('waiting'))).toEqual([])
  })

  it('rings when it escalates from waiting to a blocking question', () => {
    // Different urgency, and the user chose the terminal bell as the only signal there is.
    expect(bellTransitions(new Map([['a', 'waiting']]), views('waiting-approval'))).toEqual(['a'])
  })

  it('rings for a session seen for the first time already waiting', () => {
    expect(bellTransitions(new Map(), views('waiting'))).toEqual(['a'])
  })

  it('never rings for an external session, whose state is not knowable', () => {
    const external = buildSessionViews({ reconciled: [], activity: new Map(), processes: [proc()] })
    expect(bellTransitions(new Map(), external)).toEqual([])
  })
})

describe("what the harness says about its OWN session", () => {
  const index = (over: {
    byManagedId?: Record<string, Record<string, unknown>>
    byPid?: Record<number, Record<string, unknown>>
    byConversation?: Record<string, Record<string, unknown>>
  }) => ({
    byManagedId: new Map(Object.entries(over.byManagedId ?? {})),
    byPid: new Map(Object.entries(over.byPid ?? {}).map(([k, v]) => [Number(k), v])),
    byConversation: new Map(Object.entries(over.byConversation ?? {})),
  }) as never

  const managed = (id: string, o: Partial<ManagedSession> = {}): ManagedSession => ({
    id, harness: 'claude', cwd: '/repo/a', createdAt: '2026-08-14T10:00:00.000Z', ...o,
  })

  it('carries a name a person typed inside the session', () => {
    const [v] = buildSessionViews({
      reconciled: [{ id: 'm1', managed: managed('m1'), status: 'lost' }],
      activity: new Map(),
      processes: [],
      harnessSessions: index({ byManagedId: { m1: { name: 'principal do cockpit' } } }),
    })
    expect(v!.harnessName).toBe('principal do cockpit')
    // And it is SEARCHABLE, because it may be the only name the person remembers.
    expect(v!.searchFields.name).toContain('principal do cockpit')
  })

  it('carries nothing for a name the harness invented for itself', () => {
    const [v] = buildSessionViews({
      reconciled: [{ id: 'm1', managed: managed('m1'), status: 'lost' }],
      activity: new Map(),
      processes: [],
      harnessSessions: index({
        byManagedId: { m1: { name: 'agentistics-77', nameSource: 'derived' } },
      }),
    })
    expect(v!.harnessName).toBeUndefined()
  })

  it('resolves the conversation EXACTLY, over the directory guess', () => {
    // The guess this replaces matches on harness+directory, so every session in one repository
    // resolves to the same conversation — the bug that reopened three rows onto one conversation.
    const conv = (sessionId: string, title: string, lastActivityMs: number) => ({
      sessionId, title, lastActivityMs,
      harness: 'claude' as const, cwd: '/repo/a', resumable: true, firstPrompt: '',
    })
    // The newest is deliberately the WRONG one, so the directory guess and the exact answer differ.
    const conversations = [conv('wrong', 'the guess', 2), conv('right', 'the truth', 1)]
    const [v] = buildSessionViews({
      reconciled: [{ id: 'm1', managed: managed('m1'), status: 'exited' }],
      activity: new Map(),
      processes: [],
      conversations,
      harnessSessions: index({ byManagedId: { m1: { sessionId: 'right' } } }),
    })
    expect(v!.resume?.sessionId).toBe('right')
  })

  it('gives a CLOSED row the name its own session chose, over the store title', () => {
    // Measured on 2026-08-15. A session renamed to `MAIN` was listed under
    // `Build agentop harness cockpit with session management` — a title from a different week.
    // It is a BACKGROUND AGENT: no tmux, so `byManagedId` cannot see it, and the /proc scan
    // surfaced nothing, so `byPid` was never asked. `byConversation` is the key that needs
    // neither.
    const views = buildSessionViews({
      reconciled: [],
      activity: new Map(),
      processes: [],
      conversations: [{
        sessionId: '581deab7', title: 'Build agentop harness cockpit with session management',
        lastActivityMs: 1, harness: 'claude' as const, cwd: '/repo/a', resumable: true,
        firstPrompt: '',
      }],
      harnessSessions: index({ byConversation: { '581deab7': { name: 'MAIN' } } }),
    })
    expect(views[0]!.label).toBe('MAIN')
    // Findable by BOTH: the name it now shows, and the one it used to show.
    expect(views[0]!.searchFields.name.toLowerCase()).toContain('main')
    expect(views[0]!.searchFields.name.toLowerCase()).toContain('cockpit')
  })

  it('a conversation whose record is ALIVE is running, not closed', () => {
    // The other half of the report. A background agent alive for 38 minutes sat in the closed block
    // under a title from another week, offering to "reopen" a conversation that had never stopped.
    // It is synthesised into the SAME external path a scanned process takes, so it inherits every
    // rule already written there rather than getting a parallel branch.
    const views = buildSessionViews({
      reconciled: [],
      activity: new Map(),
      processes: [],
      conversations: [{
        sessionId: '581deab7', title: 'a title from another week', lastActivityMs: 1,
        harness: 'claude' as const, cwd: '/repo/a', resumable: true, firstPrompt: '',
      }],
      harnessSessions: index({
        byConversation: {
          '581deab7': {
            name: 'MAIN', pid: 508665, cwd: '/repo/a', sessionId: '581deab7',
            harness: 'claude', alive: true,
          },
        },
      }),
    })
    expect(views.map(v => v.status)).toContain('external')
    expect(views.find(v => v.status === 'external')?.harnessName).toBe('MAIN')
    // …and it is not ALSO sitting in the closed block under the old title.
    expect(views.filter(v => v.status === 'closed')).toHaveLength(0)
  })

  it('synthesises nothing when liveness could not be determined', () => {
    // `alive: undefined` means no /proc — not Linux, or a uid that may not read it. Unknown must
    // never become a claim, so the row stays exactly as it was today.
    const views = buildSessionViews({
      reconciled: [],
      activity: new Map(),
      processes: [],
      conversations: [{
        sessionId: 'c1', title: 'stored title', lastActivityMs: 1,
        harness: 'claude' as const, cwd: '/repo/a', resumable: true, firstPrompt: '',
      }],
      harnessSessions: index({
        byConversation: { c1: { name: 'MAIN', pid: 1, cwd: '/repo/a', harness: 'claude' } },
      }),
    })
    expect(views).toHaveLength(1)
    expect(views[0]!.status).toBe('closed')
  })

  it('never lets a DERIVED name displace a real store title', () => {
    // `agentistics-84` is what the harness invents from the folder when nobody has said anything.
    const views = buildSessionViews({
      reconciled: [],
      activity: new Map(),
      processes: [],
      conversations: [{
        sessionId: 'c1', title: 'a title somebody wrote', lastActivityMs: 1,
        harness: 'claude' as const, cwd: '/repo/a', resumable: true, firstPrompt: '',
      }],
      harnessSessions: index({
        byConversation: { c1: { name: 'agentistics-84', nameSource: 'derived' } },
      }),
    })
    expect(views[0]!.label).toBe('a title somebody wrote')
  })

  it('matches an EXTERNAL process by its pid', () => {
    const views = buildSessionViews({
      reconciled: [],
      activity: new Map(),
      processes: [{ harness: 'claude', cwd: '/repo/z', pid: 4242, startedMs: 10 }],
      harnessSessions: index({ byPid: { 4242: { name: 'the one in the other window' } } }),
    })
    expect(views[0]!.harnessName).toBe('the one in the other window')
  })

  it('leaves every row exactly as it was when nothing can be read', () => {
    // A harness with no such file, an unreadable directory, a container that cannot see it: the
    // feature costs the extra name and nothing else.
    const [v] = buildSessionViews({
      reconciled: [{ id: 'm1', managed: managed('m1', { label: 'Principal' }), status: 'lost' }],
      activity: new Map(),
      processes: [],
    })
    expect(v!.harnessName).toBeUndefined()
    expect(v!.label).toBe('Principal')
  })
})

describe('a row that KNOWS which conversation it drives', () => {
  const conv = (sessionId: string, over: Record<string, unknown> = {}) => ({
    sessionId,
    harness: 'claude' as const,
    cwd: '/repo/a',
    title: sessionId,
    lastActivityMs: 1,
    resumable: true,
    firstPrompt: '',
    ...over,
  })

  it('offers exactly that conversation, never the directory guess', () => {
    const reconciled = [row('a', {
      status: 'lost',
      backend: undefined,
      managed: managed('a', { conversationId: 'mine' }),
    })]
    const [v] = buildSessionViews({
      reconciled,
      activity: new Map(),
      processes: [],
      // `older` is the one the harness+directory guess would pick — same harness, same directory.
      conversations: [conv('older'), conv('mine')],
    })
    expect(v!.resume?.sessionId).toBe('mine')
  })

  it('offers NOTHING when the store does not hold that conversation yet', () => {
    // Ordinary now that the id is recorded at SPAWN rather than only at reopen: a session minutes
    // old has an id and no transcript written under it. Falling through to the guess would hand it
    // an unrelated conversation from the same directory — the bug that reopened three rows onto one.
    const reconciled = [row('a', {
      status: 'lost',
      backend: undefined,
      managed: managed('a', { conversationId: 'not-written-yet' }),
    })]
    const [v] = buildSessionViews({
      reconciled,
      activity: new Map(),
      processes: [],
      conversations: [conv('older')],
    })
    expect(v!.resume).toBeUndefined()
  })

  it('still guesses for a row that recorded nothing — the old behaviour, unchanged', () => {
    const reconciled = [row('a', { status: 'lost', backend: undefined })]
    const [v] = buildSessionViews({
      reconciled,
      activity: new Map(),
      processes: [],
      conversations: [conv('older')],
    })
    expect(v!.resume?.sessionId).toBe('older')
  })

  it('carries the repository the registry recorded, for the caller that resolves the facts', () => {
    const repo = { repo: 'blpsoares/agentistics', root: 'agentistics', worktree: true }
    const reconciled = [row('a', { managed: managed('a', { repo }) })]
    const [v] = buildSessionViews({ reconciled, activity: new Map(), processes: [] })
    expect(v!.recordedRepo).toEqual(repo)
  })
})

describe('a session that CHANGED DIRECTORY is still the row hosting it', () => {
  // Reported from a real machine on 2026-08-15. One claude, started by agentop in the repo root,
  // entered a git worktree: its kernel cwd moved while the managed row kept the directory it was
  // spawned in, and the fleet drew the same conversation twice — `working` on the row, `external`
  // beside it. Its own record read:
  //
  //   {"pid":36044,"cwd":"…/agentistics/.claude/worktrees/token-truth",
  //    "tmux":"agentop-e3e4fc2ce6:@2.%2", …}
  //
  // naming the very row it was being listed apart from. The duplicate is not cosmetic: the external
  // twin offers REOPEN, which would put a second assistant on one transcript.
  const index = (over: {
    byPid?: Record<number, Record<string, unknown>>
    byConversation?: Record<string, Record<string, unknown>>
  }) => ({
    byManagedId: new Map(),
    byPid: new Map(Object.entries(over.byPid ?? {}).map(([k, v]) => [Number(k), v])),
    byConversation: new Map(Object.entries(over.byConversation ?? {})),
  }) as never

  const spawnedAt = '/home/padawan/agentistics'
  const movedTo = '/home/padawan/agentistics/.claude/worktrees/token-truth'
  const working = new Map<string, SessionActivity>([['e3e4fc2ce6', 'working']])
  const hostRow = (over: Partial<ReconciledSession> = {}) =>
    row('e3e4fc2ce6', { managed: managed('e3e4fc2ce6', { cwd: spawnedAt }), ...over })

  it('draws ONE row when the process names the managed session it runs in', () => {
    const views = buildSessionViews({
      reconciled: [hostRow()],
      activity: working,
      processes: [proc({ pid: 36044, cwd: movedTo })],
      harnessSessions: index({ byPid: { 36044: { pid: 36044, tmux: 'agentop-e3e4fc2ce6:@2.%2' } } }),
    })
    expect(views.filter(v => v.status === 'external')).toHaveLength(0)
    expect(views).toHaveLength(1)
    expect(views[0]!.id).toBe('e3e4fc2ce6')
  })

  it('covers by the link even when the row reconciled to a state the guess would reject', () => {
    // `lost` while the process is demonstrably alive is a reconciliation fault to be SHOWN as one,
    // never a licence to draw the session twice. The directory path deliberately keeps rejecting a
    // non-running row; this is the exact path, where the link is proof.
    const views = buildSessionViews({
      reconciled: [hostRow({ status: 'lost', backend: undefined })],
      activity: new Map(),
      processes: [proc({ pid: 36044, cwd: movedTo })],
      harnessSessions: index({ byPid: { 36044: { pid: 36044, tmux: 'agentop-e3e4fc2ce6:@2.%2' } } }),
    })
    expect(views.filter(v => v.status === 'external')).toHaveLength(0)
  })

  it('matches by conversation id for a process the /proc scan never reported', () => {
    // A row synthesised from a record arrives with no pid the scan has seen. It must resolve the
    // same way, or the background-agent path re-opens the duplicate by another door.
    const views = buildSessionViews({
      reconciled: [hostRow()],
      activity: working,
      processes: [proc({ cwd: movedTo, sessionId: '7ee6e39f' })],
      harnessSessions: index({
        byConversation: { '7ee6e39f': { tmux: 'agentop-e3e4fc2ce6:@2.%2' } },
      }),
    })
    expect(views.filter(v => v.status === 'external')).toHaveLength(0)
  })

  it('still lists a process whose tmux session is NOT ours', () => {
    // A user's own tmux names nothing of ours, so there is no claim and the directory guess decides
    // — which for a different directory means: a genuine external session, listed.
    const views = buildSessionViews({
      reconciled: [hostRow()],
      activity: working,
      processes: [proc({ pid: 999, cwd: '/somewhere/else' })],
      harnessSessions: index({ byPid: { 999: { pid: 999, tmux: 'my-own-tmux:@0.%0' } } }),
    })
    expect(views.filter(v => v.status === 'external')).toHaveLength(1)
  })

  it('does not let a claim on an UNKNOWN row swallow the process', () => {
    // The record names an agentop session the registry no longer holds. That is an orphan, and an
    // orphan is external — never silently absent.
    const views = buildSessionViews({
      reconciled: [hostRow()],
      activity: working,
      processes: [proc({ pid: 777, cwd: movedTo })],
      harnessSessions: index({ byPid: { 777: { pid: 777, tmux: 'agentop-gonefromregistry:@0.%0' } } }),
    })
    expect(views.filter(v => v.status === 'external')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// ONE — duplicate rows. A conversation reopened N times left N `exited` rows
// beside its one live continuation, because the row key is the per-spawn
// managedId, not the conversation. `collapseSupersededSessions` drops a
// predecessor ONLY when it is provably dead (endedMs) AND superseded.
// ---------------------------------------------------------------------------
describe('collapseSupersededSessions', () => {
  const sv = (id: string, o: Partial<SessionView> = {}): SessionView => ({
    id, cwd: '/repo/a', status: 'exited', attached: false, approvalDetection: true,
    searchFields: { name: '', folder: '', harness: '', note: '', task: '', prompt: '' },
    ...o,
  })

  it('drops a retired predecessor when a LIVE row drives the same conversation', () => {
    const rows = [
      sv('live', { status: 'running', conversationId: 'c1', createdMs: 2000 }),
      sv('dead', { status: 'exited', conversationId: 'c1', createdMs: 1000, endedMs: 1500 }),
    ]
    const out = collapseSupersededSessions(rows)
    expect(out.map(v => v.id)).toEqual(['live'])
  })

  it('keeps the NEWEST ended row when nothing is live, and drops the older ended ones', () => {
    const rows = [
      sv('old1', { conversationId: 'c1', createdMs: 1000, endedMs: 1100 }),
      sv('old2', { conversationId: 'c1', createdMs: 2000, endedMs: 2100 }),
      sv('newest', { conversationId: 'c1', createdMs: 3000, endedMs: 3100 }),
    ]
    const out = collapseSupersededSessions(rows)
    // The newest ended row survives — it is the reopenable representative of the conversation.
    expect(out.map(v => v.id)).toEqual(['newest'])
  })

  // NEGATIVE — the guarantee the coordinator reads this list for.
  it('NEVER drops a live row, even when it shares a conversation with another live row', () => {
    const rows = [
      sv('liveA', { status: 'running', conversationId: 'c1', createdMs: 1000 }),
      sv('liveB', { status: 'running', conversationId: 'c1', createdMs: 2000 }),
    ]
    const out = collapseSupersededSessions(rows)
    expect(out.map(v => v.id).sort()).toEqual(['liveA', 'liveB'])
  })

  it('NEVER drops a row it cannot prove is dead — a lost row with no end time is kept', () => {
    const rows = [
      sv('live', { status: 'running', conversationId: 'c1', createdMs: 2000 }),
      // `lost` with no endedMs: the backend cannot see it, which is not proof the process is gone.
      sv('unproven', { status: 'lost', conversationId: 'c1', createdMs: 1000 }),
    ]
    const out = collapseSupersededSessions(rows)
    expect(out.map(v => v.id).sort()).toEqual(['live', 'unproven'])
  })

  it('never collapses genuinely distinct sessions — different conversations both stay', () => {
    const rows = [
      sv('a', { status: 'exited', conversationId: 'c1', createdMs: 1000, endedMs: 1100 }),
      sv('b', { status: 'exited', conversationId: 'c2', createdMs: 1000, endedMs: 1100 }),
    ]
    const out = collapseSupersededSessions(rows)
    expect(out.map(v => v.id).sort()).toEqual(['a', 'b'])
  })

  it('never groups rows with NO conversationId — a shared directory is not an identity', () => {
    const rows = [
      sv('a', { status: 'exited', createdMs: 1000, endedMs: 1100 }),
      sv('b', { status: 'exited', createdMs: 2000, endedMs: 2100 }),
    ]
    const out = collapseSupersededSessions(rows)
    expect(out.map(v => v.id).sort()).toEqual(['a', 'b'])
  })

  it('the whole pipeline: a reopen chain collapses to one row through buildSessionViews', () => {
    const m = (id: string, o: Partial<ManagedSession> = {}): ManagedSession => ({
      id, harness: 'claude', cwd: '/repo/a', createdAt: '2026-08-14T10:00:00.000Z',
      conversationId: 'conv', ...o,
    })
    const reconciled: ReconciledSession[] = [
      { id: 'r1', managed: m('r1', { createdAt: '2026-08-14T10:00:00.000Z', endedAt: '2026-08-14T11:00:00.000Z' }), status: 'lost' },
      { id: 'r2', managed: m('r2', { createdAt: '2026-08-14T12:00:00.000Z', endedAt: '2026-08-14T13:00:00.000Z' }), status: 'lost' },
      {
        id: 'r3', managed: m('r3', { createdAt: '2026-08-14T14:00:00.000Z' }),
        backend: { id: 'r3', createdMs: 5000, attached: false, alive: true, lastActivityMs: 5000 },
        status: 'running',
      },
    ]
    const views = buildSessionViews({ reconciled, activity: new Map([['r3', 'working']]), processes: [] })
    const forConv = views.filter(v => v.conversationId === 'conv')
    expect(forConv.map(v => v.id)).toEqual(['r3'])
    expect(forConv[0]!.status).toBe('running')
  })
})

// ---------------------------------------------------------------------------
// TWO — a title is an identity. The `/rename` name lived only in the harness's
// own file, which it deletes on exit; the title then flipped and CTRL+F broke.
// The poller persists the name into the registry, so buildSessionViews reads it
// even when the live file is gone.
// ---------------------------------------------------------------------------
describe('title survives the process (persisted harness name)', () => {
  const m = (id: string, o: Partial<ManagedSession> = {}): ManagedSession => ({
    id, harness: 'claude', cwd: '/repo/a', createdAt: '2026-08-14T10:00:00.000Z', ...o,
  })

  it('a finished row (no live file) still carries its persisted /rename name', () => {
    const [v] = buildSessionViews({
      reconciled: [{
        id: 'm1',
        managed: m('m1', { label: 'Integrar CLI', harnessName: 'AIPE + agentop CLI', harnessNameSince: 42, endedAt: '2026-08-14T11:00:00.000Z' }),
        status: 'lost',
      }],
      activity: new Map(),
      processes: [],
      // No harnessSessions entry — the process is gone, the file deleted.
    })
    expect(v!.harnessName).toBe('AIPE + agentop CLI')
    expect(v!.harnessNameSince).toBe(42)
  })

  it('the LIVE file still wins while the session runs — persistence is only a fallback', () => {
    const [v] = buildSessionViews({
      reconciled: [{ id: 'm1', managed: m('m1', { harnessName: 'stale name', harnessNameSince: 1 }), status: 'lost' }],
      activity: new Map(),
      processes: [],
      harnessSessions: {
        byManagedId: new Map([['m1', { name: 'fresh name', nameSince: 99 }]]),
        byPid: new Map(), byConversation: new Map(),
      } as never,
    })
    expect(v!.harnessName).toBe('fresh name')
    expect(v!.harnessNameSince).toBe(99)
  })
})

describe('dedupeExternalProcesses — one row per SESSION, not per process', () => {
  const proc = (pid: number, extra: Record<string, unknown> = {}) => ({
    harness: 'copilot' as const, cwd: '/tmp', pid, startedMs: 1000, ...extra,
  })

  it('a shim chain carrying ONE session id becomes ONE row', () => {
    // Measured on a real machine: volta installs `copilot` as a chain — the shim, `node
    // …/bin/copilot`, and the native binary — and all three carry `--session-id dbd94500-…`. The
    // fleet drew three identical `copilot em tmp` rows for one session.
    const out = dedupeExternalProcesses([
      proc(42330, { sessionId: 'dbd94500', startedMs: 1000 }),
      proc(42334, { sessionId: 'dbd94500', startedMs: 1000 }),
      proc(42353, { sessionId: 'dbd94500', startedMs: 1120 }),
    ])
    expect(out).toHaveLength(1)
    // The OLDEST, tie-broken by the lowest pid — the same answer on every poll.
    expect(out[0]!.pid).toBe(42330)
  })

  it('the answer does not depend on the order /proc happened to report', () => {
    const a = proc(42353, { sessionId: 'x', startedMs: 1120 })
    const b = proc(42330, { sessionId: 'x', startedMs: 1000 })
    expect(dedupeExternalProcesses([a, b])[0]!.pid).toBe(42330)
    expect(dedupeExternalProcesses([b, a])[0]!.pid).toBe(42330)
  })

  it('two REAL sessions in one directory stay two rows', () => {
    // The merge key is the stated id, never the directory. Collapsing by harness+cwd is exactly the
    // bug `externalId`'s start time was added to avoid.
    const out = dedupeExternalProcesses([
      proc(1, { sessionId: 'a' }),
      proc(2, { sessionId: 'b' }),
    ])
    expect(out).toHaveLength(2)
  })

  it('a process that states NO id is never merged away', () => {
    // It cannot be proven a duplicate. A spurious row is visible and dismissible; a real session
    // missing from the fleet is not.
    const out = dedupeExternalProcesses([proc(1), proc(2), proc(3, { sessionId: 'z' })])
    expect(out).toHaveLength(3)
  })

  it('different harnesses never merge, whatever their ids say', () => {
    const out = dedupeExternalProcesses([
      proc(1, { sessionId: 'same' }),
      { harness: 'claude' as const, cwd: '/tmp', pid: 2, startedMs: 1000, sessionId: 'same' },
    ])
    expect(out).toHaveLength(2)
  })

  it('externalId keys on the session id when there is one', () => {
    // Stable in a way the start time is not: a chain's parent can exit while a child keeps running,
    // and a clock-keyed id would rename the row underneath the user at that moment.
    expect(externalId(proc(1, { sessionId: 'abc' }) as never))
      .toBe(externalId(proc(2, { sessionId: 'abc', startedMs: 9999 }) as never))
    // And falls back to the old key exactly when there is none.
    expect(externalId(proc(1) as never)).not.toBe(externalId(proc(1, { startedMs: 2000 }) as never))
  })
})
