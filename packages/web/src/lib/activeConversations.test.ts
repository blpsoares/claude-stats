import { describe, expect, it } from 'bun:test'
import { keepRunning, runningConversationIds } from './activeConversations'

const row = (o: Partial<{ state: string; conversationId: string }>) =>
  ({ state: 'working', ...o }) as never

describe('runningConversationIds', () => {
  it('collects only the conversations that are running now', () => {
    const ids = runningConversationIds([
      row({ state: 'working', conversationId: 'a' }),
      row({ state: 'waiting', conversationId: 'b' }),
      row({ state: 'exited', conversationId: 'c' }),
    ])
    expect([...ids].sort()).toEqual(['a', 'b'])
  })

  it('ignores a running row with no conversation link — it names nothing to intersect', () => {
    expect(runningConversationIds([row({ state: 'working' })]).size).toBe(0)
  })
})

describe('keepRunning', () => {
  it('keeps only the stored sessions whose conversation is live', () => {
    const s = [{ session_id: 'a' }, { session_id: 'z' }] as never[]
    expect(keepRunning(s, new Set(['a'])).map(x => (x as unknown as { session_id: string }).session_id))
      .toEqual(['a'])
  })

  it('keeps nothing when nothing is running, rather than everything', () => {
    const s = [{ session_id: 'a' }] as never[]
    expect(keepRunning(s, new Set())).toEqual([])
  })
})
