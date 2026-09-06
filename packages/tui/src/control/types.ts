/**
 * types.ts — the contract between the control center (presentation) and its host (logic).
 *
 * The Ink layer owns NO logic: `cli-start.ts` still decides what the service state is, what the
 * choices are and what each action does. It implements `ControlHost`; the components below render
 * already-localized strings and report intents through it. Keeping the split this way is what
 * lets the whole surface be rewritten without changing a single behaviour.
 */

import type { HarnessId } from '@agentistics/core'
import type { CliLang } from './lang'
import type { GithubSection } from './backup'
import type { SearchFields, SearchScope } from './search-scope'
// The default ARRANGEMENT is derived from the dimension vocabulary rather than written out beside
// it. `session-dimensions.ts` imports this file for TYPES only, so this is the one value direction.
import {
  DEFAULT_FILTERS, DEFAULT_MARKED, DEFAULT_SHOW_NAMED, storedFilters,
  type SessionGroupingId,
} from './session-dimensions'

export type TabId =
  | 'services'
  | 'sessions'
  /** Configure, run, and watch a backup — see `control/backup.ts`. Between sessions and the
   *  dashboard: an operation over the data, and operations come before the numbers. */
  | 'backup'
  /** The metrics dashboard — the whole of what `agentop tui` shows, as a screen of this app. */
  | 'dashboard'
  | 'hardware'
  | 'logs'
  | 'cheatsheet'
  | 'help'
  | 'contribute'

// Operations first (what is running, and what you can do to it), then the numbers, then the
// documentation. The dashboard sits where it does because it answers a question about the same work
// the two screens before it are managing.
//
// There is no `setup` screen any more, and its absence is the point: choosing solo / central /
// member is a question ABOUT the services on this box — you cannot re-run `central.sh init` on a
// central that is up, and the only way to know that is to be looking at whether it is up. The
// wizard is a QUESTION the cockpit asks, drawn in the detail region like every other one, reached
// from the config pane's mode row. `agentop setup` still exists as the non-interactive command —
// one implementation, two entrances.
export const TAB_ORDER: readonly TabId[] = [
  'services',
  'sessions',
  'backup',
  'dashboard',
  'hardware',
  'logs',
  'cheatsheet',
  'help',
  'contribute',
] as const

/** A service is `unknown` when detection itself failed (no docker, no lsof) — never assume down. */
export type ServiceState = 'up' | 'down' | 'unknown'

/**
 * A LOGICAL service — what the user thinks about, and what the list shows one row per.
 *
 * There are two, and only two: the analytics server itself, and the team central. The ways of
 * running each of them are `RuntimeId`s below, and they are NOT services. Listing them as if they
 * were is what made the screen offer to start a Docker copy of a server that was already running
 * natively: the same program, the same files, the same port, presented as two independent things
 * the user could start independently. CLAUDE.md states outright that the two must never both run.
 */
export type ServiceId = 'agentistics' | 'central'

/**
 * One concrete way to run a logical service — an implementation detail of the host.
 *
 * `local` is the native process, `machine` is the same program inside a container
 * (docker/machine.yml), and `central` is the team central's container. A `RuntimeId`
 * appears in the contract only where an action or a log genuinely has to name ONE of them: the
 * conflict case (both runtimes of `agentistics` up at once), a start option, and the full-screen
 * Logs screen's source selector.
 */
export type RuntimeId = 'local' | 'machine' | 'central'

/**
 * How a runtime runs — the word a row and a pane badge wear.
 *
 * Deliberately untranslated: `native` and `docker` are the same two words in both languages, and
 * they are the words the CLI, the compose files and the docs already use.
 */
export type ServiceRuntime = 'native' | 'docker'

/**
 * One concrete way to BRING UP a central — a second dimension from `RuntimeId`, and not a
 * duplicate of it.
 *
 * `RuntimeId` answers "which of this box's things is this row about"; this answers "which shape of
 * the same central". The three are genuinely different deployments of one program: build the image
 * from a checkout, pull the published one, or run the binary itself with no Docker at all. The
 * cockpit needs the distinction because it offers them as separate start verbs — the screen used
 * to show ONE "Start" whose meaning was inferred from what happened to be on disk, so a user with
 * a clone could not ask for the published image and had nowhere to see why.
 *
 * Declared here rather than imported: the dependency direction is `server -> tui`, so this package
 * may not reach into `packages/server`. `central-runtime.test.ts` cross-checks this union against
 * the server's `CENTRAL_RUNTIMES`, which is what stops the two definitions drifting.
 */
export type CentralRuntimeId = 'docker-build' | 'docker-image' | 'native'

/**
 * Anything an action or a log read can name: a logical service, or one exact runtime of one.
 *
 * `central` is a member of both halves, which is not an accident and not an ambiguity — the central
 * has exactly one runtime, so naming the service and naming its runtime are the same instruction.
 */
export type ServiceRef = ServiceId | RuntimeId

/** Which services an action targets. `all` means every runtime currently up. */
export type ActionTarget = ServiceRef | 'all'

export type LogSource = ServiceRef

/**
 * One runtime of a logical service, as the host currently sees it.
 *
 * Every field past `available` is OPTIONAL and absent whenever it could not be detected — a missing
 * pid is `undefined`, never `0`, and a runtime whose uptime the OS would not give up says nothing
 * rather than claiming it started this instant. The N/A-versus-real-0 rule the dashboard follows
 * for harness capabilities applies here for the same reason: a confident wrong number is worse
 * than an honest gap, and the user acts on what this screen says.
 */
export interface ServiceRuntimeState {
  id: RuntimeId
  kind: ServiceRuntime
  state: ServiceState
  /**
   * Whether this box can run it AT ALL — false when the runtime's prerequisite is missing (docker
   * not installed). It is what keeps an honest `unknown` from spreading: a container runtime on a
   * box with no docker cannot be running, so it neither makes its service's state unknown nor gets
   * offered as a start option. A verb that cannot possibly work is worse than a missing one.
   */
  available: boolean
  /** Why this runtime's state is `unknown`, already localized. */
  reason?: string
  /** OS pid of a native process, or the container's main pid. */
  pid?: number
  /**
   * When the process started, as epoch milliseconds.
   *
   * An instant rather than a duration on purpose: the detail pane repaints far more often than the
   * status refreshes, and a "seconds so far" number would freeze at whatever it was when the host
   * last looked while the clock beside it kept moving. Formatting is the UI's job.
   */
  startedAt?: number
  /** The dashboard URL, when the runtime serves one. */
  webUrl?: string
  /** The api + mcp URL, when it is a DIFFERENT port from the dashboard's. */
  apiUrl?: string
}

/**
 * `fg` (attached — runs on this terminal, or the docker/native equivalent of that) versus `bg`
 * (detached — returns immediately, keeps running). Every runtime that CAN run has both shapes now:
 * `local` always did, `machine` runs `docker compose up [--build]` with or without `-d`, and
 * `central` offers it only when a native start is even possible (see `StartFacts.centralPlan`) —
 * the Docker central still has one shape, `bg`, because its `up` (central.sh or the standalone
 * image path) has no attached variant.
 */
export type StartHow = 'fg' | 'bg'

/** What `ControlHost.start` needs: which runtime, and — natively — whether it keeps this terminal. */
export interface StartRequest {
  runtime: RuntimeId
  how?: StartHow
  /**
   * For `central` only: which SHAPE of central to bring up.
   *
   * Absent means "whatever this central is configured with", which is what every start meant
   * before the cockpit offered the choice — so an existing deployment keeps coming up exactly as
   * it did. The host turns it into the same `--image` / `--build` / `--native` the CLI takes, so
   * pressing a verb here and typing the command are one code path.
   */
  centralRuntime?: CentralRuntimeId
}

/**
 * A start the host is offering, ready to be drawn and handed straight back to `start()`.
 *
 * The host composes these because it is the only side that knows what this box can actually run:
 * without docker there is no container option, and while anything is up there are no start options
 * at all — which is precisely the fix for "it offered to start a docker copy while one was already
 * running". The UI renders `label`/`hint` and returns the value; it decides nothing.
 */
export interface StartOption extends StartRequest {
  /** Already-localized verb, e.g. "Start (docker)". */
  label: string
  /** Already-localized one-line explanation, for surfaces that show hints. */
  hint?: string
  /**
   * The runtime this start would collide with, when there is one.
   *
   * The api port is single-occupancy, so taking it means stopping whatever holds it — and WHICH
   * runtime that is is host knowledge. The UI reads this to know that the collision question
   * applies and what to stop when the answer is yes; it used to know instead that `local` was the
   * runtime with a port, which is a rule about the product living in the presentation layer.
   */
  blockedBy?: RuntimeId
  /**
   * This start records history, so the archive consent gate applies before it runs.
   *
   * A container start does not ask: `runStart()` never has, and the gate belongs to the process
   * that will be writing to `~/.agentistics`.
   */
  asksArchive?: boolean
  /**
   * Worth asking whether it should come back on boot, once it worked.
   *
   * True only for a DETACHED option — a foreground one holds the terminal (or, for a container,
   * blocks it under `suspend` until Ctrl-C), so the question would be about something that has not
   * finished happening yet. Among the detached options, it is further true only where a genuine,
   * separate boot mechanism exists: `local` background installs the native `agentop-server` unit,
   * `machine` background installs `agentop-machine` (`docker compose … up -d`), Docker `central`
   * keeps its existing `agentop-central` unit. A NATIVE central background start does not offer
   * it — no native-central systemd unit exists yet, and installing the Docker one would claim a
   * mechanism that does not match what actually started.
   */
  offersBoot?: boolean
}

