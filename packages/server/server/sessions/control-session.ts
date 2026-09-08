/**
 * control-session.ts — PURE. One server-side `SessionView`, mapped to the `ControlSession` every
 * surface that DRAWS the fleet consumes.
 *
 * It lived inside `cli-start.ts` while the control center was the only thing drawing a session row.
 * `agentop session ls` draws the same table into a plain terminal, and the alternative was a second
 * mapping — which is how the same session ends up wearing one state word in the cockpit and another
 * on the command line, and how a row named by the user keeps its name in one place and loses it in
 * the other. The repo has already paid for that once (`task-reopen.ts`), so the decision is extracted
 * and both sides execute it.
 *
 * Pure and stringless in the sense that matters: every word it emits arrives as an already-localized
 * `CliStrings`, so this module owns no copy of any sentence.
 */

import { contextFraction, fmt, fmtCost } from '@agentistics/core'
import type { ControlSession, SessionState } from '@agentistics/tui/control'
import type { CliStrings } from '../cli-i18n'
import { approvalFor, isFreeTextOption } from './approval-spec'
import { needsChoice } from './dialog-choice'
import { pickTitle } from './harness-session-file'
import type { ResolvedRepoFacts } from './repo-facts'
import type { SessionView } from './session-view'
import { conversationLinkable } from './spawn-spec'

/** The state word each session wears, and the machine-readable state beside it. */
export function sessionState(v: SessionView): SessionState {
  if (v.status === 'closed') return 'closed'
  if (v.status === 'external') return 'unknown'
  if (v.status === 'lost') return 'lost'
  switch (v.activity) {
    case 'waiting-approval': return 'waiting-approval'
    case 'waiting': return 'waiting'
    case 'working': return 'working'
    case 'exited': return 'exited'
    // A row with no activity that is not external is one the poller could not read this time round.
    // `lost` is the honest word for it: something is known to exist and nothing can be said about it.
    default: return 'lost'
  }
}

export function stateLabel(state: SessionState, s: CliStrings): string {
  switch (state) {
    case 'working': return s.sessState.working
    case 'waiting-approval': return s.sessState.waitingApproval
    case 'waiting': return s.sessState.waiting
    case 'exited': return s.sessState.exited
    case 'lost': return s.sessState.lost
    case 'unknown': return s.sessState.external
    case 'closed': return s.sessState.closed
  }
}

/** The last path segment — the "by project" grouping key, decided here so the TUI never parses a
 *  path of its own. Backslashes normalised first, because a WSL machine sees both separators. */
export function projectName(cwd: string): string {
  const parts = cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] ?? cwd
}

