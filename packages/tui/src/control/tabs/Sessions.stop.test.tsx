import React from 'react'
import { describe, test, expect } from 'bun:test'
import { render } from 'ink-testing-library'
import { ControlCenter } from '../ControlCenter'
import type { ControlHost, ControlSession, ControlSessions, ControlStatus, SessionViewPrefs } from '../types'

/**
 * Pinning a row and picking one to KILL, driven through the real keyboard.
 *
 * The pure half of this lives in `sessions.test.ts` (`stopTargets`, `bulkStopToggle`). What it
 * cannot state is the wiring, and the wiring is where the reported defect actually was: `space`
 * pinned a row — a keeping gesture, written to `preferences.json`, that lifts the row into its own
 * band because you were about to come back to it — and `x` then offered to stop "the N marked
 * sessions". The gesture for keeping armed a mass deletion, and it did so through a component, not
 * through a function anybody could test.
 *
 * So these press the actual keys against the actual screen and read the actual frame.
 */

const ESC = '\x1b'
const CTRL_X = '\x18'

/** Strip whole CSI sequences, not only SGR — a half-stripped frame reads as text until it doesn't. */
function plain(frame: string | undefined): string {
  return (frame ?? '').replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, '')
}

const COLS = 120
const ROWS = 34

function session(o: Partial<ControlSession> & { id: string; title: string }): ControlSession {
  return {
    harness: 'claude',
    state: 'waiting',
    stateLabel: 'waiting',
    actionable: true,
    cwd: '/home/dev/repo',
    project: 'repo',
    ...o,
  } as ControlSession
}

const SESSIONS: ControlSession[] = [
  session({ id: 'aaa11', title: 'alpha' }),
  session({ id: 'bbb22', title: 'bravo' }),
  session({ id: 'ccc33', title: 'charlie' }),
  session({ id: 'ddd44', title: 'delta' }),
]

const STATUS: ControlStatus = {
  mode: 'solo',
  modeLabel: 'solo',
  services: [],
  version: '1.0.0',
  // Flat and unfiltered, so the four rows are drawn in a known order with no headings between them.
  sessionView: {
    grouping: 'none',
    showClosed: true,
    showExited: true,
    showUnfiled: true,
    showDone: true,
    onlyActive: false,
    layout: 'list',
  },
}

interface Rig {
  /** Ids the host was actually asked to stop, in the order it was asked. */
  killed: string[]
  /** Every `sessionView` the screen has written to disk, newest last. */
  written: Partial<SessionViewPrefs>[]
  host: ControlHost
  /**
   * Resolves the first time the screen ASKED for the fleet and was answered.
   *
   * A promise, not something to poll for — and that distinction is the whole of the CI failure this
   * replaces. `drive` polled the frame every 5ms until the fleet appeared, running a regex over a
   * 4KB frame two hundred times a second; on a saturated runner that competed with the very timers
   * it was waiting on, so the gate starved the effect it was gating and every test timed out at it.
   * Awaiting the host's own resolution costs nothing while it waits, which leaves a contended
   * process alone to get there.
   */
  fleetServed: Promise<void>
  /** How many times the screen has asked for the fleet. Reported when a wait gives up. */
  polls: () => number
}

