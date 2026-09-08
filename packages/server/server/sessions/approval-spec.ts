/**
 * approval-spec.ts — PURE. The keystroke that ANSWERS each harness's blocking dialog.
 *
 * A sibling of `attention-rules.ts`, and deliberately a second file rather than a field on it,
 * because the two answer different questions and can be known independently: `attention-rules.ts`
 * says how to RECOGNISE that a session is blocked, this says what to SEND once it is. A harness
 * could be probed for the first and not the second — a dialog whose footer names no key at all — and
 * a single record would then force one guess to stand in for the other.
 *
 * ## What a spec claims, exactly
 *
 * `key` is the keystroke that CONFIRMS THE OPTION THE DIALOG HAS HIGHLIGHTED. It is not "approve",
 * and the difference matters enough to be the reason this feature is built the way it is: none of
 * these CLIs can be asked which option is highlighted, and a dialog whose default is "No, tell
 * Claude what to do differently" would be answered by the same byte that approves everywhere else.
 *
 * So the keystroke is only half of the design. The other half is that the caller REREADS the screen
 * immediately before sending (a poll is up to five seconds old — the dialog may already be gone) and
 * SHOWS THE FRAME to the person answering. What is being confirmed is on the screen; the only thing
 * this table supplies is the byte that presses it.
 *
 * ## Where the values come from
 *
 * Every one of them is the footer `attention-rules.ts` captured, read for what it says about keys —
 * same probe, same CLI versions, same date, nothing added from memory of what a CLI prints:
 *
 *   claude       `Enter to confirm · Esc to cancel`
 *   codex        `Press enter to continue`
 *   kimi         `↑↓ navigate · Enter select · Esc exit`
 *   gemini       `Enter to select · ↑/↓ to navigate`
 *   copilot      `↑/↓ to navigate · enter to select`
 *   antigravity  `↑/↓ Navigate · enter Confirm`
 *
 * All six name ENTER, and all six name it as the key that takes the highlighted option. That the
 * table currently holds one value six times is a finding, not a shortcut — the footers disagree
 * about wording, capitalisation and whether `esc` is even mentioned, which is exactly why each is
 * recorded on its own row rather than collapsed into one shared assumption.
 *
 * `Record<HarnessId, … | null>` and not a `Partial`: a harness added to `HarnessId` must fail the
 * build until someone decides, the same rule `SPAWN_SPECS`, `ATTENTION_RULES` and
 * `HARNESS_CAPABILITIES` follow. `null` is that decision — "nobody has read this dialog" — and the
 * verb is then ABSENT rather than offered and wrong, with the UI saying so in words.
 *
 * The values are tmux key names (`send-keys` argument syntax), because that is the only backend
 * there is. When a second backend exists this becomes its own vocabulary; until then, inventing an
 * abstraction over one implementation would be inventing a mapping nobody can check.
 */

import type { HarnessId } from '@agentistics/core'
import { FOOTER_LINES } from './attention'

