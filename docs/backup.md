# Backup and restore

Carry a machine's whole agentistics history to another one — the metrics, and the working state of
every repository it has been used in.

Two commands, one engine: `agentop backup` and `agentop restore`. The cockpit's Backup tab and
Settings → Backup on the web drive the same modules; none of the three owns a rule of its own.

- Engine: `packages/server/server/backup/`
- CLI: `packages/server/server/cli-backup.ts`
- Design: [`docs/superpowers/specs/2026-09-04-backup-restore-design.md`](superpowers/specs/2026-09-04-backup-restore-design.md)

---

## The four layers

A backup is up to four independently selectable layers, and the manifest RECORDS which ones are in
it — a restore knows what it is holding rather than inferring it from what it happens to find.

| Layer | What it carries | Default |
|---|---|---|
| `metrics` | `~/.agentistics/sessions/**` — the computed per-session metrics, plus the stats caches and preferences | **always** |
| `repos` | A manifest that can REBUILD every checkout: clone URL, worktrees, a bundle of what was never pushed, patches of what was never committed | on |
| `archive` | The mirrored raw transcripts (`~/.agentistics/archive`, `archiveMode: 'full'` only) | off |
| `raw` | The harness directories themselves (`~/.claude`, `~/.codex`, …) | off |

**`metrics` is never optional.** Every writer of the preference runs its input through
`withMetrics()` before it is stored, so no surface can drop it by sending a list that omits it — a
backup without it restores nothing.

**Sizes are MEASURED, never estimated**, per layer and per harness (`backup-size.ts`). The one
exception is `repos`, which reports `null` — "known after a backup runs" — because its content
(bundles, patches) does not exist anywhere on disk until `buildRepoManifest` shells out to git per
candidate directory, which is not measuring the operation, it IS the operation. A surface renders
that `null` as a sentence, never as `0`: the same N/A-versus-a-confident-0 rule
`HARNESS_CAPABILITIES` applies to a metric.

---

## What a repository backup actually is

`repo-probe.ts` asks git, live, per candidate directory. For each repository the manifest carries:

- the **remote** and the commit each worktree was on;
- every **worktree**, so a machine that works the way this repo mandates comes back whole;
- a **bundle** of any branch that exists only locally — work that was never pushed and that no
  remote can give back;
- a **patch** of anything uncommitted, plus the list of untracked files.

`--max-bundle MB` bounds the bundle (200 MB by default); a repository over the bound is reported by
name rather than silently truncated.

`agentop restore <archive> --repos` replays it: clone, add worktrees, fetch the bundle, apply the
patch. `--only <repo>` restores one. The plan is `restore-plan.ts` — pure — and it is executed as
**structured argv, never a joined string**: a path with a space cannot be recovered from a joined
line, and joining to re-split is exactly how a wrong argv gets built. `restoreCommands` renders the
same plan for a person to read; one source, two forms, and no shell anywhere.

---

## What is deliberately NOT in a backup

`backup-plan.ts` holds one exclusion table with a REASON per row, and the three reasons are not
interchangeable:

- **`secret`** — a live credential. Excluded by decision: a tarball holding these is a master key to
  the user's accounts and it travels on a pendrive. The five minutes of re-login are paid on
  purpose, and `omittedSecrets()` is what lets the restore **name each one and the command that
  re-establishes it**. Nothing goes missing in silence.
- **`regenerable`** — a cache or a log. It rebuilds itself and costs megabytes.
- **`runtime`** — true on the old machine, false on the new one. `managed-sessions.json` names tmux
  sessions that will not exist there; restoring it produces a fleet of rows pointing at nothing.

A few of the named credentials, as the restore prints them:

| Omitted | Re-establish with |
|---|---|
| Claude Code credentials | `claude login` |
| Codex / Gemini / Copilot / agy auth | `codex login`, or sign in on first run |
| Kimi's `api_key` | restore it in `~/.kimi-code/config.toml` |
| The member's central token | `agentop member connect <url> <token>` |
| The backup repository's GitHub token | `agentop backup github setup <url>` |
| The envelope keypair | nothing — siblings re-pin this machine on its next announcement |

