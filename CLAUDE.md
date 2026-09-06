# agentistics — CLAUDE.md

Local analytics dashboard for AI coding assistants. Visualizes tokens, costs, activity, projects, and agent metrics based on data from `~/.claude/`.

## Process rules live in AGENTS.md, not here

Issue/PR/Project-board/Discussion workflow rules are harness-agnostic and live in `AGENTS.md` at
the repo root — read it before opening an Issue, starting implementation work, or submitting a PR.
This file stays Claude-Code-specific implementation memory and does not duplicate those rules.

## Language convention

**Everything in this project is in English**: code, comments, commit messages, PR titles and descriptions, documentation, and this file.

## Monorepo structure

```
packages/
  core/     (@agentistics/core)   — shared types, pricing, formatters, i18n, otel helpers
  server/   (@agentistics/server) — Bun HTTP server, CLI (agentop), otel-watcher, scripts
  web/      (@agentistics/web)    — React + Vite frontend
  mcp/      (@agentistics/mcp)    — MCP server, publishable to npm standalone
  tui/      (@agentistics/tui)    — Ink (React) terminal dashboard + the `agentop` control center
  vscode/   (agentistics-vscode)  — the VS Code extension: a CLIENT of the local server, no more
  desktop/                        — Tauri v2 Windows installer (spawns agentop as sidecar)
```

## Architecture

