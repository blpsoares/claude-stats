import { describe, expect, it } from 'bun:test'
import { QUIET_MS, approvalTail, attentionOf, digestFrame, frameTail, backgroundWork, dialogHeight
} from './attention'
import type { AttentionRules } from './types'

const NOW = 1_786_600_000_000

const rules: AttentionRules = {
  probed: 'test',
  approval: [/Enter to confirm/],
  working: [/esc to interrupt/],
}

/** Everything the function needs, with the session plainly quiet and unremarkable. */
const base = {
  alive: true,
  lastActivityMs: NOW - 60_000,
  nowMs: NOW,
  frame: ['idle'] as readonly string[],
  frameDigest: 'same',
  prevDigest: 'same',
}

describe('digestFrame', () => {
  it('is stable for the same frame', () => {
    expect(digestFrame(['a', 'b'])).toBe(digestFrame(['a', 'b']))
  })

  it('changes when the frame changes', () => {
    expect(digestFrame(['a', 'b'])).not.toBe(digestFrame(['a', 'c']))
  })

  it('does not collide across a line boundary shift', () => {
    // ['ab'] and ['a','b'] must differ: a digest that joined without a separator would call a
    // reflowed frame unchanged and report a working session as waiting.
    expect(digestFrame(['ab'])).not.toBe(digestFrame(['a', 'b']))
  })
})

describe('attentionOf', () => {
  it('reports a finished command as exited, whatever is on screen', () => {
    expect(attentionOf({ ...base, alive: false, frame: ['esc to interrupt'], rules })).toBe('exited')
  })

  it('reports an approval question even while the frame is moving', () => {
    // A blocked dialog outranks movement: nothing is running behind it, and a spinner elsewhere on
    // the screen must never hide the question.
    expect(attentionOf({
      ...base, frame: ['Enter to confirm · Esc to cancel'], frameDigest: 'new', rules,
    })).toBe('waiting-approval')
  })

  it('reports working from a proof marker even when the frame did not move', () => {
    expect(attentionOf({ ...base, frame: ['esc to interrupt'], rules })).toBe('working')
  })

  it('reports working when the frame changed since the last poll', () => {
    expect(attentionOf({ ...base, frameDigest: 'new', prevDigest: 'old', rules })).toBe('working')
  })

  it('reports working when the backend saw output inside the quiet window', () => {
    expect(attentionOf({ ...base, lastActivityMs: NOW - (QUIET_MS - 1), rules })).toBe('working')
  })

  it('reports waiting once the window has passed and nothing moved', () => {
    expect(attentionOf({ ...base, lastActivityMs: NOW - QUIET_MS, rules })).toBe('waiting')
  })

  it('still decides without any rules — movement alone is enough', () => {
    expect(attentionOf({ ...base, frameDigest: 'new', prevDigest: 'old' })).toBe('working')
    expect(attentionOf({ ...base })).toBe('waiting')
  })

  it('does not call a first sighting working just because there is no previous digest', () => {
    // The first poll of a long-quiet session has no prevDigest. Treating "unknown" as "changed"
    // would show every session as working for one interval after the cockpit opens.
    expect(attentionOf({ ...base, prevDigest: undefined })).toBe('waiting')
  })
})

