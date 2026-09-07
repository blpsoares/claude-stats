/**
 * cli-start.ts — the logic behind the `agentop` control center.
 *
 * This module owns everything the control center DOES: what the current mode is, which services
 * are up, and what each action performs. The Ink layer (`@agentistics/tui/control`) owns only how
 * that is drawn — the two meet at `ControlHost`, implemented here, whose methods return an
 * already-localized `ActionResult` instead of printing.
 *
 * Nothing here may write to stdout while the alternate screen is live: a stray line lands in a
 * buffer Ink is repainting and corrupts the frame. There are three ways an action obeys that, and
 * which one it takes is a judgement about what the action SAYS:
 *
 *  - `captureOutput` — it prints a sentence. The prints are swallowed and the last line becomes the
 *    failure message in the status line.
 *  - `streamOutput` — its output is the point and there is nothing to ask. `docker compose up
 *    --build`, `central.sh up`, `bun run bin`: the child is spawned with BOTH pipes captured (never
 *    `inherit`, never a tty of its own) and every line it produces is published on the output
 *    channel, which the control center draws into a pane. This is what replaced leaving the screen.
 *  - `suspend` — it asks a QUESTION, so it needs the real terminal. `central.sh init` is the whole
 *    of that list: it refuses outright without a tty, and a prompt streamed into a pane is a
 *    question nobody can answer.
 *
 * Language follows `--lang en|pt`, else `preferences.lang` (shared with the web), else English;
 * the in-app toggle persists to that same preference.
 *
 * Non-interactive stdin (a pipe or a systemd unit) never opens the control center and behaves like
 * `agentop server`. runStart() returns a numeric exit code or the sentinel 'foreground' (cli.ts
 * then starts the in-process server and does not exit).
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, platform } from 'node:os'
import {
  DEFAULT_TEAM, HARNESS_ORDER, repoShortName,
  type HarnessId, type TeamConnection,
} from '@agentistics/core'
import type {
  ActionResult,
  ActionTarget,
  AttachTicket,
  BackupLayer,
  BackupScheduleId,
  BootState,
  ControlBackupConfig,
  ControlBackupHarness,
  ControlBackupStatus,
  ControlHost,
  ControlService,
  ControlSessions,
  TranscriptSearch,
  CentralLinkState,
  ControlStatus,
  LogSource,
  RestartOption,
  RuntimeId,
  ServiceId,
  ServiceRef,
  ServiceRuntimeState,
  ServiceState,
  SessionHarnessOption,
  SessionViewPrefs,
  SpawnSessionRequest,
  SpawnSessionResult,
  ProjectOption,
  ResumeSessionRequest,
  StartOption,
  BootOption,
  TabId,
  StartRequest,
  RestoreCandidate,
} from '@agentistics/tui/control'
import { DEFAULT_SESSION_VIEW } from '@agentistics/tui/control'
import { AGENTISTICS_DATA_DIR, PORT, WEB_PORT } from './config'
import {
  readPreferences, writePreferences, resolveArchiveMode, type ArchiveMode,
  clampSessionPollMs, sessionPollMsOrDefault, SESSION_POLL_DEFAULT_MS,
} from './preferences'
import {
  performBackup, readBackupPrefs, layerSizesNow,
  writeBackupLayers, writeBackupScheduleLayers, writeBackupSchedule,
} from './cli-backup'
import { readGithubSection } from './backup-routes'
import { omittedSecrets } from './backup/backup-plan'
import { formatBytes, layerTotal, retainedTotal } from './backup/backup-size'
import { lastBackup, lastPerHarness, loadBackupHistory } from './backup/backup-store'
import { scheduleStatus } from './backup/schedule'
import { loadConsolidated } from './consolidate'
import { centralRuntimeChoices, centralStartPlan, runCentral, type CentralStartPlan } from './cli-central'
import { flagFor, type CentralRuntimeId, type CentralRuntimeOption } from './central-runtime'
import { onOutputLine, publishLines, streamCommand } from './cli-stream'
import {
  centralRebuildArgs,
  composeRebuildCommands,
  rebuildFlags,
  type RebuildFlags,
} from './rebuild-flags'
// The pure line decoder, by its own subpath: `@agentistics/tui/control` pulls in Ink and React, and
// this module is loaded by every `agentop` subcommand.
import { createLineDecoder } from '@agentistics/tui/control/stream'
import { ensureArchiveModeChosen } from './cli-setup'
import { memberConnect, memberLeave } from './cli-member'
import {
  disableAutostart,
  enableAutostart,
  serviceCommandFor,
  unitName,
  type AutostartMode,
} from './autostart'
import { confirm } from './cli-ui'
import { CURRENT_VERSION, getVersionInfo } from './version'
import { cliStrings, type CliLang, type CliStrings } from './cli-i18n'
import { resolveLang } from './cli-lang'
import { scanProcesses } from './live-sessions'
import { resolveBackend } from './sessions'
import { SPAWN_SPECS, planSpawn } from './sessions/spawn-spec'
import { availableHarnesses } from './sessions/harness-available'
import { planTakeover } from './sessions/takeover'
import { findProjects } from './sessions/project-source'
import { candidatePath } from './sessions/project-search'
import { recordedRepo, repoFacts } from './sessions/repo-facts'
import { markFleetPhase, timeFleetPhase } from './sessions/fleet-profile'
// The `SessionView` -> `ControlSession` mapping, extracted so `agentop session ls` draws the same
// rows from the same decision rather than mapping the fleet a second time.
import { toControlSession } from './sessions/control-session'
import { planTaskReopen, taskReopenSucceeded, type TaskReopenPlan } from './sessions/task-reopen'
import { approvalFor, choiceKey, isFreeTextOption} from './sessions/approval-spec'
// Carrying a rename through to the harness. Shared with `agentop session rename` — one gesture, one
// implementation, for the reason `task-reopen.ts` exists.
import { renameInHarness, renameMessage } from './sessions/rename'
import { needsChoice, parseDialogOptions } from './sessions/dialog-choice'
import { liveTranscriptDeps, runTranscriptSearch } from './sessions/transcript-run'
import { rulesFor } from './sessions/attention-rules'
import { planCrashGroup, planFellOffer } from './sessions/crash-group'
import { loadHarnessSessions } from './sessions/harness-sessions'
import { idleServers, isServerCommand } from './idle-servers'
import { planTaskDelete, taskDeleteIsNoop } from './sessions/task-delete'
import { memoryBudget } from './sessions/memory-budget'
import { readMemory, readRss } from './sessions/memory-probe'
// The lock on the door: one conversation, one live session. See `conversation-claim.ts` for the
// measurement that made it necessary, and `live-claims.ts` for the evidence it is allowed to use.
import { conversationHeldBy } from './sessions/conversation-claim'
import { liveConversationHolders } from './sessions/live-claims'
import type { ManagedSession, SpawnPlanError } from './sessions/types'
import {
  addSession, newSessionId, patchSession, readRegistry, removeSession, retireFallenSessions, touchSessions,
} from './sessions/registry'
import { createSessionsPoller, type SessionsPoller, type SessionSnapshot } from './sessions/sessions-host'
import { modeSpecFor } from './sessions/mode-spec'
import { isServerProcess, readServerSnapshot } from './sessions/shared-snapshot'
import { conversationForProcess, forgetConversations, loadConversations } from './sessions/conversations'

export type StartResult = number | 'foreground'

/**
 * How much of the pane to re-read before writing into a session.
 *
 * The same depth the poller captures with, and for the same reason: the approval rules are matched
 * against a frame, and matching them against a shallower one would make a dialog that scrolled its
 * footer just off the top read as no dialog at all — which on this path means typing a sentence into
 * an open menu.
 */
const SEND_CAPTURE_LINES = 60


// ANSI, for the output this module still writes to the REAL terminal: the suspended commands,
// the foreground handover and the non-interactive `agentop restart --all`.
const ESC = '\x1b'
const R = `${ESC}[0m`
const D = `${ESC}[2m`
const CY = `${ESC}[96m`
const GR = `${ESC}[92m`
const YE = `${ESC}[33m`

const CENTRAL_PROJECT = 'team-mode'      // central.sh: PROJECT=${PROJECT:-team-mode}
const MACHINE_IMAGE = 'agentistics-machine' // docker/machine.yml: image
const CENTRAL_FILTER = `label=com.docker.compose.project=${CENTRAL_PROJECT}`
const MACHINE_FILTER = `ancestor=${MACHINE_IMAGE}`

/**
 * Inside a container the app always listens on 47291 — both compose files pin `PORT: 47291`, so the
 * INTERNAL port is a constant even though the published one is the user's choice (APP_PORT).
 * Asking docker which host port that maps to is the only way to state the central's URL without
 * guessing; 48080 is merely the default the wizard offers.
 */
const CONTAINER_APP_PORT = '47291/tcp'
const CENTRAL_DEFAULT_PORT = 48080

const SERVER_LOG = join(homedir(), '.agentistics', 'agentop-server.log')

