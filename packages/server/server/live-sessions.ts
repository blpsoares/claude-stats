import { readdir, readlink, readFile } from 'fs/promises'
import type { HarnessId, LiveUnavailableReason, SessionMeta } from '@agentistics/core'

export type { LiveUnavailableReason }

/** Backstop for a process that is alive, was used, and then abandoned for a very long time without
 *  ever exiting. The primary rule below (activity must post-date the process) does the real work;
 *  this only bounds the pathological tail. Override with AGENTISTICS_LIVE_WINDOW_MIN. */
export const LIVE_ACTIVITY_WINDOW_MIN = Number(process.env.AGENTISTICS_LIVE_WINDOW_MIN) > 0
  ? Number(process.env.AGENTISTICS_LIVE_WINDOW_MIN)
  : 8 * 60

/** How long a just-launched assistant may show as live before it has written any conversation.
 *  agy persists nothing until a turn completes, so without this an open agy is invisible; past the
 *  grace period an empty process is idle or leaked rather than starting up. */
export const LIVE_STARTUP_GRACE_MIN = Number(process.env.AGENTISTICS_LIVE_STARTUP_MIN) > 0
  ? Number(process.env.AGENTISTICS_LIVE_STARTUP_MIN)
  : 30

/** Epoch ms of a session's last activity: end_time → last user timestamp → start_time. 0 if none. */
function lastActivityMs(s: SessionMeta): number {
  const candidates: string[] = []
  if (s.end_time) candidates.push(s.end_time)
  const ts = s.user_message_timestamps
  if (ts && ts.length > 0) candidates.push(ts[ts.length - 1]!)
  if (s.start_time) candidates.push(s.start_time)
  for (const c of candidates) {
    const t = Date.parse(c)
    if (!Number.isNaN(t)) return t
  }
  return 0
}

/** Where a session IS, which is not always the project it belongs to: a session that moved into a
 *  git worktree keeps `project_path` at the directory it was opened in (so the worktree's work
 *  still counts as the same project) while the session records the worktree as `current_cwd`.
 *  For DISPLAY, one of the two has to win and the more specific one does. Matching a process is a
 *  different question with a different answer — use `sessionAtCwd`, which accepts either. */
export function sessionCwd(s: SessionMeta): string {
  return s.current_cwd || s.project_path
}

/**
 * Is this session sitting in the directory a process is running in?
 *
 * BOTH directories count, and that is the whole point. A worktree session has two of them and the
 * process only ever has one — measured on a real machine, `claude` was launched at the repo root
 * (its kernel cwd stays there for the life of the process) while the session recorded
 * `current_cwd` = the worktree it moved into. Matching `sessionCwd()` alone — i.e. `current_cwd`
 * whenever it exists — therefore matched NEITHER end: the process was at `/repo` and the only
 * directory the session offered was `/repo/.claude/worktrees/…`. Every session of a workflow
 * CLAUDE.md itself mandates (one worktree per session) was reported closed while plainly open.
 *
 * Deliberately EXACT on each of the two paths, never a prefix test: a process sitting in `$HOME`
 * would otherwise claim every session on the machine.
 */
export function sessionAtCwd(
  s: { current_cwd?: string; project_path?: string },
  cwd: string,
): boolean {
  return s.current_cwd === cwd || s.project_path === cwd
}

/** Process name (`/proc/<pid>/comm`) → the harness it belongs to. `comm` is truncated to 15 chars
 *  by the kernel, which none of these reach. A session is only ever matched to a process of its own
 *  harness, so a `gemini` process can never mark an `antigravity` session open (they share a home
 *  directory but are separate harnesses). */
const PROCESS_HARNESS: Record<string, HarnessId> = {
  claude: 'claude',
  agy: 'antigravity',
  antigravity: 'antigravity',
  codex: 'codex',
  gemini: 'gemini',
  copilot: 'copilot',
  kimi: 'kimi',
}

/** `comm` is not always the tool's name: `gh copilot` runs its binary with the thread name
 *  `MainThread`, so matching on comm alone missed Copilot entirely. The executable's own basename
 *  is the reliable identity, with comm kept as the cheap first guess. */
export function harnessOf(comm: string, exePath: string | undefined): HarnessId | undefined {
  const byComm = PROCESS_HARNESS[comm]
  if (byComm) return byComm
  if (!exePath) return undefined
  const base = exePath.slice(exePath.lastIndexOf('/') + 1)
  const byBase = PROCESS_HARNESS[base]
  if (byBase) return byBase
  return harnessOfPath(exePath)
}