describe('frameTail — what the session is saying', () => {
  // VERBATIM from a real claude 2.1.231 session, 2026-08-13: a prompt, the answer, a status line,
  // then the input box and the footer.
  const CLAUDE = [
    ' ⚠ 4 MCP servers need authentication · run /mcp',
    '',
    '❯ diga apenas: estou pronto',
    '',
    '● estou pronto',
    '',
    '✻ Cooked for 2s',
    '',
    '────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────',
    '  ⏸ manual mode on · ? for shortcuts · ← 6 agents                          /rc',
  ]

  it('returns what the assistant said, never the input box or the footer', () => {
    const tail = frameTail(CLAUDE)
    expect(tail).toContain('● estou pronto')
    expect(tail.some(l => l.includes('manual mode on'))).toBe(false)
    expect(tail.some(l => l.startsWith('❯ ') && l.trim() === '❯')).toBe(false)
    expect(tail.some(l => /^─+$/.test(l))).toBe(false)
  })

  it('keeps the lines in the order they were written', () => {
    const tail = frameTail(CLAUDE)
    expect(tail.indexOf('❯ diga apenas: estou pronto')).toBeLessThan(tail.indexOf('● estou pronto'))
  })

  it('drops a trailing status strip on a harness that draws no rule', () => {
    // codex 0.113.0: a ghost placeholder and a `·`-separated status strip, with no box rule at all.
    const codex = [
      '• Hi',
      '',
      '› Find and fix a bug in @filename',
      '',
      '  gpt-5.4-mini low · 100% left · /tmp/scratchpad',
    ]
    expect(frameTail(codex)).toContain('• Hi')
    expect(frameTail(codex).some(l => l.includes('100% left'))).toBe(false)
  })

  it('keeps a mid-conversation line that happens to contain the same separator', () => {
    // The separator is only chrome at the very END of a frame. A sentence the assistant wrote that
    // uses it is content, and dropping it would silently eat real answers.
    const frame = ['● done · ready', '────────', '❯ ', '────────', '  x · y']
    expect(frameTail(frame)).toEqual(['● done · ready'])
  })

  it('returns nothing rather than furniture when there is nothing to say', () => {
    expect(frameTail(['────────', '❯ ', '────────'])).toEqual([])
  })

  it('honours the line budget', () => {
    expect(frameTail(['a', 'b', 'c', 'd', 'e', 'f'], 2)).toEqual(['e', 'f'])
  })
})

describe('a working marker that outlives the screen', () => {
  // VERBATIM from a real claude session, 2026-08-13: the footer offers `esc to interrupt` because
  // background AGENTS exist, while the main thread had drawn nothing for 199 seconds.
  const LINGERING = [
    '  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← 6 agents · ↓ to manage      /rc',
    '  ● main',
    '  ◯ general-purpose  Fix findings from auto-rehydrate final review        1m 17s · ↓ 51.7k',
  ]
  const rules: AttentionRules = { probed: 'test', approval: [], working: [/esc to interrupt/] }

  const after = (silentMs: number) => attentionOf({
    alive: true,
    lastActivityMs: NOW - silentMs,
    nowMs: NOW,
    frame: LINGERING,
    frameDigest: 'same',
    prevDigest: 'same',
    rules,
  })

  it('trusts the marker while the screen has moved recently', () => {
    expect(after(10_000)).toBe('working')
  })

  it('stops trusting it once the screen has been silent for a minute', () => {
    // The session reported `working` for as long as it existed, which makes the one column this
    // monitor is for permanently wrong.
    expect(after(199_000)).toBe('waiting')
  })

  it('still calls a CHANGED frame working, however long the gap says', () => {
    // A frame that changed is direct evidence: something drew it. That outranks any staleness rule.
    expect(attentionOf({
      alive: true,
      lastActivityMs: NOW - 600_000,
      nowMs: NOW,
      frame: LINGERING,
      frameDigest: 'new',
      prevDigest: 'old',
      rules,
    })).toBe('working')
  })
})

/**
 * A real claude permission dialog, in the shape `capture-pane` hands it over: a conversation above,
 * then the box, then the footer naming the key. Trimmed to what a 60-line capture would end on.
 */
const DIALOG = [
  '● I will run the migration now.',
  '',
  '╭──────────────────────────────────────────╮',
  '│ Bash command                             │',
  '│                                          │',
  '│   bun run db:migrate                     │',
  '│                                          │',
  '│ Do you want to proceed?                  │',
  '│ ❯ 1. Yes                                 │',
  '│   2. No, and tell Claude what to do      │',
  '│                                          │',
  '│ Enter to confirm · Esc to cancel         │',
  '╰──────────────────────────────────────────╯',
]