// shell helpers
async function sh(cmd: string[]): Promise<{ code: number; out: string }> {
  try {
    const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(p.stdout).text()
    return { code: await p.exited, out: out.trim() }
  } catch {
    return { code: 127, out: '' }
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// language
// resolveLang lives in cli-lang.ts so `agentop tui` resolves the language identically.

// state + detection
type Mode = 'solo' | 'central' | 'member'

/**
 * `connections` is the authority; `endpoint` is only the legacy MIRROR of `connections[0]` that
 * `normalizeTeamConfig` keeps writing for downgrades. Every member-mode decision below reads the
 * array, because the mirror cannot answer "how many centrals" — and a control center that answers
 * that question with one endpoint out of three is the same misreport `agentop status` was fixed
 * for.
 */
async function loadState(): Promise<{
  mode: Mode; endpoint?: string; connections: TeamConnection[]; mouse: boolean; sessionPollMs: number
}> {
  try {
    const prefs = await readPreferences()
    // Mouse ON unless the preference says otherwise — the default the control center assumes, and
    // the one an unreadable preferences file falls back to below. It is the reachable-by-default
    // half of the setting; `m` in the app is how it is turned off, and it is written back here.
    return {
      mode: prefs.team?.mode ?? 'solo',
      endpoint: prefs.team?.endpoint,
      connections: prefs.team?.connections ?? [],
      mouse: prefs.mouse !== false,
      sessionPollMs: sessionPollMsOrDefault(prefs),
    }
  } catch {
    return { mode: 'solo', connections: [], mouse: true, sessionPollMs: SESSION_POLL_DEFAULT_MS }
  }
}

/**
 * Which runtimes are up, by runtime id.
 *
 * A RUNTIME, not a service: `local` and `machine` are two ways of running the ONE logical service
 * the user calls "agentistics", and the whole point of the logical model is that this map is the
 * host's business and never reaches the screen as three rows.
 */
type RuntimeUp = Record<RuntimeId, boolean>

/**
 * The runtimes each target names, most-preferred first.
 *
 * One total record rather than a lookup with a fallback, so the compiler is the thing that notices
 * a new runtime or a new service — and so a logical target and a runtime target resolve through
 * exactly the same table. `central` appears on both sides because the central has a single runtime:
 * naming the service and naming its runtime are the same instruction.
 */
export const TARGET_RUNTIMES: Record<ServiceRef, readonly RuntimeId[]> = {
  agentistics: ['local', 'machine'],
  central: ['central'],
  local: ['local'],
  machine: ['machine'],
}

/** Canonical order, used wherever a set of runtimes has to be listed or acted on in sequence. */
export const RUNTIME_ORDER: readonly RuntimeId[] = ['local', 'machine', 'central']

/**
 * The runtimes an action target names, restricted to the ones actually RUNNING.
 *
 * This is where a logical target becomes something to act on: `stop('agentistics')` means "stop
 * whichever way it happens to be running", which is one runtime normally and two in the conflict
 * case — and nothing at all when it is already down, which the caller reports rather than
 * pretending it stopped something.
 */
export function targetRuntimes(target: ActionTarget, up: readonly RuntimeId[]): RuntimeId[] {
  const named = target === 'all' ? RUNTIME_ORDER : TARGET_RUNTIMES[target]
  return named.filter(id => up.includes(id))
}

/**
 * The runtime whose log a source names.
 *
 * A logical source reads whichever runtime is up; with none up it falls back to the service's
 * primary runtime, because the most useful log of a server that is NOT running is the file the last
 * one left behind. A runtime source resolves to itself, which is what the full-screen Logs screen's
 * selector needs in order to read a container the cockpit does not have selected.
 */
export function logRuntime(source: LogSource, up: readonly RuntimeId[]): RuntimeId {
  const candidates = TARGET_RUNTIMES[source]
  return candidates.find(id => up.includes(id)) ?? candidates[0]!
}

/**
 * A logical service's state, from the states of its runtimes.
 *
 * `up` if any runtime is up. Otherwise `unknown` if an AVAILABLE runtime could not be probed — the
 * old "never assume down" rule, scoped so it cannot spread: a container runtime on a box without
 * docker is not undetectable, it is impossible, so it must not make the whole service read as
 * unknown on every machine that has no docker installed. Only when every runtime that could be
 * running is confidently down is the service down.
 */
export function aggregateState(
  runtimes: readonly Pick<ServiceRuntimeState, 'state' | 'available' | 'reason'>[],
): { state: ServiceState; reason?: string } {
  if (runtimes.some(r => r.state === 'up')) return { state: 'up' }
  const blind = runtimes.find(r => r.available && r.state === 'unknown')
  return blind ? { state: 'unknown', reason: blind.reason } : { state: 'down' }
}

/**
 * Facts `startOptionsFor` needs beyond the runtime id and the strings — everything a caller can
 * only learn by asking this box, never by looking at the runtime's name.
 */
export interface StartFacts {
  /**
   * Which shape `central up` would take here — see `planCentralStart` in cli-central.ts. `native`
   * is the ONLY state that offers a native start at all: it means an external (non-bundled) Mongo
   * is configured and this is the standalone (no-repo) path, which is the one case
   * `runCentral`/`runNativeCentral` can run the binary directly instead of Docker. Every other
   * value (including `undefined`, before a plan was ever computed) keeps the Docker-only option
   * this screen has always offered — a native option that could not actually reach a database
   * would be a verb that fails on principle.
   */
  centralPlan?: CentralStartPlan
  /**
   * Every way a central could be brought up here, available or not — `centralRuntimeOptions`.
   *
   * When present it REPLACES the `centralPlan` inference for the central's start verbs: the screen
   * offers one start per available shape instead of the single "Start" whose meaning was decided
   * by whatever happened to be on disk. `centralPlan` stays, because it answers a different
   * question that has not changed — whether the start needs the real terminal.
   */
  centralRuntimes?: CentralRuntimeOption[]
}

/**
 * The starts a single runtime offers.
 *
 * Each option carries what must happen AROUND it — the port it contends for, whether the archive
 * consent applies, whether it is worth bringing back on boot. Those are facts about this box and
 * this product, so they are stated here with the option rather than re-derived from the runtime id
 * by the screen drawing it: a UI that knows `local` is the runtime with a port is a UI holding a
 * piece of the model.
 *
 * `offersBoot` is never set on a foreground option, for any runtime: a foreground process holds
 * the terminal (or, for Docker, blocks it under `suspend` until Ctrl-C), so "start it at boot" is
 * not a thing it can be — that question only makes sense for something that is going to keep
 * running after this command returns.
 */
export function startOptionsFor(runtime: RuntimeId, s: CliStrings, facts: StartFacts = {}): StartOption[] {
  switch (runtime) {
    case 'local':
      return [
        {
          runtime: 'local', how: 'fg', label: s.optForeground, hint: s.optForegroundHint,
          // The foreground path hands the terminal back to `runStart()`, which clears the port and
          // asks the gate itself; the flags describe the start either way.
          blockedBy: 'local', asksArchive: true,
        },
        {
          runtime: 'local', how: 'bg', label: s.optBackground, hint: s.optBackgroundHint,
          blockedBy: 'local', asksArchive: true, offersBoot: true,
        },
      ]
    case 'machine':
      return [
        {
          // Foreground here means genuinely attached — `docker compose up --build` without `-d`,
          // run under `suspend()` exactly like `central.sh init`: it needs the real tty because
          // Ctrl-C is how you stop it, not because it asks a question. No `offersBoot`: it never
          // returns until you interrupt it. No `asksArchive` either — a container start never has
          // (see the field's own doc): the gate belongs to the process writing to ~/.agentistics,
          // which here is the containerized server, not this CLI.
          runtime: 'machine', how: 'fg', label: s.optDockerForeground, hint: s.optDockerForegroundHint,
          blockedBy: 'local',
        },
        {
          runtime: 'machine', how: 'bg', label: s.optDockerBackground, hint: s.optDockerBackgroundHint,
          blockedBy: 'local',
          // Honoured by the systemd `agentop-machine` unit (`docker compose … up -d`) — a genuinely
          // separate mechanism from the native `agentop-server` unit `local` uses, so `enableBoot`
          // is told which runtime asked (see `ControlHost.enableBoot`).
          offersBoot: true,
        },
      ]
    case 'central': {
      // The shapes this box can actually bring up, each its own verb. A central has three, they
      // are genuinely different deployments, and the screen used to show one "Start" that picked
      // between them by inference — so a user holding a checkout could not ask for the published
      // image, and nothing said why the option they expected was missing.
      const runtimes = facts.centralRuntimes?.filter(r => r.available).map(r => r.id)
      if (runtimes && runtimes.length > 0) {
        return runtimes.flatMap(id => centralStartsFor(id, s))
      }

      // No runtime list supplied (a caller that predates it, or a status read that failed): keep
      // exactly the behaviour that existed before, decided by `centralPlan`.
      if (facts.centralPlan === 'native') return centralStartsFor('native', s)
      return [
        {
          runtime: 'central', how: 'bg', label: s.optCentral, hint: s.optCentralHint, offersBoot: true,
        },
      ]
    }
  }
}

/**
 * The starts ONE central shape offers.
 *
 * Only the native one has two, and the asymmetry is real rather than an omission: `docker compose
 * up -d` returns once the container is up, so there is no attached variant to offer, while the
 * native server holds the terminal until you stop it and therefore has both shapes.
 *
 * `offersBoot` follows the same rule it does everywhere — never on a foreground option, and only
 * where a boot mechanism genuinely exists for what was started. Both Docker shapes register the
 * `agentop-central` unit; the native background start now does too, because `serviceCommandFor`
 * composes the unit from the SAME configured runtime rather than always writing the Docker one.
 */
function centralStartsFor(id: CentralRuntimeId, s: CliStrings): StartOption[] {
  switch (id) {
    case 'docker-image':
      return [{
        runtime: 'central', centralRuntime: 'docker-image', how: 'bg',
        label: s.optCentralImage, hint: s.optCentralImageHint, offersBoot: true,
      }]
    case 'docker-build':
      return [{
        runtime: 'central', centralRuntime: 'docker-build', how: 'bg',
        label: s.optCentralBuild, hint: s.optCentralBuildHint, offersBoot: true,
      }]
    case 'native':
      return [
        {
          runtime: 'central', centralRuntime: 'native', how: 'fg',
          label: s.optCentralNativeForeground, hint: s.optCentralNativeForegroundHint,
        },
        {
          runtime: 'central', centralRuntime: 'native', how: 'bg',
          label: s.optCentralNativeBackground, hint: s.optCentralNativeBackgroundHint,
          offersBoot: true,
        },
      ]
  }
}

/**
 * PURE: the sentences naming the central shapes this box CANNOT start, and why.
 *
 * The verbs stay absent — a control that fails on principle is worse than a missing one — but an
 * absence with no explanation reads as a broken screen. This is the other half: said once, in the
 * detail pane, where a sentence fits.
 */
export function centralStartNotes(runtimes: CentralRuntimeOption[] | undefined, s: CliStrings): string[] {
  if (!runtimes) return []
  const notes: string[] = []
  for (const r of runtimes) {
    if (r.available || !r.reason) continue
    if (r.id === 'docker-image' && r.reason === 'no-docker') notes.push(s.centralBlockedImageNoDocker)
    else if (r.id === 'docker-build' && r.reason === 'no-docker') notes.push(s.centralBlockedBuildNoDocker)
    else if (r.id === 'docker-build' && r.reason === 'no-checkout') notes.push(s.centralBlockedBuildNoCheckout)
    else if (r.id === 'native' && r.reason === 'bundled-mongo') notes.push(s.centralBlockedNativeBundled)
    else if (r.id === 'native' && r.reason === 'no-env') notes.push(s.centralBlockedNativeNoEnv)
    else notes.push(`${flagFor(r.id)}: ${r.reason}`)
  }
  return notes
}

/**
 * Which runtimes this box could REBUILD, keyed by runtime.
 *
 * Absent or false means the pieces are not here — no repo checkout for `bun run bin`, no compose
 * file for the machine image — and the option is then not offered at all. A rebuild that could not
 * work is worse than a missing one: it is a verb that fails on principle, and the user pressed it
 * because the screen said they could.
 */
export type RebuildAbility = Partial<Record<RuntimeId, boolean>>

/**
 * The restarts a RUNNING service offers: the plain bounce, plus a rebuild per runtime that can.
 *
 * PURE, and the mirror of `startOptionsFor` — including the reason it is here rather than in the
 * screen: what a rebuild MEANS is per runtime (recompile the binary, rebuild the image, go through
 * the central's own `up`) and whether it can happen at all is a fact about this box.
 *
 * In a CONFLICT each copy is rebuilt on its own, exactly as it is stopped on its own: "rebuild it"
 * has no single meaning while the same program is running twice, and rebuilding both would leave
 * the conflict standing.
 */
function restartOptionsFor(
  id: ServiceId,
  up: readonly ServiceRuntimeState[],
  s: CliStrings,
  can: RebuildAbility,
): RestartOption[] {
  const out: RestartOption[] = [
    { target: id, rebuild: false, label: s.optRestart, hint: s.optRestartHint },
  ]
  const named = up.length > 1
  for (const runtime of up) {
    if (!can[runtime.id]) continue
    out.push({
      target: named ? runtime.id : id,
      rebuild: true,
      label: named ? s.optRebuildRuntime(runtime.kind) : s.optRebuild,
      hint: runtime.kind === 'native' ? s.optRebuildNativeHint : s.optRebuildDockerHint,
    })
  }
  return out
}

/**
 * One way a service can be registered to come back, as this box currently finds it.
 *
 * A mechanism is a systemd USER UNIT, and `agentistics` has two of them — `agentop-server` runs the
 * binary, `agentop-machine` runs `docker compose … up -d` — which is exactly why the boot switch
 * cannot be one flag on the service: turning "boot" off for a machine that registered the container
 * would have removed the native unit and left the container coming back.
 */
export interface BootMechanism {
  /** The full unit name, e.g. `agentop-central.service`. NAMED in every sentence it produces. */
  unit: string
  /** Which runtime it brings back, handed straight back to `enableBoot`/`disableBoot`. */
  runtime?: RuntimeId
  /** The word that distinguishes it on a verb (`native`, `docker`), or '' when there is only one. */
  mech: string
  /** Registered right now. The ONLY thing that decides whether the verb is "on" or "off". */
  on: boolean
  /**
   * Whether the unit could be WRITTEN here — its `ExecStart` needs a file that only a repo checkout
   * has (`central.sh`, `docker/machine.yml`). False means no enable verb is offered, rather
   * than one that writes a unit systemd would then restart every five seconds forever.
   */
  installable: boolean
}

/**
 * The boot verbs a service offers — PURE, one per mechanism, and never both positions of the same
 * switch.
 *
 * `supported` is the platform answer and it is all-or-nothing: `enableAutostart` writes a systemd
 * user unit and macOS/Windows are not wired up at all, so there the list is EMPTY. That is the same
 * absence-is-absence rule `ControlService.boot` follows — a verb that refuses on principle is worse
 * than a missing one, and the detail pane is already silent about boot on those platforms.
 */
export function bootOptionsFor(
  mechs: readonly BootMechanism[],
  s: CliStrings,
  supported: boolean,
  /** The service's own name, for the sentence asked right after a stop. */
  serviceLabel = '',
): BootOption[] {
  if (!supported) return []
  const out: BootOption[] = []
  for (const m of mechs) {
    if (m.on) {
      out.push({
        runtime: m.runtime,
        enable: false,
        label: s.optBootOff(m.mech),
        hint: s.optBootOffHint,
        confirm: s.bootConfirmOff(m.unit),
        confirmAfterStop: s.bootAfterStop(serviceLabel, m.unit),
      })
      continue
    }
    if (!m.installable) continue
    out.push({
      runtime: m.runtime,
      enable: true,
      label: s.optBootOn(m.mech),
      hint: s.optBootOnHint,
      confirm: s.bootConfirmOn(m.unit),
    })
  }
  return out
}

/**
 * Which autostart MODE a boot verb on this service means — PURE, and shared by both halves of the
 * switch so `enableBoot` and `disableBoot` can never resolve the same press differently.
 *
 * `agentistics` boots as the native server by default: the verb offered while nothing is running
 * has always meant that. `runtime: 'machine'` is the ONE case that means something else — the
 * container's unit runs `docker compose … up -d`, so writing (or removing) a native unit there
 * would act on a mechanism that does not match what the user pointed at. `central` has exactly one
 * mechanism regardless of `runtime`.
 */
export function bootModeFor(service: ServiceId, runtime?: RuntimeId): AutostartMode {
  if (service === 'central') return 'central'
  return runtime === 'machine' ? 'machine' : 'server'
}

/**
 * One logical service, assembled from the runtimes it could be running under.
 *
 * PURE — states and strings in, the value the screen draws out — because every judgement worth
 * getting right is in here: that a running service offers NO start (which is the whole answer to
 * "it offered to start a docker copy while one was already running"), that a service with two
 * runtimes up says so instead of showing one of them, and that a stopped service still gets a row
 * with the starts this box can actually perform.
 */
export function buildService(
  id: ServiceId,
  label: string,
  runtimes: ServiceRuntimeState[],
  s: CliStrings,
  /**
   * What only a probe of this box can answer. Optional and absent by default, so a caller that
   * cannot ask — or a platform with no user systemd — produces a service that says nothing about
   * boot rather than one that says "no", and offers no rebuild rather than one that cannot work.
   */
  facts: {
    boot?: BootState
    /** The unit `boot` is describing. Carried so the pane can NAME what brings the service back. */
    bootUnit?: string
    /** Every registration this box can change. Empty on a platform with no user systemd. */
    bootOptions?: BootOption[]
    rebuild?: RebuildAbility
    centralPlan?: CentralStartPlan
    centralRuntimes?: CentralRuntimeOption[]
    /** Pids of extra copies of this service that hold no port — see `idle-servers.ts`. */
    idlePids?: number[]
  } = {},
): ControlService {
  const up = runtimes.filter(r => r.state === 'up')
  const { state, reason } = aggregateState(runtimes)
  return {
    id,
    label,
    state,
    runtimes,
    running: up.map(r => r.id),
    active: up[0],
    boot: facts.boot,
    // Only ever beside a state: a unit name under no state would be a fact about a question nobody
    // could answer.
    bootUnit: facts.boot ? facts.bootUnit : undefined,
    bootOptions: facts.bootOptions ?? [],
    // Named, not merely coloured, and never reduced to whichever copy we happened to find first.
    conflict: up.length > 1 ? s.svcConflict(up.map(r => r.kind)) : undefined,
    // Two processes of the ONE runtime — invisible to every runtime probe, because they all ask
    // which pid holds the port. See `idle-servers.ts` for the seventy-minute incident.
    idle: facts.idlePids?.length ? s.svcIdleServer(facts.idlePids) : undefined,
    reason,
    // The single most important line in the model: while anything is up there is nothing to start.
    startOptions: up.length > 0
      ? []
      : runtimes.filter(r => r.available).flatMap(r => startOptionsFor(r.id, s, {
          centralPlan: facts.centralPlan,
          centralRuntimes: facts.centralRuntimes,
        })),
    // The other half of "a verb that cannot work is not offered": what was withheld, and why.
    // Only the central has shapes to withhold, so every other row carries nothing here.
    startNotes: id === 'central' ? centralStartNotes(facts.centralRuntimes, s) : undefined,
    // …and its mirror: nothing to restart until something is running.
    restartOptions: up.length > 0 ? restartOptionsFor(id, up, s, facts.rebuild ?? {}) : [],
    stopOptions: up.length > 1
      ? up.map(r => ({ runtime: r.id, label: s.stopRuntime(r.kind) }))
      : [],
  }
}

/**
 * `systemctl --user is-enabled` answers, mapped onto the three things the screen can say.
 *
 * PURE, and deliberately exhaustive on the KNOWN answers only: anything systemd does not recognise
 * — `not-found`, an empty line, an error it printed to stderr, a version that invents a new word —
 * comes back `undefined`, which the detail pane renders as no boot row at all. The one answer this
 * function may never invent is "off", because a user who reads that installs a boot unit they
 * already have.
 */
export function parseBootState(out: string): BootState | undefined {
  const word = out.trim().split('\n')[0]?.trim() ?? ''
  // `linked`/`enabled-runtime` are enabled by another name; `alias` follows its target, so it is
  // only ever reported for a unit that IS installed.
  if (word === 'enabled' || word === 'enabled-runtime' || word === 'linked' || word === 'linked-runtime') return 'on'
  if (word === 'disabled' || word === 'masked' || word === 'masked-runtime') return 'off'
  return undefined
}

/**
 * Does this AUTOSTART MODE come back after a reboot?
 *
 * Only Linux can be asked: `enableAutostart` writes a systemd USER unit, and macOS (launchd) and
 * Windows are not wired up at all — so on those platforms the honest answer is silence, which costs
 * one `platform()` check rather than a subprocess that would fail anyway.
 *
 * Named by MODE rather than by service: `agentistics` now has TWO distinct boot mechanisms
 * (`agentop-server` for the native runtime, `agentop-machine` for the Docker one), and a single
 * `service`-keyed probe could only ever answer for one of them — the same reason `enableBoot` now
 * needs to know which runtime asked.
 */
async function bootState(mode: AutostartMode): Promise<BootState | undefined> {
  if (platform() !== 'linux') return undefined
  const r = await sh(['systemctl', '--user', 'is-enabled', `agentop-${mode}`])
  // systemctl prints the state to stdout even when it exits non-zero, so the code is not the
  // signal — the word is. A missing binary answers 127 with nothing, which parses to `undefined`.
  return parseBootState(r.out)
}

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(600) })
    return res.ok
  } catch {
    return false
  }
}

async function dockerIds(filter: string): Promise<string[]> {
  const r = await sh(['docker', 'ps', '-q', '-f', filter])
  return r.out.split(/\s+/).filter(Boolean)
}

async function detectRuntimes(): Promise<RuntimeUp> {
  const [local, central, machine] = await Promise.all([
    isServerRunning(),
    dockerIds(CENTRAL_FILTER).then((i) => i.length > 0),
    dockerIds(MACHINE_FILTER).then((i) => i.length > 0),
  ])
  return { local, central, machine }
}

/** The running runtimes, in canonical order — the input every target resolution needs. */
async function runningRuntimes(): Promise<RuntimeId[]> {
  const up = await detectRuntimes()
  return RUNTIME_ORDER.filter(id => up[id])
}

/** Is exactly this runtime up? Used where probing all three would be wasted work. */
async function isRuntimeUp(id: RuntimeId): Promise<boolean> {
  if (id === 'local') return isServerRunning()
  return (await dockerIds(id === 'central' ? CENTRAL_FILTER : MACHINE_FILTER)).length > 0
}

/**
 * A container's state, distinguishing "not running" from "we could not tell" from "impossible here".
 *
 * Reporting `down` when docker's daemon is unreachable would be a lie the user then acts on —
 * starting a central that is already up, or believing one stopped. `sh` answers 127 when the binary
 * cannot be spawned at all and a non-zero code when docker itself refused, and those two are NOT
 * the same fact: with no docker installed there is no container to be uncertain about, so the
 * runtime is reported unavailable and stops colouring its service's state (and stops being offered
 * as a start that could not possibly work). With docker present but silent we still know nothing.
 */
async function dockerState(
  filter: string,
  s: CliStrings,
): Promise<{ state: ServiceState; reason?: string; available: boolean }> {
  const r = await sh(['docker', 'ps', '-q', '-f', filter])
  if (r.code === 127) return { state: 'unknown', reason: s.dockerMissing, available: false }
  if (r.code !== 0) return { state: 'unknown', reason: s.dockerUnreachable, available: true }
  return { state: r.out.split(/\s+/).filter(Boolean).length > 0 ? 'up' : 'down', available: true }
}

// stopping

/** Parse `lsof -ti` output into a pid list, dropping blanks and the caller's OWN
 *  pid. The health check (`isServerRunning` → fetch to PORT) leaves a keep-alive
 *  client socket open, so `lsof -ti tcp:PORT` returns the CLI's own pid alongside
 *  the server's — killing the raw list SIGTERM'd the CLI itself before it could
 *  restart the server. */
export function pidsToKill(lsofOut: string, selfPid: number): string[] {
  const self = String(selfPid)
  return lsofOut.split(/\s+/).filter(Boolean).filter((pid) => pid !== self)
}

/**
 * The pids listening on the api port, which is what "the local server" means here.
 *
 * One mechanism, two readers: the stop path kills this list and the control center's detail pane
 * names its first entry. A second way of finding the server would eventually disagree with this
 * one, and then the screen would offer to stop a process it is not showing.
 */
async function listeningServerPids(): Promise<string[]> {
  // `-sTCP:LISTEN` targets only the listening server, never a client connection
  // (e.g. our own health-check socket); pidsToKill drops our pid as a safety net.
  const lsof = await sh(['lsof', '-ti', `tcp:${PORT}`, '-sTCP:LISTEN'])
  return pidsToKill(lsof.out, process.pid)
}

/**
 * Elapsed-seconds output from `ps`, in either spelling it comes in.
 *
 * `-o etimes=` prints whole seconds and is a GNU/procps extension; BSD `ps` (macOS) only knows
 * `-o etime=`, which prints `[[DD-]HH:]MM:SS`. Anything else — an error line, an empty answer from
 * a pid that has just exited — is `undefined`, so the caller reports no uptime instead of a zero.
 */
export function parseElapsedSeconds(out: string): number | undefined {
  const text = out.trim()
  if (/^\d+$/.test(text)) return Number(text)
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text)
  if (!m) return undefined
  const secs = Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0)
  return Number.isFinite(secs) ? secs : undefined
}

/** When a native process started, as epoch ms, or `undefined` when the OS would not say. */
async function processStartedAt(pid: number): Promise<number | undefined> {
  const primary = await sh(['ps', '-o', 'etimes=', '-p', String(pid)])
  let secs = primary.code === 0 ? parseElapsedSeconds(primary.out) : undefined
  if (secs === undefined) {
    const fallback = await sh(['ps', '-o', 'etime=', '-p', String(pid)])
    secs = fallback.code === 0 ? parseElapsedSeconds(fallback.out) : undefined
  }
  // Derived from an elapsed time rather than read directly, so it is accurate to the second — which
  // is a thousand times finer than the coarsest unit any uptime is ever rendered in.
  return secs === undefined ? undefined : Date.now() - secs * 1000
}

/** What `docker inspect` can tell us about a running container, each part independently absent. */
export interface ContainerFacts {
  pid?: number
  startedAt?: number
  /** Host port the container's 47291 is published as; absent under host networking. */
  hostPort?: number
}

/**
 * The one-line inspect template, and its parser.
 *
 * `range` over the port map rather than indexing into it: a template that indexes a key which does
 * not exist FAILS the whole command, and the machine container runs on host networking, so asking
 * for its published port that way would cost us its pid and start time as well.
 */
const INSPECT_FORMAT =
  '{{.State.Pid}}|{{.State.StartedAt}}|{{range $p, $c := .NetworkSettings.Ports}}{{range $c}}{{$p}}={{.HostPort}} {{end}}{{end}}'

export function parseContainerFacts(out: string, containerPort: string = CONTAINER_APP_PORT): ContainerFacts {
  const [rawPid = '', rawStarted = '', rawPorts = ''] = out.trim().split('|')
  const pid = Number(rawPid.trim())
  // A container that is not running inspects as pid 0 and as the zero time `0001-01-01T00:00:00Z`
  // — both are real values that are not facts, so they are filtered rather than rendered.
  const started = Date.parse(rawStarted.trim())
  const mapping = rawPorts.trim().split(/\s+/).find(p => p.startsWith(`${containerPort}=`))
  const hostPort = mapping ? Number(mapping.slice(containerPort.length + 1)) : Number.NaN
  return {
    pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
    startedAt: Number.isFinite(started) && started > 0 ? started : undefined,
    hostPort: Number.isInteger(hostPort) && hostPort > 0 ? hostPort : undefined,
  }
}

/** Inspect the first container matching `filter`. Every failure path yields an empty answer. */
async function containerFacts(filter: string): Promise<ContainerFacts> {
  const ids = await dockerIds(filter)
  const id = ids[0]
  if (!id) return {}
  const r = await sh(['docker', 'inspect', '-f', INSPECT_FORMAT, id])
  if (r.code !== 0) return {}
  return parseContainerFacts(r.out)
}

/**
 * The native server's pid and start time.
 *
 * Only the first listener is named: a second pid on that port means something we did not start is
 * also there, and picking one of several to call "the server" is a guess the detail pane should not
 * be making on the user's behalf. Without lsof there are no pids at all, and both fields stay away.
 */
interface ProcessFacts { pid?: number; startedAt?: number }

async function nativeServerFacts(): Promise<ProcessFacts> {
  const pid = Number((await listeningServerPids())[0])
  if (!Number.isInteger(pid) || pid <= 0) return {}
  return { pid, startedAt: await processStartedAt(pid) }
}

/**
 * Server processes that hold NO port — the copies every runtime probe is blind to.
 *
 * `lsof -sTCP:LISTEN` can only ever find the process that won the port, so a second server is
 * invisible to `nativeServerFacts` by construction while it burns a core on the file watcher. This
 * asks the process table instead and subtracts the listener and ourselves.
 *
 * Empty on any failure, including a platform with no `ps`: an unreadable process table is "cannot
 * tell", and a warning invented out of one would appear on machines nobody could ask.
 */