/**
 * One boot registration this box can turn ON or OFF, ready to be drawn and handed back.
 *
 * It exists because `enableBoot` alone was a switch with one position. A service registered at boot
 * comes back after every reboot and after every login that starts the user's systemd manager, so a
 * user who deliberately stopped their central found it running again and had nowhere in the product
 * to say "stay down" — the machine could disable it (`disableAutostart` has always existed), the
 * cockpit simply had no way to ask.
 *
 * Composed by the host for the same reason `StartOption` is: WHICH mechanism brings a service back
 * is a fact about this box (`agentistics` has two — a native unit and one that runs `docker compose
 * … up -d` — and the central has one), and whether a mechanism can be registered here at all
 * depends on files only the host can look for. A mechanism the host cannot ask about produces NO
 * option, never a disabled one: the same absence-is-absence rule `ControlService.boot` follows.
 */
export interface BootOption {
  /** The runtime this registration brings back. Handed straight back to `enableBoot`/`disableBoot`. */
  runtime?: RuntimeId
  /** True turns it on (`enableBoot`), false turns it off (`disableBoot`). */
  enable: boolean
  /** Already-localized verb, e.g. "Start at boot (native)" / "Stop starting at boot (docker)". */
  label: string
  /** Already-localized one-line explanation, for surfaces that show hints. */
  hint?: string
  /**
   * Already-localized sentence stating exactly what pressing it does, NAMING the unit.
   *
   * The confirmation may not be "are you sure?": this writes or removes a systemd user unit, which
   * is a change to the machine that outlives the session. Naming the unit is also the only way the
   * answer to "what keeps bringing my central back" is discoverable from inside agentop.
   */
  confirm: string
  /**
   * The same question asked in the OTHER place it comes up: unprompted, right after a stop worked.
   *
   * Present only on a disable option, because that is the only direction that case has. It needs its
   * own sentence because the user did not press a boot verb to get here — "Remove <unit>?" appearing
   * on its own after `Stop` reads as a non sequitur, while "…is stopped, but <unit> still starts it
   * at boot" states why it is being asked at all.
   */
  confirmAfterStop?: string
}

/** A stop that names ONE runtime — offered only to break a conflict. */
export interface StopOption {
  runtime: RuntimeId
  /** Already-localized verb, e.g. "Stop (native)". */
  label: string
}

/** What `ControlHost.restart` needs: what to bounce, and whether to rebuild it on the way. */
export interface RestartRequest {
  target: ActionTarget
  /**
   * Rebuild before restarting instead of just bouncing what is already built.
   *
   * What that MEANS is per runtime and is the host's business: the native server recompiles the
   * binary (`bun run bin`), a container rebuilds its image and is recreated, the central goes
   * through its own `up`. The UI hands the flag back and learns none of it.
   */
  rebuild?: boolean
}

/**
 * A restart the host is offering, ready to be drawn and handed straight back to `restart()`.
 *
 * Composed by the host for the same reason `StartOption` is: whether a rebuild can work here is a
 * fact about this box, not about this screen. The native rebuild needs the repo checkout and the
 * machine's needs its compose file, so on a box without them the option is ABSENT rather than
 * present and failing — a verb that cannot work is worse than a missing one.
 */
export interface RestartOption extends RestartRequest {
  /** Already-localized verb, e.g. "Restart" / "Rebuild & restart (docker)". */
  label: string
  /** Already-localized one-line explanation, for surfaces that show hints. */
  hint?: string
}

/**
 * One logical service, as the host currently sees it.
 *
 * The list shows one row per service whether it is up or down — a stopped central stays visible
 * (dim) rather than being hidden, because hiding it would turn "start the central" into a hunt
 * through a menu. What changes with the state is what the row can DO: a running service offers
 * restart / stop / open and no start at all, a stopped one offers exactly the starts this box can
 * perform.
 */
export interface ControlService {
  id: ServiceId
  /** Already-localized name — "agentistics", "agentistics central". */
  label: string
  /**
   * The service's state, aggregated from its runtimes: `up` when any runtime is up, `unknown` when
   * an AVAILABLE runtime could not be probed, `down` only when every runtime is confidently down.
   */
  state: ServiceState
  /** Every runtime this box could run it under, in the order they are offered. */
  runtimes: ServiceRuntimeState[]
  /** The runtimes that are up right now, in that same order. Empty when nothing is up. */
  running: RuntimeId[]
  /** The runtime the detail pane describes: the first running one, absent when nothing is up. */
  active?: ServiceRuntimeState
  /**
   * Set when MORE THAN ONE runtime of this service is up at once — already localized, and naming
   * both runtimes.
   *
   * The state must never be normalised away by showing one of the two: they read the same files and
   * fight over the same port, so a user shown half of it would act on a half-truth. Its presence is
   * the flag; pair it with a word as well as a colour, and offer `stopOptions`.
   */
  conflict?: string
  /**
   * A SECOND copy of this service running under the SAME runtime, serving nothing — already
   * localized and naming the pid.
   *
   * Deliberately not folded into `conflict`, which is about two RUNTIMES and offers a per-runtime
   * stop. This one is two processes of the one runtime, and the two cases need different sentences:
   * "it is running natively and in docker, stop one" is a choice, while "a second one is running and
   * answering nothing" is waste with a pid on it.
   *
   * It exists because the runtime probe cannot see this by construction — it asks
   * `lsof -sTCP:LISTEN`, which only ever finds the process that WON the port. Measured: two
   * `agentop server`s ran for seventy minutes, the loser burning 72% of a core and 1.1 GB on the
   * file watcher, and every screen in the product said the service was healthy.
   *
   * The pid is the point. "Something is wrong" that cannot be acted on is a worse message than none.
   */
  idle?: string
  /** Why the state is `unknown`, already localized. */
  reason?: string
  /**
   * Whether it comes back on boot — `undefined` when the host cannot tell, never a guess.
   *
   * A state rather than a localized string, exactly like `ServiceState`: the two words are chrome
   * the TUI owns, and the host is the only side that can answer the question.
   */
  boot?: BootState
  /**
   * WHAT brings it back — the systemd unit name, present only when `boot` is known.
   *
   * A proper noun, deliberately untranslated, and the whole of the honest trail: "starts at boot" on
   * its own tells a user that something will restart their central and gives them nothing to go
   * look at. With the unit named, `systemctl --user status <unit>` and `agentop autostart status`
   * both answer, and the verb that turns it off is on the same pane.
   */
  bootUnit?: string
  /**
   * The boot registrations this box can change right now — on, off, or both, per mechanism.
   *
   * Offered whatever the service's state, unlike `startOptions`/`restartOptions`: "should this come
   * back after a reboot" is a question about the FUTURE and is just as answerable while the thing is
   * running as while it is stopped. Empty on a box the host cannot ask (no user systemd), which is
   * why the verbs are absent there rather than present and failing.
   */
  bootOptions: BootOption[]
  /** The starts this box can perform right now. ALWAYS EMPTY while the service is up. */
  startOptions: StartOption[]
  /**
   * Already-localized sentences naming the starts this box CANNOT perform, and why.
   *
   * The absent-beats-present-and-failing rule says a verb that cannot work is not offered. On its
   * own that leaves the opposite problem: a central offering one way to start when the operator
   * knows there are three reads as a broken screen, and nothing on it says `--native` is missing
   * because the database is the bundled one. So the verbs stay absent and the REASONS are said, in
   * the detail pane, where there is room for a sentence.
   *
   * Empty whenever nothing is withheld — never a "nothing is blocked" line, which is a row spent
   * on the absence of news.
   */
  startNotes?: string[]
  /**
   * The restarts this box can perform right now — the plain bounce, plus a rebuild wherever the
   * pieces a rebuild needs are actually here. ALWAYS EMPTY while the service is down.
   *
   * The mirror image of `startOptions`, and for the same reason: there is nothing to restart until
   * something is running, and nothing to start while something is.
   */
  restartOptions: RestartOption[]
  /** Per-runtime stops, populated only while more than one runtime is up. */
  stopOptions: StopOption[]
}

/**
 * Whether a service is registered to come back on its own after a reboot.
 *
 * ABSENT means the host could not tell — there is no user systemd on this platform, or the probe
 * itself failed — and the detail pane then says NOTHING about boot rather than "no". A service that
 * silently claims it will not restart is the fact a user acts on by installing a second copy of it.
 */
export type BootState = 'on' | 'off'

// ---------------------------------------------------------------------------
// the backup tab
// ---------------------------------------------------------------------------

/**
 * Redeclared from `server/backup/backup-plan.ts`'s `BackupLayer` — `packages/tui` may not import
 * from `packages/server` (server -> tui is the only allowed direction). `backup-plan.test.ts`
 * cross-checks this union against `BACKUP_LAYERS`, member for member, the same guard
 * `central-runtime.test.ts` runs for `CentralRuntimeId`.
 */
export type BackupLayer = 'metrics' | 'repos' | 'archive' | 'raw'

/** Redeclared from `server/backup/schedule.ts`'s `ScheduleId` — same cross-check discipline,
 *  asserted in `schedule.test.ts`. */
export type BackupScheduleId = 'off' | 'daily' | 'weekly' | 'custom'

/**
 * One harness's own coverage — see the backup tab's rule: last-backup is PER HARNESS, never a
 * single date at the top, or an unticked harness would read as covered.
 */
export interface ControlBackupHarness {
  id: HarnessId
  /** Whether this harness rides the NEXT backup — `space` toggles it. */
  enabled: boolean
  sessions: number
  /** Already-formatted, e.g. "3.4 MB" — see `backup-size.ts`'s `formatBytes`. */
  sizeLabel: string
  /**
   * ISO of the newest backup that both covered this harness AND whose file is still on disk.
   *
   * An INSTANT rather than a formatted age, exactly like `ServiceRuntimeState.startedAt`: the age
   * is recomputed every repaint against `now` so it does not freeze between polls.
   *
   * Absent when there is no such backup — see `lastBackupGone` for the other kind of absence.
   */
  lastBackupAt?: string
  /**
   * A backup once covered this harness, and that file is gone.
   *
   * Rendered as "none (no recorded backup whose file is still on disk)" rather than a reassuring
   * date — see `backup-store.ts`'s `markPresence`. Absent together with `lastBackupAt` means this
   * harness has never been backed up at all, which is a different sentence (`never`).
   */
  lastBackupGone?: boolean
}

