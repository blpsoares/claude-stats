/**
 * terminal.ts — attaching, in a terminal this window owns.
 *
 * The one place the extension does something a browser tab cannot. A webview has no PTY: an
 * in-panel emulation would mean streaming frames, diffing them, and reimplementing resize and the
 * cursor — more moving parts for a worse result than the integrated terminal, which gives real tmux
 * fidelity for free.
 *
 * The argv comes from the server (`/api/fleet/attach`), which reads it off the backend. It is
 * neither composed nor guessed here — a terminal running the wrong command is a terminal that
 * either fails or, much worse, attaches to something else.
 */

import * as vscode from 'vscode'
import type { AttachTicket } from './api'
import { fill } from './i18n'

/**
 * One terminal per session, reused.
 *
 * Reused because pressing Attach twice must not leave two terminals attached to one tmux session:
 * both would be live, both would echo the other's keystrokes, and neither would say why.
 */
const TERMINALS = new Map<string, vscode.Terminal>()

export function attachInTerminal(
  id: string,
  ticket: AttachTicket,
  strings: Record<string, string>,
): void {
  const existing = TERMINALS.get(id)
  if (existing && existing.exitStatus === undefined) {
    existing.show()
    return
  }

  const [command, ...args] = ticket.argv
  if (!command) return

  const terminal = vscode.window.createTerminal({
    name: fill(strings.terminalName ?? '{0}', ticket.label),
    shellPath: command,
    shellArgs: args,
    // The session decides what it draws; a shell integration wrapper injected around tmux fights
    // it for the alternate buffer.
    isTransient: true,
  })
  TERMINALS.set(id, terminal)
  terminal.show()

  // The REAL detach key, read from the backend rather than assumed to be `Ctrl-b` — a prefix the
  // user rebound makes a guessed hint actively wrong, and someone who cannot get out is stranded in
  // a buffer that hides their editor. Said as a notification because the pane itself is about to be
  // taken over by whatever the session is drawing.
  void vscode.window.setStatusBarMessage(
    fill(strings.attachHint ?? '{0}', ticket.detachHint),
    10_000,
  )
}

/** Forget a terminal the user closed, so the next attach opens a live one. */
export function forgetClosedTerminal(closed: vscode.Terminal): void {
  for (const [id, terminal] of TERMINALS) {
    if (terminal === closed) TERMINALS.delete(id)
  }
}

/**
 * Start the local server, in a terminal, where the user can see it.
 *
 * Deliberately not a detached child process: `agentop server` prints what it binds and why it
 * cannot, and a background spawn whose output nobody sees turns "it did not start" into a silence.
 */
export function startServerInTerminal(strings: Record<string, string>): void {
  const terminal = vscode.window.createTerminal({ name: 'agentop server' })
  terminal.sendText('agentop server')
  terminal.show()
  void vscode.window.showInformationMessage(strings.serverStarting ?? 'Starting agentop server.')
}
