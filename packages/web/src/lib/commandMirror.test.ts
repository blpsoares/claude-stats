import { describe, expect, it } from 'bun:test'
import { commandToken } from './commandToken'
import { draftSegments, needsMirror } from './commandMirror'

const known = new Set(['serena', 'update-docs'])

describe('draftSegments', () => {
  it('paints only the command run when the token is found', () => {
    const token = commandToken('/serena find the symbol', known)
    expect(draftSegments('/serena find the symbol', token)).toEqual([
      { text: '/serena', button: true },
      { text: ' find the symbol', button: false },
    ])
  })

  it('paints nothing extra when the command fills the whole draft', () => {
    const token = commandToken('/serena', known)
    expect(draftSegments('/serena', token)).toEqual([{ text: '/serena', button: true }])
  })

  it('leaves a missing command as one plain run', () => {
    const token = commandToken('/serana', known)
    expect(draftSegments('/serana', token)).toEqual([{ text: '/serana', button: false }])
  })

  it('leaves an unknown command as one plain run', () => {
    const token = commandToken('/serena', null)
    expect(draftSegments('/serena', token)).toEqual([{ text: '/serena', button: false }])
  })

  it('leaves plain prose as one plain run', () => {
    expect(draftSegments('hello there', null)).toEqual([{ text: 'hello there', button: false }])
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