async function idleServerPids(): Promise<number[]> {
  try {
    const ps = await sh(['ps', '-eo', 'pid=,args='])
    const processes = ps.out.split('\n')
      .map(line => /^\s*(\d+)\s+(.*)$/.exec(line.trim()))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => ({ pid: Number(m[1]), command: m[2]! }))
      .filter(p => isServerCommand(p.command))
    const listening = (await listeningServerPids()).map(Number).filter(n => Number.isInteger(n) && n > 0)
    return idleServers({ processes, listening, self: process.pid }).idle.map(p => p.pid)
  } catch {
    return []
  }
}

async function stopLocal(s: CliStrings): Promise<void> {
  process.stdout.write(`  ${D}${s.stoppingLocal}${R}\n`)
  const pids = await listeningServerPids()
  if (pids.length) { for (const pid of pids) await sh(['kill', pid]) }
  else await sh(['pkill', '-f', 'agentop server'])
  for (let i = 0; i < 20; i++) { if (!(await isServerRunning())) return; await sleep(150) }
}

async function stopContainers(filter: string, msg: string): Promise<void> {
  const ids = await dockerIds(filter)
  if (!ids.length) return
  process.stdout.write(`  ${D}${msg}${R}\n`)
  await sh(['docker', 'stop', ...ids])
}

// run methods
function serverReinvocation(): string {
  const script = process.argv[1]
  const fromSource = !!script && (script.endsWith('.ts') || script.endsWith('.js'))
  return fromSource ? `"${process.execPath}" "${script}" server` : `"${process.execPath}" server`
}

/** Detach a server into the background. Silent: the caller is the one that knows whether it may
 *  print (the control center reports through the status line instead). Returns the log path. */
function startBackground(): string {
  const child = spawn('sh', ['-c', `nohup ${serverReinvocation()} >> "${SERVER_LOG}" 2>&1 &`], { stdio: 'ignore', detached: true })
  child.unref()
  return SERVER_LOG
}

/** The machine container's compose file, which only exists inside a repo checkout. */
function machineComposePath(): string {
  return join(process.cwd(), 'docker', 'machine.yml')
}

/**
 * Build + start the machine container, STREAMED into the control center's pane.
 *
 * It used to run suspended, with the child inheriting the real tty and `tty()` writing the lines
 * around it past the mute a suspension installs. Now the child is piped and these lines are plain
 * `process.stdout` writes: the caller runs this inside `streamOutput`, which diverts them onto the
 * output channel, so the whole thing — the notice, the build, the addresses — arrives as pane lines
 * in the order they were said, and the screen never has to be given up.
 */
async function startDocker(s: CliStrings): Promise<number> {
  const compose = machineComposePath()
  if (!(await Bun.file(compose).exists())) {
    // Diverted like everything else here, so the REASON lands in the pane rather than in a status
    // line that has room for one sentence.
    process.stderr.write(`  ${YE}${s.noComposeFrom(process.cwd())}${R}\n  ${s.runFromRepo}\n`)
    return 1
  }
  process.stdout.write(`  ${D}${s.buildingMachine}${R}\n`)
  const code = await streamCommand(['docker', 'compose', '-f', compose, 'up', '-d', '--build'])
  if (code === 0) {
    process.stdout.write(
      `\n  ${GR}${s.containerUp}${R}\n` +
      `  ${D}${s.webLabel}:${R}  ${CY}http://localhost:${WEB_PORT}${R}\n` +
      `  ${D}${s.bootLabel}:${R} ${s.bootNote}\n`,
    )
  }
  return code
}

/**
 * Build + start the machine container ATTACHED — `docker compose up --build` with no `-d`, so this
 * terminal streams its logs directly and Ctrl-C stops the container (the standard, unsurprising
 * meaning of "run it in the foreground" for a compose service).
 *
 * Run under `suspend()`, the same wrapper `central.sh init` uses: not because this asks a question,
 * but because it needs the REAL tty for the same reason a question does — Ctrl-C has to reach the
 * child, which a piped/streamed child (Ink still owns the keyboard) cannot receive. `tty()` is used
 * for the notices around it because `suspend()` mutes `process.stdout.write`; the child's own
 * output bypasses that mute entirely by inheriting the real fd.
 */
async function startDockerForeground(s: CliStrings): Promise<number> {
  const compose = machineComposePath()
  if (!(await Bun.file(compose).exists())) {
    tty(`\n  ${YE}${s.noComposeFrom(process.cwd())}${R}\n  ${s.runFromRepo}\n`)
    return 1
  }
  tty(`\n  ${D}${s.buildingMachine}${R}\n`)
  return new Promise<number>(resolve => {
    const child = spawn('docker', ['compose', '-f', compose, 'up', '--build'], { stdio: 'inherit' })
    child.on('exit', c => resolve(c ?? 1))
    child.on('error', () => resolve(1))
  })
}

/**
 * The "a server is already running — kill it?" gate, for the FOREGROUND handover.
 *
 * Foreground is the one path that still runs on the real terminal (the control center has exited
 * by then), so the confirmation is asked the way it always was. The background path asks the same
 * question inside the control center, as an Ink prompt, and calls `stop('local')` on a yes.
 */
