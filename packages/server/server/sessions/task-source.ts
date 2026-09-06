/**
 * task-source.ts — the IO behind every task surface: the book, the fleet, the store.
 *
 * One reader, so the CLI and the HTTP route (and therefore the web and the MCP) can never disagree
 * about which sessions a task holds. The arithmetic on top of it is the pure `task-report.ts`.
 */

import { TASKS_FILE } from '../config'
import { loadConsolidated } from '../consolidate'
import { sessionCostUSD } from '../member-metrics'
import { readPreferences } from '../preferences'
import { readRegistry } from './registry'
import { createTaskStore, type TaskStore } from './task-store'
import { migrateLegacyTasks, type TaskBook } from './task-model'
import type { ManagedSession } from './types'
import type { SessionMeta } from '@agentistics/core'

export interface TaskWorld {
  store: TaskStore
  book: TaskBook
  rows: ManagedSession[]
  metas: ReadonlyMap<string, SessionMeta>
  costOf: (m: SessionMeta) => number
}

/**
 * Make sure every task name a person has already typed exists in the book.
 *
 * Idempotent by construction: `legacyTaskId` derives the id from the name, so a name already
 * carried is skipped and a second run changes nothing. Only what is MISSING is written — a task
 * already in the book may have been renamed or delivered since, and re-upserting the derived
 * record would undo that.
 */
async function ensureLegacyTasks(store: TaskStore, rows: readonly ManagedSession[]): Promise<void> {
  const finished = await readPreferences()
    .then(p => p.finishedTasks ?? [])
    .catch(() => [] as string[])
  const names = rows.map(r => r.task).filter((t): t is string => Boolean(t))
  if (names.length === 0 && finished.length === 0) return

  const book = await store.read()
  const knownIds = new Set(book.tasks.map(t => t.id))
  // A name that already exists as a TITLE is already this task, whatever its id. Checking only the
  // derived id created a duplicate the moment a task was marked done: `markTask` mirrors the title
  // into `preferences.finishedTasks`, the migration read it back as a legacy name, and minted a
  // second task under `legacyTaskId(title)` beside the real one. Seen on a live board.
  const knownTitles = new Set(book.tasks.map(t => t.title))
  // A task the user DELETED is not re-minted. Without this the migration resurrected it on the very
  // next read and the delete button read as broken.
  const buried = new Set(book.tombstones)
  const now = new Date().toISOString()
  for (const t of migrateLegacyTasks({ names, finished, now })) {
    if (knownIds.has(t.id) || knownTitles.has(t.title) || buried.has(t.id)) continue
    await store.upsertTask(t)
  }
}

export async function loadTaskWorld(): Promise<TaskWorld> {
  const store = createTaskStore(TASKS_FILE)
  const rows = await readRegistry()
  await ensureLegacyTasks(store, rows)
  const [book, metas] = await Promise.all([
    store.read(),
    // The store is an enrichment, never a prerequisite: one that cannot be read costs the money
    // column, not the list.
    loadConsolidated().catch(() => new Map<string, SessionMeta>()),
  ])
  return { store, book, rows, metas, costOf: sessionCostUSD }
}
