import { describe, expect, it } from 'bun:test'
import { classifyInput, inputReasonText, type KeyIntent } from './terminalKeys'

/** Small helper: assert a chunk classifies to an exact intent. */
function intent(data: string): KeyIntent {
  return classifyInput(data)
}

describe('printable text → literal (no submit)', () => {
  it('a single ASCII char is literal text', () => {
    expect(intent('a')).toEqual({ kind: 'text', text: 'a' })
    expect(intent('Z')).toEqual({ kind: 'text', text: 'Z' })
    expect(intent('7')).toEqual({ kind: 'text', text: '7' })
    expect(intent(' ')).toEqual({ kind: 'text', text: ' ' })
    expect(intent('$')).toEqual({ kind: 'text', text: '$' })
  })

  it('a multi-char printable chunk (paste / IME) is literal text, verbatim', () => {
    expect(intent('echo hi')).toEqual({ kind: 'text', text: 'echo hi' })
  })

  it('accented and non-ASCII printable characters pass as text (pt-BR matters)', () => {
    expect(intent('ção')).toEqual({ kind: 'text', text: 'ção' })
    expect(intent('é')).toEqual({ kind: 'text', text: 'é' })
  })
})

describe('newline → named Enter (a submit is a key, never literal)', () => {
  it('carriage return is Enter', () => {
    expect(intent('\r')).toEqual({ kind: 'key', key: 'Enter' })
  })
  it('line feed is Enter', () => {
    expect(intent('\n')).toEqual({ kind: 'key', key: 'Enter' })
  })
})

describe('editing / navigation keys → named keys', () => {
  it('DEL (0x7f) and BS (0x08) are BSpace', () => {
    expect(intent('\x7f')).toEqual({ kind: 'key', key: 'BSpace' })
    expect(intent('\x08')).toEqual({ kind: 'key', key: 'BSpace' })
  })
  it('tab is Tab', () => {
    expect(intent('\t')).toEqual({ kind: 'key', key: 'Tab' })
  })
  it('CSI arrows map to Up/Down/Right/Left', () => {
    expect(intent('\x1b[A')).toEqual({ kind: 'key', key: 'Up' })
    expect(intent('\x1b[B')).toEqual({ kind: 'key', key: 'Down' })
    expect(intent('\x1b[C')).toEqual({ kind: 'key', key: 'Right' })
    expect(intent('\x1b[D')).toEqual({ kind: 'key', key: 'Left' })
  })
  it('SS3 arrows (application cursor mode) also map', () => {
    expect(intent('\x1bOA')).toEqual({ kind: 'key', key: 'Up' })
    expect(intent('\x1bOD')).toEqual({ kind: 'key', key: 'Left' })
  })
})

describe('the two mandated control keys → named keys (A7)', () => {
  it('Ctrl+C (0x03) is C-c — the interrupt that A7 exercises', () => {
    expect(intent('\x03')).toEqual({ kind: 'key', key: 'C-c' })
  })
  it('Ctrl+D (0x04) is C-d', () => {
    expect(intent('\x04')).toEqual({ kind: 'key', key: 'C-d' })
  })
})

describe('line-editing control keys → named keys (criterion: "edits the line" passes)', () => {
  it('Ctrl+A / Ctrl+E move the cursor to line start/end', () => {
    expect(intent('\x01')).toEqual({ kind: 'key', key: 'C-a' })
    expect(intent('\x05')).toEqual({ kind: 'key', key: 'C-e' })
  })
  it('Ctrl+U / Ctrl+W / Ctrl+K edit the line (kill line / word / to-end)', () => {
    expect(intent('\x15')).toEqual({ kind: 'key', key: 'C-u' })
    expect(intent('\x17')).toEqual({ kind: 'key', key: 'C-w' })
    expect(intent('\x0b')).toEqual({ kind: 'key', key: 'C-k' })
  })
})

describe('allowlist — nothing else reaches the process', () => {
  it('empty input is blocked as empty', () => {
    expect(intent('')).toEqual({ kind: 'blocked', reason: 'empty' })
  })
  it('control keys that touch the PROCESS (not the line) are refused', () => {
    // The line separating the allowed group from this one: editing the line passes; controlling the
    // process is refused unless explicitly requested (only C-c / C-d are).
    expect(intent('\x1a')).toEqual({ kind: 'blocked', reason: 'unsupported-sequence' }) // Ctrl+Z suspend
    expect(intent('\x1c')).toEqual({ kind: 'blocked', reason: 'unsupported-sequence' }) // Ctrl+\ SIGQUIT
  })
  it('unmapped escape sequences (function keys, mouse, bracketed paste) are refused, never forwarded blindly', () => {
    expect(intent('\x1b[15~')).toEqual({ kind: 'blocked', reason: 'unsupported-sequence' }) // F5
    expect(intent('\x1b[200~')).toEqual({ kind: 'blocked', reason: 'unsupported-sequence' }) // paste start
    expect(intent('\x1b[M')).toEqual({ kind: 'blocked', reason: 'unsupported-sequence' }) // mouse
    expect(intent('\x1b')).toEqual({ kind: 'blocked', reason: 'unsupported-sequence' }) // lone ESC
  })
  it('a chunk mixing printable text and a control char is refused (not a single keystroke)', () => {
    // A paste containing a newline is the line-composer's job, not a raw keystroke — refuse rather
    // than silently reinterpret half of it as text and half as a key.
    expect(intent('ab\r')).toEqual({ kind: 'blocked', reason: 'unsupported-sequence' })
    expect(intent('a\x03')).toEqual({ kind: 'blocked', reason: 'unsupported-sequence' })
  })
})

describe('inputReasonText — the server\'s stable reason codes made human (both languages)', () => {
  it('maps every documented code in pt and en', () => {
    for (const code of ['bad_json', 'bad_message', 'empty_text', 'text_too_long', 'bad_key', 'send_failed', 'error'] as const) {
      expect(inputReasonText(code, 'en').length).toBeGreaterThan(0)
      expect(inputReasonText(code, 'pt').length).toBeGreaterThan(0)
    }
  })
  it('the load-bearing one — a keystroke that did not reach the process — reads as not delivered', () => {
    expect(inputReasonText('send_failed', 'en').toLowerCase()).toContain('not delivered')
    expect(inputReasonText('send_failed', 'pt').toLowerCase()).toContain('não')
  })
  it('an unknown code is shown verbatim rather than swallowed', () => {
    expect(inputReasonText('some_new_code', 'en')).toBe('some_new_code')
  })
})
