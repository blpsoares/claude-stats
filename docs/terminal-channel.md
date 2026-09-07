# Live terminal channel

`GET /api/fleet/stream` streams a managed session's terminal — the actual screen a coding assistant
is drawing, colours and all — to the browser over SSE, so the sessions tab can show what an agent is
doing without anyone opening a terminal and running `tmux attach`.

This is the **server contract** the web dashboard consumes. The web side (the terminal panel and its
emulator) must build on exactly this — it does not invent its own endpoint.

**This channel (Phase 1) is read-only.** No keystrokes reach the session through the *stream* — a
`frame` only ever flows server → browser. The **write** half is a separate concern with its own
contract: the line-oriented interactive composer built on `POST /api/fleet/act { action:'prompt' }`
(**Phase 2**, web-only, no new endpoint) is documented in
[`docs/terminal-interactive.md`](terminal-interactive.md); the raw key-by-key channel
(**Phase 2b**, `WS /api/fleet/input`) is documented in
[`docs/terminal-write-channel.md`](terminal-write-channel.md). The rule the read channel set still
holds: the web shows **no input box
that does nothing** — the composer is offered only where a live, managed, typable row backs it, and it
reports every line's delivery honestly.

## Transport, and why

**SSE (Server-Sent Events), snapshot-based, viewer-gated, one shared loop per session.**

- **SSE over WebSocket.** The read channel is one-directional (server → browser). SSE is plain
  HTTP, reconnects on its own, and is already the dashboard's push transport (`/api/events`). A
  WebSocket would buy bidirectionality Phase 1 does not use and a dependency the repo does not have.
- **Snapshot (`tmux capture-pane`) over a raw byte stream (`pipe-pane`).** `capture-pane` returns
  the *rendered grid* — a spinner, a redrawn line, a moved cursor are already resolved to their
  final glyphs by tmux before we see them. So every frame is a **complete, self-contained picture**:
  a reader that joins late or reconnects needs no replay, and what we show is what the pane actually
  rendered (the `attention-rules.ts` discipline: never a reconstruction from memory of what a CLI
  prints). Colours survive because we capture with `-e`.
- **Viewer-gated + shared.** A session is captured **only while at least one browser is watching**
  it. Many readers of the same session share **one** capture loop and **one** tmux read per tick; an
  unchanged frame is sent to nobody. So the server's work scales with the number of open *terminals*
  (usually one), never with the size of the fleet — the criterion the spec set.

Tuning constants live in `packages/server/server/sessions/terminal-stream.ts`
(`TERMINAL_VIEW_LINES`, `TERMINAL_POLL_MS`) and `terminal-web.ts` (`MAX_TERMINAL_STREAMS`,
`KEEPALIVE_MS`). The poll cadence is overridable with `AGENTISTICS_TERMINAL_POLL_MS`.

### Tuning: two different "echo" cases, and why `TERMINAL_POLL_MS` is not lowered

**Keystroke echo is already comfortable and does not need this constant touched.** A delivered
keystroke on the write channel ([docs/terminal-write-channel.md](terminal-write-channel.md)) calls
`hub.nudge(id)` (`terminal-hub.ts`), which captures the pane immediately instead of waiting for the
next tick — three cheap reads over ~200ms rather than one on the clock. Measured against a real,
disposable tmux session: median ~7.7 ms, worst ~31 ms (n=15) from the WS send to the character
appearing in an SSE `frame`. That is already an order of magnitude inside anything a person can
perceive as "instant"; chasing it lower buys nothing.

**Continuous output with no keystroke is a separate case the nudge cannot reach**, because nothing
calls `nudge` when a process prints on its own (an agent streaming its reply, a long build). That
case stays bound by the plain tick: measured median ~275 ms, worst ~500 ms at the default 500 ms
cadence (same method — a loop printing a timestamped line every 300ms inside the pane, no WS input
involved).

