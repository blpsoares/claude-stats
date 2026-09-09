# Session manager

`agentop session` starts, lists, attaches to, names and stops assistant sessions. Background
sessions are hosted by tmux on its own socket (`-L agentop`), so they survive `agentop` exiting and
never mix with your own tmux sessions.

There are four front doors onto the same fleet and they hold ONE set of rules: this CLI, the
control center's `sessions` tab, the web dashboard, and the
[VS Code extension](vscode-extension.md). The last two reach it over `/api/fleet`, which resolves
every verb, label and refusal through the same `sessionActions` the cockpit resolves each keypress
against — a client that re-derived them would be another answer to "what may be done to this row",
and the one that went wrong would offer a blind "approve" on a dialog with four different outcomes.

## Requirements

tmux (Linux, macOS). **On Windows, run agentop inside WSL** — the CLI says so in those words rather
than reporting a generic missing dependency.

There is no native Windows backend, and the reason is recorded in `sessions/index.ts`: Bun exposes
no PTY primitive (checked against 1.3.14), and the only alternative is a native module, which cannot
be embedded in the single portable binary this project compiles to. Hosting a full-screen assistant
TUI on plain pipes renders garbage, which is a worse failure than not starting — it looks like it
worked. When a PTY primitive lands in Bun, `backend-pty.ts` slots in behind `SessionBackend` and
nothing else changes.

## Commands

    agentop session <harness> [-p "prompt"] [--bg] [--model <id>] [--effort <level>]
                              [--cwd <path>] [--name "label"] [--task "<name>"]
    agentop session ls     [--all] [--group none|tree|status|repo|project|task|harness|model|marked]
                           [--json] [--width <n>] [--no-color]
    agentop session list   [--json]
    agentop session attach <id|name>
    agentop session kill   <id|name>
    agentop session rename <id|name> "label"
    agentop session note   <id|name> "text"

### `ls` — the cockpit's table, printed once

`ls` is the fleet for a PERSON to read: the same table the cockpit's fleet pane draws, printed to
stdout and gone. Only what is running, grouped by project — `--all` adds the finished, lost and
closed conversations, `--group` changes the sections.

    agentop session ls                    # what is running, by project
    agentop session ls --all --group repo # everything, by repository
    agentop session ls --group tree       # the CASCADE: project as root, directories as branches
    agentop session ls --json             # exactly what `list --json` prints

It draws by CONSUMING the cockpit's own arithmetic (`packages/tui/src/control/sessions.ts`) rather
than by re-implementing it: `sessionColumns` measures the page so the columns line up, `groupSessions`
and `sessionRows` decide the sections and the air between them, `sessionRunning` decides what
"running" means — an `external` row included, since it exists because a live assistant process was
found. A second copy of any of those would be a second set of rules that agree until the day they do
not, which this repository has already paid for once. What `agentop session ls` owns is the
DRAWING: ANSI written to a terminal instead of Ink components, the width taken from
`process.stdout.columns`, and a final clip so no row can wrap.

`ls` is a new command rather than a flag on `list`, because `list` is the tab-separated dump scripts
already read line by line. Its output does not change.

Piped output is plain: `process.stdout.isTTY` decides colour (`NO_COLOR` and `--no-color` override
it), and a pipe gets no invented terminal width — the table comes out as wide as its content, so
nothing is truncated to fit a terminal nobody is looking at.

A pipe can still SAY how wide it is, though, and a pager is a reader: `resolveWidth` takes `--width`
first, then the terminal's own columns, then **`COLUMNS`** when there is no tty to ask, and only then
the natural width. `COLUMNS=80 agentop session ls | less -S` therefore fits 80 columns instead of
handing `less` a row it has to break. A `COLUMNS` that is not a width falls through rather than
throwing, and no minimum is imposed on one that is — a caller asking for twenty columns gets twenty,
and the clip is what keeps the rows inside them.

## Orchestrating several at once

The form an ASSISTANT should drive. It exists because doing this through the single-session command
means N invocations, N ids to scrape out of N lines of prose, and no way to say the sessions belong
together — so the caller ends up holding state the tool could have held.

    agentop session batch --task "<name>" [--cwd <path>] [--model <id>] [--effort <level>] \
                          --session "<harness>[@<cwd>]: <prompt>" [--session "..."] [--json]
    agentop session open  "<task>" [--json]

Three assistants on one repository, in parallel:

    agentop session batch --task "auth-refactor" --cwd ~/app --json \
      --session "claude: refactor the token store" \
      --session "codex: port the tests" \
      --session "gemini: review the migration"

Every session starts detached — a batch has no single terminal to hand over — and all of them are
filed under the task, so `open` brings the whole task back later and the cockpit groups them
together. `--cwd`/`--model`/`--effort` given before the sessions are defaults for all of them; an
`@<cwd>` on a session overrides it.

