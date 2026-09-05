/**
 * i18n.ts — the control center's own chrome strings (EN/PT).
 *
 * Division of labour with `server/cli-i18n.ts`: anything the HOST produces — service labels,
 * mode sentences, action outcomes — is already localized by the time it reaches a component, and
 * stays in `cli-i18n.ts`. What lives here is the chrome the TUI owns and the server knows nothing
 * about: tab names, key hints, empty states, the words on this app's own screens.
 */

import type { CliLang } from './lang'
import { dimensionWordBook, type DimensionWordBook, type SessionDimensionId, type SessionGroupingId } from './session-dimensions'
import type { BackupLayer, BackupScheduleId, TabId, TeamMode } from './types'

export interface ControlStrings {
  tagline: string

  tabs: Record<TabId, string>
  /**
   * The tab bar's names — lowercase, because the bar is chrome and the panes are what the eye
   * should land on, and short because six of them share one row in two languages.
   *
   * They are also every pane title on the linear screens, so a screen is called the same thing in
   * the bar and in the frame around it.
   */
  tabsShort: Record<TabId, string>

  /** Footer key hints. */
  keyTabs: string
  keyPane: string
  keyMove: string
  keySelect: string
  keyActions: string
  keyActionMove: string
  keyRun: string
  keyStop: string
  keyRestart: string
  keyOpen: string
  keyBack: string
  keyQuit: string
  /**
   * The way out of the output pane a running task owns.
   *
   * `dismiss` rather than `back`: the pane is not a place you navigated into, it is a thing that
   * appeared over the facts, and esc puts the facts back.
   */
  keyTaskClose: string
  keyScroll: string
  /** `g`/`G` and Home/End — the ends of a document, named once for every screen that scrolls. */
  keyEnds: string
  keyRefresh: string
  keyLogSource: string
  /** The dashboard's own keys. Its screens are digits and `tab`, never the arrows — see
   *  `resolveDashboardScreen` for why the shell's `←→ screens` had to survive this tab. */
  dashView: string
  dashFilter: string
  /** Paging, on the three screens that draw a list. Named because the arrows could not be taken. */
  dashPage: string
  /**
   * The mouse's two hints, said only while there IS a mouse.
   *
   * `keyMouseCopy` is the important one and exists because tracking has a cost: with the terminal
   * reporting buttons, a plain drag no longer selects text, and `shift` is what hands the gesture
   * back to the terminal. It is stated only while tracking is on, because that is the only time it
   * is true — a hint for a workaround that is not needed teaches the wrong thing just as surely as
   * a hint for a key that does nothing.
   */
  keyMouse: string
  keyMouseCopy: string

  /** Pane titles. */
  paneServices: string
  paneConfig: string
  /** The detail pane's title while nothing is selected; normally it wears the service's name. */
  paneDetail: string
  /**
   * The output pane's title when the action that opened it was not named.
   *
   * Normally it wears the VERB the user pressed — "Rebuild & restart", "Start (docker)" — because
   * that is what makes a wall of build output attributable. This is the fallback, so output can
   * never arrive with nowhere to go.
   */
  paneOutput: string

  /**
   * The detail pane's section rules.
   *
   * Uppercase, like every other section header in the app (small caps, which no terminal has), and
   * plural because each heads a list of rows rather than one fact.
   */
  sectionRuntimes: string
  sectionAddresses: string
  sectionMachine: string
  /** Heads the sentences naming the starts this box cannot perform — see `ControlService.startNotes`. */
  sectionStartBlocked: string

  modeLabel: string
  historyLabel: string
  endpointLabel: string
  languageLabel: string
  /** The language currently in force, named in itself — `English` in EN, `Português` in PT. */
  languageValue: string
  setupLabel: string
  /** The config pane's mouse row, and the two words it states. `on`/`off`, never a colour. */
  mouseLabel: string
  mouseOn: string
  mouseOff: string
  /** The config pane's refresh-interval row. */
  sessionPollLabel: string
  actSessionPoll: string

  /** Detail pane. */
  pidLabel: string
  uptimeLabel: string
  webLabel: string
  apiLabel: string
  noServices: string
  /**
   * The boot row: whether the service comes back after a reboot.
   *
   * There is no third word for "we could not tell" on purpose — an unknown draws NO row, because a
   * service that says "will not restart" when nobody asked systemd is a fact a user acts on.
   */
  bootLabel: string
  bootOn: string
  bootOff: string

  /**
   * Actions on the focused service.
   *
   * There is no generic `Start` here any more, and no generic `Restart` either: both are per
   * RUNTIME, and only the host knows which ones this box can perform — so it composes and labels
   * them (`Start (docker)`, `Rebuild & restart`), and this table carries only the verbs whose
   * meaning is the same wherever they appear. `Restart all` survives because "all" is the one
   * target the selection cannot name.
   */
  actStop: string
  actOpen: string
  actStopAll: string
  actRestartAll: string
  /** Names the version, so the verb states what it is about to install. */
  actUpgrade: (version: string) => string
  actConnect: string
  actDisconnect: string
  actHistory: string
  actLanguage: string
  actMouse: string
  /**
   * Open the setup wizard — what `enter` on the config pane's mode row does.
   *
   * There is no `actBoot` beside it any more: the boot VERBS are composed by the host, both
   * positions of the switch, because which unit brings a service back is a fact about the box.
   */
  actSetup: string

  stateUp: string
  stateDown: string
  stateUnknown: string
  /**
   * The services row's word for `ControlService.conflict`.
   *
   * The row has one cell for a state, and the host's conflict sentence is a sentence; this is what
   * fits in the cell. It is a WORD beside the danger colour and a glyph, never the colour alone,
   * and the sentence itself is right there in the detail pane.
   */
  stateConflict: string

  working: string
  yes: string
  no: string

  /** Services tab. */
  killQuestion: string

  /**
   * THE SETUP WIZARD — a question the cockpit asks, not a screen of its own any more.
   *
   * Keyed by `TeamMode` rather than spelled out one constant per mode: `ControlStatus.setupBlocked`
   * is keyed the same way and the menu maps over `SETUP_MODES`, so a mode added to the product
   * fails the build here instead of compiling clean and being missing from the wizard — the same
   * rule `HARNESS_CAPABILITIES` enforces for harnesses.
   */
  setupQuestion: string
  setupMode: Record<TeamMode, string>
  setupModeHint: Record<TeamMode, string>
  archiveUnset: string
  archiveQuestion: string
  archiveWhy: string
  archiveConsolidate: string
  archiveConsolidateHint: string
  archiveFull: string
  archiveFullHint: string
  archiveOff: string
  archiveOffHint: string
  /** The opening gate's fourth option, and what it costs. Absent from the other callers' menus. */
  archiveLater: string
  archiveLaterHint: string
  archiveLaterMessage: string
  bootQuestion: string

  /** Logs tab. */
  logSource: string
  logEmpty: string
  logLoading: string
  logFollow: string
  logFollowing: string
  logPaused: string

