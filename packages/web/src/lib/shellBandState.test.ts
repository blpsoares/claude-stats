import { describe, expect, test } from 'bun:test'
import {
  INITIAL_SHELL_BAND, shellBandReducer, shellResolveWanted, type ShellBandState,
} from './shellBandState'

const opening = (): ShellBandState =>
  shellBandReducer(shellBandReducer(INITIAL_SHELL_BAND, { type: 'openBand' }), { type: 'resolving' })

describe('the ATTEMPT is what drives a request, and only a person moves it', () => {
  test('nothing has been asked yet', () => {
    expect(INITIAL_SHELL_BAND.attempt).toBe(0)
  })

  test('opening the band asks once', () => {
    expect(shellBandReducer(INITIAL_SHELL_BAND, { type: 'openBand' }).attempt).toBe(1)
  })

  test('THE EFFECT’S OWN DISPATCHES NEVER MOVE IT, or the effect re-triggers itself', () => {
    // This is the loop the first two versions of this band hit: the resolve ran in an effect that
    // changed the very thing it depended on, so its cleanup cancelled the request it had just made
    // and the next render started another. `attempt` is the dependency, and only `openBand` and
    // `retry` — both of them a person's act — advance it.
    const asked = shellBandReducer(INITIAL_SHELL_BAND, { type: 'openBand' })
    for (const a of [
      { type: 'resolving' }, { type: 'resolved', shell: { id: 'a', cwd: '/x' } },
      { type: 'refused', message: 'no' }, { type: 'cancelled' }, { type: 'closeBand' },
    ] as const) {
      expect(shellBandReducer(asked, a).attempt).toBe(asked.attempt)
    }
  })

  test('retry asks again', () => {
    const refused = shellBandReducer(opening(), { type: 'refused', message: 'no' })
    expect(shellBandReducer(refused, { type: 'retry' }).attempt).toBe(refused.attempt + 1)
  })

  test('re-opening a band that already holds a shell asks nothing', () => {
    const open = shellBandReducer(opening(), { type: 'resolved', shell: { id: 'a', cwd: '/x' } })
    const shut = shellBandReducer(open, { type: 'closeBand' })
    expect(shellBandReducer(shut, { type: 'openBand' }).attempt).toBe(shut.attempt)
  })
})

describe('the band never claims to be opening with nothing in flight', () => {
  test('the happy path: open the band, resolve, show the screen', () => {
    let s = shellBandReducer(INITIAL_SHELL_BAND, { type: 'openBand' })
    expect(s.phase).toBe('wanted')
    s = shellBandReducer(s, { type: 'resolving' })
    expect(s.phase).toBe('opening')
    s = shellBandReducer(s, { type: 'resolved', shell: { id: 'a', cwd: '/x' } })
    expect(s.phase).toBe('ready')
    expect(s.shell).toEqual({ id: 'a', cwd: '/x' })
    expect(s.message).toBeNull()
  })

  test('AN ATTEMPT THAT WAS CANCELLED GOES BACK TO WANTED, never stays "opening"', () => {
    // The defect this reducer replaces: the resolve lived in an effect whose cleanup set a
    // `cancelled` flag that ALSO suppressed the "no longer busy" write. A run cancelled between its
    // request and its answer therefore left the band spinning on "Abrindo…" with nothing in flight,
    // no shell, no error — and no dependency left to change, so nothing ever retried it. Seen on
    // screen: a band stuck on "Abrindo…" over an empty terminal.
    const s = shellBandReducer(opening(), { type: 'cancelled' })
    expect(s.phase).toBe('wanted')
    expect(shellResolveWanted(s)).toBe(true)
  })

  test('a refusal is a sentence and a DEAD STOP — never a silent retry loop', () => {
    const s = shellBandReducer(opening(), { type: 'refused', message: 'Já há 8 terminais abertos.' })
    expect(s.phase).toBe('refused')
    expect(s.message).toBe('Já há 8 terminais abertos.')
    // Retrying by itself would hammer a server that already said no, in a loop nobody asked for.
    expect(shellResolveWanted(s)).toBe(false)
  })

  test('but a refusal can always be retried by hand', () => {
    let s = shellBandReducer(opening(), { type: 'refused', message: 'nope' })
    s = shellBandReducer(s, { type: 'retry' })
    expect(s.phase).toBe('wanted')
    expect(s.message).toBeNull()
    expect(shellResolveWanted(s)).toBe(true)
  })

  test('closing the band drops the phase but KEEPS the shell — it is still running', () => {
    // Collapsing stops the capture; it does not end the shell. Re-opening must not mint a second.
    const open = shellBandReducer(opening(), { type: 'resolved', shell: { id: 'a', cwd: '/x' } })
    const shut = shellBandReducer(open, { type: 'closeBand' })
    expect(shut.phase).toBe('closed')
    expect(shut.shell).toEqual({ id: 'a', cwd: '/x' })
    expect(shellResolveWanted(shut)).toBe(false)
    expect(shellBandReducer(shut, { type: 'openBand' }).phase).toBe('ready')
  })

  test('ENDING the shell forgets it, so the next open mints a new one', () => {
    const open = shellBandReducer(opening(), { type: 'resolved', shell: { id: 'a', cwd: '/x' } })
    const gone = shellBandReducer(open, { type: 'ended' })
    expect(gone.shell).toBeNull()
    expect(gone.phase).toBe('closed')
  })

  test('only ONE attempt is ever in flight', () => {
    // `resolving` on an already-opening band changes nothing, so a re-render cannot start a second
    // request — which is how a session ended up with three shells of its own.
    const twice = shellBandReducer(opening(), { type: 'resolving' })
    expect(twice).toEqual(opening())
    expect(shellResolveWanted(opening())).toBe(false)
  })

  test('a resolve is wanted exactly when the band wants one and none is in flight', () => {
    expect(shellResolveWanted(INITIAL_SHELL_BAND)).toBe(false)
    expect(shellResolveWanted(shellBandReducer(INITIAL_SHELL_BAND, { type: 'openBand' }))).toBe(true)
  })
})