Lowering the base `TERMINAL_POLL_MS` would shrink that second number, but unlike `nudge` it is not a
burst — it is a **per watched session, all the time** cost that every open terminal panel pays for as
long as it stays open, active or not. Measured (isolated tmux socket, 9 concurrently watched idle
panes — this machine's real fleet size the day this was measured): ~11% of one core at the current
500 ms; ~41% at 150 ms; ~47% at 100 ms. A drop large enough to meaningfully shrink the
continuous-output number costs a real, standing fraction of a core for as long as a few panels stay
open — for a case that is not the one people report as uncomfortable (nobody is waiting on a
round-trip; they are watching text scroll in). So the constant stays at 500 ms. If continuous-output
lag becomes a stated priority, the cheaper lever is the same shape as `nudge` — a short burst
triggered by the pane actually changing, not a lower floor every watched session pays regardless of
activity — not implemented here because it is not what this measurement was asked to fix.

## Request

```
GET /api/fleet/stream?id=<sessionId>
Accept: text/event-stream
```

- `id` — the session's id, the **same `id`** carried on every row of `GET /api/fleet` and accepted
  by `POST /api/fleet/act`. No other identifier.
- Same-origin only; no body.

### Status codes (before the stream opens)

| Code | Meaning |
|------|---------|
| `200` | Stream opens (`text/event-stream`). |
| `400` | `{"error":"bad_request"}` — `id` missing. |
| `404` | `{"error":"not_found"}` — `id` is not a session this machine manages (**scope**). |
| `404` | `{"error":"fleet_central"}` — called on a team central (the fleet lives on members). |
| `403` | `{"error":"capability_disabled","capability":"localShell"}` — exposed profile (see Security). |
| `503` | `{"error":"too_many_streams"}` — process at `MAX_TERMINAL_STREAMS`. |

## Events

The stream emits named SSE events. `: keepalive` comment lines arrive ~every 15s and are ignored.

### `open` — once, first

```json
{ "id": "3f5f", "viewLines": 200, "historyLimit": 50000 }
```

### `frame` — the screen, on every change (deduped)

```json
{
  "seq": 7,
  "content": "[1m[35mclaude[0m … ",
  "cols": 120,
  "rows": 40,
  "cursor": { "x": 6, "y": 12 },
  "alive": true,
  "lines": 53,
  "historyLimit": 50000,
  "truncated": false
}
```

| Field | Meaning |
|-------|---------|
| `seq` | Monotonic within one stream; advances **only when the screen changed**. A late reader's first frame is the current one, whatever its `seq`. |
| `content` | The rendered pane, `\n`-joined, **with SGR escape sequences intact**. Feed it to a terminal emulator. |
| `cols` / `rows` | Pane geometry (`0` cols is a rare "don't know" fallback; the emulator sizes itself). |
| `cursor` | Block-cursor position, or **`null` once the pane is dead** — never draw a cursor on a dead frame. |
| `alive` | `false` once the hosted command has exited. The last frame stays readable and must be shown as **finished**, not live. |
| `lines` | How many lines `content` carries — the honest "you are seeing N lines" number. |
| `historyLimit` | The scrollback ceiling tmux keeps (`50000`), for a "showing last N of up to M" line. |
| `truncated` | `true` when there is more scrollback above than this frame carries. |

**Rendering.** Each `frame` is a full snapshot, not a delta: on receipt, reset the emulator and write
`content` (`term.reset(); term.write(frame.content)`), or the equivalent. Do not append frames.

### `end` — once, last (then the stream closes)

```json
{ "reason": "gone" }
```

- `gone` — the session left tmux (killed, or the machine's tmux went away). Mark the terminal
  ended; the last `frame` is the last thing it drew.
- `not-found` — the id stopped being a managed session mid-stream (scope).
- `error` — the backend could not be read.

A session that merely **exits** does **not** end the stream — it keeps arriving as `frame`s with
`alive:false`, so the finished screen stays readable. `end` is only for a session that is gone.

### A connection that never delivers must say so — not spin forever

The client opens the stream in a `connecting` state and leaves it only on a `frame` (→ live/finished)
or an `end`. If **neither** arrives — the stream opened but produced no frame, or the `EventSource`
is queued behind the browser's per-origin connection limit (~6 over HTTP/1.1, several already spent
on the dashboard's own live channels) and never actually connects — a "Connecting…" that never
resolves is indistinguishable from death. So the client (`useTerminalStream`) raises a `stall` after
`STALL_MS` (10s) without a first frame, and also on an `EventSource` error while still frame-less; the
status line then reads an honest **"No response"** with a **reconnect** verb, instead of spinning
forever. A stall **never** blanks a screen that already has a frame: there the last frame stays and
`EventSource`'s own reconnect handles the blip. Because every watched terminal holds a persistent SSE
against that same connection budget, the UI must not open more streams than it shows — in particular
it does not keep the inline terminal mounted while the maximised modal is open for the same session.

## Security

The read channel inherits the fleet's existing model exactly — it invents no new auth:

- **`localShell` capability** (`capability-guard.ts`). Streaming a session's screen is a coding
  assistant's terminal, transcript and all — shell access with extra steps. So it is **403'd on any
  exposed profile** (`lan`/`public`) regardless of who is authenticated, the same as `/api/fleet`.
  On a `local` profile (127.0.0.1, the machine's own dashboard) it is available, as the fleet is.
- **Scope.** A stream opens only for a session **this machine manages** (its own registry). The read
  power never reaches past the fleet the dashboard already lists — the boundary the Phase 2 *write*
  path will inherit, established here where it is cheap.
- **404 on a central.** Like `/api/fleet`; the fleet is a member/solo concept.

## Status indicators beside the terminal

Any activity indicator the web shows next to the terminal (working / needs-you) must come from the
**fleet's own state** (`GET /api/fleet`, the `activity`/attention the cockpit already computes) —
which, per PR #243, requires **two concordant samples** before it asserts `waiting` and accepts a
return to work immediately. Do **not** recompute a separate "looks idle" signal from the terminal
frames: a still screen is not the same as a session waiting on a person, and inventing a second
source is how the two disagree.

## Files

| File | Role |
|------|------|
| `sessions/tmux-cli.ts` | pure — `capturePaneAnsiArgs` (`-e`), `paneInfoArgs` / `parsePaneInfo`. |
| `sessions/terminal-stream.ts` | pure — frame shape, dedup digest, `buildFrame`, SSE encoder. |
| `sessions/terminal-hub.ts` | the shared, ref-counted, deduped capture loop (injectable). |
| `sessions/backend-tmux.ts` | `captureTerminal` — one ANSI-preserving read + geometry. |
| `sessions/terminal-web.ts` | singleton wiring + SSE plumbing + scope/cap gates. |
| `server/index.ts` | the `GET /api/fleet/stream` route. |
