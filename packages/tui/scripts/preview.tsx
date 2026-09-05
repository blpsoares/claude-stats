#!/usr/bin/env bun
/**
 * preview.tsx — render the control center to plain stdout, at a size you choose.
 *
 * The control center only ever runs inside an alternate screen on a real tty, which makes it
 * exactly the kind of surface nobody can look at while building it: a screenshot needs a pty, and a
 * pty is not something a review, a diff or an agent has. This renders one frame through
 * `ink-testing-library` — no alternate screen, no raw mode, no host process — and prints it between
 * width rulers, so a row that overflows the terminal it was designed for is visible at a glance
 * instead of a bug report three days later.
 *
 *   bun run packages/tui/scripts/preview.tsx [--cols 100] [--rows 34]
 *                                            [--lang en|pt] [--screen services] [--mode solo|central|member]
 *
 * The host is a FAKE. It answers instantly, performs nothing, and is deliberately stocked with the
 * awkward cases rather than the happy one: a native server with a pid and an uptime, a service that
 * is down, a runtime whose state could not be detected at all, both runtimes of one service up at
 * once (the CONFLICT), a box with no repo checkout (so no rebuild is offered), and a member endpoint
 * long enough to have wrecked the header once already. `--mode` picks which arrangement you get.
 *
 * `--task` is the other half: it makes the fake host STREAM a realistic build into the output channel
 * — raw bytes, carriage returns and colour included, through the real decoder — so the pane a task
 * owns can be looked at both while it runs and once it has finished.
 *
 * The service rows themselves are built by the host's OWN `buildService` — the pure half of
 * `cli-start.ts` — rather than assembled here by hand. A preview that composed its own rows could
 * draw a screen the real model cannot produce, which is the one thing a preview must not do.
 *
 * This is a dev tool: it is not a test, it must not be collected as one, and nothing ships imports
 * it. Its only claim is "this is what the frame looks like".
 */

import React from 'react'
import { render } from 'ink-testing-library'
import { ControlCenter } from '../src/control/ControlCenter'
import {
  TAB_ORDER,
  type ControlBackupStatus,
  type ControlHost,
  type ControlSession,
  type ControlSessions,
  type ProjectOption,
  type RestoreCandidate,
  type ControlService,
  type ControlStatus,
  type ServiceRuntimeState,
  type TabId,
  DEFAULT_SESSION_VIEW,
} from '../src/control/types'
import { GROUPINGS, type SessionGroupingId } from '../src/control/sessions'
import type { CliLang } from '../src/control/lang'
// The real string table, not a copy of it. Every label on this screen arrives from the host already
// localized, so a preview that invented its own words would be previewing a different screen —
// and `--lang pt` would prove nothing. `cli-i18n.ts` is a dependency-free table of strings; reading
// it from a dev script does not give the TUI a runtime dependency on the server.
import { cliStrings, type CliStrings } from '../../server/server/cli-i18n'
import { bootOptionsFor, buildService } from '../../server/server/cli-start'
// The REAL sanitiser, fed the raw bytes a build produces: a preview that emitted clean lines would
// be previewing a pane nobody's docker ever fills.
import { createLineDecoder } from '../src/control/stream'

// ---------------------------------------------------------------------------
// arguments
// ---------------------------------------------------------------------------

/**
 * Which fake machine to draw.
 *
 * The first three are team modes; the last two are the states that are hard to reach on purpose and
 * therefore the ones most likely to ship wrong — a box running the server natively AND in a
 * container, and a box with no docker at all.
 */
type Case = 'solo' | 'central' | 'member' | 'conflict' | 'nodocker' | 'norepo'

const CASES: readonly Case[] = ['solo', 'central', 'member', 'conflict', 'nodocker', 'norepo'] as const

/**
 * What a previewed task is doing when the frame is captured.
 *
 * `running` never resolves, which is exactly what a two-minute build looks like from here: the
 * spinner is still turning and the pane is following the newest line. `done` resolves, so the pane
 * keeps its output and the status line carries the outcome.
 */
type TaskState = 'off' | 'running' | 'done'

interface Options {
  cols: number
  rows: number
  lang: CliLang
  screen: TabId
  mode: Case
  /** Keys pressed before the frame is captured — how a question gets on screen. */
  keys: string[]
  /** Stream a build into the output channel: `running` (unfinished) or `done`. */
  task: TaskState
  /** Open the sessions list on this arrangement, as a stored preference would. */
  group?: SessionGroupingId
  cascade?: boolean
  /**
   * Pretend the history consent has never been answered.
   *
   * On its own it changes nothing on screen: the gate is asked in FRONT of a start, never at load,
   * so it takes a start to reach it (`--keys enter,right,enter` on a stopped service).
   */
  pending: boolean
  /** Make the fake host REFUSE to spawn, which is the wizard's failure path. */
  failSpawn: boolean
  /**
   * Show the "your last sessions were these" offer.
   *
   * Its own flag because the offer renders in FRONT of the list: stocking the fixture with it
   * unconditionally would put a modal over every other sessions preview, so the screen this exists
   * to check would be the only one anybody could ever see.
   */
  restore: boolean
}