/**
 * Install PATHS whose executable is named after the VERSION rather than the tool.
 *
 * Claude Code installs to `~/.local/share/claude/versions/<version>`, so both `comm` and the exe
 * basename can come back as `2.1.233` — a string in no table, and one that changes every release.
 *
 * Measured on this machine on 2026-08-15, and this is why it is a real bug rather than a tidy-up:
 * TWO processes running THAT VERY BINARY, one seen and one not.
 *
 * ```
 * pid 3137032  comm=claude    exe=…/share/claude/versions/2.1.233   ← listed
 * pid  508665  comm=2.1.233   exe=…/share/claude/versions/2.1.233   ← invisible
 * ```
 *
 * Same executable, same install, and the only difference is what the process happened to set `comm`
 * to. Matching the DIRECTORY is the identity that survives an upgrade; the basename never could.
 *
 * A `Record`, so a harness added to `HarnessId` fails the build until somebody decides. `null` is
 * "this one is not installed that way", which is the ordinary case.
 */
const VERSIONED_INSTALL: Record<HarnessId, RegExp | null> = {
  // Anchored on the whole segment run, not a bare `includes`: `/share/claude/versions/` is specific
  // enough that a user directory happening to contain the word `claude` cannot match it.
  claude: /(^|\/)\.local\/share\/claude\/versions\/[^/]+$/,
  codex: null,
  gemini: null,
  copilot: null,
  antigravity: null,
  kimi: null,
}

/** The harness an executable PATH belongs to, for installs named after their version — PURE. */
export function harnessOfPath(exePath: string): HarnessId | undefined {
  for (const [id, re] of Object.entries(VERSIONED_INSTALL) as [HarnessId, RegExp | null][]) {
    if (re && re.test(exePath)) return id
  }
  return undefined
}

/**
 * SUBCOMMANDS THAT MANAGE THE TOOL RATHER THAN TALK TO IT.
 *
 * Reported as "sessões fantasmas que ficam aparecendo como se estivessem ativas quando na real nao
 * estao abertas e nem existem", with a screenshot of `claude in task-alm`. Caught in the act by
 * sampling `/proc` twice a second for two minutes — every claude whose argv was not `--resume`:
 *
 * ```
 * claude mcp add -s user agentistics -e AGENTISTICS_API=… -- bun run …/agentistics-mcp.ts
 * ```
 *
 * `claude mcp add` is a CLI command that runs for a second and exits. It is not a conversation, it
 * cannot be attached to, and nobody opened it — but it is the harness binary running in a project
 * directory, so it became an `external` row and flickered through the fleet. Every `mcp`, `config`,
 * `update`, `doctor`, `login` in any wrapper script does the same.
 *
 * THE LISTS ARE EACH CLI'S OWN, read from its `--help`, never invented — the same rule
 * `spawn-spec.ts` keeps for flags.
 *
 * **The verbs that CONTINUE a conversation are deliberately excluded**: claude's `attach` ("Open a
 * background session in this terminal"), codex's `resume` and `fork`. Those open exactly the thing
 * this list exists to keep. Dropping one of them would hide a real session, which is the expensive
 * direction — a ghost row is noise, a missing session is a session nobody can find.
 *
 * `gemini` and `antigravity` are ABSENT rather than guessed: gemini's help does not print a command
 * list this can be read from (its parse yields the program name repeated), and agy prints none at
 * all. Absent means "not known to be management", so they behave exactly as they do today.
 */
const MANAGEMENT: Record<'claude' | 'codex' | 'copilot' | 'kimi', readonly string[]> = {
  // `claude --help`, 2.1.261. `attach` is excluded — it opens a session.
  claude: [
    'agents', 'auth', 'auto-mode', 'doctor', 'gateway', 'import', 'install', 'logs', 'mcp',
    'plugin', 'project', 'respawn', 'rm', 'setup-token', 'stop', 'ultrareview', 'update',
  ],
  // `codex --help`, 0.113.0. `resume` and `fork` are excluded — both continue a conversation.
  codex: [
    'agents', 'exec', 'review', 'login', 'logout', 'mcp', 'plugin', 'mcp-server', 'app-server',
    'remote-control', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'queue',
    'archive', 'delete', 'migrate-rollouts', 'unarchive', 'cloud',
  ],
  // `copilot --help`, 1.0.82.
  copilot: [
    'app', 'completion', 'help', 'init', 'login', 'mcp', 'plugin', 'plugins', 'skill', 'update',
    'version', 'billing', 'commands', 'config', 'environment', 'limits', 'logging', 'monitoring',
    'permissions', 'providers', 'sandbox',
  ],
  // `kimi --help`, 0.38.0.
  kimi: ['export', 'provider', 'acp', 'web', 'server', 'login', 'doctor', 'vis', 'migrate', 'upgrade'],
}

