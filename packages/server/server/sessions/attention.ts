/**
 * attention.ts — PURE. What a session is doing, from the only two things a backend can report:
 * whether the screen moved, and what is on it.
 *
 * The order below is an order of EVIDENCE, strongest first, and each step exists because the ones
 * after it are wrong in a case it covers:
 *
 *  - A blocked dialog outranks movement. The dialog IS the frame; nothing is running behind it.
 *  - A probed `working` marker outranks the movement test, so a harness that thinks without
 *    redrawing is never mistaken for quiet.
 *  - Movement is tested two ways because each alone has a blind spot: tmux's `session_activity` has
 *    one-second resolution and moves when a spinner redraws identical bytes, while a frame digest
 *    cannot see a process that is busy and silent.
 *
 * `waiting` is the floor rather than an "unknown", and that is a deliberate claim: an interactive
 * assistant that is alive and still is waiting for its user. The uncertainty this system genuinely
 * has is about the REASON, and it lives in `attention-rules.ts` having no approval rule for a
 * harness nobody probed — which the UI states in words.
 */

import type { AttentionRules, SessionActivity } from './types'

/**
 * One poll interval (5s) plus slack.
 *
 * A backend that reported output inside this window is working even if the frame it drew happens to
 * hash the same as the last one — which is exactly what a redrawn-but-unchanged status line does.
 */
export const QUIET_MS = 6_000

/**
 * How long a `working` MARKER may outlive the last thing drawn on the screen.
 *
 * Measured on a real session: claude's footer reads `esc to interrupt` whenever there is anything
 * interruptible — including background agents — so a session whose main thread had been idle for
 * 199 seconds still carried the marker and reported `working` forever. The marker's job is to catch
 * a turn that is thinking without redrawing, which is a matter of seconds; past a minute of total
 * silence the screen is simply not doing anything, and saying otherwise makes the one column this
 * monitor exists for permanently wrong.
 */
export const MARKER_STALE_MS = 60_000

/**
 * How much of the BOTTOM of a frame counts as its footer.
 *
 * Every approval pattern in `attention-rules.ts` is a footer, and every dialog probed for this
 * feature draws its footer on the last line — the three claude components, codex, kimi, gemini,
 * copilot and agy alike. Four leaves room for a trailing blank or a strip drawn beneath it without
 * reaching far enough up to catch the conversation.
 *
 * The window is the point. Matching a footer anywhere in a sixty-line capture means any session
 * that QUOTES one is read as sitting in it, and in this repository that is guaranteed rather than
 * unlikely: agentop is developed with agentop, so a session editing `attention-rules.ts` has those
 * exact strings on screen all day. One was offered a destructive key over a question it had never
 * asked. A quotation lives in the middle of a screen; a footer lives at the end of it.
 */
export const FOOTER_LINES = 4

/**
 * FNV-1a over the frame, joined with newlines.
 *
 * Dependency-free, and deliberately not a crypto hash: the only question ever asked of this value is
 * "is this the same frame as last time". The `\n` separator is load-bearing — joining without one
 * would make a reflowed frame (`['ab']` versus `['a','b']`) hash identically, and a reflow is
 * movement.
 */
