# Ordered write channel (Phase 2b — server)

`GET /api/fleet/stream` ([docs/terminal-channel.md](terminal-channel.md)) is the **read** half of the
live terminal: a session's screen, server → browser, over SSE. This is the **write** half at the
finest grain — a WebSocket that types into a managed session **key by key**, so the browser terminal
can accept direct typing (`xterm.onData`) without scrambling the order and without lying about what
was delivered.

It is the **server contract** the web dashboard (`agentistics/web`) consumes. The web side wires
`xterm.onData` to it; it invents no endpoint of its own.

## Why a WebSocket, not the existing paths

Two paths already write into a session, and neither fits key-by-key typing:

- `POST /api/fleet/act { action:'prompt', text }` types a whole line **and always appends `Enter`**
  (`sendTextTo`, `backend-tmux.ts`). It is the line composer ([docs/terminal-interactive.md](terminal-interactive.md))
  and it **stays** — good for pasting a long block and for when the socket drops. Per keystroke it is
  wrong: every character would submit a turn.
- HTTP POSTs can arrive **out of order**. One POST per keystroke turns `"hello"` into `"hlelo"`
  intermittently — a defect that passes a gate and shows up only in use.

A WebSocket gives what per-keystroke typing needs: **one connection per session** (TCP preserves
order on a single connection) and a live bidirectional channel for the per-message confirmation. The
repo already runs WebSockets (`team-agent.ts`), so it is not new ground.

Ordering is guaranteed by two things together, and neither alone is enough:

1. one connection per session, and
2. the server processing that connection's messages **strictly sequentially** — one `send-keys` at a
   time, a per-connection FIFO queue that `await`s the previous send before the next
   (`sessions/input-channel.ts`). Client timestamps are never trusted.

## Request

```
GET  /api/fleet/input?id=<sessionId>
Upgrade: websocket
```

- `id` — the **same** id carried by `GET /api/fleet`, `POST /api/fleet/act` and `GET /api/fleet/stream`.
- The session must be one **this machine manages** (the registry); anything else is a `404` before
  the upgrade, never a socket that opens and then says "not found".

## Messages

Client → server, one JSON object per WS message:

```json
{ "seq": 1, "kind": "text", "data": "l" }
{ "seq": 2, "kind": "key",  "name": "C-c" }
```

- `seq` — the client's own monotonic counter (starts at 1). It is **echoed** in the ack, which is
  what makes FIFO *verifiable* rather than assumed: a mismatch is a detected, surfaced failure.
- `kind:"text"` carries `data`, sent **literally** with `tmux send-keys -l` — **no implicit `Enter`**.
  Because it is literal, the raw bytes a browser's `xterm.onData` emits (printable characters *and*
  escape sequences — arrows, etc.) pass through as themselves.
- `kind:"key"` carries `name`, one key from a **closed allowlist**, sent as a *named* key
  (`tmux send-keys`, no `-l`). The set is
  `Enter BSpace Tab Up Down Left Right C-c C-d C-a C-e C-u C-w C-k`. A name outside it is refused —
  defence in depth: the client keeps its own allowlist and the server does **not** trust it. Widening
  the set is a deliberate code change in `KEY_ALLOWLIST` (`sessions/input-protocol.ts`), never a
  client-supplied value.

The `text`/`key` split is by construction: `text` never carries `Enter`; a submit is `kind:"key"`
`name:"Enter"`. Confusing the two fails silently in tmux (`send-keys -l Enter` types five letters),
which is exactly why the literal and named `send-keys` builders are kept apart.

Server → client, **one ack per message**:

```json
{ "seq": 1, "ok": true }
{ "seq": 2, "ok": false, "reason": "send_failed" }
```

- `reason` is present iff `ok` is false — a stable code (`bad_json`, `bad_message`, `empty_text`,
  `text_too_long`, `bad_key`, `send_failed`, `error`) the client renders or maps/localizes.
- **There is no local echo and no "ready" frame.** The WS open event is the go-ahead; a character
  appears on screen only when the *session* draws it, read back over the existing SSE stream. That is
  what makes "the UI never shows a keystroke that did not land" true **by construction** — a key that
  never reached the process is never painted. It is the opposite of the defect the line composer
  fixed at line scale.

## Security — the same gates as `/api/fleet/act`, and no lower ones

Typing key-by-key, control keys included, is **more** power than the line prompt, not less. The
channel rides exactly the gates `/api/fleet` and `/api/fleet/act` carry:

- **`localShell` capability** (`capability-guard.ts`) — refused (403) on any exposed profile,
  **before** the upgrade. There is no deployment that should expose someone's keyboard to the network.
- **404 on a central** (`TEAM_CENTRAL`) — a central hosts no sessions.
- **Same-origin** — the upgrade is refused unless the browser's `Origin` is the dashboard's own (or
  an allowlisted) origin (`wsInputOriginOk`). CSWSH protection: `localShell` being on does not stop a
  malicious page in the user's own browser from opening a socket to `localhost`.
- **Scope** — a socket opens only for a session the registry lists; the id is fixed at upgrade, so a
  message can never redirect a keystroke to another session.
- **Capacity** — `MAX_INPUT_SOCKETS` caps concurrent write sockets, like the read stream's cap.
- **Audit** — one `fleet.input.open` entry per channel opened (a keyboard attached to a session),
  never one per keystroke; a rejected upgrade is `fleet.input.denied`.

## Modules

| File | Role |
|------|------|
| `sessions/input-protocol.ts` | **pure** — message parse/validate, the closed key allowlist, ack shapes, the same-origin check |
| `sessions/input-channel.ts` | **pure, injectable** — the per-connection serial queue (the order guarantee) and one ack per message |
| `sessions/input-web.ts` | singleton wiring: scope check, capacity cap, WS lifecycle handlers; resolves the backend lazily to stay light |
| `sessions/backend-tmux.ts` | `sendTextRaw` — literal `send-keys`, no `Enter` (the first half of `sendTextTo`, exposed) |
| `index.ts` | the `/api/fleet/input` route + the shared WS handler dispatch |

## Latency (measured, local, disposable tmux session)

- **Write path (WS send → ack):** median ~9 ms, p95 ~130 ms — the channel's own contribution.
- **End-to-end echo (key → visible on screen via SSE):** median ~7.7 ms, worst ~31 ms (n=15). A
  delivered keystroke calls `nudgeTerminal()` (`terminal-web.ts`), which makes the read channel
  capture the pane immediately instead of waiting for the next `TERMINAL_POLL_MS` tick — see
  [terminal-channel.md](terminal-channel.md) for the mechanism and for the *different* case (a
  process printing with nobody typing) that the nudge does not cover and the poll still dominates.
  This superseded an earlier measurement of this section (~380 ms, poll-dominated) taken before the
  nudge existed.