  /** Sessions tab. */
  sessionsEmpty: string
  /** The list is empty because `only active` is on, and this many sessions are being withheld. */
  sessionsEmptyActive: (total: number) => string
  /** The list is empty because a search or a scope is narrowing it. */
  sessionsEmptyFiltered: string
  sessionsLoading: string
  /** Said when the host does not implement the fleet at all — not the same as an empty fleet. */
  sessionsUnsupported: string
  /** The summary row: "3 sessions · 1 waiting on you". */
  /**
   * How many rows are ON SCREEN, and out of how many the machine has.
   *
   * Two numbers, always, because one of them alone lies: with `only active` on, a fleet of 44 shows
   * ten rows, and a header reading "44 sessions" over ten of them describes a screen nobody is
   * looking at. `shown === total` is the case where the second number says nothing new, and that is
   * the only case where it is dropped.
   */
  sessionsCount: (shown: number, total: number) => string
  sessionsWaitingCount: (n: number) => string
  /**
   * The waiting cell when the list is NOT showing everything that is waiting.
   *
   * `attention` is counted over the whole fleet — it has to be, because the header carries it on
   * every tab — while this row sits directly above a FILTERED list. Printing the fleet's figure
   * here made the row claim something the rows under it contradict, which is the same defect the
   * `shown` cell already records: "the header used to read the fleet's length, so with `only
   * active` on it announced 44 over a screen showing ten".
   *
   * Both numbers, never just the visible one: a session that needs you and is being withheld by a
   * search is the one thing on this screen that must not go quiet.
   */
  sessionsWaitingSplit: (shown: number, total: number) => string
  sessionsGroupBy: string
  /** Labels the summary row's filter cell, so a grouping and a filter are told apart by WORD. */
  sessionsFilterBy: string
  /** What the filter cell says when the list is narrowed to what is alive. */
  sessionsFilterActive: string
  /** What it says when closed conversations are the only thing withheld. */
  sessionsFilterNoHistory: string
  /** Added when named rows are being kept regardless of the filter — it puts rows BACK. */
  sessionsFilterNamed: string
  /**
   * Every dimension's name, plus the flat arrangement.
   *
   * `Record<SessionGroupingId, …>` on purpose: a dimension added to `session-dimensions.ts` breaks
   * the build here until it has a word, rather than appearing in the menu under its internal id.
   */
  sessionsGroupings: Record<SessionGroupingId, string>
  /** What each dimension's 'no value' bucket is called. Same reason it is a `Record`. */
  sessionsUnfiled: Record<SessionDimensionId, string>
  /** The band of rows the user MARKED — the filled side of the `marked` dimension. */
  sessionsMarkedBand: string
  /** Stop the current turn without ending the session — the web's own verb. See `fleet-row.ts`. */
  sessionsInterrupt: string
  /** Why it is off: nothing is running to stop. */
  sessionsInterruptIdle: string
  /** Why a verb is off on a row agentop does not host. */
  sessionsExternalRow: string
  sessionsUnknownHarness: string
  sessionsUnknownModel: string
  sessionsUnknownProject: string
  sessionsUnknownTask: string
  sessionsUnknownRepo: string
  sessionsWorktreeTag: string
  /** The sessions list's column headings — an unlabelled column is one you have to learn. */
  sessionsCols: Record<'id' | 'state' | 'age' | 'title' | 'task' | 'worktree' | 'metrics' | 'context' | 'harness' | 'where', string>
  /** Detail-pane field labels. */
  sessionsWhere: string
  sessionsModel: string
  sessionsNote: string
  sessionsStarted: string
  sessionsDoing: string
  sessionsTask: string
  sessionsMetrics: string
  /** What the usage figure counts, in words — see `detailLines`'s `metricsAll`. */
  sessionsMetricsAll: string
  /** Detail-pane label for the context gauge spelled out. */
  sessionsContext: string
  /** Detail-pane label for the conversation id this row continues from. */
  sessionsConversation: string
  /** Grouping heading for rows whose recorded directory no longer exists on this machine. */
  sessionsGoneProject: string
  /** The name that did NOT win, when a session is named in agentop AND inside the harness. */
  sessionsAlsoLabel: string
  sessionsAlsoHarness: string
  /** Label of the detail line stating how to LEAVE an attached session. */
  sessionsDetach: string
  /** Marks a finished task's heading, and the word the toggle uses. */
  sessionsDoneWord: string
  /** Pane titles — the SHORT lowercase names, the same words the tab bar prints. */
  sessionsPaneMenu: string
  sessionsPaneDetail: string
  sessionsPaneAsk: string
  sessionsPaneKeys: string
  /** Said only while the reference has more below the fold: `12 of 34  ·  ↑↓ scroll`. */
  sessionsKeysMore: (shown: number, total: number) => string
  sessionsPaneRestore: string
  restoreTitle: (n: number) => string
  restoreAnswer: string
  /** What each key on the sessions screen does — the one list `ctrl+h` prints. */
  sessionsKeyWhat: {
    move: string; open: string; attach: string; menu: string; section: string
    newSession: string; search: string; clear: string; kill: string; rename: string
    note: string; task: string; mark: string; onlyActive: string
    openTask: string; finishTask: string; recent: string; cascade: string
    group: string; layout: string; detail: string; menuFold: string
    reset: string
    tabs: string; help: string; quit: string
    approve: string; prompt: string; reopenFell: string
  }
  /**
   * The finish-task confirmation.
   *
   * It states what finishing a task ACTUALLY does, which is hide its sessions behind a switch —
   * nothing is stopped and nothing is deleted, and `running` is called out separately because a
   * warning that implied otherwise would be worse than no warning at all. See `finishTask` in
   * `cli-start.ts`.
   */
  sessionsFinishConfirm: (task: string, count: number, running: number) => string
  sessionsReopenConfirm: (task: string) => string
  /** The heading over the sessions the machine took at once. */
  sessionsFellWord: string
  /** Said on the summary row and in the empty state: N fell, this long ago, and the key. */
  sessionsFellNote: (count: number, ago: string) => string
  /** The confirmation, naming how many and when. */
  sessionsFellConfirm: (count: number, ago: string) => string
  /**
   * Removing a task NAME. The count is in the question because the answer turns on it — and the
   * sentence says the sessions are KEPT, because a delete that sounded like it took them with it is
   * one nobody would press.
   */
  sessionsDeleteTaskAsk: (task: string, count: number) => string
  /** The prompt field, and the sentence above it saying where the text is going. */
  sessionsPromptLabel: (title: string) => string
  sessionsPromptHint: string
  /** The approval confirmation — and its caveat, which is the whole design. */
  sessionsApproveConfirm: (title: string) => string
  sessionsApproveCaveat: string
  /** Heading over the dialog lines carried into the confirmation. */
  sessionsApproveWhat: string
  /** Marks the option the dialog itself is highlighting, inside the picker. */
  sessionsChoiceHighlighted: string
  /** Fallback for a harness with no verified way to pick — the host normally supplies its own. */
  sessionsChooseBlind: string
  /** What DOES work when the options cannot be picked from here. */
  sessionsChooseAttach: string
  asideProjects: string
  asideAllProjects: string
  toggleDone: string
  /** The strict switch: only what is running. Overrides the other three. */
  toggleActive: string
  /** The detail pane's own switch: it is a pane, not a fact, and a screen is allowed to be a list. */
  toggleDetail: string
  /** The cascade switch, in the LAYOUT block — it is a way of drawing, not a grouping. */
  toggleCascade: string
  /** Written on the detail pane itself: the key that puts it away. */
  sessionsDetailHide: string
  /** The menu's layout section, and what the two layouts are called. */
  asideLayout: string
  sessionsLayouts: Record<'list' | 'cards', string>
  /** The card pager: which page, and how much of the fleet is on it. */
  sessionsPage: (page: number, pages: number) => string
  sessionsShowing: (shown: number, total: number) => string
  /** Card markers — said on the state line, where a row has no room for them. */
  sessionsCardAttached: string
  sessionsCardBlind: string
  keySessionsLayout: string
  keySessionsCard: string
  keySessionsPage: string
  asideSort: string
  asideStates: string
  sessionsSorts: Record<'state' | 'name' | 'started' | 'recent' | 'usage' | 'project', string>
  sessionsStates: Record<
    'working' | 'waiting' | 'waiting-approval' | 'exited' | 'lost' | 'closed' | 'unknown', string
  >
  /** States the active search on the summary row, and how to drop it. */
  sessionsSearching: (query: string) => string
  /** The per-scope depth line under the search field. */
  searchScope: Record<'name' | 'folder' | 'harness' | 'note' | 'task' | 'prompt' | 'transcript', string>
  searchDepthLabel: string
  searchRunning: string
  /** Named in words, never rendered as a zero — see `TranscriptSearch.unavailable`. */
  searchNoGrep: string
  searchNoTranscripts: string
  /** The transcription depth is switched off — a choice, distinct from "none on this machine". */
  searchTranscriptOff: string
  /** The search-depth section in the view menu, and its three cumulative toggles + the "all" row. */
  viewSearchDepth: string
  searchDepthName: string
  searchDepthPrompt: string
  searchDepthTranscript: string
  searchDepthAll: string
  searchCovered: (harnesses: string) => string
  searchFailed: (harnesses: string) => string
  /** How long ago, from a whole number of SECONDS — the caller does the clock arithmetic so this
   *  stays a pure formatter. */
  sessionsAgo: (seconds: number) => string
  /** The external row's own sentence, in the detail pane. */
  sessionsExternalNote: string
  sessionsClosedNote: string
  /**
   * This build cannot run session verbs at all — no backend on this platform, or a host that does
   * not implement them. Said in words rather than answered with a dead button: a control that is
   * silently inert is indistinguishable from a broken one.
   */
  sessionsNoHost: string
  /** Reopen was asked for on a row whose conversation cannot be resolved. */
  sessionsReopenNone: string
  /**
   * A START request that arrived over HTTP and cannot be honoured (`fleet-spawn.ts`).
   *
   * The cockpit's own wizard can produce none of these — it only ever offers what this machine can
   * start — so they exist for the other front doors, and each names the offending value rather than
   * refusing in the abstract.
   */
  spawnUnknownHarness: (harness: string) => string
  spawnCwdMissing: string
  spawnCwdRelative: (cwd: string) => string
  spawnUnknownEffort: (effort: string) => string
  spawnModelUnsupported: (harness: string) => string
  keySessionsGroup: string
  keySessionsAttach: string
  /** How to put the arrangement back to how the app opens on a fresh machine. */
  keySessionsReset: string
  keySessionsKill: string
  keySessionsDeleteTask: string
  keySessionsRename: string
  keySessionsNote: string
  keySessionsNew: string
  keySessionsSearch: string
  keySessionsActions: string
  keySessionsApprove: string
  keySessionsPrompt: string
  /** The menu fold — the plain letter, because tmux's default prefix never arrives inside a tmux. */
  keySessionsFold: string
  /** The two keys the restore offer answers, and nothing else. */
  keyRestoreAnswer: string
  /** The visible action row — the same verbs the letters run, spelled out and clickable. */
  actSessions: {
    attach: string
    resume: string
    rename: string
    note: string
    task: string
    approve: string
    prompt: string
    kill: string
    openTask: string
    reopenFell: string
    finishTask: string
    /** Removing a task NAME — the sessions under it survive, unfiled. */
    deleteTask: string
    newSession: string
    search: string
    group: string
  }
  sessionsTaskPrompt: string
  taskHint: string
  taskNone: string
  taskCurrent: string
  sessionsOpenTaskConfirm: (task: string, n: number) => string
  sessionsResumeConfirm: (title: string) => string
  /**
   * The caveat on a row that is RUNNING — and it is now a statement of what will happen, not a
   * warning to go and do it yourself.
   *
   * It used to read "the assistant already running there is NOT stopped — close it first", which
   * described the only behaviour available at the time and left the user holding a row they could
   * see and could not use. The process is ended and the same conversation reopened under tmux; the
   * turn in flight is the only thing lost, and the sentence has to say so, because a confirmation
   * that hides a kill is worse than one that refuses.
   */
  sessionsResumeRunning: string
  sessionsSearchLabel: string
  sessionsSearchEmpty: string
  /** The word on a HISTORY band. Must agree with `sessionsStates` — a row saying `off` under a
   *  band called `closed` is the same vocabulary split this collapse exists to remove. */
  sessionsClosedWord: string
  sessionsShowClosed: string
  /** The view panel: one vertical list of every choice about what the list shows. */
  viewTitle: string
  viewGroupBy: string
  viewShow: string
  /**
   * The summary row's word for the strict selection, printed after a `−`.
   *
   * It read `− everything but active`, which is a double negative over a minus sign: the row was
   * SHOWING only the active sessions and the cell appeared to say the opposite. Reported as
   * "completamente contra intuitiva". It names what is being WITHHELD, which is what the `−` in
   * front of it already promised.
   */
  viewActiveOn: string
  viewClosedOn: string
  viewClosedOff: string
  viewUnfiledOn: string
  viewUnfiledOff: string
  viewHint: string
  /** The aside menu's three headings, and the third visibility switch. */
  asideActions: string
  asideView: string
  asideShow: string
  asideTasks: string
  asideAllTasks: string
  /** ONE switch for "not running". `toggleClosed`/`toggleExited` were two names for one question. */
  toggleHistory: string
  /**
   * The named-row widening, made visible.
   *
   * It replaced `toggleUnfiled`, which hid the task-less band only while grouping by task — that is
   * now the task section's own "no task" row, on every dimension.
   */
  toggleNamed: string
  keySessionsAside: string
  /** The management view a session opens into. */
  manageTitle: (title: string) => string
  manageHint: string
  promptHint: string
  sessionsHideClosed: string
  keySessionsActive: string
  keySessionsDetail: string
  keySessionsMark: string
  keySessionsClosed: string
  keySessionsNoTask: string
  /** How to change screen where the arrows belong to the screen itself. */
  keyTabsAlt: string
  /** How to jump between the menu's sections without walking every row of one. */
  keyAsideSection: string
  sessionsNoTaskHidden: string
  sessionsNoTaskShown: string
  /** The wizard's six questions. */
  wizHarness: string
  wizWhere: string
  wizWhereHint: string
  wizModel: string
  wizModelHint: string
  wizEffort: string
  wizPrompt: string
  wizPromptHint: string
  wizName: string
  wizNameHint: string
  wizHow: string
  /** Said while the session is being started, so `enter` is visibly doing something. */
  wizStarting: string
  /** Said under a failure: nothing you typed was thrown away. */
  wizKeptDraft: string
  wizNoSpawn: string
  wizNeedHarness: string
  wizNeedCwd: string
  wizAttached: string
  wizBackground: string
  wizSkip: string
  wizNoMatch: string
  /** The project table's column headings — four unlabelled columns are four columns of guesswork. */
  wizColName: string
  wizColRepo: string
  wizColPath: string
  wizColWhy: string
  /** Heading over the candidates that belong to no repository. */
  wizNoRepo: string
  wizSourceCwd: string
  wizSourceTyped: string
  wizSourceHistory: string
  wizSourceRepo: string
  /** The rename / note prompts, and the kill confirmation. */
  sessionsRenamePrompt: string
  sessionsNotePrompt: string
  sessionsKillConfirm: (title: string) => string
  /** Said when a verb is pressed on a row that cannot take it. */
  sessionsNotActionable: string
  /** Said when the approve key is pressed on a session that is not blocked on anything. */
  sessionsNotAsking: string
  /** Said when "reopen what fell" is pressed and nothing did. */
  sessionsNoFell: string