/** The newest backup on disk, for the config and detail panes — absent when there is none. */
export interface ControlBackupLast {
  /** ISO — see `ControlBackupHarness.lastBackupAt` for why this is an instant, not a formatted age. */
  at: string
  /** Already-formatted, e.g. "4.1 MB" — the archive's real, measured size. */
  bytesLabel: string
  /**
   * How many paths the walk skipped, `undefined` on a record written before the field existed.
   *
   * `undefined` is NOT zero: it reads as "whether anything was skipped is not known", never as a
   * clean run — the same rule `BackupRecord.skipped` documents.
   */
  skipped?: number
}

/**
 * A backup once covered this harness or the machine, and its file is no longer on disk —
 * three-way, not two. See `backup-store.ts`'s `markPresence`, the single source of this
 * classification: no surface re-derives it.
 *
 *  - `present` — the archive is on disk, restorable.
 *  - `pruned` — WE deleted it, on purpose, by retention (`agentop backup`'s `keep`). Expected,
 *    routine, and neutral — a week of daily backups puts most of the history here, and rendering
 *    it the same as a real loss cries wolf on every row past `keep`.
 *  - `missing` — recorded, not pruned by us, and not on disk. The one state a warning colour
 *    belongs on.
 */
export type BackupPresence = 'present' | 'pruned' | 'missing'

/** One row of the backup history — every recorded run, newest first, however it ended up on this
 *  machine's disk (or not). See `BackupPresence`. */
export interface ControlBackupHistoryEntry {
  /** ISO. */
  at: string
  layers: BackupLayer[]
  harnesses: HarnessId[]
  /** Already-formatted, e.g. "4.1 MB" — the archive's real, measured size. */
  bytesLabel: string
  /** How many paths the walk skipped — see `ControlBackupLast.skipped`. */
  skipped?: number
  presence: BackupPresence
}

export interface ControlBackupConfig {
  /** The layers the NEXT manual run writes. Deliberately untranslated — `metrics`/`repos`/
   *  `archive`/`raw` are the CLI's own vocabulary, the same convention as `native`/`docker`. */
  layers: BackupLayer[]
  /**
   * The layers a SCHEDULED run writes — deliberately separate from `layers`. `raw` is gigabytes a
   * copy, so a daily schedule that inherited a manual run's layers would fill a disk the first
   * time someone added it to one run. See `server/cli-backup.ts`'s `BackupPrefs.scheduleLayers`.
   */
  scheduleLayers: BackupLayer[]
  destDir: string
  schedule: BackupScheduleId
  /**
   * Whether the schedule can actually fire RIGHT NOW — false while the server is stopped, per
   * `schedule.ts`'s `inactive-no-server`. The row must say so rather than a "next at…" that will
   * not arrive — the same N/A-versus-a-confident-answer rule the dashboard applies everywhere else.
   */
  scheduleActive: boolean
  keep: number
  /** Already-formatted, e.g. "35 MB" — what EVERY retained backup occupies together, visible at
   *  the moment `keep` or a heavier layer is raised, not after. */
  retainedLabel: string
  /** How many secret paths are excluded from every backup. Always > 0 — see `omittedSecrets()`. */
  secretsCount: number
  /**
   * Every layer's measured weight on this machine, already formatted — what the format picker
   * shows beside each row so the choice is informed. `repos` is `null`: it is produced during a
   * run, not measurable ahead of one (see `cli-backup.ts`'s `measuredLayerSizes`) — rendered as
   * "known after running", never as a guessed number or a confident `0`.
   */
  layerSizes: Record<BackupLayer, string | null>
  /**
   * The SAME measurement as `layerSizes`, in raw bytes rather than a formatted string — what lets
   * a surface reason about a GitHub Release asset's 2 GB-per-file cap the instant a checkbox is
   * ticked, with no round trip. `repos` stays `null` for the same reason its label does: its
   * bundles and patches do not exist anywhere until a backup actually builds them, so a byte count
   * for it would be a guess wearing a measurement's clothes.
   */
  layerBytes: Record<BackupLayer, number | null>
  /**
   * This machine's history-preservation mode, when it has been chosen at all — see
   * `preferences.ts`'s `resolveArchiveMode`. Absent means never chosen (the consent gate has not
   * run), which reads the same as anything other than `'full'`: the `archive` layer is frozen
   * either way, and the layers editor says so on that row rather than showing a size that will
   * never grow as if it were still live.
   */
  archiveMode?: ArchiveMode
  /** The newest backup on disk, or absent when there has never been one. */
  last?: ControlBackupLast
}

export interface ControlBackupStatus {
  /** One row per `HARNESS_ORDER` member the host actually reported — never a literal list. */
  harnesses: ControlBackupHarness[]
  config: ControlBackupConfig
  /** Every recorded backup, newest first — the WHOLE history; a surface pages it, it does not ask
   *  the host to page it. See `ControlBackupHistoryEntry`. */
  history: ControlBackupHistoryEntry[]
  /**
   * GitHub versioning, as `GET /api/backup/github` reports it — the shape mirrored in
   * `control/backup.ts` (tui may not import from server). Carries NO token and must never grow one.
   *
   * Optional because a host may not be able to read it, and `githubRows` renders an absent section
   * as "not configured, here is the command that turns it on" — never as blank. The field exists so
   * a machine that IS configured is not told the opposite: a screen stating the reverse of the
   * truth is worse than one saying nothing.
   */
  github?: GithubSection
}

// ---------------------------------------------------------------------------
// the session fleet
// ---------------------------------------------------------------------------

/**
 * What a session is doing, machine-readable — the colour, the sort and the counter read this.
 *
 * `unknown` is for an EXTERNAL session: an assistant running on this machine that agentop did not
 * start. Its screen cannot be captured and its backend cannot be asked, so no state can honestly be
 * claimed for it. The same N/A-versus-a-confident-0 rule the detail pane applies to `boot`.
 */
export type SessionState =
  | 'working'
  | 'waiting-approval'
  | 'waiting'
  | 'exited'
  | 'lost'
  /** Running, but agentop did not start it — nothing about it is capturable. */
  | 'unknown'
  /** Not running at all: a conversation on this machine that can usually be reopened. */
  | 'closed'

/**
 * One session, as the host currently sees it.
 *
 * Every displayable string arrives already localized, exactly as `ControlService` does — the TUI
 * owns no logic, so it neither decides what a session is doing nor what to call it.
 */
