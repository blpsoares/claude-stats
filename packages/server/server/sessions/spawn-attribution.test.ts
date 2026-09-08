import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A lint, not a unit test — the same shape `tokens.lint.test.ts` uses over the product source.
 *
 * Every `addSession(` call must carry the task attribution. A new spawn path that forgets is a
 * source of unattributed sessions, and the symptom is a rollup that is quietly short: nothing
 * throws, nothing is red, and the number on screen is simply wrong.
 *
 * Roots are derived from this file's own location rather than from the working directory, so the
 * lint says the same thing however the suite was invoked.
 */
const SESSIONS_DIR = import.meta.dir
const SERVER_DIR = join(SESSIONS_DIR, '..')
const ROOTS = [SERVER_DIR, SESSIONS_DIR]

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.ts') && !e.name.includes('.test.'))
    .map(e => join(dir, e.name))
}

describe('every spawn path stamps the task attribution', () => {
  it('has no addSession call without taskId beside it', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of filesIn(root)) {
        const src = readFileSync(file, 'utf8')
        let from = 0
        for (;;) {
          const at = src.indexOf('addSession({', from)
          if (at === -1) break
          from = at + 1
          // The object literal that follows. Generous, because these literals carry a dozen
          // conditional spreads; a false PASS here is impossible (the field is either named in the
          // window or it is not), and a window too short would only ever raise a false alarm.
          const block = src.slice(at, at + 1600)
          if (!block.includes('taskId')) {
            offenders.push(`${file}:${src.slice(0, at).split('\n').length}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('is actually looking at something — the roots hold addSession calls', () => {
    // A lint that silently stopped matching passes forever. This is the guard against a rename of
    // `addSession`, a moved file, or a glob that quietly resolves to nothing.
    const total = ROOTS
      .flatMap(filesIn)
      .map(f => readFileSync(f, 'utf8').split('addSession({').length - 1)
      .reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThan(0)
  })
})
