/**
 * cli-session.ts — the `agentop session …` handlers.
 *
 * Every decision is already made by a pure module: `parseSessionArgs` says what was asked,
 * `planSpawn` says what to run, `resolveSessionRef` says which session was meant, and
 * `reconcileSessions` says what exists. This file does I/O and prints.
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { HARNESS_ORDER, type HarnessId } from '@agentistics/core'
// `GROUPINGS` and never a list typed into the usage text: the help is the only place a person can
// read what `--group` accepts, and a second copy of that list drifts silently — the CLI would go on
// accepting an arrangement its own help says nothing about. Same rule `cli-parse.ts` already applies
// to its error message.
import { GROUPINGS, sessionRunning } from '@agentistics/tui/control/sessions'
import { controlStrings, sessionWordBook } from '@agentistics/tui/control/i18n'
import { wrapText } from '@agentistics/tui/control/surface'
import { parseSessionArgs, LS_DEFAULT, type SessionCommand } from './cli-parse'
import { cliStrings } from '../cli-i18n'
import { resolveLang } from '../cli-lang'
import { readPreferences } from '../preferences'
import { toControlSession } from './control-session'
import { recordedRepo, repoFacts } from './repo-facts'
import { emptyReason, renderSessionTable, resolveWidth } from './session-table'
import { SPAWN_SPECS, planSpawn } from './spawn-spec'
import { rulesFor } from './attention-rules'
// The harness half of a rename. Shared with the cockpit's Rename verb — see `rename.ts`.
import { renameInHarness, renameMessage } from './rename'
import { reconcileSessions, resolveSessionRef, type ReconciledSession, type RefCandidate } from './session-ref'
import { addSession, newSessionId, patchSession, readRegistry, removeSession, retireFallenSessions } from './registry'
import { conversationForProcess, loadConversations } from './conversations'
import { resolveBackend } from './index'
import { scanProcesses } from '../live-sessions'
import { loadHarnessSessions } from './harness-sessions'
import { createSessionsPoller, type SessionSnapshot } from './sessions-host'
import { needsAttention, type SessionView } from './session-view'
import { planTaskReopen, taskReopenSucceeded } from './task-reopen'
import { liveConversationHolders } from './live-claims'
import { POLL_MS, SETTLE_MS, spawnOutcome } from './spawn-outcome'
import { parseHarnessAgents } from './harness-agents'
import { planTakeover, type TakeoverRefusal } from './takeover'
import type { BackendInitialPrompt, ManagedSession, SessionBackend, SpawnPlan, SpawnPlanError } from './types'

/**
 * The initial-prompt argument for `backend.spawn`, with the harness's screen RULES attached so the
 * backend can gate delivery on readiness without importing the harness table. Absent when the plan
 * carries no prompt to deliver. One helper for both spawn sites — the rules must never be forgotten
 * on one of them.
 */
function spawnPromptArg(plan: SpawnPlan, harness: HarnessId): { initialPrompt?: BackendInitialPrompt } {
  if (!plan.initialPrompt) return {}
  const rules = rulesFor(harness)
  return { initialPrompt: { ...plan.initialPrompt, ...(rules ? { rules } : {}) } }
}

/** Derived from the specs, never a second hand-written list — the two could not then disagree. */
const STARTABLE: HarnessId[] = HARNESS_ORDER.filter(h => SPAWN_SPECS[h] !== null)

const USAGE = `Usage:
  agentop session <harness> [-p "prompt"] [--bg] [--model <id>] [--effort <level>] [--cwd <path>] [--name "label"]
  agentop session ls     [--all] [--group ${GROUPINGS.join('|')}] [--json]
  agentop session list
  agentop session attach <id|name>
  agentop session kill   <id|name>
  agentop session rename <id|name> "label"
  agentop session note   <id|name> "text"

  \`ls\` is the table a PERSON reads: aligned columns, one section per project, and only what is
  running — \`--all\` adds the finished, lost and closed conversations, \`--group\` changes the
  sections. \`list\` stays the tab-separated dump a script can read line by line; both take
  \`--json\` and print the same data.

Orchestrating several at once — the form an assistant should use:

  agentop session batch --task "<name>" [--cwd <path>] [--model <id>] [--effort <level>] \\
                       --session "<harness>[@<cwd>]: <prompt>" [--session "..."] [--json]
  agentop session open  "<task>" [--json]
  agentop session list  [--json]

  \`batch\` starts every session detached and files them all under one task, so \`open\` brings the
  whole task back later and the cockpit groups them together. \`--cwd\`/\`--model\`/\`--effort\` given
  before the sessions apply to all of them; a \`@<cwd>\` on a session overrides it. \`--json\` prints
  the started ids as data.

  Example — three assistants on one repository, in parallel:

    agentop session batch --task "auth-refactor" --cwd ~/app --json \\
      --session "claude: refactor the token store" \\
      --session "codex: port the tests" \\
      --session "gemini: review the migration"

Harnesses that can be started: ${STARTABLE.join(', ')}`

/**
 * A reconciled row as `resolveSessionRef` needs it. Unlike the registry alone, this includes
 * `unregistered` rows (the backend hosts them, the registry does not) — `attach`/`kill` resolve
 * against this so a session `list` shows is never one only `list` can name.
 */