const USAGE = `
  preview — render one control-center frame to stdout

    --cols   N              terminal width  (default 100)
    --rows   N              terminal height (default 34)
    --lang   en|pt          language        (default en)
    --screen ${TAB_ORDER.join('|')}
    --mode   ${CASES.join('|')}
                            which fake machine to show (default solo)
                            conflict = native AND docker up; nodocker = no docker installed;
                            norepo = no checkout here, so no rebuild is offered
                            --screen dashboard serves a fixture AppData over a real
                            throwaway HTTP port, so the metrics screens are drawn
                            through the same fetch the shipped tab uses
    --keys   k,k,…          press these first, e.g. enter,down,enter
                            on the dashboard: 1-5 pick a screen, f opens the filter
                            names: enter esc tab shift-tab up down left right
                            pgup pgdn space, and ctrl-<letter>; anything else is
                            typed literally
    --task   running|done   the next start/restart streams a build into the output pane
                            and either never finishes (running) or does (done);
                            reach it with --keys enter,enter
    --cascade               draw the directory cascade inside the bands
    --pending               history consent still unanswered, so a start opens the
                            gate: --pending --keys enter,right,enter
    --fail-spawn            the new-session wizard's spawn is refused, so its failure
                            path is drawn: --fail-spawn --keys a,enter,enter,enter,enter,enter,enter
    --restore               the machine lost its fleet, so the "start these again?"
                            offer is drawn in front of the list
    --group <arrangement>   open the sessions list already arranged this way, e.g.
                            \`--screen sessions --group tree\` for the cascade
`

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    cols: 100, rows: 34, lang: 'en', screen: 'services', mode: 'solo', keys: [], task: 'off',
    pending: false, failSpawn: false, restore: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1] ?? ''
    switch (flag) {
      case '--cols': opts.cols = Math.max(20, Number(value) || opts.cols); i++; break
      case '--rows': opts.rows = Math.max(10, Number(value) || opts.rows); i++; break
      case '--lang': opts.lang = value === 'pt' ? 'pt' : 'en'; i++; break
      case '--keys': opts.keys = value.split(',').filter(Boolean); i++; break
      case '--group': {
        const found = GROUPINGS.find(g => g === value)
        if (!found) {
          process.stderr.write(`unknown grouping: ${value} (${GROUPINGS.join(', ')})\n${USAGE}`)
          process.exit(2)
        }
        opts.group = found
        i++
        break
      }
      // The cascade is a VIEW now, so it is its own flag rather than one of the groupings —
      // `--group task --cascade` is exactly the combination that could not be previewed before.
      case '--cascade': opts.cascade = true; break
      case '--pending': opts.pending = true; break
      case '--fail-spawn': opts.failSpawn = true; break
      case '--restore': opts.restore = true; break
      case '--task':
        opts.task = value === 'done' ? 'done' : 'running'
        i++
        break
      case '--mode':
        opts.mode = CASES.find(c => c === value) ?? 'solo'
        i++
        break
      case '--screen': {
        const tab = TAB_ORDER.find(t => t === value)
        if (!tab) {
          process.stderr.write(`unknown screen: ${value}\n${USAGE}`)
          process.exit(2)
        }
        opts.screen = tab
        i++
        break
      }
      case '-h':
      case '--help':
        process.stdout.write(USAGE)
        process.exit(0)
        break
      default:
        process.stderr.write(`unknown flag: ${flag}\n${USAGE}`)
        process.exit(2)
    }
  }
  return opts
}

// ---------------------------------------------------------------------------
// the fake host
// ---------------------------------------------------------------------------

/** Written as a code point rather than typed, so this file stays plain text. */
const ESC = String.fromCharCode(27)

const MINUTES = 60_000

/** A long, real-shaped tailnet endpoint — the one whose sentence used to blow the header apart. */
const LONG_ENDPOINT = 'http://198.51.100.199:48080'

const LOCAL_URLS = { webUrl: 'http://localhost:47292', apiUrl: 'http://localhost:47291' }

/**
 * The two LOGICAL services, assembled by the host's own pure `buildService`.
 *
 * Each case says only which RUNTIMES are up; everything the screen reacts to — the start options a
 * stopped service offers, the conflict sentence, the empty option list of a running one — falls out
 * of the model rather than being written down here.
 */
function services(mode: Case, s: CliStrings, apiUrl?: string): ControlService[] {
  const nativeUp = mode !== 'central'
  const machineUp = mode === 'conflict'
  const noDocker = mode === 'nodocker'

  // The dashboard screen reads `/api/data` off the api URL the host reported, so when the preview is
  // drawing that screen it points this at its own fixture server — the SAME path the real tab takes,
  // rather than a hand-drawn frame the model could never produce.
  const urls = apiUrl ? { ...LOCAL_URLS, apiUrl } : LOCAL_URLS

  const native: ServiceRuntimeState = {
    id: 'local',
    kind: 'native',
    state: nativeUp ? 'up' : 'down',
    available: true,
    ...(nativeUp ? { ...urls, pid: 48213, startedAt: Date.now() - 134 * MINUTES } : {}),
  }
  const machine: ServiceRuntimeState = {
    id: 'machine',
    kind: 'docker',
    // Detection itself failed here — the state a service panel gets wrong most expensively. A
    // runtime that CANNOT run (no docker) is `available: false`, which is what keeps it from
    // colouring its service `unknown` on every box that has never installed docker.
    state: noDocker ? 'unknown' : machineUp ? 'up' : 'down',
    available: !noDocker,
    reason: noDocker ? s.dockerMissing : undefined,
    ...(machineUp ? { ...LOCAL_URLS, pid: 61044, startedAt: Date.now() - 12 * MINUTES } : {}),
  }
  const central: ServiceRuntimeState = {
    id: 'central',
    kind: 'docker',
    state: noDocker ? 'unknown' : mode === 'central' ? 'up' : 'down',
    available: !noDocker,
    reason: noDocker ? s.dockerMissing : undefined,
    ...(mode === 'central'
      ? { webUrl: 'http://localhost:48080', pid: 71120, startedAt: Date.now() - 3 * 24 * 60 * MINUTES }
      : {}),
  }

  // What a REBUILD needs, which is a fact about the box rather than about the service: a repo
  // checkout for the native binary, a compose file for the container. `norepo` is the box that has
  // neither, and the restart row there is the plain bounce alone.
  const canRebuild = mode !== 'norepo'

  return [
    // `boot` is what only an OS probe can answer, so the preview states BOTH shapes at once: the
    // native server is registered with systemd, and the central's boot state could not be
    // determined — which must render as no boot row at all rather than as "no".
    buildService('agentistics', s.svcAgentistics, [native, machine], s, {
      boot: 'on',
      bootUnit: 'agentop-server.service',
      // BOTH positions of the switch on one service, which is the case worth drawing: the native
      // unit is registered (so it offers to remove it) and the container's is not (so it offers to
      // write it). A fixture with one position would never render the longer of the two verbs.
      bootOptions: bootOptionsFor([
        { unit: 'agentop-server.service', runtime: 'local', mech: 'native', on: true, installable: true },
        { unit: 'agentop-machine.service', runtime: 'machine', mech: 'docker', on: false, installable: canRebuild },
      ], s, true, s.svcAgentistics),
      rebuild: { local: canRebuild, machine: canRebuild },
    }),
    // No `boot` at all — the state this must render as NO boot row rather than as "does not start
    // at boot", and therefore with no boot verb either.
    buildService('central', s.svcCentral, [central], s, {
      rebuild: { central: true },
      bootOptions: bootOptionsFor(
        [{ unit: 'agentop-central.service', runtime: 'central', mech: '', on: false, installable: true }],
        s, true, s.svcCentral,
      ),
    }),
  ]
}