  /** Static tabs. */
  helpIntro: string
  cheatIntro: string
  contributeIntro: string
  /**
   * Why the dashboard is showing no numbers.
   *
   * Two sentences rather than one: `dashDown` is actionable and names the screen that starts the
   * server, while `dashUnknown` is the honest form of a service whose state could not be read at
   * all. Reporting the second as the first would send someone to press a button for a problem they
   * do not have — the same N/A-versus-a-confident-0 rule the rest of this app follows.
   */
  dashDown: string
  dashUnknown: string
  copyHint: string
  /** The same reminder while the mouse reports, when a plain drag no longer selects. */
  copyHintShift: string

  /** The `backup` tab. See `control/backup.ts` — this file holds only the words, never the
   *  arithmetic or which harness rides the next backup. */
  paneHarnesses: string
  /** This build's host cannot read backup status at all — `ControlHost.backupStatus` is optional,
   *  same treatment `sessions?()` gets. */
  backupHostMissing: string
  keyBackupToggle: string
  keyBackupRun: string
  keyBackupSchedule: string
  /** The layers editor's own keys, while it has the keyboard — see `Backup.tsx`'s `editingLayers`. */
  keyLayerToggle: string
  keyLayerSave: string
  keyLayerCancel: string
  /** The verb the streaming output pane wears while a backup is running. */
  actBackupRun: string
  /** The verb the schedule row's action wears, and the outcome the config action's status line
   *  shows — the schedule change itself is host-localized (`cli-i18n.ts`'s `backupScheduleSet`). */
  actBackupSchedule: string
  /** The verbs the `layers` and `scheduleLayers` config rows wear — `enter` opens the layers
   *  editor in the detail pane, exactly like the setup wizard is a question drawn there. */
  actBackupEditLayers: string
  actBackupEditScheduleLayers: string
  backupLayersLabel: string
  /** The config row summarizing what a SCHEDULED run writes — deliberately a separate row from
   *  `backupLayersLabel`, right under `backupScheduleLabel`. */
  backupScheduleLayersLabel: string
  /**
   * The four layers, under the names a person thinks in rather than the CLI's own vocabulary
   * (`metrics`/`repos`/`archive`/`raw`) — the layers EDITOR's own row labels. `backupLayersLabel`'s
   * summary value stays untranslated CLI vocabulary on purpose; this is the only place the friendly
   * names are used.
   */
  backupLayerName: Record<BackupLayer, string>
  /** The metrics row's own sentence in the editor — it renders always-on and non-interactive, and
   *  says why rather than merely disabling a control silently. */
  backupLayerAlwaysOn: string
  /** A layer's size when it cannot be measured ahead of a run — `repos` only, whose bundles and
   *  patches do not exist anywhere until a backup actually builds them. Never a guessed number. */
  backupLayerSizeUnknown: string
  /** Shown under the SCHEDULE layers editor only, when `repos` is checked there — a schedule never
   *  actually carries it (see `schedule.ts` and `daemon.ts`), so the editor says so plainly rather
   *  than silently dropping the box's own state. */
  backupScheduleReposNote: string
  backupDestLabel: string
  backupScheduleLabel: string
  backupKeepLabel: string
  backupKeepValue: (keep: number, retainedLabel: string) => string
  backupSecretsLabel: string
  backupSecretsValue: (n: number) => string
  backupLastLabel: string
  /** The harness detail pane's own two rows — absent from the list, which shows only `last`. */
  backupSessionsLabel: string
  backupSizeLabel: string
  /** `off` / `daily` / `weekly`, said in words — the closed enum `s` cycles through. */
  backupScheduleWord: Record<BackupScheduleId, string>
  /** Appended to the schedule word when `ControlBackupConfig.scheduleActive` is false — never a
   *  "next at…" that will not arrive; see `schedule.ts`'s `inactive-no-server`. */
  backupScheduleInactive: string
  /** A harness that has never been backed up at all. */
  backupNever: string
  /** A harness (or the machine) that WAS covered by a backup whose file is now gone — never a
   *  reassuring date. See `backup-store.ts`'s `markPresence`. */
  backupLastGone: string
  /** The SAME fact, short — the harnesses list's own column. See `harnessLastShort`. */
  backupLastGoneShort: string
  /** There has never been a backup on this machine at all — the config/detail `last` row. */
  backupNoneOnDisk: string
  /** `${elapsed} ago` in EN, `há ${elapsed}` in PT — composed rather than concatenated because the
   *  word order differs between the two languages. */
  backupAgo: (elapsed: string) => string
  /** The last backup's outcome word — mirrors `agentop backup status`'s own three sentences. */
  backupLastOk: string
  backupLastUnknown: string
  backupLastSkipped: (n: number) => string
}