`backup-plan.test.ts` **greps this module's own source and re-probes every credential path**, so a
rule deleted in a refactor fails the build instead of shipping a leak, and
`backup-coverage.lint.test.ts` makes an undecided path impossible: a new path must be classified.

---

## Commands

```bash
agentop backup [--with-archive] [--with-raw] [--harness a,b] [--dest DIR]
               [--max-bundle MB] [--plan]
agentop backup schedule <off|daily|weekly>
agentop backup config [--layers a,b] [--schedule <off|daily|weekly>] [--schedule-layers a,b]
agentop backup status

agentop restore <archive> [--repos] [--only <repo>]
```

`--plan` prints what would be written and writes nothing. `agentop backup config` with no flags
prints the current layers, schedule and schedule-layers.

**A failure is a LINE naming the thing and the reason.** A run that clones 89 repositories will
partially fail, and a count of successes without the list of what did not come back is not a report.

**A restore is resumable.** It runs in two phases and records its state
(`readRestoreState` / `restoreStateFile`), so an interrupted run continues instead of starting over.

---

## The schedule

`agentop backup schedule daily|weekly|off`, or `--schedule` on `backup config` (a `custom` interval
exists with a floor of `MIN_CUSTOM_HOURS`; the raw value is carried unclamped into preferences and
`intervalMs` is the ONE place that clamps it, so a hand-edited file cannot smuggle a five-minute
backup past a validation living elsewhere).

**Absent reads as OFF.** A machine must never start writing gigabytes because it was upgraded — the
same rule `chat-gate.ts` applies to the local shell.

**A schedule never carries the `repos` layer.** Rebuilding the manifest means shelling out to git
across every candidate directory; that is a thing a person asks for (`agentop backup`, or `b` in the
cockpit), not something a timer does behind them. `scheduleLayers` is therefore its own preference
rather than a reuse of `layers`.

**It rides the daemon `agentop server` already runs** (`backup/daemon.ts`), never a service the user
has to remember to start — the same choice the event channel's producer makes and for the same
reason. `agentop backup status` reports the schedule as off / **inactive because the server is not
running** / due, because "nothing has run" and "nothing was watching" are different facts.

---

## Versioning to a private GitHub repository

Optional. It turns the newest backup into a GitHub **release** on a repository you own, so the
history is versioned and reachable from a machine that has nothing but the URL.

```bash
agentop backup github setup <repository-url>   # asks for a token, never echoed
agentop backup github status
agentop backup github install-workflow
```

Setup **checks before it writes anything**: the repository must already be PRIVATE, and the token
must actually be able to push to it. It also installs
`.github/workflows/agentistics-backup-doc.yml`, which keeps a `BACKUPS.md` in that repository up to
date on every release; `install-workflow` installs it on its own and is idempotent — it never
overwrites one already there.

### Coming back from nothing but a URL

```bash
agentop restore <repository-url> [--release <tag>] [--from <machine>]
agentop restore github --list <repository-url>
```

It asks for a token if none is stored, lists the releases, shows what would be downloaded, asks, and
**verifies the sha256 against the release body before touching anything** — then hands off to the
ordinary restore above.

`--from <machine>` takes the newest backup of ONE machine. It is required as soon as several
machines version into the same repository, where "the newest" is otherwise whichever happened to run
last (`groupReleasesByMachine` / `newestForMachine`); `machine-label.ts` is what gives each machine a
stable name in that listing. `--list` shows what is there and downloads nothing.

Retention is `github-retention.ts`; `keep` (7 by default) bounds what is kept, locally and in the
releases.

---

## The three doors

| Surface | Where |
|---|---|
| CLI | `agentop backup` / `agentop restore` |
| Cockpit | the Backup tab (`b` runs one) |
| Web | Settings → Backup |

All three call the same pure modules and the same `BackupHost` interface. A rule that lives in only
one of them is a rule the other two will eventually contradict — the reason `task-reopen.ts` exists.
