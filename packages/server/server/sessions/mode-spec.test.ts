import { describe, expect, it } from 'bun:test'
import { MODE_SPECS, modeOf, modeSpecFor } from './mode-spec'

const claude = modeSpecFor('claude')

/** The four footers, captured from a live session by sending `BTab` four times. */
const FOOTERS = {
  manual: '  ⏸ manual mode on · ? for shortcuts · ← 6 agents                          /rc',
  accept: '  ⏵⏵ accept edits on (shift+tab to cycle) · ← 6 agents                      /rc',
  plan: '  ⏸ plan mode on (shift+tab to cycle) · ← 6 agents                          /rc',
  auto: '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 6 agents                         /rc',
}

const frameWith = (footer: string) => ['some conversation', '', '─'.repeat(80), '❯ ', footer]

describe('modeOf', () => {
  it('names each of the four measured modes', () => {
    expect(modeOf(frameWith(FOOTERS.manual), claude)?.id).toBe('manual')
    expect(modeOf(frameWith(FOOTERS.accept), claude)?.id).toBe('accept-edits')
    expect(modeOf(frameWith(FOOTERS.plan), claude)?.id).toBe('plan')
    expect(modeOf(frameWith(FOOTERS.auto), claude)?.id).toBe('auto')
  })

  it('MANUAL is matched on its own name, not on the cycle hint', () => {
    // It is the one footer that does NOT advertise "(shift+tab to cycle)" — it says
    // "? for shortcuts". Matching on the hint would find three of four and call the fourth unknown.
    expect(FOOTERS.manual).not.toContain('shift+tab')
    expect(modeOf(frameWith(FOOTERS.manual), claude)?.label).toBe('manual mode')
  })

  it('reads the FOOTER only — a transcript that QUOTES a mode is not that mode', () => {
    // This product is developed with this product: a session editing `mode-spec.ts` has these exact
    // strings on screen all day. The same rule `attention-rules.ts` records for its own markers.
    const quoting = [
      'the cycle is: manual mode on, accept edits on, plan mode on, auto mode on',
      '', '─'.repeat(80), '❯ ',
      '  ⏵⏵ auto mode on (shift+tab to cycle)',
    ]
    expect(modeOf(quoting, claude)?.id).toBe('auto')
    const onlyQuoted = [
      'plan mode on is what I would use here',
      '', '', '', '', '', '', '', '',
      '❯ ', '  ? for shortcuts',
    ]
    expect(modeOf(onlyQuoted, claude)).toBeNull()
  })

  it('a frame with no footer yet is NULL, never a guess', () => {
    // A chip naming the wrong mode is worse than no chip: it is read at a glance and believed.
    expect(modeOf(['starting up…'], claude)).toBeNull()
    expect(modeOf([], claude)).toBeNull()
  })

  it('an unprobed harness has no spec and therefore no mode', () => {
    for (const h of ['codex', 'gemini', 'copilot', 'kimi', 'antigravity'] as const) {
      expect(MODE_SPECS[h]).toBeNull()
      expect(modeOf(frameWith(FOOTERS.auto), modeSpecFor(h))).toBeNull()
    }
    expect(modeOf(frameWith(FOOTERS.auto), undefined)).toBeNull()
  })

  it('the cycle key is the one that was driven', () => {
    expect(claude?.cycleKey).toBe('BTab')
    expect(claude?.probed).toContain('2.1.263')
  })
})
