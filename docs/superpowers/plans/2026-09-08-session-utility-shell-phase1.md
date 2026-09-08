# Session Utility Shell — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real shell can be opened, listed and closed in a session's own directory, through
`/api/shell/*`, invisible to the fleet — verifiable entirely from `curl` and `tmux`, with no UI.

**Architecture:** A shell is a detached tmux session running `$SHELL` in the fleet row's `cwd`, on
tmux socket **`agentop-shell`** — a socket of its own, so `list-sessions -L agentop` cannot see it
and it can never become a fleet row. Its record lives in `~/.agentistics/shells.json`, a separate
file with a separate writer from `managed-sessions.json`. The decisions (which argv, which refusal,
the ceiling) are pure modules; the tmux and filesystem work is thin around them.

**Tech Stack:** Bun, TypeScript (strict), tmux 3.2a, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-09-08-session-utility-shell-design.md` — §2 Backend, §3
isolation, §4 lifetime, §7 security, §8 refusals, §10 pure modules.

## Global Constraints

- **Language:** everything in this repo is English — code, comments, docs. Commit messages follow
  Conventional Commits; this repo's recent history writes them in Portuguese, so match that.
- **Worktree:** `.claude/worktrees/session-shell`, branch `feat/session-shell`, based on
  `origin/dev`. Never `cd` the session into it; use `git -C` and absolute paths.
- **Pre-commit hook runs `bun tsc --noEmit` and the full `bun test`.** Both must pass on every
  commit; there are 7352 tests today.
- **Never stage with `git add -A`** — other sessions share this checkout's siblings. Stage the exact
  paths each step names.
- **Purity:** `shell-spec.ts`, `shell-gate.ts` and `shell-reap.ts` import no `node:fs`, no
  `Bun.spawn`, and no config constants. Every fact they need arrives as an argument.
- **N/A over a confident value:** every refusal is a NAMED reason code, rendered into a sentence by
  the caller. No route returns an empty success where it means "cannot".
- **The ceiling is 8** (`SHELL_CAP`), stated once, in `shell-spec.ts`.
- **Absent preference reads as OFF** (`shellEnabled`), and the preference may only ever NARROW
  `CAPS.localShell`.

---

### Task 1: The tmux argv builders take a socket

The shell must live on its own tmux socket, and today every builder closes over `TMUX_SOCKET`. This
task is the seam. Nothing else changes: every existing call keeps today's socket by default.

**Files:**
- Modify: `packages/server/server/sessions/tmux-cli.ts`
- Test: `packages/server/server/sessions/tmux-cli.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SHELL_SOCKET: string`; `newSessionArgs(o: { id, cwd, argv, truecolor?, socket? })`;
  and an optional trailing `socket?: string` on `killSessionArgs`, `capturePaneAnsiArgs`,
  `paneInfoArgs`, `sendKeysLiteralArgs`, `sendKeysNamedArgs`, `listSessionsArgs`.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/server/sessions/tmux-cli.test.ts`:

```ts
describe('the socket is a parameter — the utility shell runs on its own', () => {
  // A shell on the FLEET socket would be seen by `list-sessions -L agentop`, kept by
  // `parseTmuxList` (its name starts with `agentop-`), and then reported by `reconcileSessions`
  // as an `unregistered` row — "visible and inert", per session-adopt.ts. A separate socket
  // cannot be got wrong by a later refactor the way a name prefix can.
  test('SHELL_SOCKET is not the fleet socket', () => {
    expect(SHELL_SOCKET).not.toBe(TMUX_SOCKET)
  })

  test('every builder defaults to the fleet socket, so existing callers are untouched', () => {
    expect(killSessionArgs('a').slice(0, 2)).toEqual(['-L', TMUX_SOCKET])
    expect(paneInfoArgs('a').slice(0, 2)).toEqual(['-L', TMUX_SOCKET])
    expect(listSessionsArgs().slice(0, 2)).toEqual(['-L', TMUX_SOCKET])
    expect(capturePaneAnsiArgs('a', 10).slice(0, 2)).toEqual(['-L', TMUX_SOCKET])
    expect(sendKeysLiteralArgs('a', 'x').slice(0, 2)).toEqual(['-L', TMUX_SOCKET])
    expect(sendKeysNamedArgs('a', 'Enter').slice(0, 2)).toEqual(['-L', TMUX_SOCKET])
    expect(newSessionArgs({ id: 'a', cwd: '/w', argv: ['bash'] }).slice(0, 2))
      .toEqual(['-L', TMUX_SOCKET])
  })

  test('every builder takes the shell socket when asked, and changes nothing else', () => {
    expect(killSessionArgs('a', SHELL_SOCKET))
      .toEqual(['-L', SHELL_SOCKET, 'kill-session', '-t', 'agentop-a'])
    expect(listSessionsArgs(SHELL_SOCKET).slice(0, 2)).toEqual(['-L', SHELL_SOCKET])
    expect(paneInfoArgs('a', SHELL_SOCKET).slice(0, 2)).toEqual(['-L', SHELL_SOCKET])
    expect(capturePaneAnsiArgs('a', 10, SHELL_SOCKET).slice(0, 2)).toEqual(['-L', SHELL_SOCKET])
    expect(sendKeysLiteralArgs('a', 'x', SHELL_SOCKET).slice(0, 2)).toEqual(['-L', SHELL_SOCKET])
    expect(sendKeysNamedArgs('a', 'Enter', SHELL_SOCKET).slice(0, 2)).toEqual(['-L', SHELL_SOCKET])
    expect(newSessionArgs({ id: 'a', cwd: '/w', argv: ['bash'], socket: SHELL_SOCKET }))
      .toEqual([
        '-L', SHELL_SOCKET, 'new-session', '-d', '-s', 'agentop-a',
        '-x', '120', '-y', '50', '-c', '/w', '--', 'bash',
      ])
  })
})
```