export interface ControlSession {
  id: string
  /**
   * Already-localized display name.
   *
   * A session can be named in TWO places — in agentop, and inside the harness with its own
   * `/rename` — and the host decides which one this is. See `titleSource`.
   */
  title: string
  /**
   * Where `title` came from, present ONLY when the two names disagree.
   *
   * `label` is the name typed in agentop, `harness` the one typed inside the session. Its presence
   * is the statement: an ordinary row, named in one place or neither, carries nothing here.
   */
  titleSource?: 'label' | 'harness' | 'derived'
  /**
   * The name that LOST, when there was one and it differs.
   *
   * Neither name is ever discarded. Someone who renamed in both places must be able to see that both
   * renames happened — a rename that vanishes without a word is indistinguishable from one that
   * failed, which is the complaint this whole field exists to answer.
   */
  titleOther?: string
  /** Harness id, or `''` when the registry has forgotten it. The colour and grouping key. */
  harness: string
  cwd: string
  /** The last path segment of `cwd` — the "by project" grouping key, computed by the host. */
  project: string
  /**
   * The REPOSITORY this session's directory belongs to, `org/repo` or the checkout's folder name.
   *
   * A separate grouping from `project`, and the one that matches how the work is organised: three
   * worktrees of one repo are three places to work on ONE thing, and grouping by directory files
   * them under three unrelated names. Absent for a directory that is not in a repository at all.
   */
  repo?: string
  /**
   * What the "by project" grouping keys on, when it is not simply the directory name.
   *
   * The main checkout's folder for anything inside a repository — so the three worktrees of
   * `agentistics` group under `agentistics` rather than under `session-monitor`, `billing-basis`
   * and `agentistics`, which files one project as three. It is a SEPARATE field from `project`
   * because the row must still say which directory it is actually in: with several worktrees open
   * at once, the folder cell is the only thing telling them apart.
   *
   * It is also where a row whose directory is GONE and whose repository was never recorded is filed:
   * the host puts an already-localized sentence here rather than a name, because the alternative is
   * grouping under the last segment of a path that resolves to nothing — which is how a removed
   * worktree appeared as a project of its own beside the project it was a worktree of.
   */
  projectGroup?: string
  /**
   * The project's own DIRECTORY — the main checkout, even for a session inside one of its worktrees.
   *
   * What the CASCADE arrangement measures a session's branches against: the segments of `cwd` below
   * this path are the nodes it hangs under. It is a path where `projectGroup` is a name, and the two
   * are not interchangeable — deriving the branches by string-matching the name against the cwd is a
   * guess that goes wrong wherever a segment repeats along the path.
   *
   * Absent whenever no repository names one — outside a repository, or for a directory that is gone
   * with nothing recorded at spawn. The tree then hangs the session directly off its project root
   * with no branch, which is the honest answer: a relative path that cannot be established is never
   * synthesised.
   */
  projectRoot?: string
  /**
   * Already-localized: this row's directory does not exist on this machine any more.
   *
   * Present whether or not the repository was recovered from what the registry recorded, because
   * the two are different facts — one says which project the work belonged to, this one says the
   * path is not there, which is also the answer to "why can I not reopen it".
   */
  dirGone?: string
  /** True only for a LINKED worktree. Said on the row, because it changes what the row IS. */
  worktree?: boolean
  /**
   * Whether the user deliberately MARKED this session — gave it a name, a note or a task.
   *
   * Its own flag rather than something the screen infers from `title`, because `title` always has a
   * value: the host derives one when there is no label, so "has a title" says nothing about whether
   * anyone chose it. The history switches make an exception of a marked row — see `sessionNamed`.
   */
  named?: boolean
  model?: string
  note?: string
  /** The piece of work this session belongs to, when the user said so. Groups the list. */
  task?: string
  /**
   * The harness's own conversation id this row is KNOWN to be writing — what `--resume` takes.
   *
   * The exact answer to "where does this continue from", and the only one this screen may state:
   * it is recorded, never inferred. Absent on a row started before the id could be recorded, and on
   * every row of a harness that cannot report one — see `conversationBlind`.
   */
  conversationId?: string
  /**
   * Already-localized: this harness can never report which conversation a session it started is
   * writing, so no link can be recorded for this row and anything offered to reopen is inferred.
   *
   * Present only on a hosted row that has no `conversationId`. Same discipline as `approvalBlind`:
   * a capability that does not exist is said in words rather than left to look like an absence.
   */
  conversationBlind?: string
  /**
   * The conversation this row could REOPEN, when there is one.
   *
   * Present on a row that is running outside agentop (the conversation it appears to be driving) and
   * on a closed one (itself). Absent when the harness cannot reopen by id, so the verb is not
   * offered rather than offered and wrong.
   */
  resume?: { sessionId: string; title: string }
  /**
   * The last few meaningful lines of this session's screen — what it is saying right now.
   *
   * Present only for a session agentop hosts; there is no frame to read for anything else, and an
   * invented one would be the worst possible thing to put under "what is it doing".
   */
  lastLines?: string[]
  /**
   * The last few chat turns of this session, role-tagged, read from its own transcript — Claude
   * only. When present, the detail pane renders THIS instead of `lastLines`, so the user's and the
   * assistant's own text can be told apart by role rather than by a guess at the screen's layout.
   */
  chatTurns?: {
    role: 'user' | 'assistant'
    text: string
    /** A synthesized "running a tool" note, not something either side actually said — see the
     *  server's `ChatTurn.pending`. Rendered dim, never in the role colours. */
    pending?: boolean
  }[]
  /**
   * The DIALOG this session is blocked on, verbatim — present only while it is asking.
   *
   * A different reading of the frame from `lastLines`, which cuts the input box and the status strip
   * away and would therefore cut the dialog away. This is what a person has to READ before agreeing:
   * the options, which one is highlighted, and the footer naming the key. The keystroke that answers
   * cannot know which option it is taking, so the screen showing this IS the safety.
   */
  approvalLines?: string[]
  /**
   * Whether the approve verb can run on this row at all.
   *
   * True only when the session is blocked on a dialog AND this harness's dialog has been read, so
   * the keystroke that answers it is a recorded fact rather than a guess. False everywhere else,
   * including on a perfectly healthy working session — approving something that is not asking
   * anything sends a blank turn, or takes an option out of a menu nobody was looking at.
   */
  canApprove?: boolean
  /**
   * The OPTIONS the dialog is offering, when its screen could be read with confidence.
   *
   * Present only on a blocked row, and ABSENT rather than invented when the screen cannot be
   * parsed. Its presence changes what "answering" means: with options there is no such thing as
   * approving, only choosing one of them, and the UI must show them and send the one picked.
   *
   * The case this exists for is real and was reported: a session asking "how should I promote to
   * prod?" with four different answers, in front of a key called `approve` that would have silently
   * taken whichever was highlighted.
   */
  dialogOptions?: Array<{ number: number; label: string; selected: boolean }>
  /**
   * Whether the user may pick one of `dialogOptions` from here.
   *
   * False when this harness has no verified way to select an option by number (`approval-spec.ts`).
   * There is deliberately NO fallback to the confirm key in that case: confirming the highlighted
   * row on a dialog somebody is being shown four answers to is choosing for them.
   */
  canChoose?: boolean
  /**
   * Why approving is unavailable HERE, already localized — present only when the session is blocked
   * and nobody has read this harness's dialog.
   *
   * Its presence is the statement, the same shape as `approvalBlind`: absence is not a reassurance,
   * and a verb that vanished without a word reads as the feature being broken.
   */
  approveBlind?: string
  /**
   * Why the options on screen cannot be answered from here, already localized — present only when
   * there ARE options and this harness has no verified way to pick one.
   *
   * A refusal that names its reason is usable: it tells someone to attach, which works. A verb that
   * quietly picks for them is not.
   */
  chooseBlind?: string
  /**
   * This session was taken by the machine along with the others, and comes back with them.
   *
   * Decided over the WHOLE registry rather than from this row — "did these fall together" is a
   * question about a set — so the host hands the answer down rather than the screen inferring one.
   */
  fell?: boolean
  /** Already-formatted token count, when this row's conversation has metrics. */
  tokens?: string
  /** Already-formatted cost, same. */
  cost?: string
  /**
   * How full this session's context window was on its last turn — ABSENT when it cannot be known.
   *
   * Absent covers three different situations that the screen deliberately does not distinguish,
   * because the honest rendering of all three is the same nothing: the harness reports no per-turn
   * context size (`HARNESS_CAPABILITIES.contextWindow`), the model's window is not in the verified
   * table, or the row has no conversation behind it at all. A `0%` in any of those places is a
   * confident answer to a question nobody could answer — the same rule the metrics cell follows.
   *
   * `fraction` can exceed 1: a session really can send more than the window this table names (see
   * `contextWindows.ts` on Claude Code's smaller session cap), and the bar saturates while the
   * label keeps saying the true number rather than pinning it at 100%.
   */
  context?: {
    /** Used / window. Unclamped — see above. */
    fraction: number
    /** The percentage as a word, e.g. `45%`. Already localized-agnostic (digits + `%`). */
    label: string
    /** Both halves, already formatted, for the detail pane: `455.4k` and `1M`. */
    used: string
    window: string
  }
  /** Everything this row can be found by, KEPT APART BY WHAT IT IS — including a closed
   *  conversation's opening prompt, which is what a person remembers about work they put down.
   *  Separate fields are what let the screen say WHICH of them a query matched. */
  searchFields: SearchFields
  state: SessionState
  /** Already-localized state word, e.g. "needs approval". */
  stateLabel: string
  /**
   * Something this session STARTED is still running, while the session itself needs a person.
   *
   * claude prints `esc to interrupt` whenever anything is interruptible — a background subagent
   * included — so a session that had finished its own turn and was waiting for you to type still
   * carried the marker and read as `working`. The state is now decided by the MAIN agent's own
   * spinner; this says why the screen still looks busy. Absent on an ordinary row: its presence is
   * the statement.
   */
  background?: boolean
  /**
   * The reasoning effort this session was STARTED with, when one was asked for.
   *
   * Recorded at spawn, like `model` beside it — it is what agentop passed, not something read back
   * off the running CLI, and absent means no flag was passed and the harness's own default is in
   * force. A blank would read as "none", which is a different claim.
   */
  effort?: string
  /**
   * The MODE the harness is in — its own word for it (`auto mode`, `plan mode`, …).
   *
   * Absent for a harness whose modes nobody has driven, and for a session whose footer has not been
   * read yet. See `mode-spec.ts`: the cycle key is a keystroke, so a guessed one would be a
   * keypress nobody asked for.
   */
  mode?: { id: string; label: string }
  /**
   * Whether this row can be acted on at all.
   *
   * False for an external session, which is listed because "the fleet in one place" is the point,
   * and marked because offering it verbs that cannot work would be worse than not listing it.
   */
  actionable: boolean
  /**
   * Already-localized sentence, present only when this harness has no probed approval markers.
   *
   * Its presence is the statement: a blocking question on such a session reads as plain `waiting`,
   * so the detail pane says so rather than letting the state word imply a certainty it does not have.
   */
  approvalBlind?: string
  /** When it started, epoch ms. An instant rather than a duration — see `ServiceRuntimeState`. */
  startedAt?: number
  /**
   * When it went OFF, epoch ms — absent while it runs, and absent when nothing recorded an end.
   *
   * `startedAt` answers when the work began and is the wrong question on a finished conversation: a
   * block of nineteen off rows is read, and ordered, by which of them ended most recently. Two
   * sources, in order of exactness: the registry's own recorded end, and — for a row the machine
   * LOST, where nothing was ever written — the last heartbeat stamp, which is the closest thing to
   * an end time that can exist for a reboot. There is deliberately no fallback to the start: a
   * start age printed under a heading naming the end is a wrong number rather than a missing one,
   * and this column has always been allowed to be blank.
   */
  endedAt?: number
  attached: boolean
  /** Process ID for live process monitoring. */
  pid?: number
  /** Process CPU load percentage. */
  cpuPercent?: number | null
  /** Resident Set Size memory usage in bytes. */
  rssBytes?: number | null
}

/**
 * How the fleet list is arranged, remembered ACROSS RUNS.
 *
 * It lives on the status rather than in the TUI for the same reason the language and the mouse do:
 * the control center owns no persistence. Without it the grouping was per-run state, so every
 * restart threw away the arrangement someone had chosen — which reads as the screen forgetting on
 * its own rather than as a setting that was never stored.
 */
