# agentistics CLI — `agentop`

`agentop` is the single binary for everything agentistics does: run the dashboard,
the terminal TUI, the OpenTelemetry daemon, host or join a **Team Mode** central,
and manage autostart + updates.

Get the binary from the [install instructions](../README.md#install) (`install.sh`,
`npm i -g @agentistics/agentop`, the Windows installer, or `bun run build:binary` from
source). From a checkout you can also run it directly with
`bun run packages/server/bin/cli.ts <command>`.

```bash
agentop --help       # full usage
agentop --version    # print version (and a notice if an update exists)
```

> **Ports:** a solo/member instance serves the **web dashboard on 47292** (the URL you open) and
> the **api + mcp on 47291** (in dev, Vite serves the web on 47292 and the api runs on 47291 — same split).
> A Team Mode **central** runs in Docker on **48080**
> by default. These are intentionally distinct so a member and a central can
> coexist on the same host.

---

## Command overview

| Command | Purpose |
|---------|---------|
| [`start`](#start) | The control center — services, setup, logs, commands, help (same as bare `agentop`) |
| [`setup`](#setup) | Interactive first-run wizard (solo / central / member) |
| [`server`](#server) | Start the web dashboard + api + Nay + background daemon (non-interactive) |
| [`restart`](#restart) | Restart a running mode so it picks up new code / config |
| [`status`](#status) | At-a-glance: mode, services (server/central/machine) + health |
| [`tui`](#tui) | Live terminal dashboard (no browser) |
| [`watch`](#watch) | OpenTelemetry metrics daemon only (headless) |
| [`central`](#central) | Manage the Team Mode central (wraps `central.sh`) |
| [`member`](#member) | Join / leave / inspect a Team Mode central from this machine |
| [`session`](#session) | Start / list / attach / kill background assistant sessions (tmux-backed); `ls` prints the cockpit's table |
| [`hooks`](#hooks) | Teach Claude Code to fan work out across several assistants through agentop |
| [`backup`](#backup) | Back up this machine's history — metrics, and a manifest that rebuilds every repository |
| [`restore`](#restore) | Restore a backup, or pull one from the private GitHub repository holding them |
| [`ci-push`](#ci-push) | One-shot push of a GitHub Actions run's metrics to a central (per repo) |
| [`autostart`](#autostart) | Start a mode with the system (systemd user service) |
| [`upgrade`](#upgrade) | Upgrade `agentop` to the latest release |
| [`check-update`](#check-update) | Print an "update available" banner, else stay silent |
| [`doctor`](#doctor) | Run the exposure preflight before publishing a central |
| [`setup-token`](#setup-token) | Reissue a central's one-time owner setup token |
| [`reset-password`](#reset-password) | Reset an account's password from the host (locked-out owner) |

Running **bare `agentop`** on an interactive terminal opens the
[control center](#start). Without a terminal it prints this help; `--help` always prints it.

---

## `start`

The **control center** — one full-screen application, in the terminal's *alternate buffer*, so it
adds nothing to your scrollback no matter how long you use it. Bare `agentop` opens the same thing.

```bash
agentop                      # the usual way in
agentop start
agentop start --lang pt      # force Portuguese for this run
```

```
 ▄▀█ █▀▀ █▀▀ █▄░█ ▀█▀ █ █▀ ▀█▀ █ █▀▀ █▀
 █▀█ █▄█ ██▄ █░▀█ ░█░ █ ▄█ ░█░ █ █▄▄ ▄█                           member · v1.7.3 · ● 1.7.4

  services   setup   logs   commands   help   contribute
 ━━━━━━━━━━
 ╭─ services ─────────────────────────────╮╭─ config ─────────────────────────────────────╮
 │ ❯ agentistics         native ● up      ││   mode     member                            │
 │   agentistics central        ○ stopped ││   endpoint http://198.51.100.199:48080       │
 │                                        ││   history  consolidate                       │
 │                                        ││   language English                           │
 ╰────────────────────────────────────────╯╰──────────────────────────────────────────────╯
 ╭─ agentistics ────────────────────────────────────────────────────────────────── native ╮
 │ native · pid 48213 · up 2h13m                                                          │
 │                                                                                        │
 │ RUNTIMES ───────────────────────────────────────────────────────────────────────────── │
 │ native   ● up · pid 48213 · up 2h13m                                                   │
 │ docker   ○ stopped                                                                     │
 │                                                                                        │
 │ ADDRESSES ──────────────────────────────────────────────────────────────────────────── │
 │ web      http://localhost:47292                                                        │
 │ api      http://localhost:47291                                                        │
 │                                                                                        │
 │ MACHINE ────────────────────────────────────────────────────────────────────────────── │
 │ boot     starts at boot                                                                │
 │ history  consolidate                                                                   │
 │ endpoint http://198.51.100.199:48080                                                   │
 │   Restart   Rebuild & restart   Stop   Open in browser                                 │
 ╰────────────────────────────────────────────────────────────────────────────────────────╯

 q quit  ·  ←→ screens  ·  tab pane  ·  ↑↓ move  ·  enter actions  ·  s stop  ·  R restart
```

**Naming:** `agentistics` is the per-machine app; `agentistics central` is the team aggregator.
Both serve a web dashboard, so neither is labelled "the dashboard".

### The screens

Move between them with **`←` / `→`** — there are no digit shortcuts for screens, so the digits
always belong to whatever list is drawing them.

| Screen | What it is for |
|---|---|
| **services** | The cockpit: start / stop / restart, connect to or leave a central, enable a boot service |
| **setup** | The same solo / central / member wizard as [`setup`](#setup), plus the history-preservation consent |
| **logs** | A tailing viewer, one source per running service |
| **commands** | The cheat sheet — every command, without leaving the app |
| **help** · **contribute** | What the keys do, and how to contribute |

### The services screen

The services list is the **selection**; the pane below is a view *of* it, so moving the cursor
repaints it. `tab` cycles the panes (services → config → actions) and the actions are
**focus-scoped**: with a service selected they act on *that* service, which is why there is no
"stop which?" submenu.

- **One row per logical service, never per runtime.** `agentistics` run natively and the same
  program in a container are two *runtimes* of one service. A running service therefore offers no
  "start" at all — it offers **Restart**, **Rebuild & restart** (only where a rebuild could actually
  work here), **Stop** and **Open in browser**. A stopped one is dimmed and offers only the starts
  this machine can perform.
- **A service running under BOTH runtimes says so**, in colour, with a word — and its verbs split
  into `Stop (native)` / `Stop (docker)`. They read the same files and fight over the same port, so
  the conflict is never normalised away by showing just one.
- **A long action streams into the detail pane**, titled with the verb you pressed, while the lists
  stay standing beside it. `esc` puts the facts back.
- The **Docker** option mounts the host's harness dirs read-only — run the machine in Docker **or**
  natively, not both. See [a machine in Docker](central-deploy.md#a-machine-in-docker).

The footer always names the keys that work *in the current focus*; it is the only documentation the
screen has, so a hint for a key that does nothing there is a bug.

**Non-interactive stdin** (a pipe, a systemd unit) skips all of this and behaves exactly like
[`server`](#server). `q` leaves without starting anything.

---

## `restart`

Restart a running mode so it picks up new code (after an `upgrade` / `git pull`) or a changed
config. Defaults to `server`.

```bash
agentop restart                      # = restart server
agentop restart server               # bounce the systemd user service (agentop-server)
agentop restart watch                # bounce the watch service
agentop restart central              # bounce the central's container
agentop restart --all                # bounce every service currently up
agentop restart central --rebuild    # rebuild the image first, then restart
agentop restart central --rebuild --cache -n   # …reusing the layer cache, answering the prompt
```

`server`/`watch` bounce the installed [systemd user service](#autostart) — if none is installed it
tells you to run it in the foreground or enable autostart first. `--all` bounces everything that is
up (local + central + machine), non-interactively.

**`--rebuild` is a FULL rebuild.** The Docker paths pass `--no-cache`, because a cached build can
hand you back the very image it was asked to replace — which is the one failure mode a rebuild
exists to prevent. That takes several minutes, and the command says so on the way in:

| Flag | Effect |
|---|---|
| `--cache` | Reuse Docker's layer cache instead — the fast path |
| `--no-cache` | The default for a rebuild; stated explicitly |
| `-y` / `--yes` | Re-run the central's interactive setup, without being asked |
| `-n` / `--no` | Do **not** re-run it — the default when there is no terminal to ask on |

Passing `-y` with `-n` (or `--cache` with `--no-cache`) is **refused**, not silently resolved. A
plain `agentop central up` is not a rebuild and keeps its cached build.

---

## `status`

Non-interactive, at-a-glance report of this machine. Prints three blocks:

- **CONFIG** — the team mode (`solo` / `central` / `member`) and, for a member, the
  central endpoint (from preferences).
- **SERVICES** — detected live: the local server (`http://localhost:47291/api/health`;
  shows the dashboard URL when up), the central container, and the machine container.
- **HEALTH** — a one-line summary from `/api/health` when the server is up, else `n/a`.

```bash
agentop status
```

Handy for a quick "is everything up and healthy?" without opening the dashboard.

---

## `setup`

Interactive first-run wizard. Walks you through picking a mode and wires up the
rest for you: **solo** (local only, nothing leaves the machine), **central** (host
the aggregator on this machine via `central.sh init`), or **member** (push this
machine's computed metrics to a central via `member connect`). It then offers to
enable [autostart](#autostart).

```bash
agentop setup
```

Needs a TTY. Ctrl-C is non-destructive — it aborts without touching your
preferences. For non-interactive/scripted member onboarding, use
[`agentop member connect`](#member) directly.

---

## `server`

Starts the web dashboard, api, Nay chat, MCP registration, and the OTel daemon —
everything in one process. Binds two ports: the **web dashboard on 47292** (open this) and the
**api + mcp on 47291**. They share one request handler, so the dashboard's `/api/*` calls just work.

```bash
agentop server              # web: http://localhost:47292 · api/mcp: http://localhost:47291
agentop server --port 4000  # api on 4000, web on 4001
agentop server --bg         # detached, logging to ~/.agentistics
agentop server --central    # run a central natively, no Docker
```

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | `47291` | The **api + mcp** port; the web dashboard is served on this + 1 (default 47292) |
| `--bg` | off | Start detached in the background; logs go to `~/.agentistics` |
| `--central` | off | Run this process as a **team central**, natively — see below |

### `--central` — a central without Docker

Runs the same server with `AGENTISTICS_TEAM_CENTRAL=1`, loading `central.env` (searched in
`$AGENTISTICS_CENTRAL_ENV`, `./central.env`, then `~/.agentistics/central.env`) for the secrets and
the database URL.

There is **no bundled MongoDB on this path** — set `MONGO_URL` to an external cluster (Atlas, or a
`mongod` you run yourself). For the all-in-one flow with Mongo included, use
[`agentop central up`](#central) instead.

> **`AGENTISTICS_TEAM_PASSWORD` in `central.env` selects the legacy shared-password login and masks
> the accounts sign-in.** If you want accounts, remove it — the central will otherwise serve the old
> "team password" screen with no error anywhere.

---

## `tui`

An **alias for [`start`](#start)** — it opens the control center, whose **Dashboard** screen is the
metrics dashboard this command used to be.

```bash
agentop tui        # identical to: agentop start
```

It was a second Ink application of its own: its own shell, its own keyboard, its own help panel,
drawing the same screens. Those screens are shared code now, so what the standalone app still owned
was a duplicate of the chrome around them — a second set of keys for the same material, and a second
place for the two to disagree. The command is kept because people have it in their fingers and in
their scripts.

Inside the app, the dashboard is one tab away:

| Key | Does |
|-----|------|
| `←`/`→`, `[`/`]` | Change tab — Services, Sessions, **Dashboard**, Logs, Cheat sheet, Help, Contribute |
| `1`–`6`, `tab` | Inside Dashboard: change screen — Overview, Projects, History, Costs, Harnesses, Hardware |
| `f` | Filter by harness |
| `,` / `.`, pgup/pgdn | Page a list (History, Projects, Costs) |
| `r` | Force a refresh |
| `q`, `ctrl+c` | Quit |

One difference worth knowing: the standalone command **started a server for itself** when none was
listening. The control center is the screen that starts and stops that server, so its Dashboard tab
starts nothing — when there is nothing to read it says so, and names the screen that fixes it. An
empty dashboard rendered as zeros would be a confident answer to a question it cannot answer.

Metrics match the web dashboard exactly: both price through `calcCost()`, Claude totals come from
`stats-cache.json` and every other harness from per-session sums. A metric a harness cannot
produce shows `N/A` rather than a misleading `0`.

Needs an interactive terminal — piping it runs like `agentop server`, exactly as `start` does.

---

## `watch`

Runs only the OpenTelemetry file watcher + OTLP metrics exporter (the same daemon
`server` runs in the background). Use this on a headless box that only needs to
feed Grafana/Datadog. See [docs/opentelemetry.md](opentelemetry.md).

```bash
agentop watch
```

---

## `central`

Manage the **Team Mode central** — the Docker service that aggregates metrics from
many members. This is a thin wrapper over the repo's `central.sh`, so it needs to
run from an agentistics checkout (the compiled binary alone doesn't ship the
Compose stack). Full deployment details live in [docs/central-deploy.md](central-deploy.md).

```bash
agentop central <up|init|down|logs|status|restart|pull>
```

| Action | What it does |
|--------|--------------|
| `init` | (Re)generate `central.env` interactively — auto-generates the secrets with `openssl`, detects your Tailscale IP for the bind, writes the file `chmod 600` |
| `up` | Build the image and (re)create the containers (`--build --force-recreate`); offers `init` first if `central.env` is missing |
| `restart` | Restart the `app` container without rebuilding |
| `logs` | Follow the `app` container logs |
| `status` | Show container + health status |
| `down` | Stop and remove the containers — **keeps** the Mongo data volume |
| `pull` | Rebuild from a fresh base image (run `git pull` first) |

```bash
agentop central init        # generate central.env (interactive)
agentop central up          # build + (re)create — most common
agentop central logs        # tail the app logs
agentop central down        # stop, keep the data volume
```

From a checkout you can equivalently use the package scripts
`bun run init:central` and `bun run up:central`, or call `./central.sh` directly.

---

## `member`

Configure this machine as a **member** that pushes computed metrics to a central.
Only aggregated metrics are sent — **never** chat content or raw transcripts. The
machine's display name is assigned by the central (baked into the minted token)
and resolved via `/api/team/whoami`; there is no name field on the machine.

```bash
agentop member connect --token <token> [--endpoint <url>] [--org <org>]
agentop member leave
agentop member status
```

### `member connect`

Verifies the token against the central's `whoami` endpoint, then saves the member
config. On a bad token it prints an actionable error and writes **nothing** (no
half-configured state).

**The token usually carries the URL.** A central with a public URL configured mints a
composite token (`act1_<base64 url>.<secret>`), which is what the Machines panel copies
into a ready-to-paste command — so pasting that one command connects the machine.
`--endpoint` is needed only for a bare token, or to override the embedded URL.

| Flag | Required | Description |
|------|----------|-------------|
| `--token <token>` | yes | Token minted for this machine in the central's Machines panel |
| `--endpoint <url>` | only for a bare token | Central base url, e.g. `http://host:48080` |
| `--org <org>` | no | Org override; defaults to the org on the token |

```bash
# the copy-paste form: the token carries the central's URL
agentop member connect --token act1_aHR0cHM6Ly9jZW50cmFsLmV4YW1wbGU.abc123

# a bare token needs the URL beside it
agentop member connect --endpoint http://100.64.0.2:48080 --token abc123
```

### `member leave`

Best-effort notifies the central (so it drops this member's data) and resets this
machine back to solo. Succeeds locally even if the central is unreachable.

### `member status`

Prints the current mode / endpoint / org / user plus the live uploader state
(`last sync` timestamp and whether the token/endpoint are healthy).

```
mode:      member
endpoint:  http://100.64.0.2:48080
org:       default
user:      alice-laptop
last sync: 2026-07-01T12:34:56.000Z
state:     ok
```

---

## `session`

Start, list, attach to, name and stop assistant sessions in the background. A background session is
hosted by tmux on its own socket (`-L agentop`), so it survives `agentop` exiting and never mixes
with your own tmux sessions.

```bash
agentop session <harness> [-p "prompt"] [--bg] [--model <id>] [--effort <level>] [--cwd <path>] [--name "label"] [--task "<name>"]
agentop session ls     [--all] [--group none|tree|status|repo|project|task|harness|model|marked] [--json] [--width <n>] [--no-color]
agentop session list   [--json]
agentop session attach <id|name>
agentop session kill   <id|name>
agentop session rename <id|name> "label"
agentop session note   <id|name> "text"

# several at once, filed under one task — the form an assistant should drive
agentop session batch --task "<name>" [--cwd <path>] --session "<harness>: <prompt>" [--session ...] [--json]
agentop session open  "<task>" [--json]
```

### `ls` — the cockpit's table, printed

`agentop session ls` prints the very table the control center's **sessions** tab draws: aligned
columns, a section per project, and the state word first. By default it answers the question a
person means by "what have I got open" — **only what is running**, grouped by project:

```
  id     state         session                     worktree         task                 harness  project
agentistics  4  ────────────────────────────────────────────────────────────────────────────────────────
  df831  working       claude hook                 claude-hook      cli: claude hook     claude   agentistics
  bda77  needs approval  session ls on the cli     session-ls       cli: session ls      claude   agentistics

apresentacao  1  ───────────────────────────────────────────────────────────────────────────────────────
  b87a4  waiting       drop the invented metrics                                         claude   apresentacao
```

| Flag | Effect |
|------|--------|
| `--all`, `-a` | Also list what is **not** running: finished, lost and closed conversations |
| `--group`, `-g` | `project` (default), `tree` (the cascade), `repo`, `task`, `harness`, `model`, `status`, `marked`, `none` |
| `--json` | The same JSON `list --json` prints — one machine-readable shape, not two |
| `--width <n>` | Fit this many columns instead of asking the terminal |
| `COLUMNS` (env) | Read **only when stdout is not a tty** — how wide the reader is when there is no terminal to ask (`ls \| less -S`) |
| `--no-color` | Never colour, whatever the terminal says (`NO_COLOR` does the same) |

#### `--group tree` — the cascade

`tree` is not a dimension, it is an **arrangement**: the project as the root, and the segments of
each session's directory below it as branches. It answers the question grouping by project cannot —
*where* in the project — without filing one project as N unrelated folder names.

```
agentistics  4  ───────────────────────────────────────────────────────────
  3328b  waiting       cockpit colours                        antigravity
  8157f  working       live session notifications             antigravity

  .claude/worktrees  26  ───────────────────────────────────────────────────

    sessions-cascade  1  ─────────────────────────────────────────────────
  106d0  waiting       cockpit: cascade view                  claude

    session-monitor  1  ──────────────────────────────────────────────────
  a2157  working       MAIN                                   claude
```

Chains that never branch are joined into one node (`.claude/worktrees/session-monitor` is one row
while it is the only worktree; a second one splits `.claude/worktrees` out as a node of its own).
Two things it will never do, because both would draw a directory that is not there:

- a session **outside any repository**, or one whose directory is **gone** with nothing recorded at
  spawn, hangs straight off its own root with no branch;
- a worktree created **outside** the main checkout gets ONE branch named after its own folder — a
  relative path that does not exist is not synthesised.

It is not offered as a **filter**, and cannot be: a session belongs to every node on its path, so
"filter to `packages`" and "the band `packages`" could never be made to agree.

It is a **separate command from `list`**, not a flag on it: `list` is the tab-separated dump scripts
already read line by line, and widening it into columns underneath them would break those scripts
for a cosmetic reason. Both print the same `--json`.

Some particulars, all of them shared with the cockpit rather than re-decided here:

- **A session running outside agentop counts as running.** It is listed as `external` because
  `/proc` found a live assistant; what cannot be read there is its *activity*, never whether it is
  alive. It carries no id, because `agentop session attach` cannot resolve one for it.
- **An absent number is absent.** A conversation that recorded no usage shows no usage — the column
  does not exist unless something on screen fills it, and a `0` would be a confident wrong figure.
- **An empty list says why.** "Nothing is running" names the flag that lists the rest; a poll that
  failed says so and never claims the machine is idle.
- **Nothing exceeds the width.** Columns are measured across the page and the row is clipped as a
  last resort, so a narrow terminal loses cells rather than wrapping every row onto the next.
- **Piped output is plain.** No colour, no escapes, and no invented terminal width — the table comes
  out as wide as its content, so `agentop session ls | grep` works.
- **A pipe can still state a width**, and a pager is a reader: with no tty to ask,
  `COLUMNS=80 agentop session ls | less -S` fits 80 columns, the same lever `git` and `ls` honour.
  The order is `--width` → the terminal → `COLUMNS` → as wide as the content; a `COLUMNS` that is
  not a width (`abc`, `0`) is ignored rather than obeyed, and no minimum is imposed on one that is.

`--bg` detaches and returns immediately; without it the session takes over your terminal, and the
detach keystroke is printed first (read from your own tmux prefix, never assumed to be `Ctrl-b`).
`--cwd` defaults to the directory you are in and is resolved to an absolute path.

`batch` starts every session detached and files them all under one task; `open` brings that whole
task back later — safe to press twice, since a session still running is left alone rather than
duplicated and everything reopened retires the row it replaced. Sessions keep their name, note and
task across a reopen, and across a reboot: tmux is authoritative about what is running, the registry
about what it means.

Needs **tmux** (Linux, macOS); Windows support arrives with the PTY backend. Full command reference,
the cockpit, harness support table and where state lives: see
[docs/session-manager.md](session-manager.md).

To have **Claude Code itself** propose the split, write each session's prompt and drive `batch`, see
[`hooks`](#hooks) below.

---

## `backup`

```bash
agentop backup [--with-archive] [--with-raw] [--harness a,b] [--dest DIR]
               [--max-bundle MB] [--plan]
agentop backup schedule <off|daily|weekly>
agentop backup config [--layers a,b] [--schedule <off|daily|weekly>] [--schedule-layers a,b]
agentop backup status
agentop backup github setup <repository-url>
agentop backup github status
agentop backup github install-workflow
```

Carries this machine's whole agentistics history to another one. A backup always holds the computed
**metrics** plus a **repository manifest** that can rebuild every checkout, worktree, unpushed
branch and uncommitted diff; `--with-archive` adds the mirrored transcripts and `--with-raw` the
harness directories themselves. `--plan` prints what would be written and writes nothing.

**Live credentials are never included**, by decision — `restore` prints each one and the command
that re-establishes it. A schedule never carries the `repos` layer: rebuilding that manifest shells
out to git across every candidate directory, which is a thing a person asks for, not something a
timer does behind them. The schedule rides the daemon `agentop server` already runs, and `status`
says so when the server is down rather than reporting an empty history.

`github setup <url>` connects a **private** GitHub repository to hold versioned backups as releases
— it verifies the repository is private and that the token can push before writing anything.

→ **Full reference: [docs/backup.md](backup.md)**

---

## `restore`

```bash
agentop restore <archive> [--repos] [--only <repo>]
agentop restore <repository-url> [--release <tag>] [--from <machine>]
agentop restore github --list <repository-url>
```

Two phases and **resumable**: an interrupted restore continues rather than starting over. `--repos`
replays the repository manifest (clone, worktrees, bundle, patch) as structured argv — never a
joined string, and never a shell. Given a **repository URL** instead of a file it is the path back
on a machine that has nothing else: it lists the releases, shows what would be downloaded, asks, and
**verifies the sha256 against the release body before touching anything**. `--from <machine>` is
required as soon as several machines version into the same repository, where "the newest" would
otherwise be whichever ran last.

→ **Full reference: [docs/backup.md](backup.md)**

---

## `hooks`

Teach Claude Code to fan work out across several assistants through agentop.

```bash
agentop hooks install   [--hook-only | --skill-only]
agentop hooks uninstall [--hook-only | --skill-only]
agentop hooks status
```

Two pieces, installed together, each doing what the other cannot:

- **a skill** at `~/.claude/skills/agentop-parallel-sessions/SKILL.md` — the *knowledge*: when a task
  splits into independent pieces, how to propose the split, how to write a prompt for a session that
  cannot see your conversation, and the exact `agentop session batch` contract. Claude loads it when
  the task matches its description, so it costs **nothing** on a session that never parallelises.
- **a `SessionStart` hook** in `~/.claude/settings.json` — the *facts* a static file cannot hold:
  which agentop sessions are running right now, which one is blocked on a permission prompt, which
  task can be reopened in this directory. It prints **nothing** when there is nothing running.

**A hook does not infer anything** — it is a deterministic shell command on an event. The inference
is Claude's, reading what the skill teaches and what the hook injected. That is why the "activate
when it is relevant" half is a skill and not a hook that taxes every session.

Guarantees: nothing is written to `~/.claude` unless you run this command (`agentop setup` only
*suggests* it); every other key in your `settings.json` is preserved; a file that cannot be merged
into is refused rather than rewritten; installing twice changes nothing; `uninstall` removes exactly
what `install` wrote; and with no Claude Code present the command creates no directory and no file.

Claude never starts a session on its own — the skill's first rule is to propose, show the prompts,
and wait for a yes.

Full write-up, including why not `UserPromptSubmit` and why the session verbs are not MCP tools:
[docs/claude-integration.md](claude-integration.md).

---

## `ci-push`

One-shot push of a **GitHub Actions** run's computed metrics to a central, attributed to
the repository it ran in. Meant to be the **last step** of a workflow that already runs Claude
Code (it does **not** run Claude) — the ephemeral runner populates `~/.claude`, then `ci-push`
sends that run's session/token/cost aggregates before the runner is torn down. It reads
everything from the environment and takes no flags.

| Env var | Required | Description |
|---------|----------|-------------|
| `AGENTISTICS_CENTRAL_URL` | yes | Central base URL, e.g. `https://central.example.com` |
| `AGENTISTICS_CI_TOKEN` | no | Repo-bound static token (fallback when OIDC is unavailable) |

Auth is **keyless GitHub OIDC** by default: with `permissions: id-token: write` on the job,
`ci-push` fetches a short-lived GitHub-signed token itself (audience = `AGENTISTICS_CENTRAL_URL`)
and the central verifies it against GitHub's JWKS. No secret needed. If no OIDC token can be
fetched it falls back to `AGENTISTICS_CI_TOKEN`. The repo must first be **registered** on the
central (Settings → Team → Repositories, which allowlists the remote and, for the fallback,
mints the token).

```bash
# inside a GitHub Actions job, after the Claude Code Action step:
curl -fsSL "https://github.com/blpsoares/agentistics/releases/latest/download/agentop" -o agentop
chmod +x agentop
./agentop ci-push
```

`ci-push` **never fails your job** — a push error (central down, unverifiable token) logs and
exits 0. It pushes **computed metrics only**, never chat. See
[`docs/github-actions.md`](./github-actions.md) for the full workflow + registration walkthrough.

---

## `autostart`

Register a mode to start with the system. On **Linux/WSL** this installs a systemd
**user** service at `~/.config/systemd/user/agentop-<mode>.service`, enables it
with `systemctl --user enable --now`, and runs `loginctl enable-linger` so it also
starts at boot without an active login. `enable` additionally installs a
`~/.bashrc` hook that runs [`agentop check-update`](#check-update) on every
terminal open. macOS and Windows print the manual step instead.

```bash
agentop autostart <mode> <enable|disable|status>
```

- `mode` ∈ `server` · `central` · `watch`
- `enable` — register + start the service (and add the terminal update hook)
- `disable` — stop and remove the service
- `status` — show enabled/active state; **omit the mode** to list all services

```bash
agentop autostart server enable    # start the dashboard at boot
agentop autostart status           # list every autostart service
agentop autostart watch disable    # stop the otel daemon service
```

---

## `upgrade`

Download and install the latest `agentop` release in place. (`update` is an alias.)

```bash
agentop upgrade
```

On a **central** you upgrade the Docker stack instead — pull the repo and rebuild:

```bash
git pull && bun run up:central    # or: agentop central pull
```

On a **member** running as a systemd service, restart it after upgrading:

```bash
agentop upgrade && systemctl --user restart agentop-server
```

---

## `check-update`

Prints the "new version available" banner **only** when a newer release exists,
and stays completely silent otherwise — so it's safe to run on every shell start.
This is exactly what the `~/.bashrc` hook installed by `agentop autostart …
enable` runs.

```bash
agentop check-update
```

---

## Update detection

agentistics surfaces available updates in three places, all sourced from the same
version check:

- **On command run** — most `agentop` commands print the update banner in parallel
  with startup (non-blocking); `--version` appends the notice too.
- **On terminal / boot** — the `~/.bashrc` hook added by `autostart … enable` runs
  `agentop check-update` when you open a shell (silent when you're current).
- **On the dashboard** — a bell notification plus a **mode-aware** upgrade modal
  showing the exact command for your role (a central shows `bun run up:central`; a
  member shows `agentop upgrade` then `systemctl --user restart agentop-server`). A
  periodic (~6h) server re-check pushes the notification live over SSE.


---

## `doctor`

Runs the exposure preflight: nine checks that decide whether this instance is safe to publish.
Exits non-zero on any failure, so going live can be gated on one command instead of on
remembering nine environment variables.

```bash
agentop doctor              # check against the current profile
agentop doctor --exposed    # check against the strict public bar

./central.sh doctor --exposed        # from a repo checkout, INSIDE the container
agentop central doctor --exposed     # same, from the standalone binary
```

**On a Docker central, prefer the `central.sh` / `agentop central` form.** The command
evaluates the configuration the deployment will actually run with — it reads `central.env` when
present and prints which file it used — but the owner-MFA and machine-token checks also need
MongoDB, which is reachable only from inside the compose network. Run on the host, those two
report as unverified, which counts as a failure by design.

`--exposed` evaluates as if `AGENTISTICS_EXPOSURE=public` were already set, which is how you
verify readiness **before** flipping it.

What it checks:

| Check | Fails when |
|---|---|
| `local-shell` | `/api/exec`, `/api/chat-tty`, the host transcript readers or `/api/mcp-action` are still reachable |
| `session-secret` | The secret is missing, shorter than 32 chars, or equal to the dashboard password |
| `tls` | `AGENTISTICS_TEAM_TLS` is unset on a public profile |
| `bind-ip` | `BIND_IP` is not loopback on a public profile — the tunnel connects locally, so anything wider is a way in that bypasses it |
| `trust-proxy` | *(warn)* forwarded-IP trust does not match the deployment, so per-IP limits apply to everyone at once |
| `owner-mfa` | Any owner account has no TOTP enrolled |
| `cors` | A plaintext origin sits in `AGENTISTICS_ALLOWED_ORIGINS` |
| `mongo-auth` | *(warn)* the database has no credentials — acceptable only while its port stays unpublished |
| `machine-tokens` | *(warn)* no machine tokens have been minted yet |

A check that could not be verified — the database was unreachable, say — reports a **failure**,
not a reassuring pass. See [exposure.md](exposure.md) for the full deployment runbook.

---

## `setup-token`

Reissues a central's **one-time owner setup token** — the token first boot prints, and which the
dashboard asks for when it creates the first owner account.

```bash
agentop central setup-token      # from anywhere
./central.sh setup-token         # from a checkout
```

Use it when the boot that printed the token has scrolled away or its log rotated. It is **refused
once an owner exists**: past that point the way back in is [`reset-password`](#reset-password), not
a fresh setup token.

Run it **where the central runs** — inside the container/host serving it, not on a member.

---

## `reset-password`

Resets an account's password from the host. This is the **only way back in for a locked-out last
owner**, so it deliberately requires shell access to the machine running the central.

```bash
agentop central reset-password                              # list the accounts
agentop central reset-password --email ana@example.com      # prompts for the new password
agentop central reset-password --email ana@example.com --password '<new>' --clear-mfa
```

| Flag | Effect |
|---|---|
| `--email <address>` | Which account. Omit to list them |
| `--password <new>` | Set it non-interactively (subject to the password policy) |
| `--clear-mfa` | Also drop the enrolled second factor — for a lost authenticator |

Every reset is written to the audit log. `--clear-mfa` removes a security control, so on a public
profile treat it as a break-glass action and re-enrol immediately: `owner-mfa` is one of the checks
[`doctor --exposed`](#doctor) fails on.
