/**
 * team-tasks.ts — per-member DELIVERY storage on the central.
 *
 * Mirrors `team-workflows.ts` line for line, because a new collection keyed by the machine id has
 * exactly one shape in this codebase and inventing a second one is how a rotation strands it.
 *
 * What arrives is `SharedTask` and nothing else: the record its owner opted in
 * (`Task.shared`), the comments, subtasks and file NAMES that hang off it, and the ids of the
 * sessions this connection already shares. No cost, no rounds, no tokens — the central resolves
 * those through the same `task-rollup.ts` the local board uses, over the sessions it already
 * holds, so a delivery cannot cost one thing on the machine and another here.
 *
 * DATES. `createdAt` / `updatedAt` / `deliveredAt` are hoisted to the top level of the document as
 * BSON Dates, which is what `DATE_FIELDS` migrates and what a query can index. The timestamps
 * INSIDE the board (a comment's `createdAt`, a subtask's two) are converted by this module's own
 * boundary functions and never by the migration: this collection is new, its only writer is
 * `toTeamTaskDoc`, and there is therefore no legacy document holding a string for the migration to
 * find. `dueDate` / `startDate` stay STRINGS on purpose — they are `yyyy-MM-dd`, a date somebody
 * scheduled and not an instant, the same treatment `TagDoc.window` already gets.
 */

import type {
  SharedSubtask, SharedTask, SharedTaskComment, SharedTaskFile, SharedTaskRecord,
} from '@agentistics/core'
import { redactSharedTask } from '@agentistics/core'
import { getMongoDb } from './mongo'
import { toBsonDate, fromBsonDate, type StoredDate } from './mongo-dates'
import type { Collection } from 'mongodb'

type StoredRecord = Omit<SharedTaskRecord, 'createdAt' | 'updatedAt' | 'deliveredAt'>
type StoredComment = Omit<SharedTaskComment, 'createdAt'> & { createdAt: Date | null }
type StoredSubtask = Omit<SharedSubtask, 'createdAt' | 'updatedAt'> & {
  createdAt: Date | null; updatedAt: Date | null
}
type StoredFile = Omit<SharedTaskFile, 'createdAt'> & { createdAt: Date | null }

export type TeamTaskDoc = StoredRecord & {
  _id: string
  org: string
  /** Stable token identity key (SHA-256 hash of the bearer token). */
  memberId: string
  /** Cached display name as of the last ingest; overridden at read time by getMemberNameMap(). */
  user: string
  createdAt: Date | null
  updatedAt: Date | null
  deliveredAt?: Date | null
  comments: StoredComment[]
  subtasks: StoredSubtask[]
  files: StoredFile[]
  sessionIds: string[]
  sessionsWithheld: number
}

/** The team deliveries collection, typed. */
export async function getTasksCollection(): Promise<Collection<TeamTaskDoc>> {
  const database = await getMongoDb()
  return database.collection<TeamTaskDoc>('tasks')
}

/** Stable, collision-safe Mongo _id keyed by memberId (token hash), mirroring teamDocId(). */
export function teamTaskDocId(org: string, memberId: string, taskId: string): string {
  return `${org}:${memberId}:${taskId}`
}

/**
 * Map a `SharedTask` + identity to a Mongo doc. Pure — does not mutate the input.
 *
 * The text is scrubbed HERE as well as on the member. That is not belt-and-braces: a central
 * cannot assume its members run current code, and in a mixed-version fleet the machine on the old
 * build is exactly the one that leaks. Same rule `toTeamDoc` already follows for `first_prompt`.
 */
export function toTeamTaskDoc(
  shared: SharedTask, org: string, memberId: string, user: string,
): TeamTaskDoc {
  const safe = redactSharedTask(shared)
  const { createdAt, updatedAt, deliveredAt, ...rest } = safe.task
  return {
    ...rest,
    org,
    memberId,
    user,
    _id: teamTaskDocId(org, memberId, safe.task.id),
    createdAt: toBsonDate(createdAt),
    updatedAt: toBsonDate(updatedAt),
    ...(deliveredAt !== undefined ? { deliveredAt: toBsonDate(deliveredAt) } : {}),
    comments: safe.comments.map(c => ({ ...c, createdAt: toBsonDate(c.createdAt) })),
    subtasks: safe.subtasks.map(s => ({
      ...s, createdAt: toBsonDate(s.createdAt), updatedAt: toBsonDate(s.updatedAt),
    })),
    files: safe.files.map(f => ({ ...f, createdAt: toBsonDate(f.createdAt) })),
    sessionIds: [...safe.sessionIds],
    sessionsWithheld: safe.sessionsWithheld,
  }
}