export interface ApprovalSpec {
  /**
   * The key that takes the option the dialog is currently highlighting, as tmux `send-keys` names
   * it. NOT "the key that approves" — see the header.
   */
  key: string
  /**
   * How to pick option N of a numbered dialog, when that is known for this harness.
   *
   * `digit` means typing the option's own number selects it outright. ABSENT means nobody has
   * verified how to choose on this harness — and a caller must then REFUSE a multi-option dialog in
   * words rather than falling back to `key`, which would confirm whichever row happened to be
   * highlighted. That fallback is precisely the defect this field exists to close: a person pressing
   * a key called "approve" and unknowingly picking one of four different courses of action.
   *
   * Only `claude` has one, and it was verified by driving a live session twice on 2026-08-14 —
   * sending `3` at a Write permission prompt produced `User rejected write` (option 3 = No), and
   * sending `3` at an `AskUserQuestion` selected that question's third answer. Nothing here is
   * inferred from the other harnesses' footers, which say `Enter select` and nothing about digits.
   */
  choice?: { kind: 'digit'; probed: string }
  /**
   * How to reach a row on a dialog that printed NO numbers — the only way there is to move onto it.
   *
   * `choice` above answers a numbered dialog and cannot answer this one: there is no digit to type.
   * Claude's trust prompt is the case (`❯ No, exit` / `  Yes, I trust this folder`), and it is the
   * dialog where the old fallback cost the most — a bare confirm there takes `No, exit`, so from
   * the web the only reachable answer was quitting. Reported by a user who had to open the terminal
   * to say yes.
   *
   * MEASURED on claude 2.1.x under tmux on 2026-09-08, on the harness's own select component (the
   * `/model` picker, which draws the same widget): `Down` moved the `❯` from row 2 to row 3, two
   * `Up`s walked it back to row 1, and `Escape` closed the dialog. The trust prompt itself was NOT
   * driven — it does not reappear on a machine that has already trusted its folders, and neither
   * the onboarding nor the login select reaches it — which is exactly why the caller VERIFIES the
   * cursor landed on the intended label before it confirms, instead of trusting this count.
   *
   * ABSENT means nobody has driven this harness's select, and a numberless dialog is then refused
   * in words. Never fall back to `key`: that is the defect this field exists to close.
   */
  move?: { down: string; up: string; probed: string }
  /**
   * This harness's NUMBERLESS select is one contiguous line per option — so the shape reader may
   * run on its frames.
   *
   * A GATE and not a flag, because the shape is not universal and reading it wrong is expensive.
   * MEASURED 2026-09-08 by driving a live `kimi` 0.41.0 in a fresh directory: its trust prompt is
   * numberless too, and each option carries a DESCRIPTION line at the SAME indentation, with blank
   * lines between the option groups —
   *
   *      ❯ Trust this folder
   *        Enable project MCP servers. Remembered for this folder.
   *
   *        Don't trust
   *
   * — so a contiguous-rows rule reads "Trust this folder" and its own description as two options
   * and never reaches `Don't trust`. Half-read options are worse than none because they get
   * OFFERED, so kimi is left OFF and its dialogs read exactly as they did before. claude's is one
   * line per option (`❯ No, exit` / `  Yes, I trust this folder`, captured from a live session the
   * same day), which is the only shape this reader models.
   */
  markerSelect?: { probed: string }
  /**
   * How the SCREEN says a free-text field is open and taking keys.
   *
   * WHY IT CANNOT BE INFERRED FROM THE OPTION LIST. The check that shipped read the list: a field
   * that opened was assumed to REPLACE the options, so a list still parsing the same way meant the
   * digit had merely moved the highlight. Measured against claude 2.1.263 on 2026-09-08, that is
   * false — the field opens IN PLACE, the row keeps its `Type something.` label until something is
   * typed into it, and every other option stays exactly where it was. So the guard read a field
   * that HAD opened as one that had not, and refused a perfectly good answer in words that named
   * the opposite of what happened. Reported as the option's number being fired instead of letting
   * you type.
   *
   * The footer is the honest signal. `ctrl+g to edit in VS Code` is an affordance only a TEXT FIELD
   * has, and it tracks the field rather than the dialog: driving a live session, it appeared the
   * moment the digit landed on `Type something.` and disappeared the moment an arrow moved the
   * highlight off it. Matched in the footer only, like every other rule here — this product is
   * developed with this product, and a transcript quoting the hint is a certainty.
   *
   * ABSENT means nobody has probed it. A caller must then treat "did the field open" as unknowable
   * from the frame and fall back to whatever positive evidence it has, never to a guess.
   */
  fieldOpen?: { pattern: RegExp; probed: string }
  /** Provenance — the exact CLI version the dialog came from, and the date. */
  probed: string
}

export const APPROVAL_SPECS: Record<HarnessId, ApprovalSpec | null> = {
  claude: {
    key: 'Enter',
    probed: 'claude 2.1.231, 2026-08-13',
    choice: { kind: 'digit', probed: 'claude 2.1.232, 2026-08-14 (permission prompt + AskUserQuestion)' },
    move: { down: 'Down', up: 'Up', probed: 'claude 2.1.x, 2026-09-08 (/model picker, driven under tmux)' },
    markerSelect: { probed: 'claude, 2026-09-08 (trust prompt, captured from a live session)' },
    fieldOpen: {
      pattern: /ctrl\+g to edit in VS Code/i,
      probed: 'claude 2.1.263, 2026-09-08 (AskUserQuestion "Type something.")',
    },
  },
  // No `choice` below this line, and that is a statement rather than a gap: each of these footers
  // says `Enter` selects, and none of them says anything about typing a number. Nobody has driven
  // one to find out, so a numbered dialog on these harnesses is refused with the reason.
  codex: { key: 'Enter', probed: 'codex 0.113.0, 2026-08-13' },
  kimi: { key: 'Enter', probed: 'kimi 0.35.0, 2026-08-13' },
  gemini: { key: 'Enter', probed: 'gemini 0.55.1, 2026-08-13' },
  copilot: { key: 'Enter', probed: 'GitHub Copilot CLI 1.0.79, 2026-08-13' },
  antigravity: { key: 'Enter', probed: 'agy 1.1.12, 2026-08-13' },
}

