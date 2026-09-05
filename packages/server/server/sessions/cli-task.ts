/**
 * cli-task.ts — `agentop task`. The impure half: reads the task book, the registry and the
 * consolidate store, and prints.
 *
 * Every rule lives in the pure modules beside it — `task-model.ts` (what a task is),
 * `task-parse.ts` (the argv), `task-rollup.ts` (the arithmetic and its units),
 * `task-evidence.ts` (what a delivery produced). This file resolves and draws, and nothing else.
 *
 * THE THREE THINGS IT MUST SAY, and never imply:
 *  - a metric the harness cannot produce prints `N/A`, never `0`;
 *  - a cost states how many of the attempt's sessions it actually covers, and how many of its
 *    figures were measured rather than estimated;
 *  - an attempt mixing dollars and Copilot credits prints BOTH and no total, because a sum of the
 *    two is not a number.
 */

import { TASKS_FILE } from '../config'
import { loadConsolidated } from '../consolidate'
import { getCommitsInWindow } from '../git'
import { sessionCostUSD } from '../member-metrics'
import { readPreferences, writePreferences } from '../preferences'
import { readRegistry } from './registry'
import { createTaskStore, type TaskStore } from './task-store'
import { legacyTaskId, migrateLegacyTasks, newAttemptId, type Attempt, type Task } from './task-model'
import { parseTaskArgs, type TaskCommand } from './task-parse'
import { rollupAttempt, type AttemptRollup, type RollupSession } from './task-rollup'
import { planDeliveryEvidence, type EvidenceCommit } from './task-evidence'
import type { ManagedSession } from './types'
import type { SessionMeta } from '@agentistics/core'

const NA = 'N/A'

/** A rollup row on screen: an attempt, or the sessions of a task that name no attempt. */
interface AttemptView {
  id: string | null
  label: string
  config?: Attempt['config']
  status: Attempt['status'] | 'unattributed'
  rollup: AttemptRollup
}

/**
 * Make sure every task name a person has already typed exists in the book.
 *
 * Idempotent by construction: `legacyTaskId` derives the id from the name, so a name already
 * carried is upserted as itself and a second run changes nothing. This is what makes the feature
 * useful on the machine it is installed on rather than only for work started after it.
 */
async function ensureLegacyTasks(store: TaskStore, rows: readonly ManagedSession[]): Promise<void> {
  const finished = await readPreferences().then(p => p.finishedTasks ?? []).catch(() => [] as string[])
  const names = rows.map(r => r.task).filter((t): t is string => Boolean(t))
  if (names.length === 0 && finished.length === 0) return

  const book = await store.read()
  const known = new Set(book.tasks.map(t => t.id))
  const now = new Date().toISOString()
  for (const t of migrateLegacyTasks({ names, finished, now })) {
    // Only what is MISSING. A task already in the book may have been renamed or delivered since,
    // and re-upserting the derived record would undo that.
    if (known.has(t.id)) continue
    await store.upsertTask(t)
  }
}

/**
 * The sessions of a task: those stamped with its id, plus those carrying its NAME from before ids
 * existed. The second half is exactly what `legacyTaskId` is for.
 */
function rowsOfTask(task: Task, rows: readonly ManagedSession[]): ManagedSession[] {
  return rows.filter(r =>
    r.taskId === task.id
    || (r.task !== undefined && legacyTaskId(r.task) === task.id))
}

/**
 * One `RollupSession` per row.
 *
 * `provenance` is READ from the record rather than guessed: a link with no `conversationLink` was
 * written before that field existed and was an assigned one. A row whose conversation is not in the
 * store yields `meta: null` and still counts as a session used.
 *
 * `costMeasured` stays unset: nothing reads a harness's own cost figure yet (that is the separate
 * `cost-state` work), and claiming a figure is measured when it was estimated is precisely the
 * confusion the field exists to prevent.
 */
function rollupSessionsFor(
  rows: readonly ManagedSession[],
  store: ReadonlyMap<string, SessionMeta>,
): RollupSession[] {
  return rows.map(r => {
    const meta = r.conversationId ? store.get(r.conversationId) ?? null : null
    return {
      rowId: r.id,
      provenance: r.conversationId ? (r.conversationLink ?? 'assigned') : 'none',
      meta,
      costUSD: meta ? sessionCostUSD(meta) : null,
    } satisfies RollupSession
  })
}

