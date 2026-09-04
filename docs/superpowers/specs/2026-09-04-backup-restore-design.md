# Backup & restore — carrying a machine's whole history to a new one

**Date:** 2026-09-04
**Status:** design approved, not implemented

## The problem

The user is about to reformat their machine. Everything agentistics knows lives in dotfiles on
that disk: 648 sessions of computed metrics, the deep Claude aggregate that no longer exists
anywhere else, and 282 project directories whose repositories, worktrees, unpushed branches and
uncommitted work a `git clone` alone cannot bring back.

There is no `agentop backup` today. This design adds one, plus a restore that reconstructs the
working tree layout deterministically — without a person or an assistant having to remember where
anything was.

## What the numbers actually are

Measured on the reference machine, 2026-09-04. They are the reason the layer model below exists:
the metrics are trivially small and the chat text is what weighs.

| Bucket | Path | Size |
|---|---|---|
| Computed metrics, all harnesses | `~/.agentistics/sessions/` | **3.7 MB** (648 files) |
| — claude | `sessions/claude/` | 3.4 MB (552) |
| — antigravity | `sessions/antigravity/` | 140 KB (34) |
| — gemini | `sessions/gemini/` | 64 KB (15) |
| — codex | `sessions/codex/` | 60 KB (14) |
| — kimi | `sessions/kimi/` | 52 KB (12) |
| — copilot | `sessions/copilot/` | 48 KB (11) |
| Claude's deep aggregate | `~/.claude/stats-cache.json` | 24 KB |
| Workflows | `~/.agentistics/workflows/` | 228 KB |
| Tags / preferences / notifications | `~/.agentistics/*.json` | ~6 KB |
| Archive mirror | `~/.agentistics/archive/` | 101 MB |
| Raw harness dirs | `~/.claude` 953 MB · `~/.copilot` 928 MB · `~/.gemini` 225 MB · `~/.kimi-code` 180 MB · `~/.codex` 129 MB | **~2.4 GB** |
| Unpushed git objects, one repo | `git bundle --all --not --remotes` on agentistics | **265 KB** (vs 30 MB for `--all`, vs 122 MB for `.git`) |

The last row is the load-bearing one: every local branch the remote does not have costs a quarter
of a megabyte. There is no reason not to save it.

## Scope of a restore

Four verbs over one engine, reached from three front doors that hold no rules of their own.

| Verb | CLI | Cockpit | Web |
|---|---|---|---|
| Configure | `agentop backup config` | `backup` tab, config pane | Settings → Backup |
| Run one | `agentop backup [dest]` | `b` | button |
| Schedule | `agentop backup schedule <daily\|weekly\|off>` | config pane row | row |
| Restore | `agentop restore <file>` / `--repos` | plan + retry failed | plan + retry failed |

## Layers

A backup carries up to four layers. Each is independently selectable and **recorded in the
manifest**, so a restore knows what it is holding rather than inferring it from what it finds.

| Layer | Contents | Cost here |
|---|---|---|
| `metrics` (always) | `~/.agentistics/sessions/`, `workflows/`, `tags.json`, `preferences.json`, `notifications.json`, `~/.claude/stats-cache.json` | ~4 MB |
| `repos` | the repository manifest + per-repo bundles + working-tree patches. **Never** the working trees themselves | tens of MB |
| `archive` | `~/.agentistics/archive/` — transcripts already mirrored by `full` mode | 101 MB |
| `raw` | `~/.claude`, `~/.codex`, `~/.gemini`, `~/.copilot`, `~/.kimi-code` | ~2.4 GB |

`metrics` is not optional. A backup without it restores nothing.

## Coverage — what a restore gives back, and what it does not

Stated positively and negatively, because a backup that is vague about its own edges is one people
discover the limits of at the worst moment.

### Covered

- **Every metric the dashboard shows**: cost, tokens (all four counters), sessions, projects,
  repositories, agent metrics, model breakdown, activity hours, streak, context gauge.
- **Claude's pre-30-day history**, via `stats-cache.json` — the only surviving source once Claude
  Code's own cleanup has run.
- **Session titles and first prompts**, because they live on `SessionMeta`.
- **Tags** (including their windows and sources), **workflow runs**, **custom layouts**, the
  **billing timeline**, **per-connection sharing rules**, and **notification history**.
- **Where every repository was**: absolute layout of main checkouts and all 217 worktrees, with the
  branch each was on.
