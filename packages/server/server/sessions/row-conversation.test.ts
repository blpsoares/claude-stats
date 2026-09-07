import { describe, expect, it } from 'bun:test'
import { CLOSED_ROW_PREFIX, closedRowId, conversationOfRow } from './row-conversation'

describe('conversationOfRow — where a row names its conversation', () => {
  it('reads a managed row’s recorded link', () => {
    expect(conversationOfRow({ id: '95df320c63', conversationId: 'e94094a8' })).toBe('e94094a8')
  })

  it('reads a CLOSED row’s conversation out of its id', () => {
    // The bug: this returned nothing, so the one row that exists to reopen a conversation answered
    // "this session has no linked conversation yet" over a transcript that was right there.
    expect(conversationOfRow({ id: closedRowId('e94094a8') })).toBe('e94094a8')
  })

  it('prefers the recorded link when a row somehow carries both', () => {
    expect(conversationOfRow({ id: closedRowId('old'), conversationId: 'recorded' })).toBe('recorded')
  })

  it('answers null for a harness that cannot report one — never a guess', () => {
    expect(conversationOfRow({ id: '95df320c63' })).toBe(null)
    expect(conversationOfRow({ id: CLOSED_ROW_PREFIX })).toBe(null)
  })

  it('mints the id the reader parses', () => {
    const id = closedRowId('c-1')
    expect(id).toBe('closed:c-1')
    expect(conversationOfRow({ id })).toBe('c-1')
  })
})
