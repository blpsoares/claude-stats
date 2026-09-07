import { describe, it, test, expect } from 'bun:test'
import {
  resolveOpenSessionIds, resolveLiveSnapshot, sessionIdFromArgv, harnessOf, sessionIdFromFdPaths,
  LIVE_ACTIVITY_WINDOW_MIN, LIVE_STARTUP_GRACE_MIN, harnessOfProcess, detectionUnavailable, isHarnessInfrastructure
} from './live-sessions'
import type { HarnessId, SessionMeta } from '@agentistics/core'

const NOW = Date.parse('2026-07-27T19:30:00Z')
const minsAgo = (m: number): string => new Date(NOW - m * 60_000).toISOString()

function s(id: string, project: string, lastTs: string, harness: HarnessId = 'claude'): SessionMeta {
  return {
    session_id: id, project_path: project, start_time: lastTs, end_time: lastTs,
    duration_minutes: 0, user_message_count: 0, assistant_message_count: 0,
    tool_counts: {}, tool_output_tokens: {}, agent_file_reads: {}, languages: [],
    git_commits: 0, git_pushes: 0, input_tokens: 0, output_tokens: 0,
    first_prompt: '', user_interruptions: 0, user_response_times: [], tool_errors: 0,
    tool_error_categories: {}, uses_task_agent: false, uses_mcp: false,
    uses_web_search: false, uses_web_fetch: false, lines_added: 0, lines_removed: 0,
    files_modified: 0, message_hours: [], user_message_timestamps: [], harness,
  } as SessionMeta
}

// --- project fallback --------------------------------------------------------------------------

test('one process → the most-recently-active fresh session in that project is open', () => {
  const sessions = [
    s('old', '/proj/a', minsAgo(3)),
    s('newer', '/proj/a', minsAgo(1)),
    s('other', '/proj/b', minsAgo(1)),
  ]
  const open = resolveOpenSessionIds([{ harness: 'claude', cwd: '/proj/a', startedMs: 0 }], sessions, NOW)
  expect([...open]).toEqual(['newer'])
})

test('two processes in the same project → the two most-recent sessions are open', () => {
  const sessions = [s('s1', '/proj/a', minsAgo(9)), s('s2', '/proj/a', minsAgo(5)), s('s3', '/proj/a', minsAgo(1))]
  const procs = [
    { harness: 'claude' as HarnessId, cwd: '/proj/a', startedMs: 0 },
    { harness: 'claude' as HarnessId, cwd: '/proj/a', startedMs: 0 },
  ]
  const open = resolveOpenSessionIds(procs, sessions, NOW)
  expect(open).toEqual(new Set(['s3', 's2']))
})

test('no processes → nothing open; process with no matching project → nothing', () => {
  const sessions = [s('a', '/proj/a', minsAgo(1))]
  expect(resolveOpenSessionIds([], sessions, NOW).size).toBe(0)
  expect(resolveOpenSessionIds(['/proj/zzz'], sessions, NOW).size).toBe(0)
})

// --- the directory the session is actually in ---------------------------------------------------

test('a session whose cwd moved (git worktree) is matched on its current_cwd, not project_path', () => {
  // Real shape: a session opened at the repo root and then moved into a worktree keeps
  // project_path = the repo (so it stays in the same project) while its process runs in the
  // worktree. Matching on project_path alone reported it closed while it was plainly open.
  const wt = '/repo/.claude/worktrees/feature'
  const moved = { ...s('moved', '/repo', minsAgo(1)), current_cwd: wt }
  const atRoot = s('root', '/repo', minsAgo(2))
  const procs = [
    { harness: 'claude' as HarnessId, cwd: wt, startedMs: 0 },
    { harness: 'claude' as HarnessId, cwd: '/repo', startedMs: 0 },
  ]
  expect(resolveOpenSessionIds(procs, [moved, atRoot], NOW)).toEqual(new Set(['moved', 'root']))
})

test('current_cwd does not let a session be claimed by a process in an unrelated directory', () => {
  const moved = { ...s('moved', '/repo', minsAgo(1)), current_cwd: '/repo/wt' }
  const open = resolveOpenSessionIds([{ harness: 'claude' as HarnessId, cwd: '/elsewhere', startedMs: 0 }], [moved], NOW)
  expect(open.size).toBe(0)
})