const EN: ControlStrings = {
  tagline: 'AI coding-assistant analytics',

  tabs: {
    services: 'Services',
    sessions: 'Sessions',
    backup: 'Backup',
    dashboard: 'Dashboard',
    hardware: 'Hardware',
    logs: 'Logs',
    cheatsheet: 'Cheat sheet',
    help: 'Help',
    contribute: 'Contribute',
  },

  tabsShort: {
    services: 'services',
    sessions: 'sessions',
    backup: 'backup',
    dashboard: 'dashboard',
    hardware: 'hardware',
    logs: 'logs',
    cheatsheet: 'commands',
    help: 'help',
    contribute: 'contribute',
  },

  keyTabs: '←→ screens',
  keyPane: 'tab pane',
  keyMove: '↑↓ move',
  keySelect: 'enter select',
  keyActions: 'enter actions',
  keyActionMove: '←→ action',
  keyRun: 'enter run',
  keyStop: 's stop',
  keyRestart: 'R restart',
  keyOpen: 'o open',
  keyBack: 'esc back',
  keyQuit: 'q quit',
  keyTaskClose: 'esc dismiss',
  keyScroll: '↑↓/pg scroll',
  keyEnds: 'g/G ends',
  keyRefresh: 'r refresh',
  keyLogSource: '[ ] source',
  dashView: '1-6/tab view',
  dashFilter: 'f harness',
  dashPage: ', . page',
  keyMouse: 'm mouse',
  keyMouseCopy: 'shift+drag to copy',

  paneServices: 'services',
  paneConfig: 'config',
  paneDetail: 'detail',
  paneOutput: 'output',

  sectionRuntimes: 'RUNTIMES',
  sectionAddresses: 'ADDRESSES',
  sectionMachine: 'MACHINE',
  sectionStartBlocked: 'NOT AVAILABLE HERE',

  // Lowercase, and the same case as the pane titles: these are row labels inside a pane, not
  // section headers over one. SETUP stays uppercase because it still heads a section.
  modeLabel: 'mode',
  historyLabel: 'history',
  endpointLabel: 'endpoint',
  languageLabel: 'language',
  languageValue: 'English',
  setupLabel: 'SETUP',
  mouseLabel: 'mouse',
  mouseOn: 'on',
  mouseOff: 'off',
  sessionPollLabel: 'refresh',
  actSessionPoll: 'Change',

  pidLabel: 'pid',
  uptimeLabel: 'up',
  webLabel: 'web',
  apiLabel: 'api',
  noServices: 'nothing detected yet.',
  bootLabel: 'boot',
  bootOn: 'starts at boot',
  bootOff: 'does not start at boot',

  actStop: 'Stop',
  actOpen: 'Open in browser',
  actStopAll: 'Stop all',
  actRestartAll: 'Restart all',
  actUpgrade: (v) => `Upgrade to v${v} & restart`,
  actConnect: 'Connect',
  actDisconnect: 'Disconnect',
  actHistory: 'Change',
  actLanguage: 'Switch',
  actMouse: 'Switch',
  actSetup: 'Change…',

  stateUp: 'up',
  stateDown: 'stopped',
  stateUnknown: 'unknown',
  stateConflict: 'conflict',

  working: 'working',
  yes: 'Yes',
  no: 'No',

  killQuestion: 'A server is already running here — stop it and start a new one?',

  setupQuestion: 'How should this machine track usage, and what may leave it?',
  setupMode: { solo: 'solo', central: 'central', member: 'member' },
  setupModeHint: {
    solo: 'local only — nothing leaves this machine',
    central: 'host the team central (Docker) here',
    member: 'everything solo does, plus push metrics (never chat) to a central',
  },
  archiveUnset: 'not chosen yet',
  archiveQuestion: 'Preserve session history?',
  archiveWhy: 'Claude deletes session transcripts older than 30 days.',
  archiveConsolidate: 'consolidate',
  archiveConsolidateHint: 'recommended — store computed per-session metrics (~KB each)',
  archiveFull: 'full',
  archiveFullHint: 'archivist — also mirror raw transcripts so you can re-read chats (heavy)',
  archiveOff: 'off',
  archiveOffHint: "do nothing — use Claude's default 30-day cleanup",
  archiveLater: 'decide later',
  archiveLaterHint: 'the dashboard will require an answer before it opens',
  archiveLaterMessage: 'History left unset — the dashboard will ask before it opens.',
  bootQuestion: 'Start it on every boot (systemd user service)?',

  logSource: 'SOURCE',
  logEmpty: 'nothing logged yet.',
  logLoading: 'reading…',
  logFollow: 'f follow',
  logFollowing: 'following',
  logPaused: 'paused',

  sessionsEmpty: 'no sessions running.',
  sessionsEmptyActive: (total: number) =>
    `nothing running · ${total} session${total === 1 ? '' : 's'} withheld — l shows them`,
  sessionsEmptyFiltered: 'nothing matches · esc clears the filter',
  sessionsLoading: 'reading…',
  sessionsUnsupported: 'session management is not available on this machine.',
  // `N of M sessions` read as "N of your M open sessions", which is not what either number is: the
  // second is every session this machine KNOWS, closed conversations and lost rows included, and
  // the first is only what the current view draws. Two counts of different kinds joined by "of" is
  // an invitation to read them as one kind — and the header's memory budget (`ram 4/18`) sits on the
  // same screen, so a machine showing `4/18` above `5 of 29` looked like it was contradicting
  // itself. Naming what each number counts costs three characters and removes the reading.
  sessionsCount: (shown: number, total: number) => (shown === total
    ? (total === 1 ? '1 session' : `${total} sessions`)
    : `${shown} on screen · ${total} known`),
  sessionsWaitingCount: (n: number) => (n === 1 ? '1 waiting on you' : `${n} waiting on you`),
  sessionsWaitingSplit: (shown: number, total: number) =>
    (shown === 0
      ? `none on screen · ${total} waiting on you`
      : `${shown} on screen · ${total} waiting on you`),
  sessionsGroupBy: 'GROUP',
  sessionsFilterBy: 'FILTER',
  sessionsFilterActive: 'running only',
  sessionsFilterNoHistory: 'without closed conversations',
  sessionsFilterNamed: 'plus named',
  sessionsGroupings: {
    day: 'day',
    repo: 'repository',
    task: 'task',
    none: 'flat',
    tree: 'cascade',
    harness: 'harness',
    model: 'model',
    project: 'project',
    status: 'state',
    marked: 'marked',
  },
  sessionsUnfiled: {
    day: 'no date recorded',
    harness: 'harness unknown',
    model: 'no model recorded',
    project: 'no directory recorded',
    task: 'no task',
    repo: 'no repository',
    // Unreachable in practice — every row wears a state — but a bucket without a name is a heading
    // the screen cannot draw, so it is named rather than left to render blank.
    status: 'state unrecorded',
    marked: 'not marked',
  },
  sessionsMarkedBand: 'marked',
  sessionsInterrupt: 'Stop what it is doing',
  sessionsInterruptIdle: 'Nothing is running right now, so there is nothing to stop.',
  sessionsExternalRow: 'This session was started outside agentop, so nothing here can act on it.',
  sessionsUnknownHarness: 'harness unknown',
  sessionsUnknownModel: 'no model recorded',
  sessionsUnknownProject: 'no directory recorded',
  sessionsUnknownTask: 'no task',
  sessionsUnknownRepo: 'no repository',
  /** Said on a row whose directory is a linked worktree. Short: it is a CELL, not a sentence. */
  sessionsWorktreeTag: 'worktree',
  sessionsCols: {
    id: 'id',
    state: 'state',
    // The column measures when a row went OFF, not when it began — see `sessionAge`.
    age: 'off since',
    title: 'session',
    task: 'task',
    worktree: 'worktree',
    // Named `usage (all)` rather than `usage`: the figure is every token the conversation
    // recorded — input, output, cache read and cache write — and beside a cost it was read as the
    // in/out pair alone, which makes it look an order of magnitude too big. The detail pane spells
    // the four out; the heading only has to stop the wrong reading.
    metrics: 'usage (all)',
    // The WINDOW, not "context": the cell shows how full one is, and a column headed `context`
    // over a bar reads as "this session's context" — a thing, not a level.
    context: 'window',
    harness: 'harness',
    where: 'project',
  },
  sessionsWhere: 'where',
  sessionsModel: 'model',
  sessionsNote: 'note',
  sessionsStarted: 'started',
  sessionsDoing: 'saying',
  sessionsTask: 'task',
  sessionsMetrics: 'usage',
  sessionsMetricsAll: 'in + out + cache',
  sessionsContext: 'context window',
  sessionsConversation: 'conversation',
  sessionsGoneProject: 'directory no longer exists',
  sessionsAlsoLabel: 'named here',
  sessionsAlsoHarness: 'named inside',
  sessionsDetach: 'to detach',
  sessionsDoneWord: 'finished',
  sessionsPaneMenu: 'menu',
  sessionsPaneDetail: 'detail',
  sessionsPaneAsk: 'question',
  sessionsPaneKeys: 'keys',
  sessionsKeysMore: (shown, total) => `${shown} of ${total}  ·  ↑↓ scroll`,
  sessionsPaneRestore: 'last time',
  restoreTitle: (n: number) =>
    n === 1 ? 'Your last session was this one:' : `Your last ${n} sessions were these:`,
  restoreAnswer: 'enter / R reopens active · L / tab go to list · esc ignore',
  sessionsKeyWhat: {
    move: 'move the cursor',
    open: 'switch between the menu and the list',
    attach: 'attach — or reopen, when nothing is running',
    menu: 'open the menu on this row',
    section: 'jump to a menu section',
    newSession: 'start a session',
    search: 'search everything, closed conversations included',
    clear: 'drop the search, then the project, then the task',
    kill: 'stop this session',
    rename: 'rename it',
    note: 'write a note on it',
    task: 'file it under a task',
    openTask: 'open every session of its task',
    finishTask: 'mark its task finished',
    recent: 'the last conversations, newest first, ungrouped',
    cascade: 'cascade the rows by directory',
    mark: 'mark this row, and keep it marked',
    onlyActive: 'show what is not running too — closed, ended and lost',
    layout: 'list or cards',
    group: 'change the grouping',
    detail: 'hide the detail pane',
    menuFold: 'fold the menu away — any digit brings it back',
    reset: 'back to how the app opens',
    tabs: 'change screen',
    help: 'this list',
    quit: 'leave agentop',
    approve: 'answer the question this session is blocked on',
    prompt: 'send it a line without attaching',
    reopenFell: 'reopen everything the machine took at once',
  },
  // Says what finishing ACTUALLY does. It marks the task and hides its sessions behind a switch —
  // it stops nothing — so the sentence names the count, calls out the ones still running, and names
  // the switch that brings them back.
  sessionsFinishConfirm: (task, count, running) =>
    `Mark "${task}" finished? Its ${count} session${count === 1 ? '' : 's'}`
    + `${running > 0 ? ` (${running} still running)` : ''}`
    + (count === 1
      ? ' is NOT stopped — it keeps running and stays'
      : ' are NOT stopped — they keep running and stay')
    + ' listed behind the "finished tasks" switch.',
  sessionsReopenConfirm: task => `Reopen "${task}"?`,
  sessionsFellWord: 'fell together',
  sessionsFellNote: (count, ago) =>
    `${count} session${count === 1 ? '' : 's'} fell ${ago} — R reopens them`,
  sessionsFellConfirm: (count, ago) =>
    `Reopen the ${count} session${count === 1 ? '' : 's'} that fell ${ago}? `
    + 'Each comes back as a new session resuming its own conversation; anything still running is left alone.',
  sessionsDeleteTaskAsk: (task, count) => count === 0
    ? `Remove the task "${task}"? No session is filed under it.`
    : `Remove the task "${task}"? The ${count} session${count === 1 ? '' : 's'} filed under it `
      + `${count === 1 ? 'is' : 'are'} KEPT — only the label goes.`,
  sessionsPromptLabel: (title: string) => `Send to "${title}"`,
  sessionsPromptHint: 'typed straight into the session — it reads it when it gets there',
  sessionsApproveConfirm: (title: string) => `Send the confirm key to "${title}"?`,
  sessionsApproveCaveat:
    'it takes whichever option the dialog above has highlighted — read it first.',
  sessionsApproveWhat: 'on its screen right now',
  sessionsChoiceHighlighted: '(its default)',
  sessionsChooseBlind: 'this dialog is a choice, and agentop cannot pick an option on this harness.',
  sessionsChooseAttach: 'o attaches to the session, where you can answer it — esc goes back.',
  asideProjects: 'PROJECTS',
  asideAllProjects: 'every project',
  toggleDone: 'finished tasks',
  toggleActive: 'only active',
  toggleDetail: 'detail pane',
  toggleCascade: 'cascade by directory',
  sessionsDetailHide: 'd hides',
  asideLayout: 'LAYOUT',
  sessionsLayouts: { list: 'list', cards: 'cards' },
  sessionsPage: (page, pages) => `${page} / ${pages}`,
  sessionsShowing: (shown, total) => `${shown} of ${total}`,
  sessionsCardAttached: 'attached',
  sessionsCardBlind: 'approval unknown',
  keySessionsLayout: 'ctrl+g list/cards',
  keySessionsCard: '←→ card',
  keySessionsPage: 'pgup/pgdn page',
  asideSort: 'ORDER',
  asideStates: 'STATE',
  sessionsSorts: {
    state: 'urgency', name: 'name', started: 'started', recent: 'last active',
    usage: 'usage', project: 'project',
  },
  sessionsStates: {
    'waiting-approval': 'needs approval',
    // Named for what it means to the READER, not for what the machine is doing. `waiting` and
    // `working` differ by two letters in the middle of a narrow column, and the one that needs a
    // person was the one being read as the one that does not.
    waiting: 'needs you',
    working: 'working',
    // ONE word for every way a session is not running — see `cli-i18n.ts`'s `sessState`, which this
    // table has to agree with or a row reads `off` under a band called `closed`.
    exited: 'off',
    lost: 'off',
    closed: 'off',
    unknown: 'external',
  },
  sessionsSearching: q => `search: ${q} · esc clears`,
  searchScope: {
    name: 'name', folder: 'folder', harness: 'harness',
    note: 'note', task: 'task', prompt: 'prompt', transcript: 'transcript',
  },
  searchDepthLabel: 'found in',
  searchRunning: 'reading transcripts…',
  searchNoGrep: 'transcripts not searched — grep is not available here',
  searchNoTranscripts: 'transcripts not searched — none on this machine',
  searchTranscriptOff: 'transcription off',
  viewSearchDepth: 'Search in',
  searchDepthName: 'title',
  searchDepthPrompt: 'first prompt',
  searchDepthTranscript: 'transcription (full session)',
  searchDepthAll: 'all',
  searchCovered: h => `transcripts: ${h}`,
  searchFailed: h => `could not read: ${h}`,
  sessionsAgo: (sec: number) => {
    if (sec < 60) return `${sec}s ago`
    const min = Math.round(sec / 60)
    if (min < 60) return `${min}m ago`
    return `${Math.floor(min / 60)}h ${min % 60}m ago`
  },
  sessionsExternalNote: 'started outside agentop — listed, but it cannot be attached or stopped here.',
  sessionsClosedNote: 'not running — reopen it to pick this conversation back up.',
  sessionsNoHost: 'session control is not available on this machine.',
  sessionsReopenNone: 'no conversation to reopen — nothing on this machine resolves this row.',
  spawnUnknownHarness: h => `this machine cannot start ${h} — no spawn spec for it here.`,
  spawnCwdMissing: 'no directory given — a session has to start somewhere.',
  spawnCwdRelative: cwd => `${cwd} is not an absolute path, and a relative one would resolve against this server's own directory.`,
  spawnUnknownEffort: e => `${e} is not a reasoning effort this CLI accepts.`,
  spawnModelUnsupported: h => `${h} has no model flag — a model was asked for and it could not be honoured.`,
  keySessionsGroup: 'v group',
  keySessionsAttach: 'o attach',
  keySessionsReset: '^r reset view',
  keySessionsKill: 'x kill',
  keySessionsDeleteTask: 'x delete task',
  keySessionsRename: 'r name',
  keySessionsNote: 'm note',
  keySessionsNew: 'n new',
  keySessionsSearch: 'ctrl+f search',
  keySessionsActions: 'tab actions',
  keySessionsApprove: 'a approve',
  keySessionsPrompt: 'p send',
  keySessionsFold: 'b menu',
  keyRestoreAnswer: 'enter start · esc leave closed',
  actSessions: {
    attach: 'Attach',
    resume: 'Reopen',
    // "Answer" rather than "Approve": the key takes whichever option is highlighted, and the verb
    // must not promise more than the keystroke can deliver.
    approve: 'Answer its question',
    prompt: 'Send a prompt',
    rename: 'Rename',
    note: 'Note',
    task: 'Task',
    kill: 'Stop session',
    openTask: 'Open whole task',
    reopenFell: 'Reopen what fell',
    finishTask: 'Finish task',
    deleteTask: 'Delete task',
    newSession: 'New session',
    search: 'Search',
    group: 'Group',
  },
  sessionsTaskPrompt: 'Which task does this session belong to?',
  taskHint: 'pick one, or type a new name',
  taskNone: 'no task',
  taskCurrent: '(current)',
  sessionsOpenTaskConfirm: (task: string, n: number) =>
    `Reopen all ${n} session(s) of "${task}" in the background?`,
  sessionsResumeConfirm: (title: string) => `Reopen "${title}" as a session agentop manages?`,
  sessionsResumeRunning:
    'the assistant running it will be STOPPED and the conversation reopened here — the turn in flight is lost, the conversation is not.',
  sessionsSearchLabel: 'Search sessions and closed conversations',
  sessionsSearchEmpty: 'nothing matches.',
  sessionsClosedWord: 'off',
  sessionsShowClosed: 'closed: shown',
  viewTitle: 'What this list shows',
  viewGroupBy: 'Group by',
  viewShow: 'Show',
  viewActiveOn: 'not running',
  viewClosedOn: 'closed conversations',
  viewClosedOff: 'closed conversations',
  viewUnfiledOn: 'sessions with no task',
  viewUnfiledOff: 'sessions with no task',
  viewHint: '↑↓ move · enter choose · esc close',
  asideActions: 'ACTIONS',
  asideView: 'VIEW',
  asideShow: 'SHOW',
  asideTasks: 'TASKS',
  asideAllTasks: 'every task',
  toggleHistory: 'not running',
  toggleNamed: 'always keep named sessions',
  keySessionsAside: 'tab menu',
  manageTitle: (title: string) => `Managing "${title}"`,
  manageHint: '↑↓ move · enter run · esc back to the list',
  promptHint: 'enter saves · esc cancels',
  sessionsHideClosed: 'closed: hidden',
  keySessionsActive: 'c only active',
  keySessionsDetail: 'd detail',
  keySessionsMark: 'space mark',
  keySessionsClosed: 'c closed',
  keySessionsNoTask: 'u unfiled',
  keyTabsAlt: '[ ] screens',
  keyAsideSection: '1-9 ←→ section',
  sessionsNoTaskHidden: 'unfiled: hidden',
  sessionsNoTaskShown: 'unfiled: shown',
  wizHarness: 'Which assistant?',
  wizWhere: 'Where should it start?',
  wizWhereHint: 'search any folder under your home — or paste a full path',
  wizModel: 'Which model?',
  wizModelHint: 'pick one, or type any model name',
  wizEffort: 'Which reasoning effort?',
  wizPrompt: 'First prompt (optional)',
  wizPromptHint: 'leave empty to start with nothing typed',
  wizName: 'Call it what?',
  wizNameHint: 'a name of your own — enter alone derives one from the harness and the folder',
  wizHow: 'Start it how?',
  wizStarting: 'starting…',
  wizKeptDraft: 'nothing you typed was lost — esc goes back a step, or try again',
  wizNoSpawn: 'this build cannot start sessions.',
  wizNeedHarness: 'pick an assistant first.',
  wizNeedCwd: 'pick a folder first.',
  wizAttached: 'attached — take this terminal now',
  wizBackground: 'background — keep it running and stay here',
  wizSkip: 'use the default',
  wizNoMatch: 'nothing matches — paste a full path to use a directory anywhere on this machine',
  wizColName: 'folder',
  wizColRepo: 'repository',
  wizColPath: 'path',
  wizColWhy: 'why',
  wizNoRepo: 'no repository',
  wizSourceCwd: 'you are here',
  wizSourceTyped: 'typed',
  wizSourceHistory: 'worked here before',
  wizSourceRepo: 'git repo',
  sessionsRenamePrompt: 'Name this session',
  sessionsNotePrompt: 'Describe this session',
  sessionsKillConfirm: (title: string) => `Stop "${title}"? The assistant running in it is ended.`,
  sessionsNotActionable: 'that session was not started by agentop, so it cannot be driven from here.',
  sessionsNotAsking: 'that session is not blocked on a question — there is nothing to answer.',
  sessionsNoFell: 'nothing fell — no session was lost with the machine still on record.',

  helpIntro: 'Every command, with the flags that matter. `agentop --help` prints this plain.',
  cheatIntro: 'The commands worth remembering.',
  contributeIntro: 'Agentistics is open source — issues and pull requests welcome.',
  dashDown: 'The agentistics server is not running, so there are no metrics to read. Start it on the services screen.',
  dashUnknown: 'The agentistics server\u2019s state could not be read, so there are no metrics to show. The services screen says why.',
  copyHint: 'select with the mouse to copy',
  copyHintShift: 'hold shift and drag to select and copy',

  paneHarnesses: 'harnesses',
  backupHostMissing: 'this build cannot read backup status.',
  keyBackupToggle: 'space toggle',
  keyBackupRun: 'b run backup',
  keyBackupSchedule: 's schedule',
  keyLayerToggle: 'space toggle',
  keyLayerSave: 'enter save',
  keyLayerCancel: 'esc cancel',
  actBackupRun: 'Run backup',
  actBackupSchedule: 'Change schedule',
  actBackupEditLayers: 'Edit layers',
  actBackupEditScheduleLayers: 'Edit schedule layers',
  backupLayersLabel: 'layers',
  backupScheduleLayersLabel: 'on schedule',
  backupLayerName: {
    metrics: 'Metrics',
    repos: 'Repositories',
    archive: 'Mirrored transcripts',
    raw: 'Conversations',
  },
  backupLayerAlwaysOn: 'always on — a backup with no metrics restores nothing',
  backupLayerSizeUnknown: 'known after running',
  backupScheduleReposNote: 'a scheduled run never carries this — it is built by `agentop backup`, not on a schedule',
  backupDestLabel: 'destination',
  backupScheduleLabel: 'schedule',
  backupKeepLabel: 'keep',
  backupKeepValue: (keep, retainedLabel) => `${keep} backup${keep === 1 ? '' : 's'} (${retainedLabel})`,
  backupSecretsLabel: 'secrets',
  backupSecretsValue: n => `excluded (${n} item${n === 1 ? '' : 's'})`,
  backupLastLabel: 'last',
  backupSessionsLabel: 'sessions',
  backupSizeLabel: 'size',
  backupScheduleWord: { off: 'off', daily: 'daily', weekly: 'weekly' },
  backupScheduleInactive: '\u2014 inactive (server not running)',
  backupNever: 'never',
  backupLastGone: 'none (no recorded backup whose file is still on disk)',
  backupLastGoneShort: 'gone',
  backupNoneOnDisk: 'no backup on disk yet',
  backupAgo: elapsed => `${elapsed} ago`,
  backupLastOk: 'ok',
  backupLastUnknown: '(unknown whether anything was skipped)',
  backupLastSkipped: n => `${n} skipped`,
}