export interface SessionViewPrefs {
  /**
   * How the list is arranged, BY ID.
   *
   * An id and never a position: an index records "the third dimension" and becomes a different
   * question the moment someone reorders the menu. See `session-dimensions.ts`.
   *
   * `SessionGroupingId` and never a union written out here: this was a hand-copied list of the
   * arrangements, which is the pattern CLAUDE.md forbids for harnesses and for the same reason —
   * TypeScript accepts a union with a member missing, so an arrangement added to `GROUPINGS` would
   * be offered by the menu, accepted by the CLI, and then refused by the type of the file it is
   * persisted to.
   */
  grouping: SessionGroupingId
  /**
   * What the list is narrowed to, per dimension — the ONE stored source for every filter.
   *
   * One source on purpose. The state section and the show switches used to be two, and the state
   * section silently won: the switches drew their own on/off while changing nothing. Written by
   * `storedFilters`, read by `migrateSessionFilters`, and gated by `filtersVersion`.
   */
  filters?: Record<string, string[]>
  /** Marks a `filters` written under the current model. See `FILTERS_VERSION`. */
  filtersVersion?: number
  /**
   * Whether a row the user NAMED survives a status filter that would otherwise drop it.
   *
   * Off as it ships. The exception itself is old and has a real reason — a reboot turns every
   * managed session `lost`, and without it the default list came back empty, taking the names with
   * it — but it used to be unwritten, so a strict filter quietly kept rows it did not name. Now it is
   * a switch: a widening someone chose and can see.
   */
  showNamed?: boolean
  /**
   * DERIVED ON WRITE, and read back only by `migrateSessionFilters`.
   *
   * Kept so a machine that downgrades to an older binary does not come up with every filter lifted.
   * Same pattern, and the same reason, as `deniedRepos` in the sharing rules: anything that still
   * READS these as the live answer is a bug.
   */
  showClosed: boolean
  showExited: boolean
  /** Only meaningful while grouping by task, but stored either way so it survives a detour. */
  showUnfiled: boolean
  /**
   * Whether the sessions of a FINISHED task are listed.
   *
   * Absent reads as `false`, which is the point of marking a task finished at all: the work is over
   * and its sessions stop competing for the screen with the work that is not. It is a filter and
   * never a deletion — the sessions are still there, still attachable, one toggle away.
   */
  showDone?: boolean
  /**
   * Show ONLY what is running: working, waiting, waiting on approval. Nothing else, no exceptions.
   *
   * The one switch that OVERRIDES the "a row you named is never hidden" rule rather than widening
   * alongside it. That rule exists so a reboot does not empty the list, and it is right by default —
   * but it also means a machine with months of named work shows all of it, and someone who wants
   * the four things they are actually doing had no way to say so. This is that way.
   */
  onlyActive?: boolean
  /**
   * The exact states the list keeps, when the user narrowed it beyond "active or everything".
   *
   * Absent means the two switches above decide, which is the ordinary case. Present, it is the
   * whole answer — and it is stored as the states to KEEP rather than the ones to hide, so a state
   * added to the product later is not silently included in a filter written before it existed.
   */
  states?: string[]
  /** How the rows are ordered. Absent is by state — what is blocked on you, first. */
  sort?: { by: string; dir: 'asc' | 'desc' }
  /** Whether the detail pane under the list is drawn at all. */
  hideDetail?: boolean
  /**
   * How the fleet is ARRANGED — a list of rows, or a grid of cards.
   *
   * Absent reads as `DEFAULT_SESSION_VIEW.layout`, never as a literal: a fallback written by hand
   * once turned the strict filter off on every machine that already had a `preferences.json`, and
   * the persist effect then wrote that off to disk, making it permanent.
   */
  layout?: 'list' | 'cards'
  /**
   * Draw the directory CASCADE inside each band.
   *
   * A VIEW rather than a grouping — see `groupSessions`. Absent reads as off, and a stored
   * `grouping: 'tree'` from before this existed is rewritten to `none` + cascade on read, so a
   * machine that had the cascade selected keeps it.
   */
  cascade?: boolean
  /**
   * WHICH PAGE of cards was open, named by the SESSION at the top of it rather than by a number.
   *
   * The fleet re-sorts every five seconds, so "page 2" is a position and a position is not an
   * identity — by the next poll it holds different sessions. The same rule `asideRowKey` follows
   * for the menu cursor. An anchor that is no longer in the list simply opens page 0.
   */
  cardAnchor?: string
  /**
   * Session ids the user has MARKED, so a row can be found again without searching for it.
   *
   * Persisted for the same reason the arrangement is: detaching from a session remounts this
   * screen, and a mark that did not survive that would be gone at exactly the moment it was most
   * useful — you marked the row because you were about to go into it.
   */
  marked?: string[]
  /**
   * WHICH scopes the session search looks in — the cumulative set (name, folder, harness, note,
   * task, prompt, transcript), persisted like the rest of the arrangement so the depth someone chose
   * survives a restart.
   *
   * A `SearchScope[]`, not this package's `SearchScopeSelection` object: the STORED format is the
   * server's (`Preferences.sessionView.searchScopes` in `preferences.ts`, shipped in #240), and this
   * type is the same contract read back through `cli-start.ts`. The tui converts to and from its own
   * on/off toggles at the edge (`selectionToScopes` / `selectionFromScopes`), so the object never
   * crosses this boundary. Absent reads as the default (title + first prompt on, transcription off)
   * — never a literal here, for the same reason `layout` is not. See finding (3) in the journey.
   */
  searchScopes?: SearchScope[]
}

/**
 * How the fleet list opens on a machine that has never chosen — and what `ctrl+r` restores.
 *
 * Stated ONCE, here, because three places used to spell it out: the host's fallback, the screen's
 * initial state, and the reset. Three copies of a default is three chances for the app to open on
 * one arrangement and reset to another.
 *
 * Only ACTIVE conversations, grouped by project. The list opens as what is happening rather than as
 * everything that ever has — and it means that STRICTLY, named rows included: `showNamed` is off, so
 * nothing slips past the status selection unannounced.
 *
 * "Only active" is no longer a switch of its own. It is a SELECTION on the status dimension, spelled
 * out here as the states it keeps, and the switch that used to carry the name is one of the
 * shortcuts that writes into that selection. The two can no longer disagree — see
 * `session-dimensions.ts`. `onlyActive`/`showClosed`/`showExited` below are the derived-on-write
 * copies an older binary reads.
 *
 * The consequence is deliberate and has to be stated somewhere the user can see it: when nothing is
 * running, this default shows an EMPTY list. It is not empty because the fleet is — the sessions
 * that a reboot turned into `lost` rows are still there, still named, still reopenable — so the
 * screen says so in words and names the key that lifts the filter. A blank pane under a strict
 * filter is indistinguishable from a broken one.
 */
export const DEFAULT_SESSION_VIEW: SessionViewPrefs = {
  grouping: 'project',
  ...storedFilters({ filters: DEFAULT_FILTERS, showNamed: DEFAULT_SHOW_NAMED, marked: DEFAULT_MARKED }),
  showDone: false,
  layout: 'list',
  // Derived-on-write, like the three `storedFilters` writes above: only an older binary reads it.
  showUnfiled: true,
} as SessionViewPrefs

/**
 * A session the machine lost that could be started again — see `planRestore`.
 *
 * Offered ONCE, on the run after everything went down, and never while anything is still running:
 * a machine with live sessions did not lose everything, and a modal that greets an ordinary restart
 * is a modal people learn to dismiss without reading.
 */
export interface RestoreCandidate {
  id: string
  /** Already-composed name: the user's own when there is one, else the conversation's. */
  label: string
  harness: string
  /** The last path segment, for a list that has to stay narrow. */
  project: string
  /**
   * When it started, epoch ms — absent when the registry's timestamp is unreadable.
   *
   * An instant rather than a duration, like every other time this contract carries: the screen
   * repaints far more often than the poll runs, so a duration computed here would freeze at
   * whatever it was when the host last looked.
   */
  startedAt?: number
}

/**
 * The answer to "which conversations said this", plus what it could NOT look at.
 *
 * `unavailable` and an empty `ids` are different answers and the screen must render them
 * differently — the same rule `LiveUnavailableReason` exists for. `covered` is what the header may
 * honestly claim: reporting "transcript 0" while only one of six harnesses was reachable is the
 * confident zero this product refuses everywhere else.
 */
export interface TranscriptSearch {
  /** Conversation ids whose transcript carries the query. */
  ids: ReadonlySet<string>
  /** The harnesses actually walked. */
  covered: readonly string[]
  /** Harnesses whose search errored — their conversations are missing from `ids`. */
  failed: readonly string[]
  /** Set only when nothing was searched at all. */
  unavailable?: 'no-grep' | 'no-transcripts'
}

export interface ControlSessions {
  sessions: ControlSession[]
  /** How many are waiting on a person. Drives the header counter, from every tab. */
  attention: number
  /** Ids that JUST entered attention. The shell rings the terminal bell for these, once. */
  rang: string[]
  /** Already-localized reason this list may not be the whole truth. Never an empty list alone. */
  unavailable?: string
  /**
   * The REAL keystroke that leaves an attached session, read from the backend.
   *
   * On the snapshot rather than only on the attach, so the screen can state it permanently. It was
   * printed once before handing the terminal over and then scrolled away — and a user who cannot
   * get out is stranded in a buffer that hides their shell.
   */
  detachHint?: string
  /**
   * The tasks the user has marked FINISHED.
   *
   * On the snapshot rather than derived from the sessions, because it is a statement about the WORK
   * and not about any session's state: a task is over when the person says it is, which is a
   * different fact from every one of its sessions having exited. Sessions of a finished task are
   * hidden by default and shown by a toggle.
   */
  finishedTasks?: string[]
  /**
   * The sessions the machine took ALL AT ONCE, when there are any.
   *
   * A reboot, an OOM kill or a lost tmux server turns every managed session into a `lost` row in the
   * same instant. This names that event so all of them can be picked back up with one action — which
   * is the whole point: a list of forty rows that includes everything that ever ran cannot be
   * reopened without reading each one first.
   *
   * `atMs` is when it happened, and the UI must SAY it: a fall from three days ago is a perfectly
   * legitimate thing to offer, and an offer that does not say when reads as one that just happened.
   */
  fell?: { count: number; atMs: number }
  /**
   * The SAME fall, named row by row, for the offer made on the way in.
   *
   * `fell` is the count and the instant — enough for the summary row, the section heading and the
   * menu verb. This is the list a person reads to DECIDE, and a count cannot be decided on: three
   * sessions in a repository you have finished with and one you were in the middle of are the same
   * "4" on screen.
   *
   * Both come from ONE selection (`planCrashGroup`), and that is the point of them being two fields
   * rather than two questions: a second answer to "what fell" is a second set of rules, which is
   * the bug `task-reopen.ts` exists to have fixed once.
   *
   * Narrower than `fell` by exactly one rule: a row whose conversation does not resolve is dropped
   * here, because this list is CLICKABLE and a row that cannot be reopened is a button that fails.
   * It stays inside `fell`, where the reopen counts it as skipped rather than pretending it never
   * fell.
   */
  restorable?: RestoreCandidate[]
}

