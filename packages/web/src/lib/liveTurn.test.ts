import { expect, test, describe } from 'bun:test'
import { liveTurnText, stripAnsi } from './liveTurn'

describe('stripAnsi', () => {
  test('strips a CSI sequence, ESC byte included', () => {
    // The bug: a pattern matching only "[38;5;208m" left the ESC byte behind, which a monospace
    // font renders as a stray glyph — that byte has to go too, not just its parameters.
    expect(stripAnsi('\x1b[38;5;208mhello\x1b[0m')).toBe('hello')
  })

  test('strips several codes inside one line, keeping the words between them', () => {
    expect(stripAnsi('\x1b[1mBold\x1b[0m and \x1b[31mred\x1b[0m text')).toBe('Bold and red text')
  })

  test('strips an OSC sequence terminated by BEL', () => {
    expect(stripAnsi('\x1b]0;window title\x07after')).toBe('after')
  })

  test('strips a lone ESC with nothing captured after it', () => {
    expect(stripAnsi('before\x1b')).toBe('before')
  })

  test('leaves tabs and newlines alone — they are speech, not chrome', () => {
    expect(stripAnsi('a\tb\nc')).toBe('a\tb\nc')
  })

  test('text with no escape sequences at all is untouched', () => {
    expect(stripAnsi('plain text')).toBe('plain text')
  })
})

describe('liveTurnText', () => {
  test('returns the text the screen is showing while the session works', () => {
    expect(liveTurnText({
      working: true,
      lines: ['Let me check the config first.', 'It looks like the port is taken.'],
    })).toBe('Let me check the config first.\nIt looks like the port is taken.')
  })

  test('a session that is not working has no in-flight turn', () => {
    // A still screen is the last thing that was said, not something being said.
    expect(liveTurnText({ working: false, lines: ['Done.'] })).toBeNull()
  })

  test('strips box drawing, prompts, spinners and the status strip', () => {
    expect(liveTurnText({
      working: true,
      lines: [
        '╭──────────────╮',
        '│              │',
        '⠋ Thinking…',
        'Reading the file.',
        '─────────────',
        '> ',
        '(esc to interrupt)',
      ],
    })).toBe('Reading the file.')
  })

  test('null rather than an empty string when nothing survives — no empty bubble', () => {
    expect(liveTurnText({ working: true, lines: ['────────', '│', '> '] })).toBeNull()
    expect(liveTurnText({ working: true, lines: [] })).toBeNull()
  })

  test('a screen still showing the committed turn is not a new one', () => {
    // The window between a turn landing in the transcript and the screen repainting, which would
    // otherwise render the same paragraph twice — once committed, once "live".
    expect(liveTurnText({
      working: true,
      lines: ['The port is taken.'],
      lastCommitted: 'The port is taken.',
    })).toBeNull()
  })

  test('the comparison survives the frame wrapping where the transcript does not', () => {
    // The same paragraph, broken at the pane width. Compared literally it would look like new text.
    expect(liveTurnText({
      working: true,
      lines: ['The port is already taken by', 'another process.'],
      lastCommitted: 'The port is already taken by another process.',
    })).toBeNull()
  })

  test('genuinely new text after a committed turn IS shown', () => {
    expect(liveTurnText({
      working: true,
      lines: ['Now trying the next port.'],
      lastCommitted: 'The port is taken.',
    })).toBe('Now trying the next port.')
  })

  test('keeps a paragraph break inside the text but not the empty top of the terminal', () => {
    expect(liveTurnText({
      working: true,
      lines: ['', '', 'First.', '', 'Second.', '', ''],
    })).toBe('First.\n\nSecond.')
  })

  test('does not eat a line that merely starts with a word like Enter', () => {
    // The chrome patterns must not begin eating speech: a missing line reads as a stall, and stalls
    // are exactly what this view exists to make visible.
    expect(liveTurnText({
      working: true,
      lines: ['Entering the directory now.'],
    })).toBe('Entering the directory now.')
  })
})
