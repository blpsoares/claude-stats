/**
 * dialog-choice.ts — PURE. The OPTIONS a blocked session is offering, read off its screen.
 *
 * ## Why this exists
 *
 * `approval-spec.ts` shipped with one keystroke per harness and the honest warning that it
 * "confirms the highlighted option and is not approve". That warning turns out to describe a real
 * hole rather than a caveat, and a user found it: a session sitting on
 *
 *     ❯ 1. Só o meu fix, isolado
 *       2. Promover dev→main inteiro
 *       3. Parar em dev por enquanto
 *       4. Type something.
 *
 * has no "approve". Pressing a key called approve there picks, blind, between four things that do
 * different work on somebody's repository. It is the same class of mistake as the prompt that fell
 * into a dialog's filter and approved a command nobody had read — quieter, and just as bad.
 *
 * The fix is not a better keystroke, it is READING THE OPTIONS and letting a person choose one.
 * They are on the screen; the frame is already captured to decide the state.
 *
 * ## Why the discriminator is the options and not the footer
 *
 * The obvious design is to tell "yes/no" dialogs from "choose one of N" by their footers, the way
 * `attention-rules.ts` tells one claude dialog from another. It does not survive contact with the
 * data: claude's PERMISSION prompt is itself a numbered list —
 *
 *     ❯ 1. Yes
 *       2. Yes, allow all edits during this session (shift+tab)
 *       3. No
 *
 * — so there is no yes/no dialog to separate out. There is one select component whose options
 * differ, and "Yes" being first is a convention, not a guarantee. The footer answers "is a dialog
 * open"; only the options answer "what would I be choosing".
 *
 * ## Confidence, and what happens without it
 *
 * A list of numbers is easy to hallucinate: an assistant that printed `1. foo / 2. bar` in its
 * answer would look exactly like a menu. Three things bound that:
 *
 *  - This is only ever run on a frame `attention-rules.ts` has ALREADY matched as a dialog.
 *  - The scan runs BOTTOM-UP and stops at the first `1.` it meets, so it reads the last block on
 *    the screen — the dialog is drawn at the bottom.
 *  - The numbers must come out as exactly `1..n` with nothing missing and nothing repeated. A
 *    prose list that happens to sit at the bottom will usually fail this; when it cannot be shown
 *    to be a menu, the answer is NO options, and the caller says so instead of guessing.
 *
 * Verified against three real claude 2.1.232 dialogs on 2026-08-14 (a Bash permission prompt, a
 * Write permission prompt and an `AskUserQuestion`), all captured from live sessions.
 */

/** One option a dialog is offering. */
export interface DialogOption {
  /** The number the dialog printed, which is also what is typed to pick it. */
  number: number
  /** The option's own line, without its number and without the cursor. */
  label: string
  /** True for the one the dialog is currently highlighting. */
  selected: boolean
}

/**
 * A numbered option line.
 *
 * The cursor glyph is optional and is what marks the highlighted row. The label must start with a
 * non-space, so `1.` on its own is not an option — a bare number with no text is far more likely to
 * be an ordinal in prose than a menu entry.
 */
const OPTION = /^\s*(❯|>)?\s*(\d{1,2})\.\s+(\S.*?)\s*$/

/**
 * How far up the frame to look for the dialog's LAST option row.
 *
 * Below the last option there is only chrome — a rule, a footer, the input box — so this is a
 * bound on the harness's furniture, which does not grow. It is NOT a bound on the dialog.
 */
const LAST_OPTION_LINES = 40

/**
 * How far apart two option rows of ONE menu may sit.
 *
 * This replaced a flat 40-line ceiling on the whole block, and the distinction matters because a
 * flat line count is not a bound on the DIALOG — it is a bound on the TERMINAL WIDTH. The same
 * `AskUserQuestion` whose descriptions wrap onto two lines at 120 columns wraps onto four at 60,
 * and crosses any fixed ceiling purely by the window being narrow. That is exactly how this
 * survived its own tests: measured wide, reported from a narrow window.
 *
 * The gap is the structural fact instead. Between option k and option k+1 there is only option k's
 * own description, so the block extends as far as its options do and stops where prose begins.
 */
const MAX_OPTION_GAP = 14

/** Why a dialog that IS on screen could not be read. Each is a fact about the frame. */
export type DialogUnreadable =
  /** Option rows were found and the scan never reached `1.` — the block ran off the top. */
  | 'no-anchor'
  /** The numbers did not come out `1..n`: a gap, a repeat, or a wrong start. */
  | 'gap'
  /** Two highlighted rows. A frame this parser does not understand. */
  | 'two-cursors'

