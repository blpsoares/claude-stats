import { describe, expect, it } from 'bun:test'
import { hasSomethingToSend, stopShown } from './composerAction'

const base = { working: true, stopEnabled: true, draft: '', attachments: 0 }

describe('the shared slot', () => {
  it('shows STOP on a working session with nothing written', () => {
    expect(stopShown(base)).toBe(true)
  })

  it('THE REGRESSION: shows SEND the moment a character is typed', () => {
    // Reported with a screenshot: ten characters in the composer beside a red stop square. The
    // rule was correct in one place and re-derived without the draft in the place that drew.
    expect(stopShown({ ...base, draft: 'quando eu ' })).toBe(false)
  })

  it('goes back to STOP when the draft is emptied again', () => {
    expect(stopShown({ ...base, draft: 'a' })).toBe(false)
    expect(stopShown({ ...base, draft: '' })).toBe(true)
  })

  it('treats whitespace as nothing written', () => {
    // A stray space is not a message, and a send button that would post it is a trap.
    expect(stopShown({ ...base, draft: '   \n ' })).toBe(true)
  })

  it('counts attachments as something to send, with no text at all', () => {
    // A message that is only files is still a message.
    expect(stopShown({ ...base, attachments: 1 })).toBe(false)
  })

  it('never shows STOP on a session that is not working', () => {
    expect(stopShown({ ...base, working: false })).toBe(false)
    expect(stopShown({ ...base, working: false, draft: 'x' })).toBe(false)
  })

  it('never shows STOP where the row does not offer one', () => {
    // A stop on a row that cannot take it sends Escape into the session's prompt.
    expect(stopShown({ ...base, stopEnabled: false })).toBe(false)
  })
})

describe('hasSomethingToSend', () => {
  it('is the same predicate the send button disables itself on', () => {
    expect(hasSomethingToSend({ draft: '', attachments: 0 })).toBe(false)
    expect(hasSomethingToSend({ draft: ' ', attachments: 0 })).toBe(false)
    expect(hasSomethingToSend({ draft: 'x', attachments: 0 })).toBe(true)
    expect(hasSomethingToSend({ draft: '', attachments: 2 })).toBe(true)
  })
})
