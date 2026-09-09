/**
 * sendWizard.ts — PURE: the two-step "send a prompt to several sessions" wizard.
 *
 * `SessionPickModal` used to be one screen for BOTH `SessionPickModal` kinds — tick some sessions,
 * then (for `send`) write a prompt underneath the very same list. Once the prompt needed a composer
 * of its own (paste-to-attach, an attach button, a preview strip) that one screen ran out of room —
 * a 390px modal cannot hold a session list AND a composer AND stay usable. So `send` is now two
 * steps: pick WHO, then write WHAT. `reopen` stays exactly one step — it has no prompt, so a second
 * step would be a step with nothing on it.
 *
 * Every decision the wizard needs at more than one place in the DOM lives here, tested apart from
 * any DOM — the last three bugs in this area were rules that existed twice and drifted (see
 * `sessionPick.ts`'s own header).
 */

import { pickConfirmLabel } from './sessionPick'
import { composeReply } from './replyQuote'

export type WizardStep = 'pick' | 'compose'

/** The screens THIS kind has, in order. `reopen` never grows a second one. */
export function wizardSteps(kind: 'reopen' | 'send'): readonly WizardStep[] {
  return kind === 'send' ? ['pick', 'compose'] : ['pick']
}

/**
 * May the wizard move from picking sessions to writing the prompt?
 *
 * Nothing ticked means there is nothing to write TO — the same reasoning `pickConfirmLabel` already
 * applies to the final button, asked one step earlier so a person cannot land on an empty compose
 * screen with no way to know why the list behind it is empty.
 */
export function canAdvanceToCompose(pickedCount: number): boolean {
  return pickedCount > 0
}

/**
 * What the primary button says on THIS step, and whether pressing it does anything.
 *
 * `reopen` (one step) and `send`'s COMPOSE step share one wording, because pressing either
 * PERFORMS the verb — both go through `pickConfirmLabel`'s exact arithmetic ("Reopen N sessions" /
 * "Send to N sessions"), so the count is never computed twice.
 *
 * `send`'s PICK step is the one new case, and it may not borrow that wording: pressing it does not
 * send anything yet, only turns the page, so "Send to 3 sessions" pressed here would claim a
 * delivery that has not happened. "Nothing may claim what it does not know" applies here exactly as
 * it does to `pickConfirmLabel`'s own "None picked" — an empty pick reads that word, not "Next".
 */
export function wizardPrimaryLabel(
  step: WizardStep, kind: 'reopen' | 'send', pickedCount: number, pt: boolean,
): { label: string; enabled: boolean } {
  if (kind === 'reopen' || step === 'compose') return pickConfirmLabel(pickedCount, kind, pt)
  if (!canAdvanceToCompose(pickedCount)) {
    return { enabled: false, label: pt ? 'Nenhuma escolhida' : 'None picked' }
  }
  const one = pickedCount === 1
  return {
    enabled: true,
    label: pt
      ? (one ? 'Avançar · 1 sessão' : `Avançar · ${pickedCount} sessões`)
      : (one ? 'Next · 1 session' : `Next · ${pickedCount} sessions`),
  }
}

/**
 * The message that actually goes out: the uploaded attachments' paths, then what was typed.
 *
 * A broadcast answers nobody's turn, so there is no quote — this is `composeReply` with that block
 * left empty, kept under its own name so the wizard's one real decision (what travels, and in what
 * order) is findable beside the rest of it rather than a bare call into a module about a different
 * feature (replying to one message inside one conversation).
 */
export function composeBroadcastText(paths: readonly string[], text: string): string {
  return composeReply({ quote: '', paths, text })
}