`--json` prints the started ids as data, and `agentop session list --json` reads the fleet back the
same way — id, status, activity, task and the conversation id each row could reopen. A session that
fails to start does NOT abort the rest: four that started are four that are running, and every
outcome is reported.

### Letting Claude Code drive it

`agentop hooks install` installs a skill that teaches Claude Code exactly the contract above — so
when a task splits into independent pieces, Claude proposes the split, writes each session's prompt
and runs the `batch` itself, once you approve. A companion `SessionStart` hook tells each new
session which agentop sessions are already running and which task can be reopened where it started.
See [docs/claude-integration.md](claude-integration.md).

## The cockpit

`agentop` → the **sessions** tab. It is three framed panes — a menu, the fleet, and a detail pane
under both — and the one holding the keyboard wears an accent border, so "where am I" is answered by
the screen rather than remembered.

### The menu

Everything the screen can do is on the left, visible and clickable: **actions**, **view**, **show**,
**tasks**, **projects**. Each block is its own box; the one you are in is open and the rest keep
their NAME on a single row, so nothing is ever hidden behind a fold that does not announce itself. A
terminal tall enough opens every block at once.

Sections are numbered. `1`–`9` jump straight to one, from the fleet list as well as from the menu,
and `←`/`→` step between them — a soft keyboard has no arrow keys, so the digits are the way in that
always exists. Clicking a collapsed name opens it.

### The fleet

The list holds everything — sessions agentop runs, assistants running beside it, and conversations
that are closed — in sections, with history always separated from what is live. Columns are measured
across the visible rows and carry a header, so the handle, state, name, worktree, task, usage,
harness and project line up and say what they are. The handle is the first characters of the session
id — `agentop session attach 3f5f` resolves a prefix, so it is the one thing on the row that names
the session to something other than this screen.

**What you named, you keep seeing.** A row you gave a name, a note or a task is never withheld by the
history switches. A machine restart makes every managed session `lost`, and without that rule the
list came back empty after a reboot — with the session you had renamed and filed under a task gone,
and the name with it.

The **state** block is the finer answer: one row per state — needs approval, waiting, working,
exited, lost, closed, external — each with how many sessions wear it, ticked or not. Ticking any of
them replaces the two switches entirely; unticking the last one falls back to them rather than
showing nothing, which is never what unticking a box means.

The **order** block sorts by urgency (the default — what is blocked on you, first), name, start
time, usage or project. Picking the order already in force flips its direction, which is the gesture
every table has and the only one that does not need a second control. Every key keeps state as its
tiebreak: a screen sorted by name that buries a session waiting on approval among nine idle ones has
lost the thing it is for.

`space` **marks a row** — a highlighter, not a selection. The mark is a bar in the gutter beside the
cursor caret, in a different colour from the accent (which means *focus* everywhere else in this
app, so a highlight wearing it would read as "this is selected" on four rows at once), plus the name
in that colour. It is kept by session id, because the list re-sorts under it every five seconds and
a mark meaning "the third row" would be on someone else's session by the next poll — and it survives
detaching, which is exactly when you needed it.

The detail pane has its own switch (`d`), written on the pane itself as well as offered in the
*show* block — a control for a thing you are looking straight at belongs on the thing. It is a pane, not a fact, and a screen is allowed to be a
list — but a QUESTION still takes the region whatever the switch says, because a prompt with nowhere
to draw cannot be answered.

**`only active` (`l`) counts EXTERNAL sessions as active**, because an external row exists precisely
because a live assistant process was found: what cannot be read there is its activity, never whether
it is running. It is the one switch that overrides the rule above, and it is why it leads the *show*
block. The rule above is right by default, but on a machine with months of named work it shows all
of it; this is how you ask for the four things you are actually doing and nothing else. Everything
else in that block can only ever widen.

`/` searches all of it, including a closed conversation's opening prompt, which is what a person
actually remembers about work they put down. `esc` drops the search, then the project scope, then the
task scope — the summary row states what is narrowing the list and which key clears it.

### The view, and the default

The list opens as **only active conversations, grouped by project**, and every change you make is
remembered across runs.

That default is strict on purpose, and has one consequence worth knowing: when nothing is running,
it shows an empty list. The screen says *why* and names the key that lifts it — the sessions a
reboot turned into `lost` rows are still there, still named and still reopenable, so "no sessions"
would be false, and a blank pane under a strict filter is indistinguishable from a broken one. `ctrl+r` puts it back to that default — every switch here is sticky, which
is also how an arrangement you fiddled with weeks ago follows you around.

Grouping by **repository** is the other useful one: a session is opened in a directory, but the thing
a person thinks in is the repository, and three worktrees of `agentistics` are three places to work
on ONE project. The repository is keyed by the git REMOTE wherever there is one — the only key a
worktree provably shares with its main checkout, since their directory names deliberately differ —
and falls back to the main checkout's folder name.