// --- identity from argv ------------------------------------------------------------------------

const UUID_A = '1f9f48c3-6e75-4009-addd-fba4c3a53877'
const UUID_B = 'c3deac99-b178-4004-910d-81725ee42b20'

test('sessionIdFromArgv reads the id each harness passes', () => {
  // Real argv shape, trimmed: the IDE extension always uses the --flag=value form.
  expect(sessionIdFromArgv([
    '/home/u/.vscode-server/extensions/anthropic.claude-code/resources/native-binary/claude',
    '--output-format', 'stream-json', `--resume=${UUID_A}`, '--permission-mode', 'auto',
  ])).toBe(UUID_A)
  expect(sessionIdFromArgv(['claude', '--resume', UUID_B])).toBe(UUID_B)
  expect(sessionIdFromArgv(['claude', '--session-id', UUID_B])).toBe(UUID_B)
  expect(sessionIdFromArgv(['claude', '-r', UUID_B])).toBe(UUID_B)
  expect(sessionIdFromArgv(['agy', '--conversation', UUID_A])).toBe(UUID_A)
})

test('sessionIdFromArgv returns nothing when there is no id to read', () => {
  expect(sessionIdFromArgv(['claude'])).toBeUndefined()
  expect(sessionIdFromArgv(['agy'])).toBeUndefined()
  // `--resume` with no value opens the interactive picker; the next arg is a flag, not an id.
  expect(sessionIdFromArgv(['claude', '--resume', '--verbose'])).toBeUndefined()
  expect(sessionIdFromArgv(['claude', '--resume=not-a-uuid'])).toBeUndefined()
  // `--continue` names no conversation, so it can never attribute one.
  expect(sessionIdFromArgv(['agy', '--continue'])).toBeUndefined()
  expect(sessionIdFromArgv([])).toBeUndefined()
})

test('a resumed id wins over recency', () => {
  // Ranking by recency used to report `decoy` (the freshest) instead of the session actually resumed.
  const sessions = [
    s('decoy', '/proj/a', minsAgo(1)),
    s('resumed', '/proj/a', minsAgo(4)),
  ]
  const open = resolveOpenSessionIds(
    [{ harness: 'claude', cwd: '/proj/a', sessionId: 'resumed', startedMs: NOW - 10 * 60_000 }],
    sessions, NOW)
  expect(open).toEqual(new Set(['resumed']))
})

test('a resumed id we have no session for is dropped, not guessed at', () => {
  const sessions = [s('a', '/proj/a', minsAgo(1))]
  const open = resolveOpenSessionIds(
    [{ harness: 'claude', cwd: '/proj/a', sessionId: 'deleted-transcript', startedMs: 0 }], sessions, NOW)
  expect(open.size).toBe(0)
})

test('an anonymous process never steals a session already claimed by an exact id', () => {
  const sessions = [s('resumed', '/proj/a', minsAgo(1)), s('fresh', '/proj/a', minsAgo(2))]
  const open = resolveOpenSessionIds([
    { harness: 'claude', cwd: '/proj/a', sessionId: 'resumed', startedMs: 0 },
    { harness: 'claude', cwd: '/proj/a', startedMs: 0 },
  ], sessions, NOW)
  expect(open).toEqual(new Set(['resumed', 'fresh']))
})

test('an anonymous process cannot claim a session that went quiet before it started', () => {
  const started = NOW - 5 * 60_000
  const stale = [s('before', '/proj/a', minsAgo(9))] // inside the window, but older than the process
  expect(resolveOpenSessionIds([{ harness: 'claude', cwd: '/proj/a', startedMs: started }], stale, NOW).size).toBe(0)
  const after = [s('after', '/proj/a', minsAgo(2))]
  expect(resolveOpenSessionIds([{ harness: 'claude', cwd: '/proj/a', startedMs: started }], after, NOW))
    .toEqual(new Set(['after']))
})

// --- the freshness gate ------------------------------------------------------------------------