export type TeamMode = 'solo' | 'central' | 'member'

/** What the central link is doing — see `ControlStatus.linkState`. */
export type CentralLinkState = 'ok' | 'stale' | 'offline' | 'unauthorized'

export type ArchiveMode = 'consolidate' | 'full' | 'off'

export interface ControlStatus {
  mode: TeamMode
  /** Already-localized sentence describing the mode. */
  modeLabel: string
  endpoint?: string
  services: ControlService[]
  version: string
  /** Set when a newer release exists; drives the update dot in the header. */
  latestVersion?: string
  /**
   * How many assistants are running out of how many this MACHINE can hold — the header's `ram 3/17`.
   *
   * **This is about the SYSTEM, not about agentop**, and the surface has to say so: a number in the
   * corner of a window is read as belonging to that window, and someone would otherwise conclude
   * agentop eats 10 GB. Measured: agentop's own server was 578 MB of a 4 GB total, and the rest was
   * one Node process per assistant CLI.
   *
   * **Absent when the memory could not be read at all** (not Linux, no `/proc`), and then no gauge
   * is drawn — never a zero. `red` is the host's decision, taken from the DISTANCE to the ceiling
   * rather than a percentage (three left of thirty is comfortable, three of fourteen is the last
   * warning) and from swap pressure, which is what actually freezes a machine: the incident this
   * exists for read 3.6 GB of free RAM while swap sat at 97%.
   */
  memory?: {
    used: number
    max: number
    red: boolean
    /**
     * How much of the MACHINE is in use, 0-100.
     *
     * Beside `used/max` rather than instead of it: they answer different questions, and the first
     * alone was not enough. `3/17` says how many more assistants fit; it says nothing about a box
     * already at 90% for reasons that have nothing to do with agentop. Reported as missing after
     * the first pass shipped only the ratio.
     *
     * Counts SWAP as used, like the alarm does — the freeze this warns about read 3.6 GB of free
     * RAM at 97% swap, so a RAM-only figure would print a comfortable number at the worst moment.
     */
    percent: number
  }
  /**
   * What this machine is CALLED on the central it pushes to.
   *
   * Reported: "uso 1 computador e acesso mais 1 via ssh, e daí não lembro qual agentop é de qual
   * máquina". Two identical cockpits in two terminals are indistinguishable, and the name already
   * exists — the central mints it onto the token and the member reads it back from `whoami`. It was
   * simply never shown.
   *
   * Absent in solo mode: there is no central to have named it, and substituting a hostname would be
   * a different fact wearing the same label.
   */
  machineName?: string
  /**
   * The ACCOUNT that central knows this machine under.
   *
   * Beside the name because the two answer different halves of one question: two machines can be
   * called `laptop` on two centrals, and the account is what says whose fleet this row belongs to.
   * Read from the connection the machine actually has (`/api/team/status`), never from a config
   * value typed here — a name this machine believes and the central does not is the one thing this
   * cell must not show.
   */
  accountName?: string
  /**
   * Whether that link is WORKING — decided HERE, because only the host can see the connection.
   *
   * A name and a latency say a connection was configured and once answered; neither says it is
   * alive now, and that was the whole of what the header could show. `stale` is its own answer
   * rather than folded into `offline`: the central owns the push cadence, so a member that has not
   * pushed recently has not failed at anything, and reporting that as broken is the false alarm
   * that teaches people to ignore the indicator. Absent when there is no connection at all.
   */
  linkState?: CentralLinkState
  /**
   * Round trip of the last successful contact with the central, in milliseconds.
   *
   * `undefined` before the first one and wherever nothing is pushed — never `0`, which would read
   * as an instant round trip rather than as no measurement. It is the number that says the link is
   * WORKING rather than merely configured.
   */
  pushMs?: number
  /** The history-preservation setting in force, or `undefined` while it is still unanswered. */
  archiveMode?: ArchiveMode
  /**
   * Why a mode cannot be chosen right now, already localized — one entry per BLOCKED mode, and the
   * ordinary case is an empty object.
   *
   * Reconfiguring a service that is RUNNING is the trap this closes: `central` re-runs
   * `central.sh init`, which rewrites the environment file and recreates the containers, so
   * choosing it in the middle of a working session tears down the very central being used. The
   * cockpit already refuses a start for something that is up by handing over an empty
   * `startOptions`; this is the same rule applied to the wizard.
   *
   * A REASON, never a bare flag: a greyed row with no explanation is indistinguishable from a bug,
   * and the sentence has to name what to do instead ("stop it first"). The host decides, because
   * only it knows what is running.
   */
  setupBlocked?: Partial<Record<TeamMode, string>>
  /** How the fleet list was last arranged. Absent on a machine that has never chosen. */
  sessionView?: SessionViewPrefs
  /**
   * Whether the terminal should report the mouse. Defaults to ON — the mouse is the thing a user
   * reaches for first, and `m` (or this preference) is how someone who wants their terminal's own
   * selection back turns it off.
   *
   * It lives on the STATUS rather than in the TUI because the TUI reads no preferences: the host
   * stores it beside the language and the archive mode, and hands the answer over like any other.
   */
  mouse?: boolean
  /**
   * How often the cockpit re-reads the fleet, in milliseconds — the same STATUS-not-TUI shape as
   * `mouse` and the language, for the same reason: the TUI reads no preferences of its own.
   * Absent means the host has not answered yet; the shell falls back to its own built-in default
   * exactly as it does for `mouse` and for `lang`.
   */
  sessionPollMs?: number
}

export interface ActionResult {
  ok: boolean
  /** Already-localized one-line outcome, shown in the status line. */
  message: string
}

export interface ControlHost {
  /** Re-detect config + services. Must never throw; failures come back as `unknown` services. */
  refresh(): Promise<ControlStatus>
  /**
   * What the host ALREADY knows, synchronously, or `null` on the very first look.
   *
   * `refresh()` shells out to systemd and to docker, so it takes about a second — and attach and
   * detach are two halves of one gesture, so every detach REMOUNTS this app and starts that second
   * over. Whatever the screen cannot know during it is drawn from defaults, and for the sessions
   * list that means the arrangement someone chose is replaced by the shipped one and then swapped
   * back in front of them: a frame that is not merely incomplete but WRONG about a choice the user
   * made. This is the same answer as the fleet poll's — the previous truth beats a confident
   * default — and `refresh()` runs anyway, on the frame after.
   *
   * The host is what survives the remount (`runStart` creates it once, outside the loop), so it is
   * the only place this can live.
   */
  lastStatus?(): ControlStatus | null

  /**
   * Start one runtime — normally a `StartOption` handed straight back.
   *
   * `{ runtime: 'local', how: 'fg' }` never resolves usefully from inside the mounted app: the
   * server needs the tty, which it can only have once the control center has unmounted, so the
   * cockpit reports that choice as `onExit({ kind: 'foreground' })` instead and the host takes over.
   */
  start(req: StartRequest): Promise<ActionResult>

  connect(v: { endpoint: string; token: string; org: string }): Promise<ActionResult>
  disconnect(): Promise<ActionResult>

  /**
   * Bounce / stop what a target names. A LOGICAL target acts on whichever runtimes of it are
   * actually up (both, when they are in conflict); a runtime target acts on exactly that one.
   * Naming something that is not running is answered, not silently reported as done.
   *
   * `rebuild` is a `RestartOption` handed straight back — the flag is the host's to interpret, and
   * it is only ever true for an option the host offered in the first place.
   */
  restart(target: ActionTarget, rebuild?: boolean): Promise<ActionResult>
  stop(target: ActionTarget): Promise<ActionResult>

  /** Persist a team mode from the Setup tab. `member` also needs `connect`. */
  setMode(mode: 'solo'): Promise<ActionResult>
  initCentral(): Promise<ActionResult>
  /** The archive-history consent, asked once. `null` when already chosen. */
  /**
   * Install the newer release and restart whatever is running onto it.
   *
   * Offered only while `ControlStatus.latestVersion` says there IS one. It is the whole of
   * `agentop upgrade` — download, verify, install, then restart the active systemd services, the
   * central's containers and a machine container — run as a CHILD process, because that command
   * prints, and nothing may print while the alternate buffer is live. Its output is the point, so
   * it streams into the detail pane like a build.
   */
  upgrade(): Promise<ActionResult>

  pendingArchiveMode(): Promise<ArchiveMode | null>
  setArchiveMode(mode: ArchiveMode): Promise<ActionResult>

  /**
   * Install the systemd user service that brings a logical service up on every boot.
   *
   * `runtime` is the one the option that led here actually started (`StartOption.runtime`), passed
   * straight back — a container and a native process boot through genuinely DIFFERENT mechanisms
   * (a systemd user unit that runs `docker compose … up -d`, versus one that runs the binary
   * directly), so the host needs to know which was used in order to write the matching unit rather
   * than defaulting to the native one regardless. It is optional because the manual "enable boot"
   * action row — offered while the service is down, with no runtime yet running to name — has no
   * runtime to hand over; the host then falls back to its default (native for `agentistics`,
   * Docker for `central`, its only mechanism).
   */
  enableBoot(service: ServiceId, runtime?: RuntimeId): Promise<ActionResult>