function fakeStatus(opts: Options, apiUrl?: string): ControlStatus {
  const s = cliStrings(opts.lang)
  return {
    // The two extra cases are arrangements of SERVICES, not team modes; they show a solo machine.
    mode: opts.mode === 'central' || opts.mode === 'member' ? opts.mode : 'solo',
    modeLabel: opts.mode === 'member' ? s.configMemberBare : opts.mode === 'central' ? s.configCentral : s.configSolo,
    endpoint: opts.mode === 'member' ? LONG_ENDPOINT : undefined,
    services: services(opts.mode, s, apiUrl),
    // A member machine carries a NAME and a latency; the sweep has to see the header at its widest,
    // or the fit is only ever checked in the shape that happens to be shortest.
    ...(opts.mode === 'member'
      ? {
          machineName: 'wsl-mithrandir',
          accountName: 'blpsoares',
          linkState: 'ok' as const,
          pushMs: 468,
        }
      : {}),
    version: '1.7.3',
    latestVersion: '1.7.4',
    // The parallel-sessions budget, so the width sweep exercises the header WITH it. A calm one:
    // the red case gives way later than this does, so a frame that fits this fits that too.
    memory: { used: 3, max: 17, red: false, percent: 62 },
    archiveMode: 'consolidate',
    // The wizard's blocked row, stated whenever the fake central is up: it is the case the fold
    // exists for, and a preview that only ever drew three selectable modes would never show it.
    setupBlocked: opts.mode === 'central' ? { central: s.setupBlockedCentralUp } : {},
    // `--group` arrives as a stored arrangement, exactly as a real machine's preferences would —
    // the screen reads its own default otherwise. It is the only way to LOOK at an arrangement
    // without driving the menu by keystroke, and the cascade is the one arrangement whose whole
    // point is what it looks like.
    ...(opts.group || opts.cascade
      ? {
          sessionView: {
            ...DEFAULT_SESSION_VIEW,
            ...(opts.group ? { grouping: opts.group } : {}),
            ...(opts.cascade ? { cascade: true } : {}),
          },
        }
      : {}),
  }
}

/**
 * Plausible tail lines, so the Logs screen is exercised at its real line lengths.
 *
 * Keyed by every `LogSource` the selector can produce: the two LOGICAL services normally, and the
 * two runtimes of `agentistics` in the conflict case, where they genuinely are different logs.
 */
const NATIVE_LOG = [
  '20:58:11 listening on 47291 (api + mcp)',
  '20:58:11 dashboard on 47292',
  '20:58:12 otel watcher started',
  '20:59:03 sse client connected',
  '21:03:44 rebuilt stats cache in 412ms',
]

const LOG: Record<string, string[]> = {
  agentistics: NATIVE_LOG,
  local: NATIVE_LOG,
  machine: [
    '20:31:08 [container] listening on 47291 (api + mcp)',
    '20:31:09 [container] dashboard on 47292 — ADDRESS ALREADY IN USE, retrying',
  ],
  central: [
    '20:12:02 mongo connected',
    '20:12:02 central listening on 47291',
    '20:44:19 member push accepted · 214 sessions',
  ],
}

/**
 * The raw bytes of a `docker compose up --build`, in the shapes that break a naive reader.
 *
 * A hidden cursor, a step table redrawn in place with carriage returns, colour around a step name, a
 * chunk that ends mid-line, a blank separator the build actually printed, and an error on the way
 * out. Fed through the real decoder, so what the pane shows here is what it will show there.
 */
const BUILD_CHUNKS: string[] = [
  `${ESC}[?25l#1 [internal] load build definition from Dockerfile\n`,
  '#1 transferring dockerfile: 1.4s\r#1 transferring dockerfile: 2.7s\r#1 DONE 2.7s\n\n',
  `#2 [internal] load metadata for docker.io/oven/bun:1${ESC}[0m\n#2 DONE 0.9s\n`,
  '#3 [builder 2/8] COPY package.json bun.lock ./\n#3 CACHED\n',
  '#4 [builder 3/8] RUN bun install --frozen-lockfile\n',
  '#4 1.882 bun install v1.3.14\n#4 12.40 + 412 packages installed [11.9s]\n#4 DONE 12.9s\n',
  '#5 [builder 6/8] RUN bun run build:binary\n#5 24.11   dist/index.html   0.53 kB\n#5 41.06 ',
  `  compiled ./release/agentop\n#5 DONE 41.3s\n\n#6 exporting to image\n#6 DONE 3.1s\n${ESC}[?25h`,
]