```
packages/server/bin/cli.ts  (binary entry point — agentop)
  ├── agentop (bare) / start → server/cli-start.ts → @agentistics/tui/control (the full-screen control center: Services / Sessions / Dashboard / Logs / Cheat sheet / Help / Contribute; EN default + pt-BR toggle; an unconfigured machine opens with the SETUP WIZARD already asking — `runControlCenter({ setup: true })`, a flag rather than a tab, because setup is a question the cockpit asks). Non-TTY stdin falls through to `server`; without a terminal bare `agentop` prints the help instead
  ├── agentop setup        → server/cli-setup.ts (the same solo/central/member wizard, non-interactively scriptable; its interactive twin is the cockpit's wizard, reached from the config pane's mode row)
  ├── agentop server       → server/index.ts + server/otel-watcher.ts (always together)
  ├── agentop restart …    → bounce a mode's service (`server`/`watch` → systemd; `central` → central.sh restart; `--all` → cli-start.ts restartAllServices over every running service). `--rebuild` rebuilds before restarting instead of just bouncing (`central` → `up`; machine → `compose build --no-cache` then `compose up -d --force-recreate`; `server`/`watch` → `rebuildNativeBinary()`, i.e. `bun run bin`, which needs the repo checkout — outside one it says so and restarts the existing build). **A rebuild is a FULL rebuild**: the Docker paths pass `--no-cache`, because a cached one could hand back the very image it was asked to replace, and they say so on the way in — that build is several minutes. `--cache` is the escape hatch (reuse Docker's layer cache); `-y`/`-n` answer `central.sh up`'s "re-run interactive setup?" prompt up front, so an unattended rebuild never waits on a keypress. All of it is resolved by the pure `rebuild-flags.ts` (`parseRebuildFlags` / `centralRebuildArgs` / `composeRebuildCommands`) — the shell receives an already-decided answer, `-y` with `-n` (or `--cache` with `--no-cache`) is refused rather than resolved, and the control center's rebuild verb passes `-n` EXPLICITLY instead of relying on its piped child failing `[ -t 0 ]`. A plain `agentop central up` / `central.sh up` is not a rebuild and keeps its cached build
  ├── agentop tui          → an ALIAS for `start`, renamed in cli.ts's one-line dispatch. There is no second Ink app: the metrics ARE the control center's `dashboard` tab, and a branch of its own would be a copy that starts identical and drifts
  ├── agentop watch        → server/otel-watcher.ts (daemon only)
  ├── agentop central …    → server/cli-central.ts (up/init/down/logs/status/restart/pull/setup-token/reset-password). **HOW a central runs is the USER'S choice, not an inference** — the pure `central-runtime.ts` holds the three shapes (`docker-build` = central.sh builds from the checkout, `docker-image` = pull ghcr.io/blpsoares/agentistics, `native` = the binary IS the server) plus which of them work HERE and why not. It used to be pure inference (a checkout meant central.sh, no checkout meant the image), which made two reasonable requests impossible to express: the published image from inside a clone, and a native server anywhere. `up` now takes `--image` / `--build` / `--native` (+ `--bg`, which finally exposes the detached native start that only the control center could reach), the wizard ASKS and records the answer in `AGENTISTICS_CENTRAL_RUNTIME` — read by the CLI only, passed into no container — and every later action resolves the same way the first did. **A requested shape that cannot work is REFUSED in a sentence, never downgraded**: a `--native` that quietly became a Docker start is a central running under a shape its operator did not choose. `defaultCentralRuntime` reproduces the old inference exactly and `central-runtime.test.ts` pins it against `planCentralStart`, so an upgrade changes nothing for an existing central. `up` still takes -y/-n and --cache/--no-cache
  ├── agentop member …     → server/cli-member.ts (connect/leave/status; whoami-verified, no browser)
  ├── agentop session …    → server/sessions/cli-session.ts (start/ls/list/attach/kill/rename/note;
  │                          `--bg` detaches via tmux, attach prints the REAL detach key; `list`
  │                          reports what each session is DOING and names the harnesses whose
  │                          approval detection is unavailable). **`ls` is the COCKPIT'S TABLE
  │                          printed**: it consumes `packages/tui/src/control/sessions.ts` —
  │                          `sessionColumns` / `groupSessions` / `sessionRows` / `sessionRunning`
  │                          — through the pure `session-table.ts`, and owns only the DRAWING (ANSI,
  │                          `process.stdout.columns`, a final clip so no row can wrap). A second
  │                          implementation of the table would be a second set of rules, which is
  │                          the bug `task-reopen.ts` exists to have fixed once. It is a NEW command
  │                          rather than a flag: `list` is the tab-separated dump scripts already
  │                          read, so its output is untouched and both print the same `--json`.
  │                          Without a tty there is no colour and the width comes from `COLUMNS`
  │                          when there is one — a pager IS a reader — so `session ls | grep` works
  ├── agentop hooks …      → server/cli-hooks.ts (install/uninstall/status/context — the Claude Code
  │                          integration: a SKILL that teaches the `session batch` contract, a
  │                          SessionStart HOOK that injects the live fleet, and a Stop HOOK that
  │                          feeds the event channel. Explicit, idempotent, exactly reversible;
  │                          see docs/claude-integration.md)
  ├── agentop events …     → server/cli-events.ts (watch/unwatch/status/tail/run/emit/test — the
  │                          EVENT CHANNEL: a state TRANSITION reaches a person and the assistant
  │                          orchestrating the fleet. See `events/` below and docs/session-events.md.
  │                          It is `events`, not `watch`, because `agentop watch` is already the
  │                          OTel daemon and `agentop restart watch` would become ambiguous)
  ├── agentop ci-push      → server/ci-push.ts (one-shot GitHub Actions runner → central push; env AGENTISTICS_CENTRAL_URL/AGENTISTICS_CI_TOKEN)
  ├── agentop autostart …  → server/autostart.ts (systemd user service + linger + ~/.bashrc + ~/.zshrc update-check hook)
  ├── agentop upgrade      → server/upgrade.ts
  └── agentop check-update → server/version.ts (prints a banner only when outdated; silent otherwise)

packages/server/server/index.ts (Bun, port 47291) — thin entry point
  └── delegates to server/ modules (see below)

packages/server/server/          — server-side modules (never bundled by Vite)
  ├── config.ts            → path constants + PORT (api+mcp, 47291) + WEB_PORT (dashboard, PORT+1=47292); binary mode binds BOTH
  ├── utils.ts             → createLimiter, safeReadJson, safeReadDir, safeStat
  ├── git.ts               → decodeProjectDir, getGitFileStats, getProjectGitStats
  ├── jsonl.ts             → parseSessionJsonl, makeEmptySession, classifyAgentFile, EXT_TO_LANG
  ├── health.ts            → runHealthChecks, analyzeToolHealthIssues
  ├── rates.ts             → pricing scraper + BRL rate cache
  ├── sse.ts               → SSE clients, chokidar watcher, serveStatic, maybeSpawnWatcher
  ├── archive.ts           → mirrorFile, fullSync, snapshotStatsCache ('full' mode: raw transcript mirror → ~/.agentistics/archive)
  ├── consolidate.ts       → writeConsolidated, loadConsolidated ('consolidate' mode: per-session metrics → ~/.agentistics/sessions/<harness>/<id>.json; legacy flat files load as claude)
  ├── data.ts              → loadSessionMetas, scanProjects, buildApiResponse (main orchestrator)
  ├── agent-metrics.ts     → extractAgentMetrics (parses Agent tool_use from JSONL)
  ├── otel-watcher.ts      → chokidar file watcher + OTLP metrics export daemon
  ├── preferences.ts       → ~/.agentistics prefs incl. team config (mode/endpoint/token/user)
  ├── version.ts           → getVersionInfo (current vs latest); drives update banners/notifications
  ├── autostart.ts         → systemd user service + loginctl linger + ~/.bashrc + ~/.zshrc update-check hook
  ├── cli-setup.ts / cli-central.ts / cli-member.ts → the agentop setup/central/member command handlers
  ├── sessions/            → the session manager and the fleet monitor behind the cockpit's
  │                          `sessions` tab. `SessionBackend` is the platform boundary (tmux;
  │                          **there is no Windows backend and `index.ts` records why** — Bun
  │                          exposes no PTY primitive and a native module cannot live in the
  │                          single compiled binary, so Windows is told to use WSL rather than
  │                          handed a verb that cannot work). The PURE `spawn-spec.ts`
  │                          (`Record<HarnessId, SpawnSpec|null>` — a harness with no spec is
  │                          ABSENT from the wizard, never offered and failing), the PURE
  │                          `tmux-cli.ts` (every tmux argv and parse), `session-ref.ts` and the
  │                          `managed-sessions.json` registry. **Every flag is read from the
  │                          tool's own `--help`, never guessed** — codex's reasoning effort is
  │                          deliberately absent for that reason, while agy's IS wired up because
  │                          its `--help` prints the closed set. `kimi` and `copilot` get their
  │                          first prompt TYPED IN, because their `-p` exits after answering.
  │                          **What a session is DOING** is the pure `attention.ts` over two
  │                          signals — a probed screen marker and whether the frame moved — with
  │                          `attention-rules.ts` holding the per-harness patterns **captured
  │                          from live dialogs**, each with its CLI version and date. There
  │                          is deliberately no `idle` state: an interactive assistant that is
  │                          alive and still is waiting for you, and the uncertainty that really
  │                          exists is about the REASON, which lives in an absent approval rule
  │                          the UI states in words. **One harness can have SEVERAL dialog
  │                          components with different footers**: claude's startup select says
  │                          `Enter to confirm · Esc to cancel` and its PERMISSION prompt says
  │                          `Esc to cancel · Tab to amend`, and for one release only the first was
  │                          probed — so a session sitting on "may I run this command" read as
  │                          `waiting`, and a prompt sent to it went into the dialog's own filter
  │                          where the submit took the highlighted option. Probe every dialog a
  │                          harness draws, not the first one it shows you. It has since been THREE
  │                          for claude — startup select, permission prompt, `AskUserQuestion` —
  │                          each with its own footer, so assume there is another until somebody has
  │                          looked. Two harnesses MAY share a footer (claude and gemini measurably
  │                          do); that is a fact about the CLIs, not a loose pattern, and costs
  │                          nothing because `rulesFor` only ever tests a harness against itself.
  │                          **A footer is matched in the LAST FEW LINES ONLY** (`FOOTER_LINES`), and
  │                          a frame whose FOOTER carries the WORKING marker is never `waiting-
  │                          approval`. Matching anywhere in a 60-line capture meant any session that
  │                          QUOTED a footer read as sitting in that dialog — guaranteed here rather
  │                          than unlikely, since agentop is developed with agentop: a session
  │                          editing `attention-rules.ts` has those exact strings on screen all day,
  │                          and one was offered a destructive key over a question it never asked.
  │                          The working-marker veto is deliberately checked in the FOOTER and not
  │                          over the whole frame — claude prints `esc to interrupt` whenever
  │                          anything is interruptible, background subagents included, so a
  │                          whole-frame veto would suppress a REAL permission prompt on a busy
  │                          session. Suppressing a real block is the one error worse than the one
  │                          being fixed.
  │                          **ACTING on a session without entering it** is `SessionBackend.sendText`
  │                          / `sendKey` (they were already implemented, buried inside `spawn`) plus
  │                          the pure `approval-spec.ts` + `dialog-choice.ts`. **Most dialogs are not
  │                          yes/no**: claude's permission prompt is itself `1. Yes / 2. Yes, always
  │                          / 3. No`, and an `AskUserQuestion` can offer five answers that do
  │                          different work. A key that "approves" takes whichever row is
  │                          HIGHLIGHTED, which on such a dialog is choosing for the user — reported
  │                          by one, looking at "how do I promote to prod?" with four answers. So
  │                          `parseDialogOptions` reads the options OFF THE SCREEN (bottom-up,
  │                          stopping at `1.`, and refusing unless they come out exactly `1..n` —
  │                          half-read options are worse than none because they get OFFERED), the UI
  │                          lists them, and the PICKED one is sent. `ApprovalSpec.choice` says how
  │                          to select by number and exists ONLY for claude, verified by driving a
  │                          live session; everywhere else a numbered dialog is REFUSED in words
  │                          naming what does work (attach), because falling back to the confirm key
  │                          is the defect. The bare confirm survives only where there is genuinely
  │                          nothing to choose between (codex's `Press enter to continue`). The host
  │                          RE-READS the screen immediately before sending (a poll is 5s old) and
  │                          refuses when the options CHANGED, and the question SHOWS the dialog
  │                          (`approvalTail`, deliberately not `frameTail`: that one cuts at the last
  │                          rule and so cuts the dialog away). A prompt is refused on a session with
  │                          a dialog OPEN, in words, for the same reason.
  │                          **WHICH SESSIONS FELL TOGETHER** is the pure `crash-group.ts`. The hard
  │                          part is not grouping, it is not admitting garbage: a `lost` row from
  │                          three days ago never fell, and a group holding everything that ever ran
  │                          cannot be reopened without reading it first. Membership needs evidence a
  │                          session was ALIVE, which did not exist — so the registry carries
  │                          `lastSeenMs`, stamped at birth and refreshed by a 60s HEARTBEAT that
  │                          writes ONE timestamp for EVERY live session in one write. That is what
  │                          makes the clustering exact rather than fuzzy. Every rule errs toward
  │                          EXCLUDING (no `lastSeenMs` = not in the group, ever): a session wrongly
  │                          left out costs one keypress on its own Reopen verb, one wrongly let in
  │                          is invisible and makes the whole group untrustworthy.
  │                          **What a session CALLS ITSELF** is `harness-session-file.ts` (pure) +
  │                          `harness-sessions.ts`: Claude Code writes `~/.claude/sessions/<pid>.json`
  │                          holding the name `/rename` set, the conversation id, the pid, and — for
  │                          a session we started — the TMUX SESSION NAME, which is an EXACT link to
  │                          one of our rows where everything else here has had to guess by
  │                          harness-and-directory. `Record<HarnessId, source | null>`, claude only.
  │                          `nameSource: 'derived'` marks a name the HARNESS invented (24 of 40 on
  │                          a real machine) and it never competes; `pickTitle` settles the rest by
  │                          recency where both sides say when, and otherwise gives it to the
  │                          harness — `nameSince` exists only from claude 2.1.232, and the
  │                          complaint this answers is a rename made inside the session that agentop
  │                          went on ignoring. NEITHER name is discarded when they differ: the row
  │                          says which place the one it is showing came from. **A `/rename` name
  │                          OUTLIVES the process**: the harness deletes its `<pid>.json` on exit, so a
  │                          finished session lost that name and its title FLIPPED to another source,
  │                          breaking search — the poller now PERSISTS the live non-derived name into
  │                          `ManagedSession.harnessName`/`harnessNameSince` (mirror of
  │                          `recordConversation`, one write per rename, `chosenName` only), and
  │                          `buildSessionViews` reads it as the fallback when the live file is gone, so
  │                          `pickTitle` returns the same title alive or finished. `session-view.ts` merges the managed fleet
  │                          with the EXTERNAL assistants `/proc` reports (listed, marked, and
  │                          carrying no activity — nothing about them is capturable), and
  │                          `sessions-host.ts` is the 5s poller, whose failed poll keeps the
  │                          previous list plus a reason rather than reporting an empty one.
  │                          `project-search.ts` / `project-source.ts` feed the wizard's search
  │                          field from the LOCAL store, so it works with the server stopped.
  │                          **A reboot takes tmux and leaves the registry**, so every managed
  │                          session reconciles to `lost` while keeping its name, note and task —
  │                          `session-view.ts` therefore offers REOPEN for any managed row that is
  │                          not running, not only for one the user finished. **But a RETIRED
  │                          predecessor is not a second session**: every attach/reopen/restart mints a
  │                          new managedId for the SAME conversation and retires the old record without
  │                          removing it, so a conversation reopened N times drew N `exited` rows beside
  │                          its live continuation — the row key was the per-spawn id, not the identity.
  │                          The pure `collapseSupersededSessions` (session-view.ts, applied at the
  │                          return) drops a predecessor ONLY when it is provably dead (`endedMs` set)
  │                          AND superseded by a same-`conversationId` sibling (a live row, or a newer
  │                          ended one). It NEVER hides a live row, a `lost` row with no recorded end,
  │                          or the newest ended row (the reopenable one); rows with NO conversationId
  │                          are never grouped, because a shared directory or label is not an identity —
  │                          the coordinator reads this list to decide whether to re-dispatch over work
  │                          in flight, so a row it cannot prove dead is never removed. The
  │                          pure `task-reopen.ts` holds what "open the whole task" means (a running row
  │                          is left alone and reported as `already`, never as a skip; a FINISHED
  │                          row is not resurrected; an unresolvable one is skipped AND counted;
  │                          everything reopened RETIRES the row it replaced, or a laptop closed
  │                          twice leaves the task holding dead twins under one name). It is shared
  │                          by `agentop session open`, the cockpit's verb and "reopen what fell",
  │                          which were separate implementations of one gesture and had drifted.
  │                          **Every poller must be given the same SOURCES** — `session ls` builds its
  │                          own and went one commit missing `loadHarnessSessions`, so a row renamed
  │                          inside its session read correctly in the cockpit and stale on the command
  │                          line. It gets no heartbeat, though: a one-shot command must not stamp
  │                          `lastSeenMs`.
  │                          `repo-facts.ts` answers which REPOSITORY a directory belongs to,
  │                          keyed on the git REMOTE — the only key a worktree provably shares with
  │                          its main checkout, since their directory names deliberately differ —
  │                          falling back to the COMMON git dir's parent (`--show-toplevel` would
  │                          answer with the worktree, which is the one name that must not become
  │                          the key). Memoized by directory: the poll runs every five seconds.
  │                          **A directory that is GONE is not a directory outside a repository**,
  │                          and the discriminator is whether it EXISTS, never whether git answered.
  │                          `ExitWorktree --remove` leaves the session registered at a path that
  │                          names nothing, every `git -C` fails, and the grouping fell through to the
  │                          last path segment — so the removed worktree `member-connect-rotate`
  │                          appeared as a PROJECT standing beside `Agentistics`, the project it was
  │                          a worktree of. A folder name is a guess there, and inventing one from a
  │                          path that resolves to nothing is the same error as a confident `0` for a
  │                          metric nobody can produce. So `ManagedSession.repo` records the facts AT
  │                          SPAWN — the one moment the directory is provably there — the pure
  │                          `resolveRepoFacts` prefers live git, then the record, then says
  │                          `missing`, and `groupSessions` files a row with nothing left to name it
  │                          under ONE bucket said in words (`GONE_PROJECT_KEY`, unreachable as a real
  │                          key because every project key is a single path SEGMENT). The MEMO also
  │                          caches POSITIVE answers only: a negative one is a fact about the moment,
  │                          not about the directory, and caching it for the life of the process left
  │                          a cwd first probed while its worktree was deleted repo-less forever, even
  │                          after `agentop session open` put it back. Negatives expire
  │                          (`NEGATIVE_TTL_MS`); a MISSING directory never spawns git at all.
  │                          **The conversation link is recorded at SPAWN wherever the CLI accepts an
  │                          id** — `SpawnSpec.assignId`, `claude --session-id <uuid>` and
  │                          `copilot --session-id <uuid>`, both verified by running them and
  │                          checking that the file the adapter reads back carries that very id.
  │                          Before this it existed only for a REOPENED row plus, for claude alone,
  │                          whatever `harness-sessions.ts` could read out of `~/.claude/sessions/
  │                          <pid>.json` while the process lived — so a session started with the
  │                          cockpit closed had nothing but the harness-and-directory guess, which
  │                          gives every session of one repository the same conversation. Gemini
  │                          accepts a UUID and is deliberately EXCLUDED: its id in this product is
  │                          synthetic (`${dir}/${file}`), so a recorded UUID would resolve to
  │                          nothing while LOOKING like an exact link. Where no link can ever exist
  │                          (codex, kimi, gemini, agy) `conversationLinkable` is false and the row
  │                          SAYS so. And a row that knows its conversation never falls back to the
  │                          guess even when the store has not caught up: "not yet" and "some other
  │                          conversation in this directory" are different answers.
  │                          **A MANAGED row now carries the conversation's metrics too** — tokens,
  │                          cost and the CONTEXT GAUGE. Only `external` and `closed` rows read them
  │                          from the store before, so on a machine whose whole fleet is
  │                          agentop-started (the normal case once the session manager is in use) the
  │                          usage column was empty on every live row. `metricsOf` is a READ, never a
  │                          claim: it is deliberately separate from `claimResume`, which hands out a
  │                          reopen target and must give each conversation to at most one row, and it
  │                          accepts only the EXACT links (the harness's own `~/.claude/sessions/<pid>.json`
  │                          matched by tmux session, or the id the registry stored while the session
  │                          was up). The harness-and-directory INFERENCE that `claimResume` falls back
  │                          to is refused here: a reopen is offered to a person who can recognise the
  │                          title and decline, while a gauge is read at a glance and believed, so two
  │                          sessions in one worktree would both wear the older one's fill level with
  │                          nothing on screen saying so.
  │                          The pure `control-session.ts` is the ONE `SessionView` -> `ControlSession`
  │                          mapping (it lived inside `cli-start.ts` while the cockpit was the only
  │                          thing drawing a row) and `session-table.ts` is the pure renderer behind
  │                          `agentop session ls` — including `emptyReason`, which keeps "the poll
  │                          failed", "there is nothing" and "the filter withheld it" three different
  │                          sentences.
  │                          **A RENAME lands in BOTH places a session can be named.** The reverse
  │                          direction always worked (`pickTitle` reads the harness's own record);
  │                          only agentop→harness was missing, so a row renamed here kept whatever
  │                          the harness went on calling itself and lost to it on recency. The pure
  │                          `rename-spec.ts` is `Record<HarnessId, RenameSpec|null>` and holds ONE
  │                          entry — claude's `/rename`, read from its own command table
  │                          (`immediate: true`, so it costs the session no turn). The other five
  │                          nulls are FINDINGS, each with its sentence: copilot and kimi HAVE a
  │                          rename and expose it only in-process (an SDK method, a UI call over
  │                          `state.json`); codex, gemini and agy have none at all. Two routes were
  │                          tried against claude 2.1.233 and REJECTED BY MEASUREMENT, not by taste:
  │                          the messaging socket carries a `{subtype:'rename_session'}` control
  │                          request that belongs to the SDK's stdio transport and is IGNORED there
  │                          (sent with a valid token and a distinct title, the record did not
  │                          change), and there is no CLI subcommand. Writing the harness's own file
  │                          is refused on principle: a live process rewrites it on every status
  │                          change, so our bytes would vanish while the session showed the old name
  │                          — a rename reporting success and doing nothing. So it is a TYPED LINE,
  │                          which means it needs a pane: an `external` or non-running row keeps its
  │                          agentop label alone. **The label is written on every path** — refusing
  │                          outright would make a `lost` row unnameable, which is most of what the
  │                          verb is for — and what became of the harness half is SAID in words
  │                          (`renameMessage`, one sentence per reason). It REFUSES on an open
  │                          dialog, like `promptSession`: a `/rename` typed into a permission
  │                          prompt goes into the dialog's filter and the submit takes the
  │                          highlighted option. `rename.ts` is the one implementation both
  │                          `agentop session rename` and the cockpit's verb call — one gesture
  │                          implemented twice is the bug `task-reopen.ts` exists to have fixed once.
  │                          **A RUNNING session whose registry record is GONE is taken back**
  │                          (`session-adopt.ts`, pure). `registry.ts` serialises writes within ONE
  │                          process and says so; agentop runs as several (cockpit, daemon, every
  │                          one-shot command) all read-modify-writing one file, and a record added
  │                          by a short-lived one has been observed ERASED by a longer-lived one.
  │                          Measured 2026-08-15: `agentop session attach <conversation-id>` took
  │                          over a conversation, spawned `agentop-a2b569c123`, and the file that
  │                          survived did not hold it while nine sibling rows were intact — leaving
  │                          the user sitting in a session that was `unregistered`, filed under
  │                          `GONE_PROJECT_KEY`, and beyond every verb (they all resolve against the
  │                          registry). Adoption never INVENTS: the link is the harness's own record
  │                          naming our tmux session (`byManagedId`), a row with no such record or no
  │                          `cwd` stays visible and unregistered rather than being filed under a
  │                          guessed directory, and a `derived` name is never adopted as a label. The
  │                          takeover additionally READS ITS WRITE BACK and retries once, saying so
  │                          when the record still cannot be kept — the loss is otherwise invisible
  │                          at the moment it happens.
  │                          **WHOSE CONVERSATION CAN BE READ** is `harness-transcript.ts`, a
  │                          `Record<HarnessId, HarnessTranscript | null>` behind the workspace's
  │                          chat view and the fleet poll's six-row tail. There are TWO limits and
  │                          they were one thing for as long as Claude was the only readable
  │                          harness: the LINK (is this row's `conversationId` exact?) and the
  │                          FORMAT (has anybody written a reader?). Collapsing them cost the
  │                          feature its honesty — measured 2026-09-05 on a live antigravity session
  │                          whose `/proc/<pid>/cmdline` was `agy --conversation 01d0814f-…` for the
  │                          very id the registry held, `GET /api/fleet/chat` ran into the
  │                          CLAUDE-only path resolver, found nothing, took the live branch and
  │                          answered `{turns: [], live: true}`: a blank pane with no sentence on
  │                          it, because `SessionChat.tsx` draws "no messages yet" only when
  │                          `live === null`. A `null` reader is now REFUSED IN WORDS and NAMES the
  │                          harness. The link rule is untouched: only `ManagedSession.conversationId`
  │                          reaches a reader, never the harness-and-directory guess, or some other
  │                          conversation from the same folder appears under this session's name.
  │                          `antigravity-chat.ts` is the first non-Claude reader and is PURE. agy
  │                          writes the REQUEST and the EXECUTION as two steps — a `PLANNER_RESPONSE`
  │                          carrying prose, `thinking` and `tool_calls`, then a `RUN_COMMAND` /
  │                          `VIEW_FILE` / … step whose `content` is the result (1094 against 909 on
  │                          the measured file; the executions carry no `tool_calls` at all). The
  │                          chat keeps the REQUESTS and drops the executions, which is the INVERSE
  │                          of `harness-activity.ts`'s choice for the same transcript and for the
  │                          same reason — counting both is counting twice; a count wants the thing
  │                          that happened, a bubble wants the one with the command in it. Tool names
  │                          go through `canonicalTool`, so `sessionArtifacts.ts` — which selects by
  │                          Claude's names — works on an agy session without knowing agy exists.
  │                          `CONVERSATION_HISTORY` is a replay and is skipped; `SYSTEM_MESSAGE`,
  │                          `CHECKPOINT` and `ERROR_MESSAGE` become unattributed notes that NAME the
  │                          kind and never carry the body (agy's checkpoint is the whole truncated
  │                          conversation, and its error paragraph runs 206–633 characters across all
  │                          77 measured) — the same rule `chat-envelope.ts` applies to Claude's
  │                          injected entries. `transcript-window.ts` is the shared byte-tail reader
  │                          every harness polls through: a poll that reads whole transcripts is what
  │                          made `/api/fleet` answer in 36 s cold.
  │                          **FIVE READERS, and the sixth null is a FINDING.** `codex-chat.ts`,
  │                          `copilot-chat.ts` and `kimi-chat.ts` joined `antigravity-chat.ts`, all
  │                          pure, each written against a fresh measurement of that harness's own
  │                          files. Three rules recur and every one of them was a real defect first:
  │                          **(1) THE SAME TURN IS WRITTEN TWICE**, in a different pair of places
  │                          each time — codex writes `event_msg/{user,agent}_message` beside
  │                          `response_item/message`, kimi writes `turn.prompt` beside
  │                          `context.append_message`, agy writes the tool REQUEST beside its
  │                          EXECUTION, and kimi's metrics parser records the same trap for its usage
  │                          records. In each case ONE family is chosen and the other is ignored
  │                          outright, and the chosen one is the SUPERSET, measured: codex's
  │                          `event_msg` covers 21 of 42 user messages, kimi's `turn.prompt` 15 of 22.
  │                          **(2) WHAT NOBODY SAID IS NEVER DRAWN AS A MESSAGE**, and each harness
  │                          declares it differently — kimi stamps `message.origin.kind`
  │                          (`user` against `injection`, its own `isMeta`), copilot separates
  │                          `data.content` from `data.transformedContent` (the second is the same
  │                          text wrapped in `<current_datetime>`/`<system_reminder>` and is NEVER
  │                          read), codex has a `developer` ROLE plus `<…>` envelopes, and codex ALSO
  │                          has entries with no marker at all: measured over its 40 largest
  │                          rollouts, 11 of 32 untagged user messages were the harness loading a
  │                          file (`# AGENTS.md instructions for …`), so `INJECTED` is
  │                          `chat-envelope.ts`'s `META_KINDS` applied there. Everywhere, an
  │                          unrecognised entry stays the PERSON's — hiding a real message is the
  │                          expensive direction. **(3) A SHELL DETAIL GOES THROUGH
  │                          `commandSummary`**, never a first-line truncation: on a real codex
  │                          rollout five consecutive chips read `cd /home/…/embark`, saying where
  │                          the work happened and never what it was.
  │                          **GEMINI HAS NO READER AND MAY NOT GET ONE**, and that is a LINK fact,
  │                          not a format one. A reader is only ever offered a `conversationId`, and
  │                          only a harness with `assignId` or an id-taking `resume` can ever have
  │                          one — claude and copilot have `assignId`; codex, kimi and agy have
  │                          `resume`; **gemini has neither** (`-r, --resume` takes "latest" or an
  │                          index, and `--session-id` is excluded because gemini's id here is
  │                          synthetic). So an entry for it would be unreachable code plus a claim
  │                          the product cannot honour; `conversationBlind` already says so on the
  │                          row and `SessionsPage` hides the chat tab. Its format WAS measured and
  │                          the finding is recorded in `harness-transcript.ts` so nobody spends it
  │                          twice: a patch log, not one message per line. See docs/session-manager.md
  ├── cli-start.ts         → the control center's HOST (`ControlHost`): service detection, start/stop/restart, connect/disconnect, boot service, archive consent, language — every action returns an already-localized `ActionResult` instead of printing
  ├── cli-stream.ts        → the control center's OUTPUT CHANNEL: subscribers + `streamCommand` (both pipes captured, never `inherit`) → lines via the pure `@agentistics/tui/control/stream`
  ├── cli-ui.ts            → dependency-free arrow-key select/confirm/input/pause + clearScreen (bundles clean into the binary; no node_modules to resolve)
  ├── central-runtime.ts   → **pure**: the three shapes a central can take here, each with `available` + a REASON CODE
  │                          (`no-docker` / `no-checkout` / `no-env` / `bundled-mongo`) rendered by cli-i18n and the
  │                          cockpit's own strings — the module is language-free, like `LiveUnavailableReason`. It is the
  │                          ONE resolution behind BOTH front doors: `agentop central up --image|--build|--native` and the
  │                          control center's start verbs, which is what stops the CLI and the cockpit offering different
  │                          deployments. `no-env` and `bundled-mongo` are deliberately different codes — "not configured
  │                          yet" and "configured for a database Docker alone can reach" send the user to different screens
  ├── service-manager.ts   → **pure**: which init system can keep a mode running here (systemd user units on Linux, launchd
  │                          user agents on macOS, pm2 anywhere it is installed) and the exact file/argv each needs. **pm2
  │                          never wins by default** even when installed — it is a list the user curates, and agentop filing
  │                          itself into it is their decision. The field the module exists for is `keepsRunning`: `agentop
  │                          server` holds the foreground (`Type=simple`), while `docker compose up -d` and `central.sh up`
  │                          RETURN once the container is up — registered as long-running, systemd marks the unit
  │                          inactive(dead) a second after a perfectly successful start and every `is-active` then lies, so
  │                          those become `Type=oneshot` + `RemainAfterExit=yes`. Same distinction drives launchd's
  │                          `KeepAlive` and pm2's `--no-autorestart`. It is a property of the COMMAND, so a NATIVE central
  │                          gets a different unit type from a Docker one — which is why `serviceCommandFor` takes the
  │                          central runtime, and why `agentop autostart central` finally works from an installed binary
  │                          (it writes `agentop central up --image -n` instead of refusing for want of a central.sh).
  │                          Each manager NAMES the one step it cannot take for the user (`bootCaveat`): linger on systemd,
  │                          login-not-boot on launchd, `pm2 save` + `pm2 startup` on pm2 — a service that will not survive
  │                          a reboot while the user believes it will is worse than none
  ├── rebuild-flags.ts     → **pure**: the rebuild's two answers (`-y`/`-n` for central.sh's setup prompt, `--cache`/`--no-cache` for the image build) — parse, conflict-refuse, and the argv each path receives
  ├── cli-i18n.ts          → EN/PT strings the HOST produces (CLI is English by default; language follows --lang / preferences.lang / the in-app toggle). The control center's own chrome strings live in tui/src/control/i18n.ts
  ├── cli-hooks.ts + claude-hooks.ts / claude-skill.ts / session-context.ts → **the Claude Code
  │                          integration** (`agentop hooks install|uninstall|status|context`). Two
  │                          pieces because they answer two different questions, and a **HOOK INFERS
  │                          NOTHING** — it is a deterministic shell callback on an event; the
  │                          inference is the MODEL's, reading what was injected. So the KNOWLEDGE
  │                          half (when to fan work out, how to write each session's prompt, the
  │                          `session batch` contract) is a **SKILL** — loaded by description when
  │                          the task matches, free otherwise — and never a SessionStart injection,
  │                          which would tax every session for the few that parallelise. The FACTS
  │                          half (which sessions run NOW, which is blocked on approval, which task
  │                          reopens HERE) cannot live in a static file and IS the hook — which
  │                          prints NOTHING when the fleet is empty, so a quiet machine pays no
  │                          tokens either. `claude-hooks.ts` is **pure**: the settings merge that
  │                          preserves every key it did not write, REFUSES a document it cannot
  │                          merge into rather than fixing it, is idempotent, and whose removal is
  │                          the exact inverse (containers that existed only to hold our entry are
  │                          pruned; a group carrying someone else's hook is kept). Our entry is
  │                          identified by the COMMAND it runs — a hook entry has no field for
  │                          provenance and inventing an unknown key in someone else's schema is how
  │                          a settings file stops validating — with the version carried in that same
  │                          command, so `status` can read a file it never wrote. `claude-skill.ts`
  │                          is **pure**: the document plus an ownership MARKER (delete the line and
  │                          the file is the user's, permanently). `session-context.ts` is **pure**:
  │                          what the hook prints, including when it prints nothing. **Installing is
  │                          an explicit act** — `agentop setup` only SUGGESTS the command, exactly
  │                          as `autostart.ts` does for `~/.bashrc` — and paths come from HOME_DIR,
  │                          never CLAUDE_DIR (which can be a container's read-only mount of someone
  │                          else's `~/.claude`; same distinction `mcp-list.ts` makes). The session
  │                          verbs are deliberately NOT MCP tools: `agentop session batch` already
  │                          exists as a CLI and Bash's permission prompt is the consent gate for
  │                          starting N billable assistants. There are TWO hook events, held in one
  │                          `HOOK_SPECS` table so there is exactly ONE settings merge: `SessionStart
  │                          → hooks context` (the facts, 10s) and `Stop → events emit` (the exact
  │                          end-of-turn signal for the event channel, 5s — it runs on EVERY turn, so
  │                          a budget that is felt is a budget that is wrong). The command matcher is
  │                          NARROWED by event, or removing one hook would delete a `Stop` entry
  │                          somebody had moved under `SessionStart`. See docs/claude-integration.md
  ├── events/              → **the EVENT CHANNEL** behind `agentop events`: a state TRANSITION
  │                          reaching a person and the assistant orchestrating the fleet.
  │                          **The producer MUST be long-lived, and that decides its home.**
  │                          `createSessionsPoller` holds each session's last frame digest in
  │                          memory, and MOVEMENT is the only universal `working` signal there is
  │                          (codex draws an identical screen streaming and idle); tmux's own
  │                          `session_activity` is no substitute — measured: a session working for
  │                          53 minutes reported its last activity 3185s earlier, because nothing
  │                          was attached. So a single-invocation poll reports WORKING sessions as
  │                          FINISHED, and a cron-shaped design would announce five sessions
  │                          finishing at the moment they all started. The producer therefore rides
  │                          along with the daemon `agentop server` already runs (`daemon.ts` inside
  │                          otel-watcher), never as a service the user must remember to start;
  │                          `events run` is the foreground fallback and `events status` reports the
  │                          producer as running / stale / ABSENT, because "nothing arrived" must be
  │                          distinguishable from "nothing was watching". `event-plan.ts` is
  │                          **pure** and holds the rule the whole feature is judged on: **a state
  │                          counts only once it has been observed on TWO CONSECUTIVE POLLS.** A
  │                          repaint (a tmux advisory line, a plugin notice) moves the frame for one
  │                          poll, is correctly read as `working`, and reported the same session as
  │                          `waiting` twice ten seconds apart. A TIME WINDOW does not fix it — that
  │                          was the first attempt, the next flicker landed outside it, and any
  │                          window wide enough also swallows a genuine follow-up turn. The cost is
  │                          stated: a turn inside one poll interval is invisible to this source,
  │                          which is exactly what the `Stop` hook covers. TWO SOURCES, not
  │                          equivalent: the poll is the FLOOR (all six harnesses, reads the screen,
  │                          the only thing that can see a permission prompt at all — Claude Code
  │                          fires no `Stop` for one) and the hook is EXACT (Claude only).
  │                          `event-dedupe.ts` drops the poll's copy of a turn a hook already
  │                          reported, one-directionally, and NEVER dedupes `waiting-approval`.
  │                          **The INBOX (`~/.agentistics/events.jsonl`, 0600) is the heart, not a
  │                          cache**: a Claude session only exists while invoked, so an event
  │                          delivered to a parked one happened to nobody — the socket and the toast
  │                          make the read happen SOONER, never instead. A cursor is `offset:seq`
  │                          because a byte offset is exactly what rotation invalidates, and a
  │                          pre-rotation cursor reads from the start and SAYS `rotated` rather than
  │                          returning nothing. `peer-target.ts` is **pure**: the registry says who
  │                          EXISTS, the SOCKET says who is UP (measured: 79 records, 5 live
  │                          sockets), a name matches WHOLE never by prefix, and the message carries
  │                          the target's own `session_id` so a recycled pid cannot misdeliver a
  │                          fleet event into an unrelated conversation. `notify-plan.ts` is
  │                          **pure**: the desktop cascade ccn → notify-send → powershell → bell →
  │                          none, each step named in a SENTENCE by `status`, because a notification
  │                          that fails silently is worse than none. **ccn
  │                          (`claude-code-notifications`) is DETECTED, never embedded** — it ships
  │                          through the Claude Code plugin system with its own release cycle while
  │                          agentop is one binary, so a copy would be a second version to drift;
  │                          agentop shapes its event into the `Notification` hook envelope ccn
  │                          already accepts and contributes the five harnesses ccn cannot see plus
  │                          the task grouping neither has alone. Subscriptions are a FILE
  │                          (`event-subscriptions.json`), not a process: a foreground watcher is
  │                          one the user forgets to start and is dead when it matters.
  │                          **THE FRONTIER**: an event carries facts and no instruction, a
  │                          subscription can ask for DELIVERY and never for an ACTION, and
  │                          `waiting-approval` is reported as waiting on A PERSON — nothing here
  │                          may approve anything for anyone. `events-frontier.test.ts` asserts it
  │                          over the module SOURCE, so a field named `action` or an imperative
  │                          sentence fails the build. See docs/session-events.md
  ├── team-tokens.ts       → mint / rotate / revoke / validate tokens (stored as sha256 hashes only)
  ├── rotate-identity.ts   → **pure**: what a TOKEN ROTATION carries. `memberId = sha256(token)`, so rotating renames the machine in every collection keyed by that id — this module holds the ENUMERATION (`tokens`, `sessions`, `memberStats`, `workflows`, `machineKeys` and a tag's `machine` sources all migrate; `audit.targetId` is left as written, because an audit records what was true then; CI sessions are keyed by `ciMemberId(remote)` = `repo:<remote>` and move nothing; the member side's per-connection state is named by the LOCAL connection id and is reconciled by the sync fingerprint). **Any new collection keyed by a machine id must be added here or a rotation silently strands it — that is the same bug three times already.** `planEnvelopeRotation` is the mailbox decision and has NO re-address option: the routing is the GCM AAD, so mail addressed to the old id yields `recipient_mismatch` for anyone (dropped, and counted in the audit as a LOSS) while mail SENT by it still opens exactly as sealed (kept — re-stamping the sender would destroy it). `retargetMachineSources` matches on the source TYPE as well as the value, so an `account` id that happens to read the same is never dragged along. **Sibling pins are deliberately not carried**: to a sibling the rotated machine is new, is pinned on first sight and is ANNOUNCED — continuity would need a claim the central can forge (a "formerly" field, or "same public key", which a central can copy onto an invented machine), and the announcement is the one control against a fabricated peer
  ├── mongo-dates.ts       → **the date boundary**: BSON `Date` in Mongo, ISO string on the wire. Pure toBsonDate/fromBsonDate(+OrNull)/toBsonDates/fromBsonDates + `DATE_FIELDS` (every stored timestamp, by collection) + `migrateStringDatesToBson()` (idempotent, runs at boot; also `scripts/migrate-mongo-dates.ts`)
  ├── team-store.ts / team-stats.ts → Mongo team-session doc shape + per-member statsCache store
  ├── team-ingest.ts       → POST /api/team/ingest → upsert + triggerSseNotification (real-time central)
  ├── team-source.ts / team-admin.ts → central-side team read for buildApiResponse + members-panel admin routes
  ├── team-uploader.ts     → member→central push: sent-state, sync-signature auto-reconcile, push-on-change (notifyDataChanged), auto-reset on revoke, /api/team/status pill
  ├── ingest-batch.ts      → **pure**: how many sessions one ingest carries and how long it gets.
  │                          **A BATCH IS THE UNIT OF DURABLE PROGRESS** — the sent-state advances
  │                          only on an ACCEPTED batch, so a batch that cannot complete records
  │                          NOTHING and the next cycle re-sends the same sessions forever. That
  │                          happened: `BATCH_SIZE` 200 was chosen in one place and a flat 15s
  │                          timeout in another, nothing checked that one fit the other, and a real
  │                          central costs ~195 ms/session — so 200 needed ~39s and every first push
  │                          aborted. Measured on a live member: 1.260 consecutive failures, a
  │                          sent-state still `{}`, `lastSuccessAt: null`, against a central
  │                          answering everything else in under a second. So the TIMEOUT IS DERIVED
  │                          from the batch (`ingestTimeoutMs`, the only place either number is
  │                          decided) and still BOUNDED (`MAX_TIMEOUT_MS`), because the timeout's
  │                          original job is releasing a `MAX_CONCURRENT_PUSHES` slot held by a
  │                          wedged proxy. And the batch ADAPTS (`nextBatchSize`): a derived timeout
  │                          still rests on an estimate of someone else's hardware, so a failure
  │                          HALVES and a success grows back GRADUALLY — jumping straight to the
  │                          ceiling would fail, floor, and fail again, which is the same
  │                          non-convergence in a slower loop. The ceiling is far below 200 on
  │                          purpose: smaller batches cost round trips and buy durable progress
  ├── account-repos.ts     → **pure**: buildAccountRepoList (central grouping) + findStillShared (the MACHINE-side intersection). A machine asks the central what repositories it holds FOR ITS ACCOUNT (`GET /api/team/account-repos`, team-account-repos.ts) — a question naming no repository and carrying no rule — and compares locally, so it learns a sibling still shares a repo it hid without disclosing anything
  ├── team-elsewhere.ts    → member side of that: TTL-throttled fetch + cache → ConnectionStatusEntry.elsewhere (same-origin) → the orange banner on the connection card
  ├── (core) siblingRules.ts → **pure** `@agentistics/core`: the REVERSE warning's arithmetic — `bucketSharedBy` (is this repo/project bucket shared by these announced rules?) + `siblingsRestricting` + `mergeSiblingFacts`. It may **never** be derived from the central: a sibling that hides a repo simply leaves the central without it, and absence is ambiguous between "restricted" and "never cloned", so the ONLY sound source is the sealed envelope inbox. `bucketSharedBy` is a second implementation of a privacy rule, so `share-rules.test.ts` cross-checks it against `sessionShared` over every mode x dimension x bucket combination — `share-rules.ts` stays the single source of the semantics. **Projects correlate across machines by FOLDER NAME** (`projectNameKey`: `\`→`/`, trailing separators stripped, final segment, case folded — case because WSL/Windows machines share these accounts), because the same project sits at a different path on every machine and full-`project_path` comparison correlates almost nothing. **That is the CROSS-MACHINE key only**: `bucketSharedBy` and the stored rules stay EXACT, or a local rule denying `/home/a/x/proj` would silently widen to every project named `proj` — `shareBucketKeys` (exact) and `crossMachineKeys` (correlation) must stay separate, and a test fails if the exact predicate is widened. It is a heuristic (`api`, `web`, `docs` collide), so `siblingsWithholding` reports the sibling's OWN path when the announcement carries one, and the UI says "a project with this name"
  ├── (core) proposalApply.ts → **pure** `@agentistics/core`: `planProposalApply` — applying a sibling's proposal may only ever NARROW what this machine shares. It composes the two rule sets as their INTERSECTION per mode pair (denylist+denylist → union of denials; anything with an allowlist → an allowlist), never replacing the recipient's rules with the sender's snapshot: that lifted every restriction the sender did not happen to hold, which is the button that hides things starting to share hidden ones. The denylist+allowlist pair has NO single-rule-set intersection ("share only P, except D"), so the merge keeps only the sources that provably cannot overlap a local denial — denial wins across dimensions, and a bare repo allow would re-open a session sitting in a denied project. `share-rules.test.ts` cross-checks the whole table against `sessionShared`, THROUGH the ambiguous-directory (`conflicts`) clause the plan deliberately does not model — it only ever removes sharing. **A source names a bucket on ONE dimension while `sessionShared` decides on BOTH**, so the plan's `stopsSharing` is held to the joint reading (nothing of the row ships afterwards, something did before) and rows the rules alone cannot settle are demoted to `partlyRestricts`, which the UI may only render as "no longer listed" — deciding it by membership once named a project that kept shipping through its repository, a false sentence in the REASSURING direction at the moment of the decision. `proposalAddsNothing` is the same arithmetic read as a question: **an announcement that would add nothing to the recipient's rules is not a proposal** and raises no card and no `member.rules_proposed` — otherwise applying one announces back and the two machines offer each other the same rules forever. It suppresses the OFFER only; the FACT still lands in `siblingRules`
  ├── envelope-crypto.ts   → **pure** sealed envelope: X25519 (ephemeral + static-static DH) → HKDF-SHA256 → AES-256-GCM, whole header as AAD. **Binding is only half the job — `open` REQUIRES the caller to state the sender the transport claimed, this machine's id and the connection's instanceId, and refuses any disagreement with the sealed header BEFORE any key agreement**; it also bounds `createdAt` and refuses a sender key that differs from the PINNED one. Those checks, not the cipher, are what make an invented identity or a substituted key visible. The pin is looked up by the id INSIDE the seal, never the one beside it
  ├── envelope-message.ts  → **pure**: the one message kind (a restriction proposal) + decidePin (trust on first use)
  ├── envelope-keys.ts     → this machine's keypair (0600, never logged/audited/returned) + per-connection peer pins
  ├── envelope-store.ts / envelope-routes.ts → central `machineKeys` + `envelopes` collections and /api/team/keys + /api/team/envelopes. Sender stamped from the token; recipient must be a machine of the caller's own ACCOUNT (`allowedRecipients`)
  ├── envelope-client.ts   → member: publish key, pin peers, seal on a rules change, collect + decrypt. Never applies anything. **A sender absent from the key directory is refused even when unpinned** (omitting a machine is the cheaper twin of fabricating one — no pin means no pin-comparison and no notification), and **every first-time pin is announced** (`member.peer_pinned`) — a central need not substitute a key, it can INVENT a machine under one it holds, so trust may be automatic but never silent. One unusable directory key is skipped and counted, never thrown (an unguarded `seal` in the peer loop was a free, silent off-switch for the whole channel)
  ├── envelope-inbox.ts / envelope-proposals.ts → decrypted, NOT-YET-APPLIED proposals + GET/DELETE /api/team/proposals (capability-guarded: it returns a sibling's full source list). **There is deliberately no apply path**: applying is the ordinary PATCH /api/team/connections/:id a user's click performs. `openedDigests` (sha256 of ciphertext+tag, NOT the central-minted id) is the replay memory and **survives dismissal** — otherwise a permissive pre-restriction envelope could be replayed as a one-click downgrade. The inbox also holds `siblingRules` — the **FACT** each envelope carries (what that machine announced about its OWN rules), stored apart from the **PROPOSAL** because they have different lifetimes: dismissing "apply this here" must not erase "the sibling withholds this". Superseded per `machineId` (each message is a full snapshot, which is how a sibling that LIFTS a restriction retracts the fact); a machine that goes QUIET never retracts, and rules applied before the channel existed were never announced. **PROPOSALS are superseded per `machineId` too** (`mergeProposals`) — a newer announcement replaces its own sender's pending one rather than joining it, so a machine can never hold two cards — and a proposal with **nothing left to apply** is dropped on the READ path (`selectLiveProposals`, the same `proposalAddsNothing` arithmetic re-run against the connection's CURRENT rules). Filtered, never deleted: "nothing left to apply" is a statement about the RECIPIENT's rules, which the user can lift at any time, while a sibling only re-announces when its own rules change — the supersede case is the opposite, permanently stale, and IS pruned from the store
  ├── workflow-metrics.ts / workflow-script.ts / workflow-agent.ts / workflow-match.ts → Dynamic Workflow runs. **A run's transcripts are `agent-<hash>.jsonl` and the hash carries NO order** — pairing them with the script's `agent()` calls by POSITION (after an alphabetical file sort) gave every agent a label belonging to some other agent, and the run still rendered as if it matched: the CLI said `recon:services · 71.2k` while the dashboard put that agent's numbers under `fix:backends`. The only thing a transcript and its call provably share is the PROMPT, so `parseWorkflowScript` extracts each call's literal (non-`${…}`) prompt segments as FINGERPRINTS and the pure `workflow-match.ts` pairs them by longest verbatim match. It is deliberately conservative — **no match, or a tie, yields the file name and no phase**, because a wrong label is worse than a missing one — and it is per transcript, never a bijection (a `pipeline()`/loop re-runs one call site many times, and all those transcripts legitimately carry that one label). **Tokens include cache**: `WorkflowRun.totals` carries `cacheRead`/`cacheWrite` (optional, so a doc from an older central still reads) and every surface sums them through `workflowTokens()` in `@agentistics/core` — a subagent's cache read dwarfs its input, so an in+out headline understated a real run by ~250x while the cost beside it (which always priced the cache) disagreed
  ├── project-facts.ts / data.ts `resolveProjectFacts` → **a repository is a property of a DIRECTORY, not of whichever assistant visited it.** `getGitRemote` / `getProjectGitStats` used to be called only from inside the `~/.claude/projects` walk, so a repo used exclusively through Codex/Gemini/Copilot stayed invisible until a Claude session appeared in it (measured: claude 163 sessions / 95 with a remote, **codex 10 / 0**, copilot 8 / 1, gemini 15 / 1). The pure `planProjectFacts` keys on `project_path` from ANY harness and skips paths the Claude walk already read (a resolved path with no remote is not a repo — asking git again every build spends a process to learn the same nothing), and `applyProjectFacts` stamps the result. **It never overwrites a `git_remote` that is already set** — CI ingest stamps it authoritatively from a repo-bound token — and **an empty result clears nothing**: "not a repo here" is not evidence that a remote recorded elsewhere is wrong. It runs BEFORE `writeConsolidated`, so the remote reaches the store, the uploader and the central
  ├── harness-activity.ts  → **pure, and the reason no adapter could count anything**: `countGitCommands` (a command line is a CHAIN — split it, judge each segment; `(?![\w-])` rather than `\b`, or `git commit-tree` counts as a commit) and `canonicalTool` (each harness's own name → the shared vocabulary, which is Claude's, because that is what every chart and filter is written against). Both lived INSIDE `jsonl.ts`, the Claude parser, which is exactly why every other adapter hardcoded `git_commits: 0` — the rule was not reachable, not the data missing. **`canonicalTool` is a MAPPING, never a filter**: an unmapped name passes through unchanged so a new tool shows up as itself. **Agy counts the EXECUTION, never the request** — a shell command appears twice there (a `run_command` tool_call asking, then a `RUN_COMMAND` step running, which is the one carrying the command text), and counting both doubled every shell call: same trap as Kimi's duplicated usage records, same answer
  ├── chat-gate.ts         → **pure**: `chatAllowed(capable, preference)`. Chat spawns an assistant CLI on the host — the most powerful thing this server does — and it used to be ON anywhere the exposure profile allowed it, so a machine installed for its metrics also shipped a shell nobody chose. Now **absent reads as OFF** (deliberately NOT the `shareMode` migration rule: treating absence as ON there would invert live sharing rules, treating it as ON here would leave the shell open on every machine not yet touched), and the preference may only ever NARROW `CAPS.localChat` — a switch that could re-enable what `public` denied is the opt-in `exposure.ts` exists to make impossible. **Enforced in `index.ts` before the chat routes, not only in the UI** — a hidden button is not a closed door. `/api/team/session` carries `chatEnabled` (capability AND switch) separately from `capabilities.localChat` (the profile alone), so Settings → Chat can say "your profile allows this, you have it off"
  ├── team-watch.ts        → central watches the team collection → SSE refresh (fallback)
  ├── team-repos.ts        → central repo registry (`repos` collection): registerRepo (mints a repo-bound CI token + records name/remote; re-register rotates), listRepos, unregisterRepo
  ├── ci-push.ts           → `agentop ci-push`: one-shot push of an ephemeral GitHub Actions runner's ~/.claude metrics to a central; prefers keyless OIDC (fetches the runner's id-token), falls back to a static token; never fails the CI job on a push error
  ├── team-oidc.ts         → verifies GitHub Actions OIDC JWTs (jose createRemoteJWKSet + jwtVerify; issuer/audience/expiry) for keyless CI ingest; pure helpers pickCiClaims/looksLikeJwt/ciMemberId
  ├── team-agent.ts / team-agent-client.ts → reverse-channel WebSocket: WS-authoritative presence signals, ping/pong latency, on-demand chat fetch
  ├── team-presence.ts     → computePresence (WS-authoritative online/offline + latency; heartbeat only for pure-HTTP members)
  ├── tags-store.ts        → Mongo CRUD for the `tags` collection (TagDoc: name/color/sources/sharedWith/createdBy) + visibleTagsFor(canRead)
  ├── tags-resolve.ts      → **pure**: sessionMatchesTag / resolveTagSessions / sessionInWindow — a tag's sources (`repo` | `project` | `machine` | `team` | `account`) resolve to a deduped session SET (union/OR, counted once)
  ├── tags-aggregate.ts    → **pure**: aggregateSessions() → headline numbers (costUSD via calcCost, sessions, tokens, top project/model/harness)
  ├── tags-detail.ts       → **pure**: aggregateTagDetail() → distributions (projects/models/harnesses/repos/members), daily series, activity window, distinct member/machine counts — counts and sums only
  ├── tags-authority.ts    → **pure** gates: canSeeSource / canWriteTagSources (Rule 1) / canReadTag + redactBuckets / redactTopValue / **redactSources** (any key OR source value the viewer cannot see is collapsed into `__other__` / `__hidden__` — without redacting the source list the bucket redaction is bypassable by reading `tag.sources`)
  ├── tags-handlers.ts     → GET/POST/PATCH/DELETE /api/tags and GET /api/tags/:id; the only tags module touching Mongo or auth (`tags:write` required on every write; unknown tag → 404, never 403)
  ├── central-config.ts    → Mongo central config: instanceId + pushIntervalSec + includeOfflineData
  ├── adapters/types.ts    → HarnessAdapter contract + getEnabledAdapters() (async, memoized) registry + harnessEnabled(id)
  ├── adapters/claude.ts   → wraps the existing Claude pipeline behind the HarnessAdapter contract (zero behavior change)
  ├── adapters/codex.ts    → Codex CLI reader (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
  ├── adapters/codex-parse.ts → pure parser for the Codex envelope format → SessionMeta (harness: 'codex')
  ├── adapters/gemini.ts   → Gemini CLI reader (~/.gemini/tmp/<project>/chats/*.jsonl + projects.json)
  ├── adapters/gemini-parse.ts → pure parser; only counts chats with genuine content (a real user message or model response), dropping bootstrap-only stub files; session_id is unique per chat file
  ├── adapters/copilot.ts  → Copilot CLI reader (~/.copilot/session-state/<id>/events.jsonl + workspace.yaml)
  ├── adapters/copilot-parse.ts → pure parser (session.start context, user.message, assistant turns, MCP, activity hours)
  ├── adapters/kimi.ts     → Kimi Code CLI reader (~/.kimi-code/sessions/<ws>/session_<id>/ + session_index.jsonl)
  ├── adapters/kimi-parse.ts → pure parser; counts tokens from `usage.record` ONLY (the nested `step.end` events repeat the same usage byte-for-byte), strips the provider prefix from the model alias, folds every agent of a session into it
  ├── adapters/antigravity.ts → Antigravity CLI (agy) reader (brain/<conv>/.system_generated/logs/transcript_full.jsonl + the global history.jsonl + READ-ONLY bun:sqlite reads of conversations/<conv>.db `gen_metadata` and the optional conversation_summaries.db)
  ├── adapters/antigravity-parse.ts → pure parser; skips replayed CONVERSATION_HISTORY steps and dedupes by step_index (no double counting), never treats a slash command as the first prompt, counts ERROR_MESSAGE steps, derives files/lines from the edit payloads, and drops a conversation only when it is a proven invoke_subagent child
  └── adapters/antigravity-protobuf.ts → **pure**, dependency-free protobuf wire reader for the gen_metadata blobs (tokens + model id); never throws — malformed input yields null

packages/web/src/ (React + Vite, port 47292 in dev)
  ├── lib/
  │   ├── app-context.ts        → AppContext interface (React context type shared by all pages)
  │   ├── componentCatalog.tsx  → catalog of all components available in the custom layout builder
  │   ├── chatModels.ts         → web-only model list
  │   ├── chatSounds.ts         → 5 synthesized notification sounds via Web Audio API (Ping, Chime, Soft, Bell, Pop)
  │   ├── notifications.ts      → notification store (useSyncExternalStore) + render-time pt/en i18n (NOTIFICATION_TEXT keyed by code, interpolates meta)
  │   └── harness.ts            → HARNESS_LABELS, HARNESS_COLORS, capable(harness, metric), HARNESS_INFO (data-source/contains/missing/note metadata for HarnessInfoPanel)
  ├── hooks/
  │   ├── useData.ts            → fetches /api/data + SSE subscription + useDerivedStats() + computeHarnessSummaries()
  │   └── useCustomLayout.ts    → custom layout state: named layouts, pinned projects, persistence
  ├── pages/
  │   ├── HomePage.tsx          → main dashboard (KPIs, charts, sessions)
  │   ├── CustomPage.tsx        → custom layout builder (/custom route)
  │   ├── CostsPage.tsx         → cost deep-dive page
  │   ├── ProjectsPage.tsx      → projects overview page
  │   ├── RepositoriesPage.tsx  → repositories overview (/repositories): cards grouped by normalized git remote (RepositoriesList) so the same repo unifies across devs/paths/machines. **Only repos WITH a remote are shown by default** — remote-less sessions can't be attributed to a repo (and would split the same repo's metrics across machines), so they're hidden behind an "Unlinked · N" toggle. Links to /repo/:id
  │   ├── RepoDetailPage.tsx    → per-repo detail (/repo/:id): scopes a repo via an overridden `repos` filter (no global filter mutation) + tabs Overview/Members/Actions/Sessions/Dynamic Workflows. The "Actions" tab shows only when the repo has CI sessions; the "Dynamic Workflows" tab shows only when the repo has workflow runs from a `dynamicWorkflows`-capable harness, and renders each run as a step-by-step timeline (phases → agents) with a harness badge, and offers an "All / By session" view toggle that groups runs per session (see `lib/workflowSteps.ts` `buildWorkflowSteps` + `groupRunsBySession`)
  │   ├── ActionsPage.tsx       → /repositories/actions: all CI-runner sessions (SessionMeta.ci) grouped by repo — the GitHub Actions submenu of Repositories
  │   ├── TagsPage.tsx        → tags overview (/tags): a card per visible tag (GET /api/tags, aggregate-only) in a **grid or list** layout (persisted; grid ~6 metrics, list ~10), plus a create/edit drawer for principals with `tags:write` (source picker adds on pick, with a bulk checkbox mode beside it; searchable share-with). Clicking a tag navigates to /tags/:id
  │   ├── TagDetailPage.tsx   → per-tag detail (/tags/:id) fed by GET /api/tags/:id: KPI row (cost, sessions, tokens, **distinct members + machines**), activity chart, ranked distributions (projects/repos/models/harnesses/machines), per-source breakdown, and a **Who has access** panel split by category — owners / creator / shared-with, each stating its own permission. Pencil + trash (ConfirmModal) when the viewer may edit
  │   ├── ToolsPage.tsx         → tools breakdown page
  │   ├── HarnessPage.tsx       → generic per-harness dashboard at /h/:harness (validates param; sets harness filter; tab bar: "Overview" = dashboard, "Data & sources" = HarnessInfoPanel); replaced the old hardcoded CodexPage
  │   └── ComparePage.tsx       → unified side-by-side comparison at /compare (per-harness colors; N/A for incapable metrics; sessions/messages/tokens/cost + comparatives: usage-by-hour with peak hour, busiest day-of-week, activity-over-time sparkline, peak token day / peak session cost)
  └── components/               → UI (charts, cards, heatmap, modals, PDF export)
      ├── HarnessInfoPanel.tsx  → inline panel explaining each harness's data sources / what's captured / what's missing (and why) / caveats; driven by HARNESS_INFO in lib/harness.ts
      ├── PreferencesModal.tsx  → unified Settings modal with tabs: Preferences / Live / Install (Environment tab removed)
      ├── TeamLogin.tsx / TeamMembers.tsx / TeamSettings.tsx → central: password login, members panel (mint/rotate/revoke/rename + presence), team settings (interval/express, offline-data policy)
  ├── TeamRepos.tsx         → central admin panel rendered in its own **"GitHub Repositories"** Settings tab (central-only, separate from the Team tab): register/unregister repos (POST/DELETE /api/team/repos) + generates a ready-to-paste GitHub Actions workflow snippet + `gh` setup commands with the minted CI token
      ├── team/restrictionTable.ts + NoticesModal.tsx → the notices modal is a TABLE of what is NOT shared with this central: rows are the restricted repositories/projects, cells name the machines that withhold each one (this machine included) and the ones that still share it. Built from the standing FACTS (`siblingRules`) plus this machine's live rules, so a dismissed proposal never erases a row; `bucketSharedBy` / `siblingsWithholding` / `planProposalApply` do all the arithmetic. Apply is per ROW (that same narrowing-only merge asked of a one-source denial) as well as per machine; a PROJECT row is actionable only when exactly one local project carries that folder name — a rule must name the exact path it denies. Allowlist machines withhold everything no row can name, so they are stated in words. **The connection card's own hidden block is the SAME builder** (`SharedReposPanel`'s `ReadView`), asked its narrower `scope: 'selfRestricted'` question — what THIS machine hides from THIS central — so the two surfaces can never disagree about what is hidden; it replaced red outlined chips that flattened repos and projects into one blob and never said where else a restriction was applied. It renders through `RestrictionMiniTable.tsx` as a REAL table of three columns — **what** (name + the dimension in words), **hidden on**, **still shared on** — and no more: session counts and last-active describe the project's activity rather than the restriction, and the picker one click away already shows them. Paging is the pure, tested `tablePaging.ts` (`resolvePaging` CLAMPS both page and size on every render, so a page left pointing past the end after a rule is lifted corrects itself; `PAGE_SIZE_OPTIONS` are owned by the MODE — inline 5/10/15 inside a card that must hold at 390px, maximized 10/25/50 — and a size from the other mode narrows rather than widens). The maximized view is the same table in a dialog: `esc` closes it and focus returns to the control that opened it. The table and its cells are **plain functions, not components** (`restrictionMiniTable({…})`), so the tree stays inline in `ReadView`'s and the block's content remains reachable to the tests that walk it. A row with no sibling information says so IN WORDS, and so does a "hidden on" cell holding only this machine (an empty or self-only cell reads as "nowhere else", a claim this machine cannot make); `machineCell` truncates with a truthful `+N` rather than silently dropping names; and the block carries no alarm colour: everything in it is there because the user chose it. The marker for "withheld" wherever it appears is the shared `withheldStyle.ts` token — a WEAK red, never `var(--accent-red)` itself, which is the fault colour `offline`/`unauthorized`/a broken connection use on the same card
      ├── team/siblingWarnings.ts + SiblingWithheldBadge.tsx → the REVERSE sharing warning at the point of decision, in the rules picker: a per-row badge naming the sibling machines that withhold a row (readable BEFORE the switch is flipped) plus a `role="status"` block listing exactly the rows this edit STARTS sharing (the draft's was-off-now-on set). It **warns, never blocks**, and it always renders the best-effort caveat beside the list — this machine knows only what siblings announced to it, so **an absent warning is never proof that no machine restricts a repository**. The projects tab additionally carries the folder-name caveat and shows the sibling's own path, and its copy says **"a project with this name"** — never "this project", which would assert an identity a basename match never established
      ├── DeployCentral.tsx / PresenceFilter.tsx / MemberConnectionStatus.tsx → central deploy help, online/offline member filter, member-side connection pill
      └── NotificationToasts.tsx / NotificationBell.tsx / UpdateModal.tsx → auto-dismiss toasts, header bell (history + unread badge), mode-aware upgrade modal

packages/core/src/              — shared across server + web + mcp (import as @agentistics/core)
  ├── types.ts              → all shared types + pricing functions (single source of truth)
  ├── format.ts             → shared display helpers: fmt(), fmtCost(), fmtDuration()
  ├── i18n.ts               → PT/EN translations
  ├── otel.ts               → OpenTelemetry helpers
  ├── chatUtils.ts          → TOOL_LABELS, formatToolName, etc.
  └── index.ts              → barrel re-export of everything above

packages/server/scripts/embed-dist.ts
  └── Reads packages/web/dist/ after vite build and generates
      packages/server/server/embedded-dist.generated.ts
      (assets embedded as strings/base64 for the compiled binary)
```

## Multi-harness tracking

Agentistics tracks sessions from multiple AI coding assistants (harnesses), not just Claude Code.

### Harness model

- `SessionMeta.harness: HarnessId` tags every session with its origin (`'claude' | 'codex' | 'gemini' | 'copilot' | 'antigravity' | 'kimi'`). Missing/legacy sessions default to `'claude'`.
- `AppData.harnesses: HarnessId[]` lists which harnesses have data present, used by the frontend to decide whether to show the harness selector in the nav (shown only when >1 harness is active). Selecting "All" yields the unified view.
- Each harness is implemented as a `HarnessAdapter` module under `server/adapters/` — never a separate package. `getEnabledAdapters()` lazily resolves and memoizes available adapters; individual adapters can be disabled via `AGENTISTICS_HARNESS_<ID>=0`.

### The harness contract — read `docs/harness-contract.md`

`docs/harness-contract.md` defines what each metric MUST MEAN across every harness (time, cost,
tokens, capabilities, filters, timestamps, purity). The checklist below is the mechanical half —
which files to touch. Do both: a harness that compiles and reports a metric computed its own way
is a bug, not a variation.

### Adding a harness — the complete checklist

Every point below is load-bearing; skipping one has, historically, produced a harness that compiles
clean and is then silently missing from half the product.

1. **`HarnessId`** (`packages/core/src/types.ts`) — add the id. This is what makes the compiler find
   most of the rest for you.
2. **`HARNESS_CAPABILITIES`** — a `Record<HarnessId, …>`, so the build fails until you declare it.
   Be honest: a capability set to `true` that the harness cannot actually produce renders a
   confident `0`, which is worse than `N/A`.
3. **`HARNESS_SORT`** (same file) — the Record behind `HARNESS_ORDER`. **Never hardcode a harness
   list anywhere else.** Five places used to, as plain arrays, and TypeScript accepts an array
   literal with a member missing: a new harness vanished from the Compare page, the filter bar, the
   data-source list and the consolidate store while the build stayed green.
4. **Adapter** — `packages/server/server/adapters/<id>.ts` (I/O) plus `<id>-parse.ts` (pure), and
   register it in `adapters/types.ts`. Add a data-dir constant to `config.ts` following the existing
   env-override pattern.
5. **Pricing** — usually nothing to do. Report the **bare model id** (strip any `provider/` prefix,
   as `kimi-parse.ts` does) and the shared table prices it. Only if the harness introduces a new
   vendor, add it to `PROVIDERS` (`packages/core/src/providers.ts`, which documents this) and its
   models to `MODEL_PRICING` with **verified rates and a dated source comment**. Never guess a rate:
   a wrong price is worse than a missing one, and a missing one is visible — Settings → Pricing
   lists any model of yours that no source can price.
6. **Live sessions** (`live-sessions.ts`) — add the process name to `PROCESS_HARNESS`, **and, if
   the CLI is installed as a `#!/usr/bin/env node` shim, its package path to `SCRIPT_HARNESS`**:
   such a process's `comm` and exe basename are both `node`, so name matching alone never sees it.
   `codex` and `gemini` were invisible for exactly this reason — check `readlink -f $(command -v
   <cli>)` rather than assuming a native binary, and re-check it when upstream changes packaging.
   If the CLI keeps its session file open, add a pattern to `FD_SESSION_PATTERNS` for exact
   identity; if it resumes by id, add the flag to `ID_FLAGS` and the command to `RESUME_BY_HARNESS`
   (`web/src/lib/resumeCommand.ts`) — verified from the tool's own `--help`, never guessed.
7. **Frontend** — `HARNESS_LABELS`, `HARNESS_COLORS`, `HARNESS_PROVIDERS` and a full `HARNESS_INFO`
   entry (EN + PT) in `web/src/lib/harness.ts`.
8. **Timestamps** — bucket activity hours on the **local** clock (`getHours()`), like every other
   adapter. Reading a UTC timestamp as local put the peak-usage chart hours off for four harnesses.
9. **Time** — emit `TurnEvent[]` and call `activeMinutesOf()` (`packages/core/src/activeTime.ts`)
   for `SessionMeta.active_minutes`; never compute duration in the adapter. Prefer a duration the
   harness measured itself, reconstruct from timestamps otherwise, and set `activeTime: false` only
   when the transcript has no usable timing at all. See `docs/harness-contract.md` § 1 — in
   particular, do NOT add an idle-gap threshold.
10. **Docs** — this file, `docs/harness-contract.md`, plus any `docs/` page enumerating harnesses.

### Pricing — three layered sources, and the built-in table is the floor

Costs come from `MODEL_PRICING` (compiled in), the LiteLLM community dataset, and the vendors' own
pages (Anthropic in `rates.ts`; OpenAI and Google in `pricing-official.ts`), merged in that order of
trust by `rates.ts` — so a source that fails or returns junk costs
freshness, never the ability to price anything. Every community row is validated first
(`pricing-community.ts`): non-positive costs, missing pairs, values implying a unit change, and
prices more than tenfold from the built-in figure are dropped. That dataset really does publish a
model at a cost of ZERO, which imported verbatim would make those sessions free.

Scraping a vendor page is **anchored**: OpenAI publishes every model four times (Standard / Batch at
half price / Flex / Priority at double) and Google repeats a table block per tier, with nothing in
the markup that reliably marks the standard one. A parsed block is adopted only if a model whose
rate was verified by hand comes out at the expected figure, so a page redesign yields NOTHING and
falls back, instead of yielding numbers that look right and are half wrong. Read cells positionally,
never by counting dollar signs — OpenAI writes "-" for no cache-write charge, and counting amounts
then reads output out of the wrong column.

Each model carries its origin (`official` / `community` / `builtin`), surfaced per row in
**Settings → Pricing**, which lists **only models this machine has actually used** — a new one joins
the list by itself the first time it appears in a session, with no code change. Group headings come
from `resolveProvider`, because a provider is a billing entity and a harness is not: Codex and
Copilot both run OpenAI models, Antigravity runs Google's and Anthropic's.

### N/A vs real 0 — `HARNESS_CAPABILITIES`

`HARNESS_CAPABILITIES` in `@agentistics/core` (`packages/core/src/types.ts`) is the single source of truth for which metrics each harness can produce. When a capability flag is `false`, the frontend renders "N/A" via the `NAtag` component + `capable(harness, metric)` helper (re-exported from `lib/harness.ts`), rather than showing a misleading 0. Current limitations: Codex and Gemini do not produce agent metrics or git line counts. **Antigravity produces `tokens`/`cost`/`model`** (decoded from the `gen_metadata` protobuf in `~/.gemini/antigravity-cli/conversations/<id>.db`, cost via the standard pricing table) and `gitLines` (edit deltas computed from the transcript's edit payloads, not `git diff`); it has `agents: false` because an `invoke_subagent` child is its own conversation, not an agent invocation on the parent. `dynamicWorkflows` (runs of the multi-agent orchestration Workflow tool) is `true` only for `claude` — it gates the repo-detail "Dynamic Workflows" tab.

### The context gauge — a LEVEL, and a window that is never guessed

The bar on a session row says how full that conversation's context window was on its **last turn**.
It has two halves and the second is the one that can lie.

**The measurement** is `SessionMeta.context_tokens`, gated by `HARNESS_CAPABILITIES.contextWindow`.
It is a **gauge, never a sum** — reassigned per turn, not accumulated — and that is why it is its own
field rather than something derived from the four token counters. Measured on a real session here:
cumulative input 44.3M against a context of 455k, so a gauge built from the totals would have read
~4400%. Per harness: **claude** — the last `message.usage`'s input side (`input` + `cache_creation` +
`cache_read`; verified 2 + 693 + 454.714 = 455.409 against a hand count of the same bytes);
**codex** — `last_token_usage.input_tokens`, which already includes the cached portion, NOT the
cumulative `total_token_usage`; **kimi** — the input side of one per-turn `usage.record`, from the
**main** agent only and chosen by timestamp (a subagent runs its own, emptier window, and file read
order must not decide the answer); **antigravity** — protobuf field `1.9.10.1`, off the last row,
with the window agy declares beside it in `1.9.10.4`. **gemini** and **copilot** are `false`:
gemini's chat files carry no token data at all, and copilot reports tokens only cumulatively at
shutdown.

**The window** is `resolveContextWindow` (`packages/core/src/contextWindows.ts`) — the
`MODEL_PRICING` provenance rule applied to a different number. `ContextWindow` requires
`verifiedAt` + `source`, so a window cannot exist without provenance, and **a model that is not in
the table draws no bar**. That is deliberate: an absent gauge is visible, a wrong percentage is not,
and the same 212.959 tokens is 106% of a 200k window and 21% of a 1M one. Two consequences:
- **A harness that states its own window outranks the table.** Codex writes `model_context_window`
  into every `token_count` event → `SessionMeta.context_window`, and **Antigravity states it too**,
  in protobuf field `1.9.10.4` beside its gauge. It knows the deployment and any per-session cap; a
  model id cannot express either — measured on one machine, agy ran `gemini-3.6-flash` under a
  128.000 window on some conversations and 256.000 on others, which no table keyed by model id
  could ever have told apart.
- **OpenAI and Google models are absent** (checked 2026-08-14: neither publishes a citable input
  token limit). So Kimi's routed models measure a context and still draw no bar. Add them the day
  the figures can be cited, never before. Antigravity is the case that shows the table is not the
  only way out: it draws a bar with no row here at all, because the harness declares the window
  itself.

**Known limitation, stated rather than papered over:** Claude Code can run `claude-opus-5` under a
200k session cap (its `opus[1m]` picker) and the transcript records only `claude-opus-5` — no
suffix, no window field. The table therefore reports the MODEL's documented maximum, so a session
deliberately running the smaller cap reads low.

**Rendering.** `contextFraction` is `null` whenever either half is missing or unusable, and null is
the only thing that decides whether a bar is drawn — never a `0%`. The **fraction is unclamped**
because a session really can exceed the table's window, so the **bar saturates** (or it would draw
outside its cell and shear every row under it) while the **label keeps saying `106%`**. Both round
DOWN, so neither can read full with room left. The cell outlives `metrics` under width pressure:
usage is what a session has spent, the gauge is what it has left.

### Aggregation — stats-cache.json is Claude-only

`stats-cache.json`, `dailyModelTokens`, and `modelUsage` inside it are populated exclusively by Claude Code and must never be used to aggregate non-Claude data. In `useDerivedStats`, a non-Claude harness is aggregated purely from per-session data. The unified view = Claude statsCache totals + per-session sums of non-Claude sessions. Non-Claude sessions are merged in `data.ts` **after** `supplementStatsCache` runs so Claude totals are never corrupted.

### Codex envelope format

Codex JSONL files wrap events in `event_msg` / `response_item` envelopes; the semantic event type lives at `payload.type`. Token usage is at `payload.info.total_token_usage` (cumulative — last seen wins). Codex `input_tokens` includes the cached portion, so the parser stores non-cached input (`totalInput - cached`) in `input_tokens` and the cached portion in `cache_read_input_tokens` separately.

### Antigravity (agy) — shares ~/.gemini, but is a separate harness

Antigravity lives at `~/.gemini/antigravity-cli` (inside the Gemini CLI home) while the Gemini
adapter reads only `~/.gemini/tmp` — the two never overlap or double-count. Per-conversation
transcripts are step-based JSONL at
`brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl` (`transcript.jsonl` is the
truncated fallback); the project path (`workspace`) and the raw prompts live in a single GLOBAL
`history.jsonl`. Parser rules: `CONVERSATION_HISTORY` steps are replays and are skipped, steps are
deduped by `step_index`, `type: 'slash_command'` / `/foo` prompts never become `first_prompt`, and
a conversation with no genuine user turn is dropped (same principle as the Gemini stub filter).

**Tokens / model / cost are REAL for agy.** They come from `conversations/<conversation-id>.db`
(SQLite), table `gen_metadata`, column `data` — a protobuf blob per LLM call, decoded by the pure,
dependency-free `adapters/antigravity-protobuf.ts`. Verified wire layout:
`1.4.1` the CONSTANT system-instruction size, `1.4.2` input, `1.4.3` output, `1.4.5` cache read,
`1.4.9` thinking, `1.4.10` completion, `1.9.10.1` context-size gauge, `1.9.10.4` the declared
context window, `1.19` technical model id, `1.21` display name. Rules:
- **`1.4.3` already includes `1.4.9`** — never add thinking on top of output.
- **`1.9.10.1` is a gauge, never a sum** — it is the context size at that call.
- **`1.4.1` is a CONSTANT and belongs in no sum.** This mapping was wrong for a release and the
  bug was invisible from inside: the first reader took `1.4.1` as input, `1.4.2` as cache and
  `1.4.5` as the gauge, and every number it produced looked plausible. It was off by **4,8x in
  tokens and 6,3x in cost** (52,6 mi / R$111 against a billed ~250 mi / R$703). What exposed it was
  a comparison with the provider's own console — and what would have caught it earlier is in the
  data itself: **`1.4.1` was the same 1072 on all 2.966 rows** (`min === max`), and a per-call
  counter cannot be constant. When adopting a field from an undocumented binary format, check that
  the values VARY the way the thing they claim to count varies, and reconcile the total against a
  bill before trusting it. The mapping above is pinned by tests and by the arithmetic recorded in
  `antigravity-protobuf.ts`'s header (input/cache/output and the 80,6 % cache share all land within
  a few percent of the console's figures for the same project; no other assignment is close).
- agy records **no cache-write** counter, so `cache_creation_input_tokens` stays 0.
- `model` is the dominant `1.19` across the conversation's rows (e.g. `gemini-3.6-flash`; agy can
  also drive Claude models, e.g. `claude-opus-4-6-thinking`). **Cost is `calcCost()` only** —
  `MODEL_PRICING` must resolve the id or the Sonnet fallback would report wrong money.
- The DB is opened **read-only** via `bun:sqlite` in the (impure) adapter; `antigravity-parse.ts`
  stays pure and receives the decoded totals. Missing / locked / corrupt DB → zero tokens, never a
  throw.

**Subagent children are detected intrinsically, never from `history.jsonl`.** `history.jsonl` is a
CLI prompt history that rotates and can be cleared, so it is only a hint (first prompt + workspace)
— it must never be the reason a conversation with a real transcript is dropped. A conversation is
excluded only when it appears in `buildAntigravityChildSet()`, built from (a) the parent's own
`INVOKE_SUBAGENT` step, whose content lists each child's `conversationId`, and (b)
`conversation_summaries.db` rows with `parent_conversation_id` / `nesting_depth > 0` when that table
has rows (it is frequently empty). Children are never rolled up into the parent — each has its own
DB and would double-count.

**Errors and edits.** Every agy step carries `status: "DONE"` even when it failed, so the dedicated
`type: "ERROR_MESSAGE"` step (with `error` / `error_code`) is the primary error signal; the
ERROR_MESSAGE / non-zero `exit_code` / `status ERROR|FAILED` checks are **mutually exclusive** so one
failed step can never increment `tool_errors` twice. `files_modified` is the count of DISTINCT
`TargetFile` paths from the write tools (`write_to_file`, `replace_file_content`,
`multi_replace_file_content`, …) plus the `file://` path named by a `CODE_ACTION` step, and
`lines_added` / `lines_removed` are newline counts of `CodeContent` / `ReplacementContent` vs
`TargetContent` (hence `gitLines: true` — these are edit deltas, not `git diff`; agy stores no git
metadata).

**No chat driver.** `chat-drivers/` spawns a CLI in non-interactive *streaming* mode and needs a
machine-readable event stream (`-o stream-json`), a session id and MCP registration. `agy` offers
`--print` but no structured output format, no session-id emission and no documented MCP config, so a
driver cannot be written that is trivially correct — reading `transcript_full.jsonl` after the fact
is a different (and racy) contract. Deliberately not added.

### Kimi Code (agy's neighbour in spirit, not on disk)

Kimi Code CLI lives at `~/.kimi-code`. Each session is a directory
`sessions/<workspaceId>/session_<uuid>/` holding `state.json` (title, `workDir`, `createdAt`,
`updatedAt`, the agent tree) and one `agents/<agentId>/wire.jsonl` event stream per agent — every
agent of a session folds into that one session, so sub-agent work is never dropped.

**Double-counting trap:** token counts appear TWICE in the wire — once as a top-level
`usage.record` and again inside the nested `context.append_loop_event → step.end`, byte-for-byte
identical (verified pairwise on real data). Only `usage.record` is counted. Records are per-turn
increments, not a running total (unlike Codex, where the last one wins).

Kimi ROUTES to other providers and stamps that provider's model on every usage record
(`google/gemini-3.5-flash-lite`), so `cost` is `true` and is a real calculation through the shared
pricing table — the adapter strips the provider prefix so the table can key on it. Kimi's own
`kimi-*` ids are not in `MODEL_PRICING` yet and would take the shared fallback rate like any unknown
id; add them when verified rates are published.

### Gemini caveat — bootstrap stubs vs. real sessions

Gemini CLI writes `~/.gemini/tmp/<project>/chats/*.jsonl` files but many are bootstrap-only stubs with no real conversation content. The Gemini parser (`adapters/gemini-parse.ts`) filters these out — only chats containing a genuine user message or model response are counted. Gemini's local files do not carry token/cost data; real Gemini token metrics would require OTel integration (Phase 3).

### Compare page — `computeHarnessSummaries`

`computeHarnessSummaries(data)` is an exported pure function in `hooks/useData.ts` that computes per-harness totals and comparatives (usage-by-hour, busiest day-of-week, activity-over-time, peak token day, peak session cost). Claude totals come from `statsCache` (full history); non-Claude totals are computed from per-session sums — so Compare page Claude numbers always match the main dashboard.

### Consolidate store namespacing

The consolidate store is namespaced by harness: `~/.agentistics/sessions/<harness>/<id>.json`. Legacy flat files at the root are read and treated as `claude`.

### Future phases

- **Phase 3** (planned): Gemini OTel integration for real token/cost data.

See `docs/superpowers/specs/2026-06-19-multi-harness-tracking-design.md` for the full design.

---

## Repository dimension (group by git remote)

Metrics can be grouped **by repository** (git remote) independent of the local path or which
machine produced them — so a repo's usage aggregates across all devs and CI agents. See
`docs/github-actions.md` for the GitHub Actions half.

### The key — `normalizeGitRemote` (single source of truth)

`normalizeGitRemote(url)` in `@agentistics/core` (`packages/core/src/types.ts`) collapses any
remote form (https / ssh / scp / git, with or without credentials/port/`.git`) into a stable,
**protocol-less** key `host/org/repo` (e.g. `github.com/org/repo`). Host is lowercased, path case
preserved. Returns `''` for local paths / `file://` / junk. **Never key repos by anything else.**
`repoShortName(remote)` drops the host for display (`org/repo`).

### How it's captured and threaded

- `git.ts getGitRemote(projectPath)` reads `remote.origin.url` (same Windows/WSL + no-prompt guards
  as the stats helpers) and normalizes it.
- `data.ts scanProjectDir` resolves the remote once per project and **stamps `SessionMeta.git_remote`
  onto every session** (+ `ServerProject.gitRemote`). Because it lives on the session, the remote
  travels into the consolidate store → team uploader → Mongo — the central has no filesystem access
  to members' repos, so per-session is the only place it can live.
- Frontend: `useDerivedStats` builds `repoStats` (per-remote aggregate; `remote === ''` = the
  "no linked repository" bucket, never hidden) and honors a `Filters.repos` filter (scopes cost/
  tokens session-side like a project filter). `RepoStat` is exported from `hooks/useData.ts`.

### GitHub Actions — `SessionMeta.ci` + repo-bound tokens

An ephemeral Claude Code Actions runner pushes its metrics via `agentop ci-push` →
`POST /api/team/ingest`. Auth is **keyless GitHub OIDC** (preferred): the runner presents a
short-lived GitHub-signed JWT, the central verifies it against GitHub's JWKS (`team-oidc.ts`, uses
`jose`) and checks the `repository` claim against the **registered repos allowlist** — no secret is
stored. A **repo-bound static token** (minted by `POST /api/team/repos`) is the fallback. Either
way the central **authoritatively stamps** `git_remote` + `ci: true` + `user = github-actions` (via
`stampCiSessions`) — a runner cannot mis-report its repo. CI sessions are keyed by `ciMemberId`
(`repo:<remote>`). `ci === true` sessions power the **Repositories → Actions** view. Enable OIDC by
setting `AGENTISTICS_OIDC_AUDIENCE` on the central (the workflow requests that same audience).

Cloud runners need the central reachable without exposing the dashboard. `AGENTISTICS_INGEST_ONLY=1`
(config.ts) makes a central serve **only** `POST /api/team/ingest` (404 for everything else, checked
right after the OPTIONS handler in `index.ts`) — run it as a public ingest instance sharing Mongo
with a separate private dashboard instance. See `docs/github-actions.md`.

### Repository rules

- **`normalizeGitRemote` is the only way to key a repo** — never parse `project_path` strings.
- **`git_remote` lives on the session** (not only the project) so it reaches the central.
- **CI attribution is server-authoritative** — stamped from the repo token, never trusted from the
  runner's payload.
- **`stats-cache.json` stays Claude-only** — repo/CI aggregates come from per-session sums, same as
  every non-Claude dimension.

---

## Team mode

One machine ("central") aggregates coding-assistant usage metrics from many machines ("members"). Members push **computed metrics only** (session/agent/token/cost aggregates + their statsCache) — **never chat** (raw chat is fetched on demand over a reverse WebSocket, never stored centrally). The central runs as a Docker service (`central.sh` at the repo root, default port `48080`, Mongo **not** published to the host). See `docs/architecture.md` for the full write-up.

### Roles — `preferences.team.mode`

- **solo** — local only, nothing leaves the machine (default).
- **central** — the aggregator; serves the team dashboard behind a password.
- **member** — pushes computed metrics to a central's `/api/team/ingest`.

### Push model — central owns the cadence

The **central owns the interval** (`central-config.ts`, `pushIntervalSec`; normal floor 15s, default 30s, express down to 5s = `EXPRESS_MIN_SEC`). Members read it from `GET /api/team/policy` and can only follow it — no member-side override that goes faster. Plus **push-on-change**: the file watcher calls `notifyDataChanged()` in `team-uploader.ts` → a debounced push floored by the central's interval. Members push their **supplemented** statsCache (the one the local dashboard shows, gap-filled past the stale `lastComputedDate`), never the raw `~/.claude/stats-cache.json`, so central totals match the member exactly. A member push triggers `triggerSseNotification()` on the central → dashboards refresh live, which is why the **"Live" toggle is hidden on a central**.

### Member identity

The display **name is set by the central** on the minted token — there is no name field on the machine; the member resolves it via `GET /api/team/whoami`. Sessions are keyed centrally by a stable `memberId` (token sha256 hash), so renames preserve history. `agentop member connect` never writes a half-config on a bad token.

### Presence — WebSocket-authoritative

`team-presence.ts` computes online/offline from the reverse-channel WS registry in `team-agent.ts`: online while the socket is live, **offline within ~8s** of a kill (`SOCKET_GRACE_MS`); once a member has ever held a socket that signal is trusted; a heartbeat window is only the fallback for pure-HTTP members. Latency comes from WS ping/pong RTT.

### Auto-reconciliation (self-healing sync)

`team-uploader.ts` fingerprints the target as `sha256(endpoint \0 token \0 instanceId)`. When it changes — central DB wiped (`down -v` → new `instanceId`), token revoked+re-added, or endpoint changed — the member clears its sent-state and **re-pushes its full history** (idempotent upserts, no double-count). No manual `team-sent.json` deletion. A persistent 401/403 (revoked token) auto-resets the member back to **solo** and fires a "removed from central" notification. A `null` instanceId (old/unreachable central) never triggers a spurious reset.

### Notifications

`web/src/lib/notifications.ts` is an external store rendered by `NotificationToasts` (auto-dismiss) + `NotificationBell` (history + unread badge). Notifications carry a `code` (+ `meta`) and are localized **at render time** (`NOTIFICATION_TEXT`, pt/en). The server emits them over SSE via `broadcastNotification()`.

### Team-mode rules

- **Members never push chat** — only computed metrics + statsCache; raw chat is on-demand over the WebSocket. The ONE exception is `first_prompt` / `title`, which are chat-derived and DO travel; they are scrubbed by `redactSecrets` (`@agentistics/core`, `redact.ts`) at **two** boundaries: `selectDeltas` on the member (so a pasted credential never crosses the wire) and `toTeamDoc` on the central (because a central cannot assume its members run current code — in a mixed-version fleet the machine on the old build is exactly the one that leaks). The redactor is deliberately PRECISE, not exhaustive: `first_prompt` labels every session in the UI, so a rule that also ate `input_tokens=123` would make labels useless and get switched off. Generic `key=value` rules are guarded by a value-shape test; when in doubt it leaves text alone. It is a safety net for the accidental paste — **never a substitute for rotating a leaked credential**.
- **Tokens are stored only as sha256 hashes** (`team-tokens.ts`) and never logged; the central's session-cookie secret is **separate** from the dashboard password; auth compares are constant-time.
- **Non-Claude team metrics still come from per-session sums** — `stats-cache.json` remains Claude-only, on the central too (Compare-page Claude totals match the dashboard).
- **The member's deep Claude history exists ONLY aggregated** (`AppData.userStatsCaches`, keyed by
  display name) — the individual session docs cover a fraction of it. Any filter that cannot be
  expressed against those caches must NOT silently fall back to summing sessions, or the same scope
  reports a fraction of itself. `userStatsCaches` sums a member's machines under one name, so the
  **machine and team filters are served by `AppData.machineStatsCaches`** (the same caches keyed by
  machine id) via the pure `resolveMachineCacheScope()` in `@agentistics/core`. It returns `null` —
  meaning "fall back to the per-session sum" — whenever the caches cannot serve the scope exactly
  (unknown machine, missing cache), so precision is added, never invented. Project / repo / tag /
  model / date genuinely have no cache granularity and stay cache-blind (`cacheBlindScope`).
- **The central is the sole authority on the push interval** — members clamp to `max(central, EXPRESS_MIN_SEC)`; there is no faster member override.
- **`agentop central` runs from anywhere** — in a repo checkout it wraps `central.sh` (which does `build: .`); from the standalone binary (no repo) `cli-central.ts` falls back to a Docker-image path: it materializes a compose that pulls `ghcr.io/blpsoares/agentistics:<version>` + generates `central.env` into `~/.agentistics/central/` and drives `docker compose` directly. The image is published to GHCR by the `publish-image` job in `release.yml`. Override the image with `AGENTISTICS_IMAGE`.
- **Per-connection sharing rules — projects and repositories, denylist or allowlist, never on the
  wire.** A connection restricts what it receives across two dimensions (`repo`/`project`, plus
  the fixed `none` bucket for sessions with no resolvable repo) under one of two modes:
  `shareMode: 'denylist'` (share everything except `sources` — the default) or `'allowlist'`
  (share only `sources`). **`share-rules.ts` is the only place these semantics live** —
  `sessionShared(session, rules, index)` where `rules = { mode, sources }`; nothing downstream
  re-derives them. **Deny wins across dimensions in denylist mode**: matching a blocked repo denies
  a session even if its project is not listed. **`shareMode` absent reads as `'denylist'`** —
  every pre-existing config is one, and treating absence as anything else would silently invert
  live rules; `migrateTeamConfig` (`@agentistics/core/team.ts`) derives `{shareMode:'denylist',
  sources}` from a legacy `deniedRepos: string[]`, deterministically and idempotently, in the same
  read path Plan 1's migration already used. **`deniedRepos` is derived-on-write only, from Task 2
  onward** — it is kept solely as a read-migration source; any code that still *writes* it directly
  is a bug. The typed rules live only in `preferences.json`, the in-memory `TeamConnection`, and the
  browser tab on the machine's own origin; `IngestBody` gains no field for them, and
  `GET /api/team/status` exposes only `shareMode` + a per-dimension **count**
  (`deniedRepos`/`deniedProjects`, or `allowedCount` in allowlist mode) — never the values,
  same-origin only. The restricted statsCache (`buildSplitStatsCache`, `share-rules.ts`) is
  selected by the **declared** rule — `sourcesRestrict(conn.shareMode, conn.sources)`, where
  allowlist mode is ALWAYS a restriction (even an empty allowlist, the strictest case) and
  denylist mode is one only once it names a source — never by comparing a filtered count against
  an unfiltered one; a count comparison fails open on a cold consolidate store. **There is no
  fallback to the unsplit cache on the restricted path, ever** — when the split cannot be built
  faithfully, the push omits `statsCache` entirely rather than shipping the real one.
  **Allowlist mode still ships the prehistory rollup**: days at or before Claude's own
  `lastComputedDate` watermark cannot be decomposed by repository or project by anyone, so that
  block travels as unattributed daily volume in both modes — "share only X" narrows the
  decomposable window, not that rollup. The retroactive-removal trigger (`planRulesReconcile`,
  `team-rules.ts`) is **denial, never absence** — a session merely missing from a short store read
  is never treated as newly denied, which would ask the central to delete perfectly valid sessions
  and drop them from the sent-state forever. `stats-cache.json` stays Claude-only here too — the
  split's synthetic and rebuilt halves are both accumulated from Claude sessions only
  (`accumulateClaudeSessions`).
  See [docs/architecture.md](docs/architecture.md#per-connection-repository-sharing) and
  [docs/security.md](docs/security.md#8-per-connection-sharing-rules--the-guarantee-stated-precisely).

### Managing a machine's sessions FROM a central — the machine decides, always

`docs/architecture.md` and `docs/security.md` carry the write-up; these are the invariants a
harness working here must not break.

- **Two consent switches, and absent reads as OFF** (`remoteSessions.ts`, core). `sessions` grants
  the row and the screenless verbs; `screens` additionally grants the terminal. `screens` is never
  in force without `sessions`, and withdrawing `sessions` CLEARS `screens` rather than leaving it
  stored — a grant left behind returns the moment the first switch is flipped again, which is a
  grant nobody re-made. Same rule as `chat-gate.ts`, deliberately NOT `shareMode`'s migration rule.
- **The relayed row is an ALLOWLIST, never a delete-list** (`reduceMachineFleetRow`). A
  spread-and-delete leaks the next field somebody adds to `ControlSession`, silently and on every
  machine. `chatTurns`, `lastLines`, `approvalLines` and `dialogOptions` may never cross, and
  `machineFleet.test.ts` asserts it over a row carrying all four.
- **Rules first, then reduce.** The member applies `cwdShared` BEFORE building the row, so a
  session in a withheld repository never becomes one — reducing first leaves no `cwd` to judge.
  `withheld` is a count of SESSIONS and is reported, never silently subtracted.
- **The sharing rules bind the ACT half exactly as they bind the READ half, and for one release
  they did not.** `buildMachineFleetReply` filtered rows through `cwdShared` from the day it
  shipped; `performMachineAction` checked consent and the verb and then handed the id to
  `runFleetAction`, which resolves against the machine's RAW fleet and registry — so a central
  could `kill`, `rename`, `resume` or re-task a session in a repository the member had explicitly
  withheld from it. **A rule enforced when you LOOK and not when you ACT is not a rule.** Both
  halves now resolve through the one `sharedCwd` helper, and an id the machine cannot find is
  refused for the same reason a row with no `cwd` is: the rule names directories, and an
  unresolvable target has none to judge.
- **The TASK verbs are refused outright on a RESTRICTED connection.** `openTask` expands to every
  session filed under the row's task, over the whole registry, and a task routinely spans
  repositories — so pressing it on a VISIBLE row spawned live assistants inside a withheld
  directory and answered with a count of them. Refusing only when the task provably spans a
  withheld row would be an ORACLE: repeated over the visible rows it maps which of them share work
  with the hidden half, which is the same correlation as counting a hidden project's sessions. The
  blunt refusal discloses nothing the reply does not already carry (`withheld` is a machine-level
  count), and the verbs are dropped from the relayed row too — offering one the machine will refuse
  is the control-that-reads-as-broken this file argues against everywhere else.
- **Consent is ORTHOGONAL to the sharing rules, and that is the trap.** The two switches are
  machine-wide; turning on "manage my sessions" says nothing about WHICH sessions, so without the
  rule check above it silently re-opened the act surface over every withheld repository.
- **`machineActions.ts` is CLOSED.** A verb it does not know is refused. A new `FleetActionId` must
  be listed there on purpose before a central can drive it. `approve`/`prompt` are excluded because
  neither can be offered without the screen — refused with a sentence naming why, never a disabled
  button implying it is merely off.
- **The MACHINE re-checks everything.** Consent and the verb allowlist are re-read from preferences
  on every request in `performMachineAction`. The central's copy of those checks spares a round
  trip and nothing more: a check that runs only on the party whose behaviour cannot be verified is
  not a check.
- **`machineOwnedBy` is not `canManageMachine`.** The wider predicate is right for administering a
  machine (rename, rotate, re-assign) and wrong for reaching into its sessions. An unknown machine
  answers `not-owner` exactly like one you do not own, so the route is not an existence oracle.
- **Four silences, four sentences**: `not-owner`, `refused`, `offline`, `silent`. An empty list may
  never stand in for any of them. A machine that refuses while OFFLINE reports offline — the more
  actionable half.
- **The central composes no wording.** Every refusal is the machine's own already-localized
  sentence, passed through untouched.
- **`/api/fleet*` stays refused on a central** (`index.ts`'s `TEAM_CENTRAL` block, plus its
  `localShell` entry in `capability-guard.ts`). The relay routes are separate and touch no host, and
  their deliberate ABSENCE from `capability-guard.ts` is pinned by a test rather than left as an
  omission.

---

## Cost basis — API vs plan

Every cost in this product is an **API-equivalent estimate** (`calcCost()` × `MODEL_PRICING`).
Most people pay a flat subscription, so that figure is not their invoice. `costBasis: 'api' |
'plan'` (on `AppContext`, plumbed exactly like `currency`) re-expresses it against what the user
actually pays.

- **`packages/core/src/billing.ts` is the ONLY place the plan arithmetic lives.** No caller may
  re-derive coverage. `C = Σ monthly × days / 30.44` over the user's registered periods; `V = A/C`.
  Proration is by DAYS, not calendar months — the calendar reading cannot survive an arbitrary
  filter window.
- **The model is a TIMELINE of periods per harness, never a single "current plan".** No file on
  any machine records which plan was in force when, so a window spanning a plan change can only
  be priced by asking. Overlapping periods are refused at entry **and re-checked in
  `computePlanCost`** — `preferences.json` is hand-editable and a silently doubled C is worse
  than none.
- **Uncovered days are cut from BOTH A and C**, via the single `coveredDayKeys` set. Cutting one
  side only inflates V; re-deriving the day set elsewhere makes A and C measure different periods.
- **N/A, never a confident 0.** An uncovered window is `unavailable`; a multiple over zero cost is
  `null`; an unconvertible BRL price uncovers its days rather than yielding `Infinity`. `viewCost`
  refuses too: asking for the plan basis with no usable factor returns the API figure flagged
  `unavailable`, never a silent zero under a plan label.
- **Two day rules exist in this repo; billing uses `start_time.slice(0, 10)` (UTC)**, matching
  `tagSessionDay` — not the local-clock `format(parseISO(...))` used for the session-gap count. At
  UTC-3 the two disagree, and mixing them drifts a session across a period boundary.
- **`apiCostByDay.undatedCostUSD` is real spend with no day.** In the unfiltered view Claude's
  total comes from the cumulative `statsCache.modelUsage` while the only day series
  (`dailyModelTokens`) does not sum to it, so a per-day A that closes on the headline does not
  exist. The residue is the EXACT difference (`Σ days + undated === totalCostUSD`, pinned by a
  test) and is reported, never folded into a day it did not happen on. A **negative** residue is
  the two local sources contradicting each other and withholds the basis entirely.
- **The plan basis is unavailable on a central, and the refusal lives in `usePlanBasis`.** It
  aggregates many machines and could only ever hold its operator's timeline; Settings → Billing is
  hidden there too. Forcing `costBasis` to `'api'` is NOT the guard — two surfaces read `planBasis`
  directly and bypass the switch (Home's "API vs your plan" panel, gated on
  `basis?.coverage.computable`, and `CompareByFilter`'s per-side Plan button, gated on
  `billingReady.ready && basis !== null`). A central whose `preferences.json` still carried a
  timeline — a machine that used to be solo, or a hand edit — would then price a whole FLEET from
  one operator's subscription. `central: true` returns `{basis: null, blocked: 'central'}` at the
  single place the basis is computed, so there is nothing downstream to forget. Hiding the settings
  screen is the cheap fix that leaves exactly that hole open.
- **A panel where "plan" has no meaning renders in API basis and says so** — `CacheHitRatePanel`
  is hard-wired, because cache does not reduce a subscription bill, it extends a rate limit. Same
  rule as `HARNESS_CAPABILITIES`, applied to a basis instead of a metric. `BudgetPanel` likewise
  keeps its variable tracking (a forecast of a fixed fee only predicts itself) and instead shows
  `monthlyCommitment()` — a SEPARATE question from `computePlanCost`, answering "what do I owe
  this month" rather than "what did this window cost". api-mode days commit nothing to it.
- **A Claude-only metric allocates against Claude's own C/A**, never the cross-harness aggregate —
  `AgentMetricsPanel` would otherwise price agents partly against a plan paying for something else.
- **The HEADLINE is `planCostUSD` read straight off the basis — never `totalCostUSD × factor`.**
  That rescale is the right shape for a per-ROW allocation and the wrong shape for the total: the
  factor is `C/A` of the COVERED harnesses while `totalCostUSD` spans every harness in the filter,
  so multiplying them yields neither C nor an allocation. Measured: R$2.500,86 on screen against a
  real `500 × 126/30.44 = R$2.069,65`, with `PlanValuePanel` — which always read `planCostUSD` —
  printing the correct figure directly below it. When the covered scope is narrower than what is on
  screen, `planScopeNote` names it ("só Claude Code"), because the cards beside the headline count
  every harness and an unexplained smaller number reads as a bug.
- **A harness selection of exactly `['claude']` is NOT cache-blind.** `stats-cache.json` IS Claude's
  history, so that selection is served by the cache; treating it as a session-only filter made the
  same scope report LESS with the chip than without it (Claude deletes transcripts after 30 days,
  the cache keeps the totals). A MIXED selection stays session-based — `nonClaudeInRange` is empty
  whenever any chip is set, so a cache-backed branch would silently drop the other harness.
- **Per-row plan figures are ALLOCATIONS, labelled as such.** Within one harness it is a linear
  rescale by C/A, so rankings and proportions survive exactly; across harnesses the factors differ
  and the label is the only thing stopping it being read as a measurement.
- **`plan-catalog.ts` inherits the `MODEL_PRICING` rule structurally**: `CatalogPrice` requires
  `verifiedAt` and `source`, so a price cannot exist without provenance. An unverifiable price is
  OMITTED and the user types it — several entries ship with no amount for exactly this reason.
- **`billing-detect.ts` may name only the whitelisted fields.** The files it reads also hold OAuth
  secrets, a mail address and account identifiers; `billing-detect.test.ts` greps the module's own
  source and fails if one is so much as mentioned. Never shell out to the macOS Keychain.
  Detection is a PROPOSAL — it cannot know when a plan started, which is what the timeline needs
  most. **Codex's tier is only ever written inside the ID token's payload**, so `readJwtClaim`
  decodes that segment and returns one named claim; the token itself is never held, and the guard
  list grew `access_token`/`refresh_token` so the module cannot name the pair beside it. **A tier
  detected as FREE proposes `mode: 'unknown'`, not a subscription of zero** (zero is not a price —
  it would make every multiple infinite), and the settings screen states the finding while
  withholding the "use what we detected" button, which would open a form prefilled with nothing.
- **The basis toggle is a GATE**: disabled until `billingReadiness().ready`, and pressing it
  disabled opens the setup prompt rather than doing nothing.

See `docs/metrics.md` for the arithmetic written out and `docs/security.md` for the reader's
boundary.

---

## Calculation functions — single source of truth

**All layers** use the same functions from `packages/core/src/types.ts` via `@agentistics/core`. Never inline pricing calculations.

### "Tokens" means all four counters — `packages/core/src/tokens.ts`

A session carries four billed counters and **`tokens` is always their sum**: `input + output +
cacheRead + cacheWrite`. Measured on one real machine across 123 Claude sessions, `input + output`
alone is **0,34 %** of the volume — so a surface summing two of the four is not slightly low, it is
off by ~300×, and the cost beside it (which priced the cache) disagrees by ~10×.

This was found as a session-drawer bug and turned out to be 19 call sites: the Compare page's
Tokens row and its cost-per-1M, the tag cards and tag detail, the repositories list and its sort,
the repo-detail CI and member tiles, the model breakdown's filter, five points in the PDF export,
the header's `N tok` counter, `data.ts` and `tags-detail.ts` on the server, and the session drawer
and recent-sessions list. Rules:

- **Count through `tokens.ts`** — `sessionTokens` / `usageTokens` / `sessionTokenTotal` /
  `usageTokenTotal` / `totalTokens` / `addTokens` / `sumTokens`. Never write the sum by hand.
- **An aggregate type carries `tokens: TokenBreakdown`**, not just `inputTokens`/`outputTokens`
  (`HarnessSummary`, `RepoStat`, `TagAggregate`, `derived.tokenTotals`). The conversational pair is
  kept for surfaces that legitimately want it and is **never** the thing labelled "tokens".
- **`calcCost` gets the real cache counters.** Hardcoding `cacheReadInputTokens: 0` prices the
  cheap 4 % of the volume. For a session with no model, `blendedSessionCost` applies each of the
  four blended rates — pricing cache as fresh input is the opposite error, ~10× too high.
- **A label may not exist without its explanation.** `TOKEN_KINDS` carries label + one-sentence
  `help` in EN/PT, and `totalTokensExplained()` is the sentence that goes under any headline
  figure. These numbers reach the billions; a total with no account of what it contains reads as a
  fault, and an unexplained alarming number is how a dashboard loses the right to be believed.
- **`tokens.lint.test.ts` is the enforcement** — it greps the repo (core / server / web / tui) for
  two-term token sums and for `calcCost` arguments with the cache zeroed, and fails the build.
  Comments and per-field `+=` accumulation are exempt; a genuinely intentional two-term reading
  needs `@tokens-intentional` **with a reason** on the same or a preceding line.

### `MODEL_PRICING` — pricing table (USD per 1M tokens)

```
packages/core/src/types.ts
```

Update here when Anthropic changes prices or releases new models. Fallback (Sonnet 4.6: $3/$15) is the return value of `getModelPrice` when no match is found.

### `getModelPrice(modelId)` — resolves price by model ID

```
packages/core/src/types.ts
```

Tries exact match, then partial match via `startsWith` in both directions. Returns Sonnet 4.6 fallback if no match.

### `calcCost(usage, modelId)` — total cost from a usage record

```
packages/core/src/types.ts
```

Takes a `ModelUsage` object (input, output, cacheRead, cacheWrite in tokens) and returns cost in USD.

### `blendedCostPerToken(modelUsage)` — weighted average rate across models

```
packages/web/src/hooks/useData.ts
```

Used when there is no per-session model ID (project filter active, or per-session cost in PDF export). Weights each model's rate by its token volume in global usage.

### `serveStatic(pathname)` — serves embedded frontend assets

```
packages/server/server/sse.ts
```

Only active when `SERVE_STATIC=1` (set by `cli.ts` for the `server` subcommand). Reads from `embeddedDist` (generated at compile time). Returns `null` in dev mode.

---

## Where each layer calculates cost

| Layer | What it calculates | How |
|-------|--------------------|-----|
| `useData.ts / useDerivedStats` | Filtered `totalCostUSD` | `calcCost()` per model; `blendedCostPerToken()` when project or model filter is active and per-session breakdown is needed |
| `ModelBreakdown.tsx` | Per-model cost in the UI | `calcCost()` |
| `PDFExportModal.tsx` | Per-model cost in PDF | `calcCost()` |
| `PDFExportModal.tsx` | Per-session cost in PDF | `blendedCostPerToken(statsCache.modelUsage)` — sessions have no individual model field |
| `otel-watcher.ts` | Total cost exported via OTel | `calcCost()` from `@agentistics/core` |
| `packages/tui` | Cost in terminal output | `calcCost()` via the pure `selectors.ts` |
| `server/agent-metrics.ts` | Per-agent-invocation cost | `calcCost()` with per-invocation token breakdown |
| `server/rates.ts` | — | Does not calculate cost; only fetches/caches the external pricing table (`/api/rates`) |

---

## Agent metrics

Agent metrics are extracted from raw JSONL files by `server/agent-metrics.ts`. They are available in the `agentMetrics` field of each `SessionMeta`.

### The numbers are in the SUBAGENT'S OWN transcript, not in the parent's result

**Claude Code made the `Agent` tool asynchronous on 2026-08-14 and the parent's `toolUseResult`
stopped carrying any numbers.** It is now `{ agentId, description, isAsync, outputFile,
resolvedModel, status: 'async_launched' }` — no `usage`, no `totalTokens`, no `toolStats`, no
duration. Every `?? 0` in the old reader fired at once and each invocation was published **priced at
nothing**: measured on one machine, 391 of 391 invocations from 08-14 onward reported 0 tokens while
the panel kept drawing rows for all of them. That is the whole failure mode worth remembering — a
PARTIALLY working reader. `agentType` and `description` come from the parent's `tool_use` input, so
the rows kept their names and only the values were gone, and it went unnoticed for three weeks.

The numbers moved to `~/.claude/projects/<project>/<session-id>/subagents/agent-<agentId>.jsonl`
(+ an `agent-<agentId>.meta.json` naming the parent's `toolUseId`). `subagent-parse.ts` is **pure**
— it sums one such transcript — and `subagent-metrics.ts` does the I/O: find, recurse, memoize.

- **`outputFile` is NOT the file to read.** It is the agent's text answer in the run's `/tmp` scratch
  directory, cleared on reboot and already gone for every invocation measured here. The durable one
  is under `subagents/`.
- **Price each model at ITS OWN rate.** A subagent commonly runs `haiku` under an `opus` parent (four
  distinct models across 440 transcripts here), so one `modelId` for the whole invocation bills a
  cheap agent as an expensive one — which is exactly what the old reader did with the parent's model.
- **A nested subagent counts inside the invocation that spawned it.** Only a top-level `Agent`
  `tool_use` becomes an `AgentInvocation`, so a subtree left out is left out of the session's totals
  entirely. Cycle-safe by a visited set.
- **The DURATION is the root's own span** — a nested agent runs inside its parent, and adding the two
  counts the same wall time twice.
- **An invocation whose transcript is gone is `unmeasured: true`, never a zero.** Read that flag
  BEFORE any figure on the record: it carries zeros only because the type has no other value to
  carry. `SessionAgentMetrics` totals exclude them and `unmeasuredInvocations` counts them, so a
  surface can say the totals cover fewer rows than it is showing (`web/src/lib/agentMeasured.ts`).
  Same rule as `HARNESS_CAPABILITIES`, applied to one row instead of a whole harness.

| Field | Source |
|---|---|
| `agentType` | `toolUseResult.agentType`, else the `tool_use` input's `subagent_type` |
| `description` | `tool_use.input.description` |
| `agentId` | `toolUseResult.agentId` — names the subagent transcript |
| `totalTokens` (all four counters) / `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` | the subagent transcript's `message.usage`, per model; legacy: `toolUseResult.usage.*` |
| `totalDurationMs` | the subagent transcript's first→last timestamp; legacy: `toolUseResult.totalDurationMs` |
| `totalToolUseCount` / `toolStats` | the subagent transcript's `tool_use` items and `structuredPatch` hunks; legacy: `toolUseResult.toolStats` |
| `costUSD` | `calcCost()` per model of the subagent's own turns |
| `status` | `toolUseResult.status` (`failed` → `failed`, anything else → `completed`) |

### What is NOT available for Skills and Tasks

- **Skills** (`/commit`, `/review-pr`, etc.) are not recorded as individual tool_use events in the JSONL — only a `skill_listing` attachment appears. Skill invocations can only be inferred indirectly from subsequent tool calls.
- **Tasks** (`TaskCreate`/`TaskUpdate`) have subject/description/status but no token or duration data.

---

## Data flow

```
~/.claude/
  ├── stats-cache.json          → aggregated data (tokens/day, model, activity)
  ├── usage-data/session-meta/  → enriched sessions (preferred source)
  └── projects/**/*.jsonl       → raw files (fallback + agent metrics source)
         ↓
    packages/server/server/data.ts (buildApiResponse — main orchestrator)
    packages/server/server/agent-metrics.ts (extractAgentMetrics — parses Agent tool_use from JSONL)
         ↓
    /api/data → useData() → useDerivedStats() → React components
```

## Archive mirror (survives Claude's 30-day cleanup)

Claude Code deletes session transcripts (`~/.claude/projects/**/*.jsonl`) older than `cleanupPeriodDays` (default 30) on every startup, taking per-session detail + agent metrics + chat content with them (the `stats-cache.json` aggregates survive). Official docs: https://code.claude.com/docs/en/settings.

**Three modes**, persisted as `preferences.archiveMode` (`undefined` = not chosen → the consent gate blocks the app). `resolveArchiveMode()` / `getArchiveMode()` in `preferences.ts` migrate the legacy `archiveSessions` boolean (true→'full', false→'off'):
- **`consolidate`** *(recommended default)*: `data.ts` persists each computed `SessionMeta` (+agentMetrics) to `~/.agentistics/sessions/<id>.json` (~KB each, skip-if-identical), then on read **gap-fills** — sessions/projects no longer present live are revived from the store. No raw files duplicated. Trade-off: loses the raw chat text of deleted sessions and future recompute.
- **`full`** *(opt-in "archivist")*: additionally `archive.ts` mirrors raw transcripts into `~/.agentistics/archive/` (copy-if-newer; `archiveEnabled()` = mode==='full') and `data.ts` reads the union live+archive roots + `applyArchivedStats()` (per-date fill + per-field `max`, never additive). Heavy + grows unbounded; preserves everything incl. raw chat.
- **`off`**: nothing — uses `~/.claude` exclusively.

- **Consent gate**: `ArchiveConsentModal.tsx` blocks first load (links the official doc) — primary Yes(consolidate)/No(off) + an "Advanced" expander revealing full-copy. `App.tsx` early-returns the modal when `archiveChoice === null`; `chooseArchive(mode)` PUTs `archiveMode`. Env `AGENTISTICS_ARCHIVE=0` hard-disables everything; `AGENTISTICS_ARCHIVE_DIR` overrides the archive path.
- **No false metrics**: dedup by `session_id` (live always wins) + the `supplementStatsCache` guard (`day <= lastComputedDate` skip) mean revived old sessions show in lists/agent-metrics but never inflate aggregate totals. Boot + the PUT `/api/preferences` handler warm a build (persists the store) and `full` also runs `fullSync()`.

## Security rules

A central can be published on the internet. The model is documented in **`docs/security.md`**
(threat model, trust boundaries, request pipeline, limits of each control) and the deployment
runbook in `docs/exposure.md`. These rules are what keep it safe; each exists because its
absence was a real finding.

- **`exposure.ts` is the only place that decides what a profile may do.** `PROFILE` is
  `local` | `lan` | `public`, and `CAPS` derives from it. Never re-derive a capability from env
  vars at a call site, and never add an opt-in that re-enables host power on `public`.
- **Any new route that touches the host** — spawns a process, reads `~/.claude`, writes a
  dotfile — must be registered in `capability-guard.ts`. A route that is not registered is
  assumed harmless, so a missed registration is a vulnerability, not an oversight. The guard
  runs *before* the auth gate on purpose.
- **Any new `/api` route is authenticated by default.** Adding one to `AUTH_PUBLIC`
  (`index-routes.ts`) requires updating `authz-gate.test.ts`, which asserts the exact contents
  of that Set — that test IS the review gate.
- **Never return internal error text to a client** — use `safeError` (`errors.ts`). The client
  gets a code plus a correlation ref; the message goes to the log.
- **Never `await req.json()` on an unauthenticated route** — use `readJsonLimited` (`limits.ts`),
  which abandons an oversized body mid-stream instead of buffering it first.
- **Every authentication and admin action writes an audit event** (`audit.ts`). The pure builder
  redacts secret-shaped fields; never add a field that carries a credential.
- **The session secret is never derived from the dashboard password**, and cookies are
  `__Host-` prefixed + `SameSite=Strict` whenever they are Secure.
- **Rate-limit anything that can be guessed.** `rate-limit.ts` keys hard blocks per IP and soft
  backoff per account — per-account lockout must stay soft, or it becomes a DoS against a
  colleague.
- **Step-up gates escalation, not paperwork.** `PROTECTED` in `stepup.ts` is deliberately three
  entries: editing/creating/deleting an ACCOUNT (role and memberships live there — it is where a
  session becomes an owner), deleting a TEAM, and CHANGING A PASSWORD. Enrolling a machine, a
  token or a repository is routine work and is NOT gated — a prompt people meet daily is a prompt
  they clear without reading, and every other prompt pays for it. `stepup.test.ts` asserts the
  table EXACTLY, so adding an entry is a product decision, not a drive-by. Those three call
  `stepUpFetch` on the web side, never bare `fetch`; everything else, reads included, uses `fetch`.
- **`agentop doctor --exposed` must pass before exposing anything.** A check that could not be
  verified reports `fail`, never a reassuring `pass`.
## Terminal UI (`packages/tui`)

**There is ONE Ink application in this package**, the control center, and `agentop` / `agentop start`
/ `agentop tui` all open it. `tui` used to be a second one — its own shell, its own keyboard, its own
help panel — drawing the very screens the `dashboard` tab draws; once those screens became shared
code (`src/dashboard/`), what the standalone app still owned was a DUPLICATE of the chrome around
them, which is a second set of keys for the same material and a second place for the two to
disagree. It is now renamed into `start` in `cli.ts`'s dispatch — a BRANCH of its own would be a copy
that starts identical and drifts.

```
packages/tui/src/
  selectors.ts       PURE AppData -> view model (the tested core)
  i18n.ts            EN/PT strings for the dashboard's own words (columns, screen names, the pager)
  theme.ts           palette mirroring the web dark mode + HARNESS_COLOR
  useTerminalSize.ts columns/rows that follow SIGWINCH
  data/              useAppData (fetch + SSE)
  components/        Primitives (Kpi/Bar/DataTable/fitColumns/Pager), Sparkline
  screens/           Overview, Projects, History, Costs, Harnesses, Hardware
  dashboard/         view.ts (PURE: screens, row budgets, PAGING, applyHarnessFilter),
                     useDashboardNav (its keyboard), DashboardView (the one mounted dashboard)
  overlays/          the harness filter
  control/           the control center — the `agentop` front door
    index.ts         runControlCenter({ lang, host, tab }) → ControlExit; the ONLY server import
    types.ts         ControlHost / ControlStatus / TabId — the presentation ↔ logic contract
    altScreen.ts     the alternate buffer + `suspend` + `writeFrame` (the gate Ink draws through)
                     + the signal guard
    stream.ts        PURE: a command's raw bytes → pane-safe lines (\r progress collapsed, ANSI
                     stripped, chunk/escape boundaries buffered, ring-bounded); tested
    ControlCenter.tsx  the one mounted component: screen router, global keys, shared chrome state
    nav.ts chrome.ts  PURE key/focus/scroll reducers and PURE layout arithmetic — `headerLayout`
                     (block art vs the compact mark), the tab bar and its underline, the header tag,
                     `cockpitLayout`'s band/detail geometry, `detailContent` + `fitDetailLines`, the
                     services and action row fits (both tested)
    surface.ts       PURE arithmetic for the LINEAR screens and the questions: section rules, menu
                     and prompt cells, word wrap, `logSources` (the Logs screen's source list,
                     DERIVED from ControlStatus.services), the selector's fit, and the `staticRows`
                     / `setupRows` row budgets (tested in surface.test.ts)
    i18n.ts lang.ts content.ts  EN/PT chrome strings; the CliLang type; the Help / Cheat sheet / Contribute copy
    Pane.tsx         the ONE containment style: rounded frame, title in the border, accent when focused
    Chrome.tsx Surface.tsx Menu.tsx Prompt.tsx ArchiveChoice.tsx   shared primitives (cockpit / linear / questions)
    Output.tsx       the pane a streaming task owns — the detail region, auto-following its tail
    sessions.ts      PURE arithmetic for the sessions tab: its row budget, the cell fit, the
                     grouping and the ordering (tested in sessions.test.ts)
    session-order.ts PURE: what a fleet is ordered BY, and the ranking every surface breaks ties
                     on. Below `sessions.ts` so `session-tree.ts` can read it without the two
                     importing each other — `sessions.ts` re-exports every name
    session-tree.ts  PURE: the CASCADE — the project as the root and the segments of each session's
                     `cwd` below it as branches, single-child chains compressed. It returns the SAME
                     `SessionGroup[]` the flat arrangements return, already in reading order, with
                     `depth` and `path` on top — which is what lets `sessionRows`, `cardPages`,
                     `selectableIndexes`, the cursor, the row budget, the marked band and the search
                     keep working without knowing a tree exists. **The cascade is a VIEW, not a
                     grouping**: it was one of the groupings, so choosing "show me the directories"
                     cost every band on the screen. `groupSessions` takes a `cascade` flag and draws
                     the tree INSIDE each band (`cascadeInside`), which composes with every
                     dimension — the band says what the rows have in common, the cascade says where
                     each one is. Grouped BY project the cascade's root would repeat the band's own
                     name, so that one level is dropped; everywhere else the project IS new
                     information and stays. `tree` survives as a `SessionGroupingId` ONLY so a
                     stored preference still parses (migrated on read to `none` + cascade) and is
                     absent from `ARRANGEMENTS`; it may never become a DIMENSION, because a session
                     belongs to EVERY node on its path, so "filter to `packages`" and "the band
                     `packages`" could never agree, and `session-dimensions.test.ts` cross-checks
                     exactly that agreement for every id in there. **`treeGuides` is what makes it
                     read as a cascade**: `├─`/`└─` per branch and a `│` running down through every
                     row under a node that still has siblings — indentation alone leaves "which node
                     does this hang off" and "where does this branch end" to be inferred from a
                     column position. Only the SESSION guides are padded to one width (the rows are
                     a table); a heading steps right by its own depth, and padding it too started it
                     to the RIGHT of the branch hanging off it. Branches are measured against
                     `ControlSession.projectRoot` — the main checkout's PATH, from
                     `decideRepoFacts`, recorded at spawn — because deriving them by
                     string-matching the project's NAME against the cwd goes wrong wherever a
                     segment repeats along the path. **No `projectRoot` = no branch** (outside a
                     repository, or gone with nothing recorded; `GONE_PROJECT_KEY` is left intact)
                     and **a worktree outside the main checkout gets ONE branch named after its own
                     folder** — a relative path that cannot be established is never synthesised
    tabs/            Services (the cockpit — and the SETUP wizard, as a question in its detail
                     region), Sessions (+ SessionWizard), Dashboard, Logs,
                     Static (Help / Cheat sheet / Contribute)
  stubs/react-devtools-core/   REQUIRED for the binary build — see below
packages/tui/scripts/preview.tsx   dev tool: render ONE control-center frame to stdout at a chosen
                                   size/lang/mode, with `--keys` to drive it into a question first
                                   and `--task running|done` to stream a fake build into the pane
```
(`stubs/` sits at the package root, `packages/tui/stubs/`, not under `src/`.)

### Rules

- **`stubs/react-devtools-core` is load-bearing — never delete it.** Ink guards its devtools
  bridge behind `DEV=true` but reaches it through `await import('./devtools.js')`, whose
  top-level `import ... from 'react-devtools-core'` Bun's bundler resolves **statically**. Without
  the stub `bun run build:binary` fails outright. `--external` compiles and then dies at binary
  startup; `--define process.env.DEV='"false"'` does nothing, because resolution precedes
  dead-code elimination.
- **Verify TUI work against the COMPILED BINARY**, not just `bun run`. The devtools problem above
  is invisible under `bun run` and only appears at compile time.
- **Screens receive a `width` and must fit it.** `DataTable` drops columns from the right via
  `fitColumns` and `Overview` drops KPIs via `fitKpis`; declare columns most-important-first. A
  row wider than the terminal wraps and misaligns everything below it — the shell passes
  `columns - 2` because its Box has `paddingX={1}`.
- **The control center owns no logic.** `cli-start.ts` decides what the state is and performs
  every action behind the `ControlHost` interface; `packages/tui/src/control` renders and reports
  intents. `cli-ui.ts` stays as the non-TTY fallback — do not delete it.
- **Nothing may print while the alternate buffer is live.** An Ink frame erases the lines above
  itself, so a stray `process.stdout.write` lands in a buffer Ink is repainting. Host actions run
  under one of three wrappers, chosen by what the action SAYS: `captureOutput` (it prints a
  sentence — the last line becomes the status-line message), `streamOutput` (its output is the
  point — the child is spawned with BOTH pipes captured and every line is published on
  `ControlHost.onOutput`, which the cockpit draws into the detail region), or `suspend` (it asks a
  QUESTION, so it needs the real tty; `central.sh init` is the whole of that list). A child on a
  streamed path also gets NO stdin — Ink owns the keyboard — and the streamed paths carry no
  `tty()` / `pauseForEnter` call. Ink itself draws through `altScreen.writeFrame`, NOT
  `process.stdout.write`: a frame written through a capture vanishes (the screen freezes for the
  length of the action) and a frame written through the streaming diversion is fed into the pane
  that is drawing it — a pane full of its own borders. `writeFrame` is also what drops frames while
  a command is suspended, and it must stay a faithful `write`: Ink's teardown passes a callback and
  waits for it, so a gate that swallowed the callback turned `q` into a hang. The same ordering rule applies
  to teardown: **unmount Ink BEFORE leaving the buffer**. Restore first and Ink's own exit handler
  repaints the whole frame onto the primary screen, prefixed with a clear-scrollback — which is
  why signals route through `onAltScreenSignal` instead of `process.exit`.
- **A screen that overflows its `height` is composited, not clipped.** Ink draws the extra rows on
  top of the ones below, so a miscount reads as a corrupted frame. Budget against the `height`
  prop (`cockpitLayout`, `staticRows` and `setupRows` are the worked examples), keep
  `flexShrink={0}` on every screen's root Box — a Box that shrinks blends its rows instead of
  letting the parent cut them — and keep `overflowY="hidden"` on the body as the backstop.
  `Math.max(1, height - chrome)` is the shape of the bug, not the fix: it hands out a row that does
  not exist. Give up a PIECE the screen can afford to lose (the intro, a section header) instead.
- **A list that can outgrow its pane must scroll with `windowOffset`.** Slicing from zero leaves the
  cursor below the fold — invisible, and still the thing `enter` acts on. The config pane once ran
  the language toggle from a row nobody could see.
- **The services list is one row per LOGICAL service, and a runtime is not a service.**
  `agentistics` run natively and the same program in a container are `RuntimeId`s of ONE
  `ServiceId`, never two rows — listing them separately is what made the screen offer to start a
  Docker copy of a server that was already running. A running service therefore offers NO start at
  all (the host hands over an empty `startOptions`; the offer is unreachable rather than refused)
  and offers instead the `restartOptions` it composed — the plain bounce, plus a `Rebuild & restart`
  for each running runtime whose rebuild could actually work here (a repo checkout for `bun run
  bin`, a compose file for the machine image); a rebuild that cannot work is ABSENT, never present
  and failing. A stopped one keeps its row DIMMED, has no restart at all, and its action row becomes
  exactly the starts this box can perform. A service running under BOTH runtimes says so — `ControlService.conflict`, named on
  the row in `COLORS.danger` with a glyph and a word, spelled out in the detail pane, with
  per-runtime `Stop (native)` / `Stop (docker)` and `Rebuild & restart (native|docker)` verbs —
  "rebuild it" has no single meaning while the same program is running twice. Never normalise a conflict away by showing
  one of the two: they read the same files and fight over the same port. Under width pressure
  `serviceCells` gives up the NAME first, then the runtime cell, and the state WORD last — the word
  is the cell nothing else repeats, while the runtimes are said again by the detail pane's badge and
  by the conflict sentence that leads its facts. A row reduced to a coloured glyph is a conflict
  announced in colour alone, which is the one thing this model exists to prevent.
- **The Services screen is a cockpit, and its panes relate.** The services list is the selection;
  the detail pane is a view OF it, so moving the cursor repaints it. Actions are focus-scoped —
  with a service focused they act on THAT service (which is why there is no "stop which?" submenu),
  with the config pane focused they are the config ones. There are three focusable panes
  (`PANE_ORDER`: services → config → actions) and **no log pane**: logs belong to the Logs screen,
  and a tailing viewer squeezed into six rows was a worse copy of a full screen one keypress away.
- **A long action's output goes into the DETAIL region, and nothing else moves.** `docker compose up
  --build`, `central.sh up` and `bun run bin` stream into a pane titled with the VERB the user
  pressed, while the services list and the config pane stay standing beside it — the output is a view
  of what you acted on, so it has to be readable next to WHAT you acted on. It opens on the first
  line (a stop says one sentence and never takes the region), auto-follows the tail through
  `windowOffset` — slicing from zero would leave a build's live edge below the fold — keeps the
  output with its outcome when it finishes, and `esc` puts the facts back. While it is up it reports
  `capture`, exactly as a question does: the global keys stand down (a keypress must not act on a
  service the user cannot see), and `cockpitHints` names the only three keys that work.
- **The detail pane earns the height it has.** It states every RUNTIME the service could run under
  and the state of each — with the localized reason when one cannot be run here at all, which is
  the answer to "why does this offer me nothing" — the pid and uptime of the one that is serving,
  the web and api addresses, and, under a `MACHINE` rule, whether it starts at boot plus the archive
  mode and (in member mode) the endpoint. **Boot is `ControlService.boot?: 'on' | 'off'` and is
  ABSENT when the host cannot tell** (`parseBootState` maps only the words systemd actually prints;
  macOS/Windows are never asked), and an absent boot draws no row — the same N/A-versus-real-0 rule
  the dashboard applies to harness capabilities. `fitDetailLines` cuts from the bottom and then
  drops a trailing rule or blank, so a short pane never spends a row heading nothing.
- **The boot switch has TWO positions, and the row NAMES the unit.** `enableBoot` used to be the
  whole of it: the systemd user unit it wrote could be removed by nothing in the product, so a user
  who stopped their central because they were finished with it got it back on the next boot — and on
  the next login that reaches `default.target` — with nothing on screen naming what had brought it
  back. `ControlHost.disableBoot` is the other half, and it **never stops what is running**
  (`disableAutostart(mode, { stop: false })`; the older `agentop autostart <mode> disable` keeps its
  meaning and does both) — turning off "come back after a reboot" is a statement about the future,
  and the row already carries `Stop` two cells away. The verbs are `ControlService.bootOptions`,
  composed by the HOST because `agentistics` has TWO mechanisms (`agentop-server` runs the binary,
  `agentop-machine` runs `docker compose … up -d`) and a single flag could only ever act on one of
  them; `bootModeFor` is the one mapping both halves resolve through, so the switch can never turn
  one mechanism on and a different one off. **Exactly one option per mechanism** — a row offering
  both directions of one switch asks which of two facts about the same unit is true — and a
  mechanism whose unit could not be WRITTEN here (`serviceCommandFor` returns null: no `central.sh`,
  no compose file) is ABSENT, because a unit whose `ExecStart` cannot resolve is a service systemd
  restarts every five seconds forever. Off Linux the list is EMPTY. `ControlService.bootUnit` is the
  honest trail: "starts at boot" alone tells someone that SOMETHING will bring their central back
  and gives them nowhere to look, so the pane prints `starts at boot · agentop-central.service` and
  `agentop autostart status` prints the unit's `ExecStart` and the command that removes it. **A stop
  that worked ASKS about the boot registration** (`BootOption.confirmAfterStop`, a different
  sentence because the user did not press a boot verb to get there) — the moment of the stop is the
  only moment the person knows whether they are done with the service or bouncing it.
- **Setup is a QUESTION the cockpit asks, not a screen.** It was a tab; choosing solo / central /
  member is a question ABOUT these services — you cannot re-run `central.sh init` on a central that
  is up — so it is drawn in the detail region like every other question, reached from the config
  pane's mode row, and the whole flow it already owned (the three connect prompts, the archive
  consent, the boot offer) is the flow it routes into. **A mode that would reconfigure a RUNNING
  service is withheld with a SENTENCE**, never merely greyed: `ControlStatus.setupBlocked` is
  decided by the host, because only it knows what is running, and a disabled row that explains
  nothing is indistinguishable from a broken one. It is the same rule as the empty `startOptions` of
  a running service — the offer is unreachable rather than refused after the fact. `agentop setup`
  is untouched and stays the non-interactive twin; `initial.setup` (a flag, not a `TabId`) is what
  opens an unconfigured machine on the wizard. The row budget went with the screen: `setupRows` /
  `setupBodyTop` are deleted, and the question is budgeted by `cockpitLayout`'s `QUESTION_ROWS`.
- **Screens change with `←`/`→` and nothing else.** The tab bar is at the TOP, under the title, with
  an accent rule under the active cell (`tabUnderline`), so the reading order is title, where-am-I,
  content, keys. There are no digit shortcuts for screens: the numbered bottom strip is gone, and
  with it the double-booking that made `2` on the log viewer switch the source AND leave the screen.
  The digits belong to whatever list draws them (the log sources, a numbered `Menu`). `tab` /
  `shift+tab` cycle the cockpit's PANES, and the one claim left is `ScreenChrome.claimArrows`, taken
  by the action row because it is a horizontal list — the footer stops saying `←→ screens` for
  exactly as long as that is true, and `esc` is the way back out. A key answered by the screen AND by
  the shell does two things at once, which is the same class of bug as a footer hint for a key that
  does nothing.
- **The cockpit is a BAND over a full-width DETAIL pane, and no region may be dead.**
  `cockpitLayout` puts the services list beside the config pane in a band as tall as the taller of
  the two and no taller, and gives everything below it to the detail pane at the full terminal
  width — which is what stops its URLs and its reasons being truncated by a column that was never
  wide enough for them. The detail region is reserved BEFORE the band on a short terminal (it holds
  the verbs, and a question needs `QUESTION_ROWS`), so the config pane scrolls rather than the
  actions disappearing. Surplus width goes to the CONFIG pane, which can spend it: `fitValue` shows
  the mode sentence and the whole endpoint URL as soon as the column holds them whole. Air under a
  pane is a fault; air inside one is a pane.
- **The header is the block wordmark when the row can carry it, the compact mark when it cannot.**
  `headerLayout` derives the threshold from the MEASURED art (`WORDMARK_ART`) plus the MEASURED tag
  (`headerMetaWidth`), never a column count — the tag grows with the mode word, the version and the
  update dot. It is all-or-nothing: taking the art must not cost the version. The tag is
  right-aligned on the art's LAST line so the two share a baseline. The header's height is therefore
  NOT a constant, and `bodyHeight(rows, headerRows)` is what every screen's budget goes through.
- **The Logs screen's sources are DERIVED from `ControlStatus.services`, never a constant.**
  `logSources` returns one entry per LOGICAL service under the service's own already-localized
  label (`1 agentistics   2 agentistics central`), and expands a service into its running runtimes
  ONLY in the conflict case, where they genuinely are two different logs. The screen used to hold
  `['local', 'central', 'machine'] as const` and print those internal ids, so it offered the native
  process and the container of the same service as two things long after the model had merged them
  — the same class of bug CLAUDE.md forbids for a hardcoded harness list, failing the same way.
- **Every scrolling surface answers the same keys, through the same pure reducer.**
  `resolveScrollKey` (↑↓ / j k, page up/down, home/end and g/G) CLAMPS at the ends — a document is
  not a ring, unlike `resolveListKey`'s menus — and `resolveTailKey` layers the Logs screen's
  follow state on it, unpinning the tail on any movement. The static screens' positions live in the
  shell's `scroll` record and the Logs viewport in one `TailState`, so a driver that is not the
  keyboard has one setter per surface to call.
- **Every framed region goes through `Pane`.** One containment style is what makes six screens read
  as one application; the shell frames the non-cockpit screens itself so they cannot disagree about
  it. Pane titles are the SHORT lowercase names, the same words the tab bar prints.
- **The footer must describe the keys that work in the CURRENT focus.** `cockpitHints` is the only
  place that decides this, and a hint for a key that does nothing here is a bug, not a cosmetic
  issue — the footer is the only documentation this screen has.
- **Order footer hints most-important-first** — `footerHints` drops from the RIGHT, so `q quit`
  and the tab keys lead. A narrow terminal that hides how to leave strands the user in a buffer
  that hides their shell.
- **The sessions tab shows the WHOLE fleet, and says what it cannot know.** Sessions agentop
  started are attachable, killable and nameable; assistants running beside it (from `/proc`) are
  listed as `external` and carry NO state — nothing about them is capturable, so claiming one would
  be inventing it. A verb pressed on such a row refuses in a SENTENCE rather than doing nothing: a
  control that is silently inert is indistinguishable from a broken one. The waiting counter lives
  in the HEADER because it must be readable from every tab, and it outranks the version under width
  pressure — a version is one `agentop --version` away, a session waiting on you is why the app is
  open. The bell rings on the TRANSITION into waiting, never on the level.
- **`o` attaches, and attaching is a `ControlExit`, not an exec.** The Ink app unmounts,
  `cli-start.ts` gives the session the real tty, and `runStart` LOOPS — so detaching comes back to
  the sessions tab. `enter` opens the MENU instead, which is what made every other verb reachable.
  The detach key is read from the backend, carried on the fleet SNAPSHOT and stated on the row —
  printed once before the handover, it scrolled away under whatever the session drew next, and a
  user who cannot get out is stranded in a buffer that hides their shell. **The kill key is `x`,
  never `k`** — `k` is `up` in this list, and a key that navigates on one screen and destroys work
  on another is a real accident waiting to happen. **Pressing `o` on a row with nothing RUNNING
  asks whether to reopen that conversation** rather than refusing (external rows included): the
  row-specific verb is decided by what is running, not by whether agentop hosts the row, or a
  session whose backend died offers a button whose only outcome is an error.
- **A row that wants a person says so THREE ways, and the keys are named after what they do.**
  `waiting` is called **needs you** (`precisa de você`) — it and `working` differ by two letters in
  the middle of a narrow column, so the state that needs somebody was read as the one that does not
  — and every waiting row carries a coloured `●` in its own leading cell (`NOTIFY_CELL`,
  `sessionNotify`), which costs ZERO columns on a fleet where nothing is waiting and is drawn by
  BOTH renderers (the cockpit and `session ls`) out of the same measure. The dot never carries the
  message alone: the word is beside it. `COLORS.running` (#22c55e) is its own token rather than
  `success` (#10b981), which reads as teal on a terminal and sits within a hair of
  `HARNESS_COLOR.codex`. The verbs are **`n`** new, **`r`** rename, **`m`** note (memo — `t` belongs
  to the TASK), **`t`** task, **`T`** open the whole task, **`F`** finish it, **`a`** approve (`y`
  kept as the alias every yes/no prompt taught), **`c`** show what is not running (`l`/`e` aliases),
  **`C`** the last conversations flat and by recency, **`h`** the key reference. They were handed
  out in the order they were written — `a` started a session, `n` renamed one, `t` wrote a note — so
  the only way to learn one was to read the list.
- **The header's central pill is `● machine · account · Nms`, and only when there IS a central.**
  The dot is the one coloured thing in it and its STATE is the host's decision
  (`ControlStatus.linkState`, from `/api/team/status`'s `errKind` + `lastSuccessAt`): `unauthorized`
  and `offline` are red, `stale` is amber, `ok` is green. **`stale` is deliberately not red** — the
  central owns the push cadence, so a member that has not pushed recently has not failed at
  anything, and a warning that cries wolf is one people stop reading. Under width pressure the
  account and the latency go before the name, and the name before the dot.
- **The sessions cockpit is three framed panes and claims the ARROWS.** Menu, fleet, detail; the one
  holding the keyboard wears the accent border, and clicking the list focuses it too — a pointer
  that moves the selection without moving the focus leaves the frame saying one thing while the keys
  do another. `←`/`→` had no meaning inside the screen and every meaning outside it, so overshooting
  a list by one row left the screen entirely; `[` and `]` change tab ALWAYS, claim or no claim, and
  the active tab wears those brackets. Inside the menu the arrows step between SECTIONS, and `1`-`9`
  jump to one from either pane — a soft keyboard has no arrow keys at all, so the digits are the way
  in that always exists.
- **The menu FOLDS, and every section keeps its name.** `asideFold` is the one answer for every
  height: the section holding the cursor is a framed pane with all of its rows, the others open in
  reading order while they fit WHOLE, and what does not fit keeps its NAME on one row. Opening a
  section part-way was the middle ground and the worst of the three — a block cut to two rows says
  no more than its heading did. The leftover goes to the open section so the column ends flush with
  the list: air under a pane is a fault, air inside one is a pane.
- **`onlyActive` is the one switch that OVERRIDES the named-row rule**, and the only one on that
  block that narrows rather than widens — which is why it is listed first: a switch that appears to
  do nothing is one people conclude is broken. The named rule is right by default (it is what stops
  a reboot emptying the list), but on a machine with months of named work it shows all of it.
- **A row the user NAMED is never withheld by the history switches** (`sessionNamed`). A machine
  restart makes every managed session `lost`, and with those switches off — which is how they ship —
  the list came back EMPTY, taking the session you had renamed and filed under a task with it.
  `named` is its own flag rather than inferred from `title`, because `title` always has a value: the
  host derives one whenever there is no label.
- **The default arrangement is stated ONCE** (`DEFAULT_SESSION_VIEW`): ONLY ACTIVE conversations,
  grouped by project. It is strict, so when nothing is running it shows an empty list — and the
  screen must therefore say WHY and name the key that lifts it, since the `lost` rows behind it are
  still there and still reopenable. The reason is chosen by what actually emptied the list: blaming
  the filter while a search removed the rows sends someone to the wrong switch, and blaming a search
  while nothing is running at all would hide that the filter is on. The host's fallback, the screen's initial state and the `ctrl+r` reset all read it —
  three copies of a default is three chances for the app to open on one arrangement and reset to
  another. It is persisted by the HOST (`setSessionView`), and **nothing is written before the
  restore has happened**: `sessionViewPref` always answers, so an absent `view` means "not loaded
  yet" and nothing else. It used to mean both that and "never chosen", so every remount — which is
  what detaching is — wrote the defaults a moment before the stored arrangement arrived.
- **Every column is measured against the CONTENT width, headings included.** `sessionColumns` and
  `projectColumns` size each column to the widest row ON SCREEN and to its own heading — a heading
  wider than its column is truncated, and a truncated heading sits over a cell it no longer names.
  A cell nothing on screen carries is ZERO and costs no gap. Measuring against the pane rather than
  its body made every column four characters too wide, and the table survived only because Ink
  truncated it.
- **The CARD layout is the same rows in another shape, and a card names every fact it carries.**
  `cardPages` walks the very `SessionRow[]` the list draws, so what a group is called, which ones
  are muted and where the history section begins are decided ONCE, in `sessionRows`. A band belongs
  to one GROUP — the air to the right of a one-card group is what separates it from the next, not
  waste, and filling it with the following group's cards is how the grid used to ignore the
  grouping it was drawn under. A heading is never placed without a row of cards under it, and a
  group crossing a page break REPEATS its name (within a page it is said once — it is a band or two
  above and plainly governs what follows). Each group is named exactly ONCE per card: by the band's
  heading when there is one, and otherwise by the card's own frame title, with the session HANDLE
  moving to the badge — cut to `paneTitleRoom`, because `paneTop` drops a badge whole rather than
  truncate a title and the handle is the prefix `agentop session attach 3f5f` resolves. A fact whose
  value IS that name is dropped from the card, the same rule `sessionColumns` applies to its `task`
  cell while grouping by task. The facts a reader cannot name from the value alone — the folder, the
  model, the task, the note — carry a LABEL, in the words `sessionsCols` already prints over the
  list's columns; the labels are aligned in one column and given up ALL AT ONCE
  (`cardLabelWidth`), because labels that come and go leave the values starting at different
  columns. And a card is never taller than it has content for: `cardGrid` takes the line count the
  screen measured and each BAND is then sized to its own tallest card, because one height for the
  whole grid is the height of the richest card in the fleet — one session carrying a model, a task
  and a note made every other card two rows taller than it had anything to put in them, and rows of
  blank inside a frame are a box with a name in it. The band and not the card: cards of one band
  stand side by side, and giving each its own height leaves the row's bottom edge ragged, which is
  worse to look at than the one blank line a short card beside a rich one still keeps. The rows a
  short band gives back become another band on the page, not air under the pager. And a band's cost
  is its cards PLUS the name over them, so `cardGrid` is told whether headings will be drawn and
  charges that row to EVERY band — sizing as though a band were only its cards measured the ceiling
  for a region that then had to pay a row per band out of the very same rows, and the grouped grid
  paged four times over. The trade it makes is one line of card for another group on the page.
- **`stats-cache.json` stays Claude-only here too.** `selectors.ts` reads Claude totals from the
  cache and every other harness from per-session sums; `applyHarnessFilter` blanks the cache when
  a non-Claude harness is selected, or Claude's numbers would survive the filter.
- **Capability-gated metrics render `N/A`** (`HARNESS_CAPABILITIES`), never a confident `0`.
- **The TUI does not read preferences.** The dependency direction is `server -> tui`: `cli.ts`
  resolves the language via `server/cli-lang.ts` and passes it in. **`runStart`'s loop must pass
  `host.lang`, never the value it resolved at boot** — the language is a closure variable the in-app
  toggle reassigns, so attaching to a session and detaching remounted the whole cockpit in the
  previous language, with nothing on screen to explain it and nothing to do but restart.

## VS Code extension (`packages/vscode`)

The fourth front door onto the fleet, after the CLI, the cockpit and the web dashboard. See
`docs/vscode-extension.md`.

```
packages/vscode/src/
  extension.ts   activation + wiring, nothing else
  api.ts         the ONE process that talks HTTP; every method total
  sessions.ts    SessionsHub: one poll, any number of surfaces, performs every action
  streams.ts     one live screen per session (SSE), shared by every surface watching it
  panels.ts      the editor tabs — one per session, keyed so asking twice REVEALS
  ansi.ts        PURE: one terminal frame → HTML, in the dashboard's own palette
  protocol.ts    the wire shapes (host <-> webview, and the server's answers)
  view-model.ts  PURE: grouping, ordering, search, the three empty states
  attention.ts   PURE: which sessions have just started needing a person
  today.ts       PURE: today's totals + the day rule they use
  config.ts      PURE: the two endpoints, the second derived from the first
  i18n.ts        the extension's OWN chrome words, EN/PT — nothing about a session
  terminal.ts    attach (a real integrated terminal) + starting the server
  status-bar.ts  today, and the waiting count
  webview/html.ts  PURE: the CSP'd documents and the escaping
  webview/main.ts  the panel — DOM calls only
```

### Rules

- **It is a CLIENT of `agentop server` and never anything more.** It must not read
  `~/.agentistics`, talk to tmux, or import `server/sessions/*`. A second process
  read-modify-writing `managed-sessions.json` beside the running server is the registry race
  `registry.ts` documents — a record written by a short-lived process observed ERASED by a
  longer-lived one, leaving a user in a session no verb could name.
- **It holds no rule about what a session may take.** Every `enabled` flag, verb label and refusal
  sentence arrives already decided from `/api/fleet`, which resolves them through the same
  `sessionActions` the cockpit resolves every keypress against. The two exceptions are IMPORTED,
  not restated: `sessionRank` (`@agentistics/tui/control/session-order`) and `sessionRunning`
  (`.../session-dimensions`), both widened to `Pick<ControlSession, 'state'>` precisely so a client
  holding the reduced `FleetRow` can call them.
- **`approve` is an OPTION LIST, never a button.** The server reads the options off the live frame;
  the panel lists them and sends the picked NUMBER. A single "approve" takes whichever row is
  highlighted, which on "only my fix / promote everything / stop here" is choosing for someone.
- **The webview never fetches, and never uses `innerHTML`.** Its `localhost` is the BROWSER's — in a
  Remote-SSH window that is not the machine the sessions are on — so the extension host asks. And
  every string on the panel is a session title, a note, a path or a line captured off a terminal: a
  template literal is one unescaped `<` away from executing it. DOM calls only.
- **The bell rings on the TRANSITION, never on the level**, and the FIRST poll announces nothing —
  a machine with nine blocked sessions would greet the user with nine toasts. Only
  `waiting-approval` raises a toast; plain `waiting` is where every turn ends, so a toast on it is a
  toast per turn. It still counts toward the badge.
- **An unreachable server prints a sentence, never a zero.** `down` (nothing answered), `refused`
  (a central, or a profile with no host power) and a real empty fleet are three different facts and
  keep three different sentences — the same N/A-versus-a-confident-0 rule the dashboard applies to
  harness capabilities.
- **The status bar's day is the UTC one** (`start_time.slice(0,10)`), matching the dashboard's own
  date presets, and is summed PER SESSION — `stats-cache.json` is Claude-only and today's sessions
  are all still on disk for every harness. Tokens is all four counters.
- **`/api/data` gets its own slow timer** (default 300s). It is megabytes; the fleet poll is 5s and
  a few kilobytes. Polling the large one at the small one's rate spends a megabyte a minute to move
  a figure that changes once a turn.
- **New server routes ride the `/api/fleet` PREFIX in `capability-guard.ts`.** It is a prefix and
  not a list of names so the next fleet route is guarded by having been ADDED, never by having
  remembered a second table; `capability-guard.test.ts` asserts a not-yet-written path resolves to
  `localShell`. `POST /api/fleet/new` is the one fleet call that takes a DIRECTORY from the body
  (`resume` refuses to, and says why) — `fleet-spawn.ts` is the pure reader, and it REFUSES rather
  than repairs: a relative path resolves against the server's own cwd, an effort outside the CLI's
  closed enum is a usage error nobody sees, and a model asked for on a harness with no model flag
  would start a session that is not the one requested.
- **`GET /api/fleet/attach` checks SCOPE before answering.** `attachSession` composes the command
  from whatever id it is given, so an unknown id came back as a well-formed ticket for nothing and
  the client opened a terminal that printed `no such session` and sat there.
- **The cascade is deliberately absent.** It is measured against `ControlSession.projectRoot`, which
  is not on the wire; a tree derived client-side by matching the project NAME against each `cwd`
  goes wrong wherever a path segment repeats. A band per project plus the shortened directory is the
  honest subset.
- **TWO views, one document.** `list` is the fleet; `session` is one session's live screen, composer
  and verbs. The sidebar walks between them (a 300px column cannot hold both); an editor TAB is
  created PINNED to one session and never shows the list, which is what makes "several at once"
  mean anything. Tabs are keyed by session id — asking twice REVEALS the one that exists — and are
  titled with what the session is CALLED, because a tab strip of `3f5f21a8b0c1` is unusable.
- **The HOST opens the terminal stream, never the webview** — a webview's `localhost` is the editor
  client's, which under Remote-SSH/WSL is not the machine the sessions run on. One connection per
  session shared by every watching surface (the server's own model), and **watching is tied to the
  route**: capture is viewer-gated, so a surface that forgets to unwatch leaves a `capture-pane`
  loop running for a screen nobody can see.
- **The terminal's phase machine, its honesty line and the composer are IMPORTED from the dashboard**
  (`packages/web/src/lib/terminalStream.ts` / `terminalInput.ts`, both dependency-free). A second
  copy would be a second set of honesty rules, and "this screen is live" is the one thing this
  feature may never be wrong about. Rendering is the pure `ansi.ts`, not xterm — `capture-pane` has
  already resolved the redraws, so what is left is colour — but the PALETTE is the dashboard's own
  `xtermTheme`, so one session reads the same in both places.
- **The panel wears the DASHBOARD's palette**, not VS Code chrome, and follows
  `activeColorTheme` for dark/light (the ANSI palette with it). A panel that looks like a different
  product from the dashboard beside it is a different product as far as the eye is concerned.
- **You type into the SCREEN, not into a text field**, over the WS write channel at
  `/api/fleet/input` (`input-protocol.ts` / `input-channel.ts` / `input-web.ts`, Phase 2b). One
  socket per session, FIFO by construction, one ack per keystroke. The extension briefly shipped an
  HTTP `POST` of the same name and it is GONE — two write channels for one act is the duplication
  this repo is built against, and the socket wins on both counts (ordering is the transport's, and a
  keystroke that did not land is a fact rather than a silence). `input.ts` keeps a copy of the key
  allowlist so the client does not ASK for what will be refused — a modifier press or a media key
  would otherwise cost the user an ack failure for a key nobody meant to send — and the server
  validates membership regardless. FOCUS is the consent gate (every terminal works that way) and the
  strip under the screen says which state you are in; `ctrl+shift+*` and Cmd/Win are never swallowed,
  or the editor stops working inside the panel. A delivered keystroke NUDGES the read channel, or the
  character waits out a capture interval tuned for watching rather than typing.
- **The status bar can price in BRL** (`agentistics.currency`), through `@agentistics/core`'s own
  `fmtCost` and the rate `/api/rates` already caches — the same rate and formatter the dashboard
  uses, so the two can never disagree about one day. No rate means DOLLARS, never a converted figure
  invented from a guess.

## What each surface is CALLED

Four front doors, and a person saying "the sessions screen" has to land on exactly one of them.
These are the names to use in conversation, in commits and in comments; they are not
interchangeable.

- **the Sessions workspace** — the WEB one: `/sessions`, the aside with the fleet on the left and
  the centre holding either the overview (`FleetOverview`) or the open session's chat and terminal.
  On a central it is the same workspace, showing the relayed fleet of the machine its picker has
  chosen. When someone says "a interface de sessões", "a tela de sessões" or "the sessions view",
  this is it.
- **the cockpit** — the TERMINAL one: `agentop`'s control center (`packages/tui/src/control`), whose
  own `sessions` tab draws the fleet. Never call the web one a cockpit; the ambiguity is the whole
  reason this list exists.
- **the VS Code extension** — `packages/vscode`, a client of `agentop server` and nothing more.
- **`agentop session …`** — the CLI verbs.

The FLEET is what all four show: the live sessions plus the conversations that can be reopened. A
"session" is one conversation; the "fleet" is the set.

## Accessibility magnifiers (`packages/web/src/components/a11y/`)

Lenses a low-vision user places over the dashboard. Full write-up in
[docs/accessibility-magnifiers.md](docs/accessibility-magnifiers.md); these are the invariants a
harness must not break.

- **The lens layer is a SIBLING of `#root`.** Each lens mirrors `#root`, so a layer inside it would
  clone itself forever. The recursion is structurally impossible, not guarded against — never move
  the container into the React tree.
- **The mirror is a PICTURE**: a `cloneNode` of `#root`, `inert` + `aria-hidden` +
  `pointer-events: none`, ids and names stripped. A live second copy would duplicate ids, focus and
  side effects, and a screen reader would hear the page twice. `cloneNode` drops scroll positions,
  form state and canvas pixels, so `reconcile` walks both trees in step and copies them. **A canvas
  that cannot be copied is CLEARED, never left stale** — an empty region the settings screen warned
  about is recoverable, a stale one that looks live is not.
- **The clone is offset by `-scroll` and stays `position: relative`.** The offset makes stage-local
  coordinates equal viewport coordinates, which all the geometry assumes; `relative` is the one
  position value that does NOT become a containing block for `position: fixed` descendants, so the
  cloned sidebar and modals still resolve against the stage.
- **`position: sticky` is moved with `transform`, NEVER with `position`.** Sticky is IN FLOW;
  changing it to `fixed`/`absolute` removes it and everything around it collapses. That shipped
  once and corrupted the mirror on every page, because this app's header is sticky everywhere. A
  transform is paint-only and cannot affect layout. Only WINDOW-scrolled stickies are moved at all —
  one inside an `overflow: auto` panel already reproduces correctly and is left alone.
- **A sticky copy's transform is MEASURED every scroll frame, never extrapolated** (`stickyOffset`,
  pure). The copy never engages inside the clone, so it paints at `flow − scroll` and the correction
  is `live − (flow − scroll)`. Carrying the last sync's correction forward by the scroll delta
  instead holds the copy still on screen: right while the element is STUCK, wrong the whole time it
  is not — an unstuck sticky flows with the page and its copy froze where the last sync left it. The
  live reads are shared across every lens by one cache `applyScroll` passes into each
  `setScroll`, or N lenses cost N forced layouts per frame instead of one.
- **Left click, wheel and hover go to the PAGE; right click goes to the LENS.** That is why a pinned
  lens is still reachable: right click opens its menu in every pin state, which is where unpin and
  remove live. Pinned means immovable, not unreachable.
- **A pinned lens is revealed by the KEYBOARD and never by the pointer** (`lensInteractive`, pure).
  Every pointer path selects, so revealing on SELECTION meant the one gesture a mouse has for
  reaching a pinned lens's menu also gave back its drag handle — the next drag moved a lens pinned
  precisely so it would stop moving. `Tab`/`Ctrl+Shift+M` keep their reveal, because keyboard is the
  only way a pinned lens is reachable at all. The reveal follows the SOURCE of the selection
  (`A11yState.selectedVia`), never the selection itself.
- **Interaction is forwarded by COORDINATE** (`lensPointToPage`, the exact inverse of the rendering
  geometry), never by making the clone live. The probe that finds the target must make the WHOLE
  magnifier layer transparent to hit-testing first — with two lenses stacked, hiding only the top
  one hands the click to the one beneath it.
- **`sourceRect` has two anchors and they are not interchangeable.** `'pan'` for a PLACED lens: the
  region pans proportionally to the lens's position, which is what makes the page's outer band
  reachable (a centred region plus an on-screen-clamped lens leaves a ~150px dead band at 4×); it
  agrees exactly with the old centred rule at the viewport's centre. `'cursor'` for the FOLLOW lens:
  centred on the pointer and NOT clamped, because its position IS the pointer and a pointer must
  show what is under it or aiming becomes impossible. The clamp is gone on purpose: this lens is
  never kept on screen, so sliding the region back inside the viewport while its frame stayed
  half-off painted the page's outer band where nobody can see it — the same dead band `'pan'`
  removes, reached by a different route.
- **There is no cap on the number of lenses** — the cost is bounded by `mirrorSchedule.ts` instead:
  two re-clones per frame, least-recently-synced first, off-screen never, with a backoff when a
  measured cycle overruns. Twenty lenses cost ten frames, not one frame of twenty clones.
- **`/api/preferences` could NOT be reused for these settings**: it is per MACHINE, and on a central
  that file is shared by every signed-in user, so one person's lenses would appear on everyone's
  screen. `a11y-prefs.ts` is the single place that picks the machine file or the per-account
  `userPrefs` document; a central session with no account reads defaults and is refused on write,
  and must NEVER fall back to the machine file.
- **A PUT replaces the whole `accessibility` value** so the last lens of a page can be deleted, and
  that rests on `writePreferences` staying a shallow merge across preference KEYS. Pinned by
  `a11y-persistence.test.ts`.
- **Saving is armed only by a genuinely successful load.** A central answers 401 until login and the
  hook mounts before it; treating that 401 as an empty document once armed a save that replaced the
  account's stored lenses with defaults.
- The border is always `var(--anthropic-orange)`, in every state and both themes. There is no colour
  option, and the settings screen says so rather than leaving a missing picker to read as an
  oversight.

## Important rules

- **Anything agentop writes OUTSIDE its own directories is an explicit act of the user, and is
  exactly reversible.** `~/.bashrc` and `~/.zshrc` (`autostart.ts`), `~/.claude/settings.json` and
  `~/.claude/skills/` (`cli-hooks.ts`): each is written only behind a command the user typed, never
  as a side effect of installing or configuring agentop, which may only ever SUGGEST it. Those files
  hold other people's configuration, so the write is a MERGE that preserves every key it did not
  author, a document it cannot merge into is REFUSED rather than repaired, running it twice changes
  nothing, and the uninstall removes exactly what the install wrote — including the containers that
  existed only to hold it. If the target tool is not installed at all, the command says so and
  creates neither directory nor file.
- **EVERY new screen and EVERY layout fix MUST also deliver its mobile version — no exceptions.**
  A change is not done when it looks right at 1440px. Before calling any UI work complete:
  - Build the mobile branch *in the same change*, not as a follow-up. A "we'll do mobile later" pass
    is how the whole governance area shipped desktop-only and needed the C4 rescue.
  - Follow the existing conventions rather than inventing new ones — `useIsMobile()` (768px),
    `MobileBottomNav` + the "More" sheet, full-screen drawers/modals, the `.ag-grid cols-N` utility,
    tables collapsing into `RecordCard` lists, `MultiPicker`/`Select` popovers that flip up.
  - **Touch targets ≥ 44px on mobile** — and 44px is the *mobile* number: applying it on desktop
    too turns a segmented control into a row of buttons.
  - **Any `<input>` visible on mobile computes to ≥ 16px** or iOS Safari zooms the viewport and
    breaks the sticky header. `index.css` has a global guard; do not override it with an inline
    `font-size` on the field.
  - **Verify at 390px, do not assume**: `document.documentElement.scrollWidth <= window.innerWidth`
    must hold on every page. Wide tables and code blocks scroll inside their own container, never
    the page body.
  - New pages need their nav entry in **both** the desktop `SideNav` `items` array **and** the
    `MobileBottomNav` `navTiles` array in `App.tsx` — adding only the first hides the page on a phone.
- **A tag may be pinned to a PERIOD** (`TagDoc.window`, inclusive `yyyy-MM-dd`, each end independently
  optional) — that is what makes a tag answer "I ran harness X on this project from the 4th to the
  18th; what did it cost?" instead of only "these sources, all time". It is an AND on top of the
  source union, so like `filters` it can only ever narrow. Two rules:
  **(a) the day rule is `tagSessionDay` (`start_time.slice(0,10)`)**, the same one `tags-detail.ts`
  uses for the daily series — a local-clock day would be more correct in isolation and wrong here,
  since at UTC-3 a 23:00 session would sit inside the window while being plotted on the next day's
  bar of the tag's own chart; **(b) `packages/web/src/lib/tagMatch.ts` mirrors the rule by hand**
  (the web bundle cannot import `packages/server/*`), so the window must land in BOTH or the tag's
  card and the tag FILTER disagree — `tagMatch.test.ts` has a cross-check that fails when only one
  side is updated. Because the period is per tag, `makeTagFilter` evaluates tag by tag; the old
  flattened source union cannot express it.
- **Tags are aggregate-only and explicitly shared** — a tag's visibility is the explicit `sharedWith` account list (plus its creator and every owner) and is **never** derived from teams; **anyone signed in may create a tag** — the role difference is REACH, not permission: writing requires that the principal can already see **every** one of its sources (`canWriteTagSources`, re-checked on edit), so an owner reaches anything, a manager what their teams reach, and a plain user only what their own account owns, otherwise a tag becomes a privilege-escalation path; and tag responses return **only counts and sums** — never session rows, transcripts or agent metrics — with keys the viewer cannot see collapsed into an "other" bucket. Tag math runs server-side against the unscoped session set, per-session (never from `stats-cache.json`).
- **A team is a SCOPE KEY, never a label — and an account may have none.** `canCreateAccount` /
  `canDeleteAccount` / `accountVisibleTo` / `teamVisibleTo` (`iam-view.ts`) all read memberships,
  and **being in a team IS seeing it** — there is no separate view grant. Consequences:
  - **An owner may create an account with NO team**; a manager may not. For the manager the
    requirement is the boundary itself: an account placed outside their teams is one they created
    and cannot then see or manage. The rule is stated ONCE, in `canCreateAccountWith`
    (`@agentistics/core/iam.ts`) — `iam-view.ts` delegates to it and the create form
    (`web/src/pages/settings/accountForm.ts`) calls the same function, with a cross-check test,
    because the browser copy had drifted stricter than the server and refused an owner something
    the server always allowed. A teamless account is invisible to and unmanageable by every
    manager (owner-administered only); the form says so as a **hint** and never blocks.
  - **There is deliberately NO team everybody joins.** A universal team was considered and
    rejected: it would make every user see the team and its roster, make any manager of it manage
    the whole company, and make any tag shared with it shared with everyone. Do not reintroduce one.
  - **First boot creates ONE team named after `TEAM_ORG`, and creates it EMPTY** (`org-team.ts`'s
    pure `planOrgTeam` decides; `createOrgTeam` in `teams.ts` does the IO, audited as
    `team.create`). Nobody is auto-joined — creating the team is the convenience, populating it is
    what would rebuild the universal team above. Nothing is created for the literal placeholder org
    `default` (the same `isNamedOrg` from `@agentistics/core/org.ts` the connection card's title
    uses), and nothing is created when the central already has any team, which is what makes it
    idempotent across reboots. **It never auto-renames**: the guard is "does ANY team exist", not
    "a team by this name", so changing the org config later leaves the team as it is. The
    `TeamDoc.orgTeam` mark is provenance only — the account form pre-selects that team, and
    pre-selected is not forced (the row is removable, and clearing it yields a teamless account).
- **A date is NEVER stored as a string in Mongo.** Every persisted timestamp is a BSON `Date`;
  the WIRE shape stays an ISO string (JSON has no date type and the frontend does `parseISO`), so
  the conversion lives at the persistence boundary and nowhere else — `mongo-dates.ts`. Rules:
  - Doc types (`TeamSessionDoc`, `TokenDoc`, `AccountDoc`, `TeamDoc`, `TagDoc`, `RepoDoc`,
    `BootstrapDoc`, `TeamWorkflowDoc`, memberStats) declare `Date`; the API types they map to
    (`MemberInfo`, `MachineInfo`, `RepoInfo`, `PublicAccount`, `SessionMeta`, `WorkflowRun`)
    declare `string`. Write with `new Date()`, never `new Date().toISOString()`.
  - **Reads must tolerate both shapes** — always go through `fromBsonDate`. A doc written by an
    older central in a mixed-version fleet still holds a string, and rendering it as
    "Invalid Date" is a regression the type checker cannot catch.
  - **`''` is not a date.** An adapter that could not read a start time reports `''`; it is stored
    as `null` and reads back as `''`. Storing `''` as a pseudo-date is the bug this replaced.
  - **Add every new timestamp field to `DATE_FIELDS`** and bump `DATE_MIGRATION_VERSION`, or it
    stays a string in the database forever while the writing code looks perfectly correct.
  - Date-shaped map KEYS (`statsCache.dailyTokens`'s `YYYY-MM-DD`) stay strings — a BSON key must
    be one. So do the local JSON stores (`tags-local-store.ts`, `preferences.ts`,
    `~/.agentistics/sessions/*.json`), where ISO strings are the correct representation; the local
    tag store revives them into `Date`s on read so the shared `TagDoc` contract holds in memory.
- **`stats-cache.json` is Claude-only** — never aggregate non-Claude harness metrics from it; use per-session sums for all other harnesses (see "Multi-harness tracking" above)
- **Harness adapters are modules, not packages** — all adapters live under `packages/server/server/adapters/`; never create a separate package per harness
- **`stats-cache.json`** has no project-level granularity — project filters are computed by summing individual sessions
- **Tokens per model/day**: `dailyModelTokens` only stores totals; input/output split uses global statsCache proportions as an approximation when filtering by date
- **Sessions have an optional `model` field** — extracted from the JSONL file by `server/data.ts` when not already present in session-meta. Use `blendedCostPerToken` as fallback when `model` is unknown (e.g. per-session cost column in PDF export)
- **Sessions have an optional `title` field** — the Claude-generated session title, parsed from the transcript's `ai-title` line (or legacy `summary`) by `server/jsonl.ts`. The UI displays it via the shared `sessionLabel()` helper (`@agentistics/core`), which falls back to `first_prompt` with `<local-command-caveat>`/`<command-name>` wrappers stripped — never render `first_prompt` raw as a title
- **Agent metrics** are only available for sessions whose JSONL files are accessible; `_source: 'meta'`-only sessions won't have them
- **Streak**: counts backwards from today; if today has no activity, starts from yesterday — intentional behavior so users are not penalized for not having worked yet today
- **BRL costs**: conversion via `/api/rates` (fetches live exchange rate); falls back to a fixed rate if the API fails
- **Session sources**: `_source: 'meta'` sessions are the most complete; `'jsonl'` and `'subdir'` are fallbacks with partial data (no git line counts, no cache tokens)
- **Binary mode**: `agentop server` sets `SERVE_STATIC=1`; `index.ts` then binds **two ports with one shared request handler** — `PORT` (47291) is the api + mcp endpoint, `WEB_PORT` (47292) serves the web dashboard (the URL you open). Same handler → the SPA on 47292 makes same-origin `/api/*` calls that resolve locally, so 91 stays api+mcp and 92 is the dashboard. The startup log lists `web` (92) above `api` (91)
- **Machine in Docker**: `docker/machine.yml` runs a solo/member machine in a container — reuses the central image (minus Mongo/central mode), mounts the host harness dirs read-only + `~/.agentistics` read-write, host networking. Offered as the `docker` option in the control center's Services tab. Run the machine in Docker **or** natively, never both
- **Live sessions are host-process detection, and every layer must stay honest about it.**
  `live-sessions.ts` reads `/proc` on the machine serving the request; a central never does this
  for members (it has no visibility into them) — members report their own snapshot over the
  reverse-channel WebSocket, filtered by that connection's sharing rules exactly like their
  metrics, so **a repository a member withholds does not appear on the central either**. Rules:
  - **A process cwd is matched against `sessionAtCwd`, which accepts EITHER `current_cwd` or
    `project_path` — never `sessionCwd()`.** The two disagree precisely in the worktree case this
    repo mandates: `claude` is launched at the repo root and its kernel cwd stays there, while the
    session records the worktree as `current_cwd`. Matching the more specific one alone matched
    NEITHER end and reported every session closed. It stays EXACT on both paths — a prefix test
    would let a process in `$HOME` claim every session on the machine.
  - **An empty list is never rendered as a zero when detection is impossible.** `scanProcesses`
    returns a `LiveUnavailableReason` (not Linux, no `/proc`, a container that cannot see the host,
    one whose uid cannot read a host cwd, or the capability being off) and `liveEmptyNotice`
    (`web/src/lib/sessionLive.ts`, pure, EN+PT) is the ONE place that turns it into a sentence —
    the same N/A-versus-a-confident-0 rule `HARNESS_CAPABILITIES` applies to metrics.
  - **A container needs `pid: host` AND the host user's uid.** `pid: host` alone yields the process
    list but `/proc/<pid>/cwd` is ptrace-gated, and the image runs as uid 10001 while the
    assistants run as the host user. `docker/machine.yml` sets `pid: host` and documents
    the `user:` line as a deliberate opt-in that trades the hardening for the feature.
    `docker/central.yml` (the central) deliberately has NO `pid: host` — its own processes are not
    what anyone is asking about.
  - **The /proc read is gated by `CAPS.localProcesses` inside the handler** (`readLocalLiveSnapshot`
    in `index.ts`), NOT by registering the path in `capability-guard.ts`: `/api/live-sessions` also
    carries the members' self-reported snapshots on a central, and a blanket 403 would take the
    central's "Open now" down with the host read. `capability-guard.test.ts` pins that exemption
    and asserts the module has exactly one import site.
- **`packages/server/server/embedded-dist.generated.ts`** is in `.gitignore` — auto-generated, never commit it
- **`packages/server/` modules** are server-only — never import them from `packages/web/src/` (Vite would try to bundle them and fail on Node/Bun APIs)
- **`@agentistics/core`** is the shared package — import types, pricing, and formatters from there; never duplicate them inline
- **Custom layout persistence**: `useCustomLayout` saves `{ layouts, activeLayout, pinnedProjects }` to `/api/preferences`. Layouts open **locked** by default; edit mode requires clicking "Edit". When all layouts are deleted, `active` is `''` (empty string) — CustomPage shows an empty state in this case
- **`componentCatalog.tsx`** is the single source of truth for what can be placed on the custom page — every component has a `render(ctx: AppContext)` function; to add a new component, add it there
- **`app-context.ts`** defines `AppContext` — the shape of the outlet context passed from `App.tsx` to all pages via `useOutletContext<AppContext>()`. Add new global state here when it must be accessible from any page or from custom layout components
- **`format.ts`** contains shared display helpers (`fmt`, `fmtCost`, `fmtDuration`, `fmtFull`) — never duplicate these inline
- **`chatSounds.ts`** (`packages/web/src/lib/chatSounds.ts`) defines `CHAT_SOUNDS` (5 sounds: ping, chime, soft, bell, pop), all synthesized via Web Audio API — no audio files needed. `chatSoundId` preference is wired through App.tsx → TtyChat.tsx
- **`PreferencesModal.tsx`** is the single Settings modal — it replaced 3 separate modals with one tabbed interface (Preferences / Live / Install / Environment tabs). Do not add separate settings modals.
- **Per-harness pages live at `/h/:harness`** via the generic `HarnessPage` — never create one page per harness. Harness data-source info is shown via the page's "Data & sources" tab (powered by `HarnessInfoPanel` + `HARNESS_INFO` in `lib/harness.ts`); do not add per-harness info icons or modals elsewhere.
- **A harness appears in the selector and Compare page** only when `AppData.harnesses` includes it (i.e., it contributes at least one real session). Gemini bootstrap-only stub files do not count.
- **PWA**: `vite-plugin-pwa` is configured in `packages/web/vite.config.ts` with `devOptions: { enabled: true }`. Icons are in `packages/web/public/icons/`. The Install tab in PreferencesModal handles both web PWA install and desktop app download.
- **A central installs as its own app** — same bundle, so the identity has to be applied when the
  files are SERVED, not at build time (`TEAM_CENTRAL` is a runtime mode). `serveStatic` runs
  `centralManifest()` / `centralHtml()` from `central-branding.ts` (pure, total — bad input is
  returned untouched) over `/manifest.webmanifest` and `/index.html`, swapping in the **teal**
  icon set, the name "Agentistics Central" and the teal `theme_color`. Regenerate the teal assets
  with `packages/web/scripts/gen-central-icons.py` if the artwork changes — hue, not a badge: at
  32px in a dock a corner badge is invisible. Both files are served `no-store`; **the app shell
  must never get the year-long immutable cache** the hashed assets get, or a rebuild is pinned to
  its old bundle. Anything the server rewrites must also be embedded as TEXT — `.webmanifest` was
  missing from `embed-dist.ts`'s `TEXT_EXTS`, arrived base64 and skipped the rewrite in silence.
- **Mobile / responsive UI** — the whole dashboard is responsive; gate mobile-only branches on the `useIsMobile()` hook (`packages/web/src/hooks/useIsMobile.ts`, `MOBILE_BREAKPOINT = 768`). Conventions:
  - **Sticky header** holds everything needed for interaction. On mobile the header shows only the logo; the lang/theme/export/settings/health/live/refresh controls are **not** in the top row — they live in the bottom-nav "More" sheet (see below). Desktop keeps the full action row.
  - **`MobileBottomNav`** (in `App.tsx`) is the only mobile chrome: 4 primary tabs (Home/Costs/Projects/Tools) + a **"More" bottom sheet rendered as a 3-column grid of square tiles** (Custom / Export / Compare when >1 harness, plus the moved actions: Live toggle w/ interval badge, Refresh, Settings, Warnings w/ issue count). The More button shows a dot when health warnings exist. The sheet slides in via a `transform` transition. Do not move these actions back into the top header on mobile, and keep the tiles compact (no square `aspect-ratio`).
  - **Collapsible filter bar**: on mobile the full `FiltersBar` (harness chips + date/projects/models) sits in the sticky header and can be minimized to a slim "Filters" row (with an active-filter count badge) via `filtersCollapsed`. The open/close is animated with a `grid-template-rows: 0fr↔1fr` transition. The animation wrapper needs `overflow: hidden`, which would clip the Models popover — so it's only clipped while animating/collapsed (`filtersClip` + `onTransitionEnd`), then switches to `visible`.
  - **`FiltersBar` `compact` prop** (used on mobile): hides the vestigial vertical dividers and tightens padding. On mobile the controls also stretch to fill each row (date presets `flex:1`, custom range full-width, the ＋ Filtro button full-width).
  - **`FiltersBar` "＋ Filtro" model**: the top bar shows only the date presets + custom range + a single dashed **＋ Filtro** button (with an active-dimension count badge). It opens a menu of the *available* dimensions (Members/Harnesses/Presence shown only on central-with-data; Repos only when a repo dimension exists; Projects/Models when present); picking one opens that dimension's inline value picker (Projects opens the full `ProjectsModal`). The selected values are NOT shown in the top bar — they render in the animated per-category chip rows below (`AnimatedRow`/`ChipRow`/`FilterChip`, one row per dimension incl. Presence). Do not re-add always-visible dimension dropdowns to the top bar.
  - **Full-screen modals on mobile**: ProjectsModal, SessionDrilldownModal, PreferencesModal, the transcript viewer, etc. render full-screen (overlay padding 0, width/height 100%, `borderRadius: 0`) — iOS Safari pushes centered fixed-width modals off-screen when the page overflows horizontally.
  - **iOS sticky fix**: mobile `html, body, #root` use `overflow-x: clip` (NOT `hidden`) in `index.css` — `hidden` forces `overflow-y` to compute to `auto`, creating a scroll container that breaks `position: sticky`. `clip` clips without that side effect.
  - **iOS install/PWA**: iOS has no `beforeinstallprompt`; InstallModal/Install tab detect iOS and show Add-to-Home-Screen steps instead of an install button. The data cache in `useData.ts` (`agentistics-data-cache-v1` in localStorage) gives instant reopen over plain HTTP (service worker needs HTTPS/localhost).
- **`files_modified` counting** (`packages/server/server/jsonl.ts`): tracks unique file paths from Edit/Write/MultiEdit tool calls (`claudeFilesModified` Set), then takes `Math.max(gitFileStats.filesModified, claudeFilesModified.size)` — whichever is higher. This captures files Claude edited in non-git directories.
- **`getProjectGitStats`** (`packages/server/server/git.ts`): first tries the project path as a single git repo; if that fails (not a git repo), falls back to scanning one level of subdirectories and aggregating stats across all git repos found there (handles workspace folders like `~/zuke`).
- **FILES KPI** (`packages/web/src/hooks/useData.ts`): always uses session-level `files_modified` count first (Edit/Write/MultiEdit calls); falls back to project-level `git_stats.files_modified` only if sessions show 0. This is different from commits/lines which prefer project-level git stats when a project filter is active.

## Concurrent work — one worktree per session, never the shared checkout

Several agents/sessions routinely run against this repo at the same time. A checkout can only be
on ONE branch and every session sees the same files, so sharing the main checkout is not "slightly
risky", it silently corrupts work. All four of these happened in a single afternoon:

- **A commit landed on the wrong branch.** Another session ran `git checkout` mid-session; the next
  commit went onto ITS branch, on top of an unrelated stack.
- **`git add -A` swept another session's in-progress files** into an unrelated commit. Always stage
  explicit paths, and read `git status` before every commit — the diff is not only yours.
- **`bun test` measured a tree someone else was mutating.** The count moved 656 → 842 mid-run: a red
  test may not be yours, and a green one may prove nothing about your change.
- **Two agents edited the same file minutes apart.** A "the tree is clean, nobody is working" check
  is a snapshot, not a lock — it was clean because the other agent was between reads and writes.

So: **work in `.claude/worktrees/<name>/` on your own branch** (the `EnterWorktree` tool, or
`git worktree add`). A fresh worktree needs `bun install` plus
`bun run packages/server/scripts/ensure-type-stub.ts` — without the stub `tsc` fails on the
gitignored `embedded-dist.generated.ts`. Base it on `origin/dev`, not `origin/main`.

**Never rebase or reset a branch another session is committing to** — leave a stray commit where it
is and land your own copy on the target branch. A cherry-picked duplicate resolves itself on merge
(same patch, no conflict); a rebase under a live session destroys work.

## Development

```bash
bun run dev            # API (47291) + UI (47292) in parallel
bun run watch          # OpenTelemetry daemon (optional)
bun run cli            # agentop from source (bare = the control center)
bun test               # Unit tests for pure functions

# Build the binary
bun run build          # Generates packages/web/dist/ (Vite)
bun run build:assets   # Generates packages/server/server/embedded-dist.generated.ts
bun run build:binary   # Full pipeline → release/agentop
```

## Tests

Unit tests cover the critical pure functions:

- `packages/core/src/types.test.ts` → `calcCost()`, `getModelPrice()`
- `packages/core/src/chatUtils.test.ts` → tool label helpers
- `packages/web/src/hooks/useData.test.ts` → `calcStreak()`, `getDateRangeFilter()`
- `packages/server/server/chat-tty.test.ts` → chat TTY parsing

Do not mock the filesystem — the tested functions are pure and have no side effects.

## Git hooks (husky)

- **pre-commit**: `bun tsc --noEmit` + `bun test`
- **commit-msg**: commitlint enforces Conventional Commits (`feat:`, `fix:`, `chore:`, etc.)

## The release's version bump — `versionBump.ts`, and the read that feeds it

**The published version is decided by `bumpFromCommits` / `nextVersion` in `@agentistics/core`, and
`.github/workflows/release.yml` only READS the commits and delegates.** The calculation was inline
bash and nothing exercised it, so a defect was observable only in production, one release at a time
— v1.23.1 shipped a `feat` as a patch. Two rules, both enforced by
`packages/core/src/releaseWorkflow.lint.test.ts` (a grep over the workflows, the shape
`tokens.lint.test.ts` uses over the product source):

- **`git log --pretty=tformat:`, never `format:`.** `format:` omits the terminal newline on the LAST
  record and `while IFS= read -r` silently drops a line without one, so the OLDEST commit of every
  range went unclassified — and when that was the only `feat`, zero subjects were read. It is
  harmless inside `$(…)`, which strips trailing newlines, and that is precisely why the wrong form
  survives long enough to be copied into a loop. The lint bans the form outright in every workflow
  and root shell script; `@git-format-intentional` plus a reason is the escape hatch.
- **No bash bump default.** `bumpFromCommits` THROWS on an empty commit list, because a range that
  has commits (`COMMIT_COUNT > 0`) yet yields none to classify is a reading defect, not a patch. A
  `BUMP="patch"` floor in the shell converts that loud failure back into a quietly wrong release,
  so the lint refuses one. A NON-empty list of only non-conventional subjects is a different thing
  — the read worked, there is nothing to bump — and is a legitimate patch.