const toRefCandidate = (r: ReconciledSession): RefCandidate => ({ id: r.id, label: r.managed?.label })

function explainPlanError(e: SpawnPlanError): string {
  switch (e.code) {
    case 'unsupported-harness':
      return `${e.harness} cannot be started by agentop yet. Supported: ${STARTABLE.join(', ')}.`
    case 'resume-unsupported':
      return `${e.harness} cannot reopen a conversation by id, so it cannot be resumed.`
    case 'model-unsupported':
      return `${e.harness} has no model flag, so --model cannot be applied.`
    case 'effort-unsupported':
      return `${e.harness} has no effort flag, so --effort cannot be applied.`
    case 'unknown-effort':
      return `${e.harness} does not accept effort "${e.value}". Accepted: ${e.accepted.join(', ')}.`
  }
}

export async function runSession(argv: string[]): Promise<number> {
  const cmd = parseSessionArgs(argv)
  if (cmd.kind === 'help') { console.log(USAGE); return 0 }
  if (cmd.kind === 'error') { console.error(cmd.message); console.error(`\n${USAGE}`); return 1 }

  const backend = await resolveBackend()
  const blocked = await backend.unavailable()
  if (blocked) { console.error(blocked); return 1 }

  switch (cmd.kind) {
    case 'start': return start(cmd, backend)
    case 'batch': return batch(cmd, backend)
    case 'open': return openTask(cmd.task, cmd.json ?? false, backend)
    case 'list': return list(backend, cmd.json ?? false)
    case 'ls': return ls(cmd, backend)
    case 'attach': return attach(cmd.ref, backend)
    case 'kill': return kill(cmd.ref, backend)
    // `labelSince` travels WITH the label, always. `pickTitle` settles a disagreement between the
    // name typed here and the one the harness holds by RECENCY, and it can only do that when both
    // sides say when — so a rename written without a timestamp can never win, whatever the user
    // typed and however recently. Measured on this machine: every one of twelve live rows had
    // `labelSince: undefined`, because the cockpit's rename verb stamped it and this one did not.
    // The comparison had therefore never once run in production, and the harness took every row.
    // A rename lands in BOTH places a session can be named: the registry, and the harness's own
    // record. The second half is the shared `renameInHarness` — the cockpit's Rename verb runs the
    // very same function, because one gesture implemented twice is the bug `task-reopen.ts` exists
    // to have fixed once. It never blocks the registry write: whatever became of the harness half is
    // reported in a sentence instead.
    case 'rename': return patch(
      cmd.ref,
      { label: cmd.label, labelSince: Date.now() },
      'renamed',
      backend,
      async session => {
        const s = cliStrings(await resolveLang())
        const outcome = await renameInHarness(session, cmd.label.trim(), backend)
        return `${session.id} ${renameMessage(outcome, session.harness, s)}`
      },
    )
    case 'note': return patch(cmd.ref, { note: cmd.text }, 'annotated', backend)
  }
}

/**
 * Whether the session we just started is already GONE, and what it said on the way out.
 *
 * Returns the sentence to show, or `undefined` when it is running. One helper for all three spawn
 * sites — `start`, `batch` and the reopen — because the failure is identical at each and a check in
 * only one of them is the same bug surviving in the other two.
 *
 * The deadline is `SETTLE_MS`, and it is MEASURED rather than guessed — see that constant. The
 * first version waited 700ms on the reasoning that a refusal must be immediate; the real one lands
 * between 1.5s and 3s, so that check would have reported "started" for the very session it exists
 * to catch.
 */
async function spawnFailure(backend: SessionBackend, id: string): Promise<string | undefined> {
  // POLLED, not slept. Measured: the refusal lands between 1.5s and 3s — the harness loads and
  // resolves the conversation before deciding — so a fixed short wait reports "started" for a
  // session that is about to die. Polling ends the moment it dies, so a refusal costs what it
  // costs and only a healthy session waits out the deadline.
  const deadline = Date.now() + SETTLE_MS
  let outcome = spawnOutcome([])
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS))
    outcome = spawnOutcome(await backend.capture(id, 40).catch(() => [] as string[]))
    if (outcome.died) break
  }
  if (!outcome.died) return undefined
  // The harness's own words, because they are the only actionable part. A status with no message is
  // still better than "it did not start".
  return outcome.message
    || `the session exited immediately${outcome.status !== undefined ? ` (status ${outcome.status})` : ''}`
}