/**
 * A harness process that is INFRASTRUCTURE rather than a conversation — PURE.
 *
 * Recognising the versioned install path (above) correctly found the session that was invisible,
 * and dragged in its plumbing with it. Measured on this machine, all running the same binary:
 *
 * ```
 * claude daemon run --json-path …/daemon.json      ← the daemon
 * claude bg-pty-host --bg-pty-host …/581deab7.sock ← a pty host for a session
 * claude bg-pty-host --bg-pty-host …/spare/…       ← a pre-warmed spare
 * ```
 *
 * None is a session, and listing them as assistants is the false positive that teaches people to
 * ignore this list.
 *
 * **The gate is on the SUBCOMMAND, and that is the whole care in it.** The obvious rule — "drop
 * what carries a session id" — is exactly backwards: a `bg-pty-host` argv carries the id of the
 * REAL session it serves, so that rule keeps the helper and hides the conversation. What separates
 * them is the verb, which says what the process IS.
 *
 * Absent from the table means "not known to be infrastructure", so a harness nobody has looked at
 * behaves exactly as it does today rather than being filtered on a guess.
 */
const NOT_A_SESSION: Record<HarnessId, readonly string[] | null> = {
  claude: [
    'daemon', 'bg-pty-host', 'bg-spare',
    ...MANAGEMENT.claude,
  ],
  codex: [...MANAGEMENT.codex],
  gemini: null,
  copilot: [...MANAGEMENT.copilot],
  antigravity: null,
  kimi: [...MANAGEMENT.kimi],
}

/**
 * How many leading tokens may name a subcommand.
 *
 * Bounded on purpose: a socket path, a flag value or a PROMPT later in the argv may legitimately
 * contain any of these words, and a session whose first message mentioned "daemon" must not vanish
 * from the list. Three is enough for `claude daemon run` and one token more.
 */
const SUBCOMMAND_TOKENS = 3

/**
 * Whether this argv is the harness's plumbing rather than a session — PURE.
 *
 * **`argv[0]` is split on whitespace, and that is not a nicety.** Measured: a pty host's first argv
 * element is the single string `"claude bg-pty-host"` — the process rewrote its own `argv[0]` to a
 * descriptive label, so there is no argv[1] subcommand to find. A rule that looked only past
 * `argv[0]` (the first thing written here) matched the daemon and missed every pty host, which is
 * the majority of the plumbing.
 *
 * ```
 * argv[0]="claude daemon run"?  no — ['claude','daemon','run']       three elements
 * argv[0]="claude bg-pty-host"  yes — one element, verb inside it
 * ```
 *
 * So the head is TOKENISED rather than indexed, and the flag form is skipped: `--bg-pty-host` is a
 * flag on that very process, and matching flags would be a second way to say the same thing that
 * could disagree with the first.
 */
export function isHarnessInfrastructure(harness: HarnessId, argv: readonly string[]): boolean {
  const verbs = NOT_A_SESSION[harness]
  if (!verbs) return false
  const head = argv.slice(0, SUBCOMMAND_TOKENS).join(' ').split(/\s+/).filter(Boolean)
  // argv[0]'s own first token is the program name; everything after it, up to the bound, may be a
  // subcommand. Flags are skipped rather than matched — see the header.
  return head.slice(1, SUBCOMMAND_TOKENS).some(t => !t.startsWith('-') && verbs.includes(t))
}

/** Interpreters a harness may be installed as a script for. Their `comm` and their exe basename
 *  are the RUNTIME's name, so neither says anything about which tool is running. */
const JS_RUNTIMES = new Set(['node', 'node.exe', 'bun', 'bun.exe', 'deno', 'deno.exe'])