  /**
   * Remove that registration again — the other half of the switch.
   *
   * It was missing, and its absence is the bug this pair exists to fix: `enableBoot` wrote a
   * systemd user unit that nothing in the product could take away, so stopping a service stopped
   * only this instance of it. The unit stayed enabled, and the next boot — or the next login that
   * starts the user's systemd manager — ran it again. "I stopped my central and it keeps coming
   * back" is exactly what a one-way switch produces.
   *
   * It NEVER stops what is running. Turning off "come back after a reboot" is a statement about the
   * future, and a verb that also killed the live service would be two actions behind one label —
   * the cockpit already has `Stop` for the other one. (`agentop autostart <mode> disable` keeps its
   * older meaning and does both; the flag lives on `disableAutostart`, not here.)
   *
   * `runtime` is read the same way `enableBoot` reads it: it names WHICH mechanism to remove, since
   * `agentistics` has two.
   */
  disableBoot(service: ServiceId, runtime?: RuntimeId): Promise<ActionResult>

  setLang(lang: CliLang): Promise<void>

  /**
   * Remember how the fleet list is arranged. Same shape as `setLang`, and for the same reason: a
   * preference the control center can toggle is a preference the host stores. Best-effort — a
   * machine that cannot write its preferences still gets the setting for this run.
   */
  setSessionView?(view: SessionViewPrefs): Promise<void>

  /**
   * Persist whether the mouse reports. Same shape as `setLang`, and for the same reason: the
   * control center owns no persistence, so a preference it can toggle is a preference the host
   * stores. Best-effort — a machine that cannot write its preferences still gets the toggle for
   * this session.
   */
  setMouse(on: boolean): Promise<void>

  /**
   * Persist how often the cockpit re-reads the fleet. Same shape as `setMouse` — best-effort, and
   * the shell applies the new interval to its own running poll immediately rather than waiting for
   * a `refresh()` this action does not itself trigger. The host clamps to its own floor/ceiling, so
   * a value from an older or hand-edited preferences file can never be handed back as-is.
   */
  setSessionPollMs(ms: number): Promise<void>

  /**
   * The backup tab's own snapshot — per-harness coverage and the current configuration.
   *
   * A SEPARATE read from `refresh()`, exactly like `sessions()`: computing it walks the metrics
   * layer and the consolidate store, which every OTHER tab needs `refresh()` to stay cheap for.
   * OPTIONAL, and its absence means the tab renders nothing beyond a sentence saying the host
   * cannot say — the same treatment `sessions?()` gets.
   */
  backupStatus?(): Promise<ControlBackupStatus>

  /**
   * Toggle whether one harness rides the NEXT backup — `space` on the focused row.
   *
   * Best-effort, like `setMouse`: a machine that cannot write its preferences still gets the
   * toggle for this run.
   */
  setBackupHarness?(harness: HarnessId, on: boolean): Promise<void>

  /** Cycle the schedule to the next id and persist it — `s`, from either pane. */
  setBackupSchedule?(schedule: BackupScheduleId): Promise<ActionResult>

  /**
   * Set the layers a MANUAL run writes — the layers editor's `enter`, from the `layers` config
   * row. `metrics` is enforced server-side (`backup-plan.ts`'s `withMetrics`) even if the caller
   * omitted it, so the editor's own metrics row can stay non-interactive without this ever
   * silently dropping it.
   */
  setBackupLayers?(layers: BackupLayer[]): Promise<ActionResult>

  /** Same as `setBackupLayers`, for the layers a SCHEDULED run writes — deliberately a separate
   *  call, from the `scheduleLayers` config row, so the two preferences can never be conflated. */
  setBackupScheduleLayers?(layers: BackupLayer[]): Promise<ActionResult>

  /**
   * Run a backup now, with the configured layers and harnesses — `b`.
   *
   * Streams into `ControlHost.onOutput` exactly like a rebuild: the same channel, the same
   * detail-region contract, so nothing here needs a wrapper of its own.
   */
  runBackup?(): Promise<ActionResult>

  /**
   * Hand a URL to the desktop's browser.
   *
   * OPTIONAL, and the cockpit treats its absence as the feature not existing: the "open in browser"
   * action, the `o` key and its footer hint all appear only when a host implements this. A hint for
   * a key that does nothing is the one bug this screen's footer exists to prevent, and a headless
   * box — the exact machine where `agentop` is most likely to be run over ssh — has no browser to
   * hand it to.
   */
  openUrl?(url: string): Promise<ActionResult>

  /**
   * Watch what the CURRENT action is saying, line by line. Returns an unsubscribe.
   *
   * ONE channel rather than a callback threaded through every action signature: the commands worth
   * watching are the long ones — `docker compose up --build`, `central.sh up`, `bun run bin` — and
   * which of them a given call ends up running is the host's business. The UI subscribes once,
   * around whatever it is performing, and renders what arrives.
   *
   * The lines are already sanitised (see `control/stream.ts`): no escape sequences, no carriage
   * returns, no tabs, nothing whose rendered width differs from its length. That is not politeness
   * — a raw cursor-up sequence inside a pane moves the real cursor and corrupts every row Ink draws
   * after it, which is exactly why these children are PIPED now instead of inheriting the terminal.
   */
  onOutput(handler: (line: string) => void): () => void

  /**
   * Newest-last lines of a log, or an empty array when there is nothing to show.
   *
   * A LOGICAL source reads whichever runtime is up (falling back to the service's primary runtime
   * when none is, so the file a crashed server left behind is still readable); a runtime source
   * reads exactly that one, which is what the full-screen Logs screen's selector needs.
   */
  readLog(source: LogSource, maxLines: number): Promise<string[]>

  /**
   * The session fleet, re-read. Must never throw — a failed poll comes back as the previous list
   * plus an `unavailable` sentence, never as an empty one.
   *
   * OPTIONAL, and its absence means the feature does not exist here: a host that does not implement
   * it gets no `sessions` tab content beyond a sentence saying so. Same treatment as `openUrl?`,
   * and for the same reason — a screen that offers what the host cannot do is the one bug this
   * contract exists to prevent.
   */
  sessions?(): Promise<ControlSessions>

  /**
   * Which conversations SAID this — the deep half of the sessions search.
   *
   * Reads the transcripts on THIS machine and answers with conversation ids only. The text is
   * never carried: it does not go on a session row, it does not reach the web dashboard, and it
   * cannot reach a central. A previous attempt put it on `SessionMeta` and shipped whole
   * conversations to a central in the member push — see the header of `transcript-search.ts`.
   *
   * OPTIONAL like `sessions`: a host that cannot search transcripts here (no `grep`, no
   * transcripts, not this platform) says so through `TranscriptSearch.unavailable`, and the screen
   * states it in words. An empty result with no reason is a real "nothing said this" — the two must
   * stay distinguishable, exactly as `liveUnavailable` keeps them apart for live sessions.
   */
  searchTranscripts?(query: string): Promise<TranscriptSearch>

  /**
   * What it takes to attach to a session, or `null` when this one cannot be attached.
   *
   * Returned rather than PERFORMED, exactly as the backend's own `attachCommand` is: attaching needs
   * the real tty, which it can only have once the control center has released it. The cockpit
   * reports the intent as `ControlExit.attach` and `cli-start.ts` takes over — the same discipline
   * `central.sh init` already follows.
   */
  attachSession?(id: string): Promise<AttachTicket | null>

  killSession?(id: string): Promise<ActionResult>

  /**
   * Stop the current turn WITHOUT ending the session.
   *
   * The opposite of `killSession`: that one destroys the session, this one hands the turn back and
   * leaves it sitting at its prompt. The keystroke is `Escape`, which is exactly what
   * `attention-rules.ts` records these CLIs printing while they work (`esc to interrupt`) — read
   * from the probed rules rather than assumed.
   *
   * REFUSED on a session that is not working. Escape into an idle prompt closes whatever the
   * harness happens to have open, which is not what "stop" means and is not recoverable by
   * pressing it again.
   */
  interruptSession?(id: string): Promise<ActionResult>

  /**
   * Advance a session's harness to its NEXT mode, without attaching to it.
   *
   * One keystroke, and the harness decides which mode comes next — there is no key that picks one
   * by name, so this is a cycle rather than a chooser. Refused, in words, for a harness whose modes
   * nobody has driven: a guessed key is a keypress nobody asked for. See `mode-spec.ts`.
   */
  cycleSessionMode?(id: string): Promise<ActionResult>

  /**
   * Type one line into a session and submit it, WITHOUT attaching to it.
   *
   * The ordinary case is a session that is working or waiting: the text lands in its prompt and it
   * reads it when it gets there. The case that must be refused is a session with a DIALOG open —
   * there the prompt is not a prompt, it is a menu, and a sentence typed into it is an answer to a
   * question nobody read. The host re-reads the screen before sending and refuses in words; the
   * screen cannot decide it, because its list is up to a poll old.
   */
  promptSession?(id: string, text: string): Promise<ActionResult>


  /**
   * Answer the dialog this session is blocked on.
   *
   * `choice` is the option NUMBER to pick, and it is the whole point of this signature: a dialog
   * offering "only my fix / promote everything / stop here / type something" has no approval, and a
   * verb that took the highlighted row would be choosing between four different outcomes on the
   * user's behalf. Omitted only for a dialog with no readable options — the codex-shaped
   * `Press enter to continue`, where there genuinely is nothing to choose between — and the host
   * then sends the confirm key.
   *
   * The host re-reads the frame immediately before sending and refuses when the session is no longer
   * asking, or when the options on screen no longer match what the user was shown. A snapshot is up
   * to five seconds old, and an answer to a question that has changed is worse than no answer.
   */
  answerSession?(id: string, choice?: number): Promise<ActionResult>

  /**
   * Reopen every session of the last fall, in the background.
   *
   * The same arithmetic `openTask` runs (`task-reopen.ts`), over the set `ControlSessions.fell`
   * names instead of over a task: a row still running is left alone and reported as such, a row
   * already finished is not resurrected, an unresolvable one is skipped AND counted, and everything
   * reopened retires the row it replaced.
   */
  reopenFell?(): Promise<ActionResult>

