import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { NOTIFICATION_TEXT, resolveNotification } from './notifications'

/**
 * EVERY CODE THE SERVER CAN EMIT HAS TEXT ON BOTH SIDES.
 *
 * Reported as blank notification cards: an icon, a timestamp, a dismiss button and nothing to read.
 * Only `code` + `meta` are ever stored — deliberately, so switching the language re-translates —
 * so a code this table has not met is a card that says an event happened and refuses to say what.
 *
 * A grep over the SERVER's own source, in the shape `tokens.lint.test.ts` uses: the check is that
 * the two halves cannot drift, and the only way to hold that is to read the half that emits.
 */
const SERVER = join(import.meta.dir, '../../../server/server')

/** Codes that appear only inside tests and fixtures — they are not events this product raises. */
const FIXTURES = new Set(['a', 'b', 'c', 'x', 'custom', 'ambiguous', 'missing_field', 'some.new_code_nobody_scoped'])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

const emitted = (): Set<string> => {
  const found = new Set<string>()
  for (const file of walk(SERVER)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/code: '([a-z][a-z_.]*)'/g)) {
      if (!FIXTURES.has(m[1]!)) found.add(m[1]!)
    }
  }
  return found
}

describe('notification coverage', () => {
  it('every code the server emits has EN and PT text', () => {
    const missing: string[] = []
    for (const code of [...emitted()].sort()) {
      const t = NOTIFICATION_TEXT[code]
      if (!t?.en?.title || !t?.pt?.title) missing.push(code)
    }
    expect(missing).toEqual([])
  })

  it('the server emits enough codes for this test to be worth anything', () => {
    // A guard on the guard: if the grep stops matching (the emit shape changed), the test above
    // passes vacuously and the next blank card ships.
    expect(emitted().size).toBeGreaterThan(15)
  })

  it('an UNKNOWN code still renders something a person can read', () => {
    // The lint can only see the codes this build emits. A notification stored by a newer build and
    // read by an older one is the case it cannot reach — and a blank card is the one outcome that
    // must be impossible.
    const out = resolveNotification(
      { id: '1', type: 'info', code: 'something.nobody.mapped', ts: 0, read: false },
      'en',
    )
    expect(out.title).toContain('something.nobody.mapped')
    expect(out.title.trim()).not.toBe('')
  })
})
