/**
 * taskSuggest.ts — PURE. Which delivery a new session in this folder probably belongs to.
 *
 * Filing happens at spawn or it mostly does not happen at all, and a field somebody has to fill in
 * from memory is a field they leave empty. So the form proposes one — and everything here exists to
 * make that proposal trustworthy rather than merely present:
 *
 *  - it is a SUGGESTION, never a default that is applied silently: the caller shows it filled in,
 *    says WHY, and offers to clear it;
 *  - it NEVER INVENTS. No evidence, or evidence that points two ways, yields `null` and an empty
 *    field. A wrong suggestion accepted without reading is worse than no suggestion, because it
 *    files work under a delivery nobody chose and the metrics of BOTH are then wrong.
 *
 * The rule is PLURALITY, not recency: a fleet row carries no timestamp (see `FleetRow` — the wire
 * has no `createdAt`), so "the most recent session's delivery" is not computable here. What the
 * browser can see is how many sessions of this exact folder are filed where, which is also exactly
 * what the reason sentence says out loud.
 */

/** The minimum a caller must supply per session — satisfied by `FleetRow`. */
export interface SuggestSession {
  cwd: string
  /** The delivery's TITLE. The id lives on the server's record, never on the fleet wire. */
  task?: string
}

/** The minimum a caller must supply per delivery — satisfied by the board's `TaskRecord`. */
export interface SuggestTask {
  id: string
  title: string
  status: string
}

export interface DeliverySuggestion {
  taskId: string
  title: string
  /** How many sessions of this folder are filed there — the reason, shown to the reader. */
  sameFolder: number
}

/** A delivery that is finished takes no new work: filing into it would corrupt its own duration. */
const OPEN = (status: string): boolean => status !== 'done' && status !== 'abandoned'

/** Trailing separators only. Anything else would make two spellings of one folder two folders. */
function normalizeDir(dir: string): string {
  return dir.replace(/[/\\]+$/, '')
}

export function suggestDelivery(o: {
  cwd: string
  sessions: readonly SuggestSession[]
  tasks: readonly SuggestTask[]
}): DeliverySuggestion | null {
  const here = normalizeDir(o.cwd)
  if (!here) return null

  // By TITLE, because that is the only join this side can make — the same honest join
  // `SessionTasksTab` performs. `createTask` refuses a duplicate title, so a match is unambiguous;
  // a title matching no delivery (renamed, deleted) simply matches nothing.
  const open = new Map<string, SuggestTask>()
  for (const t of o.tasks) if (OPEN(t.status)) open.set(t.title, t)

  const counts = new Map<string, number>()
  for (const s of o.sessions) {
    // EXACTLY this folder. A prefix match would offer a repository's delivery to a worktree doing
    // something else entirely, which is the confident-wrong answer this module exists to avoid.
    if (normalizeDir(s.cwd) !== here) continue
    if (!s.task) continue
    const task = open.get(s.task)
    if (!task) continue
    counts.set(task.id, (counts.get(task.id) ?? 0) + 1)
  }
  if (counts.size === 0) return null

  let best: { id: string; n: number } | null = null
  let tied = false
  for (const [id, n] of counts) {
    if (!best || n > best.n) { best = { id, n }; tied = false }
    else if (n === best.n) tied = true
  }
  // A tie is the folder genuinely holding two deliveries. Picking one would be a coin flip wearing
  // the clothes of a recommendation, so it says nothing instead.
  if (!best || tied) return null

  const task = o.tasks.find(t => t.id === best!.id)
  if (!task) return null
  return { taskId: task.id, title: task.title, sameFolder: best.n }
}