async function clearPortOrAbort(s: CliStrings, localRunning: boolean): Promise<boolean> {
  if (!localRunning) return true
  process.stdout.write(`\n  ${YE}${s.alreadyRunning(`${CY}http://localhost:${WEB_PORT}${R}${YE}`)}${R}\n`)
  if (!(await confirm(s.confirmKill, false))) {
    process.stdout.write(`  ${D}${s.leftRunning}${R}\n`)
    return false
  }
  await stopLocal(s)
  return true
}

// restart (per-service helpers)
// `rebuild` (from `--rebuild`, or from a `RestartOption` the control center offered) makes a NEW
// build before bouncing: the native binary is recompiled, a Docker image is rebuilt and recreated.
/**
 * Is this a repo checkout? The one thing the native rebuild cannot do without.
 *
 * Asked in two places — before OFFERING the rebuild (`RebuildAbility`) and before running it — and
 * they have to agree, so there is one function rather than two copies of the same path.
 */
export async function inRepoCheckout(): Promise<boolean> {
  return Bun.file(join(process.cwd(), 'packages/server/bin/cli.ts')).exists()
}

/** How a rebuild is allowed to talk: the user's terminal, or the control center's output channel. */
export interface RunMode {
  /** Pipe every child and publish its output as pane lines instead of inheriting the terminal. */
  stream?: boolean
}

/** Rebuild + reinstall the native binary from the repo (`bun run bin`: web build → embed assets →
 *  compile → install to ~/.local/bin/agentop). Returns 'not-repo' when not run from a checkout. */
export async function rebuildNativeBinary(mode: RunMode = {}): Promise<'built' | 'not-repo' | 'failed'> {
  if (!(await inRepoCheckout())) return 'not-repo'
  // Inside the control center the build is watched in a pane, so its output is piped; from the
  // plain `agentop restart --rebuild` it belongs on the terminal the user is looking at.
  const code = mode.stream
    ? await streamCommand(['bun', 'run', 'bin'], { cwd: process.cwd() })
    : await new Promise<number>(resolve => {
        const child = spawn('bun', ['run', 'bin'], { cwd: process.cwd(), stdio: 'inherit' })
        child.on('exit', c => resolve(c ?? 1))
      })
  return code === 0 ? 'built' : 'failed'
}

/** What a restart is doing, and how it is allowed to talk. */
interface RestartMode extends RunMode {
  rebuild?: boolean
  /** What the user said about the setup prompt and the Docker cache (`rebuild-flags.ts`). */
  flags?: RebuildFlags
}

/** Returns whether the local server actually came back up. `startBackground` is fire-and-forget
 *  by design (it detaches and returns immediately) — without polling the health endpoint here, a
 *  freshly (re)compiled binary that crashes on boot, or a port still held by the process just
 *  killed, was reported as a successful restart with nothing left listening. */
async function restartLocalSvc(s: CliStrings, mode: RestartMode = {}): Promise<boolean> {
  // With a rebuild, actually rebuild the native binary (web + embedded assets) so the restart
  // serves the new frontend/code — not just bounce the old build. Needs the repo checkout.
  if (mode.rebuild) {
    process.stdout.write(`  ${D}${s.rebuildingLocal}${R}\n`)
    const r = await rebuildNativeBinary(mode)
    if (r === 'not-repo') process.stderr.write(`  ${YE}${s.localRebuildHint}${R}\n`)
    else if (r === 'failed') process.stderr.write(`  ${YE}${s.localRebuildFailed}${R}\n`)
  }
  process.stdout.write(`  ${D}${s.restartingLocal}${R}\n`)
  await stopLocal(s)
  const log = startBackground()
  // A fresh compile + boot can take longer than the plain bounce this loop also covers, so it
  // gets more headroom than `stopLocal`'s symmetric wait-for-down loop (20 * 150ms).
  let up = false
  for (let i = 0; i < 40; i++) {
    if (await isServerRunning()) { up = true; break }
    await sleep(250)
  }
  if (!up) {
    process.stderr.write(`  ${YE}${s.localStartFailed}${R}\n`)
    return false
  }
  // `agentop restart --all` is a plain CLI command with no screen to report into, and it is the one
  // caller of this that the user is watching. `startBackground` fell silent when the control center
  // took it over — which left that command saying "restarted" and never where the server now is or
  // where its output went. Inside the control center these lines are swallowed by `captureOutput`
  // or by the suspension, so saying them costs the alternate screen nothing.
  process.stdout.write(
    `  ${D}${s.webLabel}:${R}  ${CY}http://localhost:${WEB_PORT}${R}\n` +
    `  ${D}${s.logsLabel}:${R} ${log}\n`,
  )
  return true
}
/** Returns whether the central actually came back up — a non-zero exit here means the old
 *  container (or none at all) is what's left running, and that must never be reported as a
 *  restart that happened. */
async function restartCentralSvc(s: CliStrings, mode: RestartMode = {}): Promise<boolean> {
  process.stdout.write(`  ${D}${mode.rebuild ? s.rebuildingCentral : s.restartingCentral}${R}\n`)
  // `up` rebuilds/pulls the image and recreates; `restart` just bounces the running container.
  // A rebuild states its answer to central.sh's setup prompt rather than relying on a piped child
  // happening to fail `[ -t 0 ]`, and rebuilds from scratch unless `--cache` was asked for.
  let code: number
  if (!mode.rebuild) {
    code = await runCentral('restart', [], { streamed: mode.stream })
  } else {
    const flags = rebuildFlags(mode.flags ?? {})
    if (flags.cache === 'fresh') process.stdout.write(`  ${D}${s.rebuildNoCache}${R}\n`)
    code = await runCentral('up', centralRebuildArgs(mode.flags ?? {}, { streamed: mode.stream }), {
      streamed: mode.stream,
    })
  }
  if (code !== 0) process.stderr.write(`  ${YE}${s.centralFailed}${R}\n`)
  return code === 0
}
/** Same contract as {@link restartCentralSvc}: false means the machine container did NOT end up
 *  running the new build (or running at all), and the caller must say so rather than "restarted". */
async function restartMachineSvc(s: CliStrings, mode: RestartMode = {}): Promise<boolean> {
  process.stdout.write(`  ${D}${mode.rebuild ? s.rebuildingMachine : s.restartingMachine}${R}\n`)
  if (mode.rebuild) {
    const compose = machineComposePath()
    if (await Bun.file(compose).exists()) {
      const flags = rebuildFlags(mode.flags ?? {})
      if (flags.cache === 'fresh') process.stdout.write(`  ${D}${s.rebuildNoCache}${R}\n`)
      // A cacheless rebuild is `build --no-cache` THEN `up` — compose's `up` has no --no-cache.
      // A failed build stops there: recreating on top of it would serve the OLD image while
      // reporting a rebuild. Every command in the sequence must exit 0, or this never happened.
      let ok = true
      for (const cmd of composeRebuildCommands(compose, flags)) {
        const code = mode.stream
          ? await streamCommand(cmd)
          : await new Promise<number>(resolve => {
              const child = spawn(cmd[0]!, cmd.slice(1), { stdio: 'inherit' })
              child.on('exit', c => resolve(c ?? 1))
            })
        if (code !== 0) { ok = false; break }
      }
      if (!ok) process.stderr.write(`  ${YE}${s.dockerStartFailed}${R}\n`)
      return ok
    }
    process.stderr.write(`  ${YE}${s.noComposeFrom(process.cwd())}${R}\n`)
    // fall through to a plain restart so the machine still comes back up
  }
  const ids = await dockerIds(MACHINE_FILTER)
  if (!ids.length) {
    process.stderr.write(`  ${YE}${s.dockerStartFailed}${R}\n`)
    return false
  }
  const { code } = await sh(['docker', 'restart', ...ids])
  if (code !== 0) process.stderr.write(`  ${YE}${s.dockerStartFailed}${R}\n`)
  return code === 0
}

/** Bounce exactly these runtimes. `rebuild` makes a new build first; `stream` pipes every child.
 *  Returns whether every targeted runtime actually came back up — a rebuild whose docker command
 *  failed leaves the old (or no) container running, and that is never a success. */
async function restartRuntimes(
  s: CliStrings,
  targets: readonly RuntimeId[],
  mode: RestartMode = {},
): Promise<boolean> {
  let ok = true
  if (targets.includes('local')) ok = (await restartLocalSvc(s, mode)) && ok
  if (targets.includes('central')) ok = (await restartCentralSvc(s, mode)) && ok
  if (targets.includes('machine')) ok = (await restartMachineSvc(s, mode)) && ok
  return ok
}

/** Non-interactive `agentop restart --all [--rebuild]`: bounce (or rebuild) every running
 *  runtime. Returns an exit code. */
/**
 * Restart the NATIVE server (`agentop restart server [--rebuild]`), whatever way it was started.
 *
 * `restartAutostart` knows exactly one way for a server to be running: a systemd user unit. But
 * the control center — and `agentop server --bg` — start a DETACHED process instead, which is the
 * common case and the one this tool sets up by default. Against that server, `restart` reported
 * "no agentop-server service is installed … install autostart first": it named the thing it could
 * not find rather than the running process it was asked to bounce, and then did nothing at all.
 * With --rebuild that is worse than nothing, because the rebuild HAD already happened and the
 * old build kept serving.
 *
 * So the way it is running decides: a unit is restarted through systemd (which is what keeps it
 * supervised), a detached process is stopped and started again — the same `restartLocalSvc` the
 * cockpit uses — and a server that is not running at all is reported as such instead of being
 * silently "restarted".
 */
export async function restartNativeServer(
  rebuild = false,
  flags: RebuildFlags = {},
): Promise<{ ok: boolean; message: string }> {
  const s = cliStrings(await resolveLang())
  const { unitInstalled, restartAutostart } = await import('./autostart')
  if (await unitInstalled('server')) {
    if (rebuild) {
      const r = await rebuildNativeBinary()
      if (r === 'not-repo') return { ok: false, message: s.localRebuildHint }
      if (r === 'failed') return { ok: false, message: s.localRebuildFailed }
    }
    return restartAutostart('server')
  }
  if (!(await isRuntimeUp('local'))) {
    return { ok: false, message: s.nothingRunning }
  }
  const ok = await restartLocalSvc(s, { rebuild, flags })
  return ok ? { ok: true, message: s.restartedDone } : { ok: false, message: s.localStartFailed }
}

export async function restartAllServices(rebuild = false, flags: RebuildFlags = {}): Promise<number> {
  const s = cliStrings(await resolveLang())
  const targets = await runningRuntimes()
  if (targets.length === 0) {
    process.stdout.write(`  ${D}○ ${s.nothingRunning}${R}\n`)
    return 0
  }
  // No stream: this is a plain command on the user's own terminal, and inherited output is right.
  const ok = await restartRuntimes(s, targets, { rebuild, flags })
  process.stdout.write(ok ? `\n  ${GR}${s.restartedAll}${R}\n` : `\n  ${YE}${s.restartFailed}${R}\n`)
  return ok ? 0 : 1
}

// ---------------------------------------------------------------------------
// Talking to the terminal while Ink owns it
// ---------------------------------------------------------------------------

/**
 * Run `fn` with process stdout/stderr handed to `sink` instead of the terminal.
 *
 * The one mechanism behind both of the ways an action's prints are dealt with: `captureOutput`
 * collects them into a string, `streamOutput` turns them into pane lines. Both streams go to the
 * same sink — the action modules interleave them (a note on stdout, a warning on stderr) and reading
 * them apart would reorder the story.
 *
 * Always restored, including when `fn` throws: a process left with a patched stdout is a process
 * that has gone silent.
 */
async function divertOutput<T>(sink: (chunk: string) => void, fn: () => Promise<T>): Promise<T> {
  const realOut = process.stdout.write.bind(process.stdout)
  const realErr = process.stderr.write.bind(process.stderr)
  const patched = ((chunk: unknown) => {
    sink(typeof chunk === 'string' ? chunk : String(chunk))
    return true
  }) as typeof process.stdout.write
  process.stdout.write = patched
  process.stderr.write = patched
  try {
    return await fn()
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
}

/**
 * Run `fn` with stdout/stderr diverted into a string.
 *
 * The action modules (`cli-member`, the stop/restart helpers) report by printing, which is right
 * for their own CLI subcommands and fatal inside the alternate screen. Capturing keeps them
 * unchanged and turns their output into something better: the failure message shown in the status
 * line, which is otherwise a generic sentence.
 */
async function captureOutput<T>(fn: () => Promise<T>): Promise<{ value: T; text: string }> {
  const chunks: string[] = []
  const value = await divertOutput(chunk => { chunks.push(chunk) }, fn)
  return { value, text: chunks.join('') }
}

/**
 * Run `fn` with everything it and its children print flowing into the OUTPUT CHANNEL as lines.
 *
 * This is what replaced leaving the alternate screen. Two halves meet here: the children are piped
 * by `streamCommand` / `runCentral({ streamed })` and publish themselves, and the host's own prints
 * — "building & starting the machine container…", the addresses afterwards, a warning about a
 * missing compose file — are diverted through the same decoder, so the pane reads as one story in
 * the order it was told. The decoder is per-scope and flushed at the end, so a note written without
 * a trailing newline still arrives.
 */
async function streamOutput<T>(fn: () => Promise<T>): Promise<T> {
  const decoder = createLineDecoder()
  try {
    return await divertOutput(chunk => publishLines(decoder.push(chunk)), fn)
  } finally {
    publishLines(decoder.flush())
  }
}

/**
 * Write straight to the terminal's own descriptor, past whatever is patched over
 * `process.stdout`. This is how the suspend wrapper and the commands it hosts talk to the user
 * while the JS-level stream is muted.
 */
function tty(text: string): void {
  try { writeSync(1, text) } catch { /* the terminal went away — nothing to say and no one to tell */ }
}

/**
 * Swallow JS-level stdout for the duration.
 *
 * Ink keeps rendering while a command has the tty: its spinner ticks and the frame queued just
 * before we left both arrive after the alternate screen is gone, and an Ink frame is not just
 * text — it erases the lines above itself first, which here means erasing the user's real
 * scrollback. Stderr is deliberately left alone, so a command that fails still says why.
 */
async function muteStdout<T>(fn: () => Promise<T>): Promise<T> {
  const real = process.stdout.write.bind(process.stdout)
  process.stdout.write = (() => true) as typeof process.stdout.write
  try {
    return await fn()
  } finally {
    process.stdout.write = real
  }
}

const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')

/** The most specific thing a captured failure said: its last non-empty line, undecorated. */
function lastLine(text: string): string {
  const lines = text.replace(ANSI_RE, '').split('\n').map(l => l.trim()).filter(Boolean)
  return lines[lines.length - 1] ?? ''
}

/** Only the shape of `altScreen` this module uses — the value arrives by dynamic import. */
interface Suspendable {
  suspend<T>(fn: () => Promise<T>): Promise<T>
}

type Suspend = <T>(fn: () => Promise<T>) => Promise<T>

/** Wait for Enter on a terminal we have just handed back to the user. */
function pauseForEnter(message: string): Promise<void> {
  return new Promise(resolve => {
    tty(`\n  ${D}${message}${R} `)
    const onData = (chunk: Buffer) => {
      const text = chunk.toString()
      if (!text.includes('\n') && !text.includes('\r')) return
      process.stdin.off('data', onData)
      resolve()
    }
    process.stdin.on('data', onData)
    process.stdin.resume()
  })
}

/**
 * Hand the real terminal to `fn`, then pause so its output can be read.
 *
 * RESERVED FOR COMMANDS THAT ASK SOMETHING. Everything whose output was merely worth watching now
 * streams into a pane instead (`streamOutput`), which is the whole point of the change: leaving the
 * alternate screen costs the user their place, and coming back costs them a keypress. What is left
 * on this path is `central.sh init`, which reads answers from the tty and refuses without one — and
 * a prompt streamed into a pane is a question nobody can answer.
 *
 * Leaving the alternate screen is only half of it: Ink is still mounted and still listening on
 * stdin in raw mode, so without detaching its `data` handlers a `q` typed at the paused prompt
 * would quit the app and every keystroke meant for the child would be read as navigation. The
 * handlers are put back exactly as they were, so Ink resumes unaware anything happened.
 */
function makeSuspend(altScreen: Suspendable, strings: () => CliStrings): Suspend {
  return async function suspend<T>(fn: () => Promise<T>): Promise<T> {
    const stdin = process.stdin
    const listeners = stdin.rawListeners('data') as Array<(chunk: Buffer) => void>
    stdin.removeAllListeners('data')
    const wasRaw = stdin.isRaw === true
    if (wasRaw) stdin.setRawMode(false)
    try {
      // The mute goes INSIDE the suspension: leaving and re-entering the alternate screen are
      // themselves stdout writes, and swallowing those would strand the terminal in one buffer.
      return await altScreen.suspend(() => muteStdout(async () => {
        try {
          return await fn()
        } finally {
          await pauseForEnter(strings().pauseMsg)
        }
      }))
    } finally {
      if (wasRaw) stdin.setRawMode(true)
      for (const listener of listeners) stdin.on('data', listener)
    }
  }
}

// ---------------------------------------------------------------------------
// ControlHost — every action the control center can ask for
// ---------------------------------------------------------------------------

/** The host, plus the language it currently speaks (runStart needs it after the app exits). */
export interface StartHost extends ControlHost {
  readonly lang: CliLang
}

/** Neither question the setup wizard asks has an answer yet. Fails closed: unreadable ≠ fresh. */
async function isUnconfigured(): Promise<boolean> {
  try {
    const prefs = await readPreferences()
    return !prefs.team || resolveArchiveMode(prefs) === undefined
  } catch {
    return false
  }
}

async function tailFile(path: string, maxLines: number): Promise<string[]> {
  try {
    const file = Bun.file(path)
    if (!(await file.exists())) return []
    const lines = (await file.text()).split('\n')
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines.slice(-maxLines)
  } catch {
    return []
  }
}

/**
 * Hand the terminal to a session and wait for the user to come back.
 *
 * Printing here is SAFE and everywhere else in this flow is not: the control center has unmounted
 * and left the alternate buffer by the time this runs, so the hint lands on the primary screen where
 * it belongs. The hint itself is the whole reason this is not a bare spawn — a user who cannot get
 * out is stranded in a buffer that hides their shell, and the key is read from the backend rather
 * than assumed, because a tmux prefix the user rebound would make a guessed `Ctrl-b` actively wrong.
 */
let printedDetachHint = false

async function execAttachTicket(ticket: AttachTicket, s: CliStrings): Promise<void> {
  // Printed ONCE per run. Every attach used to announce itself, and tmux adds its own
  // `[detached (from …)]` on the way out, so a session of ordinary use left a wall of the same two
  // lines in the scrollback the control center then drew over. The hint is worth saying; saying it
  // fourteen times is just noise, and the cockpit now carries it permanently anyway.
  if (!printedDetachHint) {
    console.log(s.sessAttaching(ticket.label, ticket.detachHint))
    printedDetachHint = true
  }
  const [bin, ...rest] = ticket.argv
  if (!bin) return
  await new Promise<void>(resolve => {
    const child = spawn(bin, rest, { stdio: 'inherit' })
    child.on('exit', () => resolve())
    // A backend that cannot be exec'd must not wedge the loop: the control center comes straight
    // back up and the failure is visible as the session simply still being there.
    child.on('error', () => resolve())
  })
}

/**
 * The session poller, created once for the life of the process.
 *
 * A singleton on purpose, and not for speed: the poller carries the previous frame digest and the
 * previous state of every session between calls, and those two are what make movement detectable
 * and the bell a TRANSITION rather than a level. A fresh poller per call would have no previous
 * frame to compare against — so nothing could ever be seen to move, and every waiting session would
 * ring the bell every five seconds forever.
 */
let sessionsPoller: SessionsPoller | null = null

async function ensureSessionsPoller(): Promise<SessionsPoller> {
  if (sessionsPoller) return sessionsPoller
  const backend = await resolveBackend()
  sessionsPoller = createSessionsPoller({
    backend, readRegistry, scanProcesses, loadConversations, touchSessions,
    loadHarnessSessions,
    // Written once per session, not once per poll — the poller only calls this when the harness's
    // own record disagrees with the registry.
    recordConversation: (id, conversationId) => patchSession(id, { conversationId }),
    // The `/rename` name, persisted so the title survives the process — same once-per-change
    // discipline. See `ManagedSession.harnessName` and `pickTitle`.
    recordHarnessName: (id, name, since) =>
      patchSession(id, { harnessName: name, ...(since !== undefined ? { harnessNameSince: since } : {}) }),
    // Take back a running session whose registry record was lost. Called only with a non-empty
    // list, so a healthy fleet never writes. See `session-adopt.ts` for what may be adopted.
    adoptSessions: async records => { for (const r of records) await addSession(r) },
  })
  return sessionsPoller
}

/**
 * A refused spawn plan, in words.
 *
 * Mirrors `cli-session.ts`'s explainer rather than sharing it, because that one prints a CLI usage
 * hint and this one goes into a status line — the same facts, addressed to someone looking at a
 * screen rather than at a shell.
 */
function explainSpawnError(e: SpawnPlanError, s: CliStrings): string {
  switch (e.code) {
    case 'unsupported-harness': return s.sessSpawnUnsupported(e.harness)
    case 'resume-unsupported': return s.sessSpawnNoResume(e.harness)
    case 'model-unsupported': return s.sessSpawnNoModel(e.harness)
    case 'effort-unsupported': return s.sessSpawnNoEffort(e.harness)
    case 'unknown-effort': return s.sessSpawnBadEffort(e.harness, e.value, e.accepted)
  }
}

/**
 * Start one managed session — the ONE path every caller goes through.
 *
 * The wizard, a resume and "open this whole task" differ only in what they put in the request, so
 * they share this rather than each doing their own plan/spawn/register dance. The plan is checked
 * BEFORE anything is spawned, so an unsupported flag is a sentence rather than a session that starts
 * and dies with a usage error on a screen nobody is looking at.
 */
/**
 * The stored fleet arrangement — ALWAYS present, falling back to the defaults.
 *
 * Never absent, and that is the whole point. The screen restores the stored arrangement when one
 * arrives and only starts persisting its own once it has; with an absent value it could not tell
 * "the status has not loaded yet" from "this machine never chose", so on every remount — which is
 * exactly what detaching from a session does — it wrote its DEFAULTS over the arrangement it was
 * about to be handed. The grouping came back to `list` after every attach, twice.
 */
async function sessionViewPref(): Promise<{ sessionView: SessionViewPrefs }> {
  const stored = (await readPreferences()).sessionView
  return { sessionView: stored ?? DEFAULT_SESSION_VIEW }
}

async function spawnManaged(req: {
  harness: HarnessId
  cwd: string
  attach: boolean
  resumeId?: string
  prompt?: string
  model?: string
  effort?: string
  label?: string
  task?: string
}, s: CliStrings): Promise<SpawnSessionResult> {
  const backend = await resolveBackend()
  const blocked = await backend.unavailable()
  if (blocked) return { ok: false, message: blocked }

  const planned = planSpawn({
    harness: req.harness,
    cwd: req.cwd,
    ...(req.resumeId ? { resumeId: req.resumeId } : {}),
    ...(req.prompt ? { prompt: req.prompt } : {}),
    ...(req.model ? { model: req.model } : {}),
    ...(req.effort ? { effort: req.effort } : {}),
    // Offered for a FRESH session; `planSpawn` applies it only where the CLI accepts one and reports
    // back what it actually did. A resume ignores it — that conversation already has an id.
    conversationId: randomUUID(),
  })
  if (!planned.ok) return { ok: false, message: explainSpawnError(planned.error, s) }

  const id = newSessionId()
  try {
    await backend.spawn({
      id,
      cwd: req.cwd,
      argv: planned.plan.argv,
      // Deliver the initial prompt once the harness is ready (see `initial-prompt.ts`). The harness's
      // screen rules ride along so the backend can tell an idle prompt from a startup dialog.
      ...(planned.plan.initialPrompt
        ? { initialPrompt: { ...planned.plan.initialPrompt, ...(rulesFor(req.harness) ? { rules: rulesFor(req.harness)! } : {}) } }
        : {}),
    })
  } catch (e) {
    return { ok: false, message: s.sessSpawnFailed(e instanceof Error ? e.message : String(e)) }
  }

  await addSession({
    id,
    harness: req.harness,
    cwd: req.cwd,
    createdAt: new Date().toISOString(),
    // Stamped at birth, not left to the first heartbeat: a session started and lost inside the same
    // minute would otherwise carry no evidence it was ever alive, and would sit out the very crash
    // it was part of. See `crash-group.ts`.
    lastSeenMs: Date.now(),
    ...(req.model ? { model: req.model } : {}),
    ...(req.effort ? { effort: req.effort } : {}),
    ...(req.label ? { label: req.label } : {}),
    ...(req.task ? { task: req.task } : {}),
    // Recorded at the one moment it is certain — the harness was just handed this id, or we asked
    // it to reopen this conversation. Without it a fresh session's link exists only while the
    // harness's own record does (`harness-sessions.ts`, claude alone), so a session started with
    // the cockpit closed had nothing to fall back on but the harness-and-directory guess.
    ...(planned.plan.conversationId ? { conversationId: planned.plan.conversationId } : {}),
    // Which repository this directory is in, while the directory is provably there. See
    // `ManagedSession.repo`: a worktree removed later leaves a path that names nothing, and the
    // grouping fell through to its last path segment as though it were a project.
    ...(await recordedRepo(req.cwd)),
  })

  const convId = planned.plan.conversationId ?? req.resumeId
  const liveBackend = await backend.list().catch(() => [])
  const backendIds = new Set(liveBackend.map(b => b.id))
  await retireFallenSessions({
    newSessionId: id,
    conversationId: convId,
    cwd: req.cwd,
    harness: req.harness,
    backendIds,
  })

  const name = req.label ?? id
  if (!req.attach) return { ok: true, id, message: s.sessStartedBg(name) }
  return {
    ok: true,
    id,
    message: s.sessStarted(name),
    ticket: { argv: backend.attachCommand(id), detachHint: await backend.detachHint(), label: name },
  }
}

/**
 * Reopen a SET of registry rows in the background — the one implementation behind both "open the
 * whole task" and "reopen everything that fell".
 *
 * The two differ only in how the set is chosen: a task is a name the user filed sessions under, a
 * fall is a timestamp `crash-group.ts` matched them on. Everything after that — which rows are left
 * alone, which are not resurrected, which are skipped and counted, and the retiring of every row
 * that is replaced — is `planTaskReopen`, and writing it twice is exactly the drift that module was
 * extracted to end.
 */
/**
 * End the assistant process holding a conversation, so the same conversation can be reopened under
 * tmux. Returns whether it is actually gone.
 *
 * `SIGTERM` first and only: a CLI asked to stop writes out what it is holding, and the whole point
 * of the takeover is that the CONVERSATION survives it. `SIGKILL` is the escalation, taken only
 * after the polite request has been ignored for `ADOPT_TERM_MS` — an assistant mid-turn can take a
 * moment, and killing it a millisecond after asking would make the gentle signal decorative.
 *
 * **The return value is a fact, not an intention.** The caller spawns a second assistant into this
 * conversation the moment this says yes, so "we sent a signal" is not good enough — the pid is
 * polled until the kernel says it is gone. If it will not die, this returns false and NOTHING is
 * spawned: leaving the user with the process they already had is much better than handing them the
 * twin this whole module exists to prevent.
 */
const ADOPT_TERM_MS = 4000
const ADOPT_KILL_MS = 2000
const ADOPT_POLL_MS = 100

/**
 * Is this pid, RIGHT NOW, an assistant process on this machine?
 *
 * Asked immediately before signalling, and the takeover is abandoned when the answer is no.
 *
 * A pid alone is not an identity. `claude agents --json` states a pid and carries no `procStart`, so
 * a record left behind by a finished agent names a number the kernel is free to hand to anything —
 * and while that number was only ever used to REFUSE a reopen, a stale one cost nothing. It is now
 * used to send SIGKILL, which turns the same staleness into killing an unrelated process of the
 * user's. The pid is therefore checked against the live assistant scan, which is the one source that
 * knows what an assistant process looks like on this machine.
 *
 * A machine that cannot be scanned answers NO, not yes: the takeover is refused and the user keeps
 * the assistant they had. Being unable to confirm is not permission.
 */
async function isAssistantPid(pid: number): Promise<boolean> {
  try {
    const { procs } = await scanProcesses()
    return procs.some(p => p.pid === pid)
  } catch {
    return false
  }
}

async function endProcess(pid: number): Promise<boolean> {
  const gone = () => {
    try { process.kill(pid, 0); return false } catch { return true }
  }
  if (gone()) return true

  const waitFor = async (ms: number): Promise<boolean> => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (gone()) return true
      await new Promise(r => setTimeout(r, ADOPT_POLL_MS))
    }
    return gone()
  }

  try { process.kill(pid, 'SIGTERM') } catch { return gone() }
  if (await waitFor(ADOPT_TERM_MS)) return true

  try { process.kill(pid, 'SIGKILL') } catch { return gone() }
  return waitFor(ADOPT_KILL_MS)
}

async function reopenEntries(
  entries: readonly ManagedSession[],
  s: CliStrings,
): Promise<{ plan: TaskReopenPlan; opened: number; skipped: number }> {
  const conversations = await loadConversations()
  const backend = await resolveBackend()
  const live = new Set(
    (await backend.list().catch(() => [])).filter(b => b.alive).map(b => b.id),
  )
  // What is already being driven, so a task reopen cannot put a second assistant into a conversation
  // that has one. `live` above cannot answer this: it is keyed by ROW, and the twin case is a row
  // that is down while another row drives its conversation.
  const inUse = await liveConversationHolders(backend)

  // CLAIMED, one per row: the harness+directory match cannot tell two sessions of one repository
  // apart, so a set of five rows used to start five copies of one conversation. A row that RECORDED
  // which conversation it drives is exact and takes that one.
  const taken = new Set<string>()
  const plan = planTaskReopen({
    entries,
    liveIds: live,
    inUse,
    conversationFor: entry => {
      const own = entry.conversationId
        ? conversations.find(c => c.sessionId === entry.conversationId)
        : undefined
      const conv = own ?? conversations.find(c =>
        !taken.has(c.sessionId) && c.harness === entry.harness && c.cwd === entry.cwd)
      if (!conv?.resumable) return null
      taken.add(conv.sessionId)
      return { sessionId: conv.sessionId, title: conv.title }
    },
  })

  let opened = 0
  let skipped = plan.skipped.length
  for (const row of plan.reopen) {
    const m = row.entry
    const r = await spawnManaged({
      harness: m.harness,
      cwd: m.cwd,
      resumeId: row.resumeId,
      label: row.label,
      attach: false,
      // The task travels with the session, whichever set this reopen was chosen from: a fall does
      // not un-file the work someone filed.
      ...(m.task ? { task: m.task } : {}),
    }, s)
    if (!r.ok) { skipped++; continue }
    opened++
    if (r.id) await patchSession(r.id, { conversationId: row.resumeId })
    // Retired, so a laptop closed and opened twice does not leave two dead twins and one live
    // session standing under the same name.
    await patchSession(m.id, { endedAt: new Date().toISOString() })
    if (m.note && r.id) await patchSession(r.id, { note: m.note })
  }
  forgetConversations()
  return { plan, opened, skipped }
}

/**
 * The fall, named ROW BY ROW — what the offer made on the way in shows.
 *
 * The SELECTION is `planCrashGroup` and nothing else. This started life as a second selection
 * (`planRestore`, from the branch this is reconciled with), and the two agreed about `endedAt` and
 * about claiming a conversation once while disagreeing about the thing that matters: `planRestore`
 * had no evidence a row was ever ALIVE, so it offered every resolvable `lost` row — which on a
 * machine with months of history is the "sessões lixo" complaint this feature was built to answer.
 * Two selections is two sets of rules; the repo has paid for that once already (`task-reopen.ts`).
 *
 * Exactly ONE rule is added on top, and it belongs here rather than in the pure selection because it
 * is about the OFFER and not about the fall: a row whose conversation cannot be resolved is dropped,
 * because this list is clickable and a row that cannot be reopened is a button that fails. It stays
 * inside `fell`, where `reopenEntries` counts it as skipped — the fall is what happened, and the
 * offer is what can be done about it.
 */
async function restorableSessions(fell: readonly ManagedSession[]): Promise<RestoreCandidate[]> {
  if (fell.length === 0) return []
  const conversations = await loadConversations()
  const taken = new Set<string>()

  // The DECISION is the pure `planFellOffer`; this is the I/O around it — the conversation store,
  // and the claiming that stops four fallen rows in one repository being offered four copies of one
  // conversation.
  return planFellOffer({
    entries: fell,
    conversationFor: m => {
      const own = m.conversationId
        ? conversations.find(c => c.sessionId === m.conversationId)
        : undefined
      const conv = own ?? conversations.find(c =>
        !taken.has(c.sessionId) && c.harness === m.harness && c.cwd === m.cwd)
      if (!conv?.resumable) return null
      taken.add(conv.sessionId)
      return { sessionId: conv.sessionId, title: conv.title }
    },
  }).map(o => ({
    id: o.entry.id,
    label: o.label,
    harness: o.entry.harness,
    // The last segment, the same key the "by project" grouping falls back to.
    project: o.entry.cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? '',
    ...(o.startedMs !== undefined ? { startedAt: o.startedMs } : {}),
  }))
}

