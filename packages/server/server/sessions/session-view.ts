/**
 * session-view.ts — PURE. One list holding the whole fleet: the sessions agentop hosts, and the
 * assistants running beside it that it did not start.
 *
 * External processes are here because "one place to see everything" is the point of the monitor —
 * an assistant opened by hand in another terminal is exactly the one a user loses track of. They
 * are marked `external` and carry NO activity, because nothing about them is capturable: there is
 * no frame to read and no backend to ask. Rendering a state for them would be inventing one.
 */

import type { HarnessId } from '@agentistics/core'
import { closedRowId } from './row-conversation'
import { capClosedConversations } from './closed-cap'
import { matchesQuery, type SearchFields } from '@agentistics/tui/control/search-scope'
import { type HarnessProcess, sessionAtCwd } from '../live-sessions'
import { rulesFor } from './attention-rules'
import type { DialogOption } from './dialog-choice'
import { chosenName, tmuxSessionName, type HarnessSessionFile } from './harness-session-file'
import type { HarnessSessionIndex } from './harness-sessions'
import { idFromTmuxName } from './tmux-cli'
import type { RepoFacts } from './repo-facts'
import type { ReconciledSession } from './session-ref'
import type { Conversation } from './conversations'
import { conversationForProcess } from './conversations'
import type { ManagedSession, SessionActivity } from './types'
import type { ChatTurn } from './chat-tail'

/**
 * The registry's own record of when a session began, as epoch ms — PURE.
 *
 * `''` and anything unparseable yield nothing rather than 1970: a start time nobody can read is an
 * absence, and an absence rendered as "56 years ago" is worse than a blank.
 */
export function registryCreatedMs(iso: string | undefined): { createdMs?: number } {
  if (!iso) return {}
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? { createdMs: ms } : {}
}