/**
 * Script path fragment → harness, for harnesses shipped as `#!/usr/bin/env node` shims.
 *
 * Taken from the real installs, never guessed: `codex` resolves to
 * `…/node_modules/@openai/codex/bin/codex.js` and `gemini` to
 * `…/node_modules/@google/gemini-cli/bundle/gemini.js`. Both therefore ran as `node`, matched
 * nothing, and were invisible to live detection — the "N harnesses" half of the report. The
 * npm-published names of the harnesses that currently ship a native binary here are included too,
 * because a native install is a packaging choice that upstream can reverse at any release.
 *
 * Matched on the PACKAGE path, not the basename: a user's own `gemini.js` is not the Gemini CLI.
 */
const SCRIPT_HARNESS: ReadonlyArray<readonly [string, HarnessId]> = [
  ['/@openai/codex', 'codex'],
  ['/@google/gemini-cli', 'gemini'],
  ['/@github/copilot', 'copilot'],
  ['/@anthropic-ai/claude-code', 'claude'],
  ['/kimi-code', 'kimi'],
  ['/@moonshotai/kimi', 'kimi'],
  ['/antigravity-cli', 'antigravity'],
  ['/agy', 'antigravity'],
]

/**
 * The harness a process belongs to, from every signal the kernel offers: `comm`, the executable's
 * basename, and — when those name a JS runtime — the script in argv.
 *
 * Pure, so the packaging rules above are testable without a `/proc` to read.
 */
export function harnessOfProcess(
  comm: string,
  exePath: string | undefined,
  argv: readonly string[],
): HarnessId | undefined {
  const direct = harnessOf(comm, exePath)
  // Identified, but is it a CONVERSATION? Recognising the versioned install path found the session
  // that was invisible and brought its plumbing with it — the daemon and the pty hosts run the same
  // binary. See `isHarnessInfrastructure` for why the gate is on the subcommand and not on the
  // session id the plumbing also carries.
  if (direct) return isHarnessInfrastructure(direct, argv) ? undefined : direct
  const exeBase = exePath ? exePath.slice(exePath.lastIndexOf('/') + 1) : ''
  if (!JS_RUNTIMES.has(comm) && !JS_RUNTIMES.has(exeBase)) return undefined
  // argv[0] is the runtime; the script is what follows. Scan the rest so a `node --flag script`
  // invocation is still identified.
  for (const arg of argv.slice(1)) {
    if (arg.startsWith('-')) continue
    for (const [fragment, harness] of SCRIPT_HARNESS) {
      if (arg.includes(fragment)) return harness
    }
  }
  return undefined
}

/**
 * Pure: decide whether an empty scan means "nobody is working" or "this configuration structurally
 * cannot see the host's processes".
 *
 * An empty list rendered as an empty panel is the confident `0` CLAUDE.md forbids for harness
 * capabilities, and it is worse here: a containerized machine or central has NO way to observe a
 * host process, so the panel was permanently, silently wrong.
 */
export function detectionUnavailable(o: {
  platform: string
  procReadable: boolean
  /** Processes visible besides this one's own. A container without `pid: host` sees only itself. */
  foreignPids: number
  /** A process was identified as a harness but its cwd link could not be read. */
  cwdDenied: boolean
}): LiveUnavailableReason | null {
  if (o.platform !== 'linux') return 'not-linux'
  if (!o.procReadable) return 'no-proc'
  if (o.foreignPids === 0) return 'container-isolated'
  // Reading `/proc/<pid>/cwd` of another user's process needs a matching uid or CAP_SYS_PTRACE.
  // The container image runs as uid 10001 while the host user is typically 1000, so `pid: host`
  // on its own yields a full process list whose cwds are all unreadable.
  if (o.cwdDenied) return 'permission-denied'
  return null
}

/** Where each harness keeps a session file open while it is running. An fd pointing into that path
 *  names the live session outright — the strongest identity available, since it comes from the
 *  kernel rather than from argv or a guess. Copilot holds `session-state/<id>/session.db` open. */
const FD_SESSION_PATTERNS: Partial<Record<HarnessId, RegExp>> = {
  copilot: /\/\.copilot\/session-state\/([0-9a-f-]{36})\//i,
  codex: /\/rollout-[^/]*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  antigravity: /\/\.gemini\/antigravity-cli\/(?:brain|conversations)\/([0-9a-f-]{8,36})/i,
  claude: /\/\.claude\/(?:sessions|transcripts|worktrees)\/([0-9a-f-]{8,36})/i,
}

