import { describe, expect, it } from 'bun:test'
import { compactsFromClaudeJsonl, skillUsesFromClaudeJsonl } from './jsonl'

/** One compact boundary, in the shape Claude Code writes it. */
const boundary = (m: Record<string, unknown>) =>
  JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: m })

/** One assistant line carrying tool_use blocks. */
const tools = (...blocks: Record<string, unknown>[]) =>
  JSON.stringify({ type: 'assistant', message: { content: blocks } })

describe('compactsFromClaudeJsonl', () => {
  it('counts the boundaries and sums the per-compact durations', () => {
    const out = compactsFromClaudeJsonl([
      boundary({ trigger: 'auto', durationMs: 104_960, cumulativeDroppedTokens: 954_238 }),
      boundary({ trigger: 'auto', durationMs: 123_621, cumulativeDroppedTokens: 1_910_306 }),
    ])
    expect(out.count).toBe(2)
    expect(out.ms).toBe(228_581)
  })

  it('takes the MAX of cumulativeDroppedTokens, never the sum', () => {
    // Measured on a real 5-compact session: the field is cumulative and monotonic, so summing
    // reported 14,4M where the truth was 4,8M.
    const out = compactsFromClaudeJsonl([
      boundary({ cumulativeDroppedTokens: 954_238 }),
      boundary({ cumulativeDroppedTokens: 1_910_306 }),
      boundary({ cumulativeDroppedTokens: 2_876_708 }),
      boundary({ cumulativeDroppedTokens: 3_829_252 }),
      boundary({ cumulativeDroppedTokens: 4_785_215 }),
    ])
    expect(out.droppedTokens).toBe(4_785_215)
  })

  it('leaves droppedTokens UNDEFINED when no record carries it', () => {
    // 27 of 46 real records have no such field. Reporting 0 would claim nothing was dropped by a
    // session that plainly compacted five times.
    const out = compactsFromClaudeJsonl([boundary({ durationMs: 900 }), boundary({ durationMs: 900 })])
    expect(out.count).toBe(2)
    expect(out.droppedTokens).toBeUndefined()
  })

  it('ignores a line that merely mentions the marker, and survives malformed JSON', () => {
    const out = compactsFromClaudeJsonl([
      JSON.stringify({ type: 'assistant', message: { content: 'we should log compact_boundary here' } }),
      '{ not json',
      JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 5 }),
    ])
    expect(out).toEqual({ count: 0, ms: 0 })
  })
})

describe('skillUsesFromClaudeJsonl', () => {
  it('counts each skill by the name the Skill tool was given', () => {
    const out = skillUsesFromClaudeJsonl([
      tools({ type: 'tool_use', name: 'Skill', input: { skill: 'superpowers:brainstorming' } }),
      tools({ type: 'tool_use', name: 'Skill', input: { skill: 'superpowers:brainstorming' } }),
      tools({ type: 'tool_use', name: 'Skill', input: { skill: 'artifact-design' } }),
    ])
    expect(out).toEqual({ 'superpowers:brainstorming': 2, 'artifact-design': 1 })
  })

  it('is empty when no skill was invoked, and ignores other tools', () => {
    expect(skillUsesFromClaudeJsonl([
      tools({ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }),
    ])).toEqual({})
  })

  it('skips a Skill call with no readable name rather than inventing one', () => {
    expect(skillUsesFromClaudeJsonl([
      tools({ type: 'tool_use', name: 'Skill', input: {} }),
    ])).toEqual({})
  })
})
