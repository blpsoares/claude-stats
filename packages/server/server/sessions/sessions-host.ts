/**
 * sessions-host.ts — the poller. The only impure module of the monitor: it reads the registry, asks
 * the backend what exists, captures a frame per live session, reads the host's processes, and hands
 * the pure functions everything they need.
 *
 * Bound to its dependencies at construction (the `createSessionRegistry(file)` pattern), so a test
 * exercises the real logic with no tmux server and no `/proc`.
 *
 * Two states it must never confuse, and the reason this file has an `unavailable` field at all:
 * "nothing is running" and "this machine cannot tell". An empty list rendered as a confident zero is
 * the same defect `liveEmptyNotice` exists to prevent on the dashboard.
 */

import { createLimiter } from '../utils'
import type { HarnessProcess } from '../live-sessions'
import { rulesFor } from './attention-rules'
import { approvalTail, attentionOf, digestFrame, frameTail } from './attention'
import { EMPTY_CONFIRM_MEMORY, confirmActivities, type ConfirmMemory } from './attention-confirm'
import type { ChatTurn } from './chat-turn'
import { transcriptReaderFor } from './harness-transcript'
import { markFleetPhase } from './fleet-profile'
import { parseDialogOptions, type DialogOption } from './dialog-choice'
// Taking a running session back when its registry record is gone. See `session-adopt.ts`.
import { planAdoptions } from './session-adopt'
import { loadConversations, type Conversation } from './conversations'
import { HEARTBEAT_MS, planCrashGroup, type CrashGroup } from './crash-group'
import { emptyHarnessSessionIndex, type HarnessSessionIndex } from './harness-sessions'
import { chosenName } from './harness-session-file'
import { reconcileSessions } from './session-ref'
import {
  attentionCount, bellTransitions, buildSessionViews, type SessionView,
} from './session-view'
import type { ManagedSession, SessionActivity, SessionBackend } from './types'
import { calculateProcCpu, type ProcStatSample } from '../hardware-pure'
import { readProcRss, readProcStat } from '../hardware-probe'
import { procAvailable } from './proc-liveness'
import { backgroundWork } from './attention'

/** How often the cockpit refreshes. Five seconds is the interval the feature was specified at. */
export const SESSION_POLL_MS = Number(process.env.AGENTISTICS_SESSION_POLL_MS) > 0
  ? Number(process.env.AGENTISTICS_SESSION_POLL_MS)
  : 5_000

/** How much of the pane to read. Enough to hold a dialog and a footer, not the whole scrollback. */
const CAPTURE_LINES = 60

/** Frames are captured one per live session; four at a time keeps a large fleet from forking a
 *  process per session all at once. */
const CAPTURE_CONCURRENCY = 4

/** How much of what a session is saying to carry. Enough that a tall pane has something to fill it
 *  with; the pane cuts from the bottom to whatever it can actually draw. */
const TAIL_LINES = 8

/** How many role-tagged chat turns to carry for a readable session — see `harness-transcript.ts`. */
const TAIL_CHAT_TURNS = 6

/**
 * How much of a blocked session's screen to carry as the dialog.
 *
 * Ten lines holds a permission prompt with three options, its question and its footer — measured
 * against the frames `attention-rules.ts` was probed from. More would start carrying the
 * conversation above the dialog into a pane whose whole job is to show only what is being answered.
 */
const APPROVAL_LINES = 10

export interface SessionSnapshot {
  sessions: SessionView[]
  /** How many are waiting on a person. Drives the header counter. */
  attention: number
  /** Ids that JUST started waiting — the caller rings the bell for these. */
  rang: string[]
  polledAtMs: number
  /**
   * The sessions the machine took all at once, when there are any — see `crash-group.ts`.
   *
   * On the snapshot rather than derived from `sessions`, because it is a statement about a SET: a row
   * is in it because of when every other row was last alive, which no per-row rule can answer.
   */
  fell?: CrashGroup
  /**
   * Why this list may not be the whole truth, already a sentence.
   *
   * Set when the backend cannot run here at all, or when a poll failed and the sessions above are
   * the PREVIOUS snapshot rather than a fresh one.
   */
  unavailable?: string
}

export interface SessionsPoller {
  poll(): Promise<SessionSnapshot>
}