export interface SessionView {
  id: string
  /**
   * ABSENT when it cannot be known.
   *
   * An `unregistered` row is one the backend hosts and the registry has forgotten — the harness it
   * runs is not recorded anywhere we can read. Defaulting it to `claude` would file a session under
   * a harness it may not be, in a list whose entire value is that it can be trusted.
   */
  harness?: HarnessId
  cwd: string
  /**
   * `external` — running, but agentop did not start it. `closed` — a conversation on this machine
   * that is not running at all.
   *
   * Neither can be attached to, and both can usually be REOPENED, which is what `resume` carries.
   * There is deliberately no second `managed` boolean saying the same thing as this field, which
   * could then disagree with it.
   */
  status: ReconciledSession['status'] | 'external' | 'closed'
  /** ABSENT for an external session — not capturable, so not knowable. */
  activity?: SessionActivity
  /**
   * Work is running that is NOT this session's own turn — a background subagent.
   *
   * The session still needs a person, and `activity` says so. This exists so "needs you" does not
   * read as "and nothing is happening". Absent on a `working` row, which has nothing to add, and on
   * a harness that cannot tell its own turn apart — see `backgroundWork`.
   */
  background?: boolean
  /**
   * The last few meaningful lines of this session's screen — what it is saying right now.
   *
   * Only ever present for a session agentop hosts: it comes from the frame that was captured to
   * decide the state, so it costs nothing extra, and there is no frame to read for anything else.
   */
  lastLines?: string[]
  /**
   * The last few CHAT TURNS of this session, role-tagged, read from its own JSONL transcript
   * rather than the screen — see `chat-tail.ts`.
   *
   * Claude only: it is the one harness with an exact live-session -> conversation-id link, which
   * is what makes trusting the transcript's own `role` field safe rather than a guess. Absent for
   * every other harness (and for a Claude row whose transcript could not be resolved yet), in
   * which case the detail pane falls back to `lastLines` exactly as it always has.
   */
  chatTurns?: ChatTurn[]
  /**
   * The BOTTOM of the screen verbatim, present only while this session is blocked on a dialog.
   *
   * A different reading of the same frame from `lastLines`, and it has to be: `frameTail` cuts the
   * input box and the status strip off, which for a session sitting on a dialog cuts the dialog off.
   * This is what the person answering actually needs to read — the options, which one is highlighted
   * and the footer naming the key — because the keystroke that answers cannot know which option it
   * is taking. See `approval-spec.ts` and `approvalTail`.
   */
  approvalLines?: string[]
  /**
   * The OPTIONS that dialog is offering, when they could be read with confidence.
   *
   * Present only alongside `approvalLines`, and empty rather than invented when the screen cannot be
   * parsed — see `dialog-choice.ts`. It is what makes answering a four-way question possible at all:
   * a keystroke that confirms the highlighted row is choosing on the user's behalf.
   */
  dialogOptions?: DialogOption[]
  /**
   * This session was taken by the machine along with the others, and is offered back with them.
   *
   * Decided by `crash-group.ts` over the whole registry, so it cannot be derived from this row: the
   * question "did these fall together" is about a set, and a per-row rule could only ever guess.
   */
  fell?: boolean
  label?: string
  /** When `label` was written, epoch ms — the recency side of the title contest. */
  labelSince?: number
  /**
   * The name the user gave this session FROM INSIDE IT, and when.
   *
   * Read from what the harness records about its own live sessions (`harness-sessions.ts`), matched
   * EXACTLY — by the tmux session for a row we host, by pid for one we merely observed. A name the
   * harness invented for itself is not carried here at all: `chosenName` drops it, because a
   * generated `agentistics-77` replacing a label somebody typed is the "reopen renamed the row back"
   * bug in a new costume.
   */
  harnessName?: string
  harnessNameSince?: number
  note?: string
  model?: string
  effort?: string
  /** The piece of work this session belongs to, when the user said. Groups the list. */
  task?: string
  /**
   * The harness's own conversation id this row drives, when it is known EXACTLY.
   *
   * Carried from `ManagedSession.conversationId`, so it is present only for a session that was
   * reopened from a conversation — we handed the id to the CLI, so there is nothing to guess. It is
   * deliberately NOT filled from the harness+directory inference behind `resume`: that guess is
   * good enough to offer a verb the user confirms by title, and not good enough to be the key the
   * event channel deduplicates on. Absent is absent.
   */
  conversationId?: string
  /** The OS process ID for a managed running session, where known. */
  pid?: number
  /** Process CPU percentage sampled over poller interval (null if unmeasurable/unavailable). */
  cpuPercent?: number | null
  /** Resident Set Size memory in bytes (null if unmeasurable/unavailable). */
  rssBytes?: number | null
  /**
   * The repository this row's directory was in when the session STARTED, as the registry recorded
   * it — carried so the caller that resolves `repo-facts.ts` can hand it over.
   *
   * It is here rather than resolved here because resolving means running git, and this module is
   * pure. Present only on a managed row written by a build that records it; `resolveRepoFacts`
   * treats absence as "nothing recorded", never as "no repository".
   */
  recordedRepo?: RepoFacts
  createdMs?: number
  /**
   * When this row went OFF, in ms — what "off for how long" is read from, and what orders a block
   * of finished conversations.
   *
   * A different fact from `createdMs`: `started` answers when the work began, and nineteen finished
   * rows are read by which of them ENDED. Three sources, most exact first, and no invention beyond
   * them — see where it is filled.
   */
  endedMs?: number
  attached: boolean
  /**
   * The conversation this row could REOPEN, when there is one.
   *
   * Present on an `external` row (the conversation it appears to be driving) and on a `closed` one
   * (itself). Absent when the harness cannot reopen by id — gemini takes "latest" or an index, never
   * an id — so the verb is simply not offered rather than offered and wrong.
   */
  resume?: { sessionId: string; title: string }
  /** Metrics of the conversation behind this row, when it has any. Absent is never zero. */
  tokens?: number
  costUSD?: number
  /** How full the context window was on the last turn, and out of how much. Both or neither. */
  contextTokens?: number
  contextWindow?: number
  /**
   * Whether this harness has probed approval rules at all.
   *
   * False means a session blocked on a permission prompt reads as plain `waiting` — still counted,
   * still surfaced, but the reason cannot be shown. The UI says so; this flag is where it learns it.
   */
  approvalDetection: boolean
  /**
   * Everything about this row worth searching, KEPT APART BY WHAT IT IS.
   *
   * Composed HERE so the search reaches a closed conversation's OPENING PROMPT — which is what a
   * person actually remembers about something they closed ("the one where I asked about the
   * migration") — without the screen having to hold conversation text it never renders.
   *
   * It used to be one lowercased blob (`searchText`) tested with `.includes()`. That found the row
   * and then could not say why it was there: a query matched the folder, the harness, the note or
   * the prompt indistinguishably, so the reader had to open the session to learn which. Separate
   * fields cost nothing at the predicate — `matchScopes` still walks them all — and are what let
   * the screen print the scope beside each row and count the depth in the header.
   */
  searchFields: SearchFields
}

export function needsAttention(a?: SessionActivity): boolean {
  return a === 'waiting' || a === 'waiting-approval'
}

/** Sort key: what is waiting on a person first, then what is running, then what is finished, then
 *  the rows nothing can be done about. */
const RANK: Record<string, number> = {
  'waiting-approval': 0,
  waiting: 1,
  working: 2,
  exited: 3,
}

function rankOf(v: SessionView): number {
  // Closed conversations sit below everything running: they are history, and history must never
  // push a session that is waiting on someone further down the screen.
  if (v.status === 'closed') return 6
  if (v.status === 'external') return 5
  return RANK[v.activity ?? ''] ?? 4
}