const PT: ControlStrings = {
  tagline: 'Analytics de assistentes de código IA',

  tabs: {
    services: 'Serviços',
    sessions: 'Sessões',
    backup: 'Backup',
    dashboard: 'Dashboard',
    hardware: 'Hardware',
    logs: 'Logs',
    cheatsheet: 'Comandos',
    help: 'Ajuda',
    contribute: 'Contribuir',
  },

  tabsShort: {
    services: 'serviços',
    sessions: 'sessões',
    backup: 'backup',
    dashboard: 'dashboard',
    hardware: 'hardware',
    logs: 'logs',
    cheatsheet: 'comandos',
    help: 'ajuda',
    contribute: 'contribuir',
  },

  keyTabs: '←→ telas',
  keyPane: 'tab painel',
  keyMove: '↑↓ mover',
  keySelect: 'enter escolher',
  keyActions: 'enter ações',
  keyActionMove: '←→ ação',
  keyRun: 'enter executar',
  keyStop: 's parar',
  keyRestart: 'R reiniciar',
  keyOpen: 'o abrir',
  keyBack: 'esc voltar',
  keyQuit: 'q sair',
  keyTaskClose: 'esc fechar',
  keyScroll: '↑↓/pg rolar',
  keyEnds: 'g/G extremos',
  keyRefresh: 'r atualizar',
  keyLogSource: '[ ] fonte',
  dashView: '1-6/tab tela',
  dashFilter: 'f assistente',
  dashPage: ', . paginar',
  keyMouse: 'm mouse',
  keyMouseCopy: 'shift+arrastar copia',

  paneServices: 'serviços',
  paneConfig: 'config',
  paneDetail: 'detalhe',
  paneOutput: 'saída',

  sectionRuntimes: 'RUNTIMES',
  sectionAddresses: 'ENDEREÇOS',
  sectionMachine: 'MÁQUINA',
  sectionStartBlocked: 'INDISPONÍVEL AQUI',

  modeLabel: 'modo',
  historyLabel: 'histórico',
  endpointLabel: 'endpoint',
  languageLabel: 'idioma',
  languageValue: 'Português',
  setupLabel: 'SETUP',
  mouseLabel: 'mouse',
  mouseOn: 'ligado',
  mouseOff: 'desligado',
  sessionPollLabel: 'atualização',
  actSessionPoll: 'Trocar',

  pidLabel: 'pid',
  uptimeLabel: 'no ar há',
  webLabel: 'web',
  apiLabel: 'api',
  noServices: 'nada detectado ainda.',
  bootLabel: 'boot',
  bootOn: 'inicia no boot',
  bootOff: 'não inicia no boot',

  actStop: 'Parar',
  actOpen: 'Abrir no navegador',
  actStopAll: 'Parar tudo',
  actRestartAll: 'Reiniciar tudo',
  actUpgrade: (v) => `Atualizar para v${v} e reiniciar`,
  actConnect: 'Conectar',
  actDisconnect: 'Desconectar',
  actHistory: 'Mudar',
  actLanguage: 'Trocar',
  actMouse: 'Trocar',
  actSetup: 'Mudar…',

  stateUp: 'no ar',
  stateDown: 'parado',
  stateUnknown: 'desconhecido',
  stateConflict: 'conflito',

  working: 'trabalhando',
  yes: 'Sim',
  no: 'Não',

  killQuestion: 'Já existe um servidor rodando aqui — parar e iniciar outro?',

  setupQuestion: 'Como esta máquina deve registrar o uso, e o que pode sair dela?',
  setupMode: { solo: 'solo', central: 'central', member: 'member' },
  setupModeHint: {
    solo: 'só local — nada sai desta máquina',
    central: 'hospedar a central do time (Docker) aqui',
    member: 'tudo que o solo faz, e ainda envia métricas (nunca chat) para uma central',
  },
  archiveUnset: 'ainda não escolhido',
  archiveQuestion: 'Preservar o histórico de sessões?',
  archiveWhy: 'O Claude apaga transcrições de sessão com mais de 30 dias.',
  archiveConsolidate: 'consolidate',
  archiveConsolidateHint: 'recomendado — guarda as métricas por sessão já calculadas (~KB cada)',
  archiveFull: 'full',
  archiveFullHint: 'arquivista — também espelha as transcrições cruas para reler os chats (pesado)',
  archiveOff: 'off',
  archiveOffHint: 'não fazer nada — usar a limpeza padrão de 30 dias do Claude',
  archiveLater: 'decidir depois',
  archiveLaterHint: 'a interface vai exigir a resposta antes de abrir',
  archiveLaterMessage: 'Histórico sem definição — a interface vai perguntar antes de abrir.',
  bootQuestion: 'Iniciar também no boot (serviço systemd de usuário)?',

  logSource: 'FONTE',
  logEmpty: 'nada registrado ainda.',
  logLoading: 'lendo…',
  logFollow: 'f acompanhar',
  logFollowing: 'acompanhando',
  logPaused: 'pausado',

  sessionsEmpty: 'nenhuma sessão em execução.',
  sessionsEmptyActive: (total: number) =>
    `nada rodando · ${total} ${total === 1 ? 'sessão retida' : 'sessões retidas'} — l mostra`,
  sessionsEmptyFiltered: 'nada corresponde · esc limpa o filtro',
  sessionsLoading: 'lendo…',
  sessionsUnsupported: 'gerenciamento de sessões não está disponível nesta máquina.',
  // Ver a nota na versão em inglês: dois números de espécies diferentes ligados por "de" são lidos
  // como um só, e o medidor de memória do cabeçalho (`ram 4/18`) está na mesma tela.
  sessionsCount: (shown: number, total: number) => (shown === total
    ? (total === 1 ? '1 sessão' : `${total} sessões`)
    : `${shown} na tela · ${total} conhecidas`),
  sessionsWaitingCount: (n: number) => (n === 1 ? '1 esperando por você' : `${n} esperando por você`),
  sessionsWaitingSplit: (shown: number, total: number) =>
    (shown === 0
      ? `nenhuma na tela · ${total} esperando por você`
      : `${shown} na tela · ${total} esperando por você`),
  sessionsGroupBy: 'AGRUPAR',
  sessionsFilterBy: 'FILTRO',
  sessionsFilterActive: 'só as ativas',
  sessionsFilterNoHistory: 'sem conversas fechadas',
  sessionsFilterNamed: 'mais as nomeadas',
  sessionsGroupings: {
    day: 'dia',
    repo: 'repositório',
    task: 'tarefa',
    none: 'lista',
    tree: 'cascata',
    harness: 'harness',
    model: 'modelo',
    project: 'projeto',
    status: 'estado',
    marked: 'marcadas',
  },
  sessionsUnfiled: {
    day: 'sem data registrada',
    harness: 'harness desconhecido',
    model: 'sem modelo registrado',
    project: 'sem diretório registrado',
    task: 'sem tarefa',
    repo: 'sem repositório',
    status: 'estado não registrado',
    marked: 'não marcadas',
  },
  sessionsMarkedBand: 'marcadas',
  sessionsInterrupt: 'Parar o que está fazendo',
  sessionsInterruptIdle: 'Nada está rodando agora, então não há o que parar.',
  sessionsExternalRow: 'Esta sessão foi iniciada fora do agentop, então nada aqui age sobre ela.',
  sessionsUnknownHarness: 'harness desconhecido',
  sessionsUnknownModel: 'sem modelo registrado',
  sessionsUnknownProject: 'sem diretório registrado',
  sessionsUnknownTask: 'sem tarefa',
  sessionsUnknownRepo: 'sem repositório',
  sessionsWorktreeTag: 'worktree',
  sessionsCols: {
    id: 'id',
    state: 'estado',
    age: 'parada há',
    title: 'sessão',
    task: 'tarefa',
    worktree: 'worktree',
    metrics: 'uso (tudo)',
    context: 'janela',
    harness: 'harness',
    where: 'projeto',
  },
  sessionsWhere: 'onde',
  sessionsModel: 'modelo',
  sessionsNote: 'nota',
  sessionsStarted: 'iniciada',
  sessionsDoing: 'dizendo',
  sessionsTask: 'tarefa',
  sessionsMetrics: 'uso',
  sessionsMetricsAll: 'entrada + saída + cache',
  sessionsContext: 'janela de contexto',
  sessionsConversation: 'conversa',
  sessionsGoneProject: 'diretório não existe mais',
  sessionsAlsoLabel: 'nome daqui',
  sessionsAlsoHarness: 'nome de dentro',
  sessionsDetach: 'para sair',
  sessionsDoneWord: 'finalizada',
  sessionsPaneMenu: 'menu',
  sessionsPaneDetail: 'detalhe',
  sessionsPaneAsk: 'pergunta',
  sessionsPaneKeys: 'teclas',
  sessionsKeysMore: (shown, total) => `${shown} de ${total}  ·  ↑↓ rolar`,
  sessionsPaneRestore: 'da última vez',
  restoreTitle: (n: number) =>
    n === 1 ? 'Sua última sessão foi esta:' : `Suas últimas ${n} sessões foram estas:`,
  restoreAnswer: 'enter / R reabre as ativas · L / tab ir para a listagem · esc ignora',
  sessionsKeyWhat: {
    move: 'move o cursor',
    open: 'alterna entre o menu e a lista',
    attach: 'anexa — ou reabre, quando não há nada rodando',
    menu: 'abre o menu nessa linha',
    section: 'pula para uma seção do menu',
    newSession: 'inicia uma sessão',
    search: 'busca tudo, inclusive conversas fechadas',
    clear: 'limpa a busca, depois o projeto, depois a tarefa',
    kill: 'encerra esta sessão',
    rename: 'renomeia',
    note: 'escreve uma nota nela',
    task: 'arquiva sob uma tarefa',
    openTask: 'abre todas as sessões da tarefa dela',
    finishTask: 'marca a tarefa dela como finalizada',
    recent: 'as últimas conversas, mais recentes primeiro, sem agrupamento',
    cascade: 'exibe em cascata por diretório',
    mark: 'marca esta linha, e mantém marcada',
    onlyActive: 'mostra também o que não está rodando — fechadas, encerradas e perdidas',
    layout: 'lista ou cards',
    group: 'muda o agrupamento',
    detail: 'oculta o painel de detalhe',
    menuFold: 'recolhe o menu — qualquer dígito traz de volta',
    reset: 'volta para como o app abre',
    tabs: 'muda de tela',
    help: 'esta lista',
    quit: 'sai do agentop',
    approve: 'responde a pergunta que travou a sessão',
    prompt: 'envia uma linha para ela sem anexar',
    reopenFell: 'reabre tudo que a máquina levou de uma vez',
  },
  sessionsFinishConfirm: (task, count, running) =>
    `Finalizar "${task}"? ${count === 1 ? 'A sessão dela' : `As ${count} sessões dela`}`
    + `${running > 0 ? ` (${running} ainda rodando)` : ''}`
    + (count === 1
      ? ' NÃO é encerrada — continua rodando e fica listada'
      : ' NÃO são encerradas — continuam rodando e ficam listadas')
    + ' atrás do interruptor "tarefas finalizadas".',
  sessionsReopenConfirm: task => `Reabrir "${task}"?`,
  sessionsFellWord: 'caíram juntas',
  sessionsFellNote: (count, ago) =>
    (count === 1 ? `1 sessão caiu ${ago} — R reabre` : `${count} sessões caíram ${ago} — R reabre todas`),
  sessionsFellConfirm: (count, ago) =>
    (count === 1
      ? `Reabrir a sessão que caiu ${ago}? `
      : `Reabrir as ${count} sessões que caíram ${ago}? `)
    + 'Cada uma volta como uma sessão nova retomando a própria conversa; o que ainda estiver rodando fica como está.',
  sessionsDeleteTaskAsk: (task, count) => count === 0
    ? `Remover a tarefa "${task}"? Nenhuma sessão está sob ela.`
    : `Remover a tarefa "${task}"? ${count === 1 ? 'A sessão' : `As ${count} sessões`} sob ela `
      + `${count === 1 ? 'é MANTIDA' : 'são MANTIDAS'} — some só o rótulo.`,
  sessionsPromptLabel: (title: string) => `Enviar para "${title}"`,
  sessionsPromptHint: 'digitado direto na sessão — ela lê quando chegar lá',
  sessionsApproveConfirm: (title: string) => `Enviar a tecla de confirmação para "${title}"?`,
  sessionsApproveCaveat:
    'ela pega a opção que o diálogo acima está destacando — leia antes.',
  sessionsApproveWhat: 'na tela dela agora',
  sessionsChoiceHighlighted: '(o padrão dela)',
  sessionsChooseBlind: 'esse diálogo é uma escolha, e o agentop não sabe selecionar uma opção neste harness.',
  sessionsChooseAttach: 'o anexa na sessão, onde dá para responder — esc volta.',
  asideProjects: 'PROJETOS',
  asideAllProjects: 'todos os projetos',
  toggleDone: 'tarefas finalizadas',
  toggleActive: 'apenas ativas',
  toggleDetail: 'painel de detalhe',
  toggleCascade: 'cascata por diretório',
  sessionsDetailHide: 'd oculta',
  asideLayout: 'FORMATO',
  sessionsLayouts: { list: 'lista', cards: 'cards' },
  sessionsPage: (page, pages) => `${page} / ${pages}`,
  sessionsShowing: (shown, total) => `${shown} de ${total}`,
  sessionsCardAttached: 'anexada',
  sessionsCardBlind: 'aprovação incerta',
  keySessionsLayout: 'ctrl+g lista/cards',
  keySessionsCard: '←→ card',
  keySessionsPage: 'pgup/pgdn página',
  asideSort: 'ORDENAR',
  asideStates: 'ESTADO',
  sessionsSorts: {
    state: 'urgência', name: 'nome', started: 'início', recent: 'atividade',
    usage: 'uso', project: 'projeto',
  },
  sessionsStates: {
    'waiting-approval': 'precisa aprovação',
    // The same word the state COLUMN shows (`cli-i18n.ts`'s `sessState.waiting`). Two tables of one
    // vocabulary, and the sessions screen draws from both at once — the column from the host, the
    // band heading and the filter row from here. They have to say the same thing or the row reads
    // `aguardando resposta` under a band called `aguardando`.
    waiting: 'precisa de você',
    working: 'trabalhando',
    exited: 'encerrada',
    lost: 'desconectada',
    closed: 'fechada',
    unknown: 'externa',
  },
  sessionsSearching: q => `busca: ${q} · esc limpa`,
  searchScope: {
    name: 'nome', folder: 'pasta', harness: 'harness',
    note: 'nota', task: 'tarefa', prompt: 'prompt', transcript: 'transcript',
  },
  searchDepthLabel: 'achado em',
  searchRunning: 'lendo transcripts…',
  searchNoGrep: 'transcripts não buscados — não há grep aqui',
  searchNoTranscripts: 'transcripts não buscados — nenhum nesta máquina',
  searchTranscriptOff: 'transcrição desligada',
  viewSearchDepth: 'Buscar em',
  searchDepthName: 'título',
  searchDepthPrompt: 'primeiro prompt',
  searchDepthTranscript: 'transcrição (sessão completa)',
  searchDepthAll: 'todos',
  searchCovered: h => `transcripts: ${h}`,
  searchFailed: h => `não deu pra ler: ${h}`,
  sessionsAgo: (sec: number) => {
    if (sec < 60) return `há ${sec}s`
    const min = Math.round(sec / 60)
    if (min < 60) return `há ${min}min`
    return `há ${Math.floor(min / 60)}h ${min % 60}min`
  },
  sessionsExternalNote: 'iniciada fora do agentop — listada, mas não dá para anexar nem parar por aqui.',
  sessionsClosedNote: 'não está rodando — reabra para retomar esta conversa.',
  sessionsNoHost: 'o controle de sessões não está disponível nesta máquina.',
  sessionsReopenNone: 'nenhuma conversa para reabrir — nada nesta máquina resolve esta linha.',
  spawnUnknownHarness: h => `esta máquina não sabe iniciar ${h} — não há spawn spec para ele aqui.`,
  spawnCwdMissing: 'nenhum diretório informado — uma sessão precisa começar em algum lugar.',
  spawnCwdRelative: cwd => `${cwd} não é um caminho absoluto, e um relativo seria resolvido a partir do diretório do próprio servidor.`,
  spawnUnknownEffort: e => `${e} não é um nível de esforço que esta CLI aceite.`,
  spawnModelUnsupported: h => `${h} não tem flag de modelo — um modelo foi pedido e não teria como ser aplicado.`,
  keySessionsGroup: 'v agrupar',
  keySessionsAttach: 'o anexar',
  keySessionsReset: '^r restaurar view',
  keySessionsKill: 'x encerrar',
  keySessionsDeleteTask: 'x apagar tarefa',
  keySessionsRename: 'r nomear',
  keySessionsNote: 'm nota',
  keySessionsNew: 'n nova',
  keySessionsSearch: 'ctrl+f buscar',
  keySessionsActions: 'tab ações',
  keySessionsApprove: 'a aprovar',
  keySessionsPrompt: 'p enviar',
  keySessionsFold: 'b menu',
  keyRestoreAnswer: 'enter inicia · esc deixa fechadas',
  actSessions: {
    attach: 'Anexar',
    resume: 'Reabrir',
    // "Responder", não "Aprovar": a tecla pega a opção destacada, e o verbo não pode prometer mais
    // do que a tecla entrega.
    approve: 'Responder a pergunta',
    prompt: 'Enviar prompt',
    rename: 'Renomear',
    note: 'Nota',
    task: 'Tarefa',
    kill: 'Encerrar sessão',
    openTask: 'Abrir tarefa toda',
    reopenFell: 'Reabrir o que caiu',
    finishTask: 'Finalizar tarefa',
    deleteTask: 'Apagar tarefa',
    newSession: 'Nova sessão',
    search: 'Buscar',
    group: 'Agrupar',
  },
  sessionsTaskPrompt: 'De qual tarefa esta sessão faz parte?',
  taskHint: 'escolha uma, ou digite um nome novo',
  taskNone: 'sem tarefa',
  taskCurrent: '(atual)',
  sessionsOpenTaskConfirm: (task: string, n: number) =>
    `Reabrir todas as ${n} sessão(ões) de "${task}" em background?`,
  sessionsResumeConfirm: (title: string) => `Reabrir "${title}" como sessão gerenciada pelo agentop?`,
  sessionsResumeRunning:
    'o assistente que roda ela vai ser ENCERRADO e a conversa reaberta aqui — perde-se o turno em andamento, não a conversa.',
  sessionsSearchLabel: 'Buscar sessões e conversas fechadas',
  sessionsSearchEmpty: 'nada corresponde.',
  sessionsClosedWord: 'desligada',
  sessionsShowClosed: 'fechadas: visíveis',
  viewTitle: 'O que esta lista mostra',
  viewGroupBy: 'Agrupar por',
  viewShow: 'Mostrar',
  viewActiveOn: 'as que não estão rodando',
  viewClosedOn: 'conversas fechadas',
  viewClosedOff: 'conversas fechadas',
  viewUnfiledOn: 'sessões sem tarefa',
  viewUnfiledOff: 'sessões sem tarefa',
  viewHint: '↑↓ mover · enter escolher · esc fechar',
  asideActions: 'AÇÕES',
  asideView: 'VER',
  asideShow: 'MOSTRAR',
  asideTasks: 'TAREFAS',
  asideAllTasks: 'todas as tarefas',
  toggleHistory: 'não estão rodando',
  toggleNamed: 'sempre manter sessões nomeadas',
  keySessionsAside: 'tab menu',
  manageTitle: (title: string) => `Gerenciando "${title}"`,
  manageHint: '↑↓ mover · enter executar · esc voltar à lista',
  promptHint: 'enter salva · esc cancela',
  sessionsHideClosed: 'fechadas: ocultas',
  keySessionsActive: 'c só ativas',
  keySessionsDetail: 'd detalhe',
  keySessionsMark: 'space marcar',
  keySessionsClosed: 'c fechadas',
  keySessionsNoTask: 'u sem tarefa',
  keyTabsAlt: '[ ] telas',
  keyAsideSection: '1-9 ←→ seção',
  sessionsNoTaskHidden: 'sem tarefa: ocultas',
  sessionsNoTaskShown: 'sem tarefa: visíveis',
  wizHarness: 'Qual assistente?',
  wizWhere: 'Onde ela começa?',
  wizWhereHint: 'busque qualquer pasta na sua home — ou cole um caminho completo',
  wizModel: 'Qual modelo?',
  wizModelHint: 'escolha um, ou digite qualquer nome de modelo',
  wizEffort: 'Qual nível de raciocínio?',
  wizPrompt: 'Primeiro prompt (opcional)',
  wizPromptHint: 'deixe vazio para começar sem nada digitado',
  wizName: 'Chamar de quê?',
  wizNameHint: 'um nome seu — enter vazio deriva um do harness e da pasta',
  wizHow: 'Iniciar como?',
  wizStarting: 'iniciando…',
  wizKeptDraft: 'nada do que você digitou foi perdido — esc volta um passo, ou tente de novo',
  wizNoSpawn: 'esta build não consegue iniciar sessões.',
  wizNeedHarness: 'escolha um assistente primeiro.',
  wizNeedCwd: 'escolha uma pasta primeiro.',
  wizAttached: 'anexada — assume este terminal agora',
  wizBackground: 'background — deixa rodando e fica aqui',
  wizSkip: 'usar o padrão',
  wizNoMatch: 'nada corresponde — cole um caminho completo para usar um diretório sem histórico',
  wizColName: 'pasta',
  wizColRepo: 'repositório',
  wizColPath: 'caminho',
  wizColWhy: 'por quê',
  wizNoRepo: 'sem repositório',
  wizSourceCwd: 'você está aqui',
  wizSourceTyped: 'digitado',
  wizSourceHistory: 'já trabalhou aqui',
  wizSourceRepo: 'repo git',
  sessionsRenamePrompt: 'Dê um nome a esta sessão',
  sessionsNotePrompt: 'Descreva esta sessão',
  sessionsKillConfirm: (title: string) => `Encerrar "${title}"? O assistente que roda nela é finalizado.`,
  sessionsNotActionable: 'essa sessão não foi iniciada pelo agentop, então não dá para controlá-la daqui.',
  sessionsNotAsking: 'essa sessão não está travada em uma pergunta — não há o que responder.',
  sessionsNoFell: 'nada caiu — nenhuma sessão foi perdida com registro de que estava viva.',

  helpIntro: 'Todos os comandos, com as flags que importam. `agentop --help` imprime isto puro.',
  cheatIntro: 'Os comandos que vale a pena lembrar.',
  contributeIntro: 'Agentistics é open source — issues e pull requests são bem-vindos.',
  dashDown: 'O servidor agentistics não está rodando, então não há métricas para ler. Suba-o na tela de serviços.',
  dashUnknown: 'Não foi possível ler o estado do servidor agentistics, então não há métricas para mostrar. A tela de serviços diz por quê.',
  copyHint: 'selecione com o mouse para copiar',
  copyHintShift: 'segure shift e arraste para selecionar e copiar',

  paneHarnesses: 'harnesses',
  backupHostMissing: 'esta build não consegue ler o estado do backup.',
  keyBackupToggle: 'espaço alternar',
  keyBackupRun: 'b rodar backup',
  keyBackupSchedule: 's agenda',
  keyLayerToggle: 'espaço alternar',
  keyLayerSave: 'enter salvar',
  keyLayerCancel: 'esc cancelar',
  actBackupRun: 'Rodar backup',
  actBackupSchedule: 'Mudar agenda',
  actBackupEditLayers: 'Editar camadas',
  actBackupEditScheduleLayers: 'Editar camadas da agenda',
  backupLayersLabel: 'camadas',
  backupScheduleLayersLabel: 'na agenda',
  backupLayerName: {
    metrics: 'Métricas',
    repos: 'Repositórios',
    archive: 'Transcripts espelhados',
    raw: 'Conversas',
  },
  backupLayerAlwaysOn: 'sempre ativo — um backup sem métricas não restaura nada',
  backupLayerSizeUnknown: 'conhecido só depois de rodar',
  backupScheduleReposNote: 'uma execução agendada nunca carrega isto — é construído por `agentop backup`, não numa agenda',
  backupDestLabel: 'destino',
  backupScheduleLabel: 'agenda',
  backupKeepLabel: 'manter',
  backupKeepValue: (keep, retainedLabel) => `${keep} backup${keep === 1 ? '' : 's'} (${retainedLabel})`,
  backupSecretsLabel: 'segredos',
  backupSecretsValue: n => `excluídos (${n} ${n === 1 ? 'item' : 'itens'})`,
  backupLastLabel: 'último',
  backupSessionsLabel: 'sessões',
  backupSizeLabel: 'tamanho',
  backupScheduleWord: { off: 'desligada', daily: 'diária', weekly: 'semanal' },
  backupScheduleInactive: '— inativa (servidor parado)',
  backupNever: 'nunca',
  backupLastGone: 'nenhum (nenhum backup gravado cujo arquivo ainda esteja no disco)',
  backupLastGoneShort: 'sumiu',
  backupNoneOnDisk: 'ainda não há backup no disco',
  backupAgo: elapsed => `há ${elapsed}`,
  backupLastOk: 'ok',
  backupLastUnknown: '(desconhecido se algo foi pulado)',
  backupLastSkipped: n => `${n} pulado${n === 1 ? '' : 's'}`,
}

