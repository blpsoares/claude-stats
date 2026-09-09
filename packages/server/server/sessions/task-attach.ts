/**
 * task-attach.ts — PURE. What a session is filed under, and the fact that it is exactly one thing.
 *
 * **A session is filed under a TASK or under one of its SUBTASKS. Never both, and never two.**
 * That is the whole point of this module: the exclusivity is one rule in one place, so a second
 * surface cannot invent a session that appears in the delivery's own list AND in a subtask's, where
 * a reader would count it twice and neither list would be the truth.
 *
 * The parent id is still STORED beside the subtask id, and that is not a contradiction — it is the
 * derived half of the same fact. A subtask belongs to a task, so a session filed under the subtask
 * is a session of that task, and the delivery's cost has to keep including it (that is what makes
 * the total close: direct sessions + every subtask's = the delivery). The invariant is therefore
 * one-directional and absolute:
 *
 *   `subtaskId` set  ⟹  `taskId` is that subtask's OWN task.
 *
 * Nothing else may write the pair. `planAttach` is the only thing that decides it, so the two ids
 * cannot drift into naming different deliveries — which would put a session's cost on one task and
 * its row on another.
 *
 * MOVING is the operation, never adding: filing under a subtask CLEARS nothing but replaces where
 * the row belongs, and filing under a task clears the subtask outright. Re-filing into a DIFFERENT
 * task clears it too, because a subtask of one delivery cannot own a session of another.
 */

export interface AttachSubtask {
  id: string
  taskId: string
}

/** Where the caller asked the session to go. */
export type AttachTarget =
  | { kind: 'task'; id: string }
  | { kind: 'subtask'; id: string }
  /** Unfile it entirely. */
  | { kind: 'none' }

export type AttachPlan =
  | { ok: true; taskId: string | null; subtaskId: string | null }
  | { ok: false; reason: 'no_such_task' | 'no_such_subtask' }

export function planAttach(o: {
  target: AttachTarget
  /** The task ids that exist. A target naming none of them is refused, never guessed. */
  taskIds: readonly string[]
  subtasks: readonly AttachSubtask[]
}): AttachPlan {
  if (o.target.kind === 'none') return { ok: true, taskId: null, subtaskId: null }

  if (o.target.kind === 'task') {
    if (!o.taskIds.includes(o.target.id)) return { ok: false, reason: 'no_such_task' }
    // The subtask is CLEARED, not left behind. A row keeping a stale `subtaskId` would go on being
    // drawn under a subtask it was explicitly moved out of.
    return { ok: true, taskId: o.target.id, subtaskId: null }
  }

  const wanted = o.target.id
  const sub = o.subtasks.find(s => s.id === wanted)
  if (!sub) return { ok: false, reason: 'no_such_subtask' }
  // The parent comes from the SUBTASK, never from the caller: that is what makes the two ids
  // incapable of naming different deliveries.
  return { ok: true, taskId: sub.taskId, subtaskId: sub.id }
}

/**
 * What a row is filed under, read back — the single answer every surface renders.
 *
 * A `subtaskId` wins over the `taskId` beside it, because the pair means "this session belongs to
 * this subtask, which belongs to this task". Reading both as two attachments is exactly the
 * double-counting this module exists to make impossible.
 */
export function filedUnder(row: { taskId?: string; subtaskId?: string }): AttachTarget {
  if (row.subtaskId) return { kind: 'subtask', id: row.subtaskId }
  if (row.taskId) return { kind: 'task', id: row.taskId }
  return { kind: 'none' }
}

/**
 * Is this row's pair internally consistent?
 *
 * Used to REPAIR on read rather than to trust: a subtask deleted while a session pointed at it, or
 * a record written by an older build, leaves a `subtaskId` naming nothing. Such a row falls back to
 * its task — the delivery is still true — rather than disappearing from both lists.
 */
export function reconcileAttachment(
  row: { taskId?: string; subtaskId?: string },
  subtasks: readonly AttachSubtask[],
): { taskId: string | null; subtaskId: string | null } {
  if (!row.subtaskId) return { taskId: row.taskId ?? null, subtaskId: null }
  const sub = subtasks.find(s => s.id === row.subtaskId)
  if (!sub) return { taskId: row.taskId ?? null, subtaskId: null }
  return { taskId: sub.taskId, subtaskId: sub.id }
}