/**
 * The keystroke that picks option `n`, or `null` when this harness has no verified way to choose.
 *
 * `null` is the refusal, and it must be honoured: there is no safe fallback to the confirm key,
 * because confirming the highlighted row on a dialog the user is being shown four answers to is
 * choosing for them.
 */
/**
 * The option that means "let me write my own", by the label the harness gives it.
 *
 * MEASURED by driving a live `AskUserQuestion` (claude 2.1.263, 2026-09-06): the option is drawn as
 * `Type something.` and its label is the harness's own chrome — it stayed English under a
 * Portuguese question, so it is a constant rather than a translation.
 *
 * WHY IT NEEDS ITS OWN NAME. Picking it with the digit does NOT submit: it moves the cursor onto
 * the option and turns it into a FIELD. Every further digit is then typed INTO that field —
 * reported with a screenshot where the option read `33333333333333333` after repeated clicks, and
 * the card said `answered: 3333333333333333`. Reproduced exactly: sending `3` then the literal
 * `capivara` turned the row into `3. capivara`, and `Enter` submitted it.
 *
 * Absent for every other harness, because nobody has driven one.
 */
const FREE_TEXT_LABEL: Partial<Record<HarnessId, RegExp>> = {
  claude: /^type something\.?$/i,
}

/** Is this option the free-text one — the one that must be typed into rather than confirmed? */
export function isFreeTextOption(harness: HarnessId | undefined, label: string): boolean {
  const re = harness ? FREE_TEXT_LABEL[harness] : undefined
  return re ? re.test(label.trim()) : false
}

export function choiceKey(spec: ApprovalSpec | undefined, n: number): string | null {
  if (!spec?.choice || !Number.isInteger(n) || n < 1) return null
  // Only single digits are typeable as one key. A dialog with more than nine options would need a
  // different mechanism, and inventing one for a case nobody has seen is how a guess ships.
  return spec.choice.kind === 'digit' && n <= 9 ? String(n) : null
}

/**
 * Can this harness pick a row on a dialog of THIS shape? — PURE.
 *
 * The two shapes need two different capabilities and a caller that asks only about `choice` offers
 * a picker it cannot honour on a numberless dialog — or, worse, withholds one it could. `null`
 * (the read found no menu) is not a pick at all.
 */
export function canPick(
  spec: ApprovalSpec | undefined,
  select: 'numbered' | 'marker' | null,
): boolean {
  if (select === 'numbered') return !!spec?.choice
  if (select === 'marker') return !!spec?.move
  return false
}

/** Whether the NUMBERLESS shape reader may run on this harness's frames — see `markerSelect`. */
export function readsMarkerSelect(harness: HarnessId | undefined): boolean {
  return !!approvalFor(harness)?.markerSelect
}

/** The spec for a harness, or `undefined` when its dialog was never read. */
export function approvalFor(harness: HarnessId | undefined): ApprovalSpec | undefined {
  return harness ? (APPROVAL_SPECS[harness] ?? undefined) : undefined
}

/**
 * Does this frame show a free-text field OPEN and taking keys?
 *
 * `null` when the harness has no probed signal — "unknowable from the frame", which is a different
 * answer from `false` and must not be collapsed into it: a caller that treats "nobody looked" as
 * "the field did not open" refuses every answer on every harness but the one that was measured.
 *
 * FOOTER ONLY, in the last few lines, exactly like `attention-rules.ts` and for the same reason:
 * a session editing this file has the hint on screen all day.
 */
export function fieldIsOpen(harness: HarnessId | undefined, frame: readonly string[]): boolean | null {
  const spec = approvalFor(harness)
  if (!spec?.fieldOpen) return null
  const footer = frame.slice(Math.max(0, frame.length - FOOTER_LINES)).join('\n')
  return spec.fieldOpen.pattern.test(footer)
}