/**
 * The host, exported so the WEB dashboard's session routes act through the same object the cockpit
 * does (`sessions/fleet-web.ts`).
 *
 * The alternative was a second set of session verbs living in `index.ts`, which is the drift
 * `task-reopen.ts` was extracted to end: `answerSession` alone re-reads the frame, re-parses the
 * options and refuses a numbered dialog on a harness with no verified way to pick — a browser copy
 * of that would be a button that approves the highlighted row. Only `suspend`-requiring actions
 * (`central.sh init`) need a real terminal, and the web host is never asked for one.
 */
export function createControlHost(initialLang: CliLang, altScreen: Suspendable): StartHost {
  let lang = initialLang
  const S = () => cliStrings(lang)
  // Built here so it always reports in the language the host is currently speaking.
  const suspend = makeSuspend(altScreen, S)

  // The update check is fired once and never awaited. `refresh()` runs on every action and on
  // every `r`, and a GitHub call on that path would stall the whole screen behind the network;
  // an answer that arrives late simply lights the header up on the next refresh.
  let latestVersion: string | undefined
  if (process.env.AGENTISTICS_NO_UPDATE_CHECK !== '1') {
    void getVersionInfo()
      .then(info => { if (info.hasUpdate) latestVersion = info.latest })
      .catch(() => { /* offline — the header simply says nothing */ })
  }

  /**
   * The last status this host produced, kept so a REMOUNT has something true to open on.
   *
   * The host outlives the Ink app — `runStart` creates it once and loops around every attach — which
   * is what makes this possible at all, and `ControlHost.lastStatus` is where the reason is written
   * down. Every write to it goes through `remember()`, so there is one place that can go stale.
   */
  let lastStatus: ControlStatus | null = null
  const remember = (next: ControlStatus): ControlStatus => (lastStatus = next)

  /**
   * The most recent fall the user has already been ASKED about — see `ControlHost.dismissFall`.
   *
   * Here, and not in the sessions screen, for the reason `lastStatus` is here: the host outlives
   * the Ink app, and attaching to a session unmounts it. A flag held in the screen is answered,
   * forgotten on the way into the session, and asked again on the way out.
   */
  let dismissedFallMs: number | null = null

  /** Has the archive consent never been answered? Used only to append a hint, so it fails open. */
  const archivePending = async (): Promise<boolean> => {
    try {
      return resolveArchiveMode(await readPreferences()) === undefined
    } catch {
      return false
    }
  }

  /**
   * The parallel-sessions budget, or `{}` when this machine cannot be measured.
   *
   * Spread into the status, so an unreadable machine contributes NO `memory` key at all and the
   * header draws no gauge — the same absence-is-absence rule as `ControlService.boot`. A zero here
   * would read as "no room left" on precisely the machines that could not be asked.
   *
   * The pids come from the harness records, which is the set this budget is about: assistants. It
   * deliberately does not try to price the whole machine — `MemAvailable` already accounts for
   * everything else, and RESERVED_BYTES holds room back for it.
   */
  const memoryStatus = async (): Promise<Pick<ControlStatus, 'memory'>> => {
    try {
      const sample = await readMemory()
      if (!sample) return {}
      const { scanProcesses } = await import('./live-sessions')
      const scan = await scanProcesses()
      const pidsFromProc = scan.procs
        .map(p => p.pid)
        .filter((pid): pid is number => pid !== undefined)

      const index = await loadHarnessSessions().catch(() => null)
      const pidsFromHarness = index
        ? [...index.byConversation.values()]
            .filter(f => f.alive === true && f.pid !== undefined)
            .map(f => f.pid!)
        : []

      const pids = Array.from(new Set([...pidsFromProc, ...pidsFromHarness]))
      const { bytes, read } = await readRss(pids)
      const b = memoryBudget({ sample, sessionBytes: bytes, sessions: read })
      return { memory: { used: b.used, max: b.max, red: b.red, percent: b.percent } }
    } catch {
      // Best-effort, exactly like every other reader on this object: a gauge that throws must not
      // take the whole status down with it.
      return {}
    }
  }

  /**
   * The machine's name on its central and the last push's round trip, or `{}`.
   *
   * Read from the LOCAL server's `/api/team/status`, which is the process that actually pushes —
   * this one only draws. Best-effort and short-timeout on purpose: the cockpit must open on a
   * machine whose server is down, and a header fact is never worth a hang. Absent beats wrong here
   * as everywhere: no name is drawn rather than a hostname standing in for one.
   */
  /**
   * How long a connection may go without a successful push before the header calls it STALE.
   *
   * Three minutes, against a cadence the CENTRAL owns and which floors at 15s (30s by default): well
   * clear of an ordinary quiet period, and short enough that a link which died between two polls
   * says so before you have acted on it. A member that has never pushed at all is stale too — "not
   * yet" and "working" are different answers, and only one of them may wear the green dot.
   */
  const LINK_STALE_MS = 3 * 60_000

  /**
   * What the link is DOING, from the facts `/api/team/status` already publishes.
   *
   * The decision lives here rather than in the TUI for the ordinary reason — the control center owns
   * no logic — and the order matters: an AUTH failure outranks everything (a revoked token does not
   * heal by waiting), then unreachable, then merely quiet.
   */
  const linkStateOf = (errKind: unknown, lastSuccessAt: number | null): CentralLinkState => {
    if (errKind === 'auth') return 'unauthorized'
    if (errKind === 'net') return 'offline'
    if (lastSuccessAt === null) return 'stale'
    return Date.now() - lastSuccessAt > LINK_STALE_MS ? 'stale' : 'ok'
  }

  const centralIdentity = async (): Promise<
    Pick<ControlStatus, 'machineName' | 'accountName' | 'linkState' | 'pushMs'>
  > => {
    try {
      const res = await fetch(`http://localhost:${PORT}/api/team/status`, {
        signal: AbortSignal.timeout(1200),
      })
      if (!res.ok) return {}
      const body = await res.json() as {
        connections?: Array<{
          machineName?: unknown; latencyMs?: unknown
          org?: unknown; errKind?: unknown; lastSuccessAt?: unknown
        }>
      }
      // The FIRST connection: a machine with several centrals has one name per central, and a header
      // cell cannot carry a list. The connection card shows them all.
      const first = body.connections?.[0]
      const name = typeof first?.machineName === 'string' && first.machineName ? first.machineName : undefined
      const ms = typeof first?.latencyMs === 'number' && Number.isFinite(first.latencyMs)
        ? Math.max(0, Math.round(first.latencyMs))
        : undefined
      const account = typeof first?.org === 'string' && first.org ? first.org : undefined
      const lastOk = typeof first?.lastSuccessAt === 'number' && Number.isFinite(first.lastSuccessAt)
        ? first.lastSuccessAt
        : null
      return {
        ...(name ? { machineName: name } : {}),
        ...(account ? { accountName: account } : {}),
        // Gated on `first` existing (there IS a connection), never on `name`: a central that never
        // resolved this token's machine name still answers whoami with an org and a latency, and
        // the header must draw the account + dot from those alone rather than going blank because
        // one field of three could not be named.
        ...(first ? { linkState: linkStateOf(first?.errKind, lastOk) } : {}),
        ...(ms !== undefined ? { pushMs: ms } : {}),
      }
    } catch {
      return {}
    }
  }

  /** The setting in force, for the Setup tab to state. `undefined` while it is still unanswered. */
  const currentArchiveMode = async (): Promise<ArchiveMode | undefined> => {
    try {
      return resolveArchiveMode(await readPreferences())
    } catch {
      return undefined
    }
  }

  /**
   * The service panel, in two passes: is a runtime up, and — only then — what is it.
   *
   * The second pass is skipped for anything not running, which is what keeps `refresh()` cheap on
   * the common machine where two of the three runtimes are down: no `docker inspect` for a
   * container that does not exist, no `ps` for a pid nobody found. Every fact in it is
   * independently optional and every command behind it is guarded, so a box without lsof, or with
   * docker installed but not answering, loses detail and never the screen.
   *
   * The three runtimes then fold into TWO rows, which is the whole point: `local` and `machine` are
   * one program run two ways, and `buildService` is what decides what that row says and offers.
   */
  const serviceRows = async (): Promise<ControlService[]> => {
    const s = S()
    const [local, central, machine, bootAgentistics, bootMachine, bootCentral, repo, machineCompose, centralPlan, centralRuntimes] = await Promise.all([
      isServerRunning(),
      dockerState(CENTRAL_FILTER, s),
      dockerState(MACHINE_FILTER, s),
      // Two more probes on the refresh path, both local, both guarded, both answering `undefined`
      // rather than throwing — and both skipped outright off Linux.
      bootState('server'),
      bootState('machine'),
      bootState('central'),
      // What a REBUILD would need, asked before it is offered: the native one recompiles this repo,
      // the machine one needs its compose file. Two `stat`s, and the answer is what keeps a verb
      // that cannot work off the action row.
      inRepoCheckout(),
      Bun.file(machineComposePath()).exists(),
      // Whether `central up` would be Docker or native here — the one fact that decides whether a
      // native start option even exists (see `StartFacts.centralPlan`).
      centralStartPlan(),
      // …and every SHAPE it could take, available or not. One probe feeds both the verbs the row
      // offers and the sentences the detail pane says about the ones it does not.
      centralRuntimeChoices(),
    ])
    // Asked whatever the runtime state says: the case this exists for is a second server running
    // while the row reads perfectly healthy, so gating it on `local` would skip exactly the machine
    // that needs it — and it is worth asking even when nothing holds the port at all.
    const idlePids = await idleServerPids()
    const [nativeFacts, centralFacts, machineFacts] = await Promise.all([
      local ? nativeServerFacts() : Promise.resolve<ProcessFacts>({}),
      central.state === 'up' ? containerFacts(CENTRAL_FILTER) : Promise.resolve<ContainerFacts>({}),
      machine.state === 'up' ? containerFacts(MACHINE_FILTER) : Promise.resolve<ContainerFacts>({}),
    ])
    // The published port is the central's own business and never reaches a runtime row; splitting
    // it off here keeps the rows to fields `ServiceRuntimeState` actually declares.
    const { hostPort: centralPort, ...centralProc } = centralFacts
    const { hostPort: _machinePort, ...machineProc } = machineFacts

    const localUrls = { webUrl: `http://localhost:${WEB_PORT}`, apiUrl: `http://localhost:${PORT}` }

    const nativeRuntime: ServiceRuntimeState = {
      id: 'local',
      kind: 'native',
      state: local ? 'up' : 'down',
      // Nothing to install and nothing to ask: this binary is the runtime.
      available: true,
      ...(local ? { ...localUrls, ...nativeFacts } : {}),
    }
    const machineRuntime: ServiceRuntimeState = {
      id: 'machine',
      kind: 'docker',
      state: machine.state,
      available: machine.available,
      reason: machine.reason,
      // Host networking (docker/machine.yml): the container's ports land directly on the
      // host, which is why it publishes nothing and its URLs are the native ones.
      ...(machine.state === 'up' ? { ...localUrls, ...machineProc } : {}),
    }
    const centralRuntime: ServiceRuntimeState = {
      id: 'central',
      kind: 'docker',
      state: central.state,
      available: central.available,
      reason: central.reason,
      // The central publishes ONE port and serves the dashboard and the api on it, so there is no
      // second URL to name — `apiUrl` is for the split the native server has, not for repeating
      // the same address under another word.
      ...(central.state === 'up'
        ? { webUrl: `http://localhost:${centralPort ?? CENTRAL_DEFAULT_PORT}`, ...centralProc }
        : {}),
    }

    // Only a Linux box has the mechanism at all — see `bootOptionsFor`. Asked once and handed to
    // both services, so the two rows can never disagree about whether this box does boot units.
    const bootSupported = platform() === 'linux'
    // `serviceCommandFor` is what decides `installable`: it returns null when the file the unit's
    // ExecStart would point at is not here, and a unit whose ExecStart cannot resolve is a service
    // systemd restarts every five seconds for the life of the machine.
    const canWrite = (mode: AutostartMode) => serviceCommandFor(mode) !== null

    return [
      buildService('agentistics', s.svcAgentistics, [nativeRuntime, machineRuntime], s, {
        // Two distinct boot mechanisms exist for this ONE service — the native `agentop-server` and
        // the Docker `agentop-machine` — and BOTH can be registered at once. The row used to name
        // whichever matched the runtime that happened to be up, so on a machine that had registered
        // both, the other one was invisible: something would bring the service back after a reboot
        // and the pane named a unit that was not it. That is the same class of half-truth
        // `ControlService.conflict` exists to prevent for the running state.
        //
        // So: registered if EITHER is, and the unit cell names every one that actually is. `boot`
        // stays `undefined` when the host could not tell at all (no user systemd) — absence is
        // absence, and a row with no answer draws nothing rather than claiming `off`.
        boot: bootAgentistics === undefined && bootMachine === undefined
          ? undefined
          : bootAgentistics === 'on' || bootMachine === 'on' ? 'on' : 'off',
        bootUnit: [
          bootAgentistics === 'on' ? unitName('server') : '',
          bootMachine === 'on' ? unitName('machine') : '',
        ].filter(Boolean).join(' + ')
          // Nothing registered: name the unit the switch on this row would WRITE, so "off" still
          // says what it is off about.
          || unitName(machine.state === 'up' ? 'machine' : 'server'),
        // BOTH mechanisms get a verb, whichever runtime happens to be up: the row states one and
        // the switch has to reach either, or a machine that registered the container at boot could
        // never turn that off while running natively.
        bootOptions: bootOptionsFor([
          {
            unit: unitName('server'), runtime: 'local', mech: 'native',
            on: bootAgentistics === 'on', installable: canWrite('server'),
          },
          {
            unit: unitName('machine'), runtime: 'machine', mech: 'docker',
            on: bootMachine === 'on', installable: canWrite('machine'),
          },
        ], s, bootSupported, s.svcAgentistics),
        rebuild: { local: repo, machine: machineCompose },
        idlePids,
      }),
      // The central's rebuild always works: `central.sh up` inside a checkout, and the published
      // image outside one — `cli-central.ts` picks between them, and a central that is RUNNING
      // (the only state that offers a restart) has already proved whichever path it took.
      buildService('central', s.svcCentral, [centralRuntime], s, {
        boot: bootCentral,
        bootUnit: unitName('central'),
        // One mechanism, so no word distinguishes it — `Start at boot`, not `Start at boot (docker)`.
        bootOptions: bootOptionsFor([{
          unit: unitName('central'), runtime: 'central', mech: '',
          on: bootCentral === 'on', installable: canWrite('central'),
        }], s, bootSupported, s.svcCentral),
        rebuild: { central: true },
        centralPlan,
        centralRuntimes,
      }),
    ]
  }

  /**
   * Which runtime a log source means, probing as little as possible.
   *
   * A log pane polls once a second, in two places, so resolving a source that names exactly one
   * runtime must cost nothing at all — and even the logical `agentistics` stops probing the moment
   * it finds a runtime up, because that is the one `logRuntime` would pick anyway.
   */
  const resolveLogRuntime = async (source: LogSource): Promise<RuntimeId> => {
    const candidates = TARGET_RUNTIMES[source]
    if (candidates.length === 1) return candidates[0]!
    const up: RuntimeId[] = []
    for (const id of candidates) {
      if (await isRuntimeUp(id)) { up.push(id); break }
    }
    return logRuntime(source, up)
  }

  const modeSentence = (s: CliStrings, mode: Mode, connections: number): string =>
    // The endpoint travels in its own field and the header prints it separately; embedding it
    // here too would render it twice. With MORE than one central the count is the fact the
    // endpoint field cannot carry on its own, so the sentence names it.
    mode === 'member' ? (connections > 1 ? s.configMembers(connections) : s.configMemberBare)
    : mode === 'central' ? s.configCentral
    : s.configSolo

  return {
    get lang() { return lang },

    lastStatus: () => lastStatus,

    async refresh(): Promise<ControlStatus> {
      const s = S()
      const [{ mode, endpoint, connections, mouse, sessionPollMs }, services] =
        await Promise.all([loadState(), serviceRows()])
      return remember({
        mode,
        modeLabel: modeSentence(s, mode, connections.length),
        // Every endpoint, not the mirror's first one: the detail pane is where the user checks
        // WHICH centrals this machine feeds, and naming one of three there reads as a machine that
        // is connected to one. `fitValue` degrades the joined list the same way it degrades a
        // single URL.
        endpoint: mode !== 'member' ? undefined
          : connections.length > 1 ? connections.map(c => c.endpoint).join(' · ')
          : (connections[0]?.endpoint ?? endpoint),
        services,
        version: CURRENT_VERSION,
        latestVersion,
        // WHICH machine this is on its central, and how long the last push took. Both come from the
        // running server's own status route rather than being re-derived here: the uploader already
        // resolves the name from `whoami` and already times its round trips, and a second
        // implementation of either would be a second answer that can disagree with the one the
        // connection card shows.
        ...(await centralIdentity()),
        // The parallel-sessions budget. Computed HERE and not in the TUI, like every other decision
        // on this object: the arithmetic lives in the pure `memory-budget.ts` and the two `/proc`
        // reads in `memory-probe.ts`, and the answer arrives already decided — including `red`,
        // which depends on swap pressure the screen has no way to know about.
        ...(await memoryStatus()),
        archiveMode: await currentArchiveMode(),
        // The setup wizard is a question the cockpit asks, so what it may offer is decided here,
        // beside the very service states that decide it. `central` is the only mode that
        // RECONFIGURES a running service — it re-runs `central.sh init`, which rewrites the
        // environment file and recreates the containers — so it is the only one withheld, and it
        // is withheld with a sentence rather than by disappearing.
        setupBlocked: services.some(v => v.id === 'central' && v.state === 'up')
          ? { central: s.setupBlockedCentralUp }
          : {},
        ...(await sessionViewPref()),
        mouse,
        sessionPollMs,
      })
    },

    /**
     * Start ONE runtime — the one the user picked off the service's own start options.
     *
     * There is no "which service?" left to decide here: the screen offers a runtime only when its
     * logical service has nothing up, so the case that produced the complaint — an offer to start a
     * container copy of a server already running natively — cannot be reached rather than being
     * refused after the fact. The port check below stays anyway, for the seconds between a refresh
     * and a keypress.
     */
    async start(req: StartRequest): Promise<ActionResult> {
      const s = S()

      if (req.runtime === 'central') {
        // The verb the user pressed names the SHAPE, and it travels as the very flag the CLI takes
        // — pressing "Start (docker · published image)" here and typing `agentop central up
        // --image` are one code path, which is what stops the two surfaces drifting into offering
        // different deployments. Absent means "whatever this central is configured with", exactly
        // as every start meant before the choice existed.
        const chosen = req.centralRuntime
        const args = chosen ? [flagFor(chosen)] : []

        // Which shape needs the real terminal is a separate question from which shape it is, and
        // `centralStartPlan` still answers it — except when the user has just told us, in which
        // case their answer outranks what is on disk.
        const plan = chosen
          ? (chosen === 'native' ? 'native' : chosen === 'docker-build' ? 'script' : 'image')
          : await centralStartPlan()

        // Native + background is the one shape that neither streams nor suspends: it returns
        // immediately with the server detached, so its own prints (which side, which port, the log
        // path) are just captured for the status line like any other quick action.
        if (plan === 'native' && req.how === 'bg') {
          const { value: code } = await captureOutput(() => runCentral('up', args, { detached: true }))
          return code === 0
            ? { ok: true, message: s.centralStarted }
            : { ok: false, message: s.centralFailed }
        }
        // Asked BEFORE it is run, because the answer decides who gets the terminal. A first-ever
        // central (`init`) has questions, a native foreground start becomes a server that never
        // exits until Ctrl-C — both need the real tty. Everything else is docker compose with
        // nothing to answer, which is what the pane is for.
        const streamable = plan === 'script' || plan === 'image'
        const code = streamable
          ? await streamOutput(() => runCentral('up', args, { streamed: true }))
          : await suspend(() => runCentral('up', args))
        return code === 0
          ? { ok: true, message: s.centralStarted }
          : { ok: false, message: s.centralFailed }
      }

      if (req.runtime === 'machine') {
        // Foreground needs the real tty (Ctrl-C has to reach the child), so it is suspended in
        // place rather than streamed — it never reports `foregroundLater`/exits the control center
        // the way `local`'s foreground does, because a container start does not need to become
        // this PROCESS's own foreground job to give the user a live, interruptible view of it.
        const code = req.how === 'fg'
          ? await suspend(() => startDockerForeground(s))
          : await streamOutput(() => startDocker(s))
        return code === 0
          ? { ok: true, message: s.containerUp }
          : { ok: false, message: s.dockerStartFailed }
      }

      // Foreground can only start once we no longer own the tty, so the control center reports it
      // as an exit and `runStart` takes over; this branch is unreachable from the Ink layer.
      if (req.how === 'fg') return { ok: false, message: s.foregroundLater }

      // The control center asks about a port collision before it ever gets here (and stops the
      // old server itself if the user says so), so reaching this means one came up in between.
      // Killing a server the user was never asked about is not a substitute for the question.
      if (await isServerRunning()) {
        return { ok: false, message: `${s.alreadyRunning(`http://localhost:${WEB_PORT}`)} ${s.useRestartInstead}` }
      }

      startBackground()
      const hint = (await archivePending()) ? ` · ${s.archiveUnsetHint}` : ''
      return { ok: true, message: `${s.startedBg} http://localhost:${WEB_PORT}${hint}` }
    },

    async connect(v): Promise<ActionResult> {
      const s = S()
      const { value: code, text } = await captureOutput(() =>
        memberConnect({ endpoint: v.endpoint, token: v.token, org: v.org || undefined }),
      )
      if (code === 0) return { ok: true, message: s.connected }
      return { ok: false, message: lastLine(text) || s.connectFailed }
    },

    /**
     * Leave a central — and with several connected, WHICH one is a question.
     *
     * `memberLeave()` handles 0/1/N itself and refuses to guess `connections[0]`; its N-connection
     * branch opens a picker, so that case goes through `suspend` (a question needs the real tty —
     * a prompt captured into the status line is one nobody can answer, and Ink still owns the
     * keyboard). One connection asks nothing and stays captured, which is the common path.
     *
     * The message is derived from what is LEFT afterwards rather than asserted: "back to solo" was
     * simply false when a machine that fed three centrals left one.
     */
    async disconnect(): Promise<ActionResult> {
      const s = S()
      const before = (await loadState()).connections.length
      const { code, text } = before > 1
        ? { code: await suspend(() => memberLeave()), text: '' }
        : await captureOutput(() => memberLeave()).then(r => ({ code: r.value, text: r.text }))
      if (code !== 0) return { ok: false, message: lastLine(text) || s.disconnectFailed }
      const after = (await loadState()).connections.length
      return { ok: true, message: after > 0 ? s.stillConnected(after) : s.disconnected }
    },

    /**
     * Bounce whatever the target names, resolved against what is RUNNING.
     *
     * The resolution is the reason the screen can stop naming runtimes: `restart('agentistics')`
     * bounces the native server or the container, whichever is actually up — and both of them when
     * they are in conflict, which is the only honest reading of "restart it". Naming something that
     * is not running is answered plainly instead of reported as a restart that never happened.
     */
    async restart(target: ActionTarget, rebuild = false): Promise<ActionResult> {
      const s = S()
      const targets = targetRuntimes(target, await runningRuntimes())
      if (targets.length === 0) return { ok: false, message: s.svcNotRunning }
      /**
       * Streamed when there is something to WATCH: a rebuild, or anything going through docker
       * compose. A native bounce says three lines and its outcome is the status line, so it stays
       * captured — the output pane must not take over the detail region for the most common action
       * on this screen. The central used to be suspended here for the opposite reason (its child
       * inherited the terminal and wrote past any capture); piping it is what removed that.
       */
      const watchable = rebuild || targets.includes('central') || targets.includes('machine')
      const work = () => restartRuntimes(s, targets, { rebuild, stream: watchable })
      const ok = watchable ? await streamOutput(work) : (await captureOutput(work)).value
      if (!ok) return { ok: false, message: s.restartFailed }
      return { ok: true, message: target === 'all' ? s.restartedAll : s.restartedDone }
    },

    async stop(target: ActionTarget): Promise<ActionResult> {
      const s = S()
      const targets = targetRuntimes(target, await runningRuntimes())
      if (targets.length === 0) return { ok: false, message: s.svcNotRunning }
      await captureOutput(async () => {
        if (targets.includes('local')) await stopLocal(s)
        if (targets.includes('central')) await stopContainers(CENTRAL_FILTER, s.stoppingCentral)
        if (targets.includes('machine')) await stopContainers(MACHINE_FILTER, s.stoppingMachine)
      })
      return { ok: true, message: target === 'all' ? s.stoppedAll : s.stoppedDone }
    },

    // `solo` is the only mode a preference write can establish on its own: central and member
    // both need a real action to succeed first (`initCentral`, `connect`), which writes it.
    async setMode(): Promise<ActionResult> {
      const s = S()
      /**
       * Going solo with centrals attached is a LEAVE, not a preference write.
       *
       * `{ ...DEFAULT_TEAM }` carries an explicit `connections: []`, which `mergeTeamPayload`
       * honours as a replacement of the whole array — so this used to drop every connection AND
       * every token in one write. A member token is minted on the central and stored nowhere else
       * on this machine, so that is unrecoverable without re-minting one per central; worse, each
       * central kept serving this machine's data while the machine had no way left to ask it to
       * stop. `--all` asks nothing, so it stays captured, and a leave that FAILED aborts the write
       * instead of orphaning the tokens it could not surrender.
       */
      const { connections } = await loadState()
      if (connections.length > 0) {
        const { value: code, text } = await captureOutput(() => memberLeave({ all: true }))
        if (code !== 0) return { ok: false, message: lastLine(text) || s.disconnectFailed }
      }
      try {
        await writePreferences({ team: { ...DEFAULT_TEAM } })
        return { ok: true, message: s.soloSet }
      } catch {
        return { ok: false, message: s.prefsWriteFailed }
      }
    },

    async initCentral(): Promise<ActionResult> {
      const s = S()
      // The ONE action still suspended, and the reason is not its output but its INPUT: `init` reads
      // the port, the org and the secrets from the terminal — central.sh exits rather than run
      // without a tty. Streaming it would put the questions in a pane and leave the answers nowhere.
      const code = await suspend(() => runCentral('init', []))
      return code === 0
        ? { ok: true, message: s.centralInitDone }
        : { ok: false, message: s.centralInitFailed }
    },

    async pendingArchiveMode(): Promise<ArchiveMode | null> {
      // `null` is "nothing left to ask" — the same rule as `ensureArchiveModeChosen()`, which
      // never re-asks. Otherwise the recommended default comes back as the preselected answer.
      try {
        return resolveArchiveMode(await readPreferences()) === undefined ? 'consolidate' : null
      } catch {
        // Unreadable preferences are not consent; ask rather than assume.
        return 'consolidate'
      }
    },

    async upgrade(): Promise<ActionResult> {
      const s = S()
      // A CHILD process, not `runUpgrade()` in here. That command prints — a lot, for minutes —
      // and nothing may print while the alternate buffer is live; run as a child under
      // `streamCommand` both pipes are captured and every line lands in the detail pane instead.
      // It is also what makes the self-replacement safe: the binary being overwritten is this
      // process's own, and upgrade.ts installs by rename, which a running process survives.
      const code = await streamCommand([process.execPath, 'upgrade'])
      return code === 0
        ? { ok: true, message: s.upgradeDone }
        : { ok: false, message: s.upgradeFailed(code) }
    },

    async setArchiveMode(mode: ArchiveMode): Promise<ActionResult> {
      const s = S()
      try {
        await writePreferences({ archiveMode: mode })
        return { ok: true, message: s.archiveSet(mode) }
      } catch {
        return { ok: false, message: s.prefsWriteFailed }
      }
    },

    async enableBoot(service: ServiceId, runtime?: RuntimeId): Promise<ActionResult> {
      // `agentistics` boots as the native server by default — the manual "enable boot" action row
      // (offered while the service is down, with nothing yet running to name a runtime) has always
      // meant that, and still does when `runtime` is absent. `runtime: 'machine'` is the ONE case
      // that now means something else: the option that just started the Docker runtime in the
      // background hands its own runtime back here, so answering "yes" writes the `agentop-machine`
      // unit (`docker compose … up -d`) instead of a native unit that would not match what is
      // actually running. `central` has one mechanism regardless of `runtime` — `agentop-central`
      // already runs `central.sh up` (Docker) — so it is passed through unchanged.
      const mode = bootModeFor(service, runtime)
      const res = await enableAutostart(mode)
      // enableAutostart formats for a printed block; the status line is one row.
      return { ok: res.ok, message: res.message.split('\n').map(l => l.trim()).filter(Boolean).join(' · ') }
    },

    /**
     * Take the registration away again — and take NOTHING else.
     *
     * `stop: false` is the whole difference from `agentop autostart <mode> disable`, and it is
     * deliberate: the cockpit's switch answers "should this come back after a reboot", which is a
     * statement about the future. A verb that also killed the running service would be doing two
     * things under one label, and the row it sits on already carries `Stop` for the other one.
     *
     * The message NAMES the unit rather than repeating systemd's block: the status line is one row,
     * and the one fact worth spending it on is which registration is now gone.
     */
    async disableBoot(service: ServiceId, runtime?: RuntimeId): Promise<ActionResult> {
      const s = S()
      const mode = bootModeFor(service, runtime)
      const unit = unitName(mode)
      const res = await disableAutostart(mode, { stop: false })
      if (!res.ok) {
        return { ok: false, message: `${s.bootDisableFailed(unit)} ${lastLine(res.message)}`.trim() }
      }
      return { ok: true, message: s.bootDisabled(unit) }
    },

    /**
     * Hand a URL to the desktop's browser.
     *
     * Tried in the order a box is likely to answer: `xdg-open` on Linux, `open` on macOS,
     * `cmd /c start` under WSL and Windows. Every one is spawned DETACHED with its output
     * discarded — `xdg-open` keeps a child around and its stderr would land in the alternate
     * screen Ink is repainting, which is the one thing this module may never do.
     *
     * `openUrl` is optional on `ControlHost` precisely because this can legitimately have nowhere
     * to go: on a headless box every candidate fails, we say so in one line, and the cockpit stops
     * offering the action rather than leaving a key that does nothing.
     */
    async openUrl(url: string): Promise<ActionResult> {
      const s = S()
      const candidates: string[][] = [
        ['xdg-open', url],
        ['open', url],
        // `start` is a cmd builtin, and the empty string is the window TITLE — without it cmd reads
        // a quoted URL as the title and opens nothing.
        ['cmd.exe', '/c', 'start', '', url],
      ]
      for (const cmd of candidates) {
        try {
          const p = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })
          // A launcher that is going to fail does so immediately; one that worked has usually not
          // exited yet, and waiting for the browser itself would freeze the screen.
          const code = await Promise.race([
            p.exited,
            new Promise<number>(resolve => setTimeout(() => resolve(0), 400)),
          ])
          if (code === 0) return { ok: true, message: s.urlOpened(url) }
        } catch {
          // Not installed on this box — try the next spelling.
        }
      }
      return { ok: false, message: s.urlOpenFailed }
    },

    /**
     * Remember how the fleet list is arranged.
     *
     * Best-effort: a machine that cannot write its preferences still gets the arrangement for this
     * run. Losing it across restarts is not worth failing anything for.
     */
    async setSessionView(view: SessionViewPrefs): Promise<void> {
      // The remembered status has to move with it. This is the ONE thing a user changes that never
      // goes through an action — so it never triggers a `refresh()` — and a cache left behind would
      // hand the next remount the arrangement from before the change, undoing it on screen a moment
      // after it was made. Written even when the file write fails, for the same reason the failure
      // is swallowed: the arrangement still holds for this run.
      if (lastStatus) remember({ ...lastStatus, sessionView: view })
      try {
        await writePreferences({ sessionView: view })
      } catch {
        // Deliberately silent — see above.
      }
    },

    async setLang(next: CliLang): Promise<void> {
      lang = next
      try { await writePreferences({ lang: next }) } catch { /* best-effort */ }
    },

    // Best-effort, exactly like the language: a box that cannot write its preferences still gets
    // the toggle for this session, because the control center holds the answer itself and only
    // asks us to remember it.
    async setMouse(on: boolean): Promise<void> {
      // Same reason as `setSessionView`: a preference the user changes with a keypress, answered by
      // no action and therefore followed by no `refresh()`. Left out, the remembered status would
      // tell the next remount the mouse is still what it was before the key was pressed.
      if (lastStatus) remember({ ...lastStatus, mouse: on })
      try { await writePreferences({ mouse: on }) } catch { /* best-effort */ }
    },

    async setSessionPollMs(ms: number): Promise<void> {
      // Same shape as `setMouse`: this changes the running `setInterval` in the shell, which reads
      // it back straight off the row it just pressed enter on rather than waiting a poll cycle for
      // a `refresh()` this action does not otherwise trigger.
      const clamped = clampSessionPollMs(ms)
      if (lastStatus) remember({ ...lastStatus, sessionPollMs: clamped })
      try { await writePreferences({ sessionPollMs: clamped }) } catch { /* best-effort */ }
    },

    /**
     * The `backup` tab's own snapshot — see `ControlHost.backupStatus`.
     *
     * A SEPARATE read from `refresh()`, never folded into it: `refresh()` runs on every action and
     * on every `r` press, and this walks the metrics layer (a few MB) plus the whole consolidate
     * store to count sessions per harness, which every OTHER tab needs `refresh()` to stay cheap
     * for. The RAW layer (gigabytes) is never walked here — the harness list's `size` column is the
     * metrics-only weight, the same figure `agentop backup --plan` would report for that layer.
     */
    async backupStatus(): Promise<ControlBackupStatus> {
      const p = await readPreferences()
      const prefs = readBackupPrefs(p)
      const [measured, consolidated, entries, github] = await Promise.all([
        Promise.resolve(layerSizesNow()),
        loadConsolidated().catch(() => new Map()),
        loadBackupHistory().catch(() => []),
        // Undefined on a read failure, never `{configured:false}`: "we could not look" and "it is
        // off" are different facts, and `githubRows` says the same honest sentence for both without
        // this one having to pretend it knows which.
        readGithubSection().catch(() => undefined),
      ])

      const sessionCounts: Partial<Record<HarnessId, number>> = {}
      for (const sess of consolidated.values()) {
        const h = (sess.harness ?? 'claude') as HarnessId
        sessionCounts[h] = (sessionCounts[h] ?? 0) + 1
      }
      const byHarness = measured?.sizes.metrics.byHarness ?? {}
      const emptyLayerLabels: ControlBackupConfig['layerSizes'] =
        { metrics: null, repos: null, archive: null, raw: null }
      const layerSizes = measured?.labels ?? emptyLayerLabels
      // The same measurement, in raw bytes — see `ControlBackupConfig.layerBytes`. `repos` stays
      // null for the same reason its label does: unmeasurable ahead of a run.
      const layerBytes: ControlBackupConfig['layerBytes'] = measured
        ? {
            metrics: layerTotal(measured.sizes, 'metrics'),
            repos: null,
            archive: layerTotal(measured.sizes, 'archive'),
            raw: layerTotal(measured.sizes, 'raw'),
          }
        : { metrics: null, repos: null, archive: null, raw: null }
      const perHarnessLast = lastPerHarness(entries)

      const harnesses: ControlBackupHarness[] = HARNESS_ORDER.map(id => {
        const at = perHarnessLast[id]
        // A recorded backup once covered this harness, and its file is gone — see
        // `backup-store.ts`'s `markPresence`. Checked only when there is no PRESENT one, so a
        // harness with several records never has to look past the newest that still exists.
        const gone = !at && entries.some(e => e.harnesses.includes(id))
        return {
          id,
          enabled: prefs.harnesses.includes(id),
          sessions: sessionCounts[id] ?? 0,
          sizeLabel: formatBytes(byHarness[id] ?? 0),
          ...(at ? { lastBackupAt: at } : {}),
          ...(gone ? { lastBackupGone: true } : {}),
        }
      })

      const last = lastBackup(entries)
      const st = scheduleStatus({
        schedule: prefs.schedule, customHours: prefs.customHours,
        atHour: prefs.atHour, tzOffsetMinutes: new Date().getTimezoneOffset(),
        lastAt: last?.at ?? null, nowMs: Date.now(),
        serverRunning: existsSync(join(AGENTISTICS_DATA_DIR, 'events-producer.json')),
      })

      return {
        harnesses,
        config: {
          layers: prefs.layers,
          scheduleLayers: prefs.scheduleLayers,
          destDir: prefs.destDir,
          schedule: prefs.schedule,
          scheduleActive: st.kind === 'next',
          keep: prefs.keep,
          retainedLabel: formatBytes(retainedTotal(entries.filter(e => e.present))),
          secretsCount: omittedSecrets().length,
          layerSizes,
          layerBytes,
          ...(resolveArchiveMode(p) ? { archiveMode: resolveArchiveMode(p) } : {}),
          ...(last
            ? { last: { at: last.at, bytesLabel: formatBytes(last.archiveBytes), skipped: last.skipped } }
            : {}),
        },
        // Newest first already — see `loadBackupHistory`.
        history: entries.map(e => ({
          at: e.at,
          layers: e.layers,
          harnesses: e.harnesses,
          bytesLabel: formatBytes(e.archiveBytes),
          skipped: e.skipped,
          presence: e.presence,
        })),
        github,
      }
    },

    // Best-effort, exactly like `setMouse`: a machine that cannot write its preferences still gets
    // the toggle for this run.
    async setBackupHarness(harness: HarnessId, on: boolean): Promise<void> {
      try {
        const p = await readPreferences()
        const prefs = readBackupPrefs(p)
        const set = new Set(prefs.harnesses)
        if (on) set.add(harness); else set.delete(harness)
        await writePreferences({
          ...p,
          // HARNESS_ORDER, never the Set's own iteration order — the same discipline `readBackupPrefs`
          // itself follows, so a preference written here reads back in the order every other surface
          // already expects.
          backup: { ...(p.backup ?? {}), harnesses: HARNESS_ORDER.filter(h => set.has(h)) },
        })
      } catch { /* best-effort — see above */ }
    },

    // Delegates to the same writer `agentop backup schedule` calls (`cli-backup.ts`'s
    // `writeBackupSchedule`) — one implementation of the read-modify-write, not three.
    async setBackupSchedule(schedule: BackupScheduleId): Promise<ActionResult> {
      await writeBackupSchedule(schedule)
      return { ok: true, message: S().backupScheduleSet(schedule) }
    },

    /**
     * The layers editor's `enter` — set the layers a MANUAL run writes. Delegates to
     * `writeBackupLayers`, the same writer `agentop backup config --layers` and the web's format
     * picker call, which is what enforces `metrics` staying in the set even if this were ever
     * called with a draft that dropped it.
     */
    async setBackupLayers(layers: BackupLayer[]): Promise<ActionResult> {
      const written = await writeBackupLayers(layers)
      return { ok: true, message: S().backupLayersSet(written.join(', ')) }
    },

    /** Same, for the layers a SCHEDULED run writes. */
    async setBackupScheduleLayers(layers: BackupLayer[]): Promise<ActionResult> {
      const written = await writeBackupScheduleLayers(layers)
      return { ok: true, message: S().backupScheduleLayersSet(written.join(', ')) }
    },

    /**
     * Run a backup now, streaming into `onOutput` — the same channel a rebuild uses.
     *
     * Calls `performBackup`, the ONE implementation `agentop backup` itself calls (`cli-backup.ts`):
     * the cockpit decides nothing about what a backup carries, it only presses the button.
     */
    async runBackup(): Promise<ActionResult> {
      const prefs = readBackupPrefs(await readPreferences())
      const result = await performBackup(
        prefs,
        { layers: prefs.layers, harnesses: prefs.harnesses, destDir: prefs.destDir },
        line => publishLines([line]),
      )
      return result.ok
        ? { ok: true, message: S().backupRunOk(formatBytes(result.record.archiveBytes)) }
        : { ok: false, message: result.reason }
    },

    /**
     * The output channel, straight from `cli-stream.ts`.
     *
     * A pass-through rather than a second registry: the streaming helpers are module-level (one
     * control center per process), and a host that kept its own subscriber set would be a second
     * place for a line to get lost.
     */
    onOutput(handler: (line: string) => void): () => void {
      return onOutputLine(handler)
    },

    async readLog(source: LogSource, maxLines: number): Promise<string[]> {
      const runtime = await resolveLogRuntime(source)
      if (runtime === 'local') return tailFile(SERVER_LOG, maxLines)
      const ids = await dockerIds(runtime === 'central' ? CENTRAL_FILTER : MACHINE_FILTER)
      if (!ids.length) return []
      // `2>&1` inside the shell rather than two pipes read separately: a container writes to both
      // streams and reading them apart would interleave the log in the wrong order.
      const r = await sh(['sh', '-c', `docker logs --tail ${maxLines} ${ids[0]} 2>&1`])
      if (r.code !== 0) return []
      return r.out.split('\n').filter(line => line.length > 0)
    },

    /**
     * The session fleet, already decided and already localized.
     *
     * The poller is created ONCE and reused, which is not an optimization: it carries the previous
     * frame digest and the previous state of every session between calls, and those are what make
     * movement detectable and the bell a transition rather than a level. A fresh poller each call
     * would have no previous frame to compare against, so no session could ever be seen to move and
     * every waiting one would ring the bell every five seconds.
     */
    /**
     * The deep half of the sessions search — see `ControlHost.searchTranscripts`.
     *
     * Deliberately NOT folded into `sessions()`: that runs every 5 seconds, and reading 475 MB on
     * a timer to answer a question nobody asked is the difference between a search and a disk
     * burner. It is called only while the search field holds something, and the screen debounces.
     */
    async searchTranscripts(query: string): Promise<TranscriptSearch> {
      const r = await runTranscriptSearch(query, liveTranscriptDeps())
      return {
        ids: r.ids,
        covered: r.covered,
        failed: r.failed,
        ...(r.unavailable ? { unavailable: r.unavailable } : {}),
      }
    },

    async sessions(): Promise<ControlSessions> {
      // `S()` rather than `this.lang`: the language is a closure variable `setLang` reassigns, and
      // reading it through `this` would break the moment a caller detached the method.
      const s = S()
      // See `fleet-profile.ts`: this breakdown exists because the cold `/api/fleet` cost (~29s,
      // measured after `chat-tail.ts`'s fix) has NOT been traced past `readRegistry`/`scanProcesses`/
      // `loadConversations`/`loadHarnessSessions`/`backend.list` (individually measured and ruled
      // out — they run inside `poller.poll()`'s own `Promise.all`). Every phase below is a candidate
      // that has not yet been measured; run with `AGENTISTICS_PROFILE_FLEET=1` on the slow machine.
      /*
       * ASK THE SERVER'S POLLER BEFORE BUILDING A SECOND ONE.
       *
       * `working` is MOVEMENT — the frame changed since the LAST poll of that poller — and a state
       * must additionally be seen twice before it is believed. Both live in the poller's own
       * memory, so a poller that has just started reads a producing session as `waiting`, and a
       * `running only` filter then hides it. Measured at one instant: the long-lived server said
       * all four sessions were `working` while a freshly built host said all four were `waiting`.
       * That is "aqui aparecem 4 e no agentop só 3".
       *
       * `null` means there is no server to ask — an ordinary answer, since the cockpit's whole
       * purpose includes a machine whose server is stopped — and the local poller answers as it
       * always did. The server never asks itself. See `shared-snapshot.ts`.
       */
      const shared = isServerProcess()
        ? null
        : await timeFleetPhase(
          'sessions: readServerSnapshot',
          () => readServerSnapshot<SessionSnapshot>(lang),
        )
      const poller = shared
        ? null
        : await timeFleetPhase('sessions: ensureSessionsPoller', ensureSessionsPoller)
      const snap = shared
        ?? await timeFleetPhase('sessions: poller.poll', () => poller!.poll())
      // Carried on every snapshot so the cockpit can state it permanently: a user who cannot get
      // out of a session is stranded in a buffer that hides their shell, and a line printed once
      // before the handover scrolls away the moment anything else happens.
      const detachHint = await timeFleetPhase(
        'sessions: detachHint',
        async () => (await resolveBackend()).detachHint().catch(() => ''),
      )
      // Read on every snapshot rather than cached: the toggle and the verb both write it, and a
      // stale copy would leave a task the user just finished still heading a live section.
      const finishedTasks = (await timeFleetPhase('sessions: readPreferences', readPreferences)).finishedTasks ?? []
      // Resolved per session and MEMOIZED by directory: a directory does not change repository, and
      // this poll runs every five seconds over the whole fleet — asking git three times per session
      // per tick would be a hundred processes a minute to learn the same thing. What the registry
      // recorded at spawn is handed over with it, so a worktree somebody has since removed keeps
      // the project it belongs to instead of becoming one.
      const repoFactsStart = performance.now()
      const facts = await Promise.all(snap.sessions.map(v => repoFacts(v.cwd, v.recordedRepo)))
      markFleetPhase(`sessions: repoFacts x${snap.sessions.length}`, repoFactsStart)
      // What the machine LOST and could start again — named row by row for the offer, from the
      // SAME selection the count below reports. Read off the snapshot the poll already produced
      // rather than recomputed, so the screen cannot be shown two answers to one question while a
      // poll is in flight.
      // …and withheld once the user has ANSWERED this fall. `restorable` is what raises the modal,
      // so the dismissal is applied here rather than in the screen: the screen is remounted from
      // scratch on every attach/detach and cannot remember anything. `fell` itself is left intact —
      // the summary row and the list's own section keep saying what happened, because dismissing
      // the offer is a statement about the QUESTION, not about the event.
      const fellAt = snap.fell?.atMs
      const answered = fellAt !== undefined && dismissedFallMs !== null && fellAt <= dismissedFallMs
      const restorable = answered
        ? []
        : await timeFleetPhase('sessions: restorableSessions', () => restorableSessions(snap.fell?.entries ?? []))
      return {
        ...(restorable.length > 0 ? { restorable } : {}),
        sessions: snap.sessions.map((v, i) => toControlSession(v, s, facts[i])),
        attention: snap.attention,
        rang: snap.rang,
        // Only the COUNT and the instant travel: the rows themselves are already in `sessions`,
        // marked `fell`, and shipping the set twice is two things that can disagree about it.
        ...(snap.fell && snap.fell.entries.length > 0
          ? { fell: { count: snap.fell.entries.length, atMs: snap.fell.atMs } }
          : {}),
        ...(finishedTasks.length > 0 ? { finishedTasks } : {}),
        ...(detachHint ? { detachHint } : {}),
        ...(snap.unavailable ? { unavailable: snap.unavailable } : {}),
      }
    },

    async attachSession(id: string): Promise<AttachTicket | null> {
      const s = S()
      const backend = await resolveBackend()
      if (await backend.unavailable()) return null
      // The label comes from the registry so the sentence printed on the way in names what the user
      // selected, not an id they never typed.
      const managed = (await readRegistry()).find(r => r.id === id)
      return {
        argv: backend.attachCommand(id),
        detachHint: await backend.detachHint(),
        label: managed?.label ?? id,
      }
    },

    /**
     * Stop a session, and delete its registry entry only once the backend CONFIRMS it is gone.
     *
     * The same rule `agentop session kill` follows, and for the same reason: clearing the entry on an
     * unconfirmed kill turns a still-running session into one nothing can name again.
     */
    /**
     * Stop the current turn without ending the session.
     *
     * `Escape` is the key, taken from what `attention-rules.ts` already records these CLIs printing
     * while they work — `esc to interrupt` — rather than assumed. It is REFUSED unless the session
     * is measurably working: Escape into an idle prompt closes whatever the harness has open (a
     * picker, a dialog, its own transcript view), which is not what "stop" means and is not undone
     * by pressing it again.
     */
    /**
     * Advance a session's harness to its next mode — see `mode-spec.ts`.
     *
     * The liveness is re-read from the BACKEND rather than from a poll snapshot, exactly as
     * `interruptSession` and `answerSession` do: this sends a keystroke into a real terminal, and a
     * five-second-old view of what is running is what would send it into a session that has ended.
     *
     * A harness with no probed spec is refused BY NAME. There is no safe fallback key: shift+tab
     * means something else in most terminals, and sending it blind into an assistant is a keypress
     * nobody asked for — the same refusal `choiceKey` makes for a numbered dialog.
     */
    async cycleSessionMode(id: string): Promise<ActionResult> {
      const s = S()
      const backend = await resolveBackend()
      const blocked = await backend.unavailable()
      if (blocked) return { ok: false, message: blocked }

      const managed = (await readRegistry()).find(m => m.id === id)
      if (!managed) return { ok: false, message: s.sessNoRegistryEntry }
      const spec = modeSpecFor(managed.harness)
      if (!spec) return { ok: false, message: s.sessModeUnknown(managed.harness) }

      const live = (await backend.list().catch(() => [])).find(b => b.id === id)
      if (!live?.alive) return { ok: false, message: s.sessNotRunning }

      // The mode AFTER the key is whatever the harness moved to, and only the next poll can say —
      // so the answer names the act rather than claiming an outcome it has not read.
      return (await backend.sendKey(id, spec.cycleKey))
        ? { ok: true, message: s.sessModeCycled }
        : { ok: false, message: s.sessSendFailed(id) }
    },

    async interruptSession(id: string): Promise<ActionResult> {
      const s = S()
      const backend = await resolveBackend()
      const blocked = await backend.unavailable()
      if (blocked) return { ok: false, message: blocked }

      // Read the pane's LIVENESS the same way `answerSession` does, rather than trusting a poll
      // snapshot: this sends a keystroke into a real terminal, and a five-second-old view of what is
      // running is exactly what would send it into a session that has since ended.
      const live = (await backend.list().catch(() => [])).find(b => b.id === id)
      if (!live?.alive) return { ok: false, message: s.sessNotRunning }

      return (await backend.sendKey(id, 'Escape'))
        ? { ok: true, message: s.sessInterrupted(id) }
        : { ok: false, message: s.sessSendFailed(id) }
    },

    async killSession(id: string): Promise<ActionResult> {
      const s = S()
      const backend = await resolveBackend()
      const blocked = await backend.unavailable()
      if (blocked) return { ok: false, message: blocked }
      if (!(await backend.kill(id))) return { ok: false, message: s.sessKillUnconfirmed(id) }
      // MARKED finished, never deleted. Removing the row took with it the only record of which
      // conversation this was — the store had not caught up, so there was nothing left to offer as
      // reopenable and the session simply vanished from the screen. A session you end is still a
      // thing that happened, and picking it back up is the ordinary next thing to want.
      if (!(await patchSession(id, { endedAt: new Date().toISOString() }))) await removeSession(id)
      forgetConversations()
      return { ok: true, message: s.sessKilled(id) }
    },

    /**
     * Mark a task finished, or reopen it.
     *
     * The state to SET rather than a toggle, so the screen and the store can never disagree about
     * what the button just did. Nothing about the sessions changes: a finished task is a statement
     * about the WORK, and its sessions stay listed, attachable and killable behind one switch.
     */
    /**
     * Start the offered sessions again, detached — or decline them.
     *
     * ACCEPTING is `reopenEntries`, the same thing "open the whole task" and "reopen what fell"
     * perform. It arrived here as its own copy of that loop, which made THREE implementations of
     * one gesture — the drift `task-reopen.ts` was extracted to end, reintroduced by two sessions
     * that could not see each other's work. The set is different, the act is not.
     *
     * DECLINING retires the rows it was offered. "No" here means the work is over, and without it
     * the same offer greets you on the next run and the one after, which is how a prompt becomes
     * something people clear without reading. Nothing is destroyed either way: a retired row stays
     * listed, and `endedAt` is exactly what keeps it out of the next crash group while leaving it
     * individually reopenable.
     */
    /**
     * The user has answered the offer for the fall at `atMs` — stop raising it.
     *
     * Monotonic (`Math.max`), so a poll that re-anchors onto an OLDER cluster — which
     * `planCrashGroup` deliberately permits, with no maximum age — cannot lower the watermark and
     * bring the modal back naming a fall from three days ago.
     */
    dismissFall(atMs: number): void {
      dismissedFallMs = dismissedFallMs === null ? atMs : Math.max(dismissedFallMs, atMs)
    },

    async restoreSessions(ids: string[], accept: boolean): Promise<ActionResult> {
      const s = S()
      const registry = await readRegistry()
      const wanted = registry.filter(m => ids.includes(m.id))
      if (wanted.length === 0) return { ok: false, message: s.sessRestoreNone }

      if (!accept) {
        const stamp = new Date().toISOString()
        for (const m of wanted) await patchSession(m.id, { endedAt: stamp })
        return { ok: true, message: s.sessRestoreDeclined(wanted.length) }
      }

      const { opened, skipped } = await reopenEntries(wanted, s)
      return opened > 0
        ? { ok: true, message: s.sessRestored(opened, skipped) }
        : { ok: false, message: s.sessRestoreFailed(skipped) }
    },

    async finishTask(task: string, done: boolean): Promise<ActionResult> {
      const s = S()
      if (!task) return { ok: false, message: s.sessNoTask }
      const current = (await readPreferences()).finishedTasks ?? []
      const next = done
        ? (current.includes(task) ? current : [...current, task])
        : current.filter(t => t !== task)
      await writePreferences({ finishedTasks: next })
      return { ok: true, message: done ? s.sessTaskFinished(task) : s.sessTaskReopened(task) }
    },

    /**
     * Remove a task NAME. The sessions filed under it survive, unfiled.
     *
     * Reported: the task list had grown to dozens of entries, some naming work that is over and
     * some whose sessions no longer exist. `finishTask` marks work DONE and hides its sessions
     * behind a switch — a statement about the work. This is a statement about the LABEL, and the
     * two are different requests.
     *
     * The name lives in TWO places, and clearing one is the bug: on each session, and in
     * `finishedTasks`. Leave it in the finished list and it goes on being a menu entry naming
     * nothing; leave it on the sessions and the task reappears the moment the list is rebuilt.
     */
    async deleteTask(task: string): Promise<ActionResult> {
      const s = S()
      if (!task.trim()) return { ok: false, message: s.sessNoTask }
      const prefs = await readPreferences()
      const plan = planTaskDelete({
        task,
        sessions: await readRegistry().catch(() => []),
        finished: prefs.finishedTasks ?? [],
      })
      if (taskDeleteIsNoop(plan)) return { ok: false, message: s.sessTaskUnknown(task) }

      for (const id of plan.clear) await patchSession(id, { task: undefined })
      if (plan.unfinish) {
        await writePreferences({ finishedTasks: (prefs.finishedTasks ?? []).filter(t => t !== task) })
      }
      return { ok: true, message: s.sessTaskDeleted(task, plan.clear.length) }
    },

    /**
     * Rename a session in BOTH places it can be named — agentop's registry and the harness itself.
     *
     * The registry write comes first and is unconditional: it is the one that always works, and a
     * rename that refused because the harness could not be reached would leave every `lost` row
     * unnameable. The harness half is then attempted through the shared `renameInHarness`, and
     * whatever became of it is SAID — see `renameMessage`.
     */
    async renameSession(id: string, label: string): Promise<ActionResult> {
      const s = S()
      const managed = (await readRegistry()).find(m => m.id === id)
      // The INSTANT goes down with the name. A session can also be renamed from inside the harness,
      // and recency is the only non-arbitrary way to settle a disagreement between the two — a
      // stored name with no timestamp cannot take part in that. See `pickTitle`.
      const ok = await patchSession(id, { label, labelSince: Date.now() })
      if (!ok || !managed) return ok
        ? { ok: true, message: s.sessRenamed }
        : { ok: false, message: s.sessNoRegistryEntry }

      const backend = await resolveBackend()
      // A backend that cannot run at all is not a failed rename — the label is written and the row
      // reads correctly. It is the harness half that did not happen, and it is reported as such.
      const blocked = await backend.unavailable()
      const outcome = blocked
        ? ({ kind: 'skipped', reason: 'not-running' } as const)
        : await renameInHarness({ id, harness: managed.harness }, label.trim(), backend)
      return { ok: true, message: renameMessage(outcome, managed.harness, s) }
    },

    async noteSession(id: string, text: string): Promise<ActionResult> {
      const s = S()
      const ok = await patchSession(id, { note: text })
      return ok ? { ok: true, message: s.sessNoted } : { ok: false, message: s.sessNoRegistryEntry }
    },

    /** Every task in use, most-used first — the order that puts what you are working on at the top. */
    async sessionTasks(): Promise<string[]> {
      const counts = new Map<string, number>()
      for (const m of await readRegistry()) {
        if (!m.task) continue
        counts.set(m.task, (counts.get(m.task) ?? 0) + 1)
      }
      return [...counts.entries()]
        .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
        .map(([task]) => task)
    },

    async taskSession(id: string, task: string): Promise<ActionResult> {
      const s = S()
      const ok = await patchSession(id, { task })
      return ok ? { ok: true, message: s.sessTasked } : { ok: false, message: s.sessNoRegistryEntry }
    },

    /**
     * Reopen a conversation as a NEW managed session.
     *
     * The only way the cockpit can act on something it did not start: it cannot attach to a foreign
     * process, but it can start a session that resumes the same conversation. The new session
     * inherits the conversation's NAME, so the row keeps reading the same after the swap.
     */
    async resumeSession(req: ResumeSessionRequest): Promise<SpawnSessionResult> {
      const s = S()
      // What the old row knew about this work — its task and its note — comes with it. A reopen
      // that dropped them would file the recovered session nowhere and lose what someone wrote
      // about it, which is most of the reason the row was worth keeping across the reboot.
      const previous = req.replaces
        ? (await readRegistry()).find(m => m.id === req.replaces)
        : undefined
      // THE LOCK ON THE DOOR — and, for one kind of holder, the door opening instead.
      //
      // Two assistants in one transcript and one working tree is the worst thing this feature has
      // done, so nothing is spawned before asking who holds the conversation. But WHO holds it
      // decides what the answer means:
      //
      //  - a MANAGED row is somewhere to go. It has a pane, `o` attaches to it, and "open it there"
      //    is an instruction the user can follow. Still refused, unchanged.
      //  - a PROCESS is not somewhere to go. An assistant started by hand has no pane to attach to,
      //    and the refusal named its DIRECTORY — which is not a place. There was no verb that could
      //    do anything with it either, so the row was a dead end: visible, and inert. Reported.
      //
      // For that second case the conversation is on DISK, so ending the process and reopening the
      // same id under tmux costs the turn in flight and nothing else — and puts the work back under
      // every verb this screen has. That is a takeover, and it is what `resume` now does rather
      // than a verb of its own: the user already pressed the key that means "put this conversation
      // in front of me".
      // THE DECISION IS `planTakeover`, which already existed and which this code did not use.
      //
      // `cli-session.ts` had been taking a conversation over since the CLI gained the verb, through
      // that pure planner. This method grew its own copy of the same gesture — the exact drift
      // `task-reopen.ts` was extracted to end — and the copy was WORSE in a way that costs work: it
      // killed the holder and then tried to resume, so a harness that cannot reopen by id would
      // have had its assistant closed for nothing. The planner refuses `resume-unsupported` BEFORE
      // anything is signalled, which is the whole reason it is a plan rather than an action.
      const holder = conversationHeldBy(
        await liveConversationHolders(await resolveBackend()),
        req.sessionId,
        req.replaces,
      )
      // A managed row is somewhere to go: it has a pane and `o` attaches to it, so "open it there"
      // is an instruction the user can follow. It never becomes a takeover.
      if (holder?.kind === 'managed') return { ok: false, message: s.sessResumeInUse(holder.label) }

      const harness = req.harness as HarnessId
      const plan = planTakeover({
        conversationId: req.sessionId,
        harness,
        resumable: planSpawn({ harness, cwd: req.cwd, resumeId: req.sessionId }).ok,
        ...(holder?.kind === 'process'
          ? { holder: { ...(holder.pid !== undefined ? { pid: holder.pid } : {}), label: holder.label, cwd: req.cwd } }
          : {}),
        cwd: req.cwd,
      })
      if (plan.kind === 'refuse') return { ok: false, message: s.sessTakeoverRefused(plan.reason) }
      if (plan.kind === 'takeover') {
        // A pid is not an identity — see `isAssistantPid`. Confirmed against the live scan in the
        // moment before signalling, or the takeover is abandoned: the cost of being wrong here is
        // SIGKILL on somebody else's process. The planner cannot do this: it is pure, and this is a
        // question only the machine can answer, in the instant before the signal.
        if (plan.holder.pid === undefined || !await isAssistantPid(plan.holder.pid)) {
          return { ok: false, message: s.sessResumeInUse(plan.holder.label ?? req.sessionId) }
        }
        const ended = await endProcess(plan.holder.pid)
        if (!ended) return { ok: false, message: s.sessAdoptFailed(plan.holder.label ?? req.sessionId) }
      }
      const spawned = await spawnManaged({
        harness: req.harness as HarnessId,
        cwd: req.cwd,
        resumeId: req.sessionId,
        label: req.label,
        attach: req.attach,
        ...(previous?.task ? { task: previous.task } : {}),
      }, s)
      if (spawned.ok) {
        // We handed this id to the CLI, so the new row KNOWS which conversation it drives — there
        // is no guessing left for the next reopen. Without it the fallback matches on directory
        // alone, and every session in one repository resolves to the same conversation.
        if (spawned.id) await patchSession(spawned.id, { conversationId: req.sessionId })
        if (previous?.note && spawned.id) await patchSession(spawned.id, { note: previous.note })
        // The old row is RETIRED rather than deleted: it is still a thing that happened, and it
        // stops standing beside its own continuation with the same name on it.
        if (previous) await patchSession(previous.id, { endedAt: new Date().toISOString() })

        const liveBackend = await (await resolveBackend()).list().catch(() => [])
        const backendIds = new Set(liveBackend.map(b => b.id))
        await retireFallenSessions({
          newSessionId: spawned.id,
          conversationId: req.sessionId,
          cwd: req.cwd,
          harness: req.harness,
          backendIds,
        })

        // The store's view of what is running just changed, and the next poll must see it rather
        // than waiting out the cache and showing the conversation as still closed.
        forgetConversations()
      }
      return spawned
    },

    /**
     * Reopen every session of one task, detached.
     *
     * The whole point of naming a task is getting its work back at once. Sessions whose conversation
     * cannot be resolved are SKIPPED AND COUNTED — a partial reopen reported as a success would
     * leave someone believing they had their whole task back when they did not.
     */
    async openTask(task: string): Promise<ActionResult> {
      const s = S()
      const wanted = (await readRegistry()).filter(m => m.task === task)
      if (wanted.length === 0) return { ok: false, message: s.sessTaskEmpty(task) }

      // The DECISION is the pure `planTaskReopen`, and the PERFORMANCE is `reopenEntries` — shared
      // with `reopenFell` below, which is the same gesture over a set chosen a different way.
      const { plan, opened, skipped } = await reopenEntries(wanted, s)
      return taskReopenSucceeded(plan, opened)
        ? { ok: true, message: s.sessTaskOpened(task, opened, skipped, plan.heldElsewhere.length) }
        : { ok: false, message: s.sessTaskNoneOpened(task, skipped) }
    },

    /**
     * Reopen everything the machine took at once.
     *
     * The set is recomputed HERE rather than taken from the snapshot the screen is showing: a
     * snapshot is up to five seconds old, and this spawns real assistants. Recomputing costs one
     * registry read and one `tmux list-sessions`, and it is the difference between reopening what
     * fell and reopening what fell as of a moment ago.
     */
    async reopenFell(): Promise<ActionResult> {
      const s = S()
      const backend = await resolveBackend()
      const blocked = await backend.unavailable()
      if (blocked) return { ok: false, message: blocked }

      const backendIds = new Set((await backend.list().catch(() => [])).map(b => b.id))
      const group = planCrashGroup({ entries: await readRegistry(), backendIds })
      if (!group || group.entries.length === 0) return { ok: false, message: s.sessNoFell }

      const { plan, opened, skipped } = await reopenEntries(group.entries, s)
      return taskReopenSucceeded(plan, opened)
        ? { ok: true, message: s.sessFellOpened(opened, skipped, plan.heldElsewhere.length) }
        : { ok: false, message: s.sessFellNoneOpened(skipped) }
    },

    /**
     * Type one line into a session and submit it, without attaching.
     *
     * The screen is RE-READ here rather than trusted from the snapshot, and that is the whole of the
     * safety: a session that was working five seconds ago may be sitting on a permission prompt now,
     * where its input line is a menu and a typed sentence is an answer to a question nobody read. A
     * poll-old belief is not good enough to write into somebody's session on.
     */
    async promptSession(id: string, text: string): Promise<ActionResult> {
      const s = S()
      const body = text.trim()
      if (!body) return { ok: false, message: s.sessPromptEmpty }

      const backend = await resolveBackend()
      const blocked = await backend.unavailable()
      if (blocked) return { ok: false, message: blocked }

      const managed = (await readRegistry()).find(m => m.id === id)
      if (!managed) return { ok: false, message: s.sessNoRegistryEntry }

      const live = (await backend.list().catch(() => [])).find(b => b.id === id)
      if (!live?.alive) return { ok: false, message: s.sessNotRunning }

      const frame = await backend.capture(id, SEND_CAPTURE_LINES).catch(() => [] as string[])
      const rules = rulesFor(managed.harness)
      if (rules && rules.approval.some(re => re.test(frame.join('\n')))) {
        return { ok: false, message: s.sessPromptBlocked }
      }

      return (await backend.sendText(id, body))
        ? { ok: true, message: s.sessPrompted(id) }
        : { ok: false, message: s.sessSendFailed(id) }
    },

    /**
     * Answer the dialog this session is blocked on.
     *
     * Everything is checked at THIS instant rather than assumed from a snapshot: the session is
     * still asking, the options on screen are still the ones the user was shown, and the harness has
     * a verified way to select the one they picked. A snapshot is up to five seconds old, and an
     * answer sent to a question that has changed underneath it is both wrong and silent.
     */
    async answerSession(id: string, choice?: number, text?: string): Promise<ActionResult> {
      const s = S()
      const backend = await resolveBackend()
      const blocked = await backend.unavailable()
      if (blocked) return { ok: false, message: blocked }

      const managed = (await readRegistry()).find(m => m.id === id)
      if (!managed) return { ok: false, message: s.sessNoRegistryEntry }

      const spec = approvalFor(managed.harness)
      if (!spec) return { ok: false, message: s.sessApproveUnknown(managed.harness) }

      const live = (await backend.list().catch(() => [])).find(b => b.id === id)
      if (!live?.alive) return { ok: false, message: s.sessNotRunning }

      const rules = rulesFor(managed.harness)
      const frame = await backend.capture(id, SEND_CAPTURE_LINES).catch(() => [] as string[])
      if (!rules || !rules.approval.some(re => re.test(frame.join('\n')))) {
        return { ok: false, message: s.sessNotAsking }
      }

      // What is on the screen RIGHT NOW, not what was drawn up to a poll ago.
      const options = parseDialogOptions(frame)

      if (needsChoice(options)) {
        // A numbered dialog is NEVER answered with a bare confirm. `Enter` takes whichever row is
        // highlighted, and on "only my fix / promote everything / stop here / type something" that
        // is choosing between four different outcomes on somebody else's repository.
        if (choice === undefined) return { ok: false, message: s.sessNeedsChoice(options.length) }
        const picked = options.find(o => o.number === choice)
        // The question CHANGED between being shown and being answered. Sending "3" to a question
        // that now has different answers is worse than sending nothing, and nothing about it would
        // be visible afterwards — so it is refused by name.
        if (!picked) return { ok: false, message: s.sessChoiceGone }
        const key = choiceKey(spec, choice)
        if (!key) return { ok: false, message: s.sessChooseUnknown(managed.harness) }

        /*
         * THE FREE-TEXT OPTION IS NOT ANSWERED BY PICKING IT.
         *
         * Measured on a live dialog: the digit moves the cursor onto `Type something.` and turns
         * the row into a FIELD — it does not submit. Every further digit is then typed INTO that
         * field, which is how a card that kept being pressed produced `33333333333333333`.
         *
         * So the three steps the person would take by hand are taken here: the digit, the words,
         * the return. Reproduced exactly before it was written — `3`, then the literal `capivara`,
         * then Enter, and the session answered "você respondeu capivara".
         *
         * WITH NO TEXT it is refused rather than confirmed. Pressing Enter on an empty field reads
         * as declining the question outright — measured, the session logged "User declined to
         * answer questions" — which is a different answer from the one anybody meant to give.
         */
        if (isFreeTextOption(managed.harness, picked.label)) {
          const answer = (text ?? '').trim()
          if (!answer) return { ok: false, message: s.sessAnswerNeedsText }
          if (!backend.sendChoiceText) return { ok: false, message: s.sessChooseUnknown(managed.harness) }
          return (await backend.sendChoiceText(id, key, answer))
            ? { ok: true, message: s.sessAnswered(answer) }
            : { ok: false, message: s.sessSendFailed(id) }
        }
        return (await backend.sendKey(id, key))
          ? { ok: true, message: s.sessAnswered(picked.label) }
          : { ok: false, message: s.sessSendFailed(id) }
      }

      // No readable options: the codex-shaped `Press enter to continue`, where there genuinely is
      // nothing to choose between. A choice offered here would be answering a question with no
      // answers, so it is refused rather than quietly ignored.
      if (choice !== undefined) return { ok: false, message: s.sessChoiceGone }
      return (await backend.sendKey(id, spec.key))
        ? { ok: true, message: s.sessApproved(id) }
        : { ok: false, message: s.sessSendFailed(id) }
    },

    /**
     * Derived from `SPAWN_SPECS`, never a second hand-written list.
     *
     * A harness with no spec is ABSENT from the wizard rather than offered and failing — the same
     * rule `agentop session`'s `STARTABLE` already follows, and the reason the two can never drift.
     */
    async startableHarnesses(): Promise<SessionHarnessOption[]> {
      // Narrowed to the CLIs actually ON THIS MACHINE, through the one helper `cli-hooks.ts` also
      // asks — a spec says how to run `codex`, not that codex exists here, and offering the other
      // five started a tmux session that died on `command not found` behind a screen nobody was
      // watching. `availableHarnesses` answers with ALL of them when it cannot tell, because an
      // empty wizard is indistinguishable from a broken one.
      const { ids } = availableHarnesses()
      return ids.flatMap(id => {
        const spec = SPAWN_SPECS[id]
        if (!spec) return []
        return [{
          id,
          label: id,
          modelSuggestions: spec.modelSuggestions,
          // Spread only when the spec HAS one: an explicit `undefined` and an absent key read the
          // same in TypeScript and differently once JSON.stringify has been over them.
          ...(spec.defaultModel ? { defaultModel: spec.defaultModel } : {}),
          supportsModel: spec.modelFlag !== undefined,
          efforts: spec.efforts ?? [],
          ...(spec.defaultEffort ? { defaultEffort: spec.defaultEffort } : {}),
        }]
      })
    },

    async searchProjects(query: string): Promise<ProjectOption[]> {
      const found = await findProjects(query, process.cwd())
      return found.map(c => ({
        path: c.path,
        // Name and repo travel SEPARATELY: the picker aligns them into columns, and a pre-joined
        // label is one cell holding two facts that no column arithmetic can take apart again.
        label: c.name,
        ...(c.remote ? { repo: repoShortName(c.remote) } : {}),
        detail: candidatePath(c, homedir()),
        source: c.source,
      }))
    },

    /**
     * Start a session, and — when it was asked for attached — hand back what it takes to enter it.
     *
     * The plan is checked BEFORE anything is spawned, so an unsupported flag is a sentence rather
     * than a session that starts and immediately dies with a usage error on a screen nobody sees.
     */
    async spawnSession(req: SpawnSessionRequest): Promise<SpawnSessionResult> {
      return spawnManaged({
        harness: req.harness as HarnessId,
        cwd: req.cwd,
        attach: req.attach,
        ...(req.prompt ? { prompt: req.prompt } : {}),
        ...(req.model ? { model: req.model } : {}),
        ...(req.effort ? { effort: req.effort } : {}),
        ...(req.label ? { label: req.label } : {}),
        ...(req.task ? { task: req.task } : {}),
      }, S())
    },
  }
}