function fakeHost(opts: Options, apiUrl?: string): ControlHost {
  const done = async () => ({ ok: true, message: 'preview — nothing was performed' })

  // The output channel, in the shape `cli-stream.ts` implements for real.
  const watchers = new Set<(line: string) => void>()
  const publish = (line: string) => { for (const w of [...watchers]) w(line) }

  /**
   * A streamed action: publish the build, then either finish or never.
   *
   * Deliberately NOT resolved for `running` — that is what a build in flight is, and it is the only
   * way to capture the frame where the pane is following a task that has not finished.
   */
  const streamed = async () => {
    const decoder = createLineDecoder()
    for (const chunk of BUILD_CHUNKS) for (const line of decoder.push(chunk)) publish(line)
    for (const line of decoder.flush()) publish(line)
    if (opts.task === 'running') return new Promise<never>(() => {})
    return { ok: true, message: 'preview — nothing was performed' }
  }

  const act = opts.task === 'off' ? done : streamed

  return {
    refresh: async () => fakeStatus(opts, apiUrl),
    start: act,
    connect: done,
    disconnect: done,
    restart: act,
    stop: done,
    setMode: done,
    initCentral: done,
    // `null` is "already answered", so the preview only opens on the consent gate when asked to.
    pendingArchiveMode: async () => (opts.pending ? 'consolidate' : null),
    upgrade: done,
    setArchiveMode: done,
    enableBoot: done,
    disableBoot: done,
    setLang: async () => {},
    // The preview has no terminal to report a mouse, so `ControlCenter` is rendered without a
    // channel and never asks for tracking — this only satisfies the contract.
    setMouse: async () => {},
    setSessionPollMs: async () => {},
    // Present so the preview shows the cockpit's full action row. `openUrl` is optional on the
    // host, and a host without it makes the action, the `o` key and its footer hint all disappear.
    openUrl: done,
    onOutput: handler => {
      watchers.add(handler)
      return () => { watchers.delete(handler) }
    },
    readLog: async (source, maxLines) => (LOG[source] ?? []).slice(-maxLines),
    sessions: async () => (opts.restore
      ? { ...FAKE_FLEET, restorable: FAKE_RESTORABLE }
      : FAKE_FLEET),
    restoreSessions: done,
    startableHarnesses: async () => [
      { id: 'claude', label: 'claude', modelSuggestions: ['opus', 'sonnet', 'haiku'], supportsModel: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'codex', label: 'codex', modelSuggestions: ['gpt-5.4', 'gpt-5.4-mini'], supportsModel: true, efforts: [] },
      { id: 'kimi', label: 'kimi', modelSuggestions: ['kimi-k3'], supportsModel: true, efforts: [] },
    ],
    searchProjects: async (query: string) => FAKE_PROJECTS
      .filter(p => p.label.toLowerCase().includes(query.trim().toLowerCase())),
    // `--fail-spawn` drives the wizard's REFUSAL path, which is the one that used to eat the
    // prompt: it closed the wizard and put the reason on a status line one row tall.
    spawnSession: async () => (opts.failSpawn
      ? { ok: false, message: 'tmux recusou: sessão duplicada' }
      : { ok: true, message: 'preview — nothing was performed' }),
    // Present so the three verbs that write into a session are reachable here at all. They perform
    // nothing: the questions are what a layout check needs to see, and the preview must never send
    // a keystroke anywhere.
    promptSession: done,
    answerSession: done,
    reopenFell: done,
    backupStatus: async () => FAKE_BACKUP,
    setBackupHarness: async () => {},
    setBackupSchedule: async () => ({ ok: true, message: 'preview — nothing was performed' }),
    runBackup: act,
  }
}

/**
 * A backup worth looking at: the numbers from the design's own measured table — a harness with
 * everything present, one riding the next backup with no size worth naming yet, one UNTICKED (so
 * it must read as unprotected, not merely dimmer), and one whose last record points at a file
 * that is gone.
 */
const FAKE_BACKUP: ControlBackupStatus = {
  harnesses: [
    { id: 'claude', enabled: true, sessions: 552, sizeLabel: '3.4 MB', lastBackupAt: new Date(Date.now() - 6 * 60 * 60_000).toISOString() },
    { id: 'codex', enabled: true, sessions: 14, sizeLabel: '60 KB', lastBackupAt: new Date(Date.now() - 6 * 60 * 60_000).toISOString() },
    { id: 'gemini', enabled: true, sessions: 15, sizeLabel: '64 KB', lastBackupAt: new Date(Date.now() - 6 * 60 * 60_000).toISOString() },
    // Unticked, and NEVER backed up — the row this whole tab exists to make unmissable.
    { id: 'copilot', enabled: false, sessions: 11, sizeLabel: '48 KB' },
    { id: 'antigravity', enabled: true, sessions: 34, sizeLabel: '140 KB', lastBackupGone: true },
    { id: 'kimi', enabled: true, sessions: 12, sizeLabel: '52 KB', lastBackupAt: new Date(Date.now() - 6 * 60 * 60_000).toISOString() },
  ],
  config: {
    layers: ['metrics', 'repos'],
    scheduleLayers: ['metrics'],
    destDir: '/home/dev/backups',
    schedule: 'daily',
    scheduleActive: true,
    keep: 7,
    retainedLabel: '35 MB',
    secretsCount: 5,
    layerSizes: { metrics: '3.4 MB', repos: null, archive: '12 MB', raw: '953 MB' },
    last: { at: new Date(Date.now() - 6 * 60 * 60_000).toISOString(), bytesLabel: '4.1 MB', skipped: 0 },
  },
}

/**
 * A fleet worth looking at: one blocked on a question, one waiting, one working, one finished, and
 * one running outside agentop.
 *
 * Deliberately covers every state the row can wear, because the point of the preview is to catch a
 * row that does not fit — and the state word is the one cell the screen may never give up, so the
 * widest of them (`needs approval`) has to be on screen at every width being checked.
 */