Add `SHELL_SOCKET` to that file's existing import from `./tmux-cli`.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/mithrandir/agentistics/.claude/worktrees/session-shell
bun test packages/server/server/sessions/tmux-cli.test.ts
```

Expected: FAIL — `SHELL_SOCKET` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `tmux-cli.ts`, below `export const SESSION_PREFIX`:

```ts
/**
 * The socket the UTILITY SHELL runs on, and the reason it is not `TMUX_SOCKET`.
 *
 * A shell opened for a session is not a fleet row and must never become one. On the fleet socket it
 * would be: `idFromTmuxName` strips `agentop-`, so `parseTmuxList` KEEPS it, and `reconcileSessions`
 * then finds a running session the registry has no record of and calls it `unregistered` — a row
 * `session-adopt.ts` describes as "visible and inert", filed under `GONE_PROJECT_KEY`, that no verb
 * in the cockpit can act on.
 *
 * A name convention would have worked and been one refactor from breaking. A socket cannot break:
 * `list-sessions -L agentop` cannot see another socket at all. Same argument this module already
 * makes for keeping OUR sessions out of the USER's tmux, applied to keep our shells out of our
 * fleet.
 */
export const SHELL_SOCKET = 'agentop-shell'
```

Change `sock` and the builders:

```ts
const sock = (rest: string[], socket: string = TMUX_SOCKET): string[] => ['-L', socket, ...rest]
```

```ts
export function newSessionArgs(
  o: { id: string; cwd: string; argv: string[]; truecolor?: boolean; socket?: string },
): string[] {
  const env = o.truecolor ? ['-e', 'COLORTERM=truecolor'] : []
  return sock([
    'new-session', '-d', '-s', tmuxName(o.id),
    '-x', String(PANE_COLS), '-y', String(PANE_ROWS),
    '-c', o.cwd, ...env, '--', ...o.argv,
  ], o.socket)
}

export function killSessionArgs(id: string, socket?: string): string[] {
  return sock(['kill-session', '-t', tmuxName(id)], socket)
}

export function capturePaneAnsiArgs(id: string, lines: number, socket?: string): string[] {
  return sock(['capture-pane', '-p', '-e', '-t', tmuxName(id), '-S', `-${lines}`], socket)
}

export function paneInfoArgs(id: string, socket?: string): string[] {
  return sock(['display-message', '-p', '-t', tmuxName(id), '-F', PANE_INFO_FORMAT], socket)
}

export function sendKeysLiteralArgs(id: string, text: string, socket?: string): string[] {
  return sock(['send-keys', '-t', tmuxName(id), '-l', text], socket)
}

export function sendKeysNamedArgs(id: string, key: string, socket?: string): string[] {
  return sock(['send-keys', '-t', tmuxName(id), key], socket)
}

export function sendKeysEnterArgs(id: string, socket?: string): string[] {
  return sendKeysNamedArgs(id, 'Enter', socket)
}

export function listSessionsArgs(socket?: string): string[] {
  return sock(['list-sessions', '-F', LIST_FORMAT], socket)
}
```

Note `sock`'s default must be `TMUX_SOCKET` and not `undefined`, so a caller passing `undefined`
explicitly still gets the fleet socket.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/server/server/sessions/tmux-cli.test.ts
bun tsc --noEmit
```

Expected: all tmux-cli tests PASS, tsc silent.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/sessions/tmux-cli.ts packages/server/server/sessions/tmux-cli.test.ts
git commit -m "refactor(sessions): o socket do tmux vira parâmetro, com o padrão de hoje"
```

---

### Task 2: `shell-spec.ts` — what opening a shell decides

**Files:**
- Create: `packages/server/server/sessions/shell-spec.ts`
- Test: `packages/server/server/sessions/shell-spec.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `SHELL_CAP: 8`; `type ShellRefusal`; `interface ShellOpenFacts`;
  `type ShellOpenPlan = { ok: true; argv: string[]; cwd: string } | { ok: false; reason: ShellRefusal }`;
  `planShellOpen(f: ShellOpenFacts): ShellOpenPlan`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/server/sessions/shell-spec.test.ts`:

```ts
import { describe, expect, test } from 'bun:test'
import { planShellOpen, SHELL_CAP, type ShellOpenFacts } from './shell-spec'

const ok: ShellOpenFacts = {
  cwd: '/home/u/proj',
  cwdExists: true,
  tmuxAvailable: true,
  openCount: 0,
  shell: '/usr/bin/zsh',
}