test('a restored-but-unused panel is not an open session — the regression this file exists for', () => {
  // Measured on a real machine: the editor restored a panel and launched
  // `claude --resume=<id>` at 09:33 for a conversation last touched two days earlier. The process
  // was alive and named the session outright, and it was still reported "open now".
  const started = NOW - 7 * 60 * 60_000
  const procs = [{ harness: 'claude' as HarnessId, cwd: '/proj/a', sessionId: 'restored', startedMs: started }]
  const untouched = [s('restored', '/proj/a', minsAgo(60 * 46))]
  expect(resolveOpenSessionIds(procs, untouched, NOW).size).toBe(0)
  // Same process, but the session HAS been used since it launched → genuinely open.
  const used = [s('restored', '/proj/a', minsAgo(19))]
  expect(resolveOpenSessionIds(procs, used, NOW)).toEqual(new Set(['restored']))
})

test('an open session you simply have not typed into for a while stays open', () => {
  // The failure mode of a plain "active in the last N minutes" window: 19 minutes of reading is
  // not a closed session. Only activity older than the process (above) or the far-out backstop
  // (below) removes it.
  const started = NOW - 7 * 60 * 60_000
  const procs = [{ harness: 'claude' as HarnessId, cwd: '/proj/a', sessionId: 'idle', startedMs: started }]
  expect(resolveOpenSessionIds(procs, [s('idle', '/proj/a', minsAgo(19))], NOW))
    .toEqual(new Set(['idle']))
  expect(resolveOpenSessionIds(procs, [s('idle', '/proj/a', minsAgo(120))], NOW))
    .toEqual(new Set(['idle']))
})

test('the backstop window is inclusive and cuts off just past it', () => {
  const procs = [{ harness: 'claude' as HarnessId, cwd: '/proj/a', startedMs: 0 }]
  const atEdge = [s('edge', '/proj/a', minsAgo(LIVE_ACTIVITY_WINDOW_MIN))]
  expect(resolveOpenSessionIds(procs, atEdge, NOW)).toEqual(new Set(['edge']))
  const pastEdge = [s('past', '/proj/a', minsAgo(LIVE_ACTIVITY_WINDOW_MIN + 1))]
  expect(resolveOpenSessionIds(procs, pastEdge, NOW).size).toBe(0)
})

// --- multi-harness -----------------------------------------------------------------------------

test('every harness is detected, each only by its own processes', () => {
  const sessions = [
    s('c', '/proj', minsAgo(1), 'claude'),
    s('a', '/proj', minsAgo(1), 'antigravity'),
    s('x', '/proj', minsAgo(1), 'codex'),
    s('g', '/proj', minsAgo(1), 'gemini'),
    s('p', '/proj', minsAgo(1), 'copilot'),
  ]
  const procs: HarnessProcessish[] = [
    { harness: 'claude', cwd: '/proj', startedMs: 0 },
    { harness: 'antigravity', cwd: '/proj', startedMs: 0 },
    { harness: 'codex', cwd: '/proj', startedMs: 0 },
    { harness: 'gemini', cwd: '/proj', startedMs: 0 },
    { harness: 'copilot', cwd: '/proj', startedMs: 0 },
  ]
  expect(resolveOpenSessionIds(procs, sessions, NOW)).toEqual(new Set(['c', 'a', 'x', 'g', 'p']))
})

test('a process never marks another harness session open', () => {
  // agy and the Gemini CLI share ~/.gemini, so crossing them here would be an easy mistake.
  const sessions = [s('agy-session', '/proj', minsAgo(1), 'antigravity')]
  const procs = [{ harness: 'gemini' as HarnessId, cwd: '/proj', startedMs: 0 }]
  expect(resolveOpenSessionIds(procs, sessions, NOW).size).toBe(0)
  // An exact id from the wrong harness is refused too.
  const wrongId = [{ harness: 'gemini' as HarnessId, cwd: '/proj', sessionId: 'agy-session', startedMs: 0 }]
  expect(resolveOpenSessionIds(wrongId, sessions, NOW).size).toBe(0)
})

type HarnessProcessish = { harness: HarnessId; cwd: string; sessionId?: string; startedMs?: number }

// --- running assistants with nothing on disk yet -------------------------------------------------

test('a just-launched assistant with no conversation on disk is still reported', () => {
  // agy persists nothing until its first turn completes, so an open one had no session to match and
  // was missing from "open now" entirely.
  const snap = resolveLiveSnapshot(
    [{ harness: 'antigravity', cwd: '/proj/a', startedMs: NOW - 60_000 }], [], NOW)
  expect(snap.liveSessionIds).toEqual([])
  expect(snap.liveProcesses).toEqual([{ harness: 'antigravity', cwd: '/proj/a', startedMs: NOW - 60_000 }])
})