const FAKE_PROJECTS: ProjectOption[] = [
  { path: '/home/dev/agentistics', label: 'agentistics', repo: 'blpsoares/agentistics', detail: '~/agentistics', source: 'cwd' },
  { path: '/home/dev/prontuario', label: 'prontuario', repo: 'org/prontuario', detail: '~/prontuario', source: 'history' },
  { path: '/home/dev/agentistics-wt', label: 'session-monitor', repo: 'blpsoares/agentistics', detail: '~/agentistics/…/worktrees/session-monitor', source: 'history' },
  { path: '/home/dev/embark', label: 'embark', detail: '~/orgs/opvibes/embark', source: 'repo' },
  { path: '/home/dev/embark2', label: 'embark', detail: '~/archive/2024/embark', source: 'folder' },
  { path: '/home/dev/scratch', label: 'scratch', detail: '~/scratch', source: 'folder' },
]

/**
 * What the offer names after a fall — the awkward cases rather than the tidy one: a long label that
 * has to be truncated beside its harness and project, a row with no start time at all, and enough
 * of them to reach the pane's own limit on a short terminal.
 */
const FAKE_RESTORABLE: RestoreCandidate[] = [
  { id: 'f00d01', label: 'ledger reconciliation', harness: 'claude', project: 'agentistics', startedAt: Date.now() - 3 * 60 * 60_000 },
  { id: 'f00d02', label: 'invoice export', harness: 'codex', project: 'prontuario', startedAt: Date.now() - 3 * 60 * 60_000 },
  { id: 'f00d03', label: 'rewrite the CSV importer so it stops guessing the encoding', harness: 'kimi', project: 'embark', startedAt: Date.now() - 4 * 60 * 60_000 },
  { id: 'f00d04', label: 'no start time on record', harness: 'claude', project: 'aipe' },
]

