import { describe, it, expect } from 'bun:test'
import { MODEL_SWITCH, modelSwitchLine, modelSwitchReason } from './modelSwitch'

describe('MODEL_SWITCH', () => {
  it('wires ONLY claude, and states every other harness explicitly', () => {
    // A guessed slash command does not fail loudly — it types a line of nonsense into a live
    // session. Each null here is a finding, not an omission.
    expect(MODEL_SWITCH.claude).toEqual({ line: '/model {model}' })
    for (const h of ['codex', 'gemini', 'copilot', 'antigravity', 'kimi']) {
      expect(h in MODEL_SWITCH).toBe(true)
      expect(MODEL_SWITCH[h]).toBeNull()
    }
  })
})

describe('modelSwitchLine', () => {
  it('builds the verified line for claude', () => {
    expect(modelSwitchLine('claude', 'opus')).toBe('/model opus')
  })

  it('returns null for a harness with no verified switch', () => {
    for (const h of ['codex', 'gemini', 'copilot', 'antigravity', 'kimi', 'something-new']) {
      expect(modelSwitchLine(h, 'opus')).toBeNull()
    }
  })

  it('passes the model name through VERBATIM, for every alias claude accepts', () => {
    // These four are exactly the ids `--model` takes and exactly the ids `/model` answered to when
    // driven against claude 2.1.259 (see the module header). The line must carry the id and nothing
    // else — a decorated or re-cased name is `Model '…' not found` inside the session, which looks
    // to the user like a switch that worked.
    for (const model of ['fable', 'opus', 'sonnet', 'haiku']) {
      expect(modelSwitchLine('claude', model)).toBe(`/model ${model}`)
    }
  })

  it('refuses an empty model rather than typing a bare slash command', () => {
    // `/model` with no argument opens the CLI's own picker inside the session, which is not what a
    // click on a value in this list asked for.
    expect(modelSwitchLine('claude', '')).toBeNull()
  })
})

describe('modelSwitchReason', () => {
  it('says nothing where the switch works', () => {
    expect(modelSwitchReason('claude', 'en')).toBeNull()
  })

  it('explains the absence in both languages', () => {
    for (const lang of ['en', 'pt'] as const) {
      expect(modelSwitchReason('codex', lang)!.length).toBeGreaterThan(10)
    }
    expect(modelSwitchReason('codex', 'pt')).not.toBe(modelSwitchReason('codex', 'en'))
  })
})