test('a restored-but-unused panel does not come back as an unmatched process', () => {
  // The session was rejected above with better evidence than "a process exists"; re-surfacing the
  // process here would put it straight back on screen.
  const sessions = [s('restored', '/proj/a', minsAgo(60 * 46))]
  const procs = [{ harness: 'claude' as HarnessId, cwd: '/proj/a', sessionId: 'restored', startedMs: NOW - 60_000 }]
  const snap = resolveLiveSnapshot(procs, sessions, NOW)
  expect(snap.liveSessionIds).toEqual([])
  expect(snap.liveProcesses).toEqual([])
})

// --- fd-identified processes are trusted, whatever the conversation's timing -----------------
// The regression: five assistants running on one machine reported as ONE. Both fd-identified
// processes were dropped because their conversation had last been touched BEFORE the process
// started — which is what `--resume` and an idle panel look like from outside.

test('a RESUMED session is open: the conversation predates the process, and the fd proves it', () => {
  // `claude --resume` — process launched a minute ago, the conversation is from this morning.
  const sessions = [s('resumed', '/proj/a', minsAgo(180))]
  const procs = [{ harness: 'claude' as HarnessId, cwd: '/proj/a', sessionId: 'resumed', startedMs: NOW - 60_000 }]
  expect(resolveLiveSnapshot(procs, sessions, NOW).liveSessionIds).toEqual(['resumed'])
})

test('an idle panel between turns stays open', () => {
  // Sitting waiting for the user. Activity is older than the process; the panel is still open.
  const sessions = [s('idle', '/proj/a', minsAgo(90))]
  const procs = [{ harness: 'claude' as HarnessId, cwd: '/proj/a', sessionId: 'idle', startedMs: NOW - 30 * 60_000 }]
  expect(resolveLiveSnapshot(procs, sessions, NOW).liveSessionIds).toEqual(['idle'])
})

test('several fd-identified assistants are ALL reported, not just the most recently used', () => {
  const sessions = [
    s('a', '/proj/a', minsAgo(2)), s('b', '/proj/a', minsAgo(120)), s('c', '/proj/a', minsAgo(300)),
  ]
  const procs = [
    { harness: 'claude' as HarnessId, cwd: '/proj/a', sessionId: 'a', startedMs: NOW - 60_000 },
    { harness: 'claude' as HarnessId, cwd: '/proj/a', sessionId: 'b', startedMs: NOW - 60_000 },
    { harness: 'claude' as HarnessId, cwd: '/proj/a', sessionId: 'c', startedMs: NOW - 60_000 },
  ]
  expect(resolveLiveSnapshot(procs, sessions, NOW).liveSessionIds.sort()).toEqual(['a', 'b', 'c'])
})

test('freshness still bounds it — an fd on a two-day-old conversation is not open', () => {
  // The counterpart to the three above: trusting the fd must not resurrect the restored-but-unused
  // panel. Freshness is what separates them, not the process's start time.
  const sessions = [s('stale', '/proj/a', minsAgo(60 * 46))]
  const procs = [{ harness: 'claude' as HarnessId, cwd: '/proj/a', sessionId: 'stale', startedMs: NOW - 60_000 }]
  expect(resolveLiveSnapshot(procs, sessions, NOW).liveSessionIds).toEqual([])
})

test('a process whose session IS open is not also listed as starting', () => {
  const sessions = [s('open', '/proj/a', minsAgo(1))]
  const procs = [{ harness: 'claude' as HarnessId, cwd: '/proj/a', sessionId: 'open', startedMs: NOW - 60_000 }]
  const snap = resolveLiveSnapshot(procs, sessions, NOW)
  expect(snap.liveSessionIds).toEqual(['open'])
  expect(snap.liveProcesses).toEqual([])
})

test('an anonymous process covered by an open session of its own project is not double-counted', () => {
  const sessions = [s('open', '/proj/a', minsAgo(1))]
  const procs = [{ harness: 'claude' as HarnessId, cwd: '/proj/a', startedMs: NOW - 60_000 }]
  const snap = resolveLiveSnapshot(procs, sessions, NOW)
  expect(snap.liveSessionIds).toEqual(['open'])
  expect(snap.liveProcesses).toEqual([])
  // A SECOND anonymous process in the same project is not covered by that one session.
  const two = resolveLiveSnapshot([...procs, { harness: 'claude' as HarnessId, cwd: '/proj/a', startedMs: NOW - 60_000 }], sessions, NOW)
  expect(two.liveProcesses.length).toBe(1)
})

