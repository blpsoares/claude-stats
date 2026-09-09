import { describe, expect, test } from 'bun:test'
import { createShellTerminal } from './shell-terminal'
import { SHELL_SOCKET, TMUX_SOCKET } from './tmux-cli'

/** A recording fake tmux: every argv it was handed, and a scripted answer per verb. */
function fakeTmux(answers: Partial<Record<string, { code: number; out: string; err: string }>> = {}) {
  const calls: string[][] = []
  const run = async (args: string[]) => {
    calls.push(args)
    const verb = args.find(a => !a.startsWith('-') && a !== SHELL_SOCKET && a !== TMUX_SOCKET) ?? ''
    return answers[verb] ?? { code: 0, out: '', err: '' }
  }
  return { calls, run }
}

const PANE = '3\t7\t80\t24\t0\t120'

describe('every shell tmux call names the shell socket', () => {
  test('a capture does', async () => {
    const t = fakeTmux({ 'capture-pane': { code: 0, out: 'hi\n', err: '' }, 'display-message': { code: 0, out: PANE, err: '' } })
    await createShellTerminal(t.run).capture('s1', 200)
    expect(t.calls.length).toBeGreaterThan(0)
    for (const args of t.calls) expect(args.slice(0, 2)).toEqual(['-L', SHELL_SOCKET])
  })

  test('so do the two writes', async () => {
    const t = fakeTmux()
    const term = createShellTerminal(t.run)
    await term.sendText('s1', 'ls')
    await term.sendKey('s1', 'C-c')
    for (const args of t.calls) expect(args.slice(0, 2)).toEqual(['-L', SHELL_SOCKET])
    // The fleet socket is what a builder called with no argument takes — the mistake this
    // whole phase is designed around, and it would still work.
    expect(t.calls.some(a => a.includes(TMUX_SOCKET))).toBe(false)
  })
})

describe('capture', () => {
  test('shapes the pane into lines plus its geometry', async () => {
    const t = fakeTmux({
      'capture-pane': { code: 0, out: 'one\ntwo\n', err: '' },
      'display-message': { code: 0, out: PANE, err: '' },
    })
    const cap = await createShellTerminal(t.run).capture('s1', 200)
    // The trailing '' from the final newline is not a row.
    expect(cap?.lines).toEqual(['one', 'two'])
    expect(cap?.info).toEqual({ cols: 80, rows: 24, cursorX: 3, cursorY: 7, alive: true, historySize: 120 })
  })

  test('a pane tmux no longer has answers null — which ENDS the stream', async () => {
    const t = fakeTmux({ 'capture-pane': { code: 1, out: '', err: "can't find session" } })
    expect(await createShellTerminal(t.run).capture('gone', 200)).toBeNull()
  })

  test('an unreadable geometry yields an honest fallback, never a confident cursor', async () => {
    const t = fakeTmux({
      'capture-pane': { code: 0, out: 'x\n', err: '' },
      'display-message': { code: 1, out: '', err: 'nope' },
    })
    const cap = await createShellTerminal(t.run).capture('s1', 200)
    expect(cap?.lines).toEqual(['x'])
    // `cols: 0` is a "don't know" the browser emulator ignores; `alive` is true because the capture
    // just worked. The same fallback `backend-tmux.ts` makes for a fleet pane.
    expect(cap?.info.cols).toBe(0)
    expect(cap?.info.alive).toBe(true)
  })

  test('a blank pane is EMPTY, not gone', async () => {
    const t = fakeTmux({
      'capture-pane': { code: 0, out: '', err: '' },
      'display-message': { code: 0, out: PANE, err: '' },
    })
    const cap = await createShellTerminal(t.run).capture('s1', 200)
    expect(cap).not.toBeNull()
    expect(cap?.lines).toEqual([])
  })
})

describe('the writes report what actually happened', () => {
  test('a non-zero send is a failure, never a silent success', async () => {
    const t = fakeTmux({ 'send-keys': { code: 1, out: '', err: 'no session' } })
    const term = createShellTerminal(t.run)
    expect(await term.sendText('s1', 'ls')).toBe(false)
    expect(await term.sendKey('s1', 'Enter')).toBe(false)
  })

  test('a zero send is a success', async () => {
    const t = fakeTmux()
    expect(await createShellTerminal(t.run).sendText('s1', 'ls')).toBe(true)
  })

  test('literal text and a named key are DIFFERENT calls', async () => {
    // `send-keys -l Enter` types five letters. Confusing the two fails silently in tmux, which is
    // why the argv builders are separate downstream.
    const t = fakeTmux()
    const term = createShellTerminal(t.run)
    await term.sendText('s1', 'Enter')
    await term.sendKey('s1', 'Enter')
    expect(t.calls[0]).toContain('-l')
    expect(t.calls[1]).not.toContain('-l')
  })
})
