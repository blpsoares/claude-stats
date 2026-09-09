import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listSessionsArgs, SHELL_SOCKET, TMUX_SOCKET } from './tmux-cli'
import { shellsPath } from './shell-store'
import { routeCapability } from '../capability-guard'

/**
 * A SHELL IS NOT A SESSION, and the cost of getting that wrong is invisible.
 *
 * The feature would work perfectly and quietly add a pane capture to the ~200 ms walk
 * `host.sessions()` runs every 5 s in four processes, put a row per shell in every fleet surface,
 * hand each one to `attention.ts` to be probed for dialog markers, and count an `htop` toward
 * "N sessions waiting on you". So the separation is asserted here rather than left to be noticed.
 */

const HERE = import.meta.dir

test('the fleet lists ONE socket and it is not the shells’', () => {
  // `parseTmuxList` keeps any session whose name starts with `agentop-`, and `reconcileSessions`
  // turns a running session with no registry record into an `unregistered` row. On one socket a
  // shell would therefore be a fleet row nobody can act on. This is the assertion that stops it.
  expect(listSessionsArgs().slice(0, 2)).toEqual(['-L', TMUX_SOCKET])
  expect(SHELL_SOCKET).not.toBe(TMUX_SOCKET)
})

test('the shell store is not the session registry', () => {
  expect(shellsPath('/x')).not.toContain('managed-sessions')
})

test('the routes are guarded, including ones nobody has written', () => {
  expect(routeCapability('/api/shell/open')).toBe('localShell')
  expect(routeCapability('/api/shell/whatever-comes-next')).toBe('localShell')
})

/**
 * COMMENTS ARE STRIPPED FIRST, and that is not a loophole.
 *
 * These modules are REQUIRED to explain themselves in terms of the registry — the whole reason they
 * exist is that a shell must not be in it, and the first version of this test failed on
 * `shell-store.ts`'s own header for saying so. What must not appear is a reference in CODE.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

test('NO SHELL MODULE TOUCHES THE SESSION REGISTRY', async () => {
  // Asserted over the SOURCE, like `events-frontier.test.ts`, because nothing else would fail: the
  // import would work, the tests would pass, and the cost would show up as a slower machine.
  const MODULES = [
    'shell-backend.ts', 'shell-store.ts', 'shell-spec.ts', 'shell-web.ts', 'shell-gate.ts',
    // Phase 2 — the read and write channels. They are the two places a shell id could most easily
    // be resolved against the fleet: both channels ALREADY exist for sessions, and reusing
    // `terminal-web.ts` / `input-web.ts` would have scoped a shell against `managed-sessions.json`.
    'shell-terminal.ts', 'shell-stream-web.ts', 'shell-input-web.ts',
  ]
  for (const f of MODULES) {
    const src = code(await readFile(join(HERE, f), 'utf-8'))
    expect(src).not.toContain('managed-sessions')
    expect(src).not.toContain("from './registry'")
    expect(src).not.toContain("from './session-view'")
  }
})

test('the stripper does not hide a real reference behind a comment', () => {
  // The guard above is only worth having if it still sees code. This is the test of the test.
  expect(code("/* managed-sessions */\nimport x from './registry'")).toContain("from './registry'")
  expect(code('// managed-sessions.json\nconst a = 1')).not.toContain('managed-sessions')
})

test('every tmux call the shell backend makes NAMES the shell socket', async () => {
  // A builder called without a socket silently takes the fleet's, which is precisely the mistake
  // this phase is designed around — and it would still work, which is why a test says it.
  const src = await readFile(join(HERE, 'shell-backend.ts'), 'utf-8')
  const calls = src.match(/(newSessionArgs|killSessionArgs|listSessionsArgs)\(/g) ?? []
  expect(calls.length).toBeGreaterThanOrEqual(3)
  // `listSessionsArgs()` with no argument is the fleet socket. It must not appear here.
  expect(src).not.toMatch(/listSessionsArgs\(\s*\)/)
  expect((src.match(/SHELL_SOCKET/g) ?? []).length).toBeGreaterThanOrEqual(calls.length)
})

test('and so does every tmux call the shell TERMINAL makes', async () => {
  // Phase 2's pane I/O. The same builders the fleet uses, and the same silent default if the
  // socket is left off — so the same assertion, over the module that reads and writes the pane.
  const src = await readFile(join(HERE, 'shell-terminal.ts'), 'utf-8')
  const calls = src.match(/(capturePaneAnsiArgs|paneInfoArgs|sendKeysLiteralArgs|sendKeysNamedArgs)\(/g) ?? []
  expect(calls.length).toBeGreaterThanOrEqual(4)
  expect((src.match(/SHELL_SOCKET/g) ?? []).length).toBeGreaterThanOrEqual(calls.length)
})

test('the shell channels do not reach the FLEET channels', async () => {
  // `terminal-web.ts` and `input-web.ts` scope against `readRegistry`. Importing either would give
  // a shell id the fleet's answer — the row-shaped failure this whole separation exists to stop —
  // and the feature would still appear to work.
  for (const f of ['shell-stream-web.ts', 'shell-input-web.ts']) {
    const src = code(await readFile(join(HERE, f), 'utf-8'))
    expect(src).not.toContain("from './terminal-web'")
    expect(src).not.toContain("from './input-web'")
  }
})