/**
 * WHAT THE SCREEN IS OFFERING — PURE, and the ONE reader of the block.
 *
 * `kind` is the whole point of this type. An empty option list used to be the only answer for two
 * situations that could not be more different:
 *
 *  - `none`       — there is no menu. The codex-shaped `Press enter to continue`. A bare confirm
 *                   key is the RIGHT answer here, because there is nothing to choose between.
 *  - `unreadable` — there IS a menu and agentop could not read it. A bare confirm key takes
 *                   whichever row is highlighted, which is choosing for the user among things that
 *                   do different work.
 *
 * The caller read `[]` as the first and got the second, and the confirm button appeared on a
 * six-option `AskUserQuestion` that the reader had just refused. That is the exact accident this
 * module was written to remove, reintroduced through its own refusal. So the refusal is now a
 * VALUE, and a caller that wants to offer a confirm has to ask for `none` by name.
 */
export interface DialogRead {
  kind: 'options' | 'none' | 'unreadable'
  /** The options, in order. EMPTY unless `kind` is `options` — a half-read list is never offered. */
  options: DialogOption[]
  /** Present only on `unreadable`. */
  reason?: DialogUnreadable
  /** Index of the TOPMOST option row reached, `-1` when none was. Feeds the preview's window. */
  top: number
}

/**
 * Read the dialog off the frame — PURE.
 *
 * Bottom-up, because the dialog is the last block on the screen, stopping at `1.` because that is
 * where the block begins. Everything the old `parseDialogOptions` refused it still refuses; it now
 * says WHICH refusal, and hands back where the block starts so the preview and the options can
 * never describe different parts of the screen.
 */
export function readDialog(frame: readonly string[]): DialogRead {
  const found: DialogOption[] = []
  let top = -1
  let anchored = false

  for (let i = frame.length - 1; i >= 0; i--) {
    // The LAST option is near the bottom, under nothing but chrome. Past this bound with nothing
    // found, there is no dialog here — and reading further would be reading the scrollback.
    if (found.length === 0 && frame.length - 1 - i > LAST_OPTION_LINES) break
    const m = OPTION.exec(frame[i] ?? '')
    if (!m) continue
    // Too far above the previous option to be part of the same menu: this is prose that happens to
    // be numbered, and joining it to the block would invent a menu.
    if (found.length > 0 && top - i > MAX_OPTION_GAP) break
    found.push({ number: Number(m[2]), label: m[3]!, selected: m[1] !== undefined })
    top = i
    if (Number(m[2]) === 1) { anchored = true; break }
  }

  found.reverse()

  // Nothing numbered at the bottom at all: there is no menu to read.
  if (found.length === 0) return { kind: 'none', options: [], top: -1 }
  // Rows were found and `1.` never was. The block is real and its top is out of reach.
  if (!anchored) return { kind: 'unreadable', reason: 'no-anchor', options: [], top }
  // A menu is at least a choice. One option is a statement, and the caller confirms it instead.
  if (found.length < 2) return { kind: 'none', options: [], top }
  // Exactly `1..n`, in order. A gap, a repeat or a wrong start means this was not read correctly —
  // and half-read options are worse than none, because they would be offered as if they were whole.
  if (found.some((o, i) => o.number !== i + 1)) return { kind: 'unreadable', reason: 'gap', options: [], top }
  // At most one highlighted row. Two cursors is a frame this parser does not understand.
  if (found.filter(o => o.selected).length > 1) {
    return { kind: 'unreadable', reason: 'two-cursors', options: [], top }
  }

  return { kind: 'options', options: found, top }
}

/**
 * The options on screen, in order — EMPTY when they cannot be read with confidence.
 *
 * A thin reading of `readDialog`, kept because most callers only want the list. **A caller deciding
 * whether to send a confirm key must NOT use this** — `[]` conflates "no menu" with "unreadable
 * menu", and that conflation is what put a blind confirm button on a six-option dialog. Ask
 * `readDialog(...).kind === 'none'`.
 */
export function parseDialogOptions(frame: readonly string[]): DialogOption[] {
  return readDialog(frame).options
}

/**
 * Does this dialog need a CHOICE rather than a confirmation? — PURE.
 *
 * The question the UI asks before deciding whether it may send a bare confirm key. `false` for a
 * dialog with no readable options, which is the codex-shaped `Press enter to continue` case: there
 * really is nothing to choose between.
 */
export function needsChoice(options: readonly DialogOption[]): boolean {
  return options.length > 1
}