**By project** keys on the main checkout too, not on the directory: a session opened in
`agentistics/.claude/worktrees/session-monitor` files under `agentistics`, and the worktree column
says which checkout it is. Keying on the directory name filed three checkouts of one project as
three projects, which is the split the repository dimension exists to avoid — and since this is the
default grouping, it was the first thing anyone saw.

**The cascade** (`tree`) is the middle between those two. Grouping by project puts every worktree and
every package of one repository in one undifferentiated run, so the band says *which* project and
nothing about *where*; grouping by directory files one project as N unrelated names. The cascade
takes the project as the root and the segments of each session's directory below it as branches,
joining any chain that never forks — `.claude/worktrees/session-monitor` is one row while it is the
only worktree, and a second one splits `.claude/worktrees` out as a node with two children under it.
The list indents each branch; the card grid, which has no indentation to spend, titles each band with
the whole crumb (`agentistics › packages/server`), cut from the LEFT so the segment that identifies
the node is the last thing given up.

It is an **arrangement, never a dimension** — it groups and cannot filter. Every other grouping is
also a filter, and the two read the same rule, so a chip and its band always show the same rows. A
tree node cannot honour that: a session belongs to every node on its path, so "filter to `packages`"
and "the band `packages`" could never agree.

Its branches come from a fact rather than from string-matching: the main checkout's own PATH, read
from the common git dir and recorded at spawn beside the repository. Where there is none — outside a
repository, or a directory that is gone with nothing recorded — the session hangs straight off its
root with no branch, and a worktree created *outside* the main checkout gets one branch named after
its own folder. A relative path that cannot be established is never invented.

**A directory that no longer exists** is its own case, and not the same one as a directory outside a
repository. Removing a worktree leaves the session registered at a path that names nothing: git
cannot be asked anything about it, so the grouping used to fall back to the last segment of that path
and a removed `member-connect-rotate` appeared as a project of its own, standing next to
`Agentistics` — the project it was a worktree of. A folder name is a guess when the path resolves to
nothing, so two things happen instead. The repository is **recorded when the session starts**, which
is the one moment the directory is provably there, and a row whose worktree is later removed keeps
the project it belonged to. Where nothing was recorded — a row from an older build, or a conversation
the store remembers without a registry entry — the row is filed under **"directory no longer exists"**
and says so on its detail pane, which is also the answer to why reopening it will fail. The folder
cell still names the directory, because that *is* where the session was.

### Where a session continues from

A row can name the conversation it is writing, and that is what `--resume` takes. It is **recorded,
never inferred**: agentop hands the id to the CLI when it starts the session (`claude --session-id`,
`copilot --session-id`) or when it reopens one, so there is nothing left to guess. Claude also writes
its own record while the process lives, which is read as well.

**antigravity is linked a third way.** It has no assign flag — measured against agy 1.1.27 on
2026-09-08, `agy --conversation <fresh-uuid>` answers `warning: conversation "…" not found` and then
creates one under an id of its own — and it writes no session record. What it does do is open one
log per process, `~/.gemini/antigravity-cli/log/cli-<YYYYMMDD_HHMMSS>.log`, **hold it open** for the
life of that process, and write `Created conversation <uuid>` into it. So the chain *managed row →
tmux pane pid → open file descriptor → log → conversation* is exact at every step, and agentop reads
it (`agy-conversation.ts` for the rules, `process-conversation.ts` for the two reads).

That route mattered more for agy than it would for anyone else, because for a session **agentop
started** even the harness-and-directory fallback below is closed: the adapter takes a
conversation's `project_path` from the global `history.jsonl`, and agy writes that file only for a
prompt typed in its own UI — a session agentop starts is handed its first prompt as
`--prompt-interactive`, so its record carries an empty `project_path` and is not a candidate for
anything. Measured the same day: 15 of 38 agy conversations here had a directory recorded, and the
23 without were exactly the ones agentop had opened. Its chat view was therefore permanently empty
while its terminal worked perfectly. The limit worth stating: this is a `/proc` read, so off Linux
there is no link and the chat view says "this session has no linked conversation yet", which is
true.

For codex, kimi and gemini no such link can exist — those CLIs invent an id and never
report it — so the row says so rather than showing a guess. The fallback everything else uses matches
by harness and directory, which gives *every* session of one repository the same conversation: good
enough to offer a reopen you confirm by its title, not good enough to be presented as the conversation
you are in. A row that does know its conversation never falls back to that guess, even in the minutes
before the transcript exists: "not written yet" and "some other conversation in this directory" are
different answers.

### One row per session, and a name that outlives the process

A session's durable identity is its **conversation**, but the registry keys a record by the
per-spawn managed id — a new one every time a session is attached, reopened or restarted. Each of
those retires the record it replaced (`endedAt`) without removing it, so a conversation reopened five
times used to stand on screen as five `exited` rows beside its one live continuation, all wearing the
same name. The list collapses those: a retired predecessor is hidden **only** when it is provably
dead (`endedAt` is set) **and** superseded by a row of the same conversation — a live one, or a newer
ended one, which *is* that session continued. A live row is never hidden, a `lost` row with no
recorded end (a reboot) is never hidden, and the newest ended row of a conversation with nothing live
is kept, because it is the one you reopen. Two rows that merely share a directory or a label are left
alone: only a shared **conversation id** proves two rows are one session, so the list never merges
sessions that are genuinely distinct.