test('an old process with nothing on disk is idle, not starting up', () => {
  const old = [{ harness: 'antigravity' as HarnessId, cwd: '/proj/a', startedMs: NOW - (LIVE_STARTUP_GRACE_MIN + 1) * 60_000 }]
  expect(resolveLiveSnapshot(old, [], NOW).liveProcesses).toEqual([])
})

// --- identifying the process itself --------------------------------------------------------------

test('an install named after its VERSION is still recognised', () => {
  // Measured on 2026-08-15, and the reason this is a bug and not a tidy-up: two processes running
  // THE SAME executable, one listed and one invisible.
  //
  //   pid 3137032  comm=claude    exe=…/share/claude/versions/2.1.233   ← listed
  //   pid  508665  comm=2.1.233   exe=…/share/claude/versions/2.1.233   ← invisible
  //
  // Claude Code installs to `~/.local/share/claude/versions/<version>`, so comm and the exe
  // basename can BOTH be a version string — in no table, and different every release. The
  // directory is the identity that survives an upgrade.
  const exe = '/home/mithrandir/.local/share/claude/versions/2.1.233'
  expect(harnessOf('2.1.233', exe)).toBe('claude')
  expect(harnessOf('claude', exe)).toBe('claude')
  // Specific enough that a directory merely containing the word cannot match.
  expect(harnessOf('2.1.233', '/home/u/projects/claude/versions/2.1.233')).toBeUndefined()
  expect(harnessOf('2.1.233', '/home/u/.local/share/claude/versions/2.1.233/extra/thing')).toBeUndefined()
})

test('the harness PLUMBING is not a session', () => {
  // Recognising the install path found the invisible session and brought its infrastructure with
  // it — the daemon and the pty hosts run the same binary. All argvs verbatim from /proc.
  const exe = '/home/mithrandir/.local/share/claude/versions/2.1.233'
  // The pty host rewrote its own argv[0] to a single string CONTAINING the verb — there is no
  // argv[1] to look at, which is exactly what a first attempt at this rule missed.
  expect(harnessOfProcess('2.1.233', exe, [
    'claude bg-pty-host', '--bg-pty-host', '/tmp/cc-daemon-1000/8c5bc785/pty/581deab7.sock', '252',
  ])).toBeUndefined()
  expect(harnessOfProcess('2.1.233', exe, [
    'claude bg-spare', '--bg-spare', '/tmp/cc-daemon-1000/8c5bc785/spare/3aa44d79.claim.sock',
  ])).toBeUndefined()
  expect(harnessOfProcess('claude', '/home/mithrandir/.local/bin/claude', [
    '/home/mithrandir/.local/bin/claude', 'daemon', 'run', '--json-path', '/home/u/.claude/daemon.json',
  ])).toBeUndefined()
  // …and the real session is untouched.
  expect(harnessOfProcess('2.1.233', exe, ['claude'])).toBe('claude')
})

test('the plumbing gate never eats a session because of what it SAYS', () => {
  // The trap this gate is written around: a `bg-pty-host` argv carries the session id of the REAL
  // conversation it serves, so "drop what carries a session id" keeps the helper and hides the
  // session. The VERB is what separates them — and a prompt that merely mentions one must not match.
  const exe = '/home/mithrandir/.local/share/claude/versions/2.1.233'
  expect(harnessOfProcess('claude', exe, ['claude', '-p', 'restart the daemon please'])).toBe('claude')
  expect(harnessOfProcess('claude', exe, ['claude', '--resume', 'a-uuid', '-p', 'bg-pty-host'])).toBe('claude')
})

test('a harness is recognised by its executable when comm is not its name', () => {
  // `gh copilot` runs its binary with the thread name MainThread, so comm-only matching missed
  // Copilot entirely and it never appeared as live.
  expect(harnessOf('MainThread', '/home/u/.local/share/gh/copilot/copilot')).toBe('copilot')
  expect(harnessOf('claude', undefined)).toBe('claude')
  expect(harnessOf('agy', '/home/u/.local/bin/agy')).toBe('antigravity')
  // A real codex binary lives behind a long vendor path; the basename is what identifies it.
  expect(harnessOf('codex', '/home/u/.bun/install/global/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex')).toBe('codex')
  expect(harnessOf('bash', '/usr/bin/bash')).toBeUndefined()
  expect(harnessOf('node', undefined)).toBeUndefined()
})