const TABLE: Record<CliLang, ControlStrings> = { en: EN, pt: PT }

export function controlStrings(lang: CliLang): ControlStrings {
  return TABLE[lang] ?? EN
}

/**
 * The dimension word book for one language — the ONE place the strings are wired to the table.
 *
 * Every surface that groups or filters (the cockpit, `agentop session ls`) calls this rather than
 * assembling its own: two assemblies is two chances for a band and the chip that selects it to be
 * called different things, which is the whole defect the dimension table exists to remove.
 */
export function sessionWordBook(
  c: ControlStrings,
  /**
   * What to call particular DAYS, keyed `YYYY-MM-DD`.
   *
   * Supplied by the caller rather than resolved here, because "today" and "yesterday" are relative
   * to a clock this module does not read — and a string table that reads a clock is a string table
   * whose answers go stale at midnight. A day nobody names falls back to its own key, which is
   * already a readable date.
   */
  days?: Readonly<Record<string, string>>,
): DimensionWordBook {
  return dimensionWordBook({
    ...(days ? { days } : {}),
    labels: {
      day: c.sessionsGroupings.day,
      status: c.sessionsGroupings.status,
      harness: c.sessionsGroupings.harness,
      model: c.sessionsGroupings.model,
      project: c.sessionsGroupings.project,
      repo: c.sessionsGroupings.repo,
      task: c.sessionsGroupings.task,
      marked: c.sessionsGroupings.marked,
    },
    unfiled: c.sessionsUnfiled,
    states: c.sessionsStates,
    goneProject: c.sessionsGoneProject,
    marked: c.sessionsMarkedBand,
  })
}