/**
 * Collapse a session's RETIRED predecessors against its own continuation — PURE, and keyed on the
 * one thing that is an identity rather than a guess: the harness's `conversationId`.
 *
 * ## Why this exists
 *
 * A session's durable identity is its CONVERSATION, but the registry keys a record by the per-spawn
 * `managedId`. Every attach / reopen / restart mints a NEW managedId for the SAME conversation and
 * retires the old record (`endedAt`) without removing it — so `reconcileSessions` returns one record
 * per spawn and `buildSessionViews` draws one row per record. A conversation reopened five times
 * therefore stood on screen as five `exited` rows beside its one live continuation, all wearing the
 * same name. Measured here: 18 conversations held more than one record, 36 rows of pure history that
 * a person reads as "this session is open many times over".
 *
 * ## What it may and may NOT drop — the guarantee
 *
 * The coordinator reads this list to decide whether to re-dispatch over work in flight, so a row it
 * cannot prove is dead is NEVER hidden. A row is dropped only when BOTH hold:
 *
 *  1. it is PROVABLY dead — `endedMs` is set, which means the system retired or the user finished it;
 *     a `lost` row with no end time (a reboot, say) is never touched, because "the backend cannot see
 *     it right now" is not proof the process is gone; and
 *  2. it is SUPERSEDED — the same conversation has either a LIVE row (running / unregistered) or a
 *     strictly newer ended row. That sibling IS this session, continued, so the predecessor is its
 *     own history, not a second session.
 *
 * Consequences, each deliberate:
 *  - a LIVE row is never dropped (it has no `endedMs`);
 *  - the newest ended row of a conversation with nothing live is KEPT — it is the reopenable
 *    representative, and a finished session the user wants back must still be there;
 *  - rows with NO `conversationId` are never grouped and never collapsed: two sessions that merely
 *    share a directory or a label are genuinely distinct, and the list telling the truth about them
 *    is the whole point — the fix is identity, never appearance.
 *
 * Two rows with the SAME `conversationId` cannot be distinct sessions: it is the harness's own id for
 * one conversation. So this never merges two real sessions — only a session with its own past lives.
 */
export function collapseSupersededSessions(managed: readonly SessionView[]): SessionView[] {
  const groups = new Map<string, SessionView[]>()
  for (const v of managed) {
    if (!v.conversationId) continue
    const arr = groups.get(v.conversationId) ?? []
    arr.push(v)
    groups.set(v.conversationId, arr)
  }

  const drop = new Set<string>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const hasLive = group.some(v => v.status === 'running' || v.status === 'unregistered')
    // The reopenable representative when nothing is live: the newest by start time, id as a
    // deterministic tiebreak so the same fleet always keeps the same row.
    const newest = group.reduce((a, b) => {
      const am = a.createdMs ?? -Infinity
      const bm = b.createdMs ?? -Infinity
      if (bm !== am) return bm > am ? b : a
      return b.id > a.id ? b : a
    })
    for (const v of group) {
      // Rule 1: only a row proven ended may go. A live row (no `endedMs`) and a `lost` row with no
      // recorded end are both kept, whatever else the group holds.
      if (v.endedMs === undefined) continue
      // Rule 2: dropped only when a continuation supersedes it — anything live retires every dead
      // predecessor; otherwise all but the newest ended row.
      if (hasLive || v !== newest) drop.add(v.id)
    }
  }

  return managed.filter(v => !drop.has(v.id))
}

/**
 * An id for an external process that is STABLE across polls and unique per process.
 *
 * The start time is what does both jobs: it distinguishes two assistants of the same harness open
 * in one directory (harness + cwd alone would collapse them into a single row), and unlike a list
 * index it does not change when an unrelated process appears or exits.
 */
export function externalId(p: HarnessProcess): string {
  return `external:${p.harness}:${p.cwd}:${p.startedMs ?? 0}`
}

/**
 * The managed row a running process PROVES it belongs to, or `undefined` — PURE.
 *
 * The one identity claim in this file that is not an inference. A harness records the tmux session
 * it is running inside, and for a session agentop started that is `agentop-<our id>`; the process
 * is therefore naming our row itself. Nothing it does afterwards — `cd`, a worktree, `/add-dir` —
 * can invalidate it, which is exactly what a directory comparison cannot say.
 *
 * `undefined` means NO CLAIM, not "no row": a tmux session that is not ours, a harness that writes
 * no record, a claude too old to carry the field. The caller then falls back to the directory
 * guess, which is all there ever was.
 *
 * Looked up by pid first (the key a scanned process arrives with) and then by conversation id (the
 * key a process synthesised from a record arrives with) — the same order, and the same reason, as
 * the name lookup below it.
 */
export function managedIdOfProcess(
  p: Pick<HarnessProcess, 'pid' | 'sessionId'>,
  index: HarnessSessionIndex | undefined,
): string | undefined {
  const file = (p.pid !== undefined ? index?.byPid.get(p.pid) : undefined)
    ?? (p.sessionId ? index?.byConversation.get(p.sessionId) : undefined)
  const tmux = tmuxSessionName(file)
  return (tmux ? idFromTmuxName(tmux) : null) ?? undefined
}