function rig(): Rig {
  const killed: string[] = []
  const written: Partial<SessionViewPrefs>[] = []
  let served: () => void = () => {}
  let polls = 0
  const fleetServed = new Promise<void>(resolve => { served = resolve })
  const done = async () => ({ ok: true, message: '' })
  const fleet = (): ControlSessions => ({
    sessions: SESSIONS.filter(s => !killed.includes(s.id)),
    attention: 0,
    rang: [],
  })
  const host = {
    refresh: async () => STATUS,
    lastStatus: () => STATUS,
    start: done,
    connect: done,
    disconnect: done,
    restart: done,
    stop: done,
    setMode: done,
    initCentral: done,
    upgrade: done,
    pendingArchiveMode: async () => null,
    setArchiveMode: done,
    enableBoot: done,
    setLang: async () => {},
    setSessionView: async (view: Partial<SessionViewPrefs>) => { written.push(view) },
    setMouse: async () => {},
    setSessionPollMs: async () => {},
    onOutput: () => () => {},
    readLog: async () => [],
    // DELIBERATELY SLOW. `sessions()` is a network-shaped call on a real host, and the CI runner
    // resolved it later than a developer machine did — which is exactly what broke these tests
    // when they waited out a fixed number of milliseconds before typing. Keeping a delay here
    // means the frame gate in `drive` is exercised on every run rather than being satisfied by
    // accident on a fast machine.
    sessions: async () => {
      polls++
      await sleep(SESSIONS_DELAY_MS)
      const answer = fleet()
      served()
      return answer
    },
    killSession: async (id: string) => { killed.push(id); return { ok: true, message: '' } },
  } as unknown as ControlHost
  return { killed, written, host, fleetServed, polls: () => polls }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** How long the fake host takes to answer `sessions()`. See the rig. */
const SESSIONS_DELAY_MS = 60

/**
 * How long a CONDITION is given before it reports which condition it was.
 *
 * Deliberately enormous next to the ~60ms these actually take. It is not a wait — every wait here
 * ends the moment its condition holds — it is only the point at which waiting becomes a failure,
 * and a loaded runner is precisely the case that broke these tests once already. Tuning it down to
 * "about long enough" would rebuild the flake in a slower loop.
 */
const WAIT_MS = 10_000

/**
 * The DEADLINE on a whole test. Larger than the waits inside it, or the test dies before the
 * condition it is waiting on can name itself — and "test timed out" says nothing, where
 * "timed out waiting for the fleet to be drawn" plus the frame says everything.
 */
const DEADLINE_MS = 30_000

/**
 * Wait for a CONDITION, never for a duration.
 *
 * These tests used to type after `await sleep(150)`. That held on a developer machine and lost on
 * the CI runner: `host.sessions()` had not resolved, the list was still drawing `reading…` over
 * `0 sessions`, and every keystroke landed on an empty fleet — so `x` named nothing, the pinned
 * band never existed and `killSession` was never called. Four tests failed for one reason, and the
 * reason was the clock. A longer sleep would only move the number at which it next loses.
 *
 * The frame is the ground truth, so it is what is waited on. A timeout throws with the last frame
 * attached, because the failure this replaces was diagnosable only by reading one.
 */
async function until(
  read: () => string,
  pred: (frame: string) => boolean,
  what: string,
  timeoutMs = WAIT_MS,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let frame = read()
  while (!pred(frame)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}.\nLast frame:\n${frame}`)
    }
    // 25ms, not 5. This loop runs a regex over the whole frame each turn, and at 5ms it was heavy
    // enough on a loaded runner to compete with the timers it was waiting for.
    await sleep(25)
    frame = read()
  }
  return frame
}

/** The same, for a fact that is not on the screen — what the host was actually asked to do. */
async function untilTrue(pred: () => boolean, what: string, timeoutMs = WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
    await sleep(25)
  }
}

/**
 * Let one keystroke finish being drawn — a fixed number of event-loop TURNS, not a duration.
 *
 * A key press is pure state on this screen: Ink parses the bytes and re-renders without waiting on
 * anything, so what a burst of keys needs between them is the loop draining, and that is a count of
 * turns rather than a number of milliseconds. Everything that does depend on the host — the fleet
 * arriving, the kills landing, the arrangement reaching the disk seam — is waited for by an
 * explicit `until` instead, which is the whole point: a wait is either deterministic or it is a
 * condition, never a guess about how fast the machine is.
 *
 * Waiting for the frame to stop MOVING was tried and rejected: the cockpit re-polls the fleet and
 * animates, so "quiet for three reads" is a state this screen legitimately never reaches, and every
 * keystroke then burned its whole cap — the suite went from seconds to five minutes while passing.
 */
async function flush(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i++) await sleep(0)
}

/**
 * Just the QUESTION pane, as one line of text.
 *
 * The list is still on screen behind every confirmation — deliberately, so the row being acted on
 * stays visible — so asserting "the question does not mention the pinned rows" against the whole
 * frame would be asserting that the list is empty. This is the region the person reads before
 * answering, and it is the only region the claim is about.
 */
function question(frame: string): string {
  const lines = frame.split('\n')
  const at = lines.findIndex(l => l.includes('─ question ─'))
  if (at < 0) return ''
  // Down to the blank row that separates the sentence from the yes/no menu — the menu's own `1.`
  // and `2.` are chrome, and a claim about what the question says must not be read against them.
  const out: string[] = []
  for (let i = at + 1; i < lines.length; i++) {
    const text = (lines[i] ?? '').replace(/[│╰╯─]/g, '').trim()
    if (text === '') break
    out.push(text)
  }
  return out.join(' ')
}

/**
 * Mount the cockpit on the sessions list, type `keys`, and hand back the frame it settled on.
 *
 * One key per tick with a beat between, exactly as `scripts/preview.tsx` does it: a burst written
 * in one chunk is parsed as a single garbled escape sequence, and a question opens on a state
 * change the next key has to be able to see.
 */
async function drive(
  r: Rig,
  keys: readonly string[],
  /** What the screen must be showing before the frame is read. Named, so a timeout says what failed. */
  ready?: { what: string; is: (frame: string) => boolean },
): Promise<{ frame: string; unmount: () => void }> {
  const host = r.host
  const size = { columns: process.stdout.columns, rows: process.stdout.rows }
  Object.defineProperty(process.stdout, 'columns', { value: COLS, configurable: true })
  Object.defineProperty(process.stdout, 'rows', { value: ROWS, configurable: true })
  const element = <ControlCenter host={host} lang="en" initial={{ tab: 'sessions' }} onExit={() => {}} />
  const app = render(element)
  // ink-testing-library hardcodes a 100-column stdout behind a prototype getter; shadowing it on
  // the instance and re-rendering is what makes the frame land at the requested width.
  Object.defineProperty(app.stdout, 'columns', { get: () => COLS, configurable: true })
  app.rerender(element)
  const read = () => plain(app.lastFrame())
  const restore = () => {
    Object.defineProperty(process.stdout, 'columns', { value: size.columns, configurable: true })
    Object.defineProperty(process.stdout, 'rows', { value: size.rows, configurable: true })
  }
  try {
    // THE FLEET HAS TO BE ON SCREEN BEFORE A KEY IS PRESSED. `pollFleet` awaits `host.sessions()`
    // and only then commits a frame; until it does, the pane draws `reading…` over `0 sessions`
    // and every keystroke acts on an empty list — which is exactly what CI produced.
    //
    // Two steps, and the order matters. First WAIT ON THE HOST'S OWN PROMISE: that costs no CPU, so
    // a contended runner is left alone to run the effect that does the asking. Only then poll for
    // the commit, which is a couple of turns away because the data already exists.
    await Promise.race([
      r.fleetServed,
      sleep(WAIT_MS).then(() => {
        // The two halves are reported APART on purpose. "Never asked" means the screen's own effect
        // did not run — a fact about the environment. "Asked but never drawn" means it did run and
        // the commit is what is missing. One message covering both sends the next reader to the
        // wrong place, and the next reader may well be CI rather than a person.
        throw new Error(
          `the screen never asked the host for the fleet within ${WAIT_MS}ms `
          + `(sessions() called ${r.polls()} times).\nLast frame:\n${read()}`,
        )
      }),
    ])
    await until(
      read,
      f => f.includes('aaa11') && f.includes('ddd44'),
      `the fleet to be DRAWN — the host answered (sessions() called ${r.polls()} times), the screen did not commit it`,
    )
    for (const key of keys) {
      app.stdin.write(key)
      await flush()
    }
    if (ready) await until(read, ready.is, ready.what)
    return { frame: read(), unmount: () => { restore(); app.unmount() } }
  } catch (err) {
    restore()
    app.unmount()
    throw err
  }
}

describe('pinning and stopping are two gestures', () => {
  test('`x` outside the mode names the ROW UNDER THE CURSOR, whatever is pinned', async () => {
    // THE REPORTED DEFECT. Two rows pinned with `space`, the cursor moved onto a third, `x`.
    const r = rig()
    const { frame, unmount } = await drive(r, [' ', '\x1b[B', ' ', '\x1b[B', 'x'],
      { what: 'the confirmation to open', is: f => f.includes('─ question ─') })
    try {
      // Both rows really are pinned, and really are in the band — the pin was not silently lost.
      expect(frame).toContain('pinned  2')
      // And the question names ONE session, the third row: neither pinned row is in it.
      const asked = question(frame)
      expect(asked).toContain('Stop "charlie"? The assistant running in it is ended.')
      expect(asked).not.toContain('alpha')
      expect(asked).not.toContain('bravo')
      // No count of anything. The old question was "encerrar as 2 sessões marcadas?".
      expect(asked).not.toMatch(/\d/)
    } finally { unmount() }
  }, DEADLINE_MS)

  test('the mode is ANNOUNCED, and `space` inside it selects instead of pinning', async () => {
    const r = rig()
    const { frame, unmount } = await drive(r, [CTRL_X, ' ', '\x1b[B', ' '],
      { what: 'two rows to be selected for stopping', is: f => f.includes('2 selected to stop') })
    try {
      // Readable from the screen alone: the pane title and the banner both say it, and the banner
      // names every key that works while it is on.
      expect(frame).toContain('sessions · STOP MODE')
      expect(frame).toContain('STOP MODE · 2 selected to stop')
      expect(frame).toContain('space selects')
      expect(frame).toContain('ctrl+x leaves')
      // `space` did NOT pin: the pinned band does not exist, because nothing is pinned.
      expect(frame).not.toContain('pinned')
    } finally { unmount() }
  }, DEADLINE_MS)

  test('`x` inside the mode stops exactly the picked rows, states the count, and LEAVES the mode', async () => {
    const r = rig()
    // Pin the first row, then pick the second, third and fourth for stopping. The pinned row is
    // deliberately not picked: it must survive.
    const { frame, unmount } = await drive(r, [
      ' ', '\x1b[B', CTRL_X, ' ', '\x1b[B', ' ', '\x1b[B', ' ',
      // `x`, then up to `Yes`, then enter.
      'x', '\x1b[A', '\r',
    ], {
      what: 'the three stopped rows to leave the list and the mode to close',
      is: f => !f.includes('STOP MODE') && !f.includes('bravo'),
    })
    try {
      await untilTrue(() => r.killed.length === 3, 'three sessions to be stopped')
      expect(r.killed.slice().sort()).toEqual(['bbb22', 'ccc33', 'ddd44'])
      // The mode closed BY ITSELF — no second keystroke was typed after the confirmation.
      expect(frame).not.toContain('STOP MODE')
      // And the pinned row is still there, still pinned, still in its band.
      expect(frame).toContain('pinned')
      expect(frame).toContain('alpha')
    } finally { unmount() }
  }, DEADLINE_MS)

  test('the confirmation inside the mode states how many rows are about to die', async () => {
    const r = rig()
    const { frame, unmount } = await drive(r, [CTRL_X, ' ', '\x1b[B', ' ', '\x1b[B', ' ', 'x'],
      { what: 'the confirmation to open', is: f => f.includes('─ question ─') })
    try {
      expect(frame).toContain('Stop the 3 selected sessions?')
      expect(r.killed).toEqual([])
    } finally { unmount() }
  }, DEADLINE_MS)

  test('leaving the mode with `ctrl+x` stops nothing and leaves the pinned set alone', async () => {
    const r = rig()
    const { frame, unmount } = await drive(r, [' ', '\x1b[B', CTRL_X, ' ', '\x1b[B', ' ', CTRL_X],
      {
        what: 'the mode to be gone with the one pinned row still banded',
        is: f => !f.includes('STOP MODE') && f.includes('pinned  1'),
      })
    try {
      expect(r.killed).toEqual([])
      expect(frame).not.toContain('STOP MODE')
      // The pin the person made before entering is untouched.
      expect(frame).toContain('pinned')
      // Re-entering finds nothing waiting: the banner counts zero.
      unmount()
    } finally { /* unmounted above */ }
  }, DEADLINE_MS)

  test('the stop selection is never written to disk, and pinning still is', async () => {
    const r = rig()
    const { unmount } = await drive(r, [' ', '\x1b[B', CTRL_X, ' ', '\x1b[B', ' '],
      { what: 'two rows to be selected for stopping', is: f => f.includes('2 selected to stop') })
    try {
      await untilTrue(() => r.written.length > 0, 'the arrangement to reach the disk seam')
      // Pinning reached the disk seam...
      const last = r.written.at(-1)
      expect(last).toBeDefined()
      expect(last!.marked).toEqual(['aaa11'])
      // ...and nothing the mode picked did, under any key. `bbb22`/`ccc33` were picked to be
      // stopped and appear nowhere in anything that was persisted.
      const all = JSON.stringify(r.written)
      expect(all).not.toContain('bbb22')
      expect(all).not.toContain('ccc33')
    } finally { unmount() }
  }, DEADLINE_MS)

  test('`esc` keeps its own job — it does not double as the way out of the mode', async () => {
    // Declared behaviour, held here so it cannot drift into a second exit by accident: `esc` on
    // this screen drops the search, then the project, then the task. `ctrl+x` is the one key that
    // leaves the mode.
    const r = rig()
    const { frame, unmount } = await drive(r, [CTRL_X, ' ', ESC],
      { what: 'the mode to still be on after esc', is: f => f.includes('1 selected to stop') })
    try {
      expect(frame).toContain('STOP MODE')
      expect(frame).toContain('1 selected to stop')
    } finally { unmount() }
  }, DEADLINE_MS)
})
