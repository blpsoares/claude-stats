import { describe, expect, it } from 'bun:test'
import {
  INITIAL_COMPOSER,
  canEdit,
  canSubmit,
  composerReducer,
  interactionBlock,
  type ComposerState,
} from './terminalInput'

/** Armed with the keyboard on the TERMINAL — what pressing the arm button now produces. */
const armed: ComposerState = { armed: true, surface: 'terminal', draft: '', status: 'idle', error: null }
/** …and the same composer once the person deliberately opened the line editor. */
const lining: ComposerState = { ...armed, surface: 'line' }

describe('consent (decision 1) — explicit, per-session, revocable', () => {
  it('starts disarmed and empty', () => {
    expect(INITIAL_COMPOSER).toEqual({ armed: false, surface: 'terminal', draft: '', status: 'idle', error: null })
  })

  it('refuses to edit or submit while disarmed', () => {
    // A viewer who never armed the session cannot type into it, even by dispatching directly.
    expect(canEdit(INITIAL_COMPOSER)).toBe(false)
    expect(canSubmit(INITIAL_COMPOSER)).toBe(false)
    expect(composerReducer(INITIAL_COMPOSER, { type: 'edit', draft: 'ls' })).toEqual(INITIAL_COMPOSER)
    expect(composerReducer(INITIAL_COMPOSER, { type: 'submit' })).toEqual(INITIAL_COMPOSER)
  })

  it('arm hands the keyboard to the TERMINAL and starts from a clean line', () => {
    // Decision 5. It used to arm the LINE editor and focus it, so the one button labelled "type
    // into this session" put the caret in the one field that cannot type into the session.
    expect(composerReducer(INITIAL_COMPOSER, { type: 'arm' })).toEqual(armed)
    expect(canEdit(armed)).toBe(false)
    expect(canEdit(lining)).toBe(true)
  })

  it('arm never wipes a line already in progress', () => {
    const typing: ComposerState = { ...lining, draft: 'half a command' }
    expect(composerReducer(typing, { type: 'arm' })).toEqual(typing)
  })

  it('disarm revokes consent and drops the draft (a revoked session keeps no pending line)', () => {
    const typing: ComposerState = { ...lining, draft: 'rm -rf', status: 'failed', error: 'nope' }
    expect(composerReducer(typing, { type: 'disarm' })).toEqual(INITIAL_COMPOSER)
  })
})

describe('batched-to-a-line + lock (decision 2) — one atomic send, never mid-flight', () => {
  it('will not submit an empty or whitespace-only line', () => {
    expect(canSubmit(lining)).toBe(false)
    expect(canSubmit({ ...lining, draft: '   ' })).toBe(false)
    expect(canSubmit({ ...lining, draft: 'echo hi' })).toBe(true)
  })

  it('locks editing and submitting while a send is in flight (no reorder, no race)', () => {
    const sending: ComposerState = { ...lining, draft: 'echo hi', status: 'sending' }
    expect(canEdit(sending)).toBe(false)
    expect(canSubmit(sending)).toBe(false)
    expect(composerReducer(sending, { type: 'edit', draft: 'echo hi more' })).toEqual(sending)
    expect(composerReducer(sending, { type: 'submit' })).toEqual(sending)
  })

  it('submit moves a non-empty line into the sending state', () => {
    const ready: ComposerState = { ...lining, draft: 'echo hi' }
    expect(composerReducer(ready, { type: 'submit' })).toEqual({ ...ready, status: 'sending', error: null })
  })
})