/** One searchable dimension, from whatever parts of a row carry it. */
function scopeText(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/**
 * The rows matching what was typed — PURE, and the same predicate for every kind of row.
 *
 * One function rather than a filter per status: a search that quietly skipped closed conversations
 * would be a search that cannot find the thing it was most likely opened to find.
 *
 * `transcriptHits` is the set of conversations whose TEXT carries the query, resolved separately
 * against the disk (`transcript-run.ts`) because no row holds its own conversation. Omitted, the
 * search is exactly what it always was — the transcript scope simply never matches.
 */
export function filterSessions(
  views: readonly SessionView[],
  query: string,
  transcriptHits?: ReadonlySet<string>,
): SessionView[] {
  if (query.trim() === '') return [...views]
  return views.filter(v => matchesQuery(v.searchFields, query, {
    transcript: hasTranscriptHit(v, transcriptHits),
  }))
}

/**
 * Whether the transcript search named THIS row's conversation.
 *
 * Only an EXACT link counts. A row knows its conversation when the registry recorded the id at
 * spawn or the harness's own file names our tmux session; where it does not, the fleet's fallback
 * is a harness-and-directory inference, and accepting that here would mark every session in one
 * worktree as matching because a sibling's transcript happened to contain the word.
 */
function hasTranscriptHit(v: SessionView, hits?: ReadonlySet<string>): boolean {
  if (!hits || hits.size === 0) return false
  return (v.conversationId !== undefined && hits.has(v.conversationId))
    || (v.resume !== undefined && hits.has(v.resume.sessionId))
}

/** The cap on closed (reopenable) conversations offered as rows. See the note at the slice. */
export const DEFAULT_CLOSED_LIMIT = 300

export function buildSessionViews(o: {
  reconciled: readonly ReconciledSession[]
  activity: ReadonlyMap<string, SessionActivity>
  /**
   * Rows with work running that is NOT their own turn — a background subagent, a watcher.
   *
   * The STATE still says the session needs a person, because it does. This is the mark beside it,
   * so "needs you" does not read as "and nothing is happening". See `backgroundWork`.
   */
  background?: ReadonlySet<string>
  /** The tail of each hosted session's screen, keyed by session id. */
  tails?: ReadonlyMap<string, string[]>
  /** Role-tagged chat turns, keyed by session id — see `SessionView.chatTurns`. */
  chatTails?: ReadonlyMap<string, ChatTurn[]>
  /** The DIALOG a blocked session is showing, keyed by session id — see `SessionView.approvalLines`. */
  approvals?: ReadonlyMap<string, string[]>
  /** The options that dialog offers, keyed by session id. Absent where they could not be read. */
  dialogOptions?: ReadonlyMap<string, DialogOption[]>
  /** The ids `crash-group.ts` decided fell together. A set, because the question is about a set. */
  fell?: ReadonlySet<string>
  /**
   * What each harness records about its OWN live sessions, indexed by the two exact keys — the tmux
   * session a managed row runs in, and the pid of a process found on the host.
   *
   * It is what makes this the one correlation in this file that is not a guess: a row matched here
   * knows its conversation id exactly, so `claimResume` never has to fall back to "some conversation
   * in this directory" — the fallback that once reopened three rows onto one conversation.
   */
  harnessSessions?: HarnessSessionIndex
  processes: readonly HarnessProcess[]
  /** Everything this machine has ever recorded, newest first. Used to name what an external process
   *  is driving, and to offer the conversations that are not running at all. */
  conversations?: readonly Conversation[]
  /**
   * How many closed conversations to offer.
   *
   * Small on purpose. A machine with hundreds of them must not drown the handful that are actually
   * running — the list is for what is happening, and SEARCH is how an older conversation is found.
   * Forty made the closed block longer than everything else on the screen put together.
   */
  closedLimit?: number
  /** Hardware metrics for managed sessions, keyed by managed session ID. */
  sessionHardware?: ReadonlyMap<string, { pid?: number; cpuPercent?: number | null; rssBytes?: number | null }>
}): SessionView[] {
  /**
   * Conversations already spoken for, so ONE is never offered to two rows.
   *
   * `conversationForProcess` matches on harness and directory, which is all it can do for a process
   * it did not start — and every managed session in one directory therefore resolved to the SAME
   * conversation. After a crash left five rows `lost` in this repository, reopening them handed
   * three of them the same conversation and the fleet came back with one session listed three
   * times, all wearing the same name. Reported from a real machine.
   *
   * A row that RECORDED which conversation it drives is exact and claims that one. The rest fall
   * back to the directory guess, but only to a conversation nobody has taken.
   */
  const claimed = new Set<string>()
  const claimResume = (
    managed: ManagedSession | undefined,
    harness: HarnessId,
    /**
     * The conversation the HARNESS ITSELF says this row is driving.
     *
     * Outranks the registry's own record and the directory guess alike, because it is the only one
     * of the three that is a fact rather than a recollection or an inference: the harness wrote it
     * about the session it is running, and the row was matched to it by tmux session or by pid.
     */
    exactId?: string,
  ): { resume?: { sessionId: string; title: string } } => {
    const pool = o.conversations ?? []
    const knownId = exactId ?? managed?.conversationId
    const own = knownId ? pool.find(c => c.sessionId === knownId) : undefined
    // A row that KNOWS which conversation it drives never falls back to the guess — not even when
    // the store does not hold that conversation yet. Since the id is recorded at SPAWN (not only at
    // reopen), that gap is now ordinary: a session minutes old has an id and no transcript written
    // under it. "Not yet" and "some other conversation in this directory" are not the same answer,
    // and taking the second is the guess that handed three rows one conversation after a crash.
    if (knownId) {
      if (!own?.resumable) return {}
      claimed.add(own.sessionId)
      return { resume: { sessionId: own.sessionId, title: own.title } }
    }
    const conv = pool.find(c =>
      !claimed.has(c.sessionId)
      && c.harness === harness
      && sessionAtCwd({ current_cwd: c.cwd, project_path: c.cwd }, managed?.cwd ?? ''))
    if (!conv?.resumable) return {}
    claimed.add(conv.sessionId)
    return { resume: { sessionId: conv.sessionId, title: conv.title } }
  }

  /**
   * The conversation a RUNNING managed row is driving, for its metrics — a read, never a claim.
   *
   * Separate from `claimResume` on purpose. That one hands out a REOPEN target and must give each
   * conversation to at most one row, or a crash that left five rows in one directory offers the
   * same conversation five times. This one only wants numbers, and numbers are not scarce: two rows
   * reading the same conversation is a display question, while a row silently losing its metrics to
   * whichever row was mapped first is a wrong answer.
   *
   * Only the EXACT links are used — the harness's own record (`~/.claude/sessions/<pid>.json`,
   * matched by tmux session name) and the id the registry stored while the session was up. The
   * harness-and-directory inference `claimResume` falls back to is deliberately not accepted here:
   * for a reopen it is offered to a person who can recognise the title and decline, whereas a
   * context gauge is read at a glance and believed. Two sessions in one worktree would otherwise
   * both wear the older one's fill level with nothing on screen saying so.
   */
  const metricsOf = (
    managed: ManagedSession | undefined,
    exactId?: string,
  ): Conversation | undefined => {
    const pool = o.conversations ?? []
    const id = exactId ?? managed?.conversationId
    return id ? pool.find(c => c.sessionId === id) : undefined
  }

  const managed: SessionView[] = o.reconciled.map(r => {
    const harness = r.managed?.harness
    // What the harness says about ITSELF, matched by the tmux session it recorded — the one exact
    // link between its record and this row.
    const own: HarnessSessionFile | undefined = o.harnessSessions?.byManagedId.get(r.id)
    // The live harness file when there is one, ELSE the name the poller persisted while there was.
    // Claude deletes `~/.claude/sessions/<pid>.json` the instant the process ends, so a finished
    // session's `/rename` name lives only in the registry copy — without this fallback the title
    // flipped to a different source on finish and `CTRL+F` stopped finding the row by the name it
    // wore a second earlier. A title is an identity; it must not change because the process died.
    const ownName = chosenName(own) ?? r.managed?.harnessName
    // The recency stamp travels with whichever name won: the live file's `nameSince` while alive,
    // the persisted mirror once it is gone. `pickTitle` then settles the label-vs-harness contest
    // identically in both states.
    const ownNameSince = own?.nameSince ?? r.managed?.harnessNameSince
    // A session the user FINISHED reports `exited` whatever the backend still holds: the row exists
    // to be reopened, and calling it `running` because a dead tmux pane lingers would put it back
    // among the things you can talk to.
    const finished = Boolean(r.managed?.endedAt)
    const activity = finished ? ('exited' as const) : o.activity.get(r.id)
    // A managed row carried no metrics at all until now — `external` and `closed` rows read them
    // from the store and this one did not, so on a machine whose whole fleet is agentop-started
    // (the normal case once the session manager is in use) the usage column was empty everywhere.
    const conv = metricsOf(r.managed, own?.sessionId)
    return {
      id: r.id,
      ...(harness ? { harness } : {}),
      cwd: r.managed?.cwd ?? '',
      status: finished ? ('exited' as const) : r.status,
      ...(activity ? { activity } : {}),
      // Only where it ADDS something: a row that is already `working` has nothing to mark, and a
      // finished one has nothing running.
      ...(!finished && activity !== 'working' && o.background?.has(r.id) ? { background: true } : {}),
      ...((o.tails?.get(r.id)?.length ?? 0) > 0 ? { lastLines: o.tails!.get(r.id)! } : {}),
      ...((o.chatTails?.get(r.id)?.length ?? 0) > 0 ? { chatTurns: o.chatTails!.get(r.id)! } : {}),
      // Only while it is genuinely asking. A dialog frame carried on a row that has moved on would
      // be shown under "what you are about to confirm" for a question that is no longer open.
      ...(activity === 'waiting-approval' && (o.approvals?.get(r.id)?.length ?? 0) > 0
        ? { approvalLines: o.approvals!.get(r.id)! }
        : {}),
      ...(activity === 'waiting-approval' && (o.dialogOptions?.get(r.id)?.length ?? 0) > 0
        ? { dialogOptions: o.dialogOptions!.get(r.id)! }
        : {}),
      ...(o.fell?.has(r.id) ? { fell: true as const } : {}),
      ...(r.managed?.label ? { label: r.managed.label } : {}),
      ...(r.managed?.labelSince !== undefined ? { labelSince: r.managed.labelSince } : {}),
      ...(ownName ? { harnessName: ownName } : {}),
      ...(ownName && ownNameSince !== undefined ? { harnessNameSince: ownNameSince } : {}),
      ...(r.managed?.note ? { note: r.managed.note } : {}),
      ...(r.managed?.model ? { model: r.managed.model } : {}),
      ...(r.managed?.effort ? { effort: r.managed.effort } : {}),
      ...(r.managed?.task ? { task: r.managed.task } : {}),
      ...(r.managed?.conversationId ? { conversationId: r.managed.conversationId } : {}),
      ...(r.managed?.repo ? { recordedRepo: r.managed.repo } : {}),
      // The backend's clock when there is a backend, the REGISTRY's when there is not. A row the
      // machine lost has no tmux session left to ask, so it reported no start time at all — and a
      // session you are deciding whether to reopen is one whose age is most of the decision.
      ...(r.backend
        ? { createdMs: r.backend.createdMs }
        : registryCreatedMs(r.managed?.createdAt)),
      // Most exact first: the end the registry RECORDED, then the backend's last activity on a row
      // that is over, and finally the last HEARTBEAT stamp. That last one is what covers a REBOOT,
      // which is the ordinary way to get a `lost` row: nothing writes a record when the machine goes
      // down, so the last time the poller saw the session alive is the only end time that exists.
      ...(r.managed?.endedAt && Number.isFinite(Date.parse(r.managed.endedAt))
        ? { endedMs: Date.parse(r.managed.endedAt) }
        : r.backend?.lastActivityMs && (finished || r.status === 'exited' || r.status === 'lost')
          ? { endedMs: r.backend.lastActivityMs }
          : r.status !== 'running' && typeof r.managed?.lastSeenMs === 'number'
            ? { endedMs: r.managed.lastSeenMs }
            : {}),
      // Reopening a finished session is the whole reason its row is kept. Resolved the same way an
      // external process's conversation is — by harness and directory — and absent when nothing
      // can be resolved, rather than offering a verb with no target.
      // Reopening is offered for ANY managed row that is not running — one you finished, one whose
      // command exited, and one the backend no longer has at all. That last case is a REBOOT: tmux
      // is gone, every managed session is `lost`, and without this the sessions you were in the
      // middle of came back as rows with no verb on them. Resolved the same way an external
      // process's conversation is, and absent when nothing resolves rather than offering a verb
      // with no target.
      ...((finished || r.status === 'lost' || r.status === 'exited') && harness
        // `own?.sessionId` is only ever present for a row still ALIVE — the harness deletes its
        // record when the process goes — so on a `lost` row this is `undefined` and the registry's
        // own `conversationId` decides, exactly as before. That is not a gap: the id was recorded
        // into the registry while the session was up, by the branch below.
        ? claimResume(r.managed, harness, own?.sessionId)
        : {}),
      ...(conv?.tokens !== undefined ? { tokens: conv.tokens } : {}),
      ...(conv?.costUSD !== undefined ? { costUSD: conv.costUSD } : {}),
      ...(conv?.contextTokens !== undefined && conv.contextWindow !== undefined
        ? { contextTokens: conv.contextTokens, contextWindow: conv.contextWindow }
        : {}),
      ...(o.sessionHardware?.get(r.id)
        ? {
            pid: o.sessionHardware.get(r.id)!.pid,
            cpuPercent: o.sessionHardware.get(r.id)!.cpuPercent,
            rssBytes: o.sessionHardware.get(r.id)!.rssBytes,
          }
        : {}),
      attached: r.backend?.attached ?? false,
      approvalDetection: harness !== undefined && rulesFor(harness) !== undefined,
      // The harness's own name is searchable too: it is the name the person reading this screen may
      // well be the only one they remember, having typed it inside the session.
      searchFields: {
        name: scopeText(r.managed?.label, ownName),
        folder: scopeText(r.managed?.cwd),
        harness: scopeText(harness),
        note: scopeText(r.managed?.note),
        task: scopeText(r.managed?.task),
        prompt: '',
      },
    }
  })

  // An assistant already accounted for by a managed row must not appear twice.
  //
  // ## A DIRECTORY IS NOT AN IDENTITY
  //
  // This was harness-and-directory alone, so a session that CHANGED DIRECTORY stopped matching the
  // row hosting it and was drawn a second time as `external`. Measured on this machine: one claude,
  // started by agentop in the repo root, entered a worktree — its kernel cwd moved to
  // `.claude/worktrees/token-truth` while the managed row kept the directory it was spawned in, and
  // the fleet showed one conversation twice, `working` on the row and `external` beside it. Its own
  // record read `"cwd":"…/worktrees/token-truth","tmux":"agentop-e3e4fc2ce6"` — naming the very row
  // it was being listed apart from. Any `cd`, `/add-dir` or worktree reproduces it, and the
  // duplicate is not cosmetic: the external twin offers REOPEN, which would put a second assistant
  // on one transcript.
  //
  // So the EXACT link is asked first. `identifiesManagedRow` reads the tmux session the harness
  // wrote about ITSELF — `agentop-<our id>` for a session we started — which is a fact the process
  // stated, immune to whatever it does with its working directory afterwards. `status` is
  // deliberately not consulted on that path: the link is proof that this process IS that row, and a
  // row reconciled to `lost` while its process is demonstrably alive is a reconciliation fault to
  // be shown as one, never a licence to draw the session twice.
  //
  // The directory guess still answers everything the link cannot — another harness, a tmux session
  // that is not ours, a claude too old to write the field. There:
  //  - a row whose harness is unknown covers NOTHING: it might be that process or might not, and
  //    silently swallowing an external session on a maybe is the worse of the two errors — a
  //    duplicate row is visible and self-correcting, a missing one is not;
  //  - only a row that is actually RUNNING can account for a running process. `!== 'lost'` was too
  //    wide: an `exited` row accounts for a process that is GONE, and letting it cover swallows a
  //    live session that happens to share its directory. Measured — three exited rows sat in the
  //    worktree of a background agent that was alive, and the agent was hidden behind them and
  //    listed as a closed conversation instead.
  const covered = (p: HarnessProcess): boolean => {
    const exact = managedIdOfProcess(p, o.harnessSessions)
    if (exact !== undefined) return managed.some(m => m.id === exact)
    return managed.some(m =>
      m.harness === p.harness &&
      (m.status === 'running' || m.status === 'unregistered') &&
      sessionAtCwd({ current_cwd: m.cwd, project_path: m.cwd }, p.cwd))
  }

  const conversations = o.conversations ?? []

  /**
   * Sessions the harness's OWN records prove are running, which the `/proc` scan did not report.
   *
   * Synthesised as processes rather than special-cased downstream, deliberately: they then travel
   * the very same `external` path as a scanned one and inherit every rule already written there —
   * the `covered` de-duplication, the exact-name lookup, the resume target, the tokens and the
   * context gauge. A parallel branch would be a second set of rules for one kind of row.
   *
   * Two things had to be true before this was sound, and both now are: the record carries
   * `procStart`, so `alive` is a fact about THIS process and not about whoever inherited its pid;
   * and `alive` is `undefined` wherever nobody could tell, so a machine with no `/proc` synthesises
   * nothing and behaves exactly as it did.
   *
   * This is what stops a live session being listed as `closed`. Measured: a background agent alive
   * for 38 minutes — no tmux, missed by the scan — sat in the closed block under a title from
   * another week, offering to "reopen" a conversation that had never stopped.
   */
  const scannedPids = new Set(o.processes.map(p => p.pid).filter((v): v is number => v !== undefined))
  const fromRecords: HarnessProcess[] = [...(o.harnessSessions?.byConversation.values() ?? [])]
    .filter(f => f.alive === true && f.pid !== undefined && !scannedPids.has(f.pid)
      && f.cwd !== undefined && f.harness !== undefined)
    .map(f => ({
      harness: f.harness!,
      cwd: f.cwd!,
      pid: f.pid!,
      ...(f.sessionId ? { sessionId: f.sessionId } : {}),
    }))

  const external: SessionView[] = [...o.processes, ...fromRecords].filter(p => !covered(p)).map(p => {
    // What the harness says about ITSELF, keyed on the pid `/proc` reported. Exact where every other
    // reading of an external process is an inference from its directory.
    // By pid first — that is the key a SCANNED process arrives with. Falling back to the
    // conversation removes a hidden coupling rather than papering over one: a row synthesised from
    // a record already knows the conversation exactly, and making its name depend on a second
    // lookup succeeding would leave it correctly listed and anonymously labelled.
    const own = (p.pid !== undefined ? o.harnessSessions?.byPid.get(p.pid) : undefined)
      ?? (p.sessionId ? o.harnessSessions?.byConversation.get(p.sessionId) : undefined)
    const ownName = chosenName(own)
    // What this process appears to be driving. The harness's own `sessionId` outranks the argv one
    // and the directory guess alike: it is what the process is writing to, said by the process.
    const conv = conversationForProcess(conversations, {
      harness: p.harness,
      cwd: p.cwd,
      ...(own?.sessionId ?? p.sessionId ? { namedId: own?.sessionId ?? p.sessionId! } : {}),
    })
    return {
      id: externalId(p),
      harness: p.harness,
      cwd: p.cwd,
      status: 'external' as const,
      ...(ownName ? { harnessName: ownName } : {}),
      ...(ownName && own?.nameSince !== undefined ? { harnessNameSince: own.nameSince } : {}),
      ...(p.startedMs !== undefined ? { createdMs: p.startedMs } : {}),
      attached: false,
      approvalDetection: false,
      ...(conv?.resumable ? { resume: { sessionId: conv.sessionId, title: conv.title } } : {}),
      ...(conv?.tokens !== undefined ? { tokens: conv.tokens } : {}),
      ...(conv?.costUSD !== undefined ? { costUSD: conv.costUSD } : {}),
      ...(conv?.contextTokens !== undefined && conv.contextWindow !== undefined
        ? { contextTokens: conv.contextTokens, contextWindow: conv.contextWindow }
        : {}),
      searchFields: {
        name: scopeText(ownName, conv?.title),
        folder: scopeText(p.cwd),
        harness: scopeText(p.harness),
        note: '',
        task: '',
        prompt: scopeText(conv?.firstPrompt),
      },
    }
  })

  // Conversations that are not running at all — the ones you closed and want back. They are the
  // reason this screen can answer "what was I doing yesterday" as well as "what is running now".
  //
  // A conversation ALREADY on screen must not appear a second time as history, and it was: only the
  // external rows were excluded, so a session agentop is running right now was listed once as
  // `working` and again as `closed` — the same title, the same directory, twice. Every LIVE row
  // covers its conversation, whether that row is one we host or one we merely observed.
  const shown = new Set<string>()
  for (const v of external) if (v.resume) shown.add(v.resume.sessionId)
  //
  // A row that RECORDED its conversation covers exactly that one. The rest fall back to the
  // harness+directory inference, and it is CLAIMED — because that inference answers with the FIRST
  // conversation in the directory, so four live sessions in one repository all covered the same
  // one. The other three stayed in history as `closed` rows for conversations that were open, and
  // whichever conversation happened to be first vanished from history while it was the one nobody
  // was running. "Some sessions do not appear" and "some appear twice" were the same bug, seen
  // from its two ends.
  const coveredConv = new Set<string>()
  for (const r of o.reconciled) {
    const m = managed.find(v => v.id === r.id)
    // `exited` and `lost` rows cover nothing: their work IS over, and the conversation belongs in
    // history where it can be reopened.
    if (!m || (m.status !== 'running' && m.status !== 'unregistered')) continue
    const own = r.managed?.conversationId
    if (own) { shown.add(own); coveredConv.add(own); continue }
    if (!m.harness) continue
    const conv = conversations.find(c =>
      !coveredConv.has(c.sessionId)
      && c.harness === m.harness
      && sessionAtCwd({ current_cwd: c.cwd, project_path: c.cwd }, m.cwd))
    if (conv) { shown.add(conv.sessionId); coveredConv.add(conv.sessionId) }
  }

  // How many CLOSED conversations become rows.
  //
  // It was a hard `12` that no caller ever overrode, so a machine with 544 consolidated
  // conversations offered twelve of them and said nothing about the other 532 — reported as "it is
  // not listing all my sessions, the list is not complete". The number was right for the terminal
  // cockpit, whose pane holds a couple of dozen rows; it is arbitrary in a scrolling sidebar that
  // also has a search field, where the whole point of history is finding something old.
  //
  // Raising it is CHEAP and that is why it is safe: `loadConversations()` has already read and
  // sorted every one of them by the time this runs, so the slice only decides how many get mapped.
  // It stays bounded rather than unbounded — several hundred rows is a list a person scrolls, a few
  // thousand is one a browser renders slowly for no one's benefit — and `closedTotal` below reports
  // what the bound withheld, so a capped list can say so instead of looking complete.
  //
  // The cap is applied by `capClosedConversations`, not by a slice: a plain recency cut deletes
  // whole HARNESSES on a machine where one of them dominates (measured: the newest 300 here were
  // 296 claude, and antigravity, kimi and gemini began at ranks 311, 379 and 575). A list that says
  // a harness has no sessions is not a truncated list, it is a wrong one — and the harness FILTER
  // is built from these rows, so it offered three options while the dashboard offered six.
  const closedCandidates = conversations.filter(c => !shown.has(c.sessionId))
  const closed: SessionView[] = capClosedConversations(
    closedCandidates, o.closedLimit ?? DEFAULT_CLOSED_LIMIT,
  )
    .map(c => {
      /**
       * The name the SESSION gave itself, when its own record can be found by conversation id.
       *
       * `c.title` comes from the conversation store, which is written from the transcript and can be
       * days older than a `/rename`. Measured: a session renamed to `MAIN` was listed here under
       * `Build agentop harness cockpit with session management` — a title from a different week.
       *
       * This is the one lookup that needs nothing else to be true. `byManagedId` requires the
       * session to have been started under tmux and `byPid` requires the `/proc` scan to have
       * surfaced it; a background agent satisfies neither, and was therefore shown under whatever
       * the store last recorded with no way to correct it.
       *
       * `chosenName` still rejects a `derived` name, so a harness-invented `agentistics-84` never
       * displaces a real title.
       */
      const own = o.harnessSessions?.byConversation.get(c.sessionId)
      const named = chosenName(own)
      return {
      id: closedRowId(c.sessionId),
      harness: c.harness,
      cwd: c.cwd,
      status: 'closed' as const,
      label: named ?? c.title,
      createdMs: c.lastActivityMs,
      endedMs: c.lastActivityMs,
      attached: false,
      approvalDetection: false,
      ...(c.resumable ? { resume: { sessionId: c.sessionId, title: c.title } } : {}),
      ...(c.tokens !== undefined ? { tokens: c.tokens } : {}),
      ...(c.costUSD !== undefined ? { costUSD: c.costUSD } : {}),
      ...(c.contextTokens !== undefined && c.contextWindow !== undefined
        ? { contextTokens: c.contextTokens, contextWindow: c.contextWindow }
        : {}),
      // BOTH names are searchable, or the row is displayed under a name that cannot be used to
      // find it — which is the complaint arriving by the other door. They share the `name` scope:
      // which of the two the user typed is not a distinction worth reporting, and the row already
      // says which place the name it is SHOWING came from.
      searchFields: {
        name: scopeText(named, named !== c.title ? c.title : undefined),
        folder: scopeText(c.cwd),
        harness: scopeText(c.harness),
        note: '',
        task: '',
        prompt: scopeText(c.firstPrompt),
      },
      }
    })

  // Retired predecessors are dropped LAST, so everything above — the external-twin dedup and the
  // closed-history cover set — still reasons over the full managed list. Only the final rows the
  // reader sees lose the superseded duplicates; the registry itself is untouched.
  return [...collapseSupersededSessions(managed), ...external, ...closed].sort((a, b) => {
    const byRank = rankOf(a) - rankOf(b)
    if (byRank !== 0) return byRank
    return (b.createdMs ?? 0) - (a.createdMs ?? 0)
  })
}

export function attentionCount(views: readonly SessionView[]): number {
  return views.filter(v => needsAttention(v.activity)).length
}

/**
 * The ids that JUST entered a state needing an answer — what the caller rings the bell for.
 *
 * A transition rather than a level, so a session sitting on a question for ten minutes does not
 * beep every five seconds. Escalating from `waiting` to `waiting-approval` counts as a transition:
 * it is a different urgency, and the bell is the only signal this design ships.
 */
export function bellTransitions(
  prev: ReadonlyMap<string, SessionActivity>,
  next: readonly SessionView[],
): string[] {
  const out: string[] = []
  for (const v of next) {
    if (!needsAttention(v.activity)) continue
    const before = prev.get(v.id)
    if (before === v.activity) continue
    out.push(v.id)
  }
  return out
}
