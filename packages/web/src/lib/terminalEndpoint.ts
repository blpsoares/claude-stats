/**
 * terminalEndpoint.ts — PURE. Which routes a terminal channel talks to, decided in ONE place.
 *
 * There are two kinds of pane this dashboard reads and writes, and they are not interchangeable:
 * a FLEET row (an assistant's own screen, resolved against `managed-sessions.json`) and a SHELL
 * (the per-session utility terminal, resolved against `shells.json`, on its own tmux socket). The
 * routes are deliberately separate on the server — `/api/shell` is registered in
 * `capability-guard.ts` rather than riding the `/api/fleet` prefix, because "a shell is not a fleet
 * row, and filing it under that prefix would be the first step toward it becoming one".
 *
 * The client end of that same argument lives here. `useTerminalStream` and `useTerminalWrite` are
 * generic over the SCOPE and interpolate nothing themselves, so a shell id can never be handed to a
 * route that would resolve it against the session registry — and a test says so, over the strings
 * rather than over a comment.
 */

/** Which of the two channels an id belongs to. Never inferred from the id — an id is opaque. */
export type TerminalScope = 'fleet' | 'shell'

const BASE: Record<TerminalScope, string> = {
  fleet: '/api/fleet',
  shell: '/api/shell',
}

/** The SSE read channel for one pane. */
export function streamUrl(scope: TerminalScope, id: string): string {
  return `${BASE[scope]}/stream?id=${encodeURIComponent(id)}`
}

/**
 * The WebSocket write channel for one pane.
 *
 * `protocol` and `host` are passed in rather than read off `window`, so the mapping is testable and
 * the module stays free of the DOM — the same split every other pure module here makes.
 */
export function inputWsUrl(scope: TerminalScope, id: string, protocol: string, host: string): string {
  const proto = protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${host}${BASE[scope]}/input?id=${encodeURIComponent(id)}`
}