/** One server-side view, mapped to what the control center renders — every word already localized. */
export function toControlSession(
  v: SessionView,
  s: CliStrings,
  /** What repository this session's directory belongs to, already resolved and memoized. */
  facts: ResolvedRepoFacts = { worktree: false, missing: false, source: 'none' },
): ControlSession {
  const state = sessionState(v)
  const project = projectName(v.cwd)
  const harness = v.harness ?? ''
  // `null` whenever either half is missing or unusable, which is the only thing that decides
  // whether the row draws a gauge at all. Rounded to a whole percent here rather than in the
  // renderer: the width of the cell depends on the text, so the text has to exist before layout.
  const fraction = contextFraction(v.contextTokens, v.contextWindow)
  // A session can be named in TWO places — here, and inside the harness with its own `/rename` — and
  // the precedence between them is the pure `pickTitle`. It is not a one-liner and it is not
  // obvious: a name the harness INVENTED for itself must never win, and neither name may be thrown
  // away when the two disagree.
  const picked = pickTitle({
    ...(v.label ? { label: v.label } : {}),
    ...(v.labelSince !== undefined ? { labelSince: v.labelSince } : {}),
    ...(v.harnessName
      ? {
          file: {
            name: v.harnessName,
            ...(v.harnessNameSince !== undefined ? { nameSince: v.harnessNameSince } : {}),
          },
        }
      : {}),
    // An UNREGISTERED row knows neither its harness nor its directory, so `sessUntitled` had
    // nothing to build a name from and produced the literal `?` — a row that says nothing at all
    // about why it is strange. `session-adopt.ts` already says such a row "is visible and says what
    // it is"; this is what makes that true. It is a real state with a real cause (the registry's
    // cross-process write race), and naming it is what tells someone the session is fine and only
    // its record is missing.
    fallback: v.status === 'unregistered'
      ? s.sessUnregistered(v.id.slice(0, 12))
      : s.sessUntitled(harness || '?', project),
  })
  return {
    id: v.id,
    title: picked.title,
    // Said only where the two sources DISAGREE — `other` is absent otherwise, so an ordinary row
    // carries nothing extra. Without it, someone who renamed in both places sees one name and
    // concludes the other rename silently failed, which is the complaint this answers in reverse.
    ...(picked.other ? { titleSource: picked.source, titleOther: picked.other } : {}),
    harness,
    cwd: v.cwd,
    project,
    ...(v.model ? { model: v.model } : {}),
    ...(v.effort ? { effort: v.effort } : {}),
    ...(v.mode ? { mode: v.mode } : {}),
    ...(v.note ? { note: v.note } : {}),
    state,
    // The mark rides ON the state word rather than in a cell of its own, so it reaches every
    // surface that draws a row — the cockpit, `session ls`, the workspace, the extension, the
    // relayed fleet — from the one place the word is decided. A cell of its own would have to be
    // added to each of them, and the first one missed would say `needs you` about a session that
    // still has work running, which is the reading this mark exists to correct.
    stateLabel: v.background ? `${stateLabel(state, s)} · ${s.sessBackground}` : stateLabel(state, s),
    // The machine-readable half, for a surface that wants to style it rather than read it.
    ...(v.background ? { background: true } : {}),
    actionable: v.status !== 'external' && v.status !== 'closed',
    // Stated only where it is TRUE and only for a session we actually HOST. A row that is closed or
    // running outside agentop has no screen to read at all, so "approval detection is unavailable
    // for this harness" is not merely noise there — it is false, and it said so about claude, which
    // is probed.
    ...(v.status !== 'external' && v.status !== 'closed' && !v.approvalDetection && harness
      ? { approvalBlind: s.sessApprovalBlind(harness) }
      : {}),
    ...(v.createdMs !== undefined ? { startedAt: v.createdMs } : {}),
    ...(v.endedMs !== undefined ? { endedAt: v.endedMs } : {}),
    ...(v.task ? { task: v.task } : {}),
    // Marked BY THE USER — a label, a note or a task. `title` cannot answer this: it always has a
    // value, because the host derives one whenever there is no label. A name typed INSIDE the
    // session counts too: it is the same act of naming, performed one window over, and a row named
    // there being hidden by the history switches is the same bug as one named here being hidden.
    ...(v.label || v.harnessName || v.note || v.task ? { named: true } : {}),
    ...(facts.repo ? { repo: facts.repo } : {}),
    // Only when it differs: a session in the main checkout groups under its own folder already, and
    // a field repeating what is beside it is one more thing that can disagree.
    ...(facts.root && facts.root !== project ? { projectGroup: facts.root } : {}),
    // Stamped whether or not `projectGroup` was — a session sitting IN the main checkout has no
    // group to state and still has a root, and the cascade needs the path in both cases. Absent
    // where nothing names a repository, which is what makes such a row hang at its project's root
    // rather than under a branch invented from its own cwd.
    ...(facts.rootPath ? { projectRoot: facts.rootPath } : {}),
    // Said wherever it is true, recovered repository or not: the row still names a path, and that
    // path resolves to nothing on this machine. It is also the answer to "why did reopening fail",
    // and — when no repository was recorded — it is what `groupSessions` keys the bucket on instead
    // of `project`, which is then the last segment of a path that names nothing.
    ...(facts.missing ? { dirGone: s.sessDirGone } : {}),
    ...(facts.worktree ? { worktree: true } : {}),
    // The conversation this row is KNOWN to be writing — what `--resume` takes, and the only exact
    // answer to "where does it continue from". Never filled from the harness+directory guess.
    ...(v.conversationId ? { conversationId: v.conversationId } : {}),
    // …and where no answer can ever exist, that is stated instead. Only on a row we HOST and only
    // while it has no id: an `external` or `closed` row was never ours to record, and a claude row
    // that has not been polled yet is about to have one. Same shape as `approvalBlind`.
    ...(v.status !== 'external' && v.status !== 'closed' && !v.conversationId && harness
      && !conversationLinkable(v.harness!)
      ? { conversationBlind: s.sessConversationBlind(harness) }
      : {}),
    ...(v.resume ? { resume: v.resume } : {}),
    ...(v.lastLines?.length ? { lastLines: v.lastLines } : {}),
    ...(v.chatTurns?.length ? { chatTurns: v.chatTurns } : {}),
    ...(v.approvalLines?.length ? { approvalLines: v.approvalLines } : {}),
    // Each option carries whether it is the FREE-TEXT one, decided HERE — the browser must not
    // re-derive it from a label, or the marker and the action would be two rules that can disagree
    // about which option is a field. See `isFreeTextOption`.
    ...(v.dialogOptions?.length
      ? {
          dialogOptions: v.dialogOptions.map(o => (isFreeTextOption(v.harness, o.label)
            ? { ...o, freeText: true }
            : o)),
        }
      : {}),
    // Picking one of them needs a VERIFIED way to select by number on this harness. Only claude has
    // one; everywhere else the options are shown and the answer is a refusal that names why, because
    // falling back to the confirm key would choose for the user among things that differ.
    ...(needsChoice(v.dialogOptions ?? []) && approvalFor(v.harness)?.choice
      ? { canChoose: true as const }
      : {}),
    ...(needsChoice(v.dialogOptions ?? []) && !approvalFor(v.harness)?.choice && harness
      ? { chooseBlind: s.sessChooseBlind(harness) }
      : {}),
    // The verb exists only where BOTH halves are true: the session is asking, and somebody has read
    // this harness's dialog and recorded the key that answers it. Either missing and the action is
    // absent rather than present and wrong — the same rule the wizard applies to a harness with no
    // spawn spec.
    // A bare confirm is only ever offered where there is NOTHING to choose between — the
    // codex-shaped `Press enter to continue`. On a numbered dialog it would take whichever row is
    // highlighted, which on "only my fix / promote everything / stop here" is picking for somebody.
    //
    // `!needsChoice(...)` ALONE WAS NOT THAT TEST, and the gap was reported: an empty option list
    // is also what the reader returns when it REFUSES, so a dialog it had just declined to read
    // came out here as "nothing to choose between" and drew the confirm button on a six-option
    // `AskUserQuestion`. That is the exact accident `dialog-choice.ts` exists to prevent, arriving
    // through its own refusal. The refusal is now a value and it is named here.
    ...(state === 'waiting-approval' && approvalFor(v.harness)
      && !needsChoice(v.dialogOptions ?? []) && !v.dialogUnreadable
      ? { canApprove: true as const }
      : {}),
    // A dialog agentop can SEE and cannot READ. Said in words naming what does work, exactly like
    // `chooseBlind` beside it — a verb that is simply absent reads as a broken control.
    ...(state === 'waiting-approval' && v.dialogUnreadable && harness
      ? { dialogBlind: s.sessDialogBlind(harness) }
      : {}),
    // Said only where it is TRUE, which is a narrower place than `approvalBlind`: that one explains
    // why a blocked session may be reading as plain `waiting`, this one explains why a session that
    // is VISIBLY blocked cannot be answered from here. A harness can have one and not the other.
    ...(state === 'waiting-approval' && !approvalFor(v.harness) && harness
      ? { approveBlind: s.sessApproveBlind(harness) }
      : {}),
    ...(v.fell ? { fell: true as const } : {}),
    // Already formatted, because formatting is a presentation concern the host owns for everything
    // else it hands over — and `fmt`/`fmtCost` are the shared helpers the dashboard uses.
    ...(v.tokens !== undefined ? { tokens: fmt(v.tokens) } : {}),
    ...(v.costUSD !== undefined ? { cost: fmtCost(v.costUSD) } : {}),
    ...(fraction !== null
      ? {
          context: {
            fraction,
            // ROUNDED DOWN, so a bar can never read `100%` on a window with room left in it. The
            // one number on this row people will act on is "is it nearly full", and rounding 99.6%
            // up to 100% answers that question wrongly in the direction that costs work.
            label: `${Math.floor(fraction * 100)}%`,
            used: fmt(v.contextTokens!),
            window: fmt(v.contextWindow!),
          },
        }
      : {}),
    searchFields: v.searchFields,
    attached: v.attached,
    ...(v.pid !== undefined ? { pid: v.pid } : {}),
    ...(v.cpuPercent !== undefined ? { cpuPercent: v.cpuPercent } : {}),
    ...(v.rssBytes !== undefined ? { rssBytes: v.rssBytes } : {}),
  }
}