const FAKE_FLEET: ControlSessions = {
  attention: 2,
  rang: [],
  detachHint: 'Ctrl-b then d',
  finishedTasks: ['billing'],
  // A fall on record, so the summary row's note, the "fell together" section and the reopen
  // confirmation are all reachable here. Reach the rows with `--keys l` (the default view is only
  // what is running, and a session that fell is by definition not).
  fell: { count: 2, atMs: Date.now() - 6 * MINUTES },
  sessions: withSearchText([
    {
      id: 'a1b2c3', title: 'migrate the auth store', harness: 'claude',
      cwd: '/home/dev/agentistics', project: 'agentistics', model: 'opus', task: 'auth store',
      repo: 'blpsoares/agentistics', projectRoot: '/home/dev/agentistics',
      // NOT under `billing`, deliberately: that task is finished in this fixture, so a row filed
      // under it is hidden by default — and the one row this preview exists to reach is the blocked
      // one. `f00d01` carries `billing` instead, which keeps the finished-task case covered.
      state: 'waiting-approval', stateLabel: 'needs approval', actionable: true,
      // Usage on SOME rows and not others, deliberately: the column is sized to the widest row that
      // has any, and a fixture where every row carries one would never exercise the padding.
      tokens: '51.7k', cost: '$1.24',
      // The WARN level: far enough along to be worth acting on, not yet past the window. The three
      // levels are on screen at once in this fixture on purpose — a palette you can only see one
      // shade of at a time is one nobody checks.
      context: { fraction: 0.87, label: '87%', used: '174k', window: '200k' },
      lastLines: ['applying migration 003_auth_store.sql', 'waiting for your approval'],
      // The dialog, at the width a real one is drawn at — which is the point: the confirmation has
      // to fit it into a pane that is often much narrower, and a fixture of short lines would never
      // show that.
      // A THREE-way choice, which is what a claude permission prompt actually is — the case the
      // picker exists for. `canApprove` is deliberately absent: there is no approving here.
      canChoose: true,
      dialogOptions: [
        { number: 1, label: 'Yes', selected: true },
        { number: 2, label: 'Yes, allow all edits during this session (shift+tab)', selected: false },
        { number: 3, label: 'No', selected: false },
      ],
      approvalLines: [
        '│ Bash command                                                    │',
        '│   bun run db:migrate --env production                           │',
        '│                                                                 │',
        '│ Do you want to proceed?                                         │',
        '│ ❯ 1. Yes                                                        │',
        '│   2. Yes, allow all edits during this session (shift+tab)       │',
        '│   3. No                                                         │',
        '│ Esc to cancel · Tab to amend                                    │',
      ],
      startedAt: Date.now() - 22 * 60_000, attached: false,
    },
    // A dialog whose options ARE readable but whose harness nobody has verified a way to pick on.
    // The one row that must draw a REFUSAL naming why, rather than a picker that would confirm the
    // highlighted row on the user's behalf.
    {
      id: 'c0de01', title: 'promote to prod', harness: 'gemini',
      cwd: '/home/dev/embark', project: 'embark',
      state: 'waiting-approval', stateLabel: 'needs approval', actionable: true,
      dialogOptions: [
        { number: 1, label: 'Só o meu fix, isolado', selected: true },
        { number: 2, label: 'Promover dev→main inteiro', selected: false },
        { number: 3, label: 'Parar em dev por enquanto', selected: false },
        { number: 4, label: 'Type something.', selected: false },
      ],
      approvalLines: [
        'Como promover pra prod? O merge dev→main levaria junto ID-100, ID-81 e ID-54.',
        '❯ 1. Só o meu fix, isolado',
        '  2. Promover dev→main inteiro',
        '  3. Parar em dev por enquanto',
        '  4. Type something.',
        'Enter to select · ↑/↓ to navigate · Esc to cancel',
      ],
      chooseBlind: 'this dialog is a choice, and nobody has verified how to pick an option on gemini — attach to answer it there.',
      startedAt: Date.now() - 8 * 60_000, attached: false,
    },
    // The two the machine took together. `lost`, named, and carrying their task — which is what a
    // reboot leaves behind and what "reopen what fell" puts back.
    {
      id: 'f00d01', title: 'ledger reconciliation', harness: 'claude',
      cwd: '/home/dev/agentistics', project: 'agentistics', repo: 'blpsoares/agentistics',
      projectRoot: '/home/dev/agentistics',
      task: 'billing', named: true, fell: true,
      state: 'lost', stateLabel: 'lost', actionable: true,
      resume: { sessionId: 'r1', title: 'ledger reconciliation' },
      startedAt: Date.now() - 3 * 60 * 60_000, attached: false,
    },
    {
      id: 'f00d02', title: 'invoice export', harness: 'codex',
      cwd: '/home/dev/prontuario', project: 'prontuario', repo: 'org/prontuario',
      named: true, fell: true,
      state: 'lost', stateLabel: 'lost', actionable: true,
      resume: { sessionId: 'r2', title: 'invoice export' },
      startedAt: Date.now() - 3 * 60 * 60_000, attached: false,
    },
    {
      id: 'd4e5f6', title: 'flaky test hunt', harness: 'codex',
      cwd: '/home/dev/prontuario', project: 'prontuario', task: 'flaky triage', repo: 'org/prontuario',
      // Named in BOTH places, so the detail pane's "the other name" row is on screen: the title is
      // the one typed inside the session, and `named here` states the agentop label that lost.
      titleSource: 'harness', titleOther: 'flaky-triage',
      // Codex states its OWN window (`model_context_window`), so this row's denominator is the
      // harness's answer rather than a table lookup — and it is not a round number.
      context: { fraction: 0.12, label: '12%', used: '31k', window: '258.4k' },
      note: 'reproduces only on CI', state: 'waiting', stateLabel: 'waiting',
      actionable: true, approvalBlind: 'agentop has no verified screen markers for codex, so a blocking question here shows as "waiting" like any other pause.',
      startedAt: Date.now() - 3 * 60_000, attached: false,
    },
    {
      id: '778899', title: 'rewrite the importer', harness: 'kimi',
      cwd: '/home/dev/embark', project: 'embark', model: 'kimi-k3',
      state: 'working', stateLabel: 'working', actionable: true,
      tokens: '308.2k', cost: '$0.91',
      // PAST the window: the bar saturates and the number keeps telling the truth. This is not a
      // contrived case — 212.959 tokens against a 200k window is a real measurement off this
      // machine, and a bar that silently pinned at 100% here would be the reassuring kind of wrong.
      context: { fraction: 1.06, label: '106%', used: '212.9k', window: '200k' },
      lastLines: ['rewriting src/importer/rows.ts'],
      note: 'blocked on the CSV encoding',
      startedAt: Date.now() - 90_000, attached: true,
    },
    {
      id: 'aabbcc', title: 'release notes', harness: 'claude',
      cwd: '/home/dev/agentistics/.claude/worktrees/notes', project: 'notes',
      repo: 'blpsoares/agentistics', projectGroup: 'agentistics', worktree: true,
      projectRoot: '/home/dev/agentistics',
      state: 'exited', stateLabel: 'exited', actionable: true, named: true,
      startedAt: Date.now() - 4 * 60 * 60_000, attached: false,
    },
    {
      id: 'external:claude:/home/dev/aipe:0', title: 'claude in aipe', harness: 'claude',
      cwd: '/home/dev/aipe', project: 'aipe',
      state: 'unknown', stateLabel: 'external', actionable: false,
      startedAt: Date.now() - 40 * 60_000, attached: false,
    },
    // Several conversations under ONE name, all off — the DUPLICATE-NAME case (a coordinator
    // reopened again and again). They share a title and a project, and are told apart ONLY by the
    // never-dropped `id` column and the per-row "ended" time. This is the awkward case behind the
    // "why do I see the same session five times" report: rendered here, the rows are distinct
    // (distinct ids co1/co2/co3), which is the proof that identical-LOOKING rows can only come from
    // records that share an id — a de-dup question upstream, not a drawing one here.
    {
      id: 'closed:co1', title: 'COORDENADOR AIPE-ELETROMIDIA', harness: 'claude',
      cwd: '/home/dev/aipe-eletromidia', project: 'aipe-eletromidia',
      state: 'closed', stateLabel: 'closed', actionable: false,
      resume: { sessionId: 'co1', title: 'COORDENADOR AIPE-ELETROMIDIA' },
      startedAt: Date.now() - 9 * 60 * 60_000, endedAt: Date.now() - 8 * 60 * 60_000, attached: false,
    },
    {
      id: 'closed:co2', title: 'COORDENADOR AIPE-ELETROMIDIA', harness: 'claude',
      cwd: '/home/dev/aipe-eletromidia', project: 'aipe-eletromidia',
      state: 'closed', stateLabel: 'closed', actionable: false,
      resume: { sessionId: 'co2', title: 'COORDENADOR AIPE-ELETROMIDIA' },
      startedAt: Date.now() - 5 * 60 * 60_000, endedAt: Date.now() - 4 * 60 * 60_000, attached: false,
    },
    {
      id: 'closed:co3', title: 'COORDENADOR AIPE-ELETROMIDIA', harness: 'claude',
      cwd: '/home/dev/aipe-eletromidia', project: 'aipe-eletromidia',
      state: 'closed', stateLabel: 'closed', actionable: false,
      resume: { sessionId: 'co3', title: 'COORDENADOR AIPE-ELETROMIDIA' },
      startedAt: Date.now() - 1 * 60 * 60_000, endedAt: Date.now() - 30 * 60_000, attached: false,
    },
    {
      id: 'closed:1', title: 'wire up the billing basis', harness: 'claude',
      cwd: '/home/dev/agentistics', project: 'agentistics', task: 'billing',
      projectRoot: '/home/dev/agentistics',
      state: 'closed', stateLabel: 'closed', actionable: false,
      resume: { sessionId: 'c1', title: 'wire up the billing basis' },
      startedAt: Date.now() - 26 * 60 * 60_000, attached: false,
    },
    {
      id: 'closed:2', title: 'billing: reconcile the ledger', harness: 'codex',
      cwd: '/home/dev/agentistics/packages/server', project: 'server',
      projectGroup: 'agentistics', projectRoot: '/home/dev/agentistics', task: 'billing',
      state: 'closed', stateLabel: 'closed', actionable: false,
      resume: { sessionId: 'c2', title: 'billing: reconcile the ledger' },
      startedAt: Date.now() - 30 * 60 * 60_000, attached: false,
    },
  ]),
}

