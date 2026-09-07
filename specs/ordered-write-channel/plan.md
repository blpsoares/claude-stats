# Plan — Ordered write channel (`canal-de-escrita-ordenado`)

Implements `spec.md`. Server-only (`packages/server`). Test-first.

## Modules

All new files live under `packages/server/server/sessions/`, beside their siblings
`terminal-web.ts` / `terminal-hub.ts` / `terminal-stream.ts` (the read channel), whose
split (pure core + injectable orchestration + impure singleton wiring) this mirrors.

### 1. `input-protocol.ts` — PURE (tested: `input-protocol.test.ts`)

The message contract and the transport gate, with no IO:

- `parseInputMessage(raw: string): ParseResult` — JSON-parse + validate shape, kind,
  bounds; returns a typed `InputMessage` or `{ ok:false, seq, reason }`.
- `InputMessage = { seq; kind:'text'; text } | { seq; kind:'key'; key }`.
- `ackOk(seq)` / `ackFail(seq, reason)` / `encodeAck(ack)` — the server→client shapes.
- `readyEvent(id)` / `encode(...)` for the `ready` frame.
- `wsInputOriginOk({ origin, host, allowlist, dev })` — same-origin/allowlist check
  (delegates to `cors.originAllowed`, plus the request's own host, mirroring
  `csrf.ts`'s Origin fallback). CSWSH protection.
- Constants: `MAX_INPUT_TEXT`, `MAX_KEY_LEN`, `KEY_PATTERN`.

### 2. `input-channel.ts` — PURE orchestration, injectable (tested: `input-channel.test.ts`)

The **ordering guarantee** and the **per-message confirmation**:

- `createInputChannel(deps)` where `deps = { sendText(text), sendKey(key), emit(ack) }`
  (send fns are pre-bound to the session in the wiring layer).
- Maintains a promise chain: each `submit(raw)` chains onto the previous, so handling
  is strictly serial (one send `await`ed before the next). The chain never breaks — a
  handler that would throw is caught and acked as failure.
- Parses via `input-protocol`, routes `text`→`sendText` / `key`→`sendKey`, and emits
  exactly one ack per submit (`send_failed` when the backend returns `false` or throws).

Tested with fake, delayed/failing send fns: order preserved under random delays,
N submits ⇒ N mapped acks, failure surfaced, `key` routed to `sendKey`.

### 3. `backend-tmux.ts` + `types.ts` — expose literal-only send

Add `sendTextRaw(id, text): Promise<boolean>` to `SessionBackend` and `tmuxBackend`:
`(await tmux(sendKeysLiteralArgs(id, text))).code === 0`. It reuses the exact argv
builder the existing `sendTextTo` uses for its first half — **exposing** the literal
path without the trailing `Enter`, not a new mechanism. `windowsBackend` inherits it
by spread.

### 4. `input-web.ts` — IMPURE singleton wiring (verified by integration, not unit)

Mirrors `terminal-web.ts`:

- `MAX_INPUT_SOCKETS = 100`; a live count for the capacity cap.
- `inputSessionExists(id)` — scope check via `readRegistry()`.
- `inputAtCapacity()`.
- `openInputSocket(ws)` / `onInputMessage(ws, raw)` / `closeInputSocket(ws)` — the
  three WS lifecycle handlers. `open` sends the `ready` frame and builds an
  `InputChannel` bound to the session id (its `sendText`/`sendKey` resolve the backend
  and call `sendTextRaw` / `sendKey`); `message` forwards raw bytes to the channel;
  `close` decrements the count. Channel state is held on `ws.data`.

### 5. `index.ts` — the route + WS dispatch

- Register `/api/fleet/input` in `capability-guard.ts` under `localShell`.
- Add `/api/fleet/input` to the `TEAM_CENTRAL` fleet-404 block.
- New route block: resolve `id`, check `wsInputOriginOk`, `inputSessionExists` (404),
  `inputAtCapacity` (503), then `server.upgrade(req, { data: { fleetInput: state } })`.
- Extend `WSData` with an optional `fleetInput` variant and branch the shared
  `_wsHandlers` (`open`/`message`/`close`) to the `input-web` handlers when present —
  leaving the existing `isAgent` reverse-channel untouched.

## Order of work (RED → GREEN each)

1. `input-protocol.test.ts` → `input-protocol.ts`.
2. `input-channel.test.ts` → `input-channel.ts`.
3. `sendTextRaw` on the backend + interface (argv builder already tested).
4. `input-web.ts` wiring + `index.ts` route/dispatch + capability-guard registration.
5. `bun tsc --noEmit` + `bun test` (package), then boot `bun run dev:api` and prove
   A1–A8 against a real disposable tmux session on a non-standard port.

## Verification (real, not just tests)

Boot the server, create a disposable managed session, open the WS from a small client,
and demonstrate: a char with no Enter (A1), a 40-char burst in order ×5 (A2), acks per
message (A3), `C-c` interrupting `sleep 60` (A4), refusal with `localShell` off (A5),
failure ack after killing the session (A6), the old prompt path intact (A7), and SSE
read coexisting with the WS write (A8). Tear down the server and the session.