describe('honest delivery (decision 3) — a key is never accepted-then-lost', () => {
  it('a delivered line clears the draft and stays armed for the next line', () => {
    const sending: ComposerState = { ...lining, draft: 'echo hi', status: 'sending' }
    expect(composerReducer(sending, { type: 'sent', ok: true, message: 'delivered' })).toEqual(lining)
  })

  it('a FAILED line is preserved verbatim and marked failed with the reason (never silently dropped)', () => {
    const sending: ComposerState = { ...lining, draft: 'echo hi', status: 'sending' }
    expect(composerReducer(sending, { type: 'sent', ok: false, message: 'session is not running' })).toEqual({
      ...lining, draft: 'echo hi', status: 'failed', error: 'session is not running',
    })
  })

  it('editing after a failure clears the failed marker (a fresh attempt), keeping the text', () => {
    const failed: ComposerState = { ...lining, draft: 'echo hi', status: 'failed', error: 'boom' }
    expect(composerReducer(failed, { type: 'edit', draft: 'echo hi!' })).toEqual({
      ...lining, draft: 'echo hi!', status: 'idle', error: null,
    })
    // a failed line can be re-submitted as-is
    expect(canSubmit(failed)).toBe(true)
  })

  it('a send result that lands after the user disarmed is ignored (no resurrection)', () => {
    const disarmedMidFlight = INITIAL_COMPOSER
    expect(composerReducer(disarmedMidFlight, { type: 'sent', ok: true, message: 'delivered' })).toEqual(INITIAL_COMPOSER)
    expect(composerReducer(disarmedMidFlight, { type: 'sent', ok: false, message: 'boom' })).toEqual(INITIAL_COMPOSER)
  })

  it('a result only lands while a send is actually in flight', () => {
    // An 'idle' armed composer (nothing sending) ignores a stray result.
    expect(composerReducer(armed, { type: 'sent', ok: false, message: 'boom' })).toEqual(armed)
  })
})

describe('interactionBlock — when the row cannot be typed into', () => {
  it('maps each fleet state to its block reason (or null when typable)', () => {
    expect(interactionBlock('working')).toBe(null)
    expect(interactionBlock('waiting')).toBe(null)
    expect(interactionBlock('waiting-approval')).toBe('awaiting-approval')
    expect(interactionBlock('exited')).toBe('not-running')
    expect(interactionBlock('lost')).toBe('not-running')
    expect(interactionBlock('closed')).toBe('not-running')
    expect(interactionBlock('unknown')).toBe('external')
  })
})

describe('where the keys go (decision 5) — one surface owns the keyboard', () => {
  it('opens the line editor only when it is asked for, and hands the keyboard back', () => {
    const opened = composerReducer(armed, { type: 'surface', surface: 'line' })
    expect(opened.surface).toBe('line')
    expect(canEdit(opened)).toBe(true)
    const back = composerReducer(opened, { type: 'surface', surface: 'terminal' })
    expect(back.surface).toBe('terminal')
    expect(canEdit(back)).toBe(false)
  })

  it('keeps the line the person wrote when the keyboard moves back to the pane', () => {
    // The draft is theirs and nothing else has a copy — the same reason `sessionScratch` keeps one.
    const written: ComposerState = { ...lining, draft: 'bun test' }
    expect(composerReducer(written, { type: 'surface', surface: 'terminal' }).draft).toBe('bun test')
  })

  it('refuses to move while a line is in flight', () => {
    const sending: ComposerState = { ...lining, draft: 'echo hi', status: 'sending' }
    expect(composerReducer(sending, { type: 'surface', surface: 'terminal' })).toEqual(sending)
  })

  it('refuses to move while disarmed — there is no keyboard to hand out', () => {
    expect(composerReducer(INITIAL_COMPOSER, { type: 'surface', surface: 'line' })).toEqual(INITIAL_COMPOSER)
  })

  it('clears a stale refusal when the surface changes', () => {
    const failed: ComposerState = { ...lining, draft: 'echo hi', status: 'failed', error: 'boom' }
    const back = composerReducer(failed, { type: 'surface', surface: 'terminal' })
    expect(back.status).toBe('idle')
    expect(back.error).toBe(null)
    expect(back.draft).toBe('echo hi')
  })
})