- **Every local commit the remote does not have**, per repository, via bundle.
- **Uncommitted work**: staged and unstaged diffs, plus the list of untracked files (and their
  contents, subject to the size ceiling).
- With `archive`: the **raw transcript text** of everything the mirror had already captured.
- With `raw`: **byte-level fidelity** of the harness directories, minus the exclusions below.

### Not covered, and why

- **Live credentials.** Excluded by decision — see below. The restore names each one and the command
  that re-establishes it.
- **Repository working trees.** They are rebuilt by cloning, never carried. `node_modules` and build
  output are not history.
- **Repositories with no remote** that exceed the bundle ceiling. Refused **in writing**, listed by
  name, never silently omitted.
- **Paths outside `$HOME`** (19 here: `/tmp`, scratchpads). Recorded in the manifest, not restored —
  `/tmp` is not a place to put a repository back.
- **Directories that no longer exist at backup time.** Recorded as `gone`. A directory that does not
  exist is not a directory outside a repository; that discriminator is the one `repo-facts.ts`
  already enforces.
- **tmux sessions.** `managed-sessions.json` names processes that will not exist. Restoring it would
  produce a fleet of rows pointing at nothing.
- **Regenerable caches.** Listed below; they cost megabytes and rebuild themselves.

## The include/exclude table

`backup-plan.ts` is pure and holds one row per rule **with its reason**. The manifest records what
was excluded so the restore can print it.

### Secrets — excluded, and named on restore

| Path | Re-establish with |
|---|---|
| `~/.claude/.credentials.json` | `claude login` |
| `~/.codex/auth.json` | `codex login` |
| `~/.gemini/oauth_creds.json` | `gemini` (first run) |
| `~/.copilot` token files | `copilot` (first run) |
| `~/.agentistics/connections/` | `agentop member connect <url> <token>` |
| `preferences.json → team.token`, `team.connections[].token` | `agentop member connect <url> <token>` — the file itself DOES travel, redacted: it also carries layouts, the billing timeline and the sharing rules, which the restore is meant to bring back |
| envelope private key (`envelope-keys.ts`) | re-pinned by siblings on next announce |

A tarball holding these is a master key to the user's accounts. It is excluded, and the cost — five
minutes of re-login — is paid deliberately rather than discovered.

**`backup-plan.test.ts` greps the module's own source and fails if any secret path can pass the
filter**, the same enforcement shape `billing-detect.test.ts` uses.

### Regenerable — excluded

`~/.agentistics/cache.db*` (2.3 MB) · `git-stats.db*` (40 KB) · `agentop-server.log` (6.2 MB) ·
`*.corrupt-*` · `*.tmp-*` · `server-*.lock` · `~/.claude/shell-snapshots` (868 KB) ·
`paste-cache` (760 KB) · `plugins/cache` (3.8 MB) · `~/.claude/statsig`

### Runtime — excluded

`managed-sessions.json` (names tmux sessions that will not exist).

## Size accounting

`backup-size.ts` is pure and is what every surface reads. Three rules:

1. **Measured, never guessed.** Sizes are real bytes on disk, walked at plan time — per layer, and
   within `metrics` and `raw`, **per harness**, so the tab can show a harness's own weight beside
   its own last-backup date.
2. **A compressed size is only ever reported after writing.** The plan shows the uncompressed total
   and says so; it never predicts a ratio and presents it as a figure. An estimate that reads like a
   measurement is the same defect as a confident `0` for a metric nobody can produce.
3. **Retention is accounted as a total.** The config pane shows what all retained backups occupy
   together, before the user raises `keep N` or adds the `raw` layer to a schedule — 7 daily copies
   of `raw` would be 17 GB, and that has to be visible at the moment of the decision, not after.

`BackupSizes` carries, per layer: `bytes`, `files`, and `byHarness: Partial<Record<HarnessId, number>>`.
The harness map is keyed off `HARNESS_ORDER`, never a literal array — a literal with a member
missing compiles clean and the harness vanishes from the screen.