A **title is an identity**: whatever a session is called while it runs, it stays called after it
ends. The name you give a session from *inside* Claude Code (`/rename`) lives only in the harness's
own record, which Claude deletes when the process exits — so a finished session used to lose that
name, its displayed title fell back to a different source, and `CTRL+F` could no longer find the row
by the name it wore a second earlier. agentop now captures that name into the registry while the
session is alive, so the title is the same before and after it finishes. Only a name a person typed
is kept; a name the harness invented for itself never displaces your own label.

### Tasks

A task is whatever you say it is: a free string, chosen while starting a session or added later, and
several sessions carrying the same one are that task's sessions. The menu lists them with counts, a
task scopes the list, and **Open whole task** brings all of its sessions back at once.

Reopening a task is safe to press twice. A session still running is left alone rather than duplicated,
one you finished is not resurrected, one whose conversation cannot be resolved is skipped *and
counted*, and everything reopened retires the row it replaced — so a laptop closed and opened twice
does not leave a task holding dead twins under one name. Names, notes and task stay with the session
through a reopen.

A task can be marked **finished**, which puts its sessions away behind a switch beside "closed" and
"exited". It stops nothing and deletes nothing.

### Attaching

`enter` opens the menu for the selected row; `o` attaches. Attaching unmounts the app, hands the
terminal over, and comes back to this tab when you detach — the detach keystroke is read from your
own tmux prefix and stated on the row before you press anything, never assumed.

Pressing `o` on a row with nothing running asks whether to pick that conversation back up instead of
refusing — external sessions included, since agentop did not start those but the conversation is on
this disk either way. `x` stops a session; it is deliberately not `k`, which moves the cursor.

### Starting one

`a` opens the wizard: harness → folder → task → model → effort → prompt → background or attached.
The folder step is a searchable table of every directory under your home — folder, repository, path
and why it is being offered — grouped by repository, with the directory you are standing in first.
It reads the local store, so it works with the server stopped.

`--bg` detaches and returns immediately. Without it the session takes over your terminal; the detach
keystroke is printed before it does. `--cwd` defaults to the directory you are in.

## What a session is doing

`agentop session ls` / `list` report a state per session:

| State | Meaning |
|---|---|
| `working` | its screen moved since the last look, or a harness-specific "running" marker is on it |
| `waiting` | alive and still — it is waiting for you |
| `NEEDS APPROVAL` | a blocking question is on screen |
| `exited` | the command finished; the session is still listable and its last frame readable |
| `lost` | the registry knows it, the backend does not — a reboot puts every session here, and each one keeps its name and offers Reopen |
| `external` | an assistant running on this machine that agentop did not start — listed, but not attachable |

There is deliberately no `idle`. An interactive assistant that is alive and whose screen has stopped
moving is waiting for you; there is no third thing it could be doing. What cannot always be known is
*why* it is waiting.

Telling a blocking question apart from an ordinary pause needs screen markers captured from the real
CLI, so it exists only for the harnesses that were probed (claude, codex, kimi). For any other
harness a blocking question shows as `waiting` — still counted, still surfaced, but the reason
cannot be named. `ls` and `list` both say so rather than leaving you to assume otherwise.

The states are also honest about their own timing, and deliberately biased. A single frame is a
noisy sample: a session that has just finished a turn, or one whose pane a plugin repainted for a
moment, reads `working` on one poll and `waiting` on the next with nothing about it having changed.
Believing that lone `waiting` is how the counter came to say "waiting on you" about a session that
had already gone back to work — a false summons that wastes the most expensive resource here and,
once it has cried wolf, stops being read. So the two directions are confirmed differently
(`attention-confirm.ts`): **`waiting` and `NEEDS APPROVAL` are believed only once the same reading
has held for two consecutive polls**, while a return to `working` (a screen that moved — unambiguous
proof) and `exited` are believed at once. The counter therefore never spikes on a single quiet
frame, and it DROPS on the very next poll after work resumes. The cost is that a genuine wait takes
one extra interval to appear — the cheap direction, since a slightly late "needs you" only delays a
person while a false one wastes them. The event channel (`agentop events`) confirms every transition
the same way for the same reason, so the two surfaces agree on when a session starts waiting; the
fleet display just clears it a poll sooner.

## Harness support

| Harness | Prompt | `--model` | `--effort` |
|---|---|---|---|
| claude | positional argument | yes | `low, medium, high, xhigh, max` |
| codex | positional argument | yes | not supported |
| gemini | `--prompt-interactive` | yes | not supported |
| antigravity (`agy`) | `--prompt-interactive` | yes | `low, medium, high` |
| kimi | typed into the session | yes | not supported |
| copilot | typed into the session | yes | not supported |