/** As read back: every stored date may still be a string in a doc an older build wrote. */
type ReadableTaskDoc = Omit<TeamTaskDoc, 'createdAt' | 'updatedAt' | 'deliveredAt' | 'comments' | 'subtasks' | 'files'> & {
  createdAt?: StoredDate
  updatedAt?: StoredDate
  deliveredAt?: StoredDate
  comments?: (Omit<StoredComment, 'createdAt'> & { createdAt?: StoredDate })[]
  subtasks?: (Omit<StoredSubtask, 'createdAt' | 'updatedAt'> & { createdAt?: StoredDate; updatedAt?: StoredDate })[]
  files?: (Omit<StoredFile, 'createdAt'> & { createdAt?: StoredDate })[]
}

/** Map a Mongo doc back to the wire shape. Pure. Reads a legacy string date identically. */
export function fromTeamTaskDoc(doc: ReadableTaskDoc): SharedTask {
  const {
    _id, org, memberId, user, createdAt, updatedAt, deliveredAt,
    comments, subtasks, files, sessionIds, sessionsWithheld, ...rest
  } = doc
  void _id; void org; void memberId; void user
  return {
    task: {
      ...rest,
      createdAt: fromBsonDate(createdAt),
      updatedAt: fromBsonDate(updatedAt),
      ...(deliveredAt !== undefined ? { deliveredAt: fromBsonDate(deliveredAt) } : {}),
    },
    comments: (comments ?? []).map(c => ({ ...c, createdAt: fromBsonDate(c.createdAt) })),
    subtasks: (subtasks ?? []).map(s => ({
      ...s, createdAt: fromBsonDate(s.createdAt), updatedAt: fromBsonDate(s.updatedAt),
    })),
    files: (files ?? []).map(f => ({ ...f, createdAt: fromBsonDate(f.createdAt) })),
    sessionIds: sessionIds ?? [],
    sessionsWithheld: sessionsWithheld ?? 0,
  }
}

/**
 * Upsert every shared delivery, keyed by org:memberId:taskId. Idempotent. Returns the count.
 *
 * A task the member stops sharing simply stops arriving — withdrawing it from the central is
 * `deleteMemberTasks`'s job, driven by the member the way `team-forget-client.ts` withdraws
 * sessions. Nothing here decides that a missing task means a deleted one: a short read is not a
 * retraction, which is the rule `planRulesReconcile` exists to state.
 */
export async function ingestTasks(
  org: string, memberId: string, user: string, tasks: SharedTask[],
): Promise<number> {
  if (tasks.length === 0) return 0
  const col = await getTasksCollection()
  const ops = tasks.filter(t => t.task?.id).map(t => {
    const doc = toTeamTaskDoc(t, org, memberId, user)
    return { replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } }
  })
  if (ops.length === 0) return 0
  await col.bulkWrite(ops, { ordered: false })
  return ops.length
}

/** Every stored delivery of every machine, with the machine it belongs to. */
export interface TeamTask {
  memberId: string
  user: string
  shared: SharedTask
}

export async function loadAllTeamTasks(
  nameMap: Record<string, string> = {},
): Promise<TeamTask[]> {
  const col = await getTasksCollection()
  const docs = await col.find({}).toArray()
  return docs.map(d => ({
    memberId: d.memberId,
    // The live tokens table wins over the cached name, so a rename shows immediately without a
    // re-ingest — the rule `loadAllTeamWorkflows` already follows.
    user: nameMap[d.memberId] ?? d.user,
    shared: fromTeamTaskDoc(d as unknown as ReadableTaskDoc),
  }))
}

/** Drop every delivery of one machine — used by revoke and by the member's own withdrawal. */
export async function deleteMemberTasks(memberId: string): Promise<number> {
  const col = await getTasksCollection()
  const res = await col.deleteMany({ memberId })
  return res.deletedCount ?? 0
}

/**
 * Carry a machine's deliveries across a token rotation.
 *
 * `memberId` IS the machine's identity, and `_id` embeds it, so the documents are rebuilt rather
 * than updated in place. Enumerated in `rotate-identity.ts`: a collection keyed by the machine id
 * and not listed there is silently stranded, which that module's header records as the same bug
 * three times already.
 */
export async function rekeyMemberTasks(oldId: string, newId: string): Promise<number> {
  const col = await getTasksCollection()
  const docs = await col.find({ memberId: oldId }).toArray()
  if (docs.length === 0) return 0
  const migrated = docs.map(d => ({
    ...d, memberId: newId, _id: teamTaskDocId(d.org, newId, d.id),
  }))
  await col.insertMany(migrated as never, { ordered: false }).catch(() => {})
  await col.deleteMany({ memberId: oldId })
  return docs.length
}
