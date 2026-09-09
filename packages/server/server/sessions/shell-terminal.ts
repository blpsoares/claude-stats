/**
 * shell-terminal.ts — reading and writing a utility shell's pane, on the SHELL socket.
 *
 * The fleet's own pane I/O is `backend-tmux.ts`'s `captureTerminal` / `sendTextRaw` / `sendKey`,
 * reached through `SessionBackend`. A shell cannot borrow those: every one of them resolves against
 * the fleet socket, and a shell that answered on it would be exactly the `unregistered` fleet row
 * this whole feature is shaped to prevent. So this module is the same three verbs, bound to
 * `SHELL_SOCKET` and to nothing else — `shell-isolation.test.ts` asserts that over the source, and
 * `shell-terminal.test.ts` asserts it over the argv actually produced.
 *
 * The tmux runner is INJECTED, the way `terminal-hub.ts` injects its capture and its clock: the
 * socket discipline, the gone-versus-empty distinction and the honest geometry fallback are then
 * provable without a tmux server.
 */

import {
  capturePaneAnsiArgs, paneInfoArgs, parsePaneInfo, SHELL_SOCKET, sendKeysLiteralArgs,
  sendKeysNamedArgs,
} from './tmux-cli'
import type { TerminalCapture } from './types'

export interface TmuxResult { code: number; out: string; err: string }
export type TmuxRun = (args: string[]) => Promise<TmuxResult>

export interface ShellTerminal {
  /** The pane as it renders right now, or `null` when tmux no longer has it — which ends a stream. */
  capture(id: string, lines: number): Promise<TerminalCapture | null>
  /** Type literal characters, with NO Enter. */
  sendText(id: string, text: string): Promise<boolean>
  /** Press ONE named key (`C-c`, `Enter`, `Escape`). */
  sendKey(id: string, key: string): Promise<boolean>
}

export function createShellTerminal(run: TmuxRun): ShellTerminal {
  return {
    async capture(id, lines) {
      // Content FIRST: a non-zero capture is how we learn the shell is gone, and there is no point
      // asking for the geometry of a pane that is not there. `-e` keeps the colours, and the frame
      // is NOT trailing-trimmed — a full-screen program's blank rows are its layout, not padding.
      const cap = await run(capturePaneAnsiArgs(id, lines, SHELL_SOCKET))
      if (cap.code !== 0) return null
      const raw = cap.out.split('\n')
      // Only the one empty string the final newline leaves; a genuinely blank pane stays EMPTY
      // rather than becoming gone.
      if (raw.length && raw[raw.length - 1] === '') raw.pop()

      const meta = await run(paneInfoArgs(id, SHELL_SOCKET))
      const info = meta.code === 0 ? parsePaneInfo(meta.out) : null
      if (!info) {
        // The pane exists (the capture worked) but its geometry could not be read. A minimal honest
        // answer rather than a confident-wrong cursor: `cols: 0` is a "don't know" the browser
        // emulator sizes past, and `alive` is true because the capture just succeeded.
        return { lines: raw, info: { cols: 0, rows: raw.length, cursorX: 0, cursorY: 0, alive: true, historySize: 0 } }
      }
      return { lines: raw, info }
    },

    async sendText(id, text) {
      return (await run(sendKeysLiteralArgs(id, text, SHELL_SOCKET))).code === 0
    },

    async sendKey(id, key) {
      return (await run(sendKeysNamedArgs(id, key, SHELL_SOCKET))).code === 0
    },
  }
}