  renameSession?(id: string, label: string): Promise<ActionResult>
  noteSession?(id: string, text: string): Promise<ActionResult>
  /** File this session under a piece of work. Empty string clears it. */
  taskSession?(id: string, task: string): Promise<ActionResult>

  /**
   * The tasks that already exist on this machine.
   *
   * So filing a session under one is a PICK rather than a spelling test: a task is a free string, so
   * typing "auth-refactor" a second time as "auth refactor" makes two tasks that look like one and
   * group like two. Offering what exists is what keeps that from happening.
   */
  sessionTasks?(): Promise<string[]>

  /**
   * Reopen a conversation as a NEW managed session.
   *
   * This is what makes a closed conversation, or one running outside agentop, something the cockpit
   * can act on at all: it cannot attach to a process it did not start, but it can start a session
   * that resumes the same conversation.
   */
  resumeSession?(req: ResumeSessionRequest): Promise<SpawnSessionResult>

  /**
   * Reopen every session of one task, in the background.
   *
   * The point of naming a task is getting all of its work back at once. Sessions whose conversation
   * cannot be resolved are SKIPPED AND COUNTED in the result — a silent partial reopen would leave
   * someone believing they had their whole task back.
   */
  openTask?(task: string): Promise<ActionResult>

  /**
   * Mark a task finished, or reopen it. Absent on a host that cannot remember the answer.
   *
   * Takes the state to SET rather than toggling, so the screen and the store can never disagree
   * about what the button just did — a toggle computed from a snapshot one poll old flips the wrong
   * way the moment two things happen between polls.
   */
  finishTask?(task: string, done: boolean): Promise<ActionResult>
  /**
   * Remove a task NAME. The sessions filed under it survive, unfiled.
   *
   * Separate from `finishTask`, which hides a task's sessions behind a switch — that is a statement
   * about the WORK, this is one about the LABEL. Deleting must never take the sessions with it: a
   * verb that loses work while sounding like tidying up is one nobody can safely press, and the
   * reason the list grew long enough to complain about is that people do not remove what they are
   * unsure of.
   */
  deleteTask?(task: string): Promise<ActionResult>

  /**
   * Start the offered sessions again, detached, or decline them.
   *
   * DECLINING is not a no-op: it retires the rows it was offered (`endedAt`), because "no" here
   * means the work is over. Without that the same modal greets you on the next run and the run
   * after, which is how a prompt becomes something people clear without reading — and the rows
   * stay listed and individually reopenable either way, so nothing is destroyed by saying no.
   */
  restoreSessions?(ids: string[], accept: boolean): Promise<ActionResult>

  /**
   * Remember that the user has ALREADY been asked about the fall that happened at `atMs`.
   *
   * It lives on the HOST because the host is the only thing here that outlives the Ink app.
   * Attaching to a session is a `ControlExit`: the app unmounts, `runStart` hands over the terminal
   * and then LOOPS, mounting a brand-new React tree that lands on the sessions tab. Every piece of
   * component state dies with the old tree, so an "already asked" flag held in a `useState` is
   * answered, forgotten, and asked again the moment the user detaches — which is exactly the
   * reported bug, and the same reason `lastStatus` is kept out here.
   *
   * Keyed by the fall's INSTANT and compared with `>`, never a bare boolean:
   *  - the offer is capped at 8 rows and only the rows that were SHOWN get retired, so the next
   *    poll legitimately re-anchors onto the remainder — same event, and it must not re-ask;
   *  - once a cluster is retired, `planCrashGroup` re-anchors onto the next-newest one, which the
   *    module deliberately allows to be days old. That is a DIFFERENT `atMs` and an older one, so
   *    `>` withholds it — a three-day-old fall presented as though it just happened is precisely
   *    the "sessions that make no sense" half of the report;
   *  - a genuine new crash while the cockpit is open stamps a NEWER `atMs` and is still announced.
   *
   * In memory, deliberately: closing the terminal and coming back is the moment the offer exists
   * for, so a fresh `agentop` must ask again.
   */
  dismissFall?(atMs: number): void

  /**
   * The harnesses this machine can actually START, with what each of them accepts.
   *
   * Derived by the host from the spawn specs, so a harness with no spec is ABSENT from the wizard
   * rather than offered and failing — the same rule the CLI already follows. The wizard renders
   * whatever comes back and knows nothing about which CLI takes which flag.
   */
  startableHarnesses?(): Promise<SessionHarnessOption[]>

  /** Places a new session could start, ranked. `query` may be empty, which opens on recency. */
  searchProjects?(query: string): Promise<ProjectOption[]>

  /** Start one. An attached request comes back with a ticket the shell hands to `ControlExit`. */
  spawnSession?(req: SpawnSessionRequest): Promise<SpawnSessionResult>
}

/** One harness the wizard may offer, and the shape of the questions it earns. */
export interface SessionHarnessOption {
  id: string
  /** Already-localized name. */
  label: string
  /**
   * Models to OFFER — never a validation list. `claude --help` documents `--model` as an alias "or
   * a model's full name", so refusing anything outside a fixed list would reject valid input the
   * day a model ships. The wizard therefore lets the value be typed as well as picked.
   */
  modelSuggestions: string[]
  /** Absent when the CLI has no model flag at all, which is a different thing from an empty list. */
  supportsModel: boolean
  /**
   * What the CLI uses when nothing is passed, ONLY where the CLI itself publishes it — so a
   * picker can say "Default (sonnet)" rather than naming a default without saying what it is.
   * Absent is the honest answer, and is what every harness reports today: see the defaults block
   * in `spawn-spec.ts` for what was checked and how.
   */
  defaultModel?: string
  /** A genuine closed enum printed by the CLI itself, so this one IS validated. Empty = none. */
  efforts: string[]
  /** The effort used when `--effort` is not passed, under exactly `defaultModel`'s rule. */
  defaultEffort?: string
}

/** One place a session could start. */
export interface ProjectOption {
  /** The directory. The only field that is load-bearing. */
  path: string
  /**
   * The directory NAME, on its own.
   *
   * On its own, and not joined to the repo any more: the picker draws a measured TABLE, and a cell
   * that already contains two facts and a separator cannot be aligned against anything. It read as
   * a paragraph per row — which, on a machine with twenty candidates, is what made it unusable.
   */
  label: string
  /** The repository it belongs to (`org/repo`), when it belongs to one. Its own column. */
  repo?: string
  /**
   * The path, shortened for display.
   *
   * Not decoration: a machine with six directories called `portifolio` renders six identical rows
   * without it, and the search field is the one control that decides where work happens.
   */
  detail: string
  /**
   * Why it is being offered, so the list can say so — and so a folder that was merely FOUND is not
   * mistaken for one you have worked in.
   *
   * `cwd` where you are standing · `history` somewhere sessions have run · `repo` a git repository
   * found on disk · `folder` any other directory found on disk · `typed` a path given in full.
   */
  source: 'cwd' | 'history' | 'repo' | 'folder' | 'typed'
}

export interface SpawnSessionRequest {
  harness: string
  cwd: string
  /**
   * The piece of work this session belongs to, chosen while starting it.
   *
   * Declared, and not merely spread in by the wizard: TypeScript runs no excess-property check on a
   * spread, so a field the request type does not know about is dropped in silence — the wizard
   * would ask the question and throw the answer away.
   */
  task?: string
  prompt?: string
  model?: string
  effort?: string
  label?: string
  /** Take the terminal now, versus start detached and stay here. */
  attach: boolean
}

export interface ResumeSessionRequest {
  /** The HARNESS's own conversation id. */
  sessionId: string
  harness: string
  cwd: string
  /** Already-composed name for the new session, so the row keeps reading the same. */
  label: string
  /**
   * The registry row this reopen REPLACES, when there is one.
   *
   * Reopening spawns a new session, so without this the old row stays beside it: a laptop closed
   * and opened twice leaves a task holding two dead twins and one live session, all with the same
   * name. The host retires the named row and carries its note and its task onto the new one — what
   * you wrote about a piece of work must survive picking that work back up.
   */
  replaces?: string
  attach: boolean
}

export interface SpawnSessionResult {
  ok: boolean
  /** Already-localized outcome for the status line. */
  message: string
  /** Present only on a successful ATTACHED start — the shell reports it as `ControlExit.attach`. */
  ticket?: AttachTicket
  /**
   * The id of the session that was started, on success.
   *
   * Returned so a caller that is REPLACING an older row can carry its note onto the new one — the
   * spawn is the only place that knows the id, and asking the registry afterwards would be a guess
   * about which of several rows in the same directory is the one just created.
   */
  id?: string
}

/** Everything the caller needs to hand the terminal over and get the user back afterwards. */
export interface AttachTicket {
  /** Exec'd with inherited stdio once Ink has unmounted and the alternate buffer is released. */
  argv: string[]
  /**
   * The REAL detach keystroke, read from the backend — never assumed to be `Ctrl-b`.
   *
   * Printed before the handover: a user who cannot get out is stranded in a buffer that hides their
   * shell, and a tmux prefix the user rebound would make a guessed hint actively wrong.
   */
  detachHint: string
  /** Already-localized name of what is being attached to, for the sentence printed on the way in. */
  label: string
}

/**
 * Why the control center stopped. `foreground` tells `cli.ts` to fall through to the in-process
 * server startup, exactly as the old launcher's `'foreground'` sentinel did.
 */
export type ControlExit =
  | { kind: 'quit'; code: number }
  | { kind: 'foreground' }
  /**
   * Hand the terminal to a session, then COME BACK.
   *
   * The Ink app never execs anything itself: it unmounts, `cli-start.ts` runs the argv with the real
   * tty, and when that returns it re-enters the control center on the sessions tab. The loop is what
   * makes attach and detach feel like two halves of one gesture rather than an exit.
   */
  | { kind: 'attach'; ticket: AttachTicket }