`kimi` and `copilot` have no flag for an initial prompt in an interactive session — their `-p` runs
one prompt non-interactively and exits — so agentop types the prompt in once the session is up.

**Delivering the initial prompt is READINESS-GATED** (`initial-prompt.ts`), not a fixed sleep. A
detached session created with a prompt has to receive it with no human in the loop, and two things
used to break that silently: a slow-starting harness lost a prompt typed after a fixed 1200 ms into
a pane that had not drawn yet, and a positional prompt was left entirely to the CLI to auto-submit —
which some versions do not do (the prompt "stays in the field" and the agent sits waiting for
something that already arrived). So agentop now polls the pane and delivers only once the harness is
genuinely ready — its input surface drawn, and NOT sitting on a startup/approval dialog — and then
once: a typed harness has its text typed and submitted; a positional harness whose "working" marker
lets us tell an auto-submitted turn from an idle prompt (claude) gets a single Enter to submit the
pre-filled text, but only after it has sat idle for a few polls without ever running, so a CLI that
DOES auto-submit is never double-submitted. It is never delivered into a dialog — launched in a
folder it does not yet trust, claude opens with a trust prompt whose default is "No, exit", and a
blind early Enter would select it and kill the session.

Codex's reasoning effort is a `-c key=value` configuration override rather than a flag; it is not
wired up because the key could not be verified from the CLI itself, and agentop does not guess flags.

### Reading the conversation

The Sessions workspace can show a session's **conversation**, not only its terminal screen. Whether
it can for a given row depends on two independent things, and confusing them cost the feature its
honesty once already — an Antigravity session with a perfectly good link showed a blank pane with
no sentence on it, because the only transcript reader that existed was Claude's.

**1. The LINK — is this row's conversation id exact?** A reader is only ever handed a
`conversationId`, and `ManagedSession.conversationId` is written only where agentop itself handed
that id to the CLI (`SpawnSpec.assignId` at spawn, or `resume` at reopen). The harness-and-directory
inference behind the reopen offer never reaches a reader: it is good enough to offer a reopen a
person confirms by title, and not good enough to put some other conversation from the same folder on
screen under this session's name.

**2. The FORMAT — has anybody written a reader for it?** `harness-transcript.ts` holds one entry per
harness. An absent reader is refused in a sentence that names the harness, never rendered as an
empty conversation.

| Harness | Exact link comes from | Transcript read from |
|---|---|---|
| claude | `--session-id` at spawn, plus its own `~/.claude/sessions/<pid>.json` | `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` |
| copilot | `--session-id` at spawn | `~/.copilot/session-state/<id>/events.jsonl` |
| codex | `codex resume <id>` | `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` |
| kimi | `--resume <id>` | `~/.kimi-code/sessions/*/session_<id>/agents/main/wire.jsonl` |
| antigravity | `--conversation <id>` | `brain/<id>/.system_generated/logs/transcript_full.jsonl` |
| **gemini** | **never** | — |

**Gemini can never be read here, and that is a fact about the LINK.** Its `-r, --resume` takes
`latest` or an index rather than an id, and `--session-id` is deliberately not used because gemini's
session id in this product is synthetic (`<dir>/<file>`), so a recorded UUID would resolve to nothing
while looking exact. A gemini row therefore never carries a conversation id at all; the row says so
(`conversationBlind`) and the workspace hides the chat tab rather than offering one that cannot work.
A reader for its file format would be code nothing can reach. Its format is nonetheless recorded in
`harness-transcript.ts` so the measurement is not spent twice: it is a patch log rather than one
message per line.

The same applies, per row, to any harness whose session was **started fresh** without an id.
codex and kimi only gain the link on a reopen (or once the first-sighting claim can settle it), so a
freshly spawned row of those two is blind until then, and says so. **antigravity is no longer one of
them** — its per-process log names the conversation it created; see above.

#### Three rules every reader follows

Each was a real defect first, in a different harness each time.

- **The same turn is often written twice, in two different places.** Codex writes
  `event_msg/{user,agent}_message` beside `response_item/message`; kimi writes `turn.prompt` beside
  `context.append_message`; antigravity writes the tool REQUEST beside its EXECUTION. Exactly one
  family is read and the other is ignored outright, and the one read is the SUPERSET — measured,
  codex's `event_msg` covers 21 of 42 user messages and kimi's `turn.prompt` 15 of 22, so choosing
  the smaller one silently drops turns.
- **What nobody said is never drawn as a message.** Every harness puts its own injected material
  under the user's role and each declares it differently: kimi stamps `message.origin.kind`, copilot
  keeps the person's `content` apart from a wrapped `transformedContent`, codex has a `developer`
  role plus `<…>` envelopes — and codex also has entries with no marker at all (measured: 11 of 32
  untagged user messages were the harness loading an `AGENTS.md`). Those become unattributed notes
  that NAME the kind and never carry the body. An entry nothing recognises stays the person's:
  hiding a real message is the expensive direction.
