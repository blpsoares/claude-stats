/**
 * The control center's public surface — the one thing `packages/server` imports.
 *
 * Keeping the entry this narrow is what keeps the dependency direction `server -> tui`: the server
 * builds a `ControlHost` out of its own modules and hands it over, and nothing in here ever reads a
 * preference, spawns a process or touches the filesystem.
 */

import React from 'react'
import { render } from 'ink'
import { ControlCenter } from './ControlCenter'
import { altScreen, enterAltScreenGuarded, onAltScreenSignal, writeFrame } from './altScreen'
import { createMouseInput } from './mouseStdin'
import { createPointerBus, type MouseChannel } from './pointer'
import { strings } from '../i18n'
import type { MouseReport } from './mouse'
import type { CliLang } from './lang'
import type { ControlExit, ControlHost, TabId } from './types'

export interface ControlCenterOptions {
  lang: CliLang
  host: ControlHost
  /** Which tab to open on. Defaults to Services. */
  tab?: TabId
  /**
   * Open with the setup wizard already asking — a machine that has never been configured.
   *
   * A flag rather than a tab, because Setup stopped being one: choosing solo / central / member is a
   * question ABOUT the services on this box, so it is drawn in the cockpit's detail region like
   * every other question. The caller still gets to say "start there", which is what it always meant.
   */
  setup?: boolean
}

/**
 * The stdout Ink draws through: `process.stdout` in every respect except its `write`, which is
 * `altScreen.writeFrame`.
 *
 * The host swaps `process.stdout.write` out while an action runs — to collect what it printed
 * (`captureOutput`) or to turn it into lines for the output pane (`streamOutput`) — and Ink resolves
 * `stdout.write` on every repaint. Left alone it would draw THROUGH whatever is patched over the
 * stream, and each diversion is wrong in its own way: the capturing one swallows the frame, so the
 * screen freezes for the length of the action, spinner included; the streaming one feeds the frame
 * into the pane that is drawing it, which is a loop whose output is a pane full of its own borders —
 * exactly what the first pty recording of this feature caught. `writeFrame` also keeps the OTHER
 * half of the old arrangement, dropping frames while a command is suspended.
 *
 * A Proxy rather than a copy: Ink reads `columns` / `rows` and subscribes to `resize`, so the object
 * has to remain the real stream apart from that one method.
 */