async function start(
  cmd: Extract<SessionCommand, { kind: 'start' }>,
  backend: SessionBackend,
): Promise<number> {
  // A relative --cwd must resolve against the CALLER's directory: passed through unresolved it
  // reaches `tmux new-session -c` and is interpreted by the tmux SERVER's own cwd instead, and it
  // is written verbatim into the registry, where `list` would print it back meaningless from
  // anywhere else.
  const cwd = cmd.cwd ? resolve(cmd.cwd) : process.cwd()
  const planned = planSpawn({
    harness: cmd.harness, cwd, prompt: cmd.prompt, model: cmd.model, effort: cmd.effort,
    conversationId: randomUUID(),
  })
  if (!planned.ok) { console.error(explainPlanError(planned.error)); return 1 }

  const id = newSessionId()
  try {
    await backend.spawn({ id, cwd, argv: planned.plan.argv, ...spawnPromptArg(planned.plan, cmd.harness) })
  } catch (e) {
    console.error(`Could not start the session: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }

  // `spawn` returning is not evidence anything is RUNNING — tmux's contract is "I made you a
  // session". A harness that refuses its arguments has already exited by now, and registering a row
  // for it is what produced three dead rows called MAIN. See `spawn-outcome.ts`.
  const failed = await spawnFailure(backend, id)
  if (failed) {
    console.error(failed)
    await backend.kill(id).catch(() => {})
    return 1
  }

  await addSession({
    id,
    harness: cmd.harness,
    cwd,
    createdAt: new Date().toISOString(),
    ...(cmd.model ? { model: cmd.model } : {}),
    ...(cmd.effort ? { effort: cmd.effort } : {}),
    ...(cmd.label ? { label: cmd.label } : {}),
    ...(cmd.task ? { task: cmd.task } : {}),
    // Stamped at SPAWN — the one moment the association is a fact. See `ManagedSession.taskId`.
    ...(cmd.taskId ? { taskId: cmd.taskId } : {}),
    ...(cmd.attemptId ? { attemptId: cmd.attemptId } : {}),
    // The link is EXACT here: the CLI was handed this id (`SpawnSpec.assignId`).
    ...(planned.plan.conversationId
      ? { conversationId: planned.plan.conversationId, conversationLink: 'assigned' as const }
      : {}),
    ...(await recordedRepo(cwd)),
  })

  const liveBackend = await backend.list().catch(() => [])
  const backendIds = new Set(liveBackend.map(b => b.id))
  await retireFallenSessions({
    newSessionId: id,
    conversationId: planned.plan.conversationId,
    cwd,
    harness: cmd.harness,
    backendIds,
  })

  if (cmd.background) {
    console.log(`Started ${cmd.harness} session ${id}${cmd.label ? ` (${cmd.label})` : ''} in ${cwd}`)
    console.log(`Attach with: agentop session attach ${id}`)
    return 0
  }
  return execAttach(id, backend)
}

/**
 * Hand the terminal over. The detach key is READ from the backend and printed first — a user who
 * cannot get out is stranded in a buffer that hides their shell, and the key is not always Ctrl-b.
 */
async function execAttach(
  id: string,
  backend: SessionBackend,
): Promise<number> {
  const hint = await backend.detachHint()
  console.log(`Attaching to ${id}. To leave the session running and come back here, press ${hint}.`)
  const [bin, ...rest] = backend.attachCommand(id)
  const p = Bun.spawn([bin!, ...rest], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  return await p.exited
}

/** The word each state wears. `external` says outright that this row is not ours to drive. */
function stateWord(v: SessionView): string {
  if (v.status === 'external') return 'external'
  if (v.status === 'lost') return 'lost'
  switch (v.activity) {
    case 'waiting-approval': return 'NEEDS APPROVAL'
    case 'waiting': return 'waiting'
    case 'working': return 'working'
    case 'exited': return 'exited'
    default: return v.status
  }
}

/**
 * `agentop session batch` — start several sessions at once, all filed under one task.
 *
 * The command an ASSISTANT drives. Every session is started detached, because a batch by definition
 * has no single terminal to hand over, and the result is printed as JSON on request so the caller
 * gets the ids back as data rather than having to parse prose it did not write.
 *
 * A failure does not abort the rest: with five sessions requested, four that started are four that
 * are running, and pretending otherwise would leave them orphaned. Every outcome is reported.
 */
async function batch(
  cmd: Extract<SessionCommand, { kind: 'batch' }>,
  backend: SessionBackend,
): Promise<number> {
  const started: Array<{ id: string; harness: string; cwd: string }> = []
  const failed: Array<{ harness: string; reason: string }> = []

  for (const spec of cmd.specs) {
    const cwd = spec.cwd ? resolve(spec.cwd) : process.cwd()
    const planned = planSpawn({
      harness: spec.harness,
      cwd,
      ...(spec.prompt ? { prompt: spec.prompt } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      conversationId: randomUUID(),
    })
    if (!planned.ok) { failed.push({ harness: spec.harness, reason: explainPlanError(planned.error) }); continue }

    const id = newSessionId()
    try {
      await backend.spawn({
        id, cwd, argv: planned.plan.argv,
        ...spawnPromptArg(planned.plan, spec.harness),
      })
    } catch (e) {
      failed.push({ harness: spec.harness, reason: e instanceof Error ? e.message : String(e) })
      continue
    }
    // Same check as `start`: a harness that refused its arguments is already gone, and a batch that
    // reports N started when N exited is worse than one that reports the refusal — the whole point
    // of a batch is that nobody is watching each one come up.
    const died = await spawnFailure(backend, id)
    if (died) {
      failed.push({ harness: spec.harness, reason: died })
      await backend.kill(id).catch(() => {})
      continue
    }
    await addSession({
      id,
      harness: spec.harness,
      cwd,
      createdAt: new Date().toISOString(),
      task: cmd.task,
      // Stamped at SPAWN — the one moment the association is a fact. See `ManagedSession.taskId`.
      ...(cmd.taskId ? { taskId: cmd.taskId } : {}),
      ...(spec.attemptId ? { attemptId: spec.attemptId } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      ...(spec.name ? { label: spec.name } : {}),
      ...(planned.plan.conversationId
        ? { conversationId: planned.plan.conversationId, conversationLink: 'assigned' as const }
        : {}),
      ...(await recordedRepo(cwd)),
    })
    const liveBackend = await backend.list().catch(() => [])
    const backendIds = new Set(liveBackend.map(b => b.id))
    await retireFallenSessions({
      newSessionId: id,
      conversationId: planned.plan.conversationId,
      cwd,
      harness: spec.harness,
      backendIds,
    })
    started.push({ id, harness: spec.harness, cwd })
  }

  if (cmd.json) {
    console.log(JSON.stringify({ task: cmd.task, started, failed }, null, 2))
  } else {
    for (const st of started) console.log(`${st.id}\t${st.harness}\t${st.cwd}`)
    for (const f of failed) console.error(`failed\t${f.harness}\t${f.reason}`)
    console.log(`\n${started.length} started under task "${cmd.task}"${failed.length ? `, ${failed.length} failed` : ''}.`)
    if (started.length > 0) console.log(`Attach to any with: agentop session attach <id>`)
  }
  return failed.length > 0 && started.length === 0 ? 1 : 0
}

/** `agentop session open "<task>"` — reopen every session of a task, detached. */
async function openTask(task: string, json: boolean, backend: SessionBackend): Promise<number> {
  const wanted = (await readRegistry()).filter(m => m.task === task)
  if (wanted.length === 0) {
    console.error(`No sessions are filed under "${task}".`)
    return 1
  }
  const conversations = await loadConversations()
  const live = new Set((await backend.list().catch(() => [])).filter(b => b.alive).map(b => b.id))
  // What is already being driven, so this cannot put a second assistant into a conversation that has
  // one. `live` above cannot answer it: it is keyed by ROW, and the twin case is a row that is down
  // while a DIFFERENT row drives its conversation. Same collector the cockpit's verb uses.
  const inUse = await liveConversationHolders(backend)
  // Claimed within this batch too. The cockpit's copy of this loop has had this set for a while and
  // this one never did, so `conversationForProcess` — which matches on harness and directory, and
  // therefore answers with the FIRST conversation of a repository — handed the same one to every row
  // of a task filed in that repository. The drift `planTaskReopen` was extracted to end, met again
  // one layer out.
  const taken = new Set<string>()
  // The DECISION is the pure `planTaskReopen`, shared with the cockpit's verb. The two used to be
  // separate implementations and had drifted: only one retired the row it replaced, so the same
  // gesture left a different registry depending on where you pressed it.
  const plan = planTaskReopen({
    entries: wanted,
    liveIds: live,
    inUse,
    conversationFor: m => {
      const own = m.conversationId
        ? conversations.find(c => c.sessionId === m.conversationId)
        : undefined
      const conv = own ?? conversationForProcess(
        conversations.filter(c => !taken.has(c.sessionId)),
        { harness: m.harness, cwd: m.cwd },
      )
      if (!conv?.resumable) return null
      taken.add(conv.sessionId)
      return { sessionId: conv.sessionId, title: conv.title }
    },
  })

  const started: string[] = []
  const skipped: string[] = [...plan.skipped]

  for (const row of plan.reopen) {
    const m = row.entry
    const planned = planSpawn({ harness: m.harness, cwd: m.cwd, resumeId: row.resumeId })
    if (!planned.ok) { skipped.push(m.id); continue }
    const id = newSessionId()
    try {
      await backend.spawn({ id, cwd: m.cwd, argv: planned.plan.argv })
    } catch { skipped.push(m.id); continue }
    // The path the report came from. Claude refuses to resume a conversation that is already open
    // as a background agent, and the refusal is instant — so this reopen wrote a row for a process
    // that no longer existed, and pressing it again wrote another. The old row must NOT be retired
    // either: retiring it on a reopen that failed would lose the only row that still names the work.
    const died = await spawnFailure(backend, id)
    if (died) {
      skipped.push(m.id)
      await backend.kill(id).catch(() => {})
      continue
    }
    await addSession({
      id, harness: m.harness, cwd: m.cwd, createdAt: new Date().toISOString(), task,
      label: row.label,
      ...(m.note ? { note: m.note } : {}),
      // INHERITED from the row being replaced, never taken from the request: a reopened session is
      // the same piece of work, and the attribution is what says so. See `ManagedSession.taskId`.
      ...(m.taskId ? { taskId: m.taskId } : {}),
      ...(m.attemptId ? { attemptId: m.attemptId } : {}),
      // The conversation is known EXACTLY here — we just handed its id to the CLI. The cockpit's
      // reopen verb has recorded it since it was written; this path had not, so the same gesture
      // left a row that knew which conversation it drove or one that did not, depending on where it
      // was pressed. `planTaskReopen` exists to stop precisely that kind of drift.
      ...(planned.plan.conversationId
        ? { conversationId: planned.plan.conversationId, conversationLink: 'assigned' as const }
        : {}),
      // The REPLACEMENT re-measures rather than copying `m.repo`: a reopen is the moment to notice
      // that the worktree came back, and copying a recorded value would carry one stale answer
      // through every session ever reopened from it.
      ...(await recordedRepo(m.cwd)),
    })
    // The old row is RETIRED, not deleted: it is still a thing that happened, and it stops standing
    // beside its own continuation with the same name on it.
    await patchSession(m.id, { endedAt: new Date().toISOString() })
    started.push(id)
  }

  if (json) {
    console.log(JSON.stringify({
      task, started, skipped, already: plan.already,
      // Each one NAMES the session that already has the conversation, because a machine reader is
      // exactly who needs to be told where the work is rather than that something did not happen.
      heldElsewhere: plan.heldElsewhere.map(h => ({ id: h.id, heldBy: h.holder.id, label: h.holder.label })),
    }, null, 2))
  } else {
    for (const id of started) console.log(id)
    // Reported, never silent: a partial reopen presented as a success leaves someone believing they
    // have their whole task back.
    for (const h of plan.heldElsewhere) {
      console.log(`${h.id}\talready open in ${h.holder.label}`)
    }
    const alreadyUp = plan.already.length ? `, ${plan.already.length} already running` : ''
    const held = plan.heldElsewhere.length ? `, ${plan.heldElsewhere.length} already open elsewhere` : ''
    console.log(`\n${started.length} reopened${skipped.length ? `, ${skipped.length} could not be` : ''}${alreadyUp}${held}.`)
  }
  return taskReopenSucceeded(plan, started.length) ? 0 : 1
}

/** The fleet as DATA, so an assistant orchestrating sessions reads it rather than parsing a table
 *  meant for a person. One shape for every command that offers `--json`: `ls` prints exactly what
 *  `list` prints, because a second machine-readable format is a second thing to keep in step. */
function fleetJson(snap: SessionSnapshot): unknown {
  return {
    sessions: snap.sessions.map(v => ({
      id: v.id,
      status: v.status,
      activity: v.activity ?? null,
      harness: v.harness ?? null,
      cwd: v.cwd,
      label: v.label ?? null,
      task: v.task ?? null,
      resumeId: v.resume?.sessionId ?? null,
      // The RECORDED conversation, kept apart from `resumeId` above rather than folded into it.
      // They answer different questions: this one is what the row provably drives, that one is a
      // target the reopen verb OFFERS and will fall back to a harness-and-directory guess for. A
      // caller reading one field could not tell which of the two it had been given.
      conversationId: v.conversationId ?? null,
    })),
    attention: snap.attention,
    unavailable: snap.unavailable ?? null,
  }
}

/**
 * The whole fleet, from the registry, the backend, `/proc`, the conversation store and what each
 * harness records about its own sessions.
 *
 * It reads the SAME sources the cockpit's poller does, and that is the point rather than a detail:
 * `session ls` is the cockpit's table printed, so a source wired into one and not the other is how
 * one session ends up wearing two different names depending on where you look at it. It was missing
 * `loadHarnessSessions` for exactly one commit, and the row a user had renamed inside the session
 * read correctly in the cockpit and stale on the command line.
 *
 * There is deliberately NO heartbeat here: a one-shot command must not stamp `lastSeenMs`. It runs
 * once and exits, so a run that happened to be the last thing before a reboot would be indistinguish-
 * able from a fleet that was alive — and `crash-group.ts` would be reading a write nobody made a
 * claim with.
 */
/**
 * How long between the two confirming polls a one-shot command makes. Long enough for a working
 * session's screen to have moved (or a quiet one to have stayed still) — tmux's activity clock has
 * one-second resolution — short enough not to be felt on the command line.
 */
const CONFIRM_POLL_GAP_MS = 700

async function pollFleet(backend: SessionBackend): Promise<SessionSnapshot> {
  const poller = createSessionsPoller({
    backend, readRegistry, scanProcesses, loadConversations, loadHarnessSessions,
  })
  // Poll TWICE, and return the second. The cockpit debounces the noisy per-frame reading by
  // confirming a `waiting` state across two polls (`attention-confirm.ts`), but a one-shot command
  // has no memory of a previous poll — so a single reading cannot be confirmed and a lone quiet
  // frame (a finished sub-turn, a repaint) would be reported as "waiting on you" for a session that
  // is still working. The first poll seeds the poller's confirmation memory; the second returns the
  // confirmed reading, so `session ls`/`list` agrees with the cockpit and the event channel instead
  // of reviving the exact false positive on the command line.
  await poller.poll()
  await new Promise(r => setTimeout(r, CONFIRM_POLL_GAP_MS))
  return await poller.poll()
}

/**
 * `agentop session ls` — the cockpit's sessions table, printed once.
 *
 * Everything about what a row IS comes from the same modules the Sessions tab uses: `pollFleet`
 * gathers the fleet, `toControlSession` maps it, `renderSessionTable` draws it. What is decided here
 * is what a COMMAND LINE has to decide — which rows the question is about (what is running, unless
 * `--all`), how wide the output may be, and whether anything is going to a terminal at all.
 */
async function ls(
  cmd: Extract<SessionCommand, { kind: 'ls' }>,
  backend: SessionBackend,
): Promise<number> {
  const snap = await pollFleet(backend)
  if (cmd.json) { console.log(JSON.stringify(fleetJson(snap), null, 2)); return 0 }

  const lang = await resolveLang()
  const s = cliStrings(lang)
  // The TABLE's own chrome — its column headings and the words an empty grouping key wears — is the
  // control center's, because it is the control center's table. Two copies of "usage" and "no task"
  // are two places for them to disagree about what a column is called.
  const c = controlStrings(lang)

  // Said BEFORE the table: an unavailable backend has not established that nothing is running, and
  // the rows below may be a previous poll rather than a fresh one.
  if (snap.unavailable) console.error(snap.unavailable)

  // Resolved per session and memoized by directory — the same read the cockpit does, and what makes
  // three worktrees of one repository group under the project rather than under three names.
  const facts = await Promise.all(snap.sessions.map(v => repoFacts(v.cwd, v.recordedRepo)))
  // A preferences file that cannot be read costs the "finished" mark on a task heading, never the
  // table: the fleet is what the command is for.
  const finishedTasks = await readPreferences().then(p => p.finishedTasks ?? []).catch(() => [])
  const fleet = snap.sessions.map((v, i) => toControlSession(v, s, facts[i]))
  // `sessionRunning` rather than a state list of our own: an EXTERNAL row is running — it exists
  // because `/proc` found a live assistant — and what cannot be read there is its activity, never
  // whether it is alive.
  const shown = cmd.all ? fleet : fleet.filter(sessionRunning)

  const tty = process.stdout.isTTY === true
  // `--width`, then the terminal, then `COLUMNS`, then the natural width — the precedence is
  // `resolveWidth`'s, so it is stated and tested in one place. `columns` is passed ONLY on a tty:
  // off one it is undefined anyway, and asking for it would make the fallback depend on a value
  // that cannot exist.
  const width = resolveWidth({
    ...(cmd.width !== undefined ? { explicit: cmd.width } : {}),
    ...(tty && process.stdout.columns ? { columns: process.stdout.columns } : {}),
    ...(process.env.COLUMNS !== undefined ? { env: process.env.COLUMNS } : {}),
  })
  const color = cmd.color ?? (tty && !process.env.NO_COLOR)
  // Every SENTENCE this command prints is wrapped, never truncated: they name sessions and flags,
  // and a cut one hides the very thing it exists to say. Through the app's own `wrapText`, and a
  // no-op at a pipe's natural width — where one long line is what `grep` wants.
  const say = (text: string) => { for (const l of wrapText(text, width)) console.log(l) }

  // A mute blank is indistinguishable from a broken command, so an empty list says which of the
  // three things happened. The decision is pure; only the sentence is chosen here.
  const empty = emptyReason({
    fleet: fleet.length,
    shown: shown.length,
    ...(snap.unavailable ? { unavailable: snap.unavailable } : {}),
  })
  if (empty !== null) {
    // `unavailable` was already printed above, and it is the whole explanation.
    if (empty === 'empty') say(s.sessLs.none)
    else if (empty === 'filtered') say(s.sessLs.noneRunning(fleet.length))
    return empty === 'unavailable' ? 1 : 0
  }

  for (const line of renderSessionTable({
    sessions: shown,
    width,
    grouping: cmd.group,
    color,
    doneTasks: finishedTasks,
    strings: {
      cols: c.sessionsCols,
      words: sessionWordBook(c),
      closed: c.sessionsClosedWord,
      done: c.sessionsDoneWord,
    },
  })) console.log(line)

  const waiting = shown.filter(v => v.state === 'waiting' || v.state === 'waiting-approval')
  if (waiting.length > 0) {
    console.log('')
    say(s.sessLs.waiting(waiting.length, waiting.map(v => v.title).join(', ')))
  }

  // A harness with no probed rules cannot tell a permission prompt from an ordinary pause. Saying so
  // is the difference between a gap and a wrong answer — and `approvalBlind` is set only on the rows
  // that can lack it, so a closed conversation never names a harness that is in fact probed.
  const blind = [...new Set(shown.filter(v => v.approvalBlind).map(v => v.harness))]
  if (blind.length > 0) say(s.sessLs.blind(blind.join(', ')))
  return 0
}

async function list(backend: SessionBackend, json = false): Promise<number> {
  const snap = await pollFleet(backend)

  if (json) {
    console.log(JSON.stringify(fleetJson(snap), null, 2))
    return 0
  }

  if (snap.unavailable) console.error(snap.unavailable)
  if (snap.sessions.length === 0) {
    // Only claim "nothing is running" when the poll actually succeeded — an unavailable backend has
    // not established that, and saying so would be a confident zero.
    if (!snap.unavailable) console.log('No sessions.')
    return snap.unavailable ? 1 : 0
  }

  for (const v of snap.sessions) {
    const id = v.status === 'external' ? '-' : v.id
    // `?` rather than a guessed harness: an unregistered session's harness is genuinely unrecorded.
    console.log(`${id}\t${stateWord(v)}\t${v.harness ?? '?'}\t${v.label ?? ''}\t${v.cwd}`)
  }

  const waiting = snap.sessions.filter(v => needsAttention(v.activity))
  if (waiting.length > 0) {
    console.log(`\n${waiting.length} session(s) waiting on you: ${waiting.map(v => v.label ?? v.id).join(', ')}`)
  }

  // A harness with no probed rules cannot distinguish a permission prompt from an ordinary pause.
  // Saying so is the difference between a gap and a wrong answer.
  // Only rows we actually HOST can have their approval detected, so only they can lack it. A closed
  // conversation and a foreign process have no screen to read at all — including them here named
  // claude, kimi and codex as undetectable when all three are probed.
  const blind = [...new Set(
    snap.sessions
      .filter(v => v.status !== 'external' && v.status !== 'closed' && !v.approvalDetection)
      .map(v => v.harness)
      .filter((h): h is NonNullable<typeof h> => h !== undefined),
  )]
  if (blind.length > 0) {
    console.log(`Approval detection is not available for: ${blind.join(', ')} — those sessions show as "waiting" either way.`)
  }
  return 0
}

async function attach(ref: string, backend: SessionBackend): Promise<number> {
  const reconciled = reconcileSessions(await readRegistry(), await backend.list())
  const found = resolveSessionRef(reconciled.map(toRefCandidate), ref)
  if (found.ok) return execAttach(found.session.id, backend)

  // Not a row agentop hosts — but it may be a conversation that is RUNNING somewhere, and the user
  // asked to get into it. This is the case the product had no answer for: it refused with "open it
  // where it already is", which names a place that for a background agent does not exist.
  //
  // The answer is to CLOSE the assistant holding it and reopen the conversation here. The lock
  // exists to stop two assistants in one conversation, and closing the first satisfies it exactly;
  // refusing satisfies it by leaving the user with none. The decision is the pure `planTakeover` —
  // it checks that the harness can resume by id BEFORE anything is killed.
  const took = await takeOver(ref, backend)
  if (took !== null) return took

  console.error(refError(ref, found.reason, found.matches))
  return 1
}

/**
 * Close whatever is holding a live conversation and reopen it under agentop.
 *
 * `null` when `ref` names no live conversation — the caller then reports the ordinary lookup error.
 *
 * Not claude-specific: the two steps are the same everywhere, and `planSpawn` already knows which
 * harnesses can resume by id at all. Today only claude publishes a live-session list to search
 * (`claude agents --json`); the day another does, it joins the search and nothing else changes.
 */
async function takeOver(ref: string, backend: SessionBackend): Promise<number | null> {
  const live = await liveAgentFor(ref)
  if (!live) return null

  const planned = planSpawn({ harness: live.harness, cwd: live.cwd, resumeId: live.sessionId })
  const plan = planTakeover({
    conversationId: live.sessionId,
    harness: live.harness,
    resumable: planned.ok,
    holder: { pid: live.pid, cwd: live.cwd, label: live.name },
    cwd: live.cwd,
  })

  if (plan.kind === 'refuse') {
    console.error(explainTakeover(plan.reason))
    return 1
  }
  if (plan.kind === 'free' || !planned.ok) return null

  // Ending somebody's running assistant loses whatever it was mid-turn, so it is stated before it
  // happens rather than reported after.
  console.log(`Closing ${plan.holder.label ?? plan.conversationId.slice(0, 8)} (pid ${plan.holder.pid}) to reopen it here…`)
  try {
    process.kill(plan.holder.pid!, 'SIGTERM')
  } catch (e) {
    console.error(`Could not close it: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
  // Wait for it to actually go. Resuming while the old one is still shutting down is the very race
  // the harness refuses on, and it would land as another dead row.
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 100))
    try { process.kill(plan.holder.pid!, 0) } catch { break }
  }

  const id = newSessionId()
  try {
    await backend.spawn({ id, cwd: plan.cwd, argv: planned.plan.argv })
  } catch (e) {
    console.error(`Closed it, but could not reopen: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
  const died = await spawnFailure(backend, id)
  if (died) { console.error(died); await backend.kill(id).catch(() => {}); return 1 }

  const record: ManagedSession = {
    id, harness: live.harness, cwd: plan.cwd, createdAt: new Date().toISOString(),
    ...(live.name ? { label: live.name, labelSince: Date.now() } : {}),
    conversationId: plan.conversationId,
    ...(await recordedRepo(plan.cwd)),
  }
  // The write is READ BACK, and that is not belt-and-braces — it is the failure this path actually
  // had. `registry.ts` serialises writes within ONE process; agentop runs as several (the cockpit,
  // the daemon, every one-shot command), all read-modify-writing the same file. A record added here
  // was observed erased by a longer-lived process that had read the file just before, and the
  // session it lost was the one the user was about to sit in: running, unregistered, and beyond
  // every verb the cockpit offers. One retry closes the ordinary interleaving; a loss that survives
  // it is SAID rather than left for the user to discover when a rename stops working.
  if (!await addVerified(record)) {
    console.error(
      `${id} is running but its registry record could not be kept — another agentop process is `
      + 'writing the same registry. The cockpit will take it back on its next poll; if it does not, '
      + `run \`agentop session attach ${id}\` again.`,
    )
  }
  return execAttach(id, backend)
}