- **A tool call is shown under the harness's OWN name.** A conversation records what happened, and
  antigravity ran `run_command`, not `Bash`. The shared vocabulary (`canonicalTool`) is carried
  alongside as `canonical` and is what anything selecting or counting reads — the artifacts panel
  picks the file-writing tools by Claude's names and keeps working for every harness. A shell
  detail goes through `commandSummary`, so a session that opens every command with `cd <dir>` does
  not draw a column of identical `cd` rows.

## Scrolling an attached session

Sessions are hosted on agentop's own tmux socket (`-L agentop`), and agentop sets its options on it
as part of creating the first session: the colour profile (below), `remain-on-exit` (a finished
session stays listable with its last frame readable), `mouse on`, a `history-limit` of 50000 lines,
and `status off`.

All of it goes in **one chained tmux invocation** with the `new-session` it precedes, and that is
not a style choice. `set-option` does not start a tmux server — on a cold socket it fails outright —
so applied as separate pre-flight calls the options were simply lost, and the very first session
kept tmux's defaults (8 colours, no mouse, a 2000-line buffer) until a second session happened to
warm the server. Chaining runs every command against the single server tmux starts for the batch,
in order, so an option that must precede its pane actually does.

**Colour — a pane inside tmux should render like the CLI does outside it.** tmux's own
`default-terminal` is `screen`, which advertises 8 colours, so a CLI in the pane self-downgrades
even when the terminal you attach from does 256 or truecolor (measured on tmux 3.2a: `tput colors`
is 8 inside such a pane against 256 outside). agentop sets `default-terminal` to the richest
256-colour terminfo entry that provably exists on the host — `tmux-256color`, else `screen-256color`
— which takes the pane to 256; a host with neither keeps tmux's default rather than naming an entry
that is not installed. This is safe for every client because tmux downsamples per attach.

