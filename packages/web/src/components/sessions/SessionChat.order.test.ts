import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * A HOOK THAT READS ANOTHER HOOK'S VALUE MUST BE DECLARED AFTER IT.
 *
 * `useMemo` runs its factory DURING the render, at the point it is called — so a memo written above
 * the `useRef` it reads touches a binding still in its temporal dead zone. That shipped: the queued
 * -messages memo read `echoSeen.current` from ten lines above the `useRef`, and threw
 * `ReferenceError: Cannot access 'W' before initialization` the moment `echo` had anything in it —
 * which is to say the moment a message was sent. The error boundary caught it AFTER the message had
 * gone, so it read as "dá esse erro (mas envia)".
 *
 * TypeScript does not catch it: using a `const` inside a closure declared earlier in the same scope
 * is legal at compile time and only fails when the closure actually runs. So the order is pinned
 * here, over the source, in the shape this repo already uses for rules a type cannot express.
 */
const FILE = join(import.meta.dir, 'SessionChat.tsx')

describe('SessionChat hook order', () => {
  it('the queued-messages memo comes after the ref it reads', () => {
    const src = readFileSync(FILE, 'utf8')
    const ref = src.indexOf('const echoSeen = useRef')
    const memo = src.indexOf('const queued = useMemo')
    expect(ref).toBeGreaterThan(-1)
    expect(memo).toBeGreaterThan(-1)
    expect(memo).toBeGreaterThan(ref)
  })

  it('and it really does read that ref — so the check above is not vacuous', () => {
    const src = readFileSync(FILE, 'utf8')
    const memo = src.indexOf('const queued = useMemo')
    const body = src.slice(memo, memo + 1200)
    expect(body).toContain('echoSeen.current')
  })
})