export function createSessionsPoller(o: {
  backend: SessionBackend
  readRegistry: () => Promise<ManagedSession[]>
  scanProcesses: () => Promise<{ procs: HarnessProcess[] }>
  /**
   * Every conversation this machine knows about — what names an external session and what fills the
   * "closed, reopenable" rows. Injected and OPTIONAL: it is a filesystem read, and the tests that
   * exercise the poller's real logic must not need one.
   */
  loadConversations?: () => Promise<Conversation[]>
  /**
   * What each harness records about its OWN live sessions — the name typed inside a session, and
   * the conversation it is driving, both keyed EXACTLY. Injected and optional, like
   * `loadConversations`: it is a filesystem read, and a harness with no such file simply has none.
   */
  loadHarnessSessions?: () => Promise<HarnessSessionIndex>
  /**
   * Stamp `lastSeenMs` on the sessions that are alive right now — the HEARTBEAT.
   *
   * Injected and optional for the same reason `loadConversations` is: it writes to disk, and the
   * tests that exercise the poller's real logic must not need a filesystem. It is what makes "these
   * fell together" answerable at all — see `crash-group.ts`.
   */
  touchSessions?: (ids: readonly string[], atMs: number) => Promise<unknown>
  /**
   * Record the conversation a managed row is EXACTLY known to be driving.
   *
   * Called only when the harness's own record says so and the registry does not already agree, so it
   * writes once per session rather than once per poll. It is what carries the exact id past the
   * session's own lifetime: the harness deletes its file when the process goes, and a `lost` row
   * with nothing recorded falls back to the harness-and-directory guess that cannot tell two
   * sessions of one repository apart — the guess that once reopened three rows onto one
   * conversation.
   */
  recordConversation?: (id: string, conversationId: string) => Promise<unknown>
  /**
   * Persist the name a managed row was given INSIDE the harness (`/rename`), so the title survives
   * the process.
   *
   * Mirror of `recordConversation`, and for the same reason: the harness deletes its own session
   * file when the process ends, so a name that lived only there is lost the instant the session
   * finishes — the displayed title then flips to a different source and `CTRL+F` can no longer find
   * the row by the name it wore a moment ago. Called ONLY when the live, non-derived name disagrees
   * with what the registry already holds, so it writes once per rename and not once per poll.
   */
  recordHarnessName?: (id: string, name: string, since?: number) => Promise<unknown>
  /**
   * Write registry records for sessions the backend is running and the registry has lost.
   *
   * Injected and optional for the same reason the two above are: it writes to disk. Called only with
   * a non-empty list, so a fleet with nothing to adopt — the ordinary case — never touches the file.
   * What may be adopted at all is the pure `planAdoptions`.
   */
  adoptSessions?: (records: readonly ManagedSession[]) => Promise<unknown>
  now?: () => number
  captureLines?: number
  /** Overridable so a test can drive several heartbeats without waiting a minute for each. */
  heartbeatMs?: number
}): SessionsPoller {
  const now = o.now ?? (() => Date.now())
  const lines = o.captureLines ?? CAPTURE_LINES
  const heartbeatMs = o.heartbeatMs ?? HEARTBEAT_MS
  const limit = createLimiter(CAPTURE_CONCURRENCY)

  // Carried between polls: what each session's screen looked like, and what state it was in. The
  // first is how movement is detected; the second is what makes the bell a transition.
  let prevDigest = new Map<string, string>()
  let prevActivity = new Map<string, SessionActivity>()
  // The raw per-poll reading is noisy: a session that just finished, or a pane a plugin repainted,
  // reads `working` then `waiting` across two polls with nothing changed. `confirmActivities` turns
  // that into a CONFIRMED reading — a needs-you state must be seen twice before the counter believes
  // it, while a return to work is believed at once — so the "waiting on you" count stops lying.
  let confirmMemory: ConfirmMemory = EMPTY_CONFIRM_MEMORY
  const prevProcStats = new Map<number, ProcStatSample>()
  let last: SessionSnapshot | null = null
  /**
   * When the heartbeat last wrote. `-Infinity` so the FIRST poll always stamps.
   *
   * Stamping immediately matters: a machine that comes up, has three sessions reopened into it and
   * then falls again inside the first minute would otherwise have three rows carrying only their
   * creation stamps — which is fine — but a fleet that was already running when this process started
   * would carry nothing at all, and would sit out the next crash entirely.
   */
  let lastHeartbeatMs = -Infinity

  async function poll(): Promise<SessionSnapshot> {
    const nowMs = now()

    const blocked = await o.backend.unavailable().catch(() => undefined)
    if (blocked) {
      // The backend cannot run here. That is a sentence, not an empty fleet.
      const snap: SessionSnapshot = {
        sessions: [], attention: 0, rang: [], polledAtMs: nowMs, unavailable: blocked,
      }
      last = snap
      return snap
    }

    try {
      const gatherStart = performance.now()
      // Each of the five is timed SEPARATELY as well as together, because the two numbers disagreed
      // and the disagreement is the whole question. Measured individually in a bare process, none
      // of them exceeded 415ms; measured here inside this `Promise.all`, the group took 2961ms. A
      // group total cannot say which member carries that, and five concurrent readers of the same
      // disk are exactly the shape that makes a per-member number differ from a solo one — so the
      // per-member marks are taken IN PLACE, under the concurrency they actually run under, rather
      // than inferred from a solo timing that has already proved not to transfer.
      const timed = <T>(label: string, p: Promise<T>): Promise<T> => {
        const started = performance.now()
        return p.then(v => { markFleetPhase(`poll: gather · ${label}`, started); return v })
      }
      const [registry, backendSessions, processes, conversations, harnessSessions] = await Promise.all([
        timed('readRegistry', o.readRegistry()),
        timed('backend.list', o.backend.list()),
        timed('scanProcesses', o.scanProcesses().then(r => r.procs).catch(() => [] as HarnessProcess[])),
        // History is an enrichment, never a prerequisite: a store that cannot be read costs the
        // closed rows, not the running ones.
        timed('loadConversations',
          o.loadConversations ? o.loadConversations().catch(() => [] as Conversation[]) : Promise.resolve([])),
        // Same rule: unreadable costs the harness's own names and its exact conversation ids, and
        // every row falls back to behaving exactly as it did before this existed.
        timed('loadHarnessSessions',
          o.loadHarnessSessions
            ? o.loadHarnessSessions().catch(() => emptyHarnessSessionIndex())
            : Promise.resolve(emptyHarnessSessionIndex())),
      ])
      markFleetPhase('poll: gather (registry/backend.list/scanProcesses/conversations/harnessSessions)', gatherStart)

      const reconciled = reconcileSessions(registry, backendSessions)
      const harnessOf = new Map(registry.map(r => [r.id, r.harness]))

      // Take back any session the backend is running that the registry has lost. It is not a
      // theoretical case: the registry's write queue is per PROCESS, several agentop processes write
      // the same file, and a record added by a short-lived one has been observed erased by a
      // longer-lived one — leaving the user sitting in a session the cockpit could no longer name,
      // attach to, rename or kill. Adoption never invents anything: see `session-adopt.ts`. It is
      // idempotent by construction (an adopted row stops being `unregistered`), so it writes once.
      if (o.adoptSessions) {
        const adoptStart = performance.now()
        const adopt = planAdoptions({
          rows: reconciled,
          byManagedId: harnessSessions.byManagedId,
          harness: 'claude',
          nowIso: new Date(nowMs).toISOString(),
        })
        // Best effort, exactly like the heartbeat: a registry that cannot be written costs the
        // adoption, never the fleet on screen.
        if (adopt.length > 0) await o.adoptSessions(adopt).catch(() => undefined)
        markFleetPhase(`poll: adoptSessions x${adopt.length}`, adoptStart)
      }

      const nextDigest = new Map<string, string>()
      const activity = new Map<string, SessionActivity>()
      /** Rows whose reading is backed by more than movement — see `confirmActivities`. */
      const corroborated = new Set<string>()
      /** Rows with work running that is not their own turn — see `backgroundWork`. */
      const background = new Set<string>()
      const tails = new Map<string, string[]>()
      const approvals = new Map<string, string[]>()
      const dialogOptions = new Map<string, DialogOption[]>()
      const chatTails = new Map<string, ChatTurn[]>()

      const captureStart = performance.now()
      await Promise.all(reconciled.map(r => limit(async () => {
        const b = r.backend
        if (!b) return // `lost`: the backend has nothing to capture and nothing to report.
        if (!b.alive) { activity.set(r.id, 'exited'); return }

        const frame = await o.backend.capture(r.id, lines).catch(() => [] as string[])
        const frameDigest = digestFrame(frame)
        nextDigest.set(r.id, frameDigest)
        tails.set(r.id, frameTail(frame, TAIL_LINES))

        const harness = harnessOf.get(r.id)

        // Read the harness's own transcript instead of the screen, wherever BOTH halves hold: the
        // conversation id is EXACT and somebody has written a reader for that harness's format
        // (`harness-transcript.ts`). Either missing and the raw screen tail above stays the row's
        // only detail content — never a conversation guessed from harness-and-directory.
        //
        // TWO exact sources, and they are not interchangeable. Claude's own
        // `~/.claude/sessions/<pid>.json` names our tmux session, which is the link for a session
        // we did not start; `ManagedSession.conversationId` is the id agentop handed the CLI
        // itself, which is the only one the other harnesses can ever have. Claude's own record is
        // preferred where both exist — it is the LIVE one, while the registry's was recorded once.
        const cwd = r.managed?.cwd
        const conversationId = harnessSessions.byManagedId.get(r.id)?.sessionId
          ?? r.managed?.conversationId
        const transcript = transcriptReaderFor(harness)
        if (transcript && conversationId) {
          const path = await transcript
            .resolve({ conversationId, ...(cwd ? { cwd } : {}) })
            .catch(() => null)
          if (path) {
            const turns = await transcript.readRecent(path, TAIL_CHAT_TURNS).catch(() => [] as ChatTurn[])
            if (turns.length > 0) chatTails.set(r.id, turns)
          }
        }

        const rules = harness ? rulesFor(harness) : undefined
        // CORROBORATED: the harness said so itself. A `working` read from MOVEMENT ALONE, on a
        // harness that does print a working marker, is most likely a repaint — and that is what
        // made a row alternate between `working` and `needs you` continuously, with a notification
        // each time. A harness with NO marker has nothing better than movement, so its reading
        // stands. See `confirmActivities`.
        if (!rules?.working?.length || rules.working.some(re => re.test(frame.join('\n')))) {
          corroborated.add(r.id)
        }
        const before = prevDigest.get(r.id)
        if (backgroundWork({ frame, ...(rules ? { rules } : {}) })) background.add(r.id)
        const state = attentionOf({
          alive: true,
          lastActivityMs: b.lastActivityMs,
          nowMs,
          frame,
          frameDigest,
          ...(before !== undefined ? { prevDigest: before } : {}),
          ...(rules ? { rules } : {}),
        })
        activity.set(r.id, state)
        // The dialog is kept from the frame that DECIDED the state, so the two can never describe
        // different moments — and it costs nothing extra, the frame is already here.
        if (state === 'waiting-approval') {
          approvals.set(r.id, approvalTail(frame, APPROVAL_LINES))
          // Read from the SAME frame that decided the state, so what is offered and what the state
          // says can never describe different moments. Empty when the screen cannot be parsed with
          // confidence, which the UI reports rather than papering over.
          const options = parseDialogOptions(frame)
          if (options.length > 0) dialogOptions.set(r.id, options)
        }
      })))
      markFleetPhase(`poll: capture+chatTail x${reconciled.length} (concurrency ${CAPTURE_CONCURRENCY})`, captureStart)

      // The heartbeat: one write, one timestamp, every session the backend reports as ALIVE. See
      // `crash-group.ts` for why one shared timestamp is what makes the grouping exact.
      const aliveIds = backendSessions.filter(b => b.alive).map(b => b.id)
      if (o.touchSessions && nowMs - lastHeartbeatMs >= heartbeatMs) {
        lastHeartbeatMs = nowMs
        // Best effort, and never awaited into the poll's own failure path: a registry that cannot be
        // written costs the crash group, not the fleet on screen.
        await o.touchSessions(aliveIds, nowMs).catch(() => undefined)
      }

      // The exact conversation, written down while there is still a harness to ask. Only where it
      // would CHANGE the registry, so this is one write per session and not one per poll.
      const recordConvStart = performance.now()
      let recordConvWrites = 0
      if (o.recordConversation) {
        for (const m of registry) {
          const exact = harnessSessions.byManagedId.get(m.id)?.sessionId
          if (!exact || m.conversationId === exact) continue
          recordConvWrites++
          await o.recordConversation(m.id, exact).catch(() => undefined)
        }
      }
      markFleetPhase(`poll: recordConversation x${recordConvWrites}`, recordConvStart)

      // The `/rename` name, captured WHILE there is still a harness file to read it from, so the
      // title outlives the process. Only a name a PERSON typed (`chosenName` drops the harness's own
      // invented `agentistics-77`), and only when it CHANGED — one write per rename, never per poll.
      const recordNameStart = performance.now()
      let recordNameWrites = 0
      if (o.recordHarnessName) {
        for (const m of registry) {
          const file = harnessSessions.byManagedId.get(m.id)
          const name = chosenName(file)
          if (!name || (m.harnessName === name && m.harnessNameSince === file?.nameSince)) continue
          recordNameWrites++
          await o.recordHarnessName(m.id, name, file?.nameSince).catch(() => undefined)
        }
      }
      markFleetPhase(`poll: recordHarnessName x${recordNameWrites}`, recordNameStart)

      // Decided against the BACKEND's own list rather than the reconciled statuses, because that is
      // the question: a row the backend has never heard of is one the machine took.
      const backendIds = new Set(backendSessions.map(b => b.id))
      const fell = planCrashGroup({ entries: registry, backendIds })

      const canReadProc = await procAvailable()
      const sessionHardware = new Map<string, { pid?: number; cpuPercent?: number | null; rssBytes?: number | null }>()
      const procStatStart = performance.now()
      if (canReadProc) {
        const panePids = await o.backend.listPanePids?.().catch(() => new Map<string, number>())
        for (const r of reconciled) {
          const own = harnessSessions.byManagedId.get(r.id)
          const harness = r.managed?.harness
          const cwd = r.managed?.cwd
          const liveProc = processes.find(
            p =>
              p.sessionId === r.id ||
              (Boolean(harness) &&
                Boolean(cwd) &&
                p.harness === harness &&
                (p.cwd === cwd || p.cwd.startsWith(cwd! + '/') || cwd!.startsWith(p.cwd + '/'))),
          )
          const pid = own?.pid ?? panePids?.get(r.id) ?? liveProc?.pid
          if (pid && Number.isFinite(pid) && pid > 0) {
            const currStat = await readProcStat(pid, nowMs)
            const rssBytes = await readProcRss(pid)
            let cpuPercent: number | null = null
            if (currStat) {
              const prevStat = prevProcStats.get(pid)
              cpuPercent = calculateProcCpu(prevStat, currStat)
              prevProcStats.set(pid, currStat)
            }
            sessionHardware.set(r.id, { pid, cpuPercent, rssBytes })
          }
        }
      }
      if (canReadProc) markFleetPhase(`poll: procStat+procRss x${reconciled.length} (sequential)`, procStatStart)

      // Confirm the raw readings before anything downstream sees them: the count, the sort, the bell
      // and the TUI all read `activity`, so confirming here is the one place that makes every surface
      // honest at once. A needs-you state must hold for two polls to be believed; a return to work is
      // believed immediately (see `attention-confirm.ts`). The dialog/approval frames captured above
      // are keyed to the RAW `waiting-approval` reading and only reach a row once its CONFIRMED state
      // is `waiting-approval` too — `buildSessionViews` gates them on `activity`.
      const confirm = confirmActivities(confirmMemory, activity, corroborated)
      confirmMemory = confirm.memory
      const confirmedActivity = confirm.activities

      const sessions = buildSessionViews({
        reconciled,
        activity: confirmedActivity,
        background,
        tails,
        chatTails,
        approvals,
        dialogOptions,
        processes,
        conversations,
        harnessSessions,
        sessionHardware,
        ...(fell ? { fell: new Set(fell.entries.map(e => e.id)) } : {}),
      })
      const rang = bellTransitions(prevActivity, sessions)

      prevDigest = nextDigest
      prevActivity = new Map(
        sessions
          .filter((s): s is SessionView & { activity: SessionActivity } => s.activity !== undefined)
          .map(s => [s.id, s.activity]),
      )

      const snap: SessionSnapshot = {
        sessions, attention: attentionCount(sessions), rang, polledAtMs: nowMs,
        ...(fell ? { fell } : {}),
      }
      last = snap
      return snap
    } catch (e) {
      // A failed poll keeps the previous answer and SAYS the refresh failed. Returning an empty
      // list would report every running session as gone the moment tmux hiccups.
      const message = e instanceof Error ? e.message : String(e)
      return {
        sessions: last?.sessions ?? [],
        attention: last?.attention ?? 0,
        rang: [],
        polledAtMs: nowMs,
        // Carried with the rest of the previous answer: the crash group is a fact about the same
        // sessions this snapshot is still showing, and dropping it would make the offer to reopen
        // them blink out on exactly the tick that already told the user something went wrong.
        ...(last?.fell ? { fell: last.fell } : {}),
        unavailable: `could not refresh sessions: ${message}`,
      }
    }
  }

  return { poll }
}