// ---------------------------------------------------------------------------

/**
 * `agentop` / `agentop start` — open the control center, then act on how it exited.
 *
 * Without an interactive stdin nothing is drawn at all: the caller runs the server, exactly as a
 * systemd unit or a pipe has always done.
 */
/**
 * The poller's RAW snapshot, for `/api/fleet/snapshot`.
 *
 * `createControlHost().sessions()` answers `ControlSessions` — already mapped, already localized,
 * shaped for drawing a row. The other agentop processes need what came BEFORE that mapping, because
 * each of them maps it its own way (`toControlSession` for the cockpit, `fleetJson` for
 * `session ls`, a hand-built summary for the hook). Serving the mapped shape and typing it as the
 * raw one is a silent field mismatch: it was written that way first, and `session ls --json` came
 * back with `activity: null` on every row.
 *
 * It is the SAME poller `sessions()` uses, so the server still holds exactly one.
 */
export async function readRawFleetSnapshot(): Promise<SessionSnapshot> {
  return (await ensureSessionsPoller()).poll()
}

export async function runStart(): Promise<StartResult> {
  if (!process.stdin.isTTY) return 'foreground'

  const lang = await resolveLang()
  const [{ runControlCenter }, { altScreen }] = await Promise.all([
    import('@agentistics/tui/control'),
    import('@agentistics/tui/control/altScreen'),
  ])

  const host = createControlHost(lang, altScreen)

  // A machine that has never been configured still opens on the WIZARD — it is just no longer a tab
  // of its own. Setup is a question the cockpit asks, drawn in the detail region like every other
  // one, so "open on setup" is now "open the cockpit with the question up": `initial.setup`. Landing
  // an unconfigured user on a list of services to start would still leave the mode and the
  // history-preservation consent behind something they have no reason to look for.
  const setup = await isUnconfigured()
  let tab: TabId | undefined

  // Attach and detach are two halves of ONE gesture, so this is a loop rather than an exit. The Ink
  // app never execs anything: it unmounts, the session gets the real tty here, and when the user
  // detaches the control center comes back up on the tab they left from. Anything else would make
  // "look at a session" a one-way trip out of the application.
  // The wizard is offered on the FIRST pass only. Detaching from a session re-enters the loop, and
  // a question that greeted the user again there would be one they learn to dismiss without reading.
  let opening = setup
  for (;;) {
    // `host.lang`, never the `lang` this function resolved at boot. The language is a closure
    // variable the in-app toggle REASSIGNS, so the boot value is stale the moment anyone switches —
    // and every pass through this loop remounted the app with it. Attaching to a session and
    // detaching was enough to put the whole cockpit back into the previous language, with nothing
    // on screen to explain it and nothing to do about it but restart the application, which is how
    // it was reported. `execAttachTicket` below already read it correctly.
    const exit = await runControlCenter({ lang: host.lang, host, tab, setup: opening })
    opening = false
    if (exit.kind === 'foreground') break
    if (exit.kind === 'quit') return exit.code
    await execAttachTicket(exit.ticket, cliStrings(host.lang))
    tab = 'sessions'
  }

  // The terminal is ours again, so the two questions the foreground start has always asked can be
  // asked the way they always were — and in the same order: free the port first (a refusal aborts
  // the start), then the archive consent, which must not be answered for a server that never runs.
  const s = cliStrings(host.lang)
  if (!(await clearPortOrAbort(s, await isServerRunning()))) return 0
  await ensureArchiveModeChosen()
  return 'foreground'
}
