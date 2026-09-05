/**
 * task-model.ts — what a Task and an Attempt ARE. Pure: no clock, no filesystem.
 *
 * Three levels, and the middle one is not optional. A Task is the work ("landing page for a
 * pizzeria"); an Attempt is one CONFIGURATION of that work ("opus, prompt only"); the sessions hang
 * off the attempt. Without the middle level, running one task under four configurations produces
 * one task holding a dozen unattributed sessions and nothing is comparable, which is the whole
 * point of the feature.
 *
 * See docs/superpowers/specs/2026-09-05-task-measurement-design.md.
 */

import { createHash, randomUUID } from 'node:crypto'
import type { HarnessId } from '@agentistics/core'

export type TaskStatus = 'open' | 'delivered' | 'abandoned'

/**
 * `abandoned` is first-class on purpose. An attempt that was given up on is the most informative
 * row in a comparison; treating it as merely "still open" quietly inflates every average.
 */
export type AttemptStatus = 'running' | 'delivered' | 'abandoned'

/**
 * How a session's conversation link was established — carried into every rollup.
 *
 * `assigned` the CLI was handed the id (`SpawnSpec.assignId`; claude and copilot only).
 * `observed`  claimed once at first sighting (`task-attribution.ts`).
 * `none`      no link: the session contributes rounds and time, and no cost or tokens.
 */
export type LinkProvenance = 'assigned' | 'observed' | 'none'

export interface AttemptConfig {
  harness: HarnessId
  model?: string
  effort?: string
  /** Free text: "sdd", "prompt only", "opus spec then sonnet". The method is not a closed set. */
  method?: string
}

export interface Task {
  id: string
  title: string
  detail?: string
  status: TaskStatus
  createdAt: string
  updatedAt: string
  deliveredAt?: string
  /** `normalizeGitRemote` key, when the work belongs to one repository. */
  repo?: string
}

export interface Attempt {
  id: string
  taskId: string
  label: string
  config: AttemptConfig
  status: AttemptStatus
  startedAt: string
  updatedAt: string
  deliveredAt?: string
}

export interface TaskBook {
  tasks: Task[]
  attempts: Attempt[]
}

function shortHex(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 10)
}

function mint(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 10)}`
}

export function newTaskId(): string {
  return mint('t')
}

export function newAttemptId(): string {
  return mint('a')
}

/**
 * The id a legacy free-text task name resolves to.
 *
 * DERIVED from the name rather than minted, which is what makes the migration idempotent: every
 * existing `ManagedSession.task` string already points at its Task without the row being rewritten,
 * and running the migration twice cannot produce two Tasks for one name.
 *
 * The name is hashed VERBATIM. Folding case or trimming would merge two names the user deliberately
 * typed apart, and a board that silently merges two pieces of work is worse than one carrying a
 * near-duplicate.
 */
export function legacyTaskId(name: string): string {
  return `legacy-${shortHex(name)}`
}

/**
 * Every legacy task name, as Tasks.
 *
 * `finished` names are carried even when no session still references them:
 * `preferences.finishedTasks` outlives the sessions it was about, and a delivery that happened is
 * not erased by its rows being cleaned up.
 */
export function migrateLegacyTasks(o: {
  names: readonly string[]
  finished: readonly string[]
  now: string
}): Task[] {
  const finished = new Set(o.finished)
  const seen = new Set<string>()
  const out: Task[] = []
  for (const title of [...o.names, ...o.finished]) {
    if (!title || seen.has(title)) continue
    seen.add(title)
    const delivered = finished.has(title)
    out.push({
      id: legacyTaskId(title),
      title,
      status: delivered ? 'delivered' : 'open',
      createdAt: o.now,
      updatedAt: o.now,
      ...(delivered ? { deliveredAt: o.now } : {}),
    })
  }
  return out
}
