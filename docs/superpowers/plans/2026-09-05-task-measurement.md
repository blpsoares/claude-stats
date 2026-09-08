# Task Measurement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one delivery measurable — attribute sessions to a Task and an Attempt at spawn, and report cost, rounds and sessions-used per attempt.

**Architecture:** Three pure modules (`task-model.ts`, `task-attribution.ts`, `task-rollup.ts`) hold all the rules and do no I/O; one store (`task-store.ts`) follows the `createLocalTagStore` shape wrapped in the existing cross-process `withFileLock`; two fields on `ManagedSession` are stamped at the existing `addSession` call sites. Nothing in this plan draws a screen.

**Tech Stack:** TypeScript (strict), Bun, `bun:test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-05-task-measurement-design.md`

**Worktree:** `.claude/worktrees/task-alm`, branch `feat/task-measurement`, based on `origin/dev`.

## Global Constraints

- **Everything in English** — code, comments, commit messages, docs.
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`).
- **Pure modules never do I/O.** `task-model.ts`, `task-attribution.ts` and `task-rollup.ts` import no `node:fs` and call no clock — every timestamp and every list arrives as an argument. That is what makes them testable without a filesystem.
- **A missing metric is `null`, never `0`.** `HARNESS_CAPABILITIES` decides. A confident zero is the failure this codebase is built against.
- **Copilot credits are never converted to dollars** and never summed with a token-derived cost.
- **Never widen an existing type's meaning.** `ManagedSession.task` (free text) stays and keeps working; the new fields sit beside it.
- **Stage explicit paths.** `git add <path>`, never `git add -A` — other sessions work in this repo concurrently.
- **Run `bun test <file>` for the file you changed** while iterating. The pre-commit hook runs `bun tsc --noEmit` plus the full suite.

## Out of scope for this plan

The cockpit band header, the web page, the attempt-comparison screen, the MCP tools and `cost-state` adoption. Each is its own plan. This one ends with `agentop task show` printing a rollup, which is a usable product on its own.

## File Structure

| File | Responsibility |
|---|---|
| `packages/server/server/sessions/task-model.ts` | **Pure.** Task/Attempt types, id minting, the legacy `task`-string migration. |
| `packages/server/server/sessions/task-model.test.ts` | Its tests. |
| `packages/server/server/sessions/task-store.ts` | The `~/.agentistics/tasks.json` store. The only file here that touches disk. |
| `packages/server/server/sessions/task-store.test.ts` | Its tests, against a real temp directory. |
| `packages/server/server/sessions/task-attribution.ts` | **Pure.** The first-sighting claim and, above all, its refusals. |
| `packages/server/server/sessions/task-attribution.test.ts` | Its tests. |
| `packages/server/server/sessions/task-rollup.ts` | **Pure.** The arithmetic, the provenance counts and the units. |
| `packages/server/server/sessions/task-rollup.test.ts` | Its tests. |
| `packages/server/server/sessions/types.ts` | Modify: `ManagedSession` and `SpawnRequest` gain `taskId`/`attemptId`. |
| `packages/server/server/sessions/registry.ts` | Modify: `SessionPatch` and `sanitize` carry the two fields. |
| `packages/server/server/sessions/sessions-host.ts` | Modify: the poller resolves the claim. |
| `packages/server/server/sessions/conversations.ts` | Modify: `Conversation` gains `startedMs`. |
| `packages/server/server/sessions/cli-parse.ts` | Modify: `BatchSpec.attempt`, the `--attempt` grammar, the `task` command. |
| `packages/server/server/sessions/cli-session.ts` | Modify: spawn sites stamp the fields; the `task` handler. |
| `packages/server/server/cli-start.ts` | Modify: the cockpit spawn site stamps the fields. |
| `packages/server/server/config.ts` | Modify: `TASKS_FILE` constant. |

---

### Task 1: The task model (pure)

**Files:**
- Create: `packages/server/server/sessions/task-model.ts`
- Test: `packages/server/server/sessions/task-model.test.ts`

**Interfaces:**
- Consumes: `HarnessId` from `@agentistics/core`.
- Produces: `Task`, `Attempt`, `AttemptConfig`, `TaskBook`, `TaskStatus`, `AttemptStatus`, `LinkProvenance`, `newTaskId(): string`, `newAttemptId(): string`, `legacyTaskId(name: string): string`, `migrateLegacyTasks(o: { names: readonly string[]; finished: readonly string[]; now: string }): Task[]`.

**Why `legacyTaskId` is derived from the name rather than minted:** every existing row carries a free-text `ManagedSession.task`. A minted id would produce two Tasks for one name when the migration ran twice, and an existing row's string would resolve to nothing. Deriving the id from the name makes the migration idempotent and makes every existing row attributable without rewriting it.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/server/sessions/task-model.test.ts
import { describe, expect, it } from 'bun:test'
import { legacyTaskId, migrateLegacyTasks, newAttemptId, newTaskId } from './task-model'

describe('legacyTaskId', () => {
  it('is stable for the same name, so migrating twice yields one task', () => {
    expect(legacyTaskId('ship the parser')).toBe(legacyTaskId('ship the parser'))
  })

  it('separates names that differ only by case or padding, because the user typed them apart', () => {
    // A task name is a label a person chose. Folding case here would silently merge two boards.
    expect(legacyTaskId('Parser')).not.toBe(legacyTaskId('parser'))
    expect(legacyTaskId(' parser')).not.toBe(legacyTaskId('parser'))
  })

  it('is safe as a file key and as a CLI argument', () => {
    expect(legacyTaskId('a/b:c d')).toMatch(/^legacy-[0-9a-f]{10}$/)
  })
})

describe('migrateLegacyTasks', () => {
  const now = '2026-09-05T12:00:00.000Z'

  it('turns every named string into a task, and marks the finished ones delivered', () => {
    const tasks = migrateLegacyTasks({ names: ['ship the parser', 'AIPE'], finished: ['AIPE'], now })
    expect(tasks.map(t => t.title)).toEqual(['ship the parser', 'AIPE'])
    expect(tasks.map(t => t.status)).toEqual(['open', 'delivered'])
    expect(tasks[1]!.deliveredAt).toBe(now)
  })

  it('is idempotent: the same input twice yields identical records', () => {
    const a = migrateLegacyTasks({ names: ['x'], finished: [], now })
    const b = migrateLegacyTasks({ names: ['x'], finished: [], now })
    expect(a).toEqual(b)
  })

  it('carries a finished name that no session still references', () => {
    // `finishedTasks` outlives the sessions it was about. A delivery that happened is not erased by
    // its rows being cleaned up.
    const tasks = migrateLegacyTasks({ names: [], finished: ['gone'], now })
    expect(tasks.map(t => [t.title, t.status])).toEqual([['gone', 'delivered']])
  })

  it('dedupes a name that appears on many sessions', () => {
    const tasks = migrateLegacyTasks({ names: ['x', 'x', 'x'], finished: [], now })
    expect(tasks).toHaveLength(1)
  })
})

describe('id minting', () => {
  it('mints distinct ids that are safe as CLI arguments', () => {
    expect(newTaskId()).not.toBe(newTaskId())
    expect(newTaskId()).toMatch(/^t-[0-9a-f]{10}$/)
    expect(newAttemptId()).toMatch(/^a-[0-9a-f]{10}$/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/server/server/sessions/task-model.test.ts`
Expected: FAIL with `Cannot find module './task-model'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/server/server/sessions/task-model.ts
/**
 * task-model.ts — what a Task and an Attempt ARE. Pure: no clock, no filesystem.
 *
 * Three levels, and the middle one is not optional. A Task is the work ("landing page for a
 * pizzeria"); an Attempt is one CONFIGURATION of that work ("opus, prompt only"); the sessions hang
 * off the attempt. Without the middle level, running one task under four configurations produces
 * one task holding a dozen unattributed sessions and nothing is comparable, which is the whole
 * point of the feature.
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
 * `finished` names are carried even when no session still references them: `preferences.finishedTasks`
 * outlives the sessions it was about, and a delivery that happened is not erased by its rows being
 * cleaned up.
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/server/server/sessions/task-model.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/sessions/task-model.ts \
        packages/server/server/sessions/task-model.test.ts
git commit -m "feat(sessions): the task model, with a legacy migration that cannot double-run

A Task is the work, an Attempt is one configuration of it, and sessions hang
off the attempt. The middle level is what makes 'the same task under four
configs' comparable instead of one task holding a dozen unattributed rows.

legacyTaskId is DERIVED from the free-text name rather than minted, so every
existing ManagedSession.task string already points at its Task without the row
being rewritten, and migrating twice cannot produce two Tasks for one name.
The name is hashed verbatim: folding case would merge two names a person typed
apart."
```

---

### Task 2: The task store

**Files:**
- Create: `packages/server/server/sessions/task-store.ts`
- Test: `packages/server/server/sessions/task-store.test.ts`
- Modify: `packages/server/server/config.ts`

