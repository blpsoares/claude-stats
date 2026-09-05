# The artifacts aside — design

**Date:** 2026-09-03
**Base:** `origin/dev` (`14344e8e`)
**Branch:** `feat/session-artifacts`
**Status:** approved design, ready for an implementation plan
**Applies after:** the sessions-overhaul Phase 1b (the collapsed rail) and Phase 2 (the unified
header), which this design reads and does not re-implement.

---

## The problem, as it happened

A session finished writing a spec and said so:

> Spec escrito e commitado. `docs/superpowers/specs/2026-09-03-accessibility-magnifiers-design.md`,
> no worktree `.claude/worktrees/a11y-magnifiers`. … Dá uma lida e me diga se quer mudar algo.

There is no way to read it from here. The dashboard shows the conversation, the terminal, and a
path — and the path is not a document. So the reader leaves for an editor, and the workspace that
exists to be where you watch a session stops being that at exactly the moment the session asks for
something.

The same gap, seen from the other side: **while** a session is writing files, the workspace shows
prose about it. What was actually touched is in the transcript and never surfaces.

So: one aside, two halves — **what this session has touched** (live) and **the file itself**
(on demand).

---

## Where it opens — layout C

The aside opens on the RIGHT, from a `◧` button in the fixed header beside the Chat/Terminal tabs,
carrying the count of files the session has touched. It never opens by itself.

**Opening it splits the centre and collapses the fleet list to its rail.** Measured against the
sessions workspace's real geometry (fleet aside 248px, rail 64px, panel 440px):

| | conversation at 1440px | at 1280px |
|---|---|---|
| split, list kept | 752px | 592px |
| **split, list collapsed to the rail** | **936px** | **776px** |

The width comes from where it was not being read: at the moment you open a file to read it, the
session list is the least consulted thing on screen. The rail loses nothing that matters — it
carries each assistant's mark, the needs-you dot, and a tooltip with the row's whole card
(Phase 1b).

**One click doing two things is normally a defect, so it is made reversible and the reversal
sticks:**

- expanding the fleet list while the panel is open **keeps it open** — that preference is the
  user's and is remembered, and the layout degrades to a plain three-column split;
- closing the panel restores the list to **the state it was in before**, never to a default;
- below **1100px** there is no room for three columns: the panel becomes an **overlay** over the
  conversation, with a scrim, and the choice stops existing;
- on mobile it is **full-screen**, like every other full-surface view here, with a back control.

---

## Half one — what the session has touched

**It needs no server work at all, and that is the design.**

`ChatTurn.tools` already arrives on every turn as `{ name, detail }`, and `chat-tail.ts`'s
`toolDetail` reads named fields in priority order — so for `Write` / `Edit` / `MultiEdit` the
`detail` **is** the `file_path`. `SessionChat` already polls `/api/fleet/chat`. The list is
therefore a **pure function over data already on screen**:

```ts
artifactsFromTurns(turns: ChatTurn[]): Artifact[]
```

Rules:

- **Selected by tool NAME, never by the shape of `detail`.** `toolDetail`'s first key is
  `command`, so a `Bash` call's detail is a shell line; deciding "this looks like a path" would
  put `rm -rf build/` in a file list. The set is `Write`, `Edit`, `MultiEdit`, `NotebookEdit`.
- **`Read` is excluded.** The ask is what the session *produced*; an assistant reading forty files
  to answer one question would bury the two it wrote.
- One entry per PATH, not per call — a file edited nine times is one row, with its last touch time
  and a count. The row says `novo` when the session's first touch was a `Write`, `editado`
  otherwise.
- **The live edge is `ChatTurn.pending`**, which already exists and means "a tool call is in the
  transcript and no text has followed it". The newest artifact of a pending turn is the one being
  written now and says so.
- Order is most-recent-first, in two bands: **agora** (the pending turn) and **antes**.

Consequences worth stating: no new route, no new poll, no new disclosure, and the list is exactly
as fresh as the conversation beside it — the two can never disagree.

---

## Half two — the file

One new route, and it is the only part of this feature that touches the disk.

```
GET /api/fleet/file?id=<session>&path=<path>&lang=<en|pt>
```

Guarded by the existing `/api/fleet` **prefix** in `capability-guard.ts` (`localShell`) — a new
fleet route is guarded by having been added, never by remembering a second table.

**Four refusals, each a sentence, none of them a repair:**

1. **The path must be one this session touched.** The server rebuilds the artifact list from the
   same transcript the browser did and refuses a path that is not in it. That makes the reachable
   set a consequence of what the session actually did, rather than a rule about directories.
2. **`realpath(path)` must be inside `realpath(cwd)`.** Resolved on both sides, so `..` and a
   symlink pointing outside are refused rather than normalised away. Refused, never sanitised: a
   path that needed fixing is a path nobody meant to send.
