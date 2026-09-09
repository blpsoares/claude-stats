import { describe, expect, it } from 'bun:test'
import { MAX_TEXT_PER_MESSAGE, classifyInput, splitInput, inputReasonText, type KeyIntent } from './terminalKeys'

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
    // A LONE ESC used to be listed here. It is now `Escape` — a deliberate widening with its own
    // describe block above; everything BUILT on the escape byte is still refused unless mapped.
  })
  it('a chunk mixing printable text and a control char is refused (not a single keystroke)', () => {
    // A paste containing a newline is the line-composer's job, not a raw keystroke — refuse rather
    // than silently reinterpret half of it as text and half as a key.
    expect(intent('ab\r')).toEqual({ kind: 'blocked', reason: 'unsupported-sequence' })
    expect(intent('a\x03')).toEqual({ kind: 'blocked', reason: 'unsupported-sequence' })
  })
})

describe('Escape — the one widening the utility shell needed', () => {
  it('a bare ESC is a named key, not an unsupported sequence', () => {
    // A soft keyboard has no Escape at all, so the shell's mobile key strip is the only way out of
    // `vim`; and a permission dialog's own footer says `Esc to cancel`. It CANCELS and controls no
    // process, which is the line this allowlist draws.
    expect(classifyInput('\x1b')).toEqual({ kind: 'key', key: 'Escape' })
  })

  it('it does not swallow the escape SEQUENCES built on it', () => {
    // `\x1b[A` is still Up; the bare byte is only Escape when nothing follows it.
    expect(classifyInput('\x1b[A')).toEqual({ kind: 'key', key: 'Up' })
    expect(classifyInput('\x1bOD')).toEqual({ kind: 'key', key: 'Left' })
  })

  it('an unmapped escape sequence is still refused', () => {
    expect(classifyInput('\x1b[1;5A')).toEqual({ kind: 'blocked', reason: 'unsupported-sequence' })
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

/**
 * A chunk is not always one keystroke — and it is not always safe to take apart.
 *
 * Reported as messages typed into the live terminal that never sent. The whole server chain was
 * verified working (tmux `send-keys -l` then `send-keys Enter` submits; the WS channel acked 21/21
 * and submitted), so the loss was above it: `onData` hands over ONE chunk carrying the text AND the
 * return — which xterm does on a paste, under coalescing, and on a mobile keyboard delivering a
 * composed word with its return — and that chunk was refused whole and dropped by a bare `return`.
 *
 * The first fix decomposed a mixed chunk GENERALLY, and code review caught what that let through:
 * a multi-line paste became one submit per line, and a stray control byte in copied terminal output
 * was executed rather than refused. So exactly ONE mixed shape is admitted — printable text and the
 * single newline that ends it — and every other mixture stays refused, as it was.
 */
describe('splitInput — text and the return that ends it', () => {
  it('decomposes a line and its Enter, instead of refusing the whole chunk', () => {
    expect(splitInput('abc\r')).toEqual([
      { kind: 'text', text: 'abc' },
      { kind: 'key', key: 'Enter' },
    ])
    expect(splitInput('abc\n')).toEqual([
      { kind: 'text', text: 'abc' },
      { kind: 'key', key: 'Enter' },
    ])
  })

  it('collapses a trailing CRLF into ONE Enter — two would be a double submit', () => {
    expect(splitInput('ok\r\n')).toEqual([
      { kind: 'text', text: 'ok' },
      { kind: 'key', key: 'Enter' },
    ])
  })

  it('REFUSES a multi-line paste — one submit per line is worse than the old refusal', () => {
    // xterm normalizes pasted newlines to `\r`, so this is what a 2-line paste looks like. Split,
    // it would fire a turn per line, each carrying a fragment.
    expect(splitInput('a\r\nb\r\n')).toEqual([{ kind: 'blocked', reason: 'unsupported-sequence' }])
    expect(splitInput('a\rb\r')).toEqual([{ kind: 'blocked', reason: 'unsupported-sequence' }])
  })

  it('REFUSES text carrying a process-control byte — a person never types one mixed', () => {
    // Copied terminal output with a stray EOF would otherwise type the text and then end the
    // session; a stray 0x03 would interrupt the running turn.
    expect(splitInput('foo\x04')).toEqual([{ kind: 'blocked', reason: 'unsupported-sequence' }])
    expect(splitInput('a\x03b')).toEqual([{ kind: 'blocked', reason: 'unsupported-sequence' }])
    expect(splitInput('\x1b[Aabc')).toEqual([{ kind: 'blocked', reason: 'unsupported-sequence' }])
  })

  it('refuses text the SERVER would reject for length, rather than letting the Enter ride along', () => {
    // The Enter is accepted even when the text before it is not, which submits the prompt with
    // whatever it already held and none of what was pasted.
    const long = 'x'.repeat(MAX_TEXT_PER_MESSAGE + 1)
    expect(splitInput(long)).toEqual([{ kind: 'blocked', reason: 'too-long' }])
    expect(splitInput(`${long}\r`)).toEqual([{ kind: 'blocked', reason: 'too-long' }])
    // Exactly at the cap still goes.
    expect(splitInput('x'.repeat(MAX_TEXT_PER_MESSAGE))).toEqual([
      { kind: 'text', text: 'x'.repeat(MAX_TEXT_PER_MESSAGE) },
    ])
  })

  it('keeps a lone key, lone text and non-ASCII whole', () => {
    expect(splitInput('\r')).toEqual([{ kind: 'key', key: 'Enter' }])
    expect(splitInput('\r\n')).toEqual([{ kind: 'key', key: 'Enter' }])
    expect(splitInput('abc')).toEqual([{ kind: 'text', text: 'abc' }])
    expect(splitInput('café\r')).toEqual([
      { kind: 'text', text: 'café' },
      { kind: 'key', key: 'Enter' },
    ])
  })

  it('reports an empty chunk as the no-op it is', () => {
    expect(splitInput('')).toEqual([{ kind: 'blocked', reason: 'empty' }])
  })
})

describe('classifyInput stays derived from splitInput', () => {
  it('is the piece when a chunk decomposes into exactly one, and refuses otherwise', () => {
    expect(classifyInput('\r')).toEqual({ kind: 'key', key: 'Enter' })
    expect(classifyInput('abc')).toEqual({ kind: 'text', text: 'abc' })
    // Its own contract is unchanged: a mixed chunk is not ONE intent.
    expect(classifyInput('abc\r')).toEqual({ kind: 'blocked', reason: 'unsupported-sequence' })
  })
})