Recorded after a run, appended to `~/.agentistics/backups.jsonl`: `at`, `path`, `layers`, `harnesses`,
`bytesRaw`, `bytesArchive` (the file's real size), `sha256`, `durationMs`.

**A recorded backup whose file is gone says so.** The date is checked against the disk before it is
shown; a reassuring timestamp pointing at a file that does not exist is worse than no timestamp.

## The repository manifest

Built at backup time by **asking live git**, using the session store only to know *which* paths to
ask about (282 distinct here; `git_remote` is recorded on only 89 of them, which is a limitation of
the store, not of reality).

Grouped by **git common dir**, not by path — that is the only thing a worktree provably shares with
its main checkout.

```ts
interface RepoEntry {
  key: string            // normalized remote (normalizeGitRemote), or the common-dir path when none
  cloneUrl: string       // the url as configured — what git actually needs
  mainPath: string       // HOME-relative when under HOME, absolute otherwise
  mainBranch: string
  worktrees: { path: string; branch: string; head: string }[]
  bundle: string | null  // path inside the archive
  dirty: { path: string; patch: string | null; untracked: string[] }[]
  note: 'no-remote' | 'gone' | 'not-a-repo' | 'outside-home' | 'too-large' | null
}
```

- Bundles are produced **per main checkout only** — a worktree shares the object store.
- A repository with **no remote** has no other home, so it gets a full `--all` bundle, subject to
  `--max-bundle`. Over the ceiling it is `too-large` and refused by name.
- Paths under `$HOME` are stored **HOME-relative**. If the new `$HOME` differs, restore rewrites the
  prefix in the restored session JSONs; the manifest records the old `$HOME`, so the substitution is
  deterministic and happens only when they differ.

`repo-manifest.ts` also holds the reverse direction — `RepoEntry` → the exact commands that rebuild
it — so the plan a user reads and the commands that run are the same function.

## Restore

Two phases. The first touches only agentistics' own data and is instant; the second is network and
disk, will partially fail, and is resumable.

```
agentop restore <file>      # metrics in seconds, then PRINTS the repo plan, changing nothing
agentop restore --repos     # executes; records what succeeded; re-running resumes the rest
agentop restore --repos --only <repo>
```

- The archive is verified in TWO steps, and **nothing reaches `$HOME` before both pass**: `tar` must
  list it end to end (catches truncation) BEFORE extraction, and the manifest's `path:bytes` digest
  must match the extracted set (catches a rebuilt or edited archive) AFTER extraction into staging
  and before the merge. The digest cannot be checked earlier — it needs the files. A
  truncated tarball is a refusal, not a partial restore.
- Metrics merge and **never overwrite a newer local file** — the same rule `writeConsolidated`
  already applies.
- `stats-cache.json` is **not written over Claude's own**. It goes to `ARCHIVE_STATS_DIR`, where
  `applyArchivedStats` already reads it with per-field `max`, never additive. An existing rule,
  reused rather than a new one invented.
- A destination directory that exists and is non-empty is **`skipped` with a reason**, never
  overwritten.
- Per-repo state lives in `~/.agentistics/restore-state.json`: `done | failed:<reason> | skipped`.
- **Every failure is a line naming the repo and the reason.** Never a count of successes without the
  list of what did not come back.
- The run ends with the **omitted-secrets list** and the command that re-establishes each.

## Schedule

The scheduled run **rides along with the daemon `agentop server` already starts** — the argument
`events/daemon.ts` records: it is the long-lived thing that already exists, is already covered by
`agentop autostart`, and is never a process the user must remember to start. `schedule.ts` is pure
and only answers "is one due?".

A schedule carries **`metrics` only** (~4 MB/day; 7 retained = 28 MB). It carries no repository
manifest — building one shells out to git across every known directory and writes bundles, which is
load nobody asked for unattended — and it therefore does not RECORD a `repos` layer either: a
manifest claiming one would produce a restore saying "0 repositories to clone" to somebody who
believed they were covered. `repos` and `raw` are both manual —
it is the tarball you take on the eve of a reformat.

**The stated cost, which the UI must state too:** with the server stopped, nothing runs. The tab
shows *"schedule inactive — the server is not running"*, never a "next at 03:00" that will not fire.
Same N/A-versus-a-confident-0 rule the dashboard applies to harness capabilities.

## Surfaces

### CLI

`agentop backup` / `agentop restore`, handlers in `cli-backup.ts`, strings in `cli-i18n.ts` (EN/PT).
It is the only surface that can run on a freshly formatted machine, so it is complete on its own.

### Control center — a `backup` tab

Enters `TAB_ORDER` between `sessions` and `dashboard`: an operation over the data, and operations
come before the numbers.

Same grammar as the Services cockpit — a band over a full-width detail pane:

```
┌─ harnesses ────────────────────┐┌─ config ──────────────────────────┐
│ ● claude      552 sessions 3.4M││ layers      metrics + repos       │
│ ● codex        14 sessions  60K││ destination ~/backups             │
│ ● gemini       15 sessions  64K││ schedule    daily 03:00           │
│ ○ copilot      11 sessions  48K││ keep        7 backups (35 MB)     │
│ ● antigravity  34 sessions 140K││ secrets     excluded (5 items)    │
│ ● kimi         12 sessions  52K││ last        6h ago · 4.1 MB · ok  │
└────────────────────────────────┘└───────────────────────────────────┘
```

- The harness list comes from `HARNESS_ORDER`.
- **Last-backup is per harness**, not one date at the top: an unticked harness must read as
  unprotected, and a single global date would make the unticked `copilot` look covered.
- A run streams into the detail region through `ControlHost.onOutput` — the path the rebuilds
  already use. Nothing prints into the alternate buffer.
- Pure arithmetic (row budget, cell fit, the config rows) lives in `control/backup.ts` and is tested,
  like `sessions.ts`.

### Web — Settings → Backup

A new `SettingsSectionId`. Same information, same host decisions; it triggers a run and shows
history, and it is `!central` (a central aggregates other machines and has no local harness dirs to
back up). Mobile branch built in the same change, per the standing rule — no follow-up pass.

## Adjacent fix: the CHAT block is in the wrong settings section

Found while surveying Settings. The notification-sound and chat-model controls live in
`PreferencesSettings.tsx`; the `chat` section already exists (`ChatSettings.tsx`) and holds the
enable switch. The block moves.

The gate is **two gates, not one**, because collapsing them makes the switch unreachable:

| State | What the section shows |
|---|---|
| Profile permits, chat **on** | enable switch **+ sound + model** |
| Profile permits, chat **off** | enable switch only — this is how it is turned back on |
| Profile denies `localChat` (`public`) | **section absent** — there is nothing to switch |

So `chatEnabled` gates the *rows*, and `capabilities.localChat` gates the *section* — exactly the
distinction `chat-gate.ts` already draws between "your profile allows this" and "you have it off".
`visibleSettingsSections` gains `localChat` on `SettingsViewer` for the section gate.

## Modules

```
packages/server/server/backup/
  backup-plan.ts     PURE  include/exclude, one row per rule with its reason
  backup-size.ts     PURE  per-layer and per-harness byte accounting; retention totals
  manifest.ts        PURE  the manifest shape + round-trip
  repo-manifest.ts   PURE  git facts → RepoEntry, and RepoEntry → the commands that rebuild it
  schedule.ts        PURE  is a run due?
  restore-plan.ts    PURE  manifest + machine state → write / skip / clone, and the resume
  backup.ts          IO    walks, runs git, writes the archive
  restore.ts         IO    verifies, extracts, writes, executes the plan
  cli-backup.ts            the agentop handlers
packages/tui/src/control/
  backup.ts          PURE  the tab's arithmetic
  tabs/Backup.tsx          the tab
packages/web/src/pages/settings/
  BackupSettings.tsx       the web section
```

## Tests

- `backup-plan.test.ts` — greps its own source; no secret path may pass the filter.
- `backup-size.test.ts` — per-harness accounting derived from `HARNESS_ORDER`; a compressed figure is
  never produced before a write.
- `manifest.test.ts` — round-trip, and an older manifest version still reads.
- `repo-manifest.test.ts` — worktree grouping by common dir; `gone` / `no-remote` / `outside-home` /
  `too-large`; `RepoEntry` → commands.
- `restore-plan.test.ts` — merge never overwrites a newer local file; non-empty destination is
  skipped with a reason; resume attempts only what is unfinished; `$HOME` rewrite fires only when
  the two differ.
- `schedule.test.ts` — due/not-due, and a stopped server yields "inactive", not a next time.
- `control/backup.test.ts` — row budget and cell fit at narrow widths.

## Delivery order

The engine is the whole value; the surfaces are how it gets remembered. Phased so the urgent case
is covered first — the user is reformatting, and a backup that exists beats a tab that is pretty.

1. **Engine + CLI.** The pure modules, `agentop backup`, `agentop restore`. At the end of this
   phase the machine is protected and the reformat is safe.
2. **Schedule.** `schedule.ts` plus the daemon hook. Protection stops depending on remembering.
3. **Control center tab.** `control/backup.ts` and `tabs/Backup.tsx`.
4. **Web section** (desktop + mobile in the same change) and the CHAT block move.

Phases 3 and 4 add no rule: they call the same host and render what it already decided.
