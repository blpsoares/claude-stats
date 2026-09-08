# The artifacts aside — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person read, from the Sessions workspace, the files the open session has written — a live list of what it touched, and the file itself on demand.

**Architecture:** Two pure modules and one route. The LIST is a pure function over the chat payload the workspace already polls, so it needs no server and no new disclosure. Only the file CONTENT takes a route, and that route refuses four ways rather than repairing anything.

**Tech Stack:** Bun, TypeScript (strict), React 18 + Vite, `react-markdown` + `remark-gfm` (already dependencies), `bun test`. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-09-03-session-artifacts-aside-design.md`.

## The two phases, and why

**Phase A (Tasks 1–4) depends on nothing** and can be built and shipped now: the pure list, the
pure path planner, the route, and the single-file renderer. Every one of them is testable without
the panel existing.

**Phase B (Tasks 5–8) must wait** for two things being built on `feat/sessions-overhaul`:
- **Phase 1b** — `SessionsRail`, the collapsed aside showing sessions. Layout C collapses the fleet
  list into it.
- **Phase 2** — the unified header, which is where the `◧` button lives.

Do not reimplement either. If Phase B is reached before those land, STOP and say so.

## Global Constraints

- Everything in this project is in **English**: code, comments, commit messages, PR text.
- Conventional Commits; commit after every task; `bun tsc --noEmit` and `bun test` green each time (the pre-commit hook runs both).
- **Refuse, never repair.** A path that needed fixing is a path nobody meant to send.
- **A pure module names no sentence.** Refusal CODES are language-free; the caller renders words, like `LiveUnavailableReason` and `central-runtime.ts`.
- **N/A, never a confident 0** — an absent capability is stated in words, never an inert control.
- **Do not use browser automation** — it hangs here. Verify the route with `curl`, including every refusal; ask the user to open the page for anything visual.
- 44px targets are mobile-only; verify at 390px that `document.documentElement.scrollWidth <= window.innerWidth`.
- Stage **explicit paths**, never `git add -A` — other sessions share this repository.
- Work in `.claude/worktrees/session-artifacts` on `feat/session-artifacts`.

---

## Phase A — the list, the route, the renderer

### Task 1: `sessionArtifacts.ts` — what this session has touched

**Files:**
- Create: `packages/web/src/lib/sessionArtifacts.ts`
- Create: `packages/web/src/lib/sessionArtifacts.test.ts`

**Interfaces:**
- Consumes: `ChatTurn` from the `/api/fleet/chat` payload — `{ role, text, tools?: { name, detail? }[], pending?: boolean }`.
- Produces: `Artifact { path: string; name: string; dir: string; kind: 'new' | 'edited'; touches: number; live: boolean }`, `artifactsFromTurns(turns): Artifact[]`, `ARTIFACT_TOOLS: ReadonlySet<string>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'bun:test'
import { artifactsFromTurns } from './sessionArtifacts'

const turn = (tools: { name: string; detail?: string }[], pending = false) =>
  ({ role: 'assistant' as const, text: '', tools, ...(pending ? { pending: true } : {}) })