test('an open session file names the session outright', () => {
  // The strongest identity available: it comes from the kernel, not from argv or a guess.
  expect(sessionIdFromFdPaths([
    '/home/u/.copilot/logs/process-123.log',
    '/home/u/.copilot/session-state/1aa6533d-8f2b-4d8c-8d20-c70f63415e0d/session.db',
  ], 'copilot')).toBe('1aa6533d-8f2b-4d8c-8d20-c70f63415e0d')

  expect(sessionIdFromFdPaths([
    '/home/u/.codex/state_5.sqlite',
    '/home/u/.codex/sessions/2026/07/27/rollout-2026-07-27T19-02-04-019fa599-71b2-7012-acfb-cb5f6387f6b6.jsonl',
  ], 'codex')).toBe('019fa599-71b2-7012-acfb-cb5f6387f6b6')

  // Nothing to match, and harnesses that keep no session file open.
  expect(sessionIdFromFdPaths(['/home/u/.copilot/session-store.db'], 'copilot')).toBeUndefined()
  expect(sessionIdFromFdPaths(['/anything'], 'claude')).toBeUndefined()
})

// --- the worktree case that actually happens ----------------------------------------------------

test('a session that moved into a worktree is still matched by its process at the launch directory', () => {
  // Measured on a real machine: `claude` was launched at the repo root and its kernel cwd STAYS
  // there, while the session records current_cwd = the worktree it moved into. Matching the
  // process against current_cwd ALONE (the previous rule) therefore reported nothing open at all —
  // and CLAUDE.md mandates exactly this one-worktree-per-session workflow, so it hit every session.
  const moved = { ...s('moved', '/repo', minsAgo(1)), current_cwd: '/repo/.claude/worktrees/livefix' }
  const proc = { harness: 'claude' as HarnessId, cwd: '/repo', startedMs: 0 }
  expect(resolveOpenSessionIds([proc], [moved], NOW)).toEqual(new Set(['moved']))
})

test('a moved session is still claimable from the worktree side too', () => {
  const wt = '/repo/.claude/worktrees/livefix'
  const moved = { ...s('moved', '/repo', minsAgo(1)), current_cwd: wt }
  const proc = { harness: 'claude' as HarnessId, cwd: wt, startedMs: 0 }
  expect(resolveOpenSessionIds([proc], [moved], NOW)).toEqual(new Set(['moved']))
})

test('matching both directories still refuses an unrelated one', () => {
  const moved = { ...s('moved', '/repo', minsAgo(1)), current_cwd: '/repo/wt' }
  const proc = { harness: 'claude' as HarnessId, cwd: '/somewhere/else', startedMs: 0 }
  expect(resolveOpenSessionIds([proc], [moved], NOW).size).toBe(0)
})

// --- harnesses installed as node scripts --------------------------------------------------------

test('a harness installed as a node script is identified from its script path', () => {
  // Verified from the real installs on this machine: `codex` and `gemini` are
  // `#!/usr/bin/env node` shims, so comm is `node` and the exe basename is `node` — both lookups
  // miss and the process was invisible. This is the "N harnesses" half of the report.
  const codex = '/home/u/.bun/install/global/node_modules/@openai/codex/bin/codex.js'
  const gemini = '/home/u/.bun/install/global/node_modules/@google/gemini-cli/bundle/gemini.js'
  expect(harnessOfProcess('node', '/usr/bin/node', ['node', codex])).toBe('codex')
  expect(harnessOfProcess('node', '/usr/bin/node', ['node', gemini])).toBe('gemini')
})

test('a native harness binary is still identified, even when its exe basename is a version', () => {
  // The real claude install resolves to .../claude/versions/2.1.220 — the basename is a version
  // number, so comm is the only signal that works.
  expect(harnessOfProcess('claude', '/home/u/.local/share/claude/versions/2.1.220', ['claude']))
    .toBe('claude')
})