3. **A binary file is refused in words**, detected by a NUL byte in the first chunk — not rendered
   as garbage.
4. **A file over `MAX_ARTIFACT_BYTES` (1 MiB) is truncated and SAYS SO**, with its real size.
   Silent truncation is a document that lies about being complete, which for a spec is the whole
   point of reading it. One megabyte is far above any spec and far below anything that would
   trouble a browser; the constant is named once, in `artifact-web.ts`, and no caller restates it.

The response carries the text, the real size, whether it was truncated, and the path relative to
the cwd. Rendering is `react-markdown` + `remark-gfm` for `.md` — the renderer the chat bubbles
already use, so a table or a code block reads the same in both places — and a plain monospace block
for everything else. **No syntax highlighting**: it would be a new dependency for a panel whose
purpose is reading prose.

The header carries the file name, the relative path, and a `⧉` that **copies the absolute path**.
It opens no editor: this server does not launch programs on behalf of a page, and a button that
pretended to would be the one dishonest control in the feature.

---

## What it does NOT do

- **It never changes what it is showing on its own.** The list updates live; the open file changes
  only when clicked. Reading a spec while the panel jumps to whatever was written last is the
  behaviour the "follow" pattern exists to avoid, and the terminal's tail already records that
  lesson.
- **It writes nothing.** No editing, no saving, no `git` anything.
- **It shows no diff.** `old_string`/`new_string` are in the transcript and a per-turn diff is a
  different feature with a different question ("what changed in that turn") and a dependency this
  repository does not have. The file as it is now is what answers "let me read it".

---

## On a central: absent, with the sentence

The list is derived from the CONVERSATION, and the conversation does not cross to a central. That
is not a new rule invented here — on-demand chat retrieval was removed from the reverse channel on
purpose (`GET /api/team/session-chat` is a 410), and `remoteSessions.ts` states that neither
consent switch grants it: *"the transcript stays where the 410 put it."*

So on a central the `◧` button is **absent**, and the workspace says why in one sentence: the
artifact list is read from the session's conversation, and that stays on the machine. What a
central can still see is the session's SCREEN, under `allowRemoteScreens` — which shows the same
work happening, as the terminal shows it.

The alternative was considered and declined rather than overlooked: the paths are already visible
in a relayed terminal frame when the screens consent is on, so carrying a structured list of them
would disclose nothing new. It is not done because it would add a field to the screen allowlist to
serve a panel whose other half is refused anyway, and a disclosure decision taken in passing is the
kind this repository is built to avoid. **Reading another machine's files is its own question, with
its own switch, on the day somebody asks for it by name.**

---

## Mobile

- No split. The panel is a full-screen view with a back control, reached from the same `◧` in the
  one bar the sessions workspace has there.
- 44px targets; the file list rows are targets, not text.
- `document.documentElement.scrollWidth <= window.innerWidth` must hold with the panel open — a
  wide code block scrolls inside its own container, never the page body.

---

## Modules

| file | what it owns |
|---|---|
| `web/src/lib/sessionArtifacts.ts` | **pure**: `artifactsFromTurns`, the tool-name set, the per-path fold, the pending edge |
| `web/src/lib/sessionArtifacts.test.ts` | the rules above, including that a `Bash` call never becomes a file |
| `web/src/components/sessions/ArtifactsAside.tsx` | the panel: the two layers, the empty states |
| `web/src/components/sessions/ArtifactDoc.tsx` | one file rendered — markdown or monospace, truncation notice, copy-path |
| `web/src/lib/artifactLayout.ts` | **pure**: which arrangement the current width and the user's own choices produce (split / split-with-rail / overlay / full-screen), and what closing restores |
| `server/sessions/artifact-file.ts` | **pure**: `planArtifactRead(path, cwd, allowed)` → allowed or a refusal code |
| `server/sessions/artifact-web.ts` | the IO: realpath, read, binary check, cap |

The refusal CODES are language-free and rendered by the caller, like `LiveUnavailableReason` and
`central-runtime.ts` — the pure module names no sentence.

---

## Testing

| module | what is pinned |
|---|---|
| `sessionArtifacts.ts` | a Bash call is never a file; Read is excluded; one row per path; `novo` vs `editado`; the pending turn is the live edge; an empty conversation yields an empty list, not an error |
| `artifactLayout.ts` | opening collapses the list; a manual expand survives; closing restores what was there; under 1100px it is an overlay |
| `artifact-file.ts` | a path not in the allowlist is refused; `..` is refused; a symlink resolving outside `cwd` is refused; a path inside is allowed; an absolute path equal to `cwd` itself is refused (a directory is not a file) |

Plus the standing gates: `bun tsc --noEmit`, `bun test`, `tokens.lint.test.ts`.

**No browser automation** — it hangs in this environment. Verify the route with `curl`, including
the refusals, and ask the user to open the page for the visual half.