function attemptViews(
  task: Task,
  attempts: readonly Attempt[],
  rows: readonly ManagedSession[],
  metas: ReadonlyMap<string, SessionMeta>,
): AttemptView[] {
  const mine = attempts.filter(a => a.taskId === task.id)
  const views: AttemptView[] = mine.map(a => ({
    id: a.id,
    label: a.label,
    config: a.config,
    status: a.status,
    rollup: rollupAttempt({ sessions: rollupSessionsFor(rows.filter(r => r.attemptId === a.id), metas) }),
  }))

  // Rows filed under the task but under no attempt. They are shown rather than dropped: they are
  // real sessions of this delivery, and a total that silently omitted them would be wrong in the
  // reassuring direction.
  const loose = rows.filter(r => !r.attemptId || !mine.some(a => a.id === r.attemptId))
  if (loose.length > 0) {
    views.push({
      id: null,
      label: 'no attempt named',
      status: 'unattributed',
      rollup: rollupAttempt({ sessions: rollupSessionsFor(loose, metas) }),
    })
  }
  return views
}

const fmtNum = (n: number | null): string => (n === null ? NA : String(n))
const fmtUSD = (n: number | null): string => (n === null ? NA : `$${n.toFixed(2)}`)

/** The one place a rollup becomes sentences. Every caveat it carries is printed, never implied. */
function rollupLines(r: AttemptRollup): string[] {
  const out: string[] = []
  const money = r.mixedCurrency
    // Two units in one column is not a total. Both are printed and neither is summed.
    ? `${fmtUSD(r.costUSD)} + ${r.credits!.premiumRequests} premium req (no single total)`
    : r.credits !== null
      ? `${r.credits.premiumRequests} premium req`
      : fmtUSD(r.costUSD)

  out.push(`    cost ${money}   rounds ${fmtNum(r.rounds)}   sessions ${r.sessionsUsed}`
    + `   tokens ${fmtNum(r.tokens)}   active ${fmtNum(r.activeMinutes)} min`)

  if (r.sessionsLinked < r.sessionsUsed) {
    out.push(`    cost covers ${r.sessionsLinked} of ${r.sessionsUsed} sessions`
      + ` (${r.provenance.none} with no conversation link)`)
  }
  if (r.costMeasuredSessions > 0 && r.costEstimatedSessions > 0) {
    out.push(`    ${r.costMeasuredSessions} measured, ${r.costEstimatedSessions} estimated`)
  }
  return out
}

async function loadEverything() {
  const store = createTaskStore(TASKS_FILE)
  const rows = await readRegistry()
  await ensureLegacyTasks(store, rows)
  const [book, metas] = await Promise.all([store.read(), loadConsolidated().catch(() => new Map())])
  return { store, rows, book, metas: metas as ReadonlyMap<string, SessionMeta> }
}

function findTask(ref: string, tasks: readonly Task[]): Task | undefined {
  return tasks.find(t => t.id === ref)
    ?? tasks.find(t => t.title === ref)
    ?? tasks.find(t => t.title.toLowerCase() === ref.toLowerCase())
}

async function runLs(json: boolean): Promise<number> {
  const { rows, book, metas } = await loadEverything()
  if (book.tasks.length === 0) {
    console.log('No tasks yet. `agentop session batch --task "<name>" --attempt "<config>" …` starts one.')
    return 0
  }
  const listed = book.tasks.map(t => {
    const mine = rowsOfTask(t, rows)
    return {
      task: t,
      sessions: mine.length,
      rollup: rollupAttempt({ sessions: rollupSessionsFor(mine, metas) }),
      attempts: book.attempts.filter(a => a.taskId === t.id).length,
    }
  })
  if (json) {
    console.log(JSON.stringify(listed, null, 2))
    return 0
  }
  for (const l of listed) {
    console.log(`${l.task.status.padEnd(9)} ${l.task.title}`)
    console.log(`    ${l.attempts} attempt(s)`)
    for (const line of rollupLines(l.rollup)) console.log(line)
  }
  return 0
}

async function runShow(ref: string, json: boolean): Promise<number> {
  const { rows, book, metas } = await loadEverything()
  const task = findTask(ref, book.tasks)
  if (!task) {
    console.error(`No task matches "${ref}". \`agentop task ls\` lists them.`)
    return 1
  }
  const mine = rowsOfTask(task, rows)
  const views = attemptViews(task, book.attempts, mine, metas)
  if (json) {
    console.log(JSON.stringify({ task, attempts: views }, null, 2))
    return 0
  }
  console.log(`${task.title}  [${task.status}]`)
  if (task.deliveredAt) console.log(`delivered ${task.deliveredAt}`)
  console.log('')
  for (const v of views) {
    const cfg = v.config
      ? [v.config.harness, v.config.model, v.config.effort, v.config.method].filter(Boolean).join(' · ')
      : ''
    console.log(`  ${v.label}${cfg ? `  (${cfg})` : ''}  [${v.status}]`)
    for (const line of rollupLines(v.rollup)) console.log(line)
    console.log('')
  }
  // Said once, at the foot, because the numbers above invite exactly this conclusion and cannot
  // support it.
  console.log('These are cost, rounds and time. Whether the work is any good is not measured here.')
  return 0
}

