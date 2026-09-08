import { describe, expect, it } from 'bun:test'
import { HARNESS_ORDER } from '@agentistics/core'
import { APPROVAL_SPECS, approvalFor, choiceKey, fieldIsOpen, isFreeTextOption
} from './approval-spec'
import { ATTENTION_RULES } from './attention-rules'

describe('APPROVAL_SPECS', () => {
  it('has decided about every harness — absence is a decision, never an omission', () => {
    // The same rule `SPAWN_SPECS` and `ATTENTION_RULES` follow. A harness added to `HarnessId` must
    // fail the build until somebody reads its dialog; `null` is how "nobody has" is said.
    for (const id of HARNESS_ORDER) expect(id in APPROVAL_SPECS).toBe(true)
    expect(Object.keys(APPROVAL_SPECS).sort()).toEqual([...HARNESS_ORDER].sort())
  })

  it('records where every key came from, with a version and a date', () => {
    // Provenance is not decoration here: the key is sent into somebody's session, and a value with
    // no probe behind it is a guess wearing the same shape as a measurement.
    for (const [id, spec] of Object.entries(APPROVAL_SPECS)) {
      if (!spec) continue
      expect(spec.key.length, id).toBeGreaterThan(0)
      // "<tool> <version>, <yyyy-mm-dd>"
      expect(spec.probed, id).toMatch(/\d.*\d, \d{4}-\d{2}-\d{2}$/)
    }
  })

  it('never offers a key for a harness whose screen cannot be read', () => {
    // A spec is only ever REACHED through `waiting-approval`, which only exists where
    // `ATTENTION_RULES` has approval patterns. A spec without them would be an unreachable promise —
    // and, worse, would be the thing a future caller reaches for when it decides to trust the spec
    // alone.
    for (const id of HARNESS_ORDER) {
      if (!APPROVAL_SPECS[id]) continue
      expect(ATTENTION_RULES[id]?.approval.length ?? 0, id).toBeGreaterThan(0)
    }
  })

  it('answers with undefined rather than null, and for an absent harness at all', () => {
    expect(approvalFor('claude')?.key).toBe('Enter')
    expect(approvalFor(undefined)).toBeUndefined()
  })
})

describe('choiceKey', () => {
  it('types the option NUMBER on a harness where that was verified', () => {
    // Driven against a live claude 2.1.232 twice on 2026-08-14: `3` at a Write permission prompt
    // produced `User rejected write` (option 3 = No), and `3` at an AskUserQuestion selected that
    // question's third answer.
    expect(choiceKey(approvalFor('claude'), 3)).toBe('3')
  })

  it('REFUSES on a harness where nobody has verified how to choose', () => {
    // There is no safe fallback to the confirm key. Confirming the highlighted row on a dialog
    // somebody is being shown four answers to is choosing for them, which is the whole defect.
    for (const id of ['codex', 'kimi', 'gemini', 'copilot', 'antigravity'] as const) {
      expect(choiceKey(approvalFor(id), 1), id).toBeNull()
    }
  })

  it('refuses a number that is not a typeable option', () => {
    const claude = approvalFor('claude')
    expect(choiceKey(claude, 0)).toBeNull()
    expect(choiceKey(claude, -1)).toBeNull()
    expect(choiceKey(claude, 1.5)).toBeNull()
    // Past nine there is no single key to type, and inventing a mechanism for a dialog nobody has
    // seen is how a guess ships.
    expect(choiceKey(claude, 10)).toBeNull()
  })

  it('refuses when there is no spec at all', () => {
    expect(choiceKey(undefined, 1)).toBeNull()
  })
})

describe('the choice capability', () => {
  it('records where it was verified, like every other probed value here', () => {
    for (const [id, spec] of Object.entries(APPROVAL_SPECS)) {
      if (!spec?.choice) continue
      expect(spec.choice.probed, id).toMatch(/\d.*\d, \d{4}-\d{2}-\d{2}/)
    }
  })
})

describe('isFreeTextOption', () => {
  it("recognises claude's own label for the write-your-own option", () => {
    // Measured on a live `AskUserQuestion` (claude 2.1.263): the row is drawn as `Type something.`
    // and stays English under a Portuguese question — it is the harness's chrome, not a
    // translation.
    expect(isFreeTextOption('claude', 'Type something.')).toBe(true)
    expect(isFreeTextOption('claude', 'type something')).toBe(true)
    expect(isFreeTextOption('claude', '  Type something.  ')).toBe(true)
  })

  it('is not fooled by an ordinary answer that mentions typing', () => {
    // A wrong `true` here opens a field over an option that submits, and the answer never lands.
    expect(isFreeTextOption('claude', 'Type something into the config')).toBe(false)
    expect(isFreeTextOption('claude', 'Chat about this')).toBe(false)
    expect(isFreeTextOption('claude', 'Azul')).toBe(false)
  })

  it('every other harness is false — nobody has driven one', () => {
    for (const h of ['codex', 'gemini', 'copilot', 'kimi', 'antigravity'] as const) {
      expect(isFreeTextOption(h, 'Type something.')).toBe(false)
    }
    expect(isFreeTextOption(undefined, 'Type something.')).toBe(false)
  })
})

describe('fieldIsOpen', () => {
  // Captured by driving claude 2.1.263 on 2026-09-08. The list is IDENTICAL in both frames — that
  // is the whole point: the old "the field replaced the options" signal cannot tell them apart.
  const SHUT = [
    '  4. Type something.',
    '────────────────────────────────────────',
    '  5. Chat about this',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ]
  const OPEN = [
    '❯ 4. Type something.',
    '────────────────────────────────────────',
    '  5. Chat about this',
    'Enter to select · ↑/↓ to navigate · ctrl+g to edit in VS Code · Esc to cancel',
  ]

  it('reads the field as open only when the footer says a text field is focused', () => {
    expect(fieldIsOpen('claude', OPEN)).toBe(true)
    expect(fieldIsOpen('claude', SHUT)).toBe(false)
  })

  it('answers null — never false — for a harness nobody probed', () => {
    expect(fieldIsOpen('codex', OPEN)).toBeNull()
    expect(fieldIsOpen(undefined, OPEN)).toBeNull()
  })

  it('matches the FOOTER, so a transcript quoting the hint is not a field', () => {
    const quoting = [
      'the hint reads ctrl+g to edit in VS Code, which is how we detect it',
      '', '', '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ]
    expect(fieldIsOpen('claude', quoting)).toBe(false)
  })
})