test('an ordinary node process is not mistaken for a harness', () => {
  expect(harnessOfProcess('node', '/usr/bin/node', ['node', '/srv/app/server.js'])).toBeUndefined()
  expect(harnessOfProcess('node', '/usr/bin/node', ['node'])).toBeUndefined()
  expect(harnessOfProcess('bash', '/usr/bin/bash', ['bash'])).toBeUndefined()
})

// --- honest unavailability ----------------------------------------------------------------------

test('an empty scan is reported as impossible only when it genuinely is', () => {
  const base = { platform: 'linux', procReadable: true, foreignPids: 40, cwdDenied: false }
  expect(detectionUnavailable(base)).toBeNull()
  expect(detectionUnavailable({ ...base, platform: 'darwin' })).toBe('not-linux')
  expect(detectionUnavailable({ ...base, procReadable: false })).toBe('no-proc')
  // A container without `pid: host` sees only its own processes.
  expect(detectionUnavailable({ ...base, foreignPids: 0 })).toBe('container-isolated')
  // pid: host, but the container's uid cannot ptrace the host user's processes.
  expect(detectionUnavailable({ ...base, cwdDenied: true })).toBe('permission-denied')
})

describe('management subcommands are not sessions', () => {
  it('the GHOST that was reported, verbatim', () => {
    // Caught by sampling /proc twice a second for two minutes, printing every claude whose argv was
    // not `--resume`. It ran for about a second in a worktree and flickered through the fleet as
    // `claude in task-alm` — a session nobody opened and that no longer existed by the time it was
    // read.
    expect(isHarnessInfrastructure('claude', [
      'claude', 'mcp', 'add', '-s', 'user', 'agentistics', '-e', 'AGENTISTICS_API=x',
      '--', 'bun', 'run', 'x.ts',
    ])).toBe(true)
  })

  it('every harness whose --help publishes a command list', () => {
    expect(isHarnessInfrastructure('codex', ['codex', 'exec', 'do the thing'])).toBe(true)
    expect(isHarnessInfrastructure('copilot', ['copilot', 'mcp', 'list'])).toBe(true)
    expect(isHarnessInfrastructure('kimi', ['kimi', 'login'])).toBe(true)
  })

  it('A REAL SESSION NEVER DISAPPEARS — the expensive direction', () => {
    // A ghost row is noise; a session nobody can find is a session nobody can find.
    expect(isHarnessInfrastructure('claude', ['claude'])).toBe(false)
    expect(isHarnessInfrastructure('claude', ['claude', '--resume', 'abc'])).toBe(false)
    expect(isHarnessInfrastructure('claude', ['claude', '--session-id', 'abc'])).toBe(false)
    expect(isHarnessInfrastructure('copilot', ['copilot', '--session-id', 'abc'])).toBe(false)
    expect(isHarnessInfrastructure('kimi', ['kimi', '-S', 'abc'])).toBe(false)
  })

  it('the verbs that CONTINUE a conversation are excluded on purpose', () => {
    // claude's `attach` is documented as "Open a background session in this terminal"; codex's
    // `resume` and `fork` pick a conversation back up. All three open the very thing this list
    // exists to keep.
    expect(isHarnessInfrastructure('claude', ['claude', 'attach', '3f5f'])).toBe(false)
    expect(isHarnessInfrastructure('codex', ['codex', 'resume', 'abc'])).toBe(false)
    expect(isHarnessInfrastructure('codex', ['codex', 'fork', 'abc'])).toBe(false)
  })

  it('a PROMPT that mentions a subcommand does not kill the session', () => {
    // The token bound exists for exactly this: the words are ordinary English and a first message
    // may contain any of them.
    expect(isHarnessInfrastructure('claude', ['claude', '-p', 'explain the mcp add command'])).toBe(false)
    expect(isHarnessInfrastructure('claude', ['claude', '--resume', 'x', 'update the doctor'])).toBe(false)
  })

  it('gemini and antigravity are ABSENT rather than guessed', () => {
    // gemini's help prints no readable command list and agy prints none at all. Absent means "not
    // known to be management", so they behave exactly as they did.
    expect(isHarnessInfrastructure('gemini', ['gemini', 'mcp', 'list'])).toBe(false)
    expect(isHarnessInfrastructure('antigravity', ['agy', 'login'])).toBe(false)
  })
})