/** Boot time in epoch seconds, read once — it cannot change while the process runs. */
let _btime: number | null = null
async function bootTimeSec(): Promise<number> {
  if (_btime !== null) return _btime
  const stat = await readFile('/proc/stat', 'utf-8').catch(() => '')
  const line = stat.split('\n').find(l => l.startsWith('btime '))
  _btime = line ? Number(line.slice(6).trim()) : 0
  return _btime
}

/**
 * Real process start time, in epoch ms.
 *
 * NOT the mtime of /proc/<pid>: that timestamp moves while the process runs (it tracked ~3 minutes
 * forward across two samples of one live process here), which silently broke every rule comparing
 * a session's activity against when its process launched. Field 22 of /proc/<pid>/stat is the
 * kernel's own start time in clock ticks since boot and never moves.
 */
async function processStartMs(pid: string, btimeSec: number, hz: number): Promise<number | undefined> {
  const raw = await readFile(`/proc/${pid}/stat`, 'utf-8').catch(() => '')
  // comm sits in parentheses and may itself contain spaces/parens, so split after the LAST ')'.
  const close = raw.lastIndexOf(')')
  if (close < 0) return undefined
  const fields = raw.slice(close + 2).split(' ')
  const ticks = Number(fields[19]) // field 22 overall = index 19 of the post-comm fields
  if (!Number.isFinite(ticks) || !btimeSec) return undefined
  return (btimeSec + ticks / hz) * 1000
}

/** Pure: pick the session id out of a process's open file paths. */
export function sessionIdFromFdPaths(paths: string[], harness: HarnessId): string | undefined {
  const pattern = FD_SESSION_PATTERNS[harness]
  if (!pattern) return undefined
  for (const target of paths) {
    const m = pattern.exec(target)
    if (m && m[1]) return m[1]
  }
  return undefined
}

/** Session id from an open file descriptor, when the harness keeps its session file open. */
async function sessionIdFromFds(pid: string, harness: HarnessId): Promise<string | undefined> {
  if (!FD_SESSION_PATTERNS[harness]) return undefined
  const fds = await readdir(`/proc/${pid}/fd`).catch(() => [] as string[])
  const paths = await Promise.all(fds.map(fd => readlink(`/proc/${pid}/fd/${fd}`).catch(() => '')))
  return sessionIdFromFdPaths(paths.filter(Boolean), harness)
}

/** A running harness process. `sessionId` is set only when the process states which session it is
 *  driving, which is the one identity signal that needs no inference. */
export interface HarnessProcess {
  harness: HarnessId
  cwd: string
  /** Exact session the process resumed, when argv says so. */
  sessionId?: string
  /** Process start time (epoch ms). Bounds which sessions an anonymous process could be driving. */
  startedMs?: number
  /**
   * The OS pid, when this record came from `/proc` rather than from an older caller's plain cwd.
   *
   * Carried because it is an EXACT key into what a harness writes about its own live sessions:
   * Claude Code names its record `~/.claude/sessions/<pid>.json` (see `harness-sessions.ts`), so a
   * process found here can be matched to the session it is running with no inference at all. Every
   * other correlation in this area has had to guess by harness-and-directory.
   */
  pid?: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Flags that carry a session/conversation id, across every harness we read. `--continue` is
 *  deliberately absent: it names no id, so it tells us nothing we can attribute. */
const ID_FLAGS = new Set([
  '--resume', '--session-id', '-r', '--conversation', '--conversation-id',
  '--session', '-S', // Kimi Code: `kimi -S <id>` resumes that session
])

/** Pull the session id out of a harness argv, in both `--flag=value` and `--flag value` form.
 *  Returns undefined for a fresh session (no id on the command line yet), for a bare `--resume`
 *  (that opens the interactive picker), or for anything that is not a session id. */
export function sessionIdFromArgv(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const eq = arg.indexOf('=')
    if (eq > 0) {
      if (ID_FLAGS.has(arg.slice(0, eq))) {
        const v = arg.slice(eq + 1)
        if (UUID_RE.test(v)) return v
      }
      continue
    }
    if (ID_FLAGS.has(arg)) {
      const v = argv[i + 1]
      if (v && UUID_RE.test(v)) return v
    }
  }
  return undefined
}

/** Read every running harness process (Linux /proc only): which harness it is, its cwd, the session
 *  it resumed when argv says so, and when it started. [] on non-Linux hosts or unreadable /proc. */