describe('approvalTail', () => {
  it('keeps the dialog exactly as drawn — borders, options and footer included', () => {
    const out = approvalTail(DIALOG, 6)
    expect(out).toHaveLength(6)
    // The three that decide anything: which options there are, which one is highlighted, and the
    // key that takes it. None of them survives being tidied.
    expect(out.join('\n')).toContain('❯ 1. Yes')
    expect(out.join('\n')).toContain('2. No')
    expect(out.join('\n')).toContain('Enter to confirm')
  })

  it('is NOT frameTail — that one throws the dialog away and keeps what came before it', () => {
    // The reason this function exists. `frameTail` answers "what is it SAYING", so it cuts at the
    // last rule; on a blocked session that cut lands above the box, and the result reads perfectly
    // plausibly under a heading saying "this is what you are confirming".
    const said = frameTail(DIALOG, 4).join('\n')
    expect(said).not.toContain('Do you want to proceed?')
    expect(approvalTail(DIALOG, 6).join('\n')).toContain('Do you want to proceed?')
  })

  it('takes the BOTTOM, because that is where the answer is', () => {
    expect(approvalTail(DIALOG, 1)).toEqual(['╰──────────────────────────────────────────╯'])
  })

  it('drops padding at either end without touching the blanks inside a dialog', () => {
    expect(approvalTail(['', '  ', 'a', '', 'b', '  ', ''], 10)).toEqual(['a', '', 'b'])
  })

  it('survives an empty or all-blank frame rather than inventing a line', () => {
    expect(approvalTail([], 6)).toEqual([])
    expect(approvalTail(['', '  '], 6)).toEqual([])
    expect(approvalTail(DIALOG, 0)).toEqual([])
  })
})

describe('a footer is the BOTTOM of the screen, not any line on it', () => {
  const rules: AttentionRules = {
    probed: 'test',
    approval: [/Esc to cancel · Tab to amend/],
    working: [/esc to interrupt/],
  }
  const read = (frame: string[]) => attentionOf({
    alive: true,
    // Quiet and unmoving, so the frame is the only thing that can decide.
    lastActivityMs: NOW - 30_000,
    nowMs: NOW,
    frame,
    frameDigest: 'same',
    prevDigest: 'same',
    rules,
  })

  /**
   * VERBATIM in shape from the session that was misreported on 2026-08-14: it had spent the morning
   * WRITING the approval rules, so the footer string was on its screen as source code while it was
   * plainly working — spinner running, `esc to interrupt` in the real footer.
   */
  const QUOTING_THE_FOOTER = [
    '● Editing attention-rules.ts',
    '   approval: [',
    '     /Esc to cancel · Tab to amend/,',
    '   ],',
    '✻ Leavening… (18m 20s · ↓ 23.0k tokens)',
    '❯ ',
    '⏵⏵ auto mode on (shift+tab to cycle) · PR #108 · esc to interrupt · ← 6 agents',
  ]

  it('does not call a session blocked because it QUOTED a dialog footer', () => {
    // The bug this fixes, and in this repository it is guaranteed rather than unlikely: agentop is
    // developed with agentop. The user was offered a destructive key over a question nobody asked.
    expect(read(QUOTING_THE_FOOTER)).toBe('working')
  })

  it('still sees the footer when it is where a footer actually is', () => {
    expect(read([
      '● I will write the file',
      ' Do you want to create x.txt?',
      ' ❯ 1. Yes',
      '   2. No',
      ' Esc to cancel · Tab to amend',
    ])).toBe('waiting-approval')
  })

  it('does not read a footer that has scrolled up out of the footer region', () => {
    // Six lines of conversation below it: whatever that string is, it is not this screen's footer.
    expect(read([
      ' Esc to cancel · Tab to amend',
      '● one', '● two', '● three', '● four', '● five', '● six',
    ])).not.toBe('waiting-approval')
  })

  it('vetoes on the FOOTER only, so background agents cannot hide a real prompt', () => {
    // claude prints `esc to interrupt` whenever anything is interruptible, background subagents
    // included. A whole-frame veto would therefore suppress a genuine permission prompt on a busy
    // session — suppressing a real block is worse than the false positive being fixed.
    expect(read([
      '  ⏵⏵ auto mode on · esc to interrupt · ← 6 agents',
      '● main',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. No',
      ' Esc to cancel · Tab to amend',
    ])).toBe('waiting-approval')
  })
})