/**
 * Commits of the directories this task's sessions ran in, inside the delivery window.
 *
 * Deduped by sha: two sessions of one task routinely share a checkout, and the same commit read
 * twice would double every count in the evidence block.
 */
async function collectCommits(
  rows: readonly ManagedSession[],
  afterIso: string,
  beforeIso: string,
): Promise<EvidenceCommit[]> {
  const dirs = [...new Set(rows.map(r => r.cwd).filter(Boolean))]
  const bySha = new Map<string, EvidenceCommit>()
  for (const dir of dirs) {
    for (const c of await getCommitsInWindow(dir, afterIso, beforeIso)) {
      if (!bySha.has(c.sha)) bySha.set(c.sha, c)
    }
  }
  return [...bySha.values()]
}

async function runMark(ref: string, to: 'delivered' | 'abandoned', json: boolean): Promise<number> {
  const { store, rows, book } = await loadEverything()
  const task = findTask(ref, book.tasks)
  if (!task) {
    console.error(`No task matches "${ref}". \`agentop task ls\` lists them.`)
    return 1
  }
  const now = new Date().toISOString()
  const mine = rowsOfTask(task, rows)

  await store.patchTask(task.id, {
    status: to,
    updatedAt: now,
    ...(to === 'delivered' ? { deliveredAt: now } : {}),
  })
  for (const a of book.attempts.filter(a => a.taskId === task.id && a.status === 'running')) {
    await store.patchAttempt(a.id, {
      status: to,
      updatedAt: now,
      ...(to === 'delivered' ? { deliveredAt: now } : {}),
    })
  }
  // A finished name also leaves `preferences.finishedTasks`, so the two places a task's state can
  // be read never disagree — the cockpit's own `finishTask` reads that list.
  const prefs = await readPreferences().catch(() => ({}) as Awaited<ReturnType<typeof readPreferences>>)
  const current = prefs.finishedTasks ?? []
  const next = to === 'delivered'
    ? [...new Set([...current, task.title])]
    : current.filter(t => t !== task.title)
  if (next.length !== current.length) await writePreferences({ finishedTasks: next }).catch(() => undefined)

  // ABANDONED attaches no evidence. Commits under an attempt that was given up on would read as a
  // delivery, which is the one thing this record must not say.
  if (to === 'abandoned') {
    console.log(`"${task.title}" marked abandoned.`)
    return 0
  }

  const startedMs = Date.parse(task.createdAt) || 0
  const evidence = planDeliveryEvidence({
    startedMs,
    deliveredMs: Date.parse(now),
    commits: await collectCommits(mine, task.createdAt, now),
  })
  if (json) {
    console.log(JSON.stringify({ task: task.id, status: to, evidence }, null, 2))
    return 0
  }
  console.log(`"${task.title}" marked delivered.`)
  if (evidence.empty) {
    // A delivery with no commit is still a delivery. Saying so beats an empty block that reads as
    // a failed read.
    console.log('No commits found in this window — the delivery stands on its own.')
    return 0
  }
  console.log(`${evidence.commits.length} commit(s) in the window`
    + (evidence.pullRequests.length > 0
      ? `, PR ${evidence.pullRequests.map(n => `#${n}`).join(' ')}`
      : ''))
  return 0
}

function printHelp(): void {
  console.log(`agentop task — the deliveries your sessions are filed under.

  agentop task                 list every task with its rollup
  agentop task show <id|name>  one task, its attempts side by side
  agentop task deliver <ref>   mark it done, and attach the git evidence
  agentop task abandon <ref>   mark it given up on (no evidence attached)

  --json  machine-readable output

A task is started by filing sessions under one:
  agentop session batch --task "landing page" --attempt "opus, prompt only" --session "claude: …"`)
}

export async function runTask(argv: string[]): Promise<number> {
  const cmd: TaskCommand = parseTaskArgs(argv)
  switch (cmd.kind) {
    case 'help': printHelp(); return 0
    case 'error': console.error(cmd.message); return 1
    case 'ls': return await runLs(cmd.json === true)
    case 'show': return await runShow(cmd.ref, cmd.json === true)
    case 'deliver': return await runMark(cmd.ref, 'delivered', cmd.json === true)
    case 'abandon': return await runMark(cmd.ref, 'abandoned', cmd.json === true)
  }
}
