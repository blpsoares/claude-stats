/**
 * shell-input-web.ts — the utility shell's WRITE channel, `WS /api/shell/input?id=<shellId>`.
 *
 * The write-side sibling of `shell-stream-web.ts`, and the shell-scoped twin of `input-web.ts`.
 * Same shape as the fleet's: the ORDER guarantee and the per-message confirmation are the pure
 * `input-channel.ts`, the wire contract is the pure `input-protocol.ts`, and this file is only the
 * socket plumbing. So a browser typing into a shell speaks EXACTLY the protocol it speaks to a
 * session, and the client needs one implementation rather than two.
 *
 * What is not shared is the scope: `input-web.ts` resolves an id against `managed-sessions.json`,
 * and this one against `shells.json`. Reusing it would have handed a shell id the fleet's answer.
 *
 * Everything harder is upstream, in `index.ts`, and it is the same gate the open route rides:
 * `localShell` (capability-guard), the user's own `shellEnabled` switch, a central refused outright,
 * and — for the upgrade specifically — the same-origin check (CSWSH). A raw shell is the most
 * powerful thing this server does, so it rides the very same gates as the fleet channel and no
 * lower ones.
 */

import { readShells } from './shell-store'
import { createShellTerminal, type TmuxRun } from './shell-terminal'
import { nudgeShell } from './shell-stream-web'
import { createInputChannel, type InputChannel } from './input-channel'
import { encodeAck } from './input-protocol'

/** A ceiling on concurrent shell write sockets, for the reason `MAX_INPUT_SOCKETS` exists. */
export const MAX_SHELL_INPUT_SOCKETS = 32

async function tmux(args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const p = Bun.spawn(['tmux', ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    const [out, err] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ])
    return { code: await p.exited, out, err }
  } catch {
    return { code: 127, out: '', err: '' }
  }
}

const terminal = createShellTerminal(tmux as TmuxRun)

/** The per-connection state carried on `ws.data`. The channel is built on `open`. */
export interface ShellInputState {
  readonly id: string
  channel: InputChannel | null
}

/** The shape this module needs from a socket — structural, so `index.ts` owns the full `WSData`. */
interface InputSocket {
  data: { shellInput?: ShellInputState }
  send(data: string): unknown
}

let openSockets = 0

export function createShellInputState(id: string): ShellInputState {
  return { id, channel: null }
}

/** Scope check for the route: an id that is not an open shell is a clean 404, never an upgrade. */
export async function shellInputExists(id: string): Promise<boolean> {
  return (await readShells()).some(s => s.id === id)
}

export function shellInputAtCapacity(): boolean {
  return openSockets >= MAX_SHELL_INPUT_SOCKETS
}

/** For tests / diagnostics: how many shell write sockets are open right now. */
export function shellInputSocketCount(): number {
  return openSockets
}

/**
 * On open: build the serial channel bound to this shell. There is no local echo and no "ready"
 * frame — a character appears only when the SHELL draws it, read back over the SSE channel, so the
 * UI can never paint a keystroke that did not land. A delivered keystroke NUDGES the read channel,
 * because the capture cadence is tuned for WATCHING (500 ms), which is an eternity when typing.
 */
export function openShellInputSocket(ws: InputSocket): void {
  const state = ws.data.shellInput
  if (!state) return
  openSockets++
  const { id } = state
  state.channel = createInputChannel({
    sendText: async text => {
      const ok = await terminal.sendText(id, text)
      if (ok) nudgeShell(id)
      return ok
    },
    sendKey: async key => {
      const ok = await terminal.sendKey(id, key)
      if (ok) nudgeShell(id)
      return ok
    },
    emit: ack => { try { ws.send(encodeAck(ack)) } catch { /* socket already closed */ } },
  })
}

export function onShellInputMessage(ws: InputSocket, raw: string | Buffer): void {
  const state = ws.data.shellInput
  if (!state?.channel) return
  state.channel.submit(typeof raw === 'string' ? raw : raw.toString('utf8'))
}

/** Idempotent — a double close cannot go negative. */
export function closeShellInputSocket(ws: InputSocket): void {
  const state = ws.data.shellInput
  if (!state || !state.channel) return
  state.channel = null
  openSockets = Math.max(0, openSockets - 1)
}