**Interfaces:**
- Consumes: `Task`, `Attempt`, `TaskBook`, `TaskStatus`, `AttemptStatus` from Task 1; `withFileLock` from `./file-lock`.
- Produces: `TaskStore` with `read()`, `upsertTask(t)`, `upsertAttempt(a)`, `patchTask(id, patch)`, `patchAttempt(id, patch)`; `createTaskStore(file: string): TaskStore`; `TaskPatch`; `AttemptPatch`.

**Durability rules are copied from `tags-local-store.ts` and `registry.ts` because they were learned from real losses:** write to `<file>.tmp` then rename, so a crash leaves the old file or the new one and never a truncated one a reader would parse-fail on; quarantine corrupt bytes to `<file>.corrupt-*` rather than overwriting them; a mutation that changes nothing writes nothing; reads never throw. On top of those, every mutation runs under `withFileLock`, because agentop runs as several processes.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/server/sessions/task-store.test.ts
import { describe, expect, it } from 'bun:test'
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createTaskStore } from './task-store'
import type { Task } from './task-model'

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: id,
  status: 'open',
  createdAt: '2026-09-05T10:00:00.000Z',
  updatedAt: '2026-09-05T10:00:00.000Z',
  ...over,
})

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'agentop-tasks-'))
  const file = join(dir, 'tasks.json')
  return { file, s: createTaskStore(file) }
}