Truecolor is added only when the terminal that *invoked* the session declared it (`COLORTERM` =
`truecolor`/`24bit`), and it is keyed to that terminal's own `$TERM`: a `terminal-features
,<TERM>:RGB` capability (appended, so tmux's built-in features survive) plus `COLORTERM=truecolor`
carried into the pane so the CLI actually emits 24-bit. Keying to the invoker's `$TERM` is the
compatibility guarantee — a different, less capable client attaching later never matches it and is
rendered at 256 rather than fed RGB it cannot show. `-2` (force-256 on attach) was evaluated and
left out: its effect on the attaching client could not be measured on 3.2a, and agentop does not
ship a flag it could not verify — the attaching client's depth follows its own `$TERM` terminfo,
which is exactly the terminfo the CLI would use outside tmux.

The status bar is off because every fact it carries is wrong here: it lists windows and an agentop
session is one window with one pane, it shows the session name and that name is `agentop-<id>`
rather than anything a person chose, and the cockpit you came from already shows all of it. It costs
a row of the assistant's screen to say nothing, in a colour that is hard to ignore.

The mouse is what makes the wheel scroll at all — without it a pane shows the last screenful and
nothing else, so attaching to a session to read what it did was attaching to a session you cannot
read. The trade is that dragging to select now goes to tmux rather than to your terminal: **hold
shift** to select and copy the terminal's own way.

The scrollback and `default-terminal` are set up front because neither applies retroactively — a
pane created before them keeps tmux's default 2000-line buffer and 8-colour `screen` for as long as
it lives. Sessions started by an older agentop therefore keep the small buffer and the flat colours
until they are reopened; the mouse, being a live server option, applies to them immediately.

None of this touches your own tmux: different socket, different server, different config.

## Where state lives

`~/.agentistics/managed-sessions.json` — the sessions agentop started, with their labels, notes and
tasks, and an `endedAt` on the ones that are over. tmux is authoritative about what is RUNNING; this
file is authoritative about what it MEANS, which is why a reboot takes the first and leaves the
second. A session is marked finished rather than deleted: it is still a thing that happened, and
reopening it is the ordinary next thing to want. It also holds `harnessName` — the `/rename` name
captured from the harness while the session was alive, so the title survives after the harness
deletes its own record.

`~/.agentistics/preferences.json` — `sessionView` (how the list is arranged, including
`searchScopes`: which fields the search looks in) and `finishedTasks` (the tasks you marked done).
Both are properties of this machine rather than of any session, which is why they do not live in the
registry. `searchScopes` is a set — name, folder, harness, note, task, prompt, transcript — so the
"all" control is simply every scope present; when it has never been chosen the search covers every
field a row carries on its own, and `transcript` (a text scan of the conversation on disk) is an
explicit opt-in rather than a cost paid on every keystroke.

## One poller, many readers

The cockpit, the web workspace, `agentop session ls` and `agentop hooks context` all describe the
same fleet, and they used to each run their own poll. That is not merely wasteful — they disagreed:
four sessions in the browser against three in the terminal, at the same moment, on the same machine.
A frame digest, a heartbeat and an attention state are all *per poller*, so two pollers are two
answers.

`GET /api/fleet/snapshot` serves the **raw `SessionSnapshot`** (`shared-snapshot.ts`), and every
one-shot reader takes it whenever a server is up, falling back to its own read when none is. Two
rules keep it honest:

- **The route serves the RAW snapshot, not the mapped `ControlSession` rows.** It briefly served the
  mapped ones under the snapshot's type, and `session ls --json` answered `activity: null` on every
  row — caught by reading the output, not by reading the types.
- **A one-shot command never stamps `lastSeenMs`.** The heartbeat is what makes crash-grouping exact;
  a `session ls` that touched it would make every row look alive at the moment somebody listed them.

## Rows that are not what they look like

Four fixes that all come from the same place — a row must say what it IS, and never guess:

- **A CLI command is not a live session.** `NOT_A_SESSION` filters the process scan, so
  `agentop session ls` typed in a terminal stopped appearing in its own output as an assistant.
- **One external row per SESSION, not per process.** A harness installed as a `node` shim spawns
  more than one process for one conversation; each was becoming a row.
- **An unregistered row says what it is instead of `?`.** A running session whose registry record is
  gone is now adopted where the harness's own record names our tmux session
  (`session-adopt.ts`), and where it cannot be, the row says `unregistered` rather than showing a
  question mark for a name.
- **A stale row and a lost conversation stop sharing one sentence.** They are different facts and
  they send the reader to different places.

## Two failures the fleet used to report as "empty"

- **A tmux that cannot be reached.** `list()` now throws unless `tmuxListIsEmptyState(code, out, err)`
  says the failure really is the no-server case — and that rule reads **stderr**, where tmux actually
  writes `error connecting to …`. Judging stdout alone would have made a machine with no tmux server
  (the ordinary first-run state) throw on every poll.
- **Two processes holding the registry lock.** `registry.ts` serialises writes within ONE process,
  and agentop runs as several. The lock's ENOENT branch used to `rm` the file it had just failed to
  find, which is how two holders happen; a vanished lock now retries and an abandoned one is taken
  over by an atomic `rename`. Measured before and after over 600 concurrent writes: 31 losses in 150,
  then 0 in 600.

## The per-session utility shell

A real shell — a full PTY, so `vim`, `htop`, colours and `Ctrl+C` all work — opened in a session's
own directory, for the person rather than for an assistant. Phase 1 is the server half: it can be
opened, listed and closed through `/api/shell/*`, and it is verifiable with `curl` and `tmux` alone.

### It is not a session, and that is structural

A shell runs on its **own tmux socket** (`SHELL_SOCKET` = `agentop-shell`) and records itself in
`~/.agentistics/shells.json` — never in `managed-sessions.json`. Both halves are load-bearing.

On the fleet socket it would become a fleet row, silently: `idFromTmuxName` strips the `agentop-`
prefix, so `parseTmuxList` keeps the session, and `reconcileSessions` then finds a running session
the registry has no record of and calls it `unregistered` — the row `session-adopt.ts` describes as
"visible and inert", filed under `GONE_PROJECT_KEY`, that no verb in the cockpit can act on.

In the registry, each shell would join the pane walk `host.sessions()` performs every 5 s in four
processes (~200 ms measured), be probed by `attention.ts` for dialog markers, take a `lastSeenMs`
heartbeat, and count toward "N sessions waiting on you" — so an `htop` would read as a session
needing a person.

A naming convention would have worked and been one refactor away from breaking. A socket cannot
break: `list-sessions -L agentop` cannot see another socket at all. `shell-isolation.test.ts`
asserts it over the modules' own source, with comments stripped first — those modules are *required*
to explain themselves in terms of the registry.

### Two gates, and absent reads OFF

- `CAPS.localShell` — the exposure profile's answer, already false outside `local`.
- `preferences.shellEnabled` — the user's own switch, which may only ever NARROW.

A raw shell is strictly more powerful than the chat, which `chat-gate.ts` already calls the most
powerful thing this server does: the chat at least spawns a NAMED assistant CLI. So absent reads as
OFF, it is a separate switch from `chatEnabled`, it is enforced in `index.ts` before the routes
rather than only in the UI, and a central refuses outright.

### A ceiling, never a timer

`SHELL_CAP` is 8, stated once in `shell-spec.ts`. A TTL would kill the `bun test` that finished at
minute 61 and whose output somebody wanted, at an hour nobody was watching, and it needs a timer
running for the life of the process. A ceiling needs nothing running: one check, on open, and it
only ever closes something at the instant somebody is asking for a new one.

Records go one way (`reconcileShells`): a pane that is gone is dropped — typing `exit` is the
ordinary death of a shell — and a pane with **no** record is not adopted, the exact opposite of
`session-adopt.ts`, because a shell carries no name, task or conversation worth recovering.

### The four refusals, and their order

`no-tmux`, `no-cwd`, `cwd-missing`, `at-cap` — codes, rendered into sentences by the route so the
deciding module stays language-free. The IMPOSSIBLE ones come before the merely FULL one: at the
ceiling the caller asks the person to close a shell to make room, and asking somebody to destroy
work to make room for an open that could never have succeeded is worse than saying no.

A session whose directory is gone is refused by name — it never falls back to `$HOME`. Opening a
shell somewhere other than where it was asked for is the same class of error as a confident `0` for
a metric nobody can produce.

### Seeing it and driving it — the two channels

A shell has the same two channels a session has, and the browser reads and writes both with one
implementation:

| | session | shell |
|---|---|---|
| read | `GET /api/fleet/stream?id=` | `GET /api/shell/stream?id=` |
| write | `WS /api/fleet/input?id=` | `WS /api/shell/input?id=` |

Everything generic is shared — the frame shape (`terminal-stream.ts`), the one-loop-per-watched-pane
hub with its dedup and its death handling (`terminal-hub.ts`), the serial write queue and its
per-key acks (`input-channel.ts` / `input-protocol.ts`). What is **not** shared is the one rule each
channel keeps: **scope**. `terminal-web.ts` and `input-web.ts` resolve an id against
`managed-sessions.json`; `shell-stream-web.ts` and `shell-input-web.ts` resolve it against
`shells.json`. Reusing the fleet's modules would have given a shell id the fleet's answer, and it
would still have worked — so `shell-isolation.test.ts` asserts the absence of those imports over the
modules' own source, and `shell-terminal.ts` (the pane I/O) takes its tmux runner injected so the
socket discipline is provable without a tmux server.

`Escape` joined `KEY_ALLOWLIST` for this, on both sides, and the reasoning is the line that set
draws: Escape **cancels** and controls no process, so it belongs with the editing keys rather than
with `C-z`. A soft keyboard has none at all, so without it there is no way out of `vim` from a
phone; and a Claude Code permission dialog's own footer says `Esc to cancel`, which this channel
could not reach for as long as the set excluded it.

### The band, and the unwatch discipline

The band is the **last** strip of the session panel, below the composer — the VS Code geometry —
with a drag handle on its top edge that also answers the arrow keys. On mobile it is a full-screen
sheet with a back control and the key strip `esc tab ctrl ↑ ↓ ← →`; `ctrl` is a **sticky modifier**,
because a soft keyboard has no chord to hold, and a letter the channel would refuse yields nothing
rather than composing a key that earns a `bad_key` ack.

**The capture loop runs only while the band is open, this session is selected and the tab is
visible** (`shellWatching`, pure). It is the only per-second cost the feature has — two tmux reads a
second per watched pane — and it is the rule `terminal-web.ts` already states for the fleet's own
channel: a surface that forgets to unwatch leaves a `capture-pane` loop running for a screen nobody
can see. Handing `useTerminalStream` a `null` id is what drops the subscription; the server's hub
then stops capturing as its last reader leaves.

There is no arm/disarm here, unlike the fleet terminal's composer: **opening the shell is the
consent**, and the server refused the whole route unless the capability and the switch both stood.

### Verifying it

```bash
AGENTISTICS_DIR=/tmp/shell-check PORT=48291 WEB_PORT=48292 bun run packages/server/bin/cli.ts server

curl -s -X POST localhost:48291/api/shell/open -d '{"sessionId":"<id>"}' \
  -H 'Content-Type: application/json'      # {"error":"shell_disabled"} until the switch is on

curl -s -X PUT localhost:48291/api/preferences -d '{"shellEnabled":true}' \
  -H 'Content-Type: application/json'

tmux -L agentop-shell ls    # the shell is here
tmux -L agentop ls          # and never here
```

Measured on 2026-09-09: the switch refused before it was flipped; the shell opened in the row's own
cwd; it appeared under `-L agentop-shell` and in neither `-L agentop` nor `/api/fleet`; the ninth
open was refused in words; a pane killed outside agentop left no ghost record; and `close` named an
unknown id instead of counting it closed.

Measured again on 2026-09-09 for the two channels: the SSE stream carried the real pane, colours and
all; a shell id on `/api/fleet/stream` and a fleet id on `/api/shell/stream` were both a clean 404,
as was a fleet id on the shell's WS upgrade, and a cross-origin upgrade was 403; typing
`echo …` + `Enter` over `WS /api/shell/input` acked `ok` and the output came back on the read
channel, while `C-z` — outside the allowlist — acked `bad_key`. In the browser, counting
EventSources: opening the band opened one stream and closed none, collapsing it closed one,
re-opening opened a second, and backgrounding the tab closed it. At 390px `scrollWidth` equalled
`innerWidth`, every control in the sheet measured 44x44, and the inputs computed to 16px.