/**
 * Add a session and confirm it survived. `false` when it did not, after one retry.
 *
 * Deliberately not inside `registry.ts`: the retry is a statement about CONCURRENCY between
 * processes, and the registry module's own contract ("one in-process writer") is honest about not
 * covering that. Hiding a cross-process retry inside `add` would make every caller believe a
 * guarantee that still does not exist.
 */
async function addVerified(record: ManagedSession): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await addSession(record)
    if ((await readRegistry()).some(s => s.id === record.id)) return true
  }
  return false
}

/** Already-localized refusal — the harness's limitation said in words, never a silent no-op. */
function explainTakeover(reason: TakeoverRefusal): string {
  switch (reason.code) {
    case 'resume-unsupported':
      return `${reason.harness} cannot reopen a conversation by id, so the assistant holding it was left alone.`
    case 'holder-unreachable':
      return `something is holding this conversation${reason.label ? ` (${reason.label})` : ''} and agentop cannot close it.`
    case 'no-cwd':
      return 'this conversation has no directory to reopen in — a removed worktree, most likely.'
  }
}

/**
 * The LIVE conversation matching what the user typed, when there is exactly one.
 *
 * Matched on a prefix of the conversation id or on the session's NAME, because those are the two
 * things on screen. Ambiguity resolves to nothing rather than to a guess: taking over the wrong
 * conversation closes the wrong assistant.
 */