describe('artifactsFromTurns', () => {
  it('lists a written file, newest first', () => {
    const out = artifactsFromTurns([
      turn([{ name: 'Write', detail: '/home/u/p/a.ts' }]),
      turn([{ name: 'Write', detail: '/home/u/p/docs/b.md' }]),
    ])
    expect(out.map(a => a.path)).toEqual(['/home/u/p/docs/b.md', '/home/u/p/a.ts'])
  })

  it('splits a path into the name and the directory that carries it', () => {
    const [a] = artifactsFromTurns([turn([{ name: 'Write', detail: '/home/u/p/docs/specs/b.md' }])])
    expect(a!.name).toBe('b.md')
    expect(a!.dir).toBe('/home/u/p/docs/specs')
  })

  it('NEVER takes a Bash command for a path', () => {
    // `toolDetail` reads `command` FIRST, so a shell call's detail is a shell line. Selecting by
    // the shape of `detail` would put `rm -rf build/` in a list of files.
    expect(artifactsFromTurns([turn([{ name: 'Bash', detail: 'rm -rf build/' }])])).toEqual([])
  })

  it('excludes Read — the list is what the session PRODUCED', () => {
    expect(artifactsFromTurns([turn([{ name: 'Read', detail: '/home/u/p/a.ts' }])])).toEqual([])
  })

  it('folds repeated touches of one path into one row and counts them', () => {
    const out = artifactsFromTurns([
      turn([{ name: 'Write', detail: '/home/u/p/a.ts' }]),
      turn([{ name: 'Edit', detail: '/home/u/p/a.ts' }]),
      turn([{ name: 'Edit', detail: '/home/u/p/a.ts' }]),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.touches).toBe(3)
  })

  it('calls it new when the session first WROTE it, edited when it first edited it', () => {
    const written = artifactsFromTurns([
      turn([{ name: 'Write', detail: '/home/u/p/a.ts' }]),
      turn([{ name: 'Edit', detail: '/home/u/p/a.ts' }]),
    ])
    expect(written[0]!.kind).toBe('new')
    const edited = artifactsFromTurns([turn([{ name: 'Edit', detail: '/home/u/p/b.ts' }])])
    expect(edited[0]!.kind).toBe('edited')
  })

  it('marks the file of a PENDING turn as the one being written now', () => {
    const out = artifactsFromTurns([
      turn([{ name: 'Write', detail: '/home/u/p/a.ts' }]),
      turn([{ name: 'Write', detail: '/home/u/p/b.ts' }], true),
    ])
    expect(out.find(a => a.name === 'b.ts')!.live).toBe(true)
    expect(out.find(a => a.name === 'a.ts')!.live).toBe(false)
  })

  it('marks nothing live once the pending turn has finished', () => {
    const out = artifactsFromTurns([turn([{ name: 'Write', detail: '/home/u/p/a.ts' }])])
    expect(out.every(a => !a.live)).toBe(true)
  })

  it('takes MultiEdit and NotebookEdit too', () => {
    const out = artifactsFromTurns([
      turn([{ name: 'MultiEdit', detail: '/home/u/p/a.ts' }]),
      turn([{ name: 'NotebookEdit', detail: '/home/u/p/n.ipynb' }]),
    ])
    expect(out).toHaveLength(2)
  })

  it('ignores a tool call with no detail — there is no path to show', () => {
    expect(artifactsFromTurns([turn([{ name: 'Write' }])])).toEqual([])
  })

  it('is empty for a conversation with no tools at all, and never throws', () => {
    expect(artifactsFromTurns([])).toEqual([])
    expect(artifactsFromTurns([{ role: 'user', text: 'hi' } as never])).toEqual([])
  })

  it('ignores a truncated detail — `toolDetail` appends an ellipsis past 200 chars', () => {
    // A truncated path names no file, and asking the server for one would be a refusal every time.
    const long = `/home/u/${'x'.repeat(210)}.ts`
    const detail = `${long.slice(0, 200)}…`
    expect(artifactsFromTurns([turn([{ name: 'Write', detail }])])).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /home/mithrandir/agentistics/.claude/worktrees/session-artifacts
bun test packages/web/src/lib/sessionArtifacts.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/web/src/lib/sessionArtifacts.ts`:

```ts
/**
 * sessionArtifacts.ts — PURE: which files the open session has written, from the conversation it
 * is already showing.
 *
 * THIS NEEDS NO SERVER, and that is the design rather than an economy. `ChatTurn.tools` already
 * arrives on every turn as `{ name, detail }`, and `chat-tail.ts`'s `toolDetail` reads named
 * fields in priority order — so for a file tool the `detail` IS the `file_path`. `SessionChat`
 * already polls that payload, so this list is exactly as fresh as the conversation beside it and
 * the two can never disagree by a poll interval.
 *
 * SELECTION IS BY TOOL NAME, NEVER BY THE SHAPE OF `detail`. `toolDetail`'s first key is
 * `command`, so a `Bash` call's detail is a shell line — and "this looks like a path" would put
 * `rm -rf build/` in a list of files somebody is about to click.
 *
 * `Read` is excluded. The question this panel answers is what the session PRODUCED; an assistant
 * reading forty files to answer one question would bury the two it wrote.
 */

/** The tools whose `detail` is a file path. Read from `chat-tail.ts`'s own priority list. */
export const ARTIFACT_TOOLS: ReadonlySet<string> = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
])

export interface Artifact {
  /** The absolute path, exactly as the transcript recorded it. */
  path: string
  /** The last segment — what the row is called. */
  name: string
  /** Everything before it, shown dim under the name. */
  dir: string
  /** `new` when the session's FIRST touch was a `Write`; `edited` otherwise. */
  kind: 'new' | 'edited'
  /** How many times this session touched it. */
  touches: number
  /** This is the file of a turn that has not finished — the one being written now. */
  live: boolean
}

interface Turnish {
  tools?: { name: string; detail?: string }[]
  pending?: boolean
}

export function artifactsFromTurns(turns: readonly Turnish[]): Artifact[] {
  // Insertion order is the transcript's order, which is what makes "first touch" answerable.
  const seen = new Map<string, { first: string; touches: number; order: number; live: boolean }>()
  let order = 0

  for (const t of turns) {
    for (const call of t?.tools ?? []) {
      if (!ARTIFACT_TOOLS.has(call.name)) continue
      const path = call.detail?.trim()
      if (!path) continue
      // `toolDetail` appends an ellipsis past 200 characters. A truncated path names no file, and
      // asking the server for one would be a refusal every time — so it is not offered.
      if (path.endsWith('…')) continue
      const prev = seen.get(path)
      if (prev) {
        prev.touches += 1
        prev.order = order++
        prev.live = t.pending === true
      } else {
        seen.set(path, { first: call.name, touches: 1, order: order++, live: t.pending === true })
      }
    }
  }

  return [...seen.entries()]
    .map(([path, v]) => {
      const cut = path.lastIndexOf('/')
      return {
        path,
        name: cut === -1 ? path : path.slice(cut + 1),
        dir: cut === -1 ? '' : path.slice(0, cut),
        kind: v.first === 'Write' ? ('new' as const) : ('edited' as const),
        touches: v.touches,
        live: v.live,
      }
    })
    // Newest first: the thing that just happened is what the panel is opened for.
    .sort((a, b) => (seen.get(b.path)!.order - seen.get(a.path)!.order))
}
```

- [ ] **Step 4: Run the tests**

```bash
bun test packages/web/src/lib/sessionArtifacts.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/lib/sessionArtifacts.ts packages/web/src/lib/sessionArtifacts.test.ts
git commit -m "feat(web): what a session has written, read from the conversation it already shows"
```

---

### Task 2: `artifact-file.ts` — which paths may be read

**Files:**
- Create: `packages/server/server/sessions/artifact-file.ts`
- Create: `packages/server/server/sessions/artifact-file.test.ts`

**Interfaces:**
- Produces: `ArtifactRefusal = 'not-touched' | 'outside-cwd' | 'not-a-file' | 'binary' | 'unreadable'`, `planArtifactRead({ path, cwd, allowed }): { ok: true; path: string } | { ok: false; reason: ArtifactRefusal }`.

This module is given **already-resolved** paths (the caller does the `realpath`), so it stays pure
and the containment rule is testable without a filesystem.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'bun:test'
import { planArtifactRead } from './artifact-file'

const cwd = '/home/u/proj'
const allowed = ['/home/u/proj/docs/spec.md', '/home/u/proj/src/a.ts']

describe('planArtifactRead', () => {
  it('allows a path the session touched, inside the cwd', () => {
    expect(planArtifactRead({ path: '/home/u/proj/docs/spec.md', cwd, allowed }))
      .toEqual({ ok: true, path: '/home/u/proj/docs/spec.md' })
  })

  it('refuses a path the session never touched, even inside the cwd', () => {
    // The reachable set is a consequence of what the session DID, not a rule about directories.
    // `/home/u/proj/.env` is in the project and has nothing to do with this conversation.
    expect(planArtifactRead({ path: '/home/u/proj/.env', cwd, allowed }))
      .toEqual({ ok: false, reason: 'not-touched' })
  })

  it('refuses a resolved path outside the cwd', () => {
    // The caller resolves first, so this is what an escaping symlink or a `..` LOOKS like here.
    expect(planArtifactRead({ path: '/home/u/.ssh/id_ed25519', cwd, allowed: ['/home/u/.ssh/id_ed25519'] }))
      .toEqual({ ok: false, reason: 'outside-cwd' })
  })

  it('refuses a sibling directory whose name merely starts with the cwd', () => {
    // `/home/u/proj-secrets` starts with `/home/u/proj` as a STRING and is a different directory.
    // Containment is by path SEGMENT, never by prefix.
    expect(planArtifactRead({
      path: '/home/u/proj-secrets/x.md', cwd, allowed: ['/home/u/proj-secrets/x.md'],
    })).toEqual({ ok: false, reason: 'outside-cwd' })
  })

  it('refuses the cwd itself — a directory is not a file', () => {
    expect(planArtifactRead({ path: cwd, cwd, allowed: [cwd] }))
      .toEqual({ ok: false, reason: 'not-a-file' })
  })

  it('refuses an empty path without pretending it is anything else', () => {
    expect(planArtifactRead({ path: '', cwd, allowed }))
      .toEqual({ ok: false, reason: 'not-touched' })
  })

  it('checks membership BEFORE containment, so an unrelated path never reveals the cwd', () => {
    // Answering `outside-cwd` for a path nobody asked about would confirm where the cwd is not.
    expect(planArtifactRead({ path: '/etc/passwd', cwd, allowed }).ok).toBe(false)
    expect(planArtifactRead({ path: '/etc/passwd', cwd, allowed }))
      .toEqual({ ok: false, reason: 'not-touched' })
  })
})
```

- [ ] **Step 2: Run and watch it fail**

```bash
bun test packages/server/server/sessions/artifact-file.test.ts
```

- [ ] **Step 3: Implement**

Create `packages/server/server/sessions/artifact-file.ts`:

```ts
/**
 * artifact-file.ts — PURE: may this file be read for this session?
 *
 * The most powerful thing in the artifacts panel is that it reads the disk, so the rule is written
 * once, here, with no IO in it. The caller resolves both paths with `realpath` FIRST and hands the
 * results in — which is what makes `..` and an escaping symlink ordinary inputs to this function
 * rather than string patterns it would have to recognise.
 *
 * TWO GATES, IN THIS ORDER:
 *
 *  1. **The session must have touched it.** The reachable set is a consequence of what the session
 *     did, not a rule about directories — `/home/u/proj/.env` is in the project and has nothing to
 *     do with this conversation. Checked FIRST, so a path nobody asked about is refused without
 *     the answer confirming anything about where the cwd is.
 *  2. **It must resolve inside the session's cwd.** By path SEGMENT, never by string prefix:
 *     `/home/u/proj-secrets` starts with `/home/u/proj` and is a different directory.
 *
 * REFUSE, NEVER REPAIR. A path that needed fixing is a path nobody meant to send, and a sanitiser
 * is a place for the next bug to hide. The codes are language-free; the caller renders the words.
 */

export type ArtifactRefusal =
  /** Not in this session's artifact list. */
  | 'not-touched'
  /** Resolved outside the session's working directory. */
  | 'outside-cwd'
  /** A directory, or something that is not a regular file. */
  | 'not-a-file'
  /** Not text — a NUL byte in the first chunk. */
  | 'binary'
  /** Present in the list and gone, or unreadable, at the moment it was asked for. */
  | 'unreadable'

export interface ArtifactReadRequest {
  /** The already-resolved absolute path being asked for. */
  path: string
  /** The already-resolved absolute working directory of the session. */
  cwd: string
  /** The already-resolved absolute paths this session touched. */
  allowed: readonly string[]
}

export type ArtifactReadPlan =
  | { ok: true; path: string }
  | { ok: false; reason: ArtifactRefusal }

/** Is `path` inside `dir`, by SEGMENT? `dir` itself is not "inside" itself. */
export function withinDirectory(path: string, dir: string): boolean {
  if (path === dir) return false
  const base = dir.endsWith('/') ? dir : `${dir}/`
  return path.startsWith(base)
}

export function planArtifactRead({ path, cwd, allowed }: ArtifactReadRequest): ArtifactReadPlan {
  if (path === '' || !allowed.includes(path)) return { ok: false, reason: 'not-touched' }
  if (path === cwd) return { ok: false, reason: 'not-a-file' }
  if (!withinDirectory(path, cwd)) return { ok: false, reason: 'outside-cwd' }
  return { ok: true, path }
}
```

- [ ] **Step 4: Run the tests**

```bash
bun test packages/server/server/sessions/artifact-file.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/server/server/sessions/artifact-file.ts packages/server/server/sessions/artifact-file.test.ts
git commit -m "feat(server): the rule for which of a session's files may be read"
```

---

### Task 3: the route

**Files:**
- Create: `packages/server/server/sessions/artifact-web.ts`
- Modify: `packages/server/server/index.ts` (the new handler, beside the other `/api/fleet/*` ones)
- Modify: `packages/server/server/capability-guard.test.ts`

**Interfaces:**
- Consumes: `planArtifactRead` (Task 2); the fleet host, for the session's row and its `cwd`; `readSessionChat`, for the same transcript the browser derived its list from.
- Produces: `readArtifact(lang, id, path): Promise<ArtifactResponse>` where `ArtifactResponse = { ok: true; text: string; path: string; relPath: string; bytes: number; truncated: boolean } | { ok: false; message: string }`; `MAX_ARTIFACT_BYTES`.

- [ ] **Step 1: Write the module**

Create `packages/server/server/sessions/artifact-web.ts`:

```ts
/**
 * artifact-web.ts — reading one file a session wrote.
 *
 * The ONLY part of the artifacts panel that touches the disk. Everything it is allowed to do is
 * decided by the pure `planArtifactRead`; what lives here is the IO and the two facts that can
 * only be learned by looking: whether it is text, and how big it is.
 *
 * THE ALLOWLIST IS REBUILT HERE, from the same transcript the browser read. The browser's list is
 * not trusted and is not even sent: a client asking for a path is asking a question, and the
 * answer comes from what the session actually did on this machine.
 *
 * `realpath` on BOTH sides before deciding, so `..` and a symlink pointing out of the project are
 * ordinary inputs to the rule rather than patterns to recognise. Refused, never normalised.
 */

import { realpath, readFile, stat } from 'node:fs/promises'
import { relative } from 'node:path'
import type { CliLang } from '../cli-lang'
import { planArtifactRead, type ArtifactRefusal } from './artifact-file'

/**
 * The most a file may carry into the page. Far above any spec and far below anything that would
 * trouble a browser. Named ONCE — no caller restates it.
 */
export const MAX_ARTIFACT_BYTES = 1024 * 1024

export type ArtifactResponse =
  | { ok: true; text: string; path: string; relPath: string; bytes: number; truncated: boolean }
  | { ok: false; message: string }

/** One sentence per refusal, in the caller's language. The pure module names none of these. */
export function artifactRefusalText(reason: ArtifactRefusal, lang: CliLang): string {
  const pt = lang === 'pt'
  switch (reason) {
    case 'not-touched':
      return pt
        ? 'Esta sessão não escreveu esse arquivo, então ele não pode ser aberto por aqui.'
        : 'This session did not write that file, so it cannot be opened from here.'
    case 'outside-cwd':
      return pt
        ? 'Esse caminho fica fora da pasta da sessão.'
        : 'That path resolves outside the session’s folder.'
    case 'not-a-file':
      return pt ? 'Isso é uma pasta, não um arquivo.' : 'That is a folder, not a file.'
    case 'binary':
      return pt
        ? 'Esse arquivo não é texto, então não há o que mostrar aqui.'
        : 'That file is not text, so there is nothing to show here.'
    case 'unreadable':
      return pt
        ? 'Não consegui ler esse arquivo agora — ele pode ter sido movido ou apagado.'
        : 'That file could not be read just now — it may have been moved or deleted.'
  }
}

/** A NUL byte in the first chunk. The same test `file(1)` starts from, and enough for this. */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0)
}

export async function readArtifact(
  lang: CliLang,
  cwd: string,
  allowedRaw: readonly string[],
  requested: string,
): Promise<ArtifactResponse> {
  const refuse = (r: ArtifactRefusal) => ({ ok: false as const, message: artifactRefusalText(r, lang) })

  // Resolve everything first. A path that cannot be resolved is not a path this machine has.
  const resolve = async (p: string): Promise<string | null> => {
    try { return await realpath(p) } catch { return null }
  }
  const cwdReal = await resolve(cwd)
  if (cwdReal === null) return refuse('unreadable')
  const pathReal = await resolve(requested)
  if (pathReal === null) return refuse('unreadable')

  const allowed: string[] = []
  for (const a of allowedRaw) {
    const r = await resolve(a)
    if (r !== null) allowed.push(r)
  }

  const plan = planArtifactRead({ path: pathReal, cwd: cwdReal, allowed })
  if (!plan.ok) return refuse(plan.reason)

  let bytes: number
  try {
    const st = await stat(plan.path)
    if (!st.isFile()) return refuse('not-a-file')
    bytes = st.size
  } catch { return refuse('unreadable') }

  let buf: Buffer
  try { buf = await readFile(plan.path) } catch { return refuse('unreadable') }
  if (looksBinary(buf)) return refuse('binary')

  const truncated = bytes > MAX_ARTIFACT_BYTES
  return {
    ok: true,
    // Truncated and SAYING so. A spec silently cut short is a document lying about being complete.
    text: (truncated ? buf.subarray(0, MAX_ARTIFACT_BYTES) : buf).toString('utf8'),
    path: plan.path,
    relPath: relative(cwdReal, plan.path),
    bytes,
    truncated,
  }
}
```

- [ ] **Step 2: Add the handler**

In `packages/server/server/index.ts`, beside the other `/api/fleet/*` handlers:

```ts
// One file this session wrote. Guarded by the `/api/fleet` PREFIX already registered in
// `capability-guard.ts` — a new fleet route is guarded by having been ADDED, never by remembering
// a second table — and 404'd on a central with the rest of `/api/fleet*`.
if (url.pathname === '/api/fleet/file' && req.method === 'GET') {
  const id = url.searchParams.get('id')
  const path = url.searchParams.get('path')
  if (!id || !path) {
    return new Response(JSON.stringify({ ok: false, message: 'bad_request' }), {
      status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }
  try {
    const { readFleetArtifact, fleetLang } = await import('./sessions/fleet-web')
    const out = await readFleetArtifact(fleetLang(url.searchParams.get('lang')), id, path)
    return new Response(JSON.stringify(out), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, ...safeError(err, { verbose: PROFILE === 'local' }).body }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    })
  }
}
```

- [ ] **Step 3: Resolve the session in `fleet-web.ts`**

Add to `packages/server/server/sessions/fleet-web.ts`:

```ts
/**
 * Read one artifact of ONE session.
 *
 * SCOPE IS CHECKED FIRST, exactly as `GET /api/fleet/attach` checks it: an unknown id must not be
 * answered with a file assembled from anything this server happens to have. And the allowlist is
 * REBUILT here from the session's own transcript — the browser's list is not sent and would not be
 * believed if it were.
 */
export async function readFleetArtifact(lang: CliLang, id: string, path: string) {
  const host = await hostFor(lang)
  const fleet = await host.sessions?.()
  const row = fleet?.sessions.find(r => r.id === id || r.conversationId === id)
  if (!row) {
    return {
      ok: false,
      message: lang === 'pt'
        ? 'Essa sessão não está na lista desta máquina.'
        : 'That session is not in this machine’s list.',
    }
  }
  const chat = await readSessionChat(host, lang, row.id)
  const allowed = artifactPathsFromTurns(chat.turns)
  const { readArtifact } = await import('./artifact-web')
  return await readArtifact(lang, row.cwd, allowed, path)
}
```

`artifactPathsFromTurns` is the server's own two-line reader over the same `ChatTurn.tools`,
selecting by the same tool names. It lives in `artifact-file.ts` (pure) and is shared with nothing
else — the browser has its own richer `artifactsFromTurns` because it also needs names, kinds and
counts, and the server needs only the paths.

Add to `artifact-file.ts`:

```ts
/** The tools whose `detail` is a file path — the same set the browser selects by. */
export const ARTIFACT_TOOL_NAMES = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const

/** PURE: just the paths, for the server's allowlist. */
export function artifactPathsFromTurns(
  turns: readonly { tools?: { name: string; detail?: string }[] }[],
): string[] {
  const out = new Set<string>()
  for (const t of turns) {
    for (const call of t?.tools ?? []) {
      if (!(ARTIFACT_TOOL_NAMES as readonly string[]).includes(call.name)) continue
      const p = call.detail?.trim()
      if (p && !p.endsWith('…')) out.add(p)
    }
  }
  return [...out]
}
```

Add a test for it in `artifact-file.test.ts` mirroring the Bash and the ellipsis cases from Task 1 —
the two selectors must agree, and this is the one that guards the disk.

- [ ] **Step 4: Pin the guard**

In `packages/server/server/capability-guard.test.ts`, beside the other concrete fleet paths:

```ts
expect(capabilityFor('/api/fleet/file')).toBe('localShell')
```

- [ ] **Step 5: Verify every refusal with curl**

With a server running and a real session id that has written a file:

```bash
S=<session-id>; P=<a path that session wrote>
# allowed
curl -s "http://localhost:47291/api/fleet/file?id=$S&path=$P&lang=en" | head -c 300
# not touched, inside the project
curl -s "http://localhost:47291/api/fleet/file?id=$S&path=$HOME/agentistics/package.json&lang=en"
# outside the project
curl -s "http://localhost:47291/api/fleet/file?id=$S&path=/etc/passwd&lang=en"
# traversal
curl -s "http://localhost:47291/api/fleet/file?id=$S&path=$HOME/agentistics/../../etc/passwd&lang=en"
# unknown session
curl -s "http://localhost:47291/api/fleet/file?id=nope&path=$P&lang=en"
```

Expected: the first returns text; **every other one returns `ok:false` with a sentence**, and none
of them returns file content. If any refusal returns content, stop and fix before continuing —
that is the whole point of the task.

- [ ] **Step 6: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/server/server/sessions/artifact-web.ts packages/server/server/sessions/artifact-file.ts packages/server/server/sessions/artifact-file.test.ts packages/server/server/sessions/fleet-web.ts packages/server/server/index.ts packages/server/server/capability-guard.test.ts
git commit -m "feat(server): one route reads a file a session wrote, and refuses four ways"
```

---

### Task 4: `ArtifactDoc` — one file, rendered

**Files:**
- Create: `packages/web/src/components/sessions/ArtifactDoc.tsx`

**Interfaces:**
- Consumes: `GET /api/fleet/file`.
- Produces: `ArtifactDoc({ sessionId, artifact, lang, onBack })`.

- [ ] **Step 1: Build it**

The header carries a back control, the file name, the relative path and the copy-path button. The
body is `react-markdown` + `remark-gfm` for `.md`/`.markdown`, and a monospace `<pre>` that scrolls
**inside its own container** for everything else.

```tsx
/**
 * ArtifactDoc — one file the session wrote, read here.
 *
 * Markdown goes through the SAME `react-markdown` + `remark-gfm` the chat bubbles use, so a table
 * or a code block reads the same in both places. Everything else is monospace and unhighlighted:
 * syntax highlighting would be a new dependency for a panel whose purpose is reading prose.
 *
 * `⧉` copies the ABSOLUTE path. It opens no editor — this server does not launch programs on
 * behalf of a page, and a button that pretended to would be the one dishonest control here.
 */
```

Three states, three different sentences — never one empty box:
- loading: "Lendo o arquivo…" / "Reading the file…";
- refused: the server's own `message`, verbatim (the machine words its refusals; this component
  composes none);
- truncated: a `role="status"` line above the content naming the real size — e.g.
  "Mostrando o primeiro 1 MB de 4,2 MB." / "Showing the first 1 MB of 4.2 MB."

- [ ] **Step 2: Make wide content scroll inside itself**

`pre`, `table` and long code blocks get `overflow-x: auto` on their own container. The page body
must never scroll horizontally — this is checked at 390px in Task 8.

- [ ] **Step 3: Verify with the user**

```bash
bun run dev
```

There is no panel yet (that is Phase B), so mount it temporarily behind a query parameter or a
scratch route to look at it, and ask the user to confirm a real spec renders — headings, table,
code block — and that a `.ts` file renders as readable monospace. Remove the temporary mount before
committing.

- [ ] **Step 4: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/components/sessions/ArtifactDoc.tsx
git commit -m "feat(web): a file a session wrote, rendered where you are reading the session"
```

---

## Phase B — the panel and its place

**STOP HERE unless `feat/sessions-overhaul` has landed Phase 1b (`SessionsRail`) and Phase 2 (the
unified header).** Phase B reads both. If they are not in this branch's history, say so and stop —
do not reimplement either.

### Task 5: `artifactLayout.ts` — where the panel goes

**Files:**
- Create: `packages/web/src/lib/artifactLayout.ts`
- Create: `packages/web/src/lib/artifactLayout.test.ts`

**Interfaces:**
- Produces: `ArtifactLayout = 'closed' | 'split' | 'split-rail' | 'overlay' | 'fullscreen'`, `resolveArtifactLayout({ open, width, isMobile, listExpandedByUser }): { layout: ArtifactLayout; collapseList: boolean }`, `SPLIT_MIN_WIDTH`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'bun:test'
import { resolveArtifactLayout } from './artifactLayout'

const at = (o: Partial<Parameters<typeof resolveArtifactLayout>[0]>) =>
  resolveArtifactLayout({ open: true, width: 1440, isMobile: false, listExpandedByUser: false, ...o })

describe('resolveArtifactLayout', () => {
  it('is closed when it is closed, and asks for no collapse', () => {
    expect(at({ open: false })).toEqual({ layout: 'closed', collapseList: false })
  })

  it('opens split and collapses the fleet list to the rail', () => {
    expect(at({})).toEqual({ layout: 'split-rail', collapseList: true })
  })

  it('KEEPS the list when the user expanded it themselves — their choice wins', () => {
    expect(at({ listExpandedByUser: true })).toEqual({ layout: 'split', collapseList: false })
  })

  it('becomes an overlay below the three-column floor, whatever the user chose', () => {
    expect(at({ width: 1000 })).toEqual({ layout: 'overlay', collapseList: false })
    expect(at({ width: 1000, listExpandedByUser: true }))
      .toEqual({ layout: 'overlay', collapseList: false })
  })

  it('is full-screen on mobile, at any width', () => {
    expect(at({ isMobile: true })).toEqual({ layout: 'fullscreen', collapseList: false })
    expect(at({ isMobile: true, width: 1440 })).toEqual({ layout: 'fullscreen', collapseList: false })
  })

  it('never asks to collapse the list in a layout that does not use the rail', () => {
    for (const o of [{ width: 1000 }, { isMobile: true }, { open: false }]) {
      expect(at(o).collapseList, JSON.stringify(o)).toBe(false)
    }
  })
})
```

- [ ] **Step 2: Run and watch it fail, then implement**

```ts
/**
 * artifactLayout.ts — PURE: where the artifacts panel goes, and what that costs the fleet list.
 *
 * Opening the panel COLLAPSES the session list to its rail, and the width comes from where it was
 * not being read: at the moment somebody opens a file to read it, the list is the least consulted
 * thing on screen. Measured at 1440px — list 248, rail 64, panel 440 — that is 936px of
 * conversation instead of 752.
 *
 * ONE CLICK DOING TWO THINGS is normally a defect, so the reversal sticks: `listExpandedByUser`
 * means the person opened the list back up with the panel open, and their choice WINS for as long
 * as it is set. The layout then degrades to a plain three-column split, which is the honest
 * arrangement it would have had anyway.
 *
 * Below `SPLIT_MIN_WIDTH` there is no room for three columns and the choice stops existing: the
 * panel becomes an overlay, and nothing is collapsed — collapsing a list the layout is not using
 * would be taking something for nothing.
 */
export const SPLIT_MIN_WIDTH = 1100
```

- [ ] **Step 3: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/lib/artifactLayout.ts packages/web/src/lib/artifactLayout.test.ts
git commit -m "feat(web): where the artifacts panel goes, and what it gives back when it closes"
```

---

### Task 6: `ArtifactsAside` — the two layers

**Files:**
- Create: `packages/web/src/components/sessions/ArtifactsAside.tsx`

- [ ] **Step 1: Build the list layer**

Header: `◧ Artefatos`, the count (`4 arquivos · 2 novos`), close. Two bands — **agora** (the `live`
artifact) and **antes** — each row: a dot coloured by `kind`, the name, the directory dim beneath,
and `escrevendo…` on the live one.

- [ ] **Step 2: Three empty states, three sentences**

Never one empty box:
- the conversation has not loaded yet;
- the session has written nothing yet ("Nada escrito ainda nesta sessão.");
- the harness cannot be read this way at all — reuse the `unavailable` sentence
  `/api/fleet/chat` already returns, verbatim.

- [ ] **Step 3: The file layer is `ArtifactDoc` (Task 4)**, with `onBack` returning to the list.

- [ ] **Step 4: It never changes what it shows on its own.** The list updates with each poll; the
  open file changes only on a click. Assert this by reading the component: there must be no effect
  that sets the selected artifact from incoming data.

- [ ] **Step 5: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/components/sessions/ArtifactsAside.tsx
git commit -m "feat(web): the artifacts panel — what this session touched, and the file itself"
```

---

### Task 7: the `◧` button and the wiring

**Files:**
- Modify: `packages/web/src/App.tsx` (the unified header's trailing group — Phase 2's `sessionTopBar`)
- Modify: `packages/web/src/pages/SessionsPage.tsx` (the split)

- [ ] **Step 1: The button**

Beside the Chat/Terminal tabs, carrying the artifact count. **Absent on a central**, with the
sentence — the list is derived from the conversation, and the conversation does not cross:

- EN: "The artifact list is read from the session's conversation, which stays on the machine."
- PT: "A lista de artefatos é lida da conversa da sessão, e a conversa não sai da máquina."

Absent, not disabled: a control that cannot work is not rendered inert.

- [ ] **Step 2: The split**

`SessionsPage` reads `resolveArtifactLayout` and renders the panel accordingly. The divider is
draggable in `split` / `split-rail`, with its width persisted like the aside's.

Both wrappers keep `display: flex; flexDirection: column` — `SessionsPage` records this bug twice
already: `flex: 1` on a child means nothing until its PARENT is a flex container.

- [ ] **Step 3: Restore on close**

Closing returns the fleet list to the state it was in before opening, not to a default. Hold that
previous state next to the panel's own open flag.

- [ ] **Step 4: Verify with the user at three widths**

Ask them to check 1440px, 1280px and ~1000px: the collapse happens, expanding the list keeps it,
closing restores, and below 1100px it becomes an overlay.

- [ ] **Step 5: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/App.tsx packages/web/src/pages/SessionsPage.tsx
git commit -m "feat(web): open the artifacts panel from the header, and give the width back on close"
```

---

### Task 8: mobile

**Files:**
- Modify: `packages/web/src/pages/SessionsPage.tsx` (the mobile branch)

- [ ] **Step 1: Full-screen, with a back control**, reached from the same `◧` in the one bar the
  mobile sessions workspace has.
- [ ] **Step 2: 44px targets** on every file row and on the back control.
- [ ] **Step 3: Verify at 390px** — ask the user to confirm
  `document.documentElement.scrollWidth <= window.innerWidth` holds with the panel open and a wide
  code block on screen, and that the list scrolls.
- [ ] **Step 4: Commit**

```bash
bun tsc --noEmit && bun test
git add packages/web/src/pages/SessionsPage.tsx
git commit -m "feat(web): the artifacts panel on a phone — one screen at a time"
```

---

## Self-review

- **Spec coverage.** Layout C → Tasks 5, 7. The live list → Task 1, rendered in 6. The file route
  and its four refusals → Tasks 2, 3. Rendering → Task 4. Central absent-with-a-sentence → Task 7.
  Mobile → Task 8. The "never changes on its own" rule → Task 6 step 4.
- **Interfaces.** `artifactsFromTurns`/`Artifact` (1) → 6. `planArtifactRead`/`ArtifactRefusal` and
  `artifactPathsFromTurns` (2) → 3. `readFleetArtifact` (3) → 4. `resolveArtifactLayout` (5) → 7.
  `ArtifactDoc` (4) → 6.
- **Order.** 1, 2 independent; 3 needs 2; 4 needs 3; Phase B needs Phase A **and** the other
  branch's 1b + 2.
- **Two selectors, one rule.** The browser's `artifactsFromTurns` and the server's
  `artifactPathsFromTurns` select by the same tool names for different outputs. Task 3 step 3
  requires the server's to be tested against the same Bash and ellipsis cases — it is the one
  guarding the disk, and a disagreement between them is a refusal the user cannot explain.
