/**
 * session-verbs.ts — what a row may TAKE, and nothing else.
 *
 * Its own module rather than a section of `session-fleet.ts` because it is the exact surface
 * `fleet-row.ts` consumes to answer `/api/fleet`, and it is the one module that must never acquire
 * a width. `sessionActions` is already the single answer BOTH the cockpit's keypress and the web
 * dashboard resolve against; a browser-side re-derivation is the defect `fleet-row.ts`'s header
 * names — offering `approve` on a numbered dialog whose confirm key takes whichever row happens to
 * be highlighted, which on "only my fix / promote everything / stop here" is choosing for somebody.
 *
 * Both its imports are type-only and erase under `verbatimModuleSyntax`, so the 1500-line `i18n`
 * string table never enters a consumer's value graph.
 */

import type { ControlStrings } from './i18n'
import type { ControlSession } from './types'


/** What a verb DOES, independent of what it is called in either language. */
export type SessionAction =
  | 'attach' | 'resume' | 'approve' | 'prompt' | 'rename' | 'note' | 'task' | 'kill'
  | 'openTask' | 'reopenFell' | 'finishTask'
  | 'new' | 'search' | 'group'

/**
 * The verbs offered for the selected row — PURE, and the single answer both the drawn row and a
 * click on it resolve against.
 *
 * Composed rather than fixed, on the same rule the services cockpit follows: a verb that cannot work
 * on this row is ABSENT, never present and refusing. A closed conversation has nothing to attach to;
 * one running outside agentop has nothing to rename; a row whose harness cannot reopen by id gets no
 * reopen at all.
 */
export interface OfferedAction {
  action: SessionAction
  /** False when this row cannot take it. Drawn DIM and skipped by the cursor — never selectable. */
  enabled: boolean
}

/**
 * The verbs, ALWAYS all of them, each marked with whether this row can take it.
 *
 * The rule everywhere else in this control center is that a verb which cannot work is absent. Here
 * that was wrong, and it took watching someone use it to see why: with a fleet of sessions agentop
 * did not start, the row shrank from nine verbs to four, and the honest reading of a menu that lost
 * five items is that the feature broke. Absence communicates nothing about WHY.
 *
 * So the shape stays constant and the unavailable verbs are dimmed. Nothing failing is ever offered
 * — the cursor skips them and a click does nothing — but the screen no longer implies that renaming
 * a session stopped existing because the one you selected cannot be renamed.
 */
export function sessionActions(
  selected: ControlSession | undefined,
  /** Facts about the FLEET rather than the row — what the fleet-level verbs need. */
  fleet: { fell?: number } = {},
): OfferedAction[] {
  // A row agentop still HOSTS: it has a registry entry, so it can be renamed, filed and stopped.
  // `exited` and `lost` are hosted — a reboot loses every backend session while the registry keeps
  // every name, and losing the verbs that edit those names is how a rename disappears.
  const hosted = selected !== undefined
    && selected.state !== 'unknown'
    && selected.state !== 'closed'
  // ATTACHING is narrower: there has to be something running to attach TO. A hosted row whose
  // backend is gone offers REOPEN instead, which is the verb that actually works on it — offering
  // `attach` there was a button whose only outcome was an error.
  const live = hosted
    && (selected.state === 'working' || selected.state === 'waiting'
      || selected.state === 'waiting-approval')
  const canReopen = Boolean(selected?.resume)
  const hasTask = Boolean(selected?.task)

  return [
    // The row-specific verb comes first, and which one it is depends on what the row IS: something
    // running is attached to, everything else is reopened. They are never both live.
    ...(live
      ? [{ action: 'attach' as const, enabled: true }]
      : [{ action: 'resume' as const, enabled: canReopen }]),
    // APPROVE leads the rest because a session blocked on a question is the reason this screen
    // exists. The host decides `canApprove`, and it is true only when the session is genuinely
    // asking AND somebody has read this harness's dialog — a keystroke sent into a session that is
    // not asking is a blank turn, or an option taken out of a menu nobody was looking at.
    // Enabled wherever there is something to ANSWER: a plain confirmation, a pickable option list,
    // or an option list this harness cannot pick from — that last one opens a refusal that names why
    // and points at attaching, which is information rather than an inert key.
    {
      action: 'approve',
      enabled: Boolean(selected?.canApprove)
        || Boolean(selected?.canChoose)
        || (selected?.dialogOptions?.length ?? 0) > 1,
    },
    // Typing into a session needs it to be RUNNING and nothing more: a session that is working will
    // read what it was handed when it gets there. The one case that must not go through is a
    // session sitting on a dialog, where the prompt is a menu — and that is refused by the HOST,
    // which re-reads the screen, rather than here from a list up to a poll old.
    { action: 'prompt', enabled: live },
    { action: 'rename', enabled: hosted },
    { action: 'note', enabled: hosted },
    { action: 'task', enabled: hosted },
    { action: 'openTask', enabled: hosted && hasTask },
    // A FLEET verb sitting among the row verbs, because that is where the hand already is when a
    // reboot has just emptied the screen. Enabled only when something actually fell — offered and
    // doing nothing is the shape this menu already refuses everywhere else.
    { action: 'reopenFell', enabled: (fleet.fell ?? 0) > 0 },
    // Finishing needs only a TASK, not a live session: the ordinary moment to close a piece of work
    // is when its last session has already ended, and requiring a hosted row would make the verb
    // unreachable at exactly that moment.
    { action: 'finishTask', enabled: hasTask },
    { action: 'kill', enabled: hosted },
    // These three need no selection at all and are therefore never dim.
    { action: 'new', enabled: true },
    { action: 'search', enabled: true },
    { action: 'group', enabled: true },
  ]
}

/**
 * The already-localized word for every verb, in ONE place.
 *
 * It lived inside `tabs/Sessions.tsx` while the cockpit was the only thing offering these verbs.
 * The web Sessions page offers the same set, resolved by the same `sessionActions`, and a second
 * copy of the wording is a second place for "Answer its question" to drift back into "Approve" —
 * which is exactly the promise the keystroke cannot keep. It lives here, beside the decision it
 * names, so both surfaces read one map.
 */
export const actionWords = (s: ControlStrings): Record<SessionAction, string> => ({
  attach: s.actSessions.attach,
  resume: s.actSessions.resume,
  approve: s.actSessions.approve,
  prompt: s.actSessions.prompt,
  rename: s.actSessions.rename,
  note: s.actSessions.note,
  task: s.actSessions.task,
  kill: s.actSessions.kill,
  openTask: s.actSessions.openTask,
  reopenFell: s.actSessions.reopenFell,
  finishTask: s.actSessions.finishTask,
  new: s.actSessions.newSession,
  search: s.actSessions.search,
  group: s.actSessions.group,
})

/** The already-localized labels for those verbs, in the order they are offered. */
export function actionLabels(
  actions: readonly OfferedAction[],
  words: Record<SessionAction, string>,
): string[] {
  return actions.map(a => words[a.action])
}

/** Index of the nth ENABLED verb, so the cursor never lands on one that cannot run. */
export function enabledActionIndexes(actions: readonly OfferedAction[]): number[] {
  const out: number[] = []
  actions.forEach((a, i) => { if (a.enabled) out.push(i) })
  return out
}
