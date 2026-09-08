/**
 * cli-task.ts — `agentop task`. The DRAWING, and nothing else.
 *
 * Every rule lives beside it: `task-source.ts` reads, `task-report.ts` resolves, `task-rollup.ts`
 * computes, `task-web.ts` serves the same answers over HTTP. This file turns them into lines.
 *
 * THE THREE THINGS IT MUST SAY, and never imply:
 *  - a metric the harness cannot produce prints `N/A`, never `0`;
 *  - a cost states how many of the attempt's sessions it actually covers;
 *  - an attempt mixing dollars and Copilot credits prints BOTH and no total, because a sum of the
 *    two is not a number.
 */

import { loadTaskWorld } from './task-source'
import { buildTaskDetail, buildTaskList, findTask, type AttemptView } from './task-report'
import { markTask } from './task-web'
import { parseTaskArgs, type TaskCommand } from './task-parse'
import type { TaskStatus } from './task-model'
import type { AttemptRollup } from './task-rollup'

const NA = 'N/A'






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



async function runLs(json: boolean): Promise<number> {
  const w = await loadTaskWorld()
  if (w.book.tasks.length === 0) {
    console.log('No tasks yet. `agentop session batch --task "<name>" --attempt "<config>" …` starts one.')
    return 0
  }
  const listed = buildTaskList({
    tasks: w.book.tasks, attempts: w.book.attempts, rows: w.rows, metas: w.metas, costOf: w.costOf,
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
  const w = await loadTaskWorld()
  const task = findTask(ref, w.book.tasks)
  if (!task) {
    console.error(`No task matches "${ref}". \`agentop task ls\` lists them.`)
    return 1
  }
  const detail = buildTaskDetail({
    task, attempts: w.book.attempts, rows: w.rows, metas: w.metas, costOf: w.costOf,
  })
  if (json) {
    console.log(JSON.stringify(detail, null, 2))
    return 0
  }
  console.log(`${detail.task.title}  [${detail.task.status}]`)
  if (detail.task.deliveredAt) console.log(`delivered ${detail.task.deliveredAt}`)
  console.log('')
  for (const v of detail.attempts) console.log(attemptBlock(v).join('\n'))
  // Said once, at the foot, because the numbers above invite exactly this conclusion and cannot
  // support it.
  console.log('These are cost, rounds and time. Whether the work is any good is not measured here.')
  return 0
}

/** One attempt, as lines. */
function attemptBlock(v: AttemptView): string[] {
  const cfg = v.config
    ? [v.config.harness, v.config.model, v.config.effort, v.config.method].filter(Boolean).join(' · ')
    : ''
  return [
    `  ${v.label}${cfg ? `  (${cfg})` : ''}  [${v.status}]`,
    ...rollupLines(v.rollup),
    '',
  ]
}

async function runMark(ref: string, to: TaskStatus, json: boolean): Promise<number> {
  const out = await markTask(ref, to)
  if (!out.ok) {
    console.error(`No task matches "${ref}". \`agentop task ls\` lists them.`)
    return 1
  }
  if (json) {
    console.log(JSON.stringify(out, null, 2))
    return 0
  }
  if (to !== 'done') {
    console.log(`"${ref}" is now ${to}.`)
    return 0
  }
  console.log(`"${ref}" marked delivered.`)
  const e = out.evidence
  if (!e || e.empty) {
    // A delivery with no commit is still a delivery. Saying so beats an empty block that reads as
    // a failed read.
    console.log('No commits found in this window — the delivery stands on its own.')
    return 0
  }
  console.log(`${e.commits.length} commit(s) in the window`
    + (e.pullRequests.length > 0 ? `, PR ${e.pullRequests.map(n => `#${n}`).join(' ')}` : ''))
  return 0
}

/**
 * Turn sharing on or off for one delivery.
 *
 * The confirmation SAYS what the state now means, rather than echoing the verb: "shared" alone
 * does not tell anybody that a description and every comment now travel, and this is the command's
 * only chance to say it.
 */
async function runShare(ref: string, on: boolean, json: boolean): Promise<number> {
  const { editTask } = await import('./task-web')
  const ok = await editTask(ref, { shared: on, actor: 'cli' })
  if (!ok) {
    console.error(`No task matches "${ref}". \`agentop task ls\` lists them.`)
    return 1
  }
  if (json) {
    console.log(JSON.stringify({ ok, ref, shared: on }, null, 2))
    return 0
  }
  console.log(on
    ? `"${ref}" now travels to this machine's centrals: its title, description, comments, subtasks`
      + ' and file names. The files themselves stay here, and its sessions still follow this'
      + ' connection\'s sharing rules.'
    : `"${ref}" stays on this machine. Nothing of it travels.`)
  return 0
}

function printHelp(): void {
  console.log(`agentop task — the deliveries your sessions are filed under.

  agentop task                 list every task with its rollup
  agentop task show <id|name>  one task, its attempts side by side
  agentop task deliver <ref>   mark it done, and attach the git evidence
  agentop task abandon <ref>   mark it given up on (no evidence attached)
  agentop task share <ref>     let it travel to this machine's centrals
  agentop task unshare <ref>   keep it on this machine (the default: absent means NOT shared)

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
    case 'deliver': return await runMark(cmd.ref, 'done', cmd.json === true)
    case 'abandon': return await runMark(cmd.ref, 'abandoned', cmd.json === true)
    case 'share': return await runShare(cmd.ref, cmd.on, cmd.json === true)
  }
}