async function liveAgentFor(ref: string): Promise<
  { sessionId: string; harness: HarnessId; cwd: string; pid?: number; name?: string } | null
> {
  try {
    const out = Bun.spawnSync(['claude', 'agents', '--json'])
    if (!out.success) return null
    const needle = ref.trim().toLowerCase()
    const hits = parseHarnessAgents(out.stdout.toString()).filter(a =>
      a.sessionId.toLowerCase().startsWith(needle)
      || (a.name ?? '').toLowerCase() === needle)
    const only = hits.length === 1 ? hits[0]! : undefined
    if (!only?.cwd) return null
    return {
      sessionId: only.sessionId,
      harness: 'claude',
      cwd: only.cwd,
      ...(only.pid !== undefined ? { pid: only.pid } : {}),
      ...(only.name ? { name: only.name } : {}),
    }
  } catch {
    return null
  }
}

async function kill(ref: string, backend: SessionBackend): Promise<number> {
  const registry = await readRegistry()
  const reconciled = reconcileSessions(registry, await backend.list())
  const found = resolveSessionRef(reconciled.map(toRefCandidate), ref)
  if (!found.ok) { console.error(refError(ref, found.reason, found.matches)); return 1 }
  const { id } = found.session
  const statusBefore = reconciled.find(r => r.id === id)?.status

  const confirmed = await backend.kill(id)
  // A session that was already `lost` (the backend has nothing by this id — there was never
  // anything for `kill` to do) or `exited` (the hosted command already finished) is safe to clear
  // even on a backend report we cannot trust, because the reconciled view established BEFORE this
  // call already knew nothing was running. This is the fallback, not the common path: an ordinary
  // kill still relies on `confirmed`, so a real failure never gets papered over.
  if (!confirmed && statusBefore !== 'lost' && statusBefore !== 'exited') {
    console.error(`Could not confirm ${id} was killed — it may still be running. Its registry entry was kept.`)
    return 1
  }
  await removeSession(id)
  console.log(`Killed ${id}.`)
  return 0
}

