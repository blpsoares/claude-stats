/**
 * sharedTask.ts — what a delivery looks like ON THE WIRE, and nothing more.
 *
 * The board is a local store. A task travels to a central only when its owner says so
 * (`Task.shared`, absent reading as NOT shared), and what travels is this shape — a LIST, exactly
 * like `redactSessionText`'s list of free-text fields, and for the same reason: a field added to
 * the server's `Task` does not reach a central until somebody adds it HERE and decides that it
 * should. A wire type derived automatically from the record would ship every future field by
 * default, which is the opposite of an opt-in.
 *
 * Three deliberate absences:
 *
 *  - **No numbers.** No cost, no rounds, no token totals. The central already holds the sessions
 *    this machine shares with it, so it resolves the rollup through the very `task-rollup.ts` the
 *    local board uses. A total computed on the member and shipped would be a second answer to
 *    "what did this delivery cost", and the two would drift.
 *  - **No claim.** A lease lasts 30 minutes and the push cadence is seconds to minutes, so a claim
 *    arrives already stale and reads as "somebody is on this right now" long after they stopped.
 *    Who is working on what is a question for the machine that can see its own fleet.
 *  - **No file bytes.** The central learns that N files exist and what they are called; fetching
 *    one is an on-demand pull over the reverse channel, the way raw chat already works.
 */

/** The fields of a task that travel. Structural on purpose — core imports nothing of the server. */
export interface SharedTaskRecord {
  id: string
  title: string
  detail?: string
  status: string
  createdAt: string
  updatedAt: string
  deliveredAt?: string
  priority?: string
  assignee?: string
  dueDate?: string
  startDate?: string
  labels?: string[]
  /** Kept because a blocked card that does not say what it waits on is a card nobody can unblock. */
  blockedReason?: string
  repo?: string
  blockedBy?: string[]
}

export interface SharedTaskComment {
  id: string
  author: string
  body: string
  createdAt: string
}

export interface SharedSubtask {
  id: string
  title: string
  done: boolean
  status: string
  createdAt: string
  updatedAt: string
  assignee?: string
  dueDate?: string
  startDate?: string
  notes?: string
}

/** A file's IDENTITY, never its bytes. */
export interface SharedTaskFile {
  id: string
  name: string
  size: number
  kind?: string
  author?: string
  createdAt: string
}

export interface SharedTask {
  task: SharedTaskRecord
  comments: SharedTaskComment[]
  subtasks: SharedSubtask[]
  files: SharedTaskFile[]
  /**
   * The sessions of this task that this connection SHARES — decided by `sessionShared`, unchanged.
   * A shared task whose work sits in a withheld repository ships its record and none of its
   * sessions.
   */
  sessionIds: string[]
  /**
   * How many of its sessions this connection withholds.
   *
   * Sent so the central can SAY the delivery is measured short, exactly as `withheld` already does
   * for the fleet. A count that silently shrank is the same defect as a confident zero: the figure
   * is smaller and nothing on screen explains why.
   */
  sessionsWithheld: number
}
