import { describe, expect, it } from 'bun:test'
import { commandToken } from './commandToken'
import { draftSegments, needsMirror } from './commandMirror'

const known = new Set(['serena', 'update-docs'])

describe('draftSegments', () => {
  it('paints only the command run when the token is found', () => {
    const token = commandToken('/serena find the symbol', known)
    expect(draftSegments('/serena find the symbol', token)).toEqual([
      { text: '/serena', kind: 'command' },
      { text: ' find the symbol', kind: 'plain' },
    ])
  })

  it('paints nothing extra when the command fills the whole draft', () => {
    const token = commandToken('/serena', known)
    expect(draftSegments('/serena', token)).toEqual([{ text: '/serena', kind: 'command' }])
  })

  it('leaves a missing command as one plain run', () => {
    const token = commandToken('/serana', known)
    expect(draftSegments('/serana', token)).toEqual([{ text: '/serana', kind: 'plain' }])
  })

  it('leaves an unknown command as one plain run', () => {
    const token = commandToken('/serena', null)
    expect(draftSegments('/serena', token)).toEqual([{ text: '/serena', kind: 'plain' }])
  })

  it('leaves plain prose as one plain run', () => {
    expect(draftSegments('hello there', null)).toEqual([{ text: 'hello there', kind: 'plain' }])
  })
})

describe('needsMirror', () => {
  it('is true only for a found token', () => {
    expect(needsMirror(commandToken('/serena', known))).toBe(true)
    expect(needsMirror(commandToken('/serana', known))).toBe(false)
    expect(needsMirror(commandToken('/serena', null))).toBe(false)
    expect(needsMirror(null)).toBe(false)
  })
})

describe('mentions are marked too, and differently', () => {
  it('marks a mention as a reference, not as the command button', () => {
  // Two different things: a command is an action the message performs, a mention points at
  // something on this machine. They must not read as the same mark.
  const out = draftSegments('olha @serena:find_symbol', null, [{ start: 5, end: 24 }])
  expect(out).toEqual([
    { text: 'olha ', kind: 'plain' },
    { text: '@serena:find_symbol', kind: 'mention' },
  ])
  })

  it('paints a command and its mentions in the same draft, in order', () => {
  const draft = '/review @serena e @agentistics'
  const out = draftSegments(
    draft,
    { text: '/review', start: 0, end: 7, state: 'found' },
    [{ start: 8, end: 15 }, { start: 18, end: 30 }],
  )
  expect(out.map(s => s.kind)).toEqual(['command', 'plain', 'mention', 'plain', 'mention'])
  expect(out.map(s => s.text).join('')).toBe(draft)
  })

  it('the mirror is drawn for a mention alone, with no command at all', () => {
  expect(needsMirror(null, [{ start: 0, end: 8 }])).toBe(true)
  expect(needsMirror(null, [])).toBe(false)
  })

  it('every segmentation reproduces the draft exactly', () => {
  // The mirror sits behind the field: a run lost or duplicated here misaligns every character
  // after it.
  const draft = 'a @serena b /x c'
  for (const mentions of [[], [{ start: 2, end: 9 }]]) {
    expect(draftSegments(draft, null, mentions).map(s => s.text).join('')).toBe(draft)
  }
  })
})