describe('createTaskStore', () => {
  it('reads an empty book when the file does not exist', async () => {
    const { s } = await store()
    expect(await s.read()).toEqual({ tasks: [], attempts: [] })
  })

  it('round-trips a task', async () => {
    const { s } = await store()
    await s.upsertTask(task('t-1'))
    expect((await s.read()).tasks.map(t => t.id)).toEqual(['t-1'])
  })

  it('upsert replaces by id rather than appending a second record', async () => {
    const { s } = await store()
    await s.upsertTask(task('t-1', { title: 'first' }))
    await s.upsertTask(task('t-1', { title: 'second' }))
    const book = await s.read()
    expect(book.tasks).toHaveLength(1)
    expect(book.tasks[0]!.title).toBe('second')
  })

  it('patch reports false for an id nobody carries, never a silent success', async () => {
    const { s } = await store()
    expect(await s.patchTask('nope', { status: 'delivered' })).toBe(false)
  })

  it('patch stamps updatedAt so a later sync can order writes', async () => {
    const { s } = await store()
    await s.upsertTask(task('t-1'))
    await s.patchTask('t-1', { status: 'delivered', updatedAt: '2026-09-05T11:00:00.000Z' })
    const [t] = (await s.read()).tasks
    expect(t!.status).toBe('delivered')
    expect(t!.updatedAt).toBe('2026-09-05T11:00:00.000Z')
  })

  it('reads an empty book from corrupt bytes instead of throwing', async () => {
    const { file, s } = await store()
    await writeFile(file, '{ this is not json', 'utf8')
    expect(await s.read()).toEqual({ tasks: [], attempts: [] })
  })

  it('moves corrupt bytes aside rather than overwriting them', async () => {
    const { file, s } = await store()
    await writeFile(file, '{ this is not json', 'utf8')
    await s.read()
    await s.upsertTask(task('t-1'))
    // The bad bytes still exist: a parse failure must never become permanent data loss.
    const names = await readdir(dirname(file))
    expect(names.some(n => n.includes('corrupt'))).toBe(true)
  })

  it('drops a malformed record and keeps the file usable', async () => {
    const { file, s } = await store()
    await writeFile(file, JSON.stringify({ tasks: [{ nope: 1 }, task('t-ok')], attempts: [] }), 'utf8')
    expect((await s.read()).tasks.map(t => t.id)).toEqual(['t-ok'])
  })

  it('serialises concurrent writes without losing one', async () => {
    const { s } = await store()
    await Promise.all([s.upsertTask(task('t-1')), s.upsertTask(task('t-2')), s.upsertTask(task('t-3'))])
    expect((await s.read()).tasks.map(t => t.id).sort()).toEqual(['t-1', 't-2', 't-3'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/server/server/sessions/task-store.test.ts`
Expected: FAIL with `Cannot find module './task-store'`.

- [ ] **Step 3: Read `withFileLock`'s real signature before writing the store**

Run: `grep -n "export async function withFileLock" -A 14 packages/server/server/sessions/file-lock.ts`

The implementation below assumes it resolves to `{ result, contended }`. **If it returns the callback's value directly, drop the retry wrapper**, call it once, and delete the paragraph of the docstring about contention. Match the file; do not invent a shape.

- [ ] **Step 4: Add the path constant**

In `packages/server/server/config.ts`, beside `MANAGED_SESSIONS_FILE`, following the env-override pattern the neighbouring constants already use:

```ts
/** The task book — see `sessions/task-store.ts`. Lives beside the session registry. */
export const TASKS_FILE = process.env.AGENTISTICS_TASKS_FILE
  ?? join(AGENTISTICS_DIR, 'tasks.json')
```

- [ ] **Step 5: Write the implementation**

```ts
// packages/server/server/sessions/task-store.ts
/**
 * task-store.ts — the task book on disk, and the only file in this feature that touches it.
 *
 * Shape and durability rules come from `tags-local-store.ts` and `registry.ts`, unchanged because
 * they were learned from real losses: temp-file-then-rename, so a crash cannot leave a truncated
 * file a reader would parse-fail on; corrupt bytes quarantined rather than overwritten, so a parse
 * failure degrades to "no tasks" instead of erasing them; a no-op mutation writing nothing.
 *
 * Mutations additionally run under `withFileLock`. The in-process promise chain is only half the
 * problem, because agentop runs as several processes: the server, the cockpit, and every one-shot
 * command. See `file-lock.ts`.
 *
 * A CONTENDED write is retried once. The lock's wait is bounded and it proceeds without the lock
 * when the wait expires, which is the right trade for a session that has ALREADY been spawned (a
 * lost label beats a live session with no record) and the wrong one here: nothing has been started,
 * and a task silently lost has no running process to be adopted back from.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock } from './file-lock'
import type { Attempt, AttemptStatus, Task, TaskBook, TaskStatus } from './task-model'

export interface TaskPatch {
  title?: string
  detail?: string
  status?: TaskStatus
  deliveredAt?: string
  repo?: string
  updatedAt?: string
}

export interface AttemptPatch {
  label?: string
  status?: AttemptStatus
  deliveredAt?: string
  updatedAt?: string
}

export interface TaskStore {
  read(): Promise<TaskBook>
  upsertTask(task: Task): Promise<void>
  upsertAttempt(attempt: Attempt): Promise<void>
  /** False when no record carries that id — never a silent success. */
  patchTask(id: string, patch: TaskPatch): Promise<boolean>
  patchAttempt(id: string, patch: AttemptPatch): Promise<boolean>
}

/** Keep only records shaped enough to be used safely downstream. */
function sanitizeTask(raw: unknown): Task | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  if (typeof t.id !== 'string' || !t.id) return null
  if (typeof t.title !== 'string' || !t.title) return null
  const status = t.status
  return {
    id: t.id,
    title: t.title,
    status: status === 'delivered' || status === 'abandoned' ? status : 'open',
    createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date(0).toISOString(),
    updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : new Date(0).toISOString(),
    ...(typeof t.detail === 'string' ? { detail: t.detail } : {}),
    ...(typeof t.deliveredAt === 'string' ? { deliveredAt: t.deliveredAt } : {}),
    ...(typeof t.repo === 'string' ? { repo: t.repo } : {}),
  }
}

function sanitizeAttempt(raw: unknown): Attempt | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  if (typeof a.id !== 'string' || !a.id) return null
  if (typeof a.taskId !== 'string' || !a.taskId) return null
  const cfg = (a.config ?? {}) as Record<string, unknown>
  if (typeof cfg.harness !== 'string' || !cfg.harness) return null
  const status = a.status
  return {
    id: a.id,
    taskId: a.taskId,
    label: typeof a.label === 'string' ? a.label : a.id,
    config: {
      harness: cfg.harness as Attempt['config']['harness'],
      ...(typeof cfg.model === 'string' ? { model: cfg.model } : {}),
      ...(typeof cfg.effort === 'string' ? { effort: cfg.effort } : {}),
      ...(typeof cfg.method === 'string' ? { method: cfg.method } : {}),
    },
    status: status === 'delivered' || status === 'abandoned' ? status : 'running',
    startedAt: typeof a.startedAt === 'string' ? a.startedAt : new Date(0).toISOString(),
    updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : new Date(0).toISOString(),
    ...(typeof a.deliveredAt === 'string' ? { deliveredAt: a.deliveredAt } : {}),
  }
}

export function createTaskStore(file: string): TaskStore {
  let queue: Promise<unknown> = Promise.resolve()
  let corrupt = false

  async function read(): Promise<TaskBook> {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      corrupt = false
      return { tasks: [], attempts: [] }
    }
    try {
      const raw = JSON.parse(text) as Record<string, unknown>
      corrupt = false
      const tasks = Array.isArray(raw.tasks) ? raw.tasks : []
      const attempts = Array.isArray(raw.attempts) ? raw.attempts : []
      return {
        tasks: tasks.map(sanitizeTask).filter((t): t is Task => t !== null),
        attempts: attempts.map(sanitizeAttempt).filter((a): a is Attempt => a !== null),
      }
    } catch {
      // The bad bytes stay on disk; the next write moves them aside. An empty book must never be
      // made permanent by overwriting the file that still holds the real one.
      corrupt = true
      return { tasks: [], attempts: [] }
    }
  }

  async function write(book: TaskBook): Promise<void> {
    await mkdir(dirname(file), { recursive: true })
    if (corrupt) {
      await rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {})
      corrupt = false
    }
    const tmp = `${file}.tmp`
    await writeFile(tmp, JSON.stringify(book, null, 2), 'utf8')
    await rename(tmp, file)
  }

  /** One write, under the cross-process lock, retried once when the lock was contended. */
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const first = await withFileLock(file, fn)
      if (!first.contended) return first.result
      const second = await withFileLock(file, fn)
      return second.result
    }
    const next = queue.then(run)
    queue = next.catch(() => undefined)
    return next
  }

  return {
    read,
    upsertTask(task) {
      return enqueue(async () => {
        const book = await read()
        await write({ ...book, tasks: [...book.tasks.filter(t => t.id !== task.id), task] })
      })
    },
    upsertAttempt(attempt) {
      return enqueue(async () => {
        const book = await read()
        await write({ ...book, attempts: [...book.attempts.filter(a => a.id !== attempt.id), attempt] })
      })
    },
    patchTask(id, patch) {
      return enqueue(async () => {
        const book = await read()
        const target = book.tasks.find(t => t.id === id)
        if (!target) return false
        const next = { ...target, ...patch }
        await write({ ...book, tasks: book.tasks.map(t => (t.id === id ? next : t)) })
        return true
      })
    },
    patchAttempt(id, patch) {
      return enqueue(async () => {
        const book = await read()
        const target = book.attempts.find(a => a.id === id)
        if (!target) return false
        const next = { ...target, ...patch }
        await write({ ...book, attempts: book.attempts.map(a => (a.id === id ? next : a)) })
        return true
      })
    },
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test packages/server/server/sessions/task-store.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/server/server/sessions/task-store.ts \
        packages/server/server/sessions/task-store.test.ts \
        packages/server/server/config.ts
git commit -m "feat(sessions): the task book on disk

Durability rules are the ones tags-local-store.ts and registry.ts already
learned: temp-file-then-rename, corrupt bytes quarantined rather than
overwritten, a no-op mutation writing nothing, reads that never throw.

Mutations run under the cross-process withFileLock, because agentop runs as
several processes. A contended write is retried once rather than proceeding
without the lock: that trade is right for a session already spawned, where a
lost label beats a live session with no record, and wrong for a task, which
has no running process to be adopted back from."
```

---

### Task 3: Carry the attribution on the session record

**Files:**
- Modify: `packages/server/server/sessions/types.ts`
- Modify: `packages/server/server/sessions/registry.ts`
- Test: `packages/server/server/sessions/registry.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ManagedSession.taskId?: string`, `ManagedSession.attemptId?: string`, and the same two optional fields on `SpawnRequest` and on `SessionPatch`.

**Why both fields and not only `attemptId`:** an attempt implies its task, but deriving it means opening the task book. The fleet poller groups rows by task and runs every five seconds; making it read a second file to learn what a row is filed under is how a five-second poll becomes a slow one. Both are known for free at spawn.

- [ ] **Step 1: Write the failing test**

Read the top of `registry.test.ts` first and reuse whatever helper it already defines for binding a registry to a temp path. Do not add a second helper beside it. Then append:

```ts
describe('task attribution on the record', () => {
  it('round-trips taskId and attemptId', async () => {
    const { registry } = await tempRegistry()
    await registry.add({
      id: 'a1', harness: 'claude', cwd: '/repo',
      createdAt: '2026-09-05T10:00:00.000Z',
      taskId: 't-1', attemptId: 'a-1',
    })
    const [row] = await registry.read()
    expect(row!.taskId).toBe('t-1')
    expect(row!.attemptId).toBe('a-1')
  })

  it('drops a non-string attribution rather than carrying it into the grouping', async () => {
    // The file is hand-editable. A number reaching the fleet's task grouping would key a band on
    // something that is not an id, and the row would file itself under a task nobody can name.
    const { file, registry } = await tempRegistry()
    await Bun.write(file, JSON.stringify([{
      id: 'a1', harness: 'claude', cwd: '/repo',
      createdAt: '2026-09-05T10:00:00.000Z', taskId: 7, attemptId: null,
    }]))
    const [row] = await registry.read()
    expect(row!.id).toBe('a1')
    expect(row!.taskId).toBeUndefined()
    expect(row!.attemptId).toBeUndefined()
  })

  it('patches the attribution onto an existing row', async () => {
    const { registry } = await tempRegistry()
    await registry.add({
      id: 'a1', harness: 'claude', cwd: '/repo', createdAt: '2026-09-05T10:00:00.000Z',
    })
    expect(await registry.patch('a1', { taskId: 't-9', attemptId: 'a-9' })).toBe(true)
    const [row] = await registry.read()
    expect([row!.taskId, row!.attemptId]).toEqual(['t-9', 'a-9'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/server/server/sessions/registry.test.ts`
Expected: FAIL — a type error on `taskId`, or `row.taskId` is `undefined` where `'t-1'` was expected.

- [ ] **Step 3: Add the fields to `ManagedSession` and `SpawnRequest`**

In `packages/server/server/sessions/types.ts`, inside `ManagedSession`, beside `task`:

```ts
  /**
   * The Task and Attempt this session was started under — see `task-model.ts`.
   *
   * Stamped at SPAWN, the one moment the association is a fact rather than a guess, and carried by
   * every path that mints a new managedId for the same work: resume, attach, takeover, openTask,
   * adoption. The same discipline `conversationId` follows, for the same reason — a session filed
   * under the wrong task makes every number wrong without looking wrong.
   *
   * `task` (the free-text name) stays beside these and keeps working. A name typed before this
   * existed resolves through `legacyTaskId`.
   */
  taskId?: string
  attemptId?: string

  /**
   * HOW `conversationId` was established — see `LinkProvenance` in `task-model.ts`.
   *
   * `assigned` the CLI was handed the id at spawn; `observed` the poller claimed it at first
   * sighting. A rollup must be able to tell them apart, and on the record alone they look
   * identical. A MISSING value reads as `assigned`: every link written before this field existed
   * was one.
   */
  conversationLink?: 'assigned' | 'observed'
```

And on `SpawnRequest`, `taskId` and `attemptId` as optional fields, with a one-line comment pointing at `ManagedSession.taskId`.

- [ ] **Step 4: Carry them through the registry**

In `packages/server/server/sessions/registry.ts`, add to `SessionPatch`:

```ts
  /** See `ManagedSession.taskId` — stamped at spawn, patched only when a row is re-attributed. */
  taskId?: string
  attemptId?: string
  /** See `ManagedSession.conversationLink`. Written beside `conversationId`, never on its own. */
  conversationLink?: 'assigned' | 'observed'
```

And to `sanitize`, beside the existing `task` line:

```ts
    ...(typeof s.taskId === 'string' ? { taskId: s.taskId } : {}),
    ...(typeof s.attemptId === 'string' ? { attemptId: s.attemptId } : {}),
    ...(s.conversationLink === 'assigned' || s.conversationLink === 'observed'
      ? { conversationLink: s.conversationLink }
      : {}),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/server/server/sessions/registry.test.ts`
Expected: PASS, including the three new tests.

- [ ] **Step 6: Commit**

```bash
git add packages/server/server/sessions/types.ts \
        packages/server/server/sessions/registry.ts \
        packages/server/server/sessions/registry.test.ts
git commit -m "feat(sessions): carry the task attribution on the session record

taskId and attemptId sit beside the free-text task name, which keeps working.
Both are stamped rather than one derived: an attempt implies its task, but
deriving it means opening the task book, and the fleet poller that groups rows
by task runs every five seconds.

sanitize drops a non-string attribution. The file is hand-editable, and a
number reaching the task grouping would key a band on something that is not an
id, filing the row under a task nobody can name."
```

---

### Task 4: Stamp the attribution at every spawn path

**Files:**
- Modify: `packages/server/server/cli-start.ts` (around line 1524, the cockpit and web spawn)
- Modify: `packages/server/server/sessions/cli-session.ts` (around lines 224, 331, 427 and 778)
- Test: `packages/server/server/sessions/spawn-attribution.test.ts` (create)

**Interfaces:**
- Consumes: `SpawnRequest.taskId` / `.attemptId` from Task 3.
- Produces: no new names — every `addSession` call now carries the attribution when the request had one.

**There are five call sites and every one must be done.** A missed site is a spawn path that silently produces unattributed sessions, and the symptom is a rollup that is quietly short: nothing throws, nothing is red, the number is simply wrong. Enumerate them with `grep -rn "addSession(" packages/server/server --include=*.ts | grep -v test`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/server/sessions/spawn-attribution.test.ts
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A lint, not a unit test — the same shape `tokens.lint.test.ts` uses.
 *
 * Every `addSession(` call must carry the attribution. A new spawn path that forgets is a source of
 * unattributed sessions, and the symptom is a rollup that is quietly short.
 */
const ROOTS = ['packages/server/server', 'packages/server/server/sessions']

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.ts') && !e.name.includes('.test.'))
    .map(e => join(dir, e.name))
}

describe('every spawn path stamps the task attribution', () => {
  it('has no addSession call without taskId beside it', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of filesIn(root)) {
        const src = readFileSync(file, 'utf8')
        let from = 0
        for (;;) {
          const at = src.indexOf('addSession({', from)
          if (at === -1) break
          from = at + 1
          const block = src.slice(at, at + 1400)
          if (!block.includes('taskId')) {
            offenders.push(`${file}:${src.slice(0, at).split('\n').length}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/server/server/sessions/spawn-attribution.test.ts`
Expected: FAIL, listing the call sites (`packages/server/server/cli-start.ts:1524`, `.../cli-session.ts:224`, and the rest).

- [ ] **Step 3: Stamp each site reported by the failing test**

At a FRESH spawn, beside the existing `...(req.task ? { task: req.task } : {})` line (or `cmd.task`, matching that site's own variable name):

```ts
    // Stamped at SPAWN — the one moment the association is a fact. See `ManagedSession.taskId`.
    ...(req.taskId ? { taskId: req.taskId } : {}),
    ...(req.attemptId ? { attemptId: req.attemptId } : {}),
```

At a RESUME or REOPEN site, the attribution is inherited from the row being replaced rather than taken from the request, because a reopened session is the same piece of work:

```ts
    ...(previous?.taskId ? { taskId: previous.taskId } : {}),
    ...(previous?.attemptId ? { attemptId: previous.attemptId } : {}),
```

Read each site to find what the row being replaced is called there (`row`, `entry`, `prev`) and use that name. Do not introduce a new one.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/server/server/sessions/spawn-attribution.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify nothing else broke**

Run: `bun test packages/server/server/sessions/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/server/cli-start.ts \
        packages/server/server/sessions/cli-session.ts \
        packages/server/server/sessions/spawn-attribution.test.ts
git commit -m "feat(sessions): stamp the task attribution at every spawn path

Five call sites, and a lint test that fails the build when a sixth appears
without it. A spawn path that forgets the attribution produces unattributed
sessions, and the symptom is a rollup that is quietly short: nothing throws,
nothing is red, the number is simply wrong.

A reopened session inherits the attribution from the row it replaces rather
than taking it from the request: it is the same piece of work."
```

---

### Task 5: The first-sighting claim (pure)

**Files:**
- Create: `packages/server/server/sessions/task-attribution.ts`
- Test: `packages/server/server/sessions/task-attribution.test.ts`

**Interfaces:**
- Consumes: `HarnessId` from `@agentistics/core`.
- Produces: `ClaimRow`, `ClaimCandidate`, `Claim`, `ClaimRefusal`, `ClaimRefusalReason`, `ClaimPlan`, `planFirstSightingClaims(o: { rows; candidates; claimed }): ClaimPlan`.

**This is the module the feature lives or dies on.** `SpawnSpec.assignId` exists for claude and copilot only, so a freshly spawned codex, kimi, antigravity or gemini session has no conversation link and contributes no cost at all — the whole antigravity column coming out empty in a feature about cost per delivery. This resolves it once, at first sighting, anchored in time and held exclusively. It is **not** the harness-and-directory inference `session-view.ts`'s `metricsOf` refuses, which is a standing guess re-evaluated forever that gives every session of one repository the same conversation.

**The tests that matter are the refusals**, and they are the bulk of the file.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/server/sessions/task-attribution.test.ts
import { describe, expect, it } from 'bun:test'
import { planFirstSightingClaims } from './task-attribution'
import type { ClaimCandidate, ClaimRow } from './task-attribution'

const row = (id: string, over: Partial<ClaimRow> = {}): ClaimRow => ({
  id, harness: 'codex', cwd: '/repo/a', spawnedMs: 1_000, ...over,
})

const cand = (sessionId: string, over: Partial<ClaimCandidate> = {}): ClaimCandidate => ({
  sessionId, harness: 'codex', cwd: '/repo/a', startedMs: 2_000, ...over,
})

describe('planFirstSightingClaims', () => {
  it('claims the one conversation that appeared after the spawn, in the spawn directory', () => {
    const plan = planFirstSightingClaims({ rows: [row('r1')], candidates: [cand('c1')], claimed: new Set() })
    expect(plan.claims).toEqual([{ rowId: 'r1', sessionId: 'c1' }])
    expect(plan.refused).toEqual([])
  })

  it('REFUSES when two candidates fit — it does not pick the closer one', () => {
    // Choosing by proximity is a guess wearing a measurement's clothes. Two conversations in the
    // window means the evidence does not identify one, and a wrong cost is invisible.
    const plan = planFirstSightingClaims({
      rows: [row('r1')],
      candidates: [cand('c1'), cand('c2', { startedMs: 2_500 })],
      claimed: new Set(),
    })
    expect(plan.claims).toEqual([])
    expect(plan.refused).toEqual([{ rowId: 'r1', reason: 'ambiguous-candidates' }])
  })

  it('REFUSES both rows when two of one harness were spawned in one directory', () => {
    // `agentop session batch` starting several sessions of one harness in one repository is exactly
    // this case. Coming out empty is correct; coming out swapped is the bug this cannot survive.
    const plan = planFirstSightingClaims({
      rows: [row('r1'), row('r2')], candidates: [cand('c1')], claimed: new Set(),
    })
    expect(plan.claims).toEqual([])
    expect(plan.refused.map(r => r.reason)).toEqual(['ambiguous-rows', 'ambiguous-rows'])
  })

  it('ignores a conversation that started BEFORE the spawn', () => {
    const plan = planFirstSightingClaims({
      rows: [row('r1', { spawnedMs: 5_000 })],
      candidates: [cand('c1', { startedMs: 1_000 })],
      claimed: new Set(),
    })
    expect(plan.claims).toEqual([])
  })

  it('ignores a conversation of another harness, and one in another directory', () => {
    const plan = planFirstSightingClaims({
      rows: [row('r1')],
      candidates: [cand('c1', { harness: 'kimi' }), cand('c2', { cwd: '/repo/b' })],
      claimed: new Set(),
    })
    expect(plan.claims).toEqual([])
  })

  it('never re-claims a conversation another row already holds', () => {
    const plan = planFirstSightingClaims({
      rows: [row('r1')], candidates: [cand('c1')], claimed: new Set(['c1']),
    })
    expect(plan.claims).toEqual([])
  })

  it('leaves a row that already has a link alone — a claim is never revised', () => {
    // Re-deriving a link later is how a row silently changes what it measured.
    const plan = planFirstSightingClaims({
      rows: [row('r1', { conversationId: 'already' })], candidates: [cand('c1')], claimed: new Set(),
    })
    expect(plan.claims).toEqual([])
    expect(plan.refused).toEqual([])
  })

  it('claims independently for rows in different directories', () => {
    const plan = planFirstSightingClaims({
      rows: [row('r1'), row('r2', { cwd: '/repo/b' })],
      candidates: [cand('c1'), cand('c2', { cwd: '/repo/b' })],
      claimed: new Set(),
    })
    expect(plan.claims).toEqual([
      { rowId: 'r1', sessionId: 'c1' },
      { rowId: 'r2', sessionId: 'c2' },
    ])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/server/server/sessions/task-attribution.test.ts`
Expected: FAIL with `Cannot find module './task-attribution'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/server/server/sessions/task-attribution.ts
/**
 * task-attribution.ts — the conversation link for the harnesses that cannot be told one.
 *
 * `SpawnSpec.assignId` exists for claude and copilot only, so a freshly spawned codex, kimi,
 * antigravity or gemini session has no exact link and contributes no cost or tokens to its task.
 * That is not a rounding error in a feature about cost per delivery: it is the whole antigravity
 * column coming out empty.
 *
 * This resolves it ONCE, at first sighting: a conversation of the spawned harness, in the spawned
 * directory, that appeared AFTER the spawn, and that nobody else holds.
 *
 * It is deliberately NOT the harness-and-directory inference `session-view.ts`'s `metricsOf`
 * refuses. That one is a standing guess, re-evaluated on every read, which gives every session of a
 * repository the same conversation. This is a one-time claim anchored in TIME and held EXCLUSIVELY,
 * and once written it is as good as an assigned id.
 *
 * EVERY RULE ERRS TOWARD REFUSING. A row left unlinked costs a column that says so; a row linked to
 * the wrong conversation costs every number in the rollup and looks perfectly fine.
 *
 * GEMINI IS DELIBERATELY NOT EXCLUDED HERE, although its store id is synthetic (`${dir}/${file}`)
 * and no `resume` can use it. The claim is for METRICS, and a synthetic id resolves perfectly well
 * against the store; whether a row can be reopened is `Conversation.resumable`, a separate question
 * with a separate answer. Excluding gemini would cost it its cost and tokens to fix a problem it
 * does not have.
 */

import type { HarnessId } from '@agentistics/core'

export interface ClaimRow {
  id: string
  harness: HarnessId
  cwd: string
  /** Epoch ms the session was spawned — `ManagedSession.createdAt`, parsed. */
  spawnedMs: number
  /** Already linked: assigned at spawn, or claimed by an earlier pass. */
  conversationId?: string
}

export interface ClaimCandidate {
  sessionId: string
  harness: HarnessId
  cwd: string
  /** Epoch ms the conversation BEGAN — `SessionMeta.start_time`, parsed. */
  startedMs: number
}

export type ClaimRefusalReason = 'ambiguous-candidates' | 'ambiguous-rows'

export interface ClaimRefusal {
  rowId: string
  reason: ClaimRefusalReason
}

export interface Claim {
  rowId: string
  sessionId: string
}

export interface ClaimPlan {
  claims: Claim[]
  /** Rows that could have been claimed and deliberately were not, with the reason. */
  refused: ClaimRefusal[]
}

const key = (harness: HarnessId, cwd: string) => `${harness} ${cwd}`

export function planFirstSightingClaims(o: {
  rows: readonly ClaimRow[]
  candidates: readonly ClaimCandidate[]
  /** Conversations already held by some row, anywhere in the fleet. */
  claimed: ReadonlySet<string>
}): ClaimPlan {
  const claims: Claim[] = []
  const refused: ClaimRefusal[] = []

  // A row that already knows its conversation is never revisited. "Not yet" and "some other
  // conversation" are different answers, and revising a link changes what a row measured.
  const open = o.rows.filter(r => !r.conversationId)

  const rowsByKey = new Map<string, ClaimRow[]>()
  for (const r of open) {
    const k = key(r.harness, r.cwd)
    rowsByKey.set(k, [...(rowsByKey.get(k) ?? []), r])
  }

  for (const [k, rows] of rowsByKey) {
    // Two unclaimed rows of one harness in one directory: nothing here can tell which conversation
    // belongs to which, so NEITHER is linked. `agentop session batch` does exactly this.
    if (rows.length > 1) {
      for (const r of rows) refused.push({ rowId: r.id, reason: 'ambiguous-rows' })
      continue
    }
    const row = rows[0]!
    const fits = o.candidates.filter(c =>
      key(c.harness, c.cwd) === k
      && c.startedMs > row.spawnedMs
      && !o.claimed.has(c.sessionId))

    // Nothing has appeared yet. Not a refusal: the conversation may simply not be in the store, and
    // the next poll asks again.
    if (fits.length === 0) continue

    // Two conversations fit. Picking the closer one is a guess wearing a measurement's clothes.
    if (fits.length > 1) {
      refused.push({ rowId: row.id, reason: 'ambiguous-candidates' })
      continue
    }
    claims.push({ rowId: row.id, sessionId: fits[0]!.sessionId })
  }

  return { claims, refused }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/server/server/sessions/task-attribution.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/sessions/task-attribution.ts \
        packages/server/server/sessions/task-attribution.test.ts
git commit -m "feat(sessions): claim a conversation once, at first sighting

assignId exists for claude and copilot only, so a fresh codex, kimi,
antigravity or gemini session has no conversation link and contributes no cost
to its task: the whole antigravity column coming out empty in a feature about
cost per delivery.

This claims it once: same harness, same directory, started AFTER the spawn,
held by nobody else. It is not the standing harness-and-directory inference
metricsOf refuses, which gives every session of a repository the same
conversation; it is anchored in time, exclusive, and never revised.

Every rule errs toward refusing. Two candidates, or two unclaimed rows of one
harness in one directory (which is what session batch does), and nothing is
linked. A row left unlinked costs a column that says so; a row linked to the
wrong conversation costs every number and looks fine."
```

---

### Task 6: The rollup (pure)

**Files:**
- Create: `packages/server/server/sessions/task-rollup.ts`
- Test: `packages/server/server/sessions/task-rollup.test.ts`

**Interfaces:**
- Consumes: `SessionMeta` and the all-four-counters token helper from `@agentistics/core`; `LinkProvenance` from `task-model.ts`.
- Produces: `SessionCredits`, `RollupSession`, `AttemptRollup`, `rollupAttempt(o: { sessions: readonly RollupSession[] }): AttemptRollup`.

**The source is `SessionMeta`, not `Conversation`.** `toConversation` is a projection built for the fleet row and carries neither `user_message_count` nor `active_minutes` — two of the three metrics this feature exists for. Read `loadConsolidated()`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/server/sessions/task-rollup.test.ts
import { describe, expect, it } from 'bun:test'
import { rollupAttempt } from './task-rollup'
import type { RollupSession } from './task-rollup'
import type { SessionMeta } from '@agentistics/core'

const meta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  session_id: 's1', project_path: '/repo', start_time: '2026-09-05T10:00:00.000Z',
  harness: 'claude', user_message_count: 3, active_minutes: 10,
  input_tokens: 100, output_tokens: 50,
  cache_read_input_tokens: 800, cache_creation_input_tokens: 50,
  ...over,
} as SessionMeta)

const link = (over: Partial<RollupSession> = {}): RollupSession => ({
  rowId: 'r1', provenance: 'assigned', meta: meta(), costUSD: 1, costMeasured: false, ...over,
})

describe('rollupAttempt', () => {
  it('sums rounds across the sessions of one attempt', () => {
    const r = rollupAttempt({ sessions: [
      link({ rowId: 'r1', meta: meta({ user_message_count: 3 }) }),
      link({ rowId: 'r2', meta: meta({ session_id: 's2', user_message_count: 4 }) }),
    ] })
    expect(r.rounds).toBe(7)
    expect(r.sessionsUsed).toBe(2)
  })

  it('counts tokens as all four counters, never input plus output', () => {
    // input+output alone is 0.34% of the volume on real data: not slightly low, roughly 300x off.
    const r = rollupAttempt({ sessions: [link()] })
    expect(r.tokens).toBe(1000)
  })

  it('reports a metric the harness cannot produce as null, never zero', () => {
    // copilot reports no tokens. A confident 0 beside a real cost reads as a free session.
    const r = rollupAttempt({ sessions: [link({
      meta: meta({
        harness: 'copilot',
        input_tokens: undefined, output_tokens: undefined,
        cache_read_input_tokens: undefined, cache_creation_input_tokens: undefined,
      }),
      costUSD: null,
    })] })
    expect(r.tokens).toBeNull()
    expect(r.costUSD).toBeNull()
  })

  it('counts cost provenance per session and never merges the two', () => {
    const r = rollupAttempt({ sessions: [
      link({ rowId: 'r1', costUSD: 2, costMeasured: true }),
      link({ rowId: 'r2', costUSD: 3, costMeasured: false }),
    ] })
    expect(r.costUSD).toBe(5)
    expect(r.costMeasuredSessions).toBe(1)
    expect(r.costEstimatedSessions).toBe(1)
  })

  it('counts how each session was linked, so a short rollup can say why', () => {
    const r = rollupAttempt({ sessions: [
      link({ rowId: 'r1', provenance: 'assigned' }),
      link({ rowId: 'r2', provenance: 'observed' }),
      link({ rowId: 'r3', provenance: 'none', meta: null, costUSD: null }),
    ] })
    expect(r.provenance).toEqual({ assigned: 1, observed: 1, none: 1 })
    expect(r.sessionsUsed).toBe(3)
    expect(r.sessionsLinked).toBe(2)
  })

  it('an unlinked session still counts as a session used', () => {
    // "This attempt needed three sessions" is true whether or not the third could be priced.
    const r = rollupAttempt({ sessions: [link({ provenance: 'none', meta: null, costUSD: null })] })
    expect(r.sessionsUsed).toBe(1)
    expect(r.rounds).toBeNull()
  })

  it('keeps copilot credits out of the money and in their own field', () => {
    const r = rollupAttempt({ sessions: [link({
      meta: meta({ harness: 'copilot' }), costUSD: null,
      credits: { nanoAiu: 404_356_500, premiumRequests: 1 },
    })] })
    expect(r.costUSD).toBeNull()
    expect(r.credits).toEqual({ nanoAiu: 404_356_500, premiumRequests: 1 })
  })

  it('refuses a single money figure when the attempt mixes credits and dollars', () => {
    // A cross-harness total spanning copilot is not a number; it is two numbers in one column.
    const r = rollupAttempt({ sessions: [
      link({ rowId: 'r1', costUSD: 2 }),
      link({ rowId: 'r2', meta: meta({ harness: 'copilot' }), costUSD: null,
             credits: { nanoAiu: 1, premiumRequests: 1 } }),
    ] })
    expect(r.mixedCurrency).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/server/server/sessions/task-rollup.test.ts`
Expected: FAIL with `Cannot find module './task-rollup'`.

- [ ] **Step 3: Confirm the token helper's real export name**

Run: `grep -n "^export function session" packages/core/src/tokens.ts`

Use whichever export takes a `SessionMeta` and returns the sum of all four counters, and import it from `@agentistics/core`. **Do not hand-write the sum** — `tokens.lint.test.ts` greps the repo for two-term token additions and fails the build. The implementation below calls it `sessionTokenTotal`; if the real name differs, use the real one consistently.

- [ ] **Step 4: Write the implementation**

```ts
// packages/server/server/sessions/task-rollup.ts
/**
 * task-rollup.ts — what an attempt cost, in how many rounds, across how many sessions. Pure.
 *
 * Reads `SessionMeta` (from `loadConsolidated()`), never `Conversation`: the latter is a projection
 * built by `toConversation` for the fleet row and carries neither `user_message_count` nor
 * `active_minutes`, which are two of the three metrics this feature exists for.
 *
 * Three rules, each an existing rule of this codebase applied to a new dimension:
 *
 *  1. A metric the harness cannot produce is `null`, never `0` — the HARNESS_CAPABILITIES rule.
 *  2. Cost PROVENANCE is counted per session and never merged in silence. A measured figure (the
 *     harness's own) and an estimate (`calcCost`) are different claims about the world.
 *  3. Copilot's credits are their OWN field and are never dollars. An attempt that mixes them with
 *     a token-derived cost reports `mixedCurrency`, and the caller renders two columns rather than
 *     one sum.
 */

import type { SessionMeta } from '@agentistics/core'
import { sessionTokenTotal } from '@agentistics/core'
import type { LinkProvenance } from './task-model'

export interface SessionCredits {
  nanoAiu: number
  premiumRequests: number
}

/** One session of an attempt, already resolved against the store by the caller. */
export interface RollupSession {
  rowId: string
  provenance: LinkProvenance
  /** Null when the row has no conversation link. It still counts as a session used. */
  meta: SessionMeta | null
  /** Dollars, when this harness produces them at all. */
  costUSD: number | null
  /** True when the figure came from the harness itself rather than from `calcCost`. */
  costMeasured?: boolean
  /** Copilot only. Never converted, never summed with `costUSD`. */
  credits?: SessionCredits
}

export interface AttemptRollup {
  /** Every session filed under the attempt, linked or not. */
  sessionsUsed: number
  /** How many of those had a conversation link, and so contributed numbers. */
  sessionsLinked: number
  provenance: Record<LinkProvenance, number>
  /** Null when no linked session reported a turn count. */
  rounds: number | null
  activeMinutes: number | null
  tokens: number | null
  costUSD: number | null
  costMeasuredSessions: number
  costEstimatedSessions: number
  credits: SessionCredits | null
  /** True when this attempt holds both a dollar figure and a credit figure. */
  mixedCurrency: boolean
}

function sumOrNull(values: readonly (number | null | undefined)[]): number | null {
  const real = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  return real.length === 0 ? null : real.reduce((a, b) => a + b, 0)
}

export function rollupAttempt(o: { sessions: readonly RollupSession[] }): AttemptRollup {
  const provenance: Record<LinkProvenance, number> = { assigned: 0, observed: 0, none: 0 }
  for (const s of o.sessions) provenance[s.provenance] += 1

  const linked = o.sessions.filter(s => s.meta !== null)

  const tokens = sumOrNull(linked.map(s => {
    const m = s.meta!
    const has = m.input_tokens !== undefined || m.output_tokens !== undefined
      || m.cache_read_input_tokens !== undefined || m.cache_creation_input_tokens !== undefined
    // Absent is NOT zero: a harness that reports no tokens must not read as a free session.
    return has ? sessionTokenTotal(m) : null
  }))

  const costUSD = sumOrNull(o.sessions.map(s => s.costUSD))

  const creditRows = o.sessions.filter(s => s.credits !== undefined)
  const credits = creditRows.length === 0 ? null : {
    nanoAiu: creditRows.reduce((a, s) => a + s.credits!.nanoAiu, 0),
    premiumRequests: creditRows.reduce((a, s) => a + s.credits!.premiumRequests, 0),
  }

  return {
    sessionsUsed: o.sessions.length,
    sessionsLinked: linked.length,
    provenance,
    rounds: sumOrNull(linked.map(s => s.meta!.user_message_count)),
    activeMinutes: sumOrNull(linked.map(s => s.meta!.active_minutes)),
    tokens,
    costUSD,
    costMeasuredSessions: o.sessions.filter(s => s.costMeasured === true).length,
    costEstimatedSessions: o.sessions.filter(s => s.costUSD !== null && s.costMeasured !== true).length,
    credits,
    mixedCurrency: costUSD !== null && credits !== null,
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/server/server/sessions/task-rollup.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/server/server/sessions/task-rollup.ts \
        packages/server/server/sessions/task-rollup.test.ts
git commit -m "feat(sessions): the attempt rollup, with its units kept apart

Reads SessionMeta rather than Conversation: the projection built for the fleet
row carries neither user_message_count nor active_minutes, which are two of
the three metrics this exists for.

A metric a harness cannot produce is null, never 0. Cost provenance is counted
per session, because the harness's own figure and calcCost's estimate are
different claims. Copilot credits are their own field and never dollars, and
an attempt holding both reports mixedCurrency so the caller renders two
columns instead of one meaningless sum.

An unlinked session still counts as a session used: 'this attempt needed three
sessions' is true whether or not the third could be priced."
```

---

### Task 7: Resolve the claim in the poller

**Files:**
- Modify: `packages/server/server/sessions/sessions-host.ts`
- Modify: `packages/server/server/sessions/conversations.ts` (add `startedMs`)
- Test: `packages/server/server/sessions/sessions-host.test.ts` (extend)

**Interfaces:**
- Consumes: `planFirstSightingClaims` from Task 5; the existing `recordConversation(id, conversationId)` dependency wired at `cli-start.ts:1429`.
- Produces: `Conversation.startedMs: number`. No new callbacks.

**Reuse `recordConversation`; do not add a second writer.** It is already the once-per-change write for the conversation link (`patchSession(id, { conversationId })`), and a claim is that same write with a different origin. A second path to one field is a second place for the two to disagree.

- [ ] **Step 1: Write the failing test**

Read `sessions-host.test.ts` first and reuse its existing helper for building a poller with fake dependencies. Adapt the fixture shape to that helper; the two behaviours asserted are what matter, not the helper's name.

```ts
describe('first-sighting claims', () => {
  it('records the claim once, through recordConversation', async () => {
    const recorded: Array<[string, string]> = []
    const poller = makePoller({
      registry: [{ id: 'r1', harness: 'codex', cwd: '/repo/a',
                   createdAt: new Date(1_000).toISOString() }],
      conversations: [{ sessionId: 'c1', harness: 'codex', cwd: '/repo/a', startedMs: 2_000 }],
      recordConversation: (id, cid) => { recorded.push([id, cid]); return Promise.resolve(true) },
    })
    await poller.pollOnce()
    expect(recorded).toEqual([['r1', 'c1']])

    // A claim is never revised, and never re-written on the next poll.
    await poller.pollOnce()
    expect(recorded).toHaveLength(1)
  })

  it('writes nothing when the claim is refused', async () => {
    const recorded: Array<[string, string]> = []
    const poller = makePoller({
      registry: [
        { id: 'r1', harness: 'codex', cwd: '/repo/a', createdAt: new Date(1_000).toISOString() },
        { id: 'r2', harness: 'codex', cwd: '/repo/a', createdAt: new Date(1_000).toISOString() },
      ],
      conversations: [{ sessionId: 'c1', harness: 'codex', cwd: '/repo/a', startedMs: 2_000 }],
      recordConversation: (id, cid) => { recorded.push([id, cid]); return Promise.resolve(true) },
    })
    await poller.pollOnce()
    expect(recorded).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/server/server/sessions/sessions-host.test.ts`
Expected: FAIL — `recorded` is empty where `[['r1','c1']]` was expected.

- [ ] **Step 3: Give `Conversation` a start time**

In `conversations.ts`, add `startedMs: number` to the `Conversation` interface and set it in `toConversation`:

```ts
  /**
   * Epoch ms the conversation BEGAN. Distinct from `lastActivityMs`, which moves every turn: the
   * first-sighting claim is anchored on when a conversation started, relative to a spawn.
   */
  startedMs: Date.parse(s.start_time) || 0,
```

- [ ] **Step 4: Call the planner in the poll**

In `sessions-host.ts`, after the registry and the conversations have both been loaded and before the snapshot is returned:

```ts
    // The conversation link for the harnesses no `assignId` can be given. Claimed once, refused on
    // any ambiguity — see `task-attribution.ts`.
    const plan = planFirstSightingClaims({
      rows: registry.map(r => ({
        id: r.id,
        harness: r.harness,
        cwd: r.cwd,
        spawnedMs: Date.parse(r.createdAt) || 0,
        ...(r.conversationId ? { conversationId: r.conversationId } : {}),
      })),
      candidates: conversations.map(c => ({
        sessionId: c.sessionId,
        harness: c.harness,
        cwd: c.cwd,
        startedMs: c.startedMs,
      })),
      claimed: new Set(registry.map(r => r.conversationId).filter((v): v is string => !!v)),
    })
    for (const claim of plan.claims) {
      await deps.recordConversation?.(claim.rowId, claim.sessionId)
    }
```

Match the local variable names this function already uses for the registry list and the conversation list rather than introducing `registry` / `conversations` if it calls them something else.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/server/server/sessions/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/server/sessions/sessions-host.ts \
        packages/server/server/sessions/conversations.ts \
        packages/server/server/sessions/sessions-host.test.ts
git commit -m "feat(sessions): resolve the first-sighting claim in the poller

Written through recordConversation, the once-per-change writer that already
owns the conversation link: a second path to one field is a second place for
the two to disagree.

Conversation gains startedMs. The claim is anchored on when a conversation
BEGAN, and lastActivityMs moves every turn."
```

---

### Task 8: `agentop session batch --attempt` and `agentop task`

**Files:**
- Modify: `packages/server/server/sessions/cli-parse.ts`
- Modify: `packages/server/server/sessions/cli-session.ts`
- Test: `packages/server/server/sessions/cli-parse.test.ts` (extend)

**Interfaces:**
- Consumes: `rollupAttempt` from Task 6, the store from Task 2, `ManagedSession.attemptId` from Task 3.
- Produces: `BatchSpec.attempt?: string`; `SessionCommand` gains `{ kind: 'task'; sub: 'ls' }` and `{ kind: 'task'; sub: 'show'; ref: string }`.

**`--attempt` is a positional default, like `--cwd`.** It applies to every `--session` that follows it, until the next `--attempt`. That is what lets one attempt hold several sessions, which is the case the middle level exists for.

- [ ] **Step 1: Write the failing test**

```ts
describe('batch --attempt', () => {
  it('applies to the sessions that follow it, until the next one', () => {
    const cmd = parseSessionArgs([
      'batch', '--task', 'pizzeria',
      '--attempt', 'opus, prompt only',
      '--session', 'claude: build it',
      '--session', 'claude: keep going',
      '--attempt', 'agy + flash, sdd',
      '--session', 'antigravity: build it',
    ])
    expect(cmd.kind).toBe('batch')
    if (cmd.kind !== 'batch') return
    expect(cmd.specs.map(s => s.attempt)).toEqual([
      'opus, prompt only', 'opus, prompt only', 'agy + flash, sdd',
    ])
  })

  it('leaves attempt unset when none was named, so a plain batch still works', () => {
    const cmd = parseSessionArgs(['batch', '--task', 'x', '--session', 'claude: go'])
    expect(cmd.kind).toBe('batch')
    if (cmd.kind !== 'batch') return
    expect(cmd.specs[0]!.attempt).toBeUndefined()
  })

  it('refuses an --attempt with no value rather than swallowing the next flag', () => {
    const cmd = parseSessionArgs(['batch', '--task', 'x', '--attempt', '--session', 'claude: go'])
    expect(cmd.kind).toBe('error')
  })
})

describe('agentop task', () => {
  it('parses the listing', () => {
    expect(parseSessionArgs(['task', 'ls'])).toEqual({ kind: 'task', sub: 'ls' })
  })

  it('parses a show by reference', () => {
    expect(parseSessionArgs(['task', 'show', 'pizzeria'])).toEqual({
      kind: 'task', sub: 'show', ref: 'pizzeria',
    })
  })

  it('refuses show with no reference', () => {
    expect(parseSessionArgs(['task', 'show']).kind).toBe('error')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/server/server/sessions/cli-parse.test.ts`
Expected: FAIL with `Unknown option: --attempt`.

- [ ] **Step 3: Extend the batch grammar**

In `cli-parse.ts`: add `attempt?: string` to `BatchSpec`; add `'--attempt'` to `VALUE_FLAGS`; widen the `shared` declaration in `parseBatch` to `{ cwd?: string; model?: string; effort?: string; attempt?: string }`; and treat the flag exactly as the existing defaults are treated, so `parseBatchSpec` picks it up for every subsequent `--session`:

```ts
    if (arg === '--attempt') { shared.attempt = value; continue }
```

Then carry `attempt` through `parseBatchSpec` alongside `cwd` / `model` / `effort`.

- [ ] **Step 4: Add the `task` command**

To the `SessionCommand` union:

```ts
  /**
   * The task book, read. `ls` lists tasks with their rollups; `show <ref>` opens one and lists its
   * attempts side by side.
   *
   * A command of its own rather than a `session` subcommand: a task is not a session. The two verbs
   * that already act on one (`open`, `finish`) take the ROW's own task precisely so a caller cannot
   * name someone else's, and that stays true.
   */
  | { kind: 'task'; sub: 'ls' }
  | { kind: 'task'; sub: 'show'; ref: string }
```

And in `parseSessionArgs`, beside the other heads:

```ts
  if (head === 'task') {
    const sub = argv[1]
    if (sub === 'ls' || sub === undefined) return { kind: 'task', sub: 'ls' }
    if (sub === 'show') {
      const ref = argv[2]
      if (!ref) return { kind: 'error', message: 'Usage: agentop task show <id|name>' }
      return { kind: 'task', sub: 'show', ref }
    }
    return { kind: 'error', message: 'Usage: agentop task [ls|show <id|name>]' }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/server/server/sessions/cli-parse.test.ts`
Expected: PASS.

- [ ] **Step 6: Implement the handler**

In `cli-session.ts`, handle `kind: 'task'`. The resolution both subcommands share:

```ts
/**
 * The registry rows of one attempt, resolved against the store.
 *
 * `provenance` is read from the record rather than guessed: a link with no `conversationLink` was
 * written before that field existed and was an assigned one. A row whose conversation is not in the
 * store yields `meta: null` and still counts as a session used.
 */
function rollupSessionsFor(
  attemptId: string,
  rows: readonly ManagedSession[],
  store: ReadonlyMap<string, SessionMeta>,
): RollupSession[] {
  return rows
    .filter(r => r.attemptId === attemptId)
    .map(r => {
      const meta = r.conversationId ? store.get(r.conversationId) ?? null : null
      return {
        rowId: r.id,
        provenance: r.conversationId ? (r.conversationLink ?? 'assigned') : 'none',
        meta,
        costUSD: meta ? sessionCostUSD(meta) : null,
      }
    })
}
```

`sessionCostUSD` is the helper `conversations.ts` already uses to price a `SessionMeta`; import it rather than calling `calcCost` here, so a task's money and a fleet row's money can never disagree. `costMeasured` stays unset for now — nothing reads the harness's own figure until the separate `cost-state` plan lands, and claiming a figure is measured when it was estimated is exactly the confusion the field exists to prevent.

The printing rules, which the Task 6 tests already encode. State each; never imply it:

- a `null` metric prints `N/A`, never `0`;
- when `sessionsLinked < sessionsUsed`, print `cost covers N of M sessions`;
- when `costMeasuredSessions` and `costEstimatedSessions` are both non-zero, print `N measured, M estimated`;
- when `mixedCurrency`, print dollars and credits as two columns and **no total**;
- print the honest limit once, at the foot of `show`: this measures cost, rounds and time, and not whether the output was any good.

- [ ] **Step 7: Verify end to end against a real fleet**

```bash
bun run cli session batch --task "smoke test" \
  --attempt "claude, prompt only" --session "claude@/tmp: say hello and stop"
bun run cli task ls
bun run cli task show "smoke test"
```

Expected: `task ls` lists `smoke test` with one attempt; `task show` prints that attempt with its rounds, and `N/A` for anything the harness has not produced yet. Then clean up with `bun run cli session kill <id>`.

- [ ] **Step 8: Commit**

```bash
git add packages/server/server/sessions/cli-parse.ts \
        packages/server/server/sessions/cli-parse.test.ts \
        packages/server/server/sessions/cli-session.ts \
        packages/server/server/sessions/types.ts \
        packages/server/server/sessions/registry.ts
git commit -m "feat(cli): agentop session batch --attempt, and agentop task

--attempt is a positional default like --cwd: it applies to every --session
that follows it until the next one, which is what lets one attempt hold
several sessions, the case the middle level exists for.

agentop task is its own command rather than a session subcommand, because a
task is not a session. It prints N/A rather than 0, says how many sessions a
cost actually covers, says how many figures were measured and how many
estimated, refuses a total when an attempt mixes dollars and credits, and
states once that this measures cost and rounds and not whether the work was
any good.

ManagedSession gains conversationLink so a rollup can tell an assigned id from
a claimed one. A missing value reads as assigned: every link written before
this field existed was one."
```

---

---

### Task 9: The delivery marker

**Files:**
- Modify: `packages/server/server/sessions/cli-parse.ts`
- Create: `packages/server/server/sessions/task-evidence.ts`
- Test: `packages/server/server/sessions/task-evidence.test.ts`
- Modify: `packages/server/server/sessions/cli-session.ts`

**Interfaces:**
- Consumes: `Attempt`, `AttemptStatus` from Task 1; the store from Task 2; `getGitFileStats` / `getProjectGitStats` from `../git`.
- Produces: `DeliveryEvidence`, `planDeliveryEvidence(o): DeliveryEvidence`; `SessionCommand` gains `{ kind: 'task'; sub: 'deliver' | 'abandon'; ref: string }`.

**Without this task the headline metric never closes.** "Rounds to delivery" needs a delivery, and `rollupAttempt` can sum rounds forever on an attempt nobody ever marked. Per the spec's §6 the marker is **manual, with git evidence attached**: the person decides, the product measures. Neither is inferred from the other — a commit is not a delivery, and a delivery with no commit is still a delivery.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/server/sessions/task-evidence.test.ts
import { describe, expect, it } from 'bun:test'
import { planDeliveryEvidence } from './task-evidence'

const commit = (sha: string, message: string, atMs: number) => ({ sha, message, atMs })

describe('planDeliveryEvidence', () => {
  it('keeps only commits inside the attempt window', () => {
    const e = planDeliveryEvidence({
      startedMs: 1_000, deliveredMs: 3_000,
      commits: [commit('a', 'early', 500), commit('b', 'during', 2_000), commit('c', 'late', 4_000)],
    })
    expect(e.commits.map(c => c.sha)).toEqual(['b'])
  })

  it('extracts PR references from commit messages', () => {
    const e = planDeliveryEvidence({
      startedMs: 0, deliveredMs: 10,
      commits: [commit('a', 'feat: thing (#287)', 5), commit('b', 'fix: other\n\nCloses #42', 6)],
    })
    expect(e.pullRequests.sort()).toEqual([287, 42].sort())
  })

  it('does not read a number that is not a PR reference', () => {
    // "issue 42" and "v2 of the parser" are not references. A fabricated PR link in a delivery
    // record is worse than none: it sends someone to a page about something else.
    const e = planDeliveryEvidence({
      startedMs: 0, deliveredMs: 10,
      commits: [commit('a', 'bump to v2 and fix 42 things', 5)],
    })
    expect(e.pullRequests).toEqual([])
  })

  it('reports an empty evidence set rather than refusing the delivery', () => {
    // Work that produces no commit is still delivered. The marker is the person's; the evidence is
    // whatever there is.
    const e = planDeliveryEvidence({ startedMs: 0, deliveredMs: 10, commits: [] })
    expect(e.commits).toEqual([])
    expect(e.pullRequests).toEqual([])
    expect(e.empty).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/server/server/sessions/task-evidence.test.ts`
Expected: FAIL with `Cannot find module './task-evidence'`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/server/server/sessions/task-evidence.ts
/**
 * task-evidence.ts — what an attempt produced, attached to the moment someone said it was done.
 *
 * The MARKER is a decision and the EVIDENCE is a measurement, and neither is derived from the
 * other. A commit is not a delivery (a branch full of them can still be abandoned) and a delivery
 * with no commit is still a delivery (a spike, a review, a piece of work that ended in a decision).
 *
 * The evidence exists because in a comparison two attempts both marked "delivered" look identical.
 * "Delivered what" is half the question being asked.
 */

export interface EvidenceCommit {
  sha: string
  message: string
  atMs: number
}

export interface DeliveryEvidence {
  commits: EvidenceCommit[]
  /** PR numbers named by those commits, deduped. */
  pullRequests: number[]
  /** True when nothing was found. Stated, so the caller can say so rather than print an empty box. */
  empty: boolean
}

/**
 * A PR reference, and nothing else that happens to be a number.
 *
 * Only the two forms git actually carries: a trailing `(#N)` from a squash merge, and the
 * `Closes|Fixes|Resolves #N` trailers. A bare `#N` mid-sentence is deliberately not matched — a
 * fabricated link in a delivery record sends someone to a page about something else, which is worse
 * than no link at all.
 */
const PR_PATTERNS = [/\(#(\d+)\)/g, /(?:closes|fixes|resolves)\s+#(\d+)/gi]

export function planDeliveryEvidence(o: {
  startedMs: number
  deliveredMs: number
  commits: readonly EvidenceCommit[]
}): DeliveryEvidence {
  const commits = o.commits
    .filter(c => c.atMs >= o.startedMs && c.atMs <= o.deliveredMs)
    .sort((a, b) => a.atMs - b.atMs)

  const prs = new Set<number>()
  for (const c of commits) {
    for (const pattern of PR_PATTERNS) {
      for (const m of c.message.matchAll(pattern)) {
        const n = Number(m[1])
        if (Number.isInteger(n) && n > 0) prs.add(n)
      }
    }
  }

  return {
    commits: [...commits],
    pullRequests: [...prs],
    empty: commits.length === 0 && prs.size === 0,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/server/server/sessions/task-evidence.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Add the verbs**

To the `SessionCommand` union and `parseSessionArgs`, beside `task ls` / `task show`:

```ts
  | { kind: 'task'; sub: 'deliver' | 'abandon'; ref: string }
```

```ts
    if (sub === 'deliver' || sub === 'abandon') {
      const ref = argv[2]
      if (!ref) return { kind: 'error', message: `Usage: agentop task ${sub} <id|name>` }
      return { kind: 'task', sub, ref }
    }
```

Add a test for each in `cli-parse.test.ts`, mirroring the `show` tests: one that parses, one that refuses a missing reference.

- [ ] **Step 6: Implement the handler**

`deliver` sets the task's `status` to `delivered` and stamps `deliveredAt`, sets every one of its `running` attempts to `delivered` with the same stamp, and for each attempt collects its commits from the repositories its sessions ran in (`getProjectGitStats` already scans a project path; the `cwd` of each attributed row is the path to ask about) and stores the `DeliveryEvidence` beside the attempt.

`abandon` is the same write with `abandoned` and **no evidence** — an attempt that was given up on has nothing to show, and attaching commits to it would read as a delivery.

Both are idempotent: delivering a delivered task changes `updatedAt` and nothing else, and both report `false` from the store when the reference names nothing, which the handler turns into a sentence rather than a silent success.

- [ ] **Step 7: Verify end to end**

```bash
bun run cli task deliver "smoke test"
bun run cli task show "smoke test"
```

Expected: the attempt reads `delivered`, its rounds figure is now final, and the evidence block lists the commits from the window or says there were none.

- [ ] **Step 8: Commit**

```bash
git add packages/server/server/sessions/task-evidence.ts \
        packages/server/server/sessions/task-evidence.test.ts \
        packages/server/server/sessions/cli-parse.ts \
        packages/server/server/sessions/cli-parse.test.ts \
        packages/server/server/sessions/cli-session.ts
git commit -m "feat(cli): agentop task deliver and abandon, with git evidence

Rounds-to-delivery needs a delivery, and without this the headline metric
never closes: rollupAttempt sums rounds forever on an attempt nobody marked.

The marker is a decision and the evidence is a measurement, and neither is
derived from the other. A commit is not a delivery; a delivery with no commit
is still one. The evidence exists because two attempts both marked delivered
look identical in a comparison, and 'delivered what' is half the question.

PR references are read only from the two forms git actually carries — a
trailing (#N) and the Closes/Fixes/Resolves trailers. A bare number mid
sentence is not matched: a fabricated link sends someone to a page about
something else, which is worse than no link.

abandon attaches no evidence. Commits under an abandoned attempt would read as
a delivery."
```

## Verification before calling the plan done

- [ ] `bun test` — the full suite passes.
- [ ] `bun tsc --noEmit` — clean.
- [ ] `bun run build:binary` — the compiled binary still builds. Nothing here touches Ink, but the binary is where import mistakes surface that `bun run` hides.
- [ ] `bun run cli task ls` on a machine with real sessions prints something readable at 80 columns.
- [ ] Legacy check: on a machine whose `preferences.finishedTasks` is non-empty, those names appear as delivered tasks. The migration ran, and nothing a user typed was lost.
- [ ] Attribution check, the one that matters: start two codex sessions in ONE directory with `session batch`, and confirm **neither** is linked to a conversation rather than one being linked to the other's. A swap here is invisible in every other check on this list.
- [ ] Delivery check: `agentop task deliver` on a task with commits in its window attaches them; on one with none it says so rather than printing an empty block.
