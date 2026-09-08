/**
 * wizardSteps.ts — PURE: what the new-session wizard asks, in what order, and when it may advance.
 *
 * Separated from the rendering so "can I continue", "what is missing" and "what did they choose"
 * are answerable without a DOM. A wizard whose gating lives in JSX is a wizard nothing can check,
 * and this one gates the most powerful act the server performs.
 *
 * TWO RULES CARRIED OVER FROM THE TERMINAL WIZARD, both load-bearing:
 *
 * - The assistants offered are the ones `availableHarnesses()` found ON PATH. Anything else starts
 *   a tmux session that dies on `command not found` behind a screen nobody is watching.
 * - `model` and `effort` are SKIPPED, not shown-and-disabled, where the harness cannot take them.
 *   `efforts` is a closed set read from each CLI's own `--help`. A model question is skipped where
 *   the harness NAMES no models, even if it accepts `--model`: a dropdown whose only entry is "the
 *   assistant's default" is a control that cannot be used, while an absent one says "we cannot name
 *   these for you".
 *
 * THE TITLE IS REQUIRED, and it is the one answer of step 1 that is. A session is found again by
 * what it is CALLED — in the fleet list, in the search field, in `agentop session ls` — and the
 * harness-derived fallback names the conversation rather than the work ("Fixing the build" against
 * whatever Claude decided to call itself). Everything else on that step has a defensible unset
 * state the CLI resolves; a session nobody can pick out of a list of forty does not.
 */

export type StepId = 'assistant' | 'where' | 'message' | 'review'

export const STEP_ORDER: StepId[] = ['assistant', 'where', 'message', 'review']

export interface WizardHarness {
  id: string
  label: string
  models: { id: string; label: string }[]
  supportsModel: boolean
  efforts: string[]
  /** What the CLI itself publishes as its default, where it publishes one. See `unsetAnswer`. */
  defaultModel?: string
  defaultEffort?: string
}

export interface WizardDraft {
  harness: string
  cwd: string
  task: string
  model: string
  effort: string
  prompt: string
  /**
   * The session's TITLE, and REQUIRED — see the header.
   *
   * The field keeps the server's own name for it: `ManagedSession.label` is what
   * `POST /api/fleet/new` takes and what every verb renames. "Title" is what a person reads; a
   * second name for one value on the wire is how the two drift.
   */
  label: string
  /** Paths already stored on the machine by `POST /api/fleet/attach`. */
  attachments: { name: string; path: string }[]
}

/** What a blocked step is waiting for. A closed set: the footer owns a sentence for each. */
export type MissingAnswer = 'assistant' | 'title' | 'cwd'

export interface StepState {
  ok: boolean
  /** What is missing, when it is not. Never absent when `ok` is false. */
  missing?: MissingAnswer
}

export function visibleQuestions(harness: WizardHarness | null): { model: boolean; effort: boolean } {
  if (!harness) return { model: false, effort: false }
  return {
    model: harness.supportsModel && harness.models.length > 0,
    effort: harness.efforts.length > 0,
  }
}

export function stepReady(step: StepId, draft: WizardDraft, harness: WizardHarness | null): StepState {
  switch (step) {
    case 'assistant':
      if (!harness || draft.harness === '') return { ok: false, missing: 'assistant' }
      // Trimmed: a title of spaces is a title nobody can search for, and it would pass a bare
      // emptiness test while reading as blank everywhere it is drawn.
      return draft.label.trim() !== '' ? { ok: true } : { ok: false, missing: 'title' }
    case 'where':
      return draft.cwd !== '' ? { ok: true } : { ok: false, missing: 'cwd' }
    // The first message is optional: a session started with none is a session waiting for you,
    // which is a perfectly ordinary thing to want.
    case 'message':
      return { ok: true }
    case 'review': {
      const a = stepReady('assistant', draft, harness)
      if (!a.ok) return a
      return stepReady('where', draft, harness)
    }
  }
}

/**
 * How a chosen model is SHOWN: the name the harness's own CLI prints, and its id only when that is
 * a different string.
 *
 * Two surfaces ask this — the picker and the review — and they must answer identically, or the
 * same choice reads as two things one step apart. `opus` and `Opus 5` are one model under two
 * names: the name is what a person recognises, the id is what the CLI reports back and what a
 * `/model` typed into the live session has to match, so both are worth showing. Where the harness
 * publishes no name, `harnessModels.ts` sets `label` to the id itself and the id is dropped rather
 * than printed twice.
 *
 * `null` for an unset model: that is the assistant's default, which is a sentence, not a value.
 */
export function modelDisplay(
  models: { id: string; label: string }[],
  id: string,
): { label: string; id: string | null } | null {
  if (id === '') return null
  // An id the list does not carry is still a legitimate choice — every one of these CLIs accepts a
  // full model name — so it is shown as itself rather than dropped.
  const label = models.find(m => m.id === id)?.label ?? id
  return { label, id: label === id ? null : id }
}

/**
 * What to say for a question left UNSET.
 *
 * "The assistant's default" names a thing without saying what it is, which leaves the reader with
 * no way to tell whether leaving the field alone was the right call. Where the CLI publishes the
 * answer, the wizard says it — "Default (sonnet)". Where it does not, the vague sentence is the
 * only honest one available, and naming a default we could not read out of the tool's own output
 * would be the confident-wrong-answer this product refuses everywhere else.
 *
 * Every harness reports `known: false` today; `spawn-spec.ts` records what was checked, per CLI,
 * and how. The blank string is treated as ABSENT rather than as a default named "": a field that
 * arrived empty is a field nobody filled in.
 */
export type UnsetAnswer = { known: true; value: string } | { known: false }

export function unsetAnswer(published: string | undefined | null): UnsetAnswer {
  const value = (published ?? '').trim()
  return value === '' ? { known: false } : { known: true, value }
}

export function nextStep(step: StepId): StepId {
  const i = STEP_ORDER.indexOf(step)
  return STEP_ORDER[Math.min(i + 1, STEP_ORDER.length - 1)]!
}

export function prevStep(step: StepId): StepId {
  const i = STEP_ORDER.indexOf(step)
  return STEP_ORDER[Math.max(i - 1, 0)]!
}

/**
 * Drop only the answers the NEW assistant cannot accept.
 *
 * Carrying `effort: 'high'` across to a harness whose set does not contain it would send a flag
 * the CLI rejects at spawn. Everything else — the directory, the task, the message, the title —
 * belongs to any assistant and going back a step must not silently discard it.
 */
export function clearForHarness(draft: WizardDraft, harness: WizardHarness | null): WizardDraft {
  const q = visibleQuestions(harness)
  const keepModel = q.model && harness!.models.some(m => m.id === draft.model)
  const keepEffort = q.effort && harness!.efforts.includes(draft.effort)
  return { ...draft, model: keepModel ? draft.model : '', effort: keepEffort ? draft.effort : '' }
}