export function digestFrame(lines: readonly string[]): string {
  const s = lines.join('\n')
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

export function attentionOf(o: {
  alive: boolean
  lastActivityMs: number
  nowMs: number
  frame: readonly string[]
  frameDigest: string
  /** Absent on the first sighting of a session — treated as "no movement observed", never as
   *  movement, or every session would read as working for one interval after the poller starts. */
  prevDigest?: string
  /** Absent for a harness with no probed markers. Movement alone still decides. */
  rules?: AttentionRules
}): SessionActivity {
  if (!o.alive) return 'exited'

  const text = o.frame.join('\n')
  // A dialog's footer is a property of the BOTTOM of the screen, and matching it anywhere in the
  // frame is what let a session that merely TALKED about one be reported as blocked in it. That is
  // not a hypothetical here: this project is built with agentop, so sessions spend whole mornings
  // with strings like `Esc to cancel · Tab to amend` on screen as source code — and one of them was
  // offered a destructive key over a question it had never asked. Reported from a real machine.
  const footer = o.frame.slice(Math.max(0, o.frame.length - FOOTER_LINES)).join('\n')
  const working = (haystack: string) =>
    Boolean(o.rules?.working && o.rules.working.some(re => re.test(haystack)))
  // A frame whose FOOTER says something is interruptible is not a frame sitting on a dialog: the
  // dialog's own footer takes that row while it is open. Checked in the footer rather than over the
  // whole frame, and that narrowness is deliberate — claude prints `esc to interrupt` whenever
  // anything is interruptible INCLUDING BACKGROUND AGENTS, so a whole-frame veto would suppress a
  // genuine permission prompt on a session whose subagents happen to be running. Suppressing a real
  // block is the one error worse than the one being fixed.
  if (o.rules && !working(footer) && o.rules.approval.some(re => re.test(footer))) {
    return 'waiting-approval'
  }

  // The marker is PROOF of work only while the screen has been moving at all recently. A footer
  // that lingers is not evidence, and silence eventually outweighs it — see `MARKER_STALE_MS`.
  //
  // AND IT MUST BE THE MAIN AGENT. `esc to interrupt` is printed whenever anything is
  // interruptible, background subagents included, so a session that had already answered and was
  // waiting for a person read as `working` — telling them nothing was needed when something was.
  // Where the harness draws a distinct marker for its own turn (`mainWorking`), that is what
  // counts; the interruptible marker alone means work is happening SOMEWHERE, which
  // `backgroundWork` below reports separately. A harness with no `mainWorking` keeps the old
  // behaviour exactly.
  const silentFor = o.nowMs - o.lastActivityMs
  const mainMarker = o.rules?.mainWorking
  const producing = mainMarker
    ? mainMarker.some(re => re.test(text))
    : working(text)
  if (silentFor <= MARKER_STALE_MS && producing) {
    return 'working'
  }

  // A frame that CHANGED is direct evidence, and outranks any staleness rule: something drew it.
  if (o.prevDigest !== undefined && o.frameDigest !== o.prevDigest) return 'working'
  if (silentFor < QUIET_MS) return 'working'

  return 'waiting'
}

/**
 * The BOTTOM of the frame, verbatim — what a blocked session is asking, PURE.
 *
 * Deliberately not `frameTail`, and the difference is the whole point. `frameTail` answers "what is
 * this session SAYING", so it cuts at the last rule and throws away the input box and the status
 * strip — which for a session sitting on a dialog throws away the dialog, and leaves whatever the
 * assistant said before it opened. That text read perfectly plausibly under a heading saying "you
 * are about to confirm this", which is the worst possible way to be wrong.
 *
 * So this takes the last lines AS DRAWN, chrome included. The options, the highlighted one and the
 * footer naming the key are the answer to "what am I agreeing to", and none of them survive being
 * tidied. Blank lines at either end are dropped because they are padding rather than content;
 * everything between is kept exactly as the pane rendered it.
 *
 * It is the only thing standing between `approvalFor()`'s keystroke and a confirmation the user
 * cannot check — see `approval-spec.ts`.
 */
export function approvalTail(frame: readonly string[], max = 10): string[] {
  const from = Math.max(0, frame.length - Math.max(0, dialogHeight(frame, max)))
  const lines = frame.slice(from)
  let start = 0
  let end = lines.length
  while (start < end && (lines[start] ?? '').trim() === '') start++
  while (end > start && (lines[end - 1] ?? '').trim() === '') end--
  return lines.slice(start, end)
}

/** A numbered option row, in the shape `parseDialogOptions` reads. Kept in step with it by test. */
const OPTION_ROW = /^\s*(?:❯|>)?\s*(\d{1,2})\.\s+\S/

/** How far above the first option the question itself may reach. */
const QUESTION_LINES = 12

/**
 * HOW MANY LINES THE DIALOG ACTUALLY OCCUPIES — PURE.
 *
 * `max` was a flat count sized for a permission prompt with three short options, and an
 * `AskUserQuestion` is much taller: four options, several of them wrapping onto two lines, plus a
 * footer. The window then began BELOW the question, and the card showed a list of answers with
 * nothing saying what was being asked — reported with a screenshot whose first line is the middle
 * of a sentence.
 *
 * The dialog's own structure says where it starts: its FIRST OPTION. `parseDialogOptions` already
 * anchors on `1.` for the same reason, bottom-up, because the dialog is the last block on screen.
 * So the window is "everything from a little above option 1", which grows with the dialog instead
 * of guessing at its height.
 *
 * IT ONLY EVER GROWS THE WINDOW, and only when it found an anchor. With no `1.` in range this
 * returns `max` unchanged — the permission-prompt case, and every frame this cannot read. Reaching
 * further up on a frame whose shape is unknown is how the conversation above a dialog ends up
 * printed under "you are about to confirm this", which is the failure `approvalTail`'s own header
 * calls the worst possible way to be wrong.
 *
 * The extra room above option 1 is bounded (`QUESTION_LINES`) for that same reason: a question is a
 * sentence or two, not a screen.
 */
export function dialogHeight(frame: readonly string[], max: number): number {
  // Look no further up than the question could possibly reach — the same bound the return honours.
  const limit = Math.max(0, max) + QUESTION_LINES
  const from = Math.max(0, frame.length - limit)
  const blank = (i: number) => (frame[i] ?? '').trim() === ''
  for (let i = frame.length - 1; i >= from; i--) {
    const m = OPTION_ROW.exec(frame[i] ?? '')
    if (!m || m[1] !== '1') continue
    /*
     * THE QUESTION IS THE BLOCK IMMEDIATELY ABOVE OPTION 1, and a blank line is what separates it
     * from the conversation. A flat "N lines above" cannot tell the two apart, and reaching one
     * line too far prints somebody's earlier prose under "you are about to confirm this".
     *
     *   …conversation…      ← must not be reached
     *   (blank)             ← the boundary
     *   Devo abrir a issue…  ← the question
     *   (blank)             ← the dialog's own spacing
     *     1. …              ← the anchor
     */
    let top = i
    // The dialog's own spacing above option 1.
    while (top > from && blank(top - 1)) top--
    // The question itself: the contiguous non-blank block.
    while (top > from && !blank(top - 1)) top--
    const height = frame.length - top
    // Never smaller than the flat window: this only ever grows it.
    return Math.min(limit, Math.max(Math.max(0, max), height))
  }
  return Math.max(0, max)
}

/** A line that is only box-drawing or rule characters — a frame's furniture, never its content. */
const RULE = /^[─━═╌┄┈╭╰╮╯┌└┐┘│|+\-=_~]+$/
/** An empty input box: the prompt glyph with nothing after it. */
const EMPTY_PROMPT = /^[❯>›»]\s*$/

/**
 * The last few lines of the frame that actually say something — PURE.
 *
 * This is the "what is it doing right now" a person wants when they select a session, and it costs
 * nothing extra: the frame was already captured to decide the state.
 *
 * The hard part is not finding the last lines, it is not returning the harness's own CHROME. Every
 * one of these CLIs draws the same structure — the conversation, then an input box, then a status
 * strip — so the content is everything ABOVE the box, and the box announces itself with a rule or a
 * border. Cutting there is structural rather than a per-harness pattern, which matters: a pattern
 * list would need re-probing on every CLI release, and this does not.
 *
 * Verified against real frames from claude 2.1.231, codex 0.113.0 and kimi 0.35.0 — see the tests.
 */
export function frameTail(frame: readonly string[], max = 4): string[] {
  // Everything from the last rule or box edge onward is the input box and the status strip.
  let end = frame.length
  for (let i = frame.length - 1; i >= 0; i--) {
    if (RULE.test((frame[i] ?? '').trim())) { end = i; break }
  }

  const body = frame.slice(0, end)
  const out: string[] = []
  for (let i = body.length - 1; i >= 0 && out.length < max; i--) {
    const line = (body[i] ?? '').trim()
    if (!line) continue
    if (RULE.test(line) || EMPTY_PROMPT.test(line)) continue
    // A harness with no rule around its box (codex) ends on a status strip instead: a run of
    // `·`-separated facts. Dropped only at the very END of the frame, where it is chrome — the same
    // characters mid-conversation are something the assistant actually said.
    if (out.length === 0 && end === frame.length && line.includes(' · ') && !line.startsWith('●')) continue
    out.push(line)
  }
  return out.reverse()
}


/**
 * Is something running that is NOT the main agent's turn — PURE.
 *
 * True when the harness says something is interruptible while its own turn marker is absent: a
 * background subagent, a watcher, a build being followed. The session still NEEDS A PERSON, and
 * that is what the state says; this is the mark beside it, so "needs you" does not read as "and
 * nothing is happening".
 *
 * Answers `false` for a harness with no `mainWorking`: without a way to tell the main turn apart,
 * every interruptible frame would be reported as background work, which is a confident claim made
 * out of an absence.
 */
export function backgroundWork(o: {
  frame: readonly string[]
  rules?: AttentionRules
}): boolean {
  if (!o.rules?.mainWorking?.length || !o.rules.working?.length) return false
  const text = o.frame.join('\n')
  if (o.rules.mainWorking.some(re => re.test(text))) return false
  return o.rules.working.some(re => re.test(text))
}
