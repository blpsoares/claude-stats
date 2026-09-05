/**
 * backend-tmux.ts — the Unix SessionBackend. Thin on purpose: every decision it could get wrong
 * lives in the pure `tmux-cli.ts` beside it.
 */

import {
  attachArgs, capturePaneArgs, capturePaneAnsiArgs, idFromTmuxName, isSessionGoneError,
  killSessionArgs, listSessionsArgs, paneInfoArgs, parsePaneInfo, parsePrefix, parseTmuxList,
  resolveDefaultTerminal, resolveTruecolorTerm, spawnArgs, sendKeysNamedArgs, sendKeysLiteralArgs,
  showPrefixArgs, trimCapture,
  type TerminalProfile,
} from './tmux-cli'
import { dependencyCommandLine } from './dependency-plan'
import { probeDependency } from './dependency-probe'
import { planPromptDelivery } from './initial-prompt'
import { frameChanged } from './submit-check'
import type {
  BackendInitialPrompt, BackendSession, BackendSpawn, SessionBackend, TerminalCapture,
} from './types'

/** How often to re-read the pane while waiting for the harness to be ready to receive the prompt. */
const DELIVER_POLL_MS = 400
/**
 * How long to keep trying to deliver the initial prompt before giving up.
 *
 * Robust to a SLOW start (a big CLAUDE.md, MCP servers loading) — the old fixed 1200ms lost the
 * keys to a pane that had not drawn its prompt yet. Bounded so a session stuck on an unrecognised
 * dialog cannot block a batch forever. Overridable for tests.
 */
const DELIVER_DEADLINE_MS = Number(process.env.AGENTISTICS_DELIVER_DEADLINE_MS) > 0
  ? Number(process.env.AGENTISTICS_DELIVER_DEADLINE_MS)
  : 15_000
/** How much of the pane to read to judge readiness — enough for the input box and its footer. */
const DELIVER_CAPTURE_LINES = 40

/**
 * The gap between typing a prompt and submitting it, and how long the submit is given to show.
 *
 * The gap exists because the two `send-keys` calls were back to back, microseconds apart, and a
 * terminal UI reading a burst that size has every reason to treat the `\r` at the end of it as part
 * of the same burst rather than as a person pressing return.
 *
 * The wait is what makes the CHECK possible at all: a pane captured the instant after `Enter` has
 * not repainted yet, so it always looks unchanged and every send would retry.
 */
const SUBMIT_SETTLE_MS = 200
const SUBMIT_SHOW_MS = 600

/** True when this host has the named terminfo entry (`infocmp` exits 0). Never throws. */
async function terminfoHas(name: string): Promise<boolean> {
  try {
    const p = Bun.spawn(['infocmp', name], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })
    return (await p.exited) === 0
  } catch {
    // No infocmp on PATH — treat every entry as absent, so agentop leaves tmux's own default rather
    // than naming a terminfo entry it could not confirm exists.
    return false
  }
}

let profileCache: TerminalProfile | null = null

/**
 * Resolve the colour profile once per process: the terminfo entries do not change under us, and the
 * invoking terminal's env (`TERM` / `COLORTERM`) is fixed for this run. The pure resolvers in
 * `tmux-cli.ts` decide; this only does the IO they cannot.
 */
async function terminalProfile(): Promise<TerminalProfile> {
  if (profileCache) return profileCache
  const [tmux256color, screen256color] = await Promise.all([
    terminfoHas('tmux-256color'),
    terminfoHas('screen-256color'),
  ])
  profileCache = {
    defaultTerminal: resolveDefaultTerminal({ tmux256color, screen256color }),
    truecolorTerm: resolveTruecolorTerm({ TERM: process.env.TERM, COLORTERM: process.env.COLORTERM }),
  }
  return profileCache
}