function inkStdout(): NodeJS.WriteStream {
  return new Proxy(process.stdout, {
    get(target, prop) {
      if (prop === 'write') return writeFrame
      // Read against the TARGET so a getter (`columns`) sees the real stream as `this`, and bind
      // methods for the same reason — `on('resize', …)` must register on the stream, not the proxy.
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export async function runControlCenter(opts: ControlCenterOptions): Promise<ControlExit> {
  const { lang, host, tab, setup } = opts

  // Ink needs raw mode, which a pipe or a systemd unit cannot give it; it would throw from inside
  // a React effect and surface as a reconciler stack. One sentence and a non-zero code instead.
  //
  // `runStart()` checks `isTTY` itself and returns before it ever gets here, so on the shipped path
  // this is unreachable — it stays as the module's own guarantee, because this is an exported entry
  // point and the next caller does not inherit `runStart`'s check.
  if (!process.stdin.isTTY) {
    process.stderr.write(`${strings(lang).needsTty}\n`)
    return { kind: 'quit', code: 1 }
  }

  enterAltScreenGuarded()

  let settle: (exit: ControlExit) => void = () => {}
  const exited = new Promise<ControlExit>(resolve => { settle = resolve })

  let done = false
  const onExit = (exit: ControlExit) => {
    // Ctrl-C and `q` can both arrive while an action is still settling; the first one wins and the
    // rest are dropped, so the process cannot be handed two different reasons for stopping.
    if (done) return
    done = true
    settle(exit)
  }

  // THE ONLY LISTENER ON THE REAL STDIN. Mouse reports are cut out of the stream here and the rest
  // is forwarded to Ink through a `PassThrough` — see `mouseStdin.ts` for why a second listener
  // would not do. Nothing else in this process may read stdin while the app is mounted, except
  // `makeSuspend`, which borrows it by moving this listener aside and putting it back.
  const reportHandlers = new Set<(report: MouseReport) => void>()
  const input = createMouseInput(process.stdin, report => {
    for (const handler of [...reportHandlers]) handler(report)
  })

  const mouse: MouseChannel = {
    onReport(handler) {
      reportHandlers.add(handler)
      return () => { reportHandlers.delete(handler) }
    },
    pointer: createPointerBus(),
    // The escape sequences belong to `altScreen`, so that turning tracking OFF is under the same
    // guarantee as leaving the buffer: every exit path, every signal, and every suspension.
    setTracking(on) { if (on) altScreen.enableMouse(); else altScreen.disableMouse() },
  }

  // `createElement` rather than JSX so this entry can stay a `.ts` file: it is imported by the
  // server, and a `.tsx` extension there would drag JSX settings into a module that renders nothing.
  const app = render(
    React.createElement(ControlCenter, { host, lang, initial: { tab, setup }, onExit, mouse }),
    {
      stdin: input.stdin,
      // THE FRAME MUST NOT GO THROUGH `process.stdout.write` — see `inkStdout`.
      stdout: inkStdout(),
      // Ctrl-C routes through onExit like every other way out, so the alternate screen is always
      // left the same way and the exit code is decided in one place.
      exitOnCtrlC: false,
    },
  )

  // A kill has to unwind the same way `q` does — see `onAltScreenSignal`.
  const stopSignals = onAltScreenSignal(code => onExit({ kind: 'quit', code }))

  // Ink rejects its OWN exit promise when a tab throws during render, and `exited` is settled only
  // by `onExit` — so without racing the two, a crash would leave the process alive on an empty
  // alternate buffer with no prompt, which reads as a hang rather than as a failure.
  const crashed: Promise<ControlExit> = app.waitUntilExit().then(
    () => ({ kind: 'quit', code: 0 }),
    () => ({ kind: 'quit', code: 1 }),
  )

  try {
    return await Promise.race([exited, crashed])
  } finally {
    stopSignals()
    app.unmount()
    // Whatever it has to say has already come back through `crashed`; this await only lets Ink
    // finish its teardown writes before the buffer is swapped out from under them.
    await crashed
    // Ink's own teardown drops raw mode on the stream it was GIVEN, which is the PassThrough and
    // therefore a no-op; the real descriptor is ours to hand back, and only after Ink has stopped
    // reading from what we were feeding it.
    input.stop()
    // Disables tracking as well as restoring the buffer — see `altScreen.leave`. A process that
    // returned from here with the mouse still on would leave the user's shell typing `<35;40;12M`.
    altScreen.leave()
  }
}

export type {
  ActionResult,
  ActionTarget,
  AttachTicket,
  BackupLayer,
  BackupScheduleId,
  BackupPresence,
  BootOption,
  BootState,
  ControlBackupConfig,
  ControlBackupHarness,
  ControlBackupHistoryEntry,
  ControlBackupLast,
  ControlBackupStatus,
  RestartOption,
  RestartRequest,
  ControlExit,
  ControlHost,
  ControlService,
  ControlSession,
  ControlSessions,
  TranscriptSearch,
  ControlStatus,
  LogSource,
  RuntimeId,
  ServiceId,
  ServiceRef,
  ServiceRuntime,
  ServiceRuntimeState,
  ServiceState,
  SessionHarnessOption,
  SessionState,
  SessionViewPrefs,
  SpawnSessionRequest,
  SpawnSessionResult,
  ProjectOption,
  RestoreCandidate,
  ResumeSessionRequest,
  StartHow,
  StartOption,
  StartRequest,
  StopOption,
  TabId,
  TeamMode,
  CentralLinkState,
} from './types'
export { TAB_ORDER, DEFAULT_SESSION_VIEW } from './types'
// The arrangements are declared once, in `session-dimensions.ts`. Re-exported here so the SERVER —
// which persists whichever one was chosen — names that type rather than keeping a copy of the list.
export type { SessionGroupingId } from './session-dimensions'
export type { CliLang } from './lang'