/** The preview's fixtures say what they ARE; the searchable blob is derived, exactly as the host
 *  derives it, so the two can never disagree about what a row can be found by. */
function withSearchText(rows: Array<Omit<ControlSession, 'searchFields'>>): ControlSession[] {
  return rows.map(r => ({
    ...r,
    searchFields: {
      name: r.title ?? '', folder: r.cwd ?? '', harness: r.harness ?? '',
      note: r.note ?? '', task: r.task ?? '', prompt: '',
    },
  }))
}

// ---------------------------------------------------------------------------
// the dashboard's data
// ---------------------------------------------------------------------------

/**
 * A day key `n` days back, so the sparkline has something to draw whenever this is run.
 *
 * Dates in the fixture are relative for the same reason the fleet's timestamps are: a hardcoded
 * month would render an empty activity chart the moment it fell out of the 30-day window, and the
 * preview would be reporting a layout problem the screen does not have.
 */
function dayKey(back: number): string {
  const d = new Date(Date.now() - back * 24 * 60 * MINUTES)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function fakeSession(over: Record<string, unknown>): Record<string, unknown> {
  return {
    project_path: '/home/dev/agentistics', start_time: new Date(Date.now() - 3 * 60 * MINUTES).toISOString(),
    duration_minutes: 24, user_message_count: 12, assistant_message_count: 14,
    tool_counts: {}, tool_output_tokens: {}, agent_file_reads: {}, languages: [],
    git_commits: 0, git_pushes: 0, input_tokens: 0, output_tokens: 0, first_prompt: '',
    user_interruptions: 0, user_response_times: [], tool_errors: 0, tool_error_categories: {},
    uses_task_agent: false, uses_mcp: false, uses_web_search: false, uses_web_fetch: false,
    lines_added: 0, lines_removed: 0, files_modified: 0, message_hours: [], user_message_timestamps: [],
    ...over,
  }
}

/**
 * An `AppData` shaped like a real machine's, and awkward on purpose.
 *
 * Claude's totals come from the statsCache and everything else from per-session sums — the rule
 * `selectors.ts` exists to enforce — so the fixture carries BOTH, or the preview would never show a
 * screen where the two sources meet. The long project path and the eleven-digit token counts are the
 * two things that actually break a column.
 */
function dashboardData(): unknown {
  return {
    harnesses: ['claude', 'codex', 'gemini', 'kimi'],
    liveSessionIds: ['s-live'],
    projects: [],
    allSessions: [],
    statsCache: {
      totalSessions: 1284, totalMessages: 41902,
      lastComputedDate: dayKey(1),
      dailyActivity: Array.from({ length: 30 }, (_, i) => ({
        date: dayKey(29 - i),
        messageCount: [0, 12, 340, 88, 512, 1204, 90][i % 7]!,
        sessionCount: 3,
      })),
      dailyTokens: {},
      dailyModelTokens: {},
      modelUsage: {
        'claude-opus-4-6': { inputTokens: 4_120_000, outputTokens: 812_000, cacheReadInputTokens: 903_400_000, cacheCreationInputTokens: 41_000_000 },
        'claude-sonnet-4-6': { inputTokens: 2_004_000, outputTokens: 410_000, cacheReadInputTokens: 210_000_000, cacheCreationInputTokens: 9_800_000 },
      },
    },
    sessions: [
      fakeSession({ session_id: 's-live', harness: 'claude', model: 'claude-opus-4-6', title: 'wire the dashboard tab into the cockpit', input_tokens: 91_000, output_tokens: 12_400, cache_read_input_tokens: 8_100_000 }),
      fakeSession({ session_id: 's-2', harness: 'codex', model: 'gpt-5.4', title: 'flaky test hunt', project_path: '/home/dev/prontuario/packages/front', input_tokens: 410_000, output_tokens: 61_000 }),
      fakeSession({ session_id: 's-3', harness: 'kimi', model: 'gemini-3.5-flash-lite', title: 'rewrite the importer', project_path: '/home/dev/orgs/opvibes/embark', input_tokens: 1_200_000, output_tokens: 88_000 }),
      fakeSession({ session_id: 's-4', harness: 'gemini', title: 'read the migration plan', project_path: '/home/dev/agentistics/.claude/worktrees/dashboard-tab', start_time: new Date(Date.now() - 26 * 60 * MINUTES).toISOString() }),
      fakeSession({ session_id: 's-5', harness: 'claude', model: 'claude-sonnet-4-6', title: 'ledger reconciliation', project_path: '/home/dev/agentistics', start_time: new Date(Date.now() - 50 * 60 * MINUTES).toISOString(), input_tokens: 44_000, output_tokens: 9_100 }),
    ],
  }
}

/**
 * A throwaway server answering the two endpoints the dashboard reads.
 *
 * The alternative was a `data` prop the tab accepts only for previews, which is a hole in the
 * component's contract kept open for a dev script — and it would prove nothing about the path that
 * actually ships. This exercises the real fetch, the real SSE handshake and the real "the server is
 * up, here is its api URL" resolution.
 */
function serveFixture(): { apiBase: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url)
      if (pathname === '/api/data') return Response.json(dashboardData())
      if (pathname === '/api/events') {
        // One SSE COMMENT and then silence. The comment is not politeness: a stream that enqueues
        // nothing never flushes its headers, so `fetch` does not resolve and the screen is captured
        // still saying `connecting` — a preview reporting a state the real server never shows. A
        // single `\n` rather than the blank line an event ends with, so it is not read as one.
        return new Response(
          new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(': preview\n')) } }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      return new Response('not found', { status: 404 })
    },
  })
  return { apiBase: `http://localhost:${server.port}`, stop: () => { void server.stop(true) } }
}