describe('background work', () => {
  const rules = { approval: [], working: [/esc to interrupt/], mainWorking: [/\(\d+[hms][^)]*·\s*↓/], probed: 'test' }

  it('a session that ANSWERED and has subagents running needs a person', () => {
    // Measured on a live claude: `esc to interrupt` is printed whenever anything is interruptible,
    // background subagents included. Reading that as `working` told a person nothing was needed
    // from them when something was.
    const frame = ['❯ ', '  ⏵⏵ auto mode on · esc to interrupt · ← 6 agents']
    // Quiet for longer than `QUIET_MS`: a session that JUST moved reads as working whatever the
    // markers say, which is a separate and correct rule.
    expect(attentionOf({
      alive: true, lastActivityMs: 0, nowMs: QUIET_MS + 1000, frame,
      frameDigest: 'd', prevDigest: 'd', rules,
    })).toBe('waiting')
    expect(backgroundWork({ frame, rules })).toBe(true)
  })

  it('the main agent producing is WORKING, and is not background', () => {
    const frame = ['· Jitterbugging… (37s · ↓ 1.7k tokens)', '  ⏵⏵ esc to interrupt']
    expect(attentionOf({
      alive: true, lastActivityMs: 0, nowMs: 1000, frame,
      frameDigest: 'd', prevDigest: 'd', rules,
    })).toBe('working')
    expect(backgroundWork({ frame, rules })).toBe(false)
  })

  it('a harness with no main marker is not given a guess', () => {
    // Without a way to tell the main turn apart, every interruptible frame would be reported as
    // background work — a confident claim made out of an absence.
    const bare = { approval: [], working: [/esc to interrupt/], probed: 'test' }
    const frame = ['❯ ', 'esc to interrupt']
    expect(backgroundWork({ frame, rules: bare })).toBe(false)
    expect(attentionOf({
      alive: true, lastActivityMs: 0, nowMs: 1000, frame,
      frameDigest: 'd', prevDigest: 'd', rules: bare,
    })).toBe('working')
  })
})

describe('approvalTail carries the QUESTION, not just the answers', () => {
  /** An `AskUserQuestion` as claude 2.1.261 draws it — the shape from the report's screenshot. */
  const ASK = [
    'Some earlier assistant text that is NOT part of the dialog.',
    'More conversation, further up.',
    '',
    'Devo abrir a issue retroativamente para o PR #368?',
    '',
    '  1. Não abrir (recomendado)',
    '     O que importa está no corpo do PR, que é onde a revisão as pega.',
    '  2. Abrir retroativamente',
    '     Registro formal em Ideas apontando o PR #368, para o histórico do processo',
    '     ficar completo.',
    '❯ 3. Escrever a minha',
    '  4. Chat about this',
    '',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ]

  it('THE REPORTED CASE: the question survives a tall dialog', () => {
    // With a flat ten-line window the card began mid-sentence, inside option 1's second line, and
    // showed a list of answers with nothing saying what was being asked.
    const out = approvalTail(ASK, 10)
    expect(out.join('\n')).toContain('Devo abrir a issue retroativamente')
    expect(out.join('\n')).toContain('Enter to select')
  })

  it('does NOT reach into the conversation above the dialog', () => {
    // The failure `approvalTail`'s own header calls the worst possible way to be wrong: prose from
    // before the dialog, printed under "you are about to confirm this".
    const out = approvalTail(ASK, 10).join('\n')
    expect(out).not.toContain('NOT part of the dialog')
    expect(out).not.toContain('further up')
  })

  it('a SHORT permission prompt is unchanged — the window only ever grows', () => {
    const prompt = [
      'irrelevant scrollback',
      'Do you want to proceed?',
      '❯ 1. Yes',
      '  2. Yes, and don\'t ask again',
      '  3. No',
      'Esc to cancel',
    ]
    expect(approvalTail(prompt, 10).join('\n')).toContain('Do you want to proceed?')
  })

  it('a frame with no readable options falls back to the flat window', () => {
    // Reaching further up on a shape this cannot read is exactly what must not happen.
    const noOptions = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    expect(approvalTail(noOptions, 10)).toHaveLength(10)
    expect(dialogHeight(noOptions, 10)).toBe(10)
  })

  it('the room above option 1 is bounded', () => {
    const tall = [
      ...Array.from({ length: 60 }, (_, i) => `scrollback ${i}`),
      '  1. one',
      '  2. two',
    ]
    // Never the whole frame: a question is a sentence or two, not a screen.
    expect(approvalTail(tall, 10).length).toBeLessThanOrEqual(22)
  })
})