describe('planShellOpen', () => {
  test('opens the user’s own shell in the session’s directory', () => {
    expect(planShellOpen(ok)).toEqual({ ok: true, argv: ['/usr/bin/zsh'], cwd: '/home/u/proj' })
  })

  test('falls back to bash when the environment names no shell', () => {
    const p = planShellOpen({ ...ok, shell: undefined })
    expect(p).toEqual({ ok: true, argv: ['/bin/bash'], cwd: '/home/u/proj' })
  })

  test('an empty SHELL is not a shell', () => {
    // `process.env.SHELL` can be present and empty; spawning '' would fail with no useful message.
    expect(planShellOpen({ ...ok, shell: '' })).toEqual(
      { ok: true, argv: ['/bin/bash'], cwd: '/home/u/proj' },
    )
  })

  test('no tmux refuses first — nothing else can work without it', () => {
    const p = planShellOpen({ ...ok, tmuxAvailable: false, cwd: undefined, openCount: 99 })
    expect(p).toEqual({ ok: false, reason: 'no-tmux' })
  })

  test('a session with no recorded directory is refused, never opened in $HOME', () => {
    // Opening somewhere other than where it was asked for is the same class of error as a
    // confident 0 for a metric nobody can produce. See the spec, §8.
    expect(planShellOpen({ ...ok, cwd: undefined })).toEqual({ ok: false, reason: 'no-cwd' })
  })

  test('a directory that is gone is refused, and is its own reason', () => {
    // The removed-worktree case repo-facts.ts documents. It reads differently from "no directory
    // recorded" and sends the user somewhere else, so it is not folded into it.
    expect(planShellOpen({ ...ok, cwdExists: false })).toEqual({ ok: false, reason: 'cwd-missing' })
  })

  test('THE CEILING: the ninth shell is refused', () => {
    expect(planShellOpen({ ...ok, openCount: SHELL_CAP - 1 }).ok).toBe(true)
    expect(planShellOpen({ ...ok, openCount: SHELL_CAP })).toEqual({ ok: false, reason: 'at-cap' })
    expect(planShellOpen({ ...ok, openCount: SHELL_CAP + 5 })).toEqual({ ok: false, reason: 'at-cap' })
  })

  test('an IMPOSSIBLE open is refused before a merely FULL one', () => {
    // Being told to close a shell to make room, for an open that could never have worked, is a
    // request to destroy work for nothing.
    expect(planShellOpen({ ...ok, cwdExists: false, openCount: SHELL_CAP }))
      .toEqual({ ok: false, reason: 'cwd-missing' })
  })

  test('the ceiling is 8, and it is stated here and nowhere else', () => {
    expect(SHELL_CAP).toBe(8)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/server/server/sessions/shell-spec.test.ts
```

Expected: FAIL — `Cannot find module './shell-spec'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/server/sessions/shell-spec.ts`:

```ts
/**
 * shell-spec.ts — PURE. What opening a utility shell decides, and every way it refuses.
 *
 * The shell is a PTY in the session's own directory, opened for the person, and it is the most
 * powerful thing this server can be asked for. So every decision that can be silently wrong lives
 * here, tested without a tmux server: which binary, which directory, and which of the four
 * refusals applies.
 *
 * A REFUSAL IS A CODE, NEVER A SENTENCE. The route renders it, so the module stays language-free —
 * the same split `central-runtime.ts` makes with its reason codes and `LiveUnavailableReason` makes
 * with its own.
 */

/**
 * How many utility shells one machine may hold at once.
 *
 * A CEILING AND NOT A TIMER, and the number lives here alone. A TTL would kill the `bun test` that
 * finished at minute 61 and whose output the person wanted, at an hour nobody was watching, and it
 * needs a timer running for the life of the process. A ceiling needs nothing running: it is one
 * check, on open, and it only ever closes something at the instant somebody is asking for a new
 * one — so the trade is visible at the moment it is made.
 */
export const SHELL_CAP = 8

/** Why a shell could not be opened. Rendered into a sentence by the caller, never here. */
export type ShellRefusal =
  /** tmux is not on this host — no PTY, so no shell. Windows without WSL is this case. */
  | 'no-tmux'
  /** The row records no working directory, and there is no second-best place to open one. */
  | 'no-cwd'
  /** It records one, and that directory is gone — the removed-worktree case. */
  | 'cwd-missing'
  /** `SHELL_CAP` shells are already open. */
  | 'at-cap'

/** Everything the decision needs. Every field is a FACT the caller measured; none is read here. */
export interface ShellOpenFacts {
  /** The fleet row's `cwd`, or undefined when the registry holds none. */
  cwd: string | undefined
  /** Does that directory exist right now? Meaningless when `cwd` is undefined. */
  cwdExists: boolean
  tmuxAvailable: boolean
  /** How many shells are open on this machine already. */
  openCount: number
  /** `process.env.SHELL`, which may be absent or empty. */
  shell: string | undefined
}

export type ShellOpenPlan =
  | { ok: true; argv: string[]; cwd: string }
  | { ok: false; reason: ShellRefusal }

/** The shell to run when the environment names none. Present on every host that has tmux. */
const FALLBACK_SHELL = '/bin/bash'

/**
 * The order of the refusals is the design, not an accident.
 *
 * The IMPOSSIBLE ones come before the merely FULL one: at the ceiling, the caller asks the person
 * to close a shell to make room, and asking someone to destroy work to make room for an open that
 * could never have succeeded is worse than saying no.
 *
 * The shell is run bare — no `-l`. tmux gives the pane a tty, so it is already an interactive
 * shell; adding a login flag would make it read a different set of rc files from the panes
 * `agentop session` opens, and two kinds of shell on one machine is a difference nobody asked for.
 */
export function planShellOpen(f: ShellOpenFacts): ShellOpenPlan {
  if (!f.tmuxAvailable) return { ok: false, reason: 'no-tmux' }
  if (!f.cwd) return { ok: false, reason: 'no-cwd' }
  if (!f.cwdExists) return { ok: false, reason: 'cwd-missing' }
  if (f.openCount >= SHELL_CAP) return { ok: false, reason: 'at-cap' }
  return { ok: true, argv: [f.shell || FALLBACK_SHELL], cwd: f.cwd }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/server/server/sessions/shell-spec.test.ts
bun tsc --noEmit
```

Expected: 9 pass, 0 fail; tsc silent.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/sessions/shell-spec.ts packages/server/server/sessions/shell-spec.test.ts
git commit -m "feat(sessions): decide o que abrir um shell utilitário significa, e como ele recusa"
```

---

### Task 3: `shell-gate.ts` and the `shellEnabled` preference

**Files:**
- Create: `packages/server/server/sessions/shell-gate.ts`
- Modify: `packages/server/server/preferences.ts` (the `Preferences` interface)
- Test: `packages/server/server/sessions/shell-gate.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `shellAllowed(capable: boolean, preference: boolean | undefined): boolean`;
  `Preferences.shellEnabled?: boolean`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/server/sessions/shell-gate.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { shellAllowed } from './shell-gate'

test('ABSENT READS AS OFF — nobody gets a browser shell by having upgraded', () => {
  expect(shellAllowed(true, undefined)).toBe(false)
})

test('an explicit no is a no', () => {
  expect(shellAllowed(true, false)).toBe(false)
})

test('both together, and only both together', () => {
  expect(shellAllowed(true, true)).toBe(true)
})

test('the preference may only ever NARROW the profile, never re-open it', () => {
  // A switch that could re-enable what `public` denied would be the opt-in exposure.ts exists to
  // make impossible.
  expect(shellAllowed(false, true)).toBe(false)
  expect(shellAllowed(false, undefined)).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/server/server/sessions/shell-gate.test.ts
```

Expected: FAIL — `Cannot find module './shell-gate'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/server/sessions/shell-gate.ts`:

```ts
/** PURE: may this machine serve a utility shell?
 *
 *  A raw shell is strictly more powerful than the chat, which `chat-gate.ts` already calls the most
 *  powerful thing this server does — the chat at least spawns a named assistant CLI, while this
 *  spawns whatever the person types. So it takes the same two gates, in the same order:
 *
 *  - `capable` is `CAPS.localShell`, decided by the exposure profile. It is the SECURITY answer.
 *  - `preference` is the user's own switch, and it may only ever NARROW. A preference that could
 *    re-enable what `public` denied would be an opt-in restoring host power on an exposed instance,
 *    which `exposure.ts` exists to make impossible.
 *
 *  Absent reads as OFF, deliberately, and for the reason `chatAllowed` gives: treating absence as
 *  ON would leave a shell open on every machine nobody has touched since the upgrade. The cost of
 *  the strict reading is a switch to flip in Settings. The cost of the lenient one is a shell
 *  nobody asked for, in a browser. */
export function shellAllowed(capable: boolean, preference: boolean | undefined): boolean {
  return capable && preference === true
}
```

In `packages/server/server/preferences.ts`, beside `chatEnabled`, add:

```ts
  /** Opt-in for the per-session utility SHELL (`/api/shell/*`). Absent reads as OFF, and it can
   *  only ever narrow `CAPS.localShell`; see sessions/shell-gate.ts. Separate from `chatEnabled`
   *  because they are different powers: the chat runs a named assistant, this runs anything. */
  shellEnabled?: boolean
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/server/server/sessions/shell-gate.test.ts
bun tsc --noEmit
```

Expected: 4 pass; tsc silent.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/sessions/shell-gate.ts packages/server/server/sessions/shell-gate.test.ts packages/server/server/preferences.ts
git commit -m "feat(sessions): o shell utilitário é opt-in, e ausente lê como desligado"
```

---

### Task 4: `shell-store.ts` — the record, in a file of its own

**Files:**
- Create: `packages/server/server/sessions/shell-store.ts`
- Test: `packages/server/server/sessions/shell-store.test.ts`

**Interfaces:**
- Consumes: `AGENTISTICS_DATA_DIR` from `../config`.
- Produces: `interface ShellRecord { id: string; sessionId: string; cwd: string; createdMs: number; lastViewedMs: number }`;
  `shellsPath(dir?: string): string`; `readShells(dir?: string): Promise<ShellRecord[]>`;
  `writeShells(list: ShellRecord[], dir?: string): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/server/sessions/shell-store.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readShells, shellsPath, writeShells, type ShellRecord } from './shell-store'

const rec = (id: string): ShellRecord => ({
  id, sessionId: 's1', cwd: '/home/u/proj', createdMs: 1, lastViewedMs: 2,
})

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agentistics-shells-'))
}

test('IT IS NOT THE SESSION REGISTRY — a different file, so a different writer', () => {
  // The whole isolation argument (spec §3) rests on this. `host.sessions()` walks every row in
  // managed-sessions.json and captures its pane; a shell in there would join that 5s loop in four
  // processes, and become a fleet row besides.
  expect(shellsPath('/x')).toBe('/x/shells.json')
  expect(shellsPath('/x')).not.toContain('managed-sessions')
})

test('a missing store is an empty list, never a throw', async () => {
  const dir = await tmp()
  expect(await readShells(dir)).toEqual([])
  await rm(dir, { recursive: true, force: true })
})

test('what is written is what is read', async () => {
  const dir = await tmp()
  await writeShells([rec('a'), rec('b')], dir)
  expect((await readShells(dir)).map(r => r.id)).toEqual(['a', 'b'])
  await rm(dir, { recursive: true, force: true })
})

test('an unreadable store is an empty list, never a throw', async () => {
  // A truncated write or a hand edit must not take the whole feature down; the caller then simply
  // finds no shells and opens a new one.
  const dir = await tmp()
  await writeFile(join(dir, 'shells.json'), '{ not json')
  expect(await readShells(dir)).toEqual([])
  await rm(dir, { recursive: true, force: true })
})

test('a store that is not an array is an empty list', async () => {
  const dir = await tmp()
  await writeFile(join(dir, 'shells.json'), '{"id":"a"}')
  expect(await readShells(dir)).toEqual([])
  await rm(dir, { recursive: true, force: true })
})

test('a row missing a field it cannot do without is dropped, not kept half-built', async () => {
  const dir = await tmp()
  await writeFile(join(dir, 'shells.json'), JSON.stringify([rec('a'), { id: 'b' }]))
  expect((await readShells(dir)).map(r => r.id)).toEqual(['a'])
  await rm(dir, { recursive: true, force: true })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/server/server/sessions/shell-store.test.ts
```

Expected: FAIL — `Cannot find module './shell-store'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/server/sessions/shell-store.ts`:

```ts
/**
 * shell-store.ts — where the open utility shells are recorded, and why it is not the registry.
 *
 * `~/.agentistics/shells.json`, a separate file with a separate writer from
 * `managed-sessions.json`, and that separation is the whole performance argument of this feature.
 * `host.sessions()` "walks every session and captures its pane: ~200 ms measured here"
 * (`fleet-web.ts`) and runs every 5 s in the cockpit, in the web fleet poll, in the VS Code
 * extension and on every `/api/fleet` call. A shell in the registry would join that loop — and
 * would also become a fleet row, be probed by `attention.ts` for dialog markers, take a
 * `lastSeenMs` heartbeat, and count toward "N sessions waiting on you", so an `htop` would read as
 * a session needing a person.
 *
 * Reads are TOTAL: a missing, unreadable, non-array or half-written store yields `[]`. A shell is
 * a convenience, and a corrupt store must cost the person a new shell, never the dashboard.
 */

import { join } from 'node:path'
import { AGENTISTICS_DATA_DIR } from '../config'

/** One open shell. There is no `tmuxName` field: it is `tmuxName(id)`, on `SHELL_SOCKET`. */
export interface ShellRecord {
  /** This shell's own id — also its tmux session name, through `tmuxName`. */
  id: string
  /** The fleet row it was opened for. Not a foreign key anything enforces: the row can go away. */
  sessionId: string
  /** Where it was opened. Recorded at open, the one moment the directory is provably there. */
  cwd: string
  createdMs: number
  /** When a viewer last had it on screen — the tiebreak the ceiling's recommendation uses. */
  lastViewedMs: number
}

export function shellsPath(dir: string = AGENTISTICS_DATA_DIR): string {
  return join(dir, 'shells.json')
}

function asRecord(v: unknown): ShellRecord | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.sessionId !== 'string') return null
  if (typeof r.cwd !== 'string' || !r.cwd) return null
  const created = typeof r.createdMs === 'number' ? r.createdMs : NaN
  const viewed = typeof r.lastViewedMs === 'number' ? r.lastViewedMs : NaN
  if (!Number.isFinite(created) || !Number.isFinite(viewed)) return null
  return { id: r.id, sessionId: r.sessionId, cwd: r.cwd, createdMs: created, lastViewedMs: viewed }
}

export async function readShells(dir?: string): Promise<ShellRecord[]> {
  try {
    const file = Bun.file(shellsPath(dir))
    if (!(await file.exists())) return []
    const parsed = JSON.parse(await file.text()) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.map(asRecord).filter((r): r is ShellRecord => r !== null)
  } catch {
    return []
  }
}

export async function writeShells(list: ShellRecord[], dir?: string): Promise<void> {
  await Bun.write(shellsPath(dir), JSON.stringify(list, null, 2))
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/server/server/sessions/shell-store.test.ts
bun tsc --noEmit
```

Expected: 6 pass; tsc silent.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/sessions/shell-store.ts packages/server/server/sessions/shell-store.test.ts
git commit -m "feat(sessions): os shells utilitários têm store próprio, fora do registry do fleet"
```

---

### Task 5: `shell-backend.ts` — open, list and close against tmux

**Files:**
- Create: `packages/server/server/sessions/shell-backend.ts`
- Test: `packages/server/server/sessions/shell-backend.test.ts`

**Interfaces:**
- Consumes: `planShellOpen`, `ShellRefusal`, `SHELL_CAP` (Task 2); `readShells`, `writeShells`,
  `ShellRecord` (Task 4); `SHELL_SOCKET`, `newSessionArgs`, `killSessionArgs`, `listSessionsArgs`,
  `parseTmuxList`, `tmuxListIsEmptyState` (Task 1).
- Produces:
  `openShell(o: { sessionId: string; cwd: string | undefined; now?: number }): Promise<{ ok: true; shell: ShellRecord } | { ok: false; reason: ShellRefusal }>`;
  `listShells(): Promise<ShellRecord[]>`;
  `closeShells(ids: string[]): Promise<{ closed: string[]; unknown: string[] }>`.

`listShells` RECONCILES: a record whose tmux session is gone (the person typed `exit`) is dropped
from the store, so the ceiling counts what is actually running.

- [ ] **Step 1: Write the failing test**

Create `packages/server/server/sessions/shell-backend.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { reconcileShells } from './shell-backend'
import type { ShellRecord } from './shell-store'

const rec = (id: string): ShellRecord => ({
  id, sessionId: 's1', cwd: '/home/u/proj', createdMs: 1, lastViewedMs: 2,
})

test('a shell whose tmux session is gone is dropped — `exit` is the ordinary death', () => {
  expect(reconcileShells([rec('a'), rec('b')], ['a']).map(r => r.id)).toEqual(['a'])
})

test('a tmux session with no record is NOT adopted', () => {
  // The opposite of session-adopt.ts, and deliberately: a shell holds nothing worth recovering —
  // no name, no task, no conversation — and adopting one would put a row in a store whose whole
  // purpose is to be the small, exact list the ceiling counts.
  expect(reconcileShells([rec('a')], ['a', 'stray']).map(r => r.id)).toEqual(['a'])
})

test('nothing running empties the store rather than keeping ghosts', () => {
  // Ghost records would make the ceiling refuse an open with every shell already dead.
  expect(reconcileShells([rec('a'), rec('b')], [])).toEqual([])
})

test('order is preserved — the store is read in the order it was written', () => {
  expect(reconcileShells([rec('b'), rec('a')], ['a', 'b']).map(r => r.id)).toEqual(['b', 'a'])
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/server/server/sessions/shell-backend.test.ts
```

Expected: FAIL — `Cannot find module './shell-backend'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/server/sessions/shell-backend.ts`:

```ts
/**
 * shell-backend.ts — opening, listing and closing utility shells against tmux.
 *
 * The DECISIONS are `shell-spec.ts`'s and the RECORD is `shell-store.ts`'s; what is here is the
 * tmux and filesystem work between them, plus the one rule that needs its own test:
 * `reconcileShells`.
 *
 * Everything runs on `SHELL_SOCKET`, never the fleet's — see `tmux-cli.ts`'s note on why that is
 * structural and not a naming convention.
 */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import {
  killSessionArgs, listSessionsArgs, newSessionArgs, parseTmuxList, SHELL_SOCKET,
  tmuxListIsEmptyState,
} from './tmux-cli'
import { planShellOpen, type ShellRefusal } from './shell-spec'
import { readShells, writeShells, type ShellRecord } from './shell-store'

async function tmux(args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const p = Bun.spawn(['tmux', ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ])
    return { code: await p.exited, out, err }
  } catch {
    // tmux is not on PATH. 127 is what a shell reports for that; never a throw.
    return { code: 127, out: '', err: '' }
  }
}

async function tmuxAvailable(): Promise<boolean> {
  const r = await tmux(['-V'])
  return r.code === 0
}

async function dirExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

/** Which shell ids tmux is actually running on our socket. Empty when there is no server at all. */
async function runningIds(): Promise<string[]> {
  const r = await tmux(listSessionsArgs(SHELL_SOCKET))
  // A non-zero exit is either "no server running on that socket" — the ordinary state before the
  // first shell of the day — or a real failure. Both yield no shells; `tmuxListIsEmptyState` is
  // consulted so the two can be told apart in a log, and so this reads as a decision rather than a
  // swallowed error.
  if (r.code !== 0) {
    if (!tmuxListIsEmptyState(r.code, r.out, r.err)) {
      console.error(`[shell] tmux list-sessions on ${SHELL_SOCKET} failed: ${r.err.trim()}`)
    }
    return []
  }
  return parseTmuxList(r.out).map(s => s.id)
}

/**
 * PURE: the store, narrowed to what is really running.
 *
 * Records go one way only. A record whose pane is gone is DROPPED — `exit` is the ordinary death of
 * a shell, and a ghost record would make the ceiling refuse an open with nothing actually running.
 * A pane with no record is NOT adopted, which is the exact opposite of `session-adopt.ts` and is
 * deliberate: a session there carries a name, a task and a conversation worth recovering, while a
 * shell carries nothing, and this store's whole job is to be the small exact list the ceiling
 * counts.
 */
export function reconcileShells(stored: ShellRecord[], running: string[]): ShellRecord[] {
  const live = new Set(running)
  return stored.filter(r => live.has(r.id))
}

export async function listShells(): Promise<ShellRecord[]> {
  const stored = await readShells()
  const live = reconcileShells(stored, await runningIds())
  if (live.length !== stored.length) await writeShells(live)
  return live
}

export async function openShell(o: {
  sessionId: string
  cwd: string | undefined
  now?: number
}): Promise<{ ok: true; shell: ShellRecord } | { ok: false; reason: ShellRefusal }> {
  const now = o.now ?? Date.now()
  const open = await listShells()
  const plan = planShellOpen({
    cwd: o.cwd,
    cwdExists: o.cwd ? await dirExists(o.cwd) : false,
    tmuxAvailable: await tmuxAvailable(),
    openCount: open.length,
    shell: process.env.SHELL,
  })
  if (!plan.ok) return plan

  const id = randomUUID()
  const r = await tmux(newSessionArgs({
    id, cwd: plan.cwd, argv: plan.argv, socket: SHELL_SOCKET,
  }))
  // tmux could not start it. `no-tmux` is the honest code: nothing this caller can name went
  // wrong with the request, and the alternative is inventing a reason.
  if (r.code !== 0) return { ok: false, reason: 'no-tmux' }

  const shell: ShellRecord = {
    id, sessionId: o.sessionId, cwd: plan.cwd, createdMs: now, lastViewedMs: now,
  }
  await writeShells([...open, shell])
  return { ok: true, shell }
}

export async function closeShells(ids: string[]): Promise<{ closed: string[]; unknown: string[] }> {
  const open = await listShells()
  const known = new Set(open.map(r => r.id))
  const closed: string[] = []
  const unknown: string[] = []
  for (const id of ids) {
    if (!known.has(id)) { unknown.push(id); continue }
    await tmux(killSessionArgs(id, SHELL_SOCKET))
    closed.push(id)
  }
  await writeShells(open.filter(r => !closed.includes(r.id)))
  return { closed, unknown }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/server/server/sessions/shell-backend.test.ts
bun tsc --noEmit
```

Expected: 4 pass; tsc silent.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/sessions/shell-backend.ts packages/server/server/sessions/shell-backend.test.ts
git commit -m "feat(sessions): abre, lista e fecha shells utilitários no socket próprio"
```

---

### Task 6: The routes, the capability and the switch

**Files:**
- Create: `packages/server/server/sessions/shell-web.ts`
- Modify: `packages/server/server/capability-guard.ts` (the `PREFIXES` table)
- Modify: `packages/server/server/capability-guard.test.ts`
- Modify: `packages/server/server/index.ts` (the gate, then the three routes)

**Interfaces:**
- Consumes: `openShell`, `listShells`, `closeShells` (Task 5); `shellAllowed` (Task 3);
  `hostForFleet(lang)` and `fleetLang(raw)` from `./sessions/fleet-web`; `routeCapability` in the
  guard's own test.
- Produces: `handleShellRoute(req: Request, url: URL, host: StartHost, lang: CliLang): Promise<Response | null>`
  — `null` when the path is not ours, so `index.ts` falls through.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/server/capability-guard.test.ts`:

```ts
test('THE UTILITY SHELL rides localShell, by prefix', () => {
  expect(routeCapability('/api/shell/open')).toBe('localShell')
  expect(routeCapability('/api/shell/list')).toBe('localShell')
  expect(routeCapability('/api/shell/close')).toBe('localShell')
})

test('a shell route nobody has written yet is guarded by having been ADDED', () => {
  // A prefix and not three names, for the reason the fleet entry gives: a route that is not
  // registered here is assumed harmless, so the next one must be guarded by existing under the
  // prefix, never by somebody remembering a second table.
  expect(routeCapability('/api/shell/not-written-yet')).toBe('localShell')
})
```

`routeCapability` is already imported at the top of that file (`import { routeCapability,
capabilityDenied } from './capability-guard'`), so no import change is needed.

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test packages/server/server/capability-guard.test.ts
```

Expected: FAIL — `routeCapability('/api/shell/open')` returns `null`.

- [ ] **Step 3: Write minimal implementation**

In `capability-guard.ts`, in `PREFIXES`, directly under the `/api/fleet` entry:

```ts
  // The per-session utility SHELL. It spawns `$SHELL` on the host in a directory of the caller's
  // session and types whatever arrives into it — the most powerful thing this server offers, more
  // than `/api/fleet` itself, which at least only ever runs a named assistant CLI. Same capability,
  // and a PREFIX for the same reason: the next shell route must be guarded by having been added at
  // all. The user's own opt-in switch is enforced separately, in index.ts — see shell-gate.ts.
  ['/api/shell', 'localShell'],
```

Create `packages/server/server/sessions/shell-web.ts`:

```ts
/**
 * shell-web.ts — the three routes behind the per-session utility shell.
 *
 * `capability-guard.ts` has already refused these paths where the exposure profile forbids them,
 * and `index.ts` has already applied the user's own `shellEnabled` switch on top. What is left here
 * is resolving the session, and turning a `ShellRefusal` code into a localized sentence — the
 * module below the routes stays language-free, like `central-runtime.ts`'s reason codes.
 */

import type { StartHost } from '../cli-start'
import type { CliLang } from '../cli-lang'
import { closeShells, listShells, openShell } from './shell-backend'
import type { ShellRefusal } from './shell-spec'
import { SHELL_CAP } from './shell-spec'

const REFUSAL: Record<ShellRefusal, { en: string; pt: string }> = {
  'no-tmux': {
    en: 'This machine has no tmux, so there is no terminal to open. On Windows, run agentop under WSL.',
    pt: 'Esta máquina não tem tmux, então não há terminal para abrir. No Windows, rode o agentop pelo WSL.',
  },
  'no-cwd': {
    en: 'The registry records no directory for this session, so there is nowhere to open a shell.',
    pt: 'O registro não guarda um diretório para esta sessão, então não há onde abrir um shell.',
  },
  'cwd-missing': {
    en: 'This session’s directory no longer exists, so its shell cannot be opened there.',
    pt: 'O diretório desta sessão não existe mais, então o shell dele não pode ser aberto ali.',
  },
  'at-cap': {
    en: `${SHELL_CAP} terminals are already open. Close one to open another.`,
    pt: `Já há ${SHELL_CAP} terminais abertos. Feche um para abrir outro.`,
  },
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  })

/** `null` when the path is not ours, so `index.ts` falls through to its next route. */
export async function handleShellRoute(
  req: Request,
  url: URL,
  host: StartHost,
  lang: CliLang,
): Promise<Response | null> {
  if (url.pathname === '/api/shell/list' && req.method === 'GET') {
    return json({ shells: await listShells(), cap: SHELL_CAP })
  }

  if (url.pathname === '/api/shell/open' && req.method === 'POST') {
    const body = await req.json().catch(() => ({})) as { sessionId?: string }
    if (!body.sessionId) return json({ error: 'sessionId required' }, 400)
    if (!host.sessions) return json({ error: 'no_host' }, 503)
    const fleet = await host.sessions()
    const row = fleet.sessions.find(r => r.id === body.sessionId)
    if (!row) return json({ error: 'unknown_session' }, 404)

    const out = await openShell({ sessionId: row.id, cwd: row.cwd })
    if (!out.ok) {
      // A REFUSAL IS A 200 CARRYING A SENTENCE, not an error status. The request was well formed
      // and the answer is "no, and here is why" — a 4xx would make the browser render its generic
      // failure instead of the one sentence that says what to do about it.
      return json({ ok: false, reason: out.reason, message: REFUSAL[out.reason][lang] })
    }
    return json({ ok: true, shell: out.shell })
  }

  if (url.pathname === '/api/shell/close' && req.method === 'POST') {
    const body = await req.json().catch(() => ({})) as { ids?: string[] }
    if (!Array.isArray(body.ids)) return json({ error: 'ids required' }, 400)
    return json(await closeShells(body.ids.filter(i => typeof i === 'string')))
  }

  return null
}
```

In `index.ts`, beside the existing chat gate (search for `chat_disabled`), add:

```ts
    if (url.pathname === '/api/shell' || url.pathname.startsWith('/api/shell/')) {
      // A CENTRAL NEVER OFFERS ONE. It aggregates other machines and has no host to serve — the
      // same refusal, and the same shape, the `/api/fleet` block above gives.
      if (TEAM_CENTRAL) {
        return new Response(JSON.stringify({ error: 'shell_central' }), {
          status: 404,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        })
      }
      // Opt-in, exactly as the chat is, and enforced HERE and not only in the UI: a hidden button
      // is not a closed door, and this endpoint is what actually spawns $SHELL.
      if (!shellAllowed(CAPS.localShell, (await readPreferences()).shellEnabled)) {
        return new Response(JSON.stringify({ error: 'shell_disabled' }), {
          status: 403,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        })
      }
      const { hostForFleet, fleetLang } = await import('./sessions/fleet-web')
      const { handleShellRoute } = await import('./sessions/shell-web')
      const lang = fleetLang(url.searchParams.get('lang'))
      const res = await handleShellRoute(req, url, await hostForFleet(lang), lang)
      if (res) {
        for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v)
        return res
      }
    }
```

`shellAllowed` is imported statically from `./sessions/shell-gate` (it is pure and tiny); the two
dynamic imports follow the `/api/fleet` handler's own pattern a few blocks away, which keeps the
session machinery out of a cold start that never touches it.

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test packages/server/server/capability-guard.test.ts
bun tsc --noEmit
bun test
```

Expected: capability-guard PASS, tsc silent, full suite 0 fail.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/sessions/shell-web.ts packages/server/server/capability-guard.ts packages/server/server/capability-guard.test.ts packages/server/server/index.ts
git commit -m "feat(server): expõe /api/shell atrás de localShell e do interruptor do usuário"
```

---

### Task 7: The isolation test — a shell is not a session

This is the task the whole phase exists to make true. It fails loudly if anybody later moves shells
onto the fleet socket or into the registry.

**Files:**
- Create: `packages/server/server/sessions/shell-isolation.test.ts`

**Interfaces:**
- Consumes: `SHELL_SOCKET`, `TMUX_SOCKET`, `listSessionsArgs` (Task 1); `shellsPath` (Task 4).

- [ ] **Step 1: Write the failing test**

Create `packages/server/server/sessions/shell-isolation.test.ts`:

```ts
import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listSessionsArgs, SHELL_SOCKET, TMUX_SOCKET } from './tmux-cli'
import { shellsPath } from './shell-store'

const HERE = import.meta.dir

test('the fleet lists ONE socket and it is not the shells’', () => {
  // `parseTmuxList` keeps any session whose name starts with `agentop-`, and `reconcileSessions`
  // turns a running session with no registry record into an `unregistered` row. On one socket a
  // shell would therefore be a fleet row nobody can act on. This is the assertion that stops it.
  expect(listSessionsArgs()).toEqual(['-L', TMUX_SOCKET, '-F', expect.any(String)])
  expect(SHELL_SOCKET).not.toBe(TMUX_SOCKET)
})

test('the shell store is not the session registry', () => {
  expect(shellsPath('/x')).not.toContain('managed-sessions')
})

test('NO SHELL MODULE TOUCHES THE SESSION REGISTRY', async () => {
  // Asserted over the SOURCE, like events-frontier.test.ts, because the cost of getting this wrong
  // is invisible: the feature would work perfectly and quietly add ~200 ms of pane capture to a
  // 5-second loop in four processes, plus a row per shell in every fleet surface.
  for (const f of ['shell-backend.ts', 'shell-store.ts', 'shell-spec.ts', 'shell-web.ts']) {
    const src = await readFile(join(HERE, f), 'utf-8')
    expect(src).not.toContain('managed-sessions')
    expect(src).not.toContain('./registry')
    expect(src).not.toContain('session-view')
  }
})

test('the shell backend never asks tmux for the fleet socket', async () => {
  const src = await readFile(join(HERE, 'shell-backend.ts'), 'utf-8')
  // Every tmux call in that module passes SHELL_SOCKET explicitly. A builder called without it
  // silently takes the fleet socket, which is precisely the mistake this phase is designed around.
  const calls = src.match(/(newSessionArgs|killSessionArgs|listSessionsArgs)\(/g) ?? []
  expect(calls.length).toBeGreaterThan(0)
  expect(src).not.toMatch(/listSessionsArgs\(\)/)
  expect(src).not.toMatch(/killSessionArgs\([^)]*\)(?<!SHELL_SOCKET\))/)
})
```

If the last assertion proves brittle against the final source, replace it with an explicit count:
`expect((src.match(/SHELL_SOCKET/g) ?? []).length).toBeGreaterThanOrEqual(3)` — the point is that
every tmux call names the socket, not the exact regex.

- [ ] **Step 2: Run test to verify it fails**

Run it BEFORE Task 1 is merged and it fails on the missing export; run it now and it should pass.
To see it fail meaningfully, temporarily change `SHELL_SOCKET` to `TMUX_SOCKET` and confirm:

```bash
bun test packages/server/server/sessions/shell-isolation.test.ts
```

Expected: FAIL on `SHELL_SOCKET is not the fleet socket`. Revert the temporary change.

- [ ] **Step 3: No implementation needed**

This task adds no production code. Its job is to pin decisions Tasks 1–6 already made.

- [ ] **Step 4: Run the full suite**

```bash
bun test
bun tsc --noEmit
```

Expected: 0 fail; tsc silent.

- [ ] **Step 5: Commit**

```bash
git add packages/server/server/sessions/shell-isolation.test.ts
git commit -m "test(sessions): prende a separação entre shell utilitário e fleet"
```

---

### Task 8: Manual verification, and the docs

Phase 1 is verifiable with no UI at all. This task proves it and writes down what was proved.

**Files:**
- Modify: `CLAUDE.md` (the `packages/server/server/` module list)
- Modify: `docs/session-manager.md` (a section on the utility shell)

- [ ] **Step 1: Turn the switch on and start the server**

```bash
cd /home/mithrandir/agentistics/.claude/worktrees/session-shell
AGENTISTICS_DIR=/tmp/shell-phase1 bun run packages/server/bin/cli.ts server
```

The isolated `AGENTISTICS_DIR` is mandatory: the production build running on this machine writes the
same store, and sharing it makes a fix look broken.

- [ ] **Step 2: Confirm the switch is a real door, not a hidden button**

```bash
curl -s -X POST localhost:47291/api/shell/open -d '{"sessionId":"x"}' -H 'Content-Type: application/json'
```

Expected: `{"error":"shell_disabled"}` with status 403, because `shellEnabled` is absent.

- [ ] **Step 3: Enable it and open a shell in a real session's directory**

```bash
curl -s -X PUT localhost:47291/api/preferences -H 'Content-Type: application/json' -d '{"shellEnabled":true}'
SID=$(curl -s localhost:47291/api/fleet | python3 -c 'import json,sys; print(json.load(sys.stdin)["sessions"][0]["id"])')
curl -s -X POST localhost:47291/api/shell/open -H 'Content-Type: application/json' -d "{\"sessionId\":\"$SID\"}"
```

Expected: `{"ok":true,"shell":{...,"cwd":"<that session's cwd>"}}`.

- [ ] **Step 4: Prove the isolation, which is the point of the phase**

```bash
tmux -L agentop-shell ls     # the new shell is here
tmux -L agentop ls           # and NOT here
curl -s localhost:47291/api/fleet | grep -c "$(curl -s localhost:47291/api/shell/list | python3 -c 'import json,sys; print(json.load(sys.stdin)["shells"][0]["id"])')"
```

Expected: the shell appears under `-L agentop-shell`, is absent from `-L agentop`, and the grep
against `/api/fleet` returns `0`.

- [ ] **Step 5: Prove the ceiling refuses in words**

Open shells until the ninth:

```bash
for i in $(seq 1 9); do
  curl -s -X POST localhost:47291/api/shell/open -H 'Content-Type: application/json' -d "{\"sessionId\":\"$SID\"}" | head -c 120; echo
done
```

Expected: eight `{"ok":true,...}` then
`{"ok":false,"reason":"at-cap","message":"8 terminals are already open. …"}`.

- [ ] **Step 6: Prove `exit` is the ordinary death**

```bash
FIRST=$(curl -s localhost:47291/api/shell/list | python3 -c 'import json,sys; print(json.load(sys.stdin)["shells"][0]["id"])')
tmux -L agentop-shell kill-session -t "agentop-$FIRST"
curl -s localhost:47291/api/shell/list | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["shells"]))'
```

Expected: `7` — `listShells` reconciled the dead one out, so the ceiling counts what is running.

- [ ] **Step 7: Write the docs, in the same change**

Add to `CLAUDE.md`'s `packages/server/server/` list, under the `sessions/` entry:

```
  │                          **The per-session UTILITY SHELL** (`shell-spec.ts` / `shell-gate.ts` /
  │                          `shell-store.ts` / `shell-backend.ts` / `shell-web.ts`) is a PTY in a
  │                          session's own directory, and it is NOT a session. It runs on its own
  │                          tmux socket (`SHELL_SOCKET`) and records itself in
  │                          `~/.agentistics/shells.json`, never in the registry — on the fleet
  │                          socket `parseTmuxList` would keep it and `reconcileSessions` would
  │                          report it as an `unregistered` row, and in the registry every shell
  │                          would join the ~200 ms pane walk `host.sessions()` runs every 5 s in
  │                          four processes. It is opt-in (`shellEnabled`, absent reads as OFF, may
  │                          only narrow `CAPS.localShell`) and capped at `SHELL_CAP` = 8 by a
  │                          CEILING and never a timer.
```

Add a `## The utility shell` section to `docs/session-manager.md` covering the same three facts:
the socket, the store, and the two gates.

- [ ] **Step 8: Commit**

```bash
git add CLAUDE.md docs/session-manager.md
git commit -m "docs: registra o shell utilitário por sessão e por que ele não é uma sessão"
```

---

## What Phase 1 deliberately leaves out

Each gets its own plan, written after this one lands, because each depends on route shapes this
phase fixes:

- **Phase 2 — you can see and drive it.** `/api/shell/stream` and `/api/shell/input`, the docked
  band in `SessionPanel` with its drag handle, the unwatch discipline, and the full-screen sheet
  with the key strip on mobile. Built together, desktop and mobile in one change.
- **Phase 3 — the ceiling modal.** `shell-reap.ts` and the recommendation rules, `/api/shell/list`
  growing the facts the modal needs (what is running, `/proc` child detection), and the shimmer
  button. Phase 1 already REFUSES at the ceiling in words; Phase 3 is what makes that refusal
  actionable instead of a dead end.
- **Phase 4 — the floating window**, reusing the `TtyChat` pop-out pattern. Desktop only.