// ---------------------------------------------------------------------------
// framing
// ---------------------------------------------------------------------------

/**
 * Color codes occupy no cells. They stay in the printed frame — a preview in a terminal should
 * look like the thing — but are discounted when measuring, or every colored row would be
 * reported as overflowing. Spelled `\u001B` rather than typed, so the source stays plain text.
 */
const ANSI = /\u001B\[[0-9;]*m/g

function visibleWidth(line: string): number {
  return line.replace(ANSI, '').length
}

/**
 * A two-row ruler: tens above, units below.
 *
 * Column numbers, not a bare rule of dashes — when a row is three cells too long the question is
 * always "by how much", and counting dashes by eye is exactly the work this is meant to remove.
 */
function ruler(cols: number): string[] {
  let tens = ''
  let units = ''
  for (let i = 1; i <= cols; i++) {
    tens += i % 10 === 0 ? String(Math.floor(i / 10) % 10) : ' '
    units += String(i % 10)
  }
  return [tens, units]
}

/**
 * The escape sequences a real terminal sends, so `--keys` drives the app through the same parser a
 * keyboard does.
 *
 * Without this the questions — "how should it run?", the archive consent, every confirmation — are
 * unpreviewable: they exist only after a keypress, which is exactly the state a screenshot cannot
 * reach and therefore the state that shipped wrong twice.
 */
/**
 * A control chord as the byte a terminal actually sends: `ctrl-a` is 0x01, `ctrl-h` is 0x08.
 *
 * Named rather than typed literally because there is no way to type a control byte into a shell
 * argument, and this screen now answers three of them — a key the preview cannot press is a key no
 * layout check ever sees.
 */
function ctrlByte(name: string): string | undefined {
  const m = /^ctrl-([a-z])$/.exec(name)
  return m ? String.fromCharCode(m[1]!.charCodeAt(0) - 96) : undefined
}

const KEYS: Record<string, string> = {
  enter: '\r',
  esc: ESC,
  tab: '\t',
  'shift-tab': `${ESC}[Z`,
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  right: `${ESC}[C`,
  left: `${ESC}[D`,
  pgup: `${ESC}[5~`,
  pgdn: `${ESC}[6~`,
  space: ' ',
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))

  // `useTerminalSize` reads the REAL `process.stdout`, while Ink lays out against the fake stdout
  // the testing library hands it — so a preview at anything other than the default size has to set
  // both, or the layout math and the frame it lands in would disagree about how wide the world is.
  Object.defineProperty(process.stdout, 'columns', { value: opts.cols, configurable: true })
  Object.defineProperty(process.stdout, 'rows', { value: opts.rows, configurable: true })

  // Only the dashboard reads over HTTP, so only it opens a port — every other screen is drawn from
  // values the fake host returns directly, and a listener nobody uses is a listener that can fail.
  const fixture = opts.screen === 'dashboard' ? serveFixture() : null

  const element = (
    <ControlCenter
      host={fakeHost(opts, fixture?.apiBase)}
      lang={opts.lang}
      initial={{ tab: opts.screen }}
      onExit={() => {}}
    />
  )

  const app = render(element)
  // ink-testing-library hardcodes a 100-column stdout behind a prototype getter. Shadowing it on
  // the instance and re-rendering is the whole of the fix: Ink re-reads `columns` on every render
  // pass, so the second frame is laid out at the requested width.
  Object.defineProperty(app.stdout, 'columns', { get: () => opts.cols, configurable: true })
  app.rerender(element)

  // The first frame is drawn before `refresh()` resolves, so it is the spinner. Waiting a beat is
  // what makes the preview show the screen rather than its loading state. The dashboard waits
  // longer: its status has to land BEFORE it knows which address to read, so it is two round trips
  // rather than one.
  await sleep(fixture ? 700 : 200)

  // One key per tick, with the app given time to settle between them: a question opens on a state
  // change, and a burst written in one chunk would be parsed as a single garbled sequence.
  for (const key of opts.keys) {
    app.stdin.write(KEYS[key] ?? ctrlByte(key) ?? key)
    await sleep(60)
  }

  const frame = app.lastFrame() ?? ''
  const lines = frame.replace(/\n+$/, '').split('\n')
  const [tens, units] = ruler(opts.cols)
  const over = lines.filter(l => visibleWidth(l) > opts.cols)

  /**
   * HEIGHT is measured too, and it fails the same way width does.
   *
   * Ink does not clip an overflowing child, it COMPOSITES it — a body one row too tall is drawn
   * into the same cells as the status line, which reads as a corrupted frame rather than a cramped
   * one. Every screen budgets itself against `height` for exactly that reason, and a budget nobody
   * checks is a budget that drifts: this is the check. Reported as its own line, because "three rows
   * too tall" and "three columns too wide" are different bugs in different functions.
   */
  const tall = lines.length - opts.rows

  const out = [
    `  ${opts.mode} · ${opts.screen} · ${opts.lang} · ${opts.cols}x${opts.rows}`,
    tens,
    units,
    ...lines,
    units,
    over.length
      ? `  ✗ ${over.length} row(s) exceed ${opts.cols} columns — widest is ${Math.max(...over.map(visibleWidth))}`
      : `  ✓ every row fits ${opts.cols} columns`,
    tall > 0
      ? `  ✗ the frame is ${tall} row(s) taller than ${opts.rows} — Ink composites the overflow`
      : `  ✓ the frame fits ${opts.rows} rows (${lines.length} used)`,
    '',
  ].join('\n')

  app.unmount()
  fixture?.stop()
  process.stdout.write(`${out}\n`)
  // Ink's spinner keeps an interval alive past the unmount; the frame is printed, so the only thing
  // left to do is leave rather than idle on a timer nobody is watching.
  process.exit(over.length || tall > 0 ? 1 : 0)
}

void main()