export async function scanProcesses(): Promise<{
  procs: HarnessProcess[]
  unavailable: LiveUnavailableReason | null
}> {
  if (process.platform !== 'linux') {
    return { procs: [], unavailable: detectionUnavailable({ platform: process.platform, procReadable: false, foreignPids: 0, cwdDenied: false }) }
  }
  let pids: string[]
  try { pids = await readdir('/proc') } catch {
    return { procs: [], unavailable: 'no-proc' }
  }
  let harnessIndex: Awaited<ReturnType<typeof import('./sessions/harness-sessions').loadHarnessSessions>> | null = null
  try {
    const { loadHarnessSessions } = await import('./sessions/harness-sessions')
    harnessIndex = await loadHarnessSessions()
  } catch { /* best-effort */ }

  const btimeSec = await bootTimeSec()
  const hz = 100 // USER_HZ is 100 on every Linux this runs on; only used to scale start ticks.
  const procs: HarnessProcess[] = []
  const numeric = pids.filter(p => /^\d+$/.test(p))
  const own = String(process.pid)
  // A container without `pid: host` sees only its own process tree, so this is what separates
  // "nothing is running" from "this configuration cannot see the host at all".
  const foreignPids = numeric.filter(p => p !== own).length
  let cwdDenied = false
  await Promise.all(numeric.map(async pid => {
    try {
      const comm = (await readFile(`/proc/${pid}/comm`, 'utf-8')).trim()
      const exePath = await readlink(`/proc/${pid}/exe`).catch(() => undefined)
      // argv is NUL-separated; a trailing NUL yields an empty last element. Read BEFORE the
      // harness test now, because a script-installed harness is identified from argv.
      const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf-8').catch(() => ''))
        .split('\0').filter(Boolean)
      const harness = harnessOfProcess(comm, exePath, argv)
      if (!harness) return
      // A harness we could identify but whose cwd we may not read is the signature of a container
      // running under a uid that cannot ptrace the host user — record it rather than skipping in
      // silence, or the panel reports an empty, confident zero.
      const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => { cwdDenied = true; return '' })
      if (!cwd) return
      const startedMs = await processStartMs(pid, btimeSec, hz)
      const pidNum = Number(pid)
      const harnessRecord = harnessIndex?.byPid.get(pidNum)
      // Harness session file beats fd and argv: it is what the harness explicitly wrote for this pid.
      const sessionId = harnessRecord?.sessionId
        ?? (await sessionIdFromFds(pid, harness))
        ?? sessionIdFromArgv(argv)
      procs.push({ harness, cwd, sessionId, startedMs, pid: pidNum })
    } catch { /* process exited or not ours — ignore */ }
  }))
  const unavailable = procs.length > 0
    ? null
    : detectionUnavailable({ platform: 'linux', procReadable: true, foreignPids, cwdDenied })
  return { procs, unavailable }
}

/** Read every running harness process (Linux /proc only). [] on non-Linux or unreadable /proc. */
export async function harnessProcesses(): Promise<HarnessProcess[]> {
  return (await scanProcesses()).procs
}

/** Back-compat: the cwds of running `claude` processes only. Prefer `harnessProcesses()`. */
export async function claudeProcessCwds(): Promise<string[]> {
  return (await harnessProcesses()).filter(p => p.harness === 'claude').map(p => p.cwd)
}

/**
 * Map running processes to the sessions that are actually open.
 *
 * Two signals must agree, because each one alone produces wrong answers:
 *
 *   1. A running process of the session's own harness. Identity comes from the process itself
 *      whenever possible — the IDE extension launches `claude --resume=<id>`, and agy takes
 *      `--conversation <id>`. Ranking a project's sessions by recency instead (what this used to do)
 *      marked the wrong ones live: a session last touched days earlier was reported open while a
 *      genuinely resumed older session was only right by luck.
 *   2. Activity that POST-DATES the process. A live process is not proof on its own, not even when
 *      it names the session outright: reopening an editor restores its panels, so a `--resume`
 *      process routinely exists for a conversation nobody has touched in days. If the session has
 *      not been used once since its process started, that process is holding a restored-but-unused
 *      panel, not an open session. This bound is what a plain "active in the last N minutes" window
 *      cannot express — the window also throws away a session you really do have open and simply
 *      have not typed into for a while, which is why `windowMin` is only a far-out backstop.
 *
 * A process that never named a session (a fresh session, a bare `claude`, `agy` with no flags) is
 * still matched by harness + project. That fallback cannot claim a session already taken by an
 * exact id, and cannot claim one that went quiet before the process started.
 *
 * Pure — the process list and `nowMs` are the only external inputs.
 */
