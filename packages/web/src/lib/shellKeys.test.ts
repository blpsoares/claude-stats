import { describe, expect, it } from 'bun:test'
import { SHELL_STRIP, ctrlKeyFor, keyBytes, stripKeyLabel } from './shellKeys'
import { classifyInput, type NamedKey } from './terminalKeys'

/** Every named key the strip claims to send must survive the client allowlist. */
function sendable(key: NamedKey): boolean {
  const i = classifyInput(keyBytes(key))
  return i.kind === 'key' && i.key === key
}

describe('the mobile key strip', () => {
  it('carries exactly the keys the design names, in that order', () => {
    // `esc tab ctrl ↑ ↓ ← →` — without it there is no Ctrl+C on a phone, and a soft keyboard has
    // no arrow keys at all.
    expect(SHELL_STRIP.map(k => k.id)).toEqual(['esc', 'tab', 'ctrl', 'up', 'down', 'left', 'right'])
  })

  it('every direct key of the strip is one the channel actually accepts', () => {
    for (const entry of SHELL_STRIP) {
      if (entry.kind !== 'key') continue
      expect(sendable(entry.key)).toBe(true)
    }
  })

  it('ctrl is a MODIFIER, not a key — it has nothing to send on its own', () => {
    const ctrl = SHELL_STRIP.find(k => k.id === 'ctrl')
    expect(ctrl?.kind).toBe('modifier')
  })

  it('labels are readable glyphs, never internal ids', () => {
    expect(stripKeyLabel('up')).toBe('↑')
    expect(stripKeyLabel('esc')).toBe('esc')
  })
})

describe('a named key goes out as the bytes the emulator would have produced', () => {
  it('every key the channel accepts round-trips through the ONE classifier', () => {
    // The strip does not get a private send path: it produces the raw bytes and hands them to the
    // same `send` an actual keypress uses, so a key the allowlist would refuse is refused here too
    // rather than reaching the wire by a side door.
    const keys: NamedKey[] = [
      'Enter', 'BSpace', 'Tab', 'Escape', 'Up', 'Down', 'Left', 'Right',
      'C-c', 'C-d', 'C-a', 'C-e', 'C-u', 'C-w', 'C-k',
    ]
    for (const k of keys) expect(classifyInput(keyBytes(k))).toEqual({ kind: 'key', key: k })
  })
})

describe('ctrl composes with the NEXT character typed', () => {
  it('the interrupt everybody comes here for', () => {
    expect(ctrlKeyFor('c')).toBe('C-c')
  })

  it('case does not matter — a soft keyboard capitalises on its own', () => {
    expect(ctrlKeyFor('C')).toBe('C-c')
  })

  it('every control key the channel allows can be reached', () => {
    expect(ctrlKeyFor('d')).toBe('C-d')
    expect(ctrlKeyFor('a')).toBe('C-a')
    expect(ctrlKeyFor('e')).toBe('C-e')
    expect(ctrlKeyFor('u')).toBe('C-u')
    expect(ctrlKeyFor('w')).toBe('C-w')
    expect(ctrlKeyFor('k')).toBe('C-k')
  })

  it('a letter the channel does NOT allow yields nothing rather than a key it will refuse', () => {
    // `C-z` (suspend) and `C-\` (SIGQUIT) are deliberately outside the allowlist. Composing one and
    // sending it would earn a `bad_key` ack for a keystroke the person had every reason to expect
    // to work; answering `null` lets the strip say so instead.
    expect(ctrlKeyFor('z')).toBeNull()
    expect(ctrlKeyFor('1')).toBeNull()
  })

  it('a multi-character chunk is not a control key', () => {
    // A soft keyboard can deliver a whole composed word; that is not `ctrl` plus one letter.
    expect(ctrlKeyFor('cd')).toBeNull()
    expect(ctrlKeyFor('')).toBeNull()
  })
})
