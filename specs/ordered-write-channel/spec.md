# Spec — Ordered write channel for the live terminal (`canal-de-escrita-ordenado`)

Journey `j-20260901-e9`, unit `agentistics/server`. This spec is derived from and
subordinate to the approved task spec at
`.aipe/journeys/j-20260901-e9/task-specs/agentistics__server.md`; where they differ,
the task spec wins.

## Problem

The live terminal (PR #269) can only be written to through
`POST /api/fleet/act {action:'prompt'}`, which types a line **and always appends
`Enter`** (`sendTextTo`, `backend-tmux.ts`). That is proper for a line composer and
improper for typing key-by-key: every keystroke would submit a turn, and HTTP POSTs
can arrive out of order, so `"hello"` becomes `"hlelo"` intermittently.

The backend can already send a single named key (`sendKey` → `sendKeysNamedArgs`,
e.g. `C-c`) and literal text (`sendKeysLiteralArgs`), but **no `/api/fleet/*` route
reaches either without the forced `Enter`**. The capability exists; the path does not.

This unit delivers **only the server path**. The browser terminal is another unit
(`agentistics/web`) and consumes this contract.

## Solution shape

A **WebSocket** endpoint, `GET /api/fleet/input?id=<sessionId>`, upgraded per session:

- **One connection per session.** TCP preserves order on a single connection.
- **Server processes messages strictly sequentially** — one `send-keys` at a time,
  a per-connection FIFO queue that `await`s the previous send before the next.
  Client timestamps are never trusted.
- **Every message is confirmed.** The server replies with one ack per message
  (`ok:true` / `ok:false` + reason), so the browser can honestly show "not delivered"
  — the key-scale version of the lie #269 fixed.
- **Two message kinds:** `text` (literal characters via `sendKeysLiteralArgs`, **no
  implicit `Enter`**) and `key` (one named key via `sendKeysNamedArgs`, e.g. `C-c`).

## Wire contract (consumed by `agentistics/web`)

Client → server (one JSON object per WS message):

```json
{ "seq": 1, "type": "text", "data": "h" }
{ "seq": 2, "type": "key",  "key": "C-c" }
```

Server → client:

```json
{ "type": "ready", "id": "3f5f" }              // once, on open
{ "type": "ack", "seq": 1, "ok": true }
{ "type": "ack", "seq": 2, "ok": false, "reason": "send_failed" }
```

- `seq` is a client-assigned finite number, echoed back in the ack — the mapping
  between a message and its confirmation. An unparseable message acks with
  `seq: null` and a reason.
- `data` for `text` is non-empty and at most `MAX_INPUT_TEXT` (8192) bytes; `-l`
  means it is typed verbatim (no shell, no interpretation), so raw control bytes a
  browser's `xterm.onData` emits pass through as themselves.
- `key` for `key` matches `^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$` (≤ 32 chars): `C-c`,
  `Enter`, `Up`, `M-Up`. It is sent as a *named* key, never as literal text.
- Reason codes: `bad_json`, `bad_message`, `empty_text`, `text_too_long`, `bad_key`,
  `send_failed`, `error`.

**Which control keys the user may send is the web unit's decision** (its per-session
consent gate, #269). The server exposes the mechanism behind the security boundary
below; it does not police individual keys beyond making the token well-formed.

## Security boundary (does not loosen)

The new path inherits **exactly** the gates `/api/fleet` and `/api/fleet/act` carry:

- **`localShell` capability** (`capability-guard.ts`) — refused (403) on any exposed
  profile, checked before the upgrade. Typing key-by-key, control keys included, is
  shell access with extra steps.
- **404 on a central** (`TEAM_CENTRAL`) — a central hosts no sessions.
- **Cookie auth** where it applies (central path), via the same auth gate.
- **Same-origin only.** The upgrade is refused unless the browser's `Origin` is the
  dashboard's own origin or an allowlisted one — CSWSH protection, because
  `localShell` being on (local profile) does not stop a malicious page in the user's
  browser from opening a socket to `localhost`.
- **Scope.** The socket is opened only for a session **this machine manages** (the
  registry), the same boundary the read channel enforces. The session id is fixed at
  upgrade; a message can never redirect a keystroke to another session.
- **Capacity cap** (`MAX_INPUT_SOCKETS`), like the read stream's cap, so open sockets
  cannot exhaust the process.

## Acceptance (mirrors the task spec A1–A8)

- **A1** — a single `text` char appears in the session with no implicit `Enter`.
- **A2** — 40+ one-char messages sent fast arrive in exact order, none lost/dup/reordered.
- **A3** — every message is answered by exactly one ack, mapped by `seq`.
- **A4** — a `key` `C-c` interrupts a long process via `sendKeysNamedArgs`.
- **A5** — no `localShell` (or, where it applies, no auth) ⇒ connection refused, nothing written.
- **A6** — a failed send acks as failure with a reason, never a silent success.
- **A7** — `POST /api/fleet/act {action:'prompt'}` still types + `Enter` as before.
- **A8** — the read SSE stream and the write WS coexist without interfering.

## Out of scope

- `packages/web` (the `xterm.onData` wiring, client consent, coalesced audit, the two
  presentations).
- Removing or changing `POST /api/fleet/act {action:'prompt'}`.
- The read channel `GET /api/fleet/stream` (stays SSE, unchanged).
- Redesigning auth or the capability model.