export function resolveOpenSessionIds(
  procs: Array<HarnessProcess | string>,
  sessions: SessionMeta[],
  nowMs: number = Date.now(),
  windowMin: number = LIVE_ACTIVITY_WINDOW_MIN,
): Set<string> {
  // A bare string is a legacy claude cwd.
  const normalised: HarnessProcess[] = procs.map(p =>
    (typeof p === 'string' ? { harness: 'claude' as HarnessId, cwd: p } : p))

  const floor = nowMs - windowMin * 60_000
  const isFresh = (s: SessionMeta): boolean => lastActivityMs(s) >= floor

  const byId = new Map(sessions.map(s => [s.session_id, s]))
  const open = new Set<string>()

  // Pass 1 — exact identity. The id comes from a file descriptor: the kernel says this process
  // holds that session's file open. A resumed id we have no session for is still dropped (never
  // guessed at), the harness must match, and the conversation must be FRESH — a panel a terminal
  // multiplexer restored and nobody has touched in two days is not work in progress.
  //
  // What is deliberately NOT asked here is `lastActivityMs(s) >= p.startedMs`, i.e. that the
  // conversation was touched since this process launched. That is backwards for the two most
  // ordinary ways to have an assistant open: `--resume` (the process starts now, the conversation
  // is from this morning) and a panel sitting idle between turns. Measured on a real machine with
  // five assistants running, it rejected BOTH fd-identified processes — their sessions known AND
  // fresh — and the fleet reported as one. Freshness already bounds staleness; requiring the
  // activity to post-date the process only ever penalised resuming, which is not a defect.
  //
  // The heuristics below (activity-after-start, one session per process) are for ANONYMOUS
  // processes, where a guess is all there is. They have no business in the path that has proof.
  const anonymous: HarnessProcess[] = []
  for (const p of normalised) {
    if (!p.sessionId) { anonymous.push(p); continue }
    const s = byId.get(p.sessionId)
    if (s && s.harness === p.harness && isFresh(s)) open.add(s.session_id)
  }

  // Pass 2 — harness + project fallback for processes that never named a session.
  const groups = new Map<string, HarnessProcess[]>()
  for (const p of anonymous) {
    const key = `${p.harness} ${p.cwd}`
    const list = groups.get(key)
    if (list) list.push(p)
    else groups.set(key, [p])
  }
  for (const group of groups.values()) {
    const { harness, cwd } = group[0]!
    const candidates = sessions
      .filter(s => s.harness === harness && sessionAtCwd(s, cwd) && !open.has(s.session_id))
      .filter(isFresh)
      .sort((a, b) => lastActivityMs(b) - lastActivityMs(a))
    // Strictest bound first, so the newest process claims the newest session it could be driving
    // and the looser ones fill from what remains.
    const starts = group.map(p => p.startedMs ?? 0).sort((a, b) => b - a)
    const taken = new Set<string>()
    for (const start of starts) {
      const match = candidates.find(s => !taken.has(s.session_id) && lastActivityMs(s) >= start)
      if (!match) continue
      taken.add(match.session_id)
      open.add(match.session_id)
    }
  }
  return open
}

/** Convenience: read live processes and resolve to open session_ids in one call. */
export async function getLiveSessionIds(sessions: SessionMeta[]): Promise<string[]> {
  const procs = await harnessProcesses()
  return [...resolveOpenSessionIds(procs, sessions)]
}

/** A running assistant with no session to point at yet. An assistant does not necessarily persist a
 *  conversation the moment it starts — agy creates nothing on disk until a turn completes — so
 *  reporting only matched sessions makes a freshly-opened one invisible. These are surfaced
 *  separately, with no metrics, because there is genuinely nothing to measure yet. */
export interface UnmatchedProcess {
  harness: HarnessId
  cwd: string
  startedMs?: number
  /** Set when the process named a session we have no record of (deleted or not yet written). */
  sessionId?: string
}

