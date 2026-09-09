import { test, expect } from 'bun:test'
import { existsSync } from 'fs'
import { claudeAdapter, tagClaude } from './claude'
import { CLAUDE_DIR } from '../config'
import type { SessionMeta } from '@agentistics/core'

/**
 * THE INVARIANT IS THE POINT, AND THE FULL SCAN WAS NOT PROVING IT WHERE IT MATTERED.
 *
 * This file used to hold one test: call `claudeAdapter.loadSessions()` — the whole real read of
 * `~/.claude` — and assert every session came back tagged `claude`, plus a non-empty result when
 * the directory exists. It ran on every commit, through the pre-commit hook, and it had two
 * problems that are really one:
 *
 * - **On CI it proved almost nothing.** There is no `~/.claude` there, so `loadSessions()` returns
 *   `[]`, `every()` is vacuously true and the `length > 0` assertion is skipped entirely. The only
 *   place the interesting half ever ran was a developer's own machine.
 * - **On that machine it was a coin flip.** The scan walks every project and parses every
 *   transcript; measured here it costs most of a two-minute suite by itself, and under load — this
 *   product is developed with several assistants running — it exceeded its own 120 s budget and
 *   FAILED the commit. Observed three times in one session, each time on a change that touched no
 *   adapter: pure tmux argv, and a pure module. A gate whose verdict is decided by how busy the
 *   laptop is teaches people to bypass the gate.
 *
 * So the invariant is now tested where it LIVES — `tagClaude`, the one line every session passes
 * through — exhaustively and in microseconds, including the cases the real tree happened not to
 * contain. The end-to-end read is still here and still asserts exactly what it did, behind
 * `AGENTISTICS_TEST_REAL_CLAUDE=1`: it is a useful thing to run deliberately, and a wasteful thing
 * to run before every commit on the one machine where it is slow.
 */

const meta = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ session_id: 's', start_time: '', ...over } as SessionMeta)

test('an untagged session becomes claude — the invariant the adapter exists to keep', () => {
  expect(tagClaude([meta()]).map(s => s.harness)).toEqual(['claude'])
})

test('a session that already names its harness is left ALONE', () => {
  // The map is `s.harness ? s : …` on purpose. `loadSessionMetas` and `scanProjects` are Claude's
  // own sources today, but a session that arrived carrying another harness must not be relabelled
  // into this one — that would be the adapter claiming work it did not read.
  expect(tagClaude([meta({ harness: 'codex' })]).map(s => s.harness)).toEqual(['codex'])
})

test('a MIXED list keeps each side of it', () => {
  // The real tree on any given machine may hold only one of these shapes, so the old test could
  // pass for years without ever exercising both branches.
  expect(tagClaude([meta({ harness: 'codex' }), meta(), meta({ harness: 'kimi' })])
    .map(s => s.harness)).toEqual(['codex', 'claude', 'kimi'])
})

test('an empty list is an empty list, not a throw', () => {
  expect(tagClaude([])).toEqual([])
})

test('EVERY session comes back tagged, whatever went in', () => {
  const out = tagClaude([meta(), meta({ harness: 'codex' }), meta()])
  expect(out.every(s => s.harness !== undefined)).toBe(true)
  expect(out).toHaveLength(3)
})

test('the input is not mutated — a tagged copy, never a rewrite of the caller’s object', () => {
  const input = meta()
  tagClaude([input])
  expect(input.harness).toBeUndefined()
})

/**
 * The end-to-end read, opt-in. Run it with:
 *
 *     AGENTISTICS_TEST_REAL_CLAUDE=1 bun test packages/server/server/adapters/claude.test.ts
 *
 * It asserts exactly what the old default test asserted; only its schedule changed.
 */
test.skipIf(process.env.AGENTISTICS_TEST_REAL_CLAUDE !== '1')(
  'INTEGRATION: the real ~/.claude tree loads, and every session of it is claude',
  async () => {
    const sessions = await claudeAdapter.loadSessions()
    expect(sessions.every(s => s.harness === 'claude')).toBe(true)
    if (existsSync(CLAUDE_DIR)) expect(sessions.length).toBeGreaterThan(0)
  },
  300_000,
)