async function patch(
  ref: string,
  // `labelSince` is here rather than stamped inside because it belongs to `label` and to nothing
  // else — a note carries no timestamp and must not acquire one by passing through this helper.
  fields: { label?: string; labelSince?: number; note?: string },
  verb: string,
  backend: SessionBackend,
  /**
   * What to print once the registry write has landed, when the plain `<id> <verb>.` is not the whole
   * story. `rename` uses it to report what became of the HARNESS half; `note` has no second half and
   * passes nothing. It runs only after `patchSession` succeeded, so it can never announce work done
   * on a session the write did not find.
   */
  then?: (session: ManagedSession) => Promise<string>,
): Promise<number> {
  const registry = await readRegistry()
  const found = resolveSessionRef(registry, ref)
  if (!found.ok) {
    // `rename`/`note` patch registry METADATA, so they only ever resolve against the registry —
    // an unregistered session has none to patch. But "not found" there is not the same claim as
    // "does not exist": check the reconciled view so the error says which one is actually true.
    if (found.reason === 'not-found') {
      const reconciled = reconcileSessions(registry, await backend.list())
      const inBackend = resolveSessionRef(reconciled.map(toRefCandidate), ref)
      if (inBackend.ok) {
        console.error(
          `${inBackend.session.id} is running but has no registry entry to update — it was not ` +
          'started as a managed session, or its record was lost. There is nothing to rename/note.',
        )
        return 1
      }
    }
    console.error(refError(ref, found.reason, found.matches))
    return 1
  }
  // The registry was read before this write, and writes are queued — a concurrent `kill` can
  // remove the session in between, so the patch itself is the only source of truth on success.
  const applied = await patchSession(found.session.id, fields)
  if (!applied) { console.error(refError(ref, 'not-found', [])); return 1 }
  console.log(then ? await then(found.session) : `${found.session.id} ${verb}.`)
  return 0
}

function refError(ref: string, reason: 'not-found' | 'ambiguous', matches: string[]): string {
  return reason === 'not-found'
    ? `No session matches "${ref}". Run \`agentop session list\` to see them.`
    : `"${ref}" matches more than one session: ${matches.join(', ')}. Use a full id.`
}