export interface LiveSnapshot {
  /** session_ids of persisted sessions that are open right now. */
  liveSessionIds: string[]
  /** Running assistants that could not be matched to any persisted session. */
  liveProcesses: UnmatchedProcess[]
  /** Map of session_id to current activity status (working, waiting, waiting-approval, exited). */
  liveSessionActivities?: Record<string, 'working' | 'waiting' | 'waiting-approval' | 'exited'>
  /** Set when this configuration cannot observe host processes AT ALL. An empty list then means
   *  "we cannot know", not "nobody is working", and the UI must say which. */
  liveUnavailable?: LiveUnavailableReason
}

/** Split the running processes into "drives a known session" and "running but nothing on disk yet".
 *  Pure, so the attribution stays testable. */
export function resolveLiveSnapshot(
  procs: HarnessProcess[],
  sessions: SessionMeta[],
  nowMs: number = Date.now(),
  windowMin: number = LIVE_ACTIVITY_WINDOW_MIN,
): LiveSnapshot {
  const open = resolveOpenSessionIds(procs, sessions, nowMs, windowMin)

  // A process is "accounted for" when one of the open sessions could plausibly be the one it drives:
  // its own id, or — for an anonymous process — an open session of the same harness and project.
  // Counting per group keeps three panels in one project from being covered by a single session.
  // Accounted for by the SAME predicate that opened them (`sessionAtCwd`), never by a key built
  // from `sessionCwd()`. A worktree session offers two directories and the process has one, so a
  // string key made them disagree: the session showed as live AND its process was reported again
  // as an unmatched "starting" card — the one open assistant counted twice.
  const openSessions = [...open]
    .map(id => sessions.find(x => x.session_id === id))
    .filter((s): s is SessionMeta => !!s)
  const claimed = new Set<string>()

  const known = new Set(sessions.map(s => s.session_id))
  const graceFloor = nowMs - LIVE_STARTUP_GRACE_MIN * 60_000

  const unmatched: UnmatchedProcess[] = []
  for (const p of procs) {
    // The process named a session we already know about. Whether it ended up open or not, that call
    // was made above with better evidence than "a process exists" — re-surfacing it here would put
    // the restored-but-unused panels straight back into the list.
    if (p.sessionId && known.has(p.sessionId)) continue
    if (!p.sessionId) {
      const match = openSessions.find(s =>
        !claimed.has(s.session_id) && s.harness === p.harness && sessionAtCwd(s, p.cwd))
      if (match) { claimed.add(match.session_id); continue }
    }
    // Nothing on disk to attribute. That is only believable while the assistant is still starting
    // up; a process running for hours with no conversation to show is idle or leaked, not warming up.
    if ((p.startedMs ?? 0) < graceFloor) continue
    unmatched.push({
      harness: p.harness,
      cwd: p.cwd,
      ...(p.startedMs !== undefined ? { startedMs: p.startedMs } : {}),
      ...(p.sessionId ? { sessionId: p.sessionId } : {}),
      // Carried through, because these are exactly the rows the cockpit lists as `external` — and
      // the pid is the one key that names what each of them is actually running.
      ...(p.pid !== undefined ? { pid: p.pid } : {}),
    })
  }
  return { liveSessionIds: [...open], liveProcesses: unmatched }
}

/** Read the processes and produce the full snapshot in one call. */
export async function getLiveSnapshot(sessions: SessionMeta[]): Promise<LiveSnapshot> {
  const { procs, unavailable } = await scanProcesses()
  const snap = resolveLiveSnapshot(procs, sessions)

  const liveSessionActivities: Record<string, 'working' | 'waiting' | 'waiting-approval' | 'exited'> = {}
  try {
    const { createEventStore } = await import('./events/event-store')
    const store = createEventStore()
    const { events } = await store.recent(100)

    for (const id of snap.liveSessionIds) {
      const match = events.filter(e => e.id === id || e.conversationId === id).pop()
      if (match) {
        if (match.kind === 'turn-end') {
          liveSessionActivities[id] = 'waiting'
        } else if (match.kind === 'working' || match.kind === 'waiting' || match.kind === 'waiting-approval' || match.kind === 'exited') {
          liveSessionActivities[id] = match.kind
        } else {
          liveSessionActivities[id] = 'working'
        }
      } else {
        liveSessionActivities[id] = 'working'
      }
    }
  } catch {
    for (const id of snap.liveSessionIds) {
      liveSessionActivities[id] = 'working'
    }
  }

  const result: LiveSnapshot = { ...snap, liveSessionActivities }
  return unavailable ? { ...result, liveUnavailable: unavailable } : result
}