async function tmux(args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const p = Bun.spawn(['tmux', ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    return { code: await p.exited, out, err }
  } catch {
    // tmux is not on PATH. 127 is what a shell reports for that, and `unavailable()` is what
    // callers are meant to consult — no throw, so a missing tmux never crashes a caller.
    return { code: 127, out: '', err: '' }
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Type text and submit it, as two separate `send-keys` calls.
 *
 * `-l` (literal) for the text so a prompt containing `;` or `C-c` is typed rather than interpreted,
 * then the named `Enter` — which is why they cannot be one call.
 *
 * The submit is only sent once the text was accepted. Half a prompt followed by an unconditional
 * Enter is a blank turn sent to an assistant, which is the exact accident this feature exists to
 * avoid.
 *
 * A free function rather than a method on the object below, because `spawn` calls it: reaching it
 * through `this` would break the moment a caller spread or destructured the backend, and `index.ts`
 * spreads it.
 */
async function sendTextTo(id: string, text: string): Promise<boolean> {
  const typed = await tmux(sendKeysLiteralArgs(id, text))
  if (typed.code !== 0) return false

  // Let the burst end before the return key, then look at what the typing produced — that frame is
  // the thing the submit has to change. See `submit-check.ts` for why the check is the SCREEN and
  // not the prompt's own words.
  await sleep(SUBMIT_SETTLE_MS)
  const typedFrame = await captureFrame(id)
  if ((await tmux(sendKeysNamedArgs(id, 'Enter'))).code !== 0) return false
  await sleep(SUBMIT_SHOW_MS)
  if (!frameChanged(typedFrame, await captureFrame(id))) {
    // The pane did not move. That is NOT proof the submit was swallowed — measured: a screen that
    // redraws identically looks the same either way — so it buys one more return rather than a
    // verdict. An extra return on an emptied input does nothing.
    await tmux(sendKeysNamedArgs(id, 'Enter'))
  }
  return true
}

async function captureFrame(id: string): Promise<string[]> {
  const { code, out } = await tmux(capturePaneArgs(id, DELIVER_CAPTURE_LINES))
  if (code !== 0) return []
  return trimCapture(out.split('\n'))
}

/**
 * Deliver the initial prompt once the harness is genuinely ready to receive it — see
 * `initial-prompt.ts` for the WHY. This is the impure half: it polls the pane, hands each frame to
 * the pure `planPromptDelivery`, and does exactly what it says. It NEVER submits into a startup or
 * approval dialog (the pure planner never returns an action for one), so the "press Enter too early
 * and select No, exit" accident cannot happen.
 */
async function deliverInitialPrompt(id: string, d: BackendInitialPrompt): Promise<void> {
  const deadline = Date.now() + DELIVER_DEADLINE_MS
  let readyStreak = 0
  while (Date.now() < deadline) {
    const frame = await captureFrame(id)
    const step = planPromptDelivery({ frame, mode: d.mode, readyStreak, ...(d.rules ? { rules: d.rules } : {}) })
    readyStreak = step.readyStreak
    if (step.action === 'done') return // a positional prompt that already auto-submitted
    if (step.action === 'type') { await sendTextTo(id, d.text ?? ''); return }
    if (step.action === 'submit') { await tmux(sendKeysNamedArgs(id, 'Enter')); return }
    await sleep(DELIVER_POLL_MS)
  }
  // Timed out. For a `type` harness, fall back to the old best-effort so a slow-but-eventually-up
  // harness still gets its prompt (never worse than before). For `submit`, do nothing: the text is
  // in the field, the CLI may still auto-submit, and a blind Enter now could land on a dialog we
  // never confirmed had cleared.
  if (d.mode === 'type') await sendTextTo(id, d.text ?? '')
}

let tmuxPresent: boolean | null = null
/** The install sentence, computed once — same cost as the presence check it already memoized. */
let tmuxMissingReason: string | null = null

/**
 * Why tmux is missing, and what would fix it — NAMING the manager and showing the exact command,
 * never a generic "install it" that leaves the reader to go find one themselves.
 *
 * `dependency-plan.ts` decides what to say; this only turns its three honest refusals into the one
 * sentence every caller of `unavailable()` already knows how to show (a plain string, dimmed under
 * the CLI's usage text, or a banner in the cockpit's Sessions tab).
 */
async function explainMissingTmux(): Promise<string> {
  const plan = await probeDependency('tmux')
  switch (plan.reason) {
    case 'windows':
      return 'tmux is not installed, and there is no Windows session backend — use WSL to manage background sessions.'
    case 'no-manager':
      return 'tmux is not installed, and no recognised package manager was found — install it yourself to manage background sessions.'
    default: {
      const line = dependencyCommandLine(plan)
      return line
        ? `tmux is not installed — install it with ${plan.manager}: ${line}`
        : 'tmux is not installed — install it to manage background sessions'
    }
  }
}

export const tmuxBackend: SessionBackend = {
  id: 'tmux',

  async unavailable() {
    if (tmuxPresent === null) {
      const { code } = await tmux(['-V'])
      tmuxPresent = code === 0
      if (!tmuxPresent) tmuxMissingReason = await explainMissingTmux()
    }
    return tmuxPresent ? undefined : tmuxMissingReason ?? 'tmux is not installed — install it to manage background sessions'
  },

  async spawn(req: BackendSpawn) {
    // Options and `new-session` go in ONE chained invocation. They must be set BEFORE the session
    // exists — `remain-on-exit` afterwards is a race the fast-failing case always wins,
    // `history-limit` afterwards does not apply to this pane at all, and `default-terminal` (the
    // colour fix) keeps tmux's 8-colour `screen` default for the life of a pane created before it.
    // Applied as SEPARATE pre-flight calls they were lost on a cold socket, because `set-option`
    // does not start a server — see `spawnArgs`.
    const profile = await terminalProfile()
    const { code, out } = await tmux(
      spawnArgs(profile, { id: req.id, cwd: req.cwd, argv: req.argv }),
    )
    if (code !== 0) throw new Error(out.trim() || `tmux new-session failed (code ${code})`)
    if (req.initialPrompt) {
      // Deliver the prompt only once the harness is READY — polled, not a fixed sleep — so a slow
      // start does not lose it and a startup dialog is never submitted into. See `deliverInitialPrompt`.
      await deliverInitialPrompt(req.id, req.initialPrompt)
    }
  },

  sendText: sendTextTo,

  async sendTextRaw(id: string, text: string) {
    // Literal only, NO Enter — the first half of `sendTextTo`. This is what the browser's key-by-key
    // channel needs: a character appears without submitting a turn.
    return (await tmux(sendKeysLiteralArgs(id, text))).code === 0
  },

  async sendKey(id: string, key: string) {
    return (await tmux(sendKeysNamedArgs(id, key))).code === 0
  },

  async list(): Promise<BackendSession[]> {
    // "no server running on …" is the ordinary empty state, not an error: exit code 1 with no
    // sessions is what tmux reports before anything has been started.
    const { out } = await tmux(listSessionsArgs())
    return parseTmuxList(out)
  },

  async capture(id: string, lines: number) {
    const { code, out } = await tmux(capturePaneArgs(id, lines))
    if (code !== 0) return []
    return trimCapture(out.split('\n'))
  },

  async captureTerminal(id: string, lines: number): Promise<TerminalCapture | null> {
    // Content FIRST: a non-zero capture is how we learn the session is gone, and there is no point
    // asking for its geometry once it is. `-e` keeps the colours; the frame is NOT trailing-trimmed
    // because a full-screen TUI's blank rows are part of its layout, not padding to discard.
    const cap = await tmux(capturePaneAnsiArgs(id, lines))
    if (cap.code !== 0) return null // tmux no longer has this session — the caller ends the stream
    // A trailing '' from the final newline is not a real row; drop only that one.
    const raw = cap.out.split('\n')
    if (raw.length && raw[raw.length - 1] === '') raw.pop()

    const meta = await tmux(paneInfoArgs(id))
    const info = meta.code === 0 ? parsePaneInfo(meta.out) : null
    if (!info) {
      // The pane exists (capture succeeded) but display-message could not be read or parsed. Rather
      // than ship a confident-wrong cursor, fall back to a minimal honest geometry: the browser
      // emulator sizes itself, so `cols: 0` is a "don't know" the client can ignore, and `alive` is
      // true because the capture just worked. Never a throw.
      return { lines: raw, info: { cols: 0, rows: raw.length, cursorX: 0, cursorY: 0, alive: true, historySize: 0 } }
    }
    return { lines: raw, info }
  },

  async kill(id: string) {
    const { code, err } = await tmux(killSessionArgs(id))
    // A non-zero exit that ISN'T "already gone" leaves the session running — reporting success
    // anyway is exactly the bug this return value exists to prevent (see types.ts).
    return code === 0 || isSessionGoneError(err)
  },

  attachCommand(id: string) {
    return attachArgs(id)
  },

  async detachHint() {
    const { out } = await tmux(showPrefixArgs())
    return parsePrefix(out)
  },

  async listPanePids(): Promise<Map<string, number>> {
    const { out } = await tmux(['list-panes', '-a', '-F', '#{session_name}\t#{pane_pid}'])
    const map = new Map<string, number>()
    for (const raw of out.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const [name, pidStr] = line.split('\t')
      if (!name || !pidStr) continue
      const id = idFromTmuxName(name)
      const pid = Number(pidStr)
      if (id && Number.isFinite(pid) && pid > 0) {
        map.set(id, pid)
      }
    }
    return map
  },
}
