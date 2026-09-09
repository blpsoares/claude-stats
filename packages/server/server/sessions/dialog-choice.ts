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
  /**
   * HOW one of them is picked — and the reason this field exists is that the answer differs.
   *
   * `numbered` — the dialog printed `1.`…`n.` and typing the digit selects. `marker` — it printed
   * no numbers at all (claude's trust prompt: `❯ No, exit` / `  Yes, I trust this folder`), so the
   * only way to reach a row is to MOVE the cursor onto it. `number` on those options is a POSITION,
   * never something to type; a caller that sends it as a digit is typing into the dialog.
   *
   * `null` whenever `kind` is not `options`.
   */
  select: 'numbered' | 'marker' | null
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
export function readDialog(
  frame: readonly string[],
  /**
   * Whether to try the NUMBERLESS shape when no numbers are found.
   *
   * Off by default, and that is the safe direction: a caller that does not know which harness drew
   * this frame must not go looking for a menu with the weaker signal. `ApprovalSpec.markerSelect`
   * is what turns it on, per harness and only where the shape has been measured — see that field
   * for the kimi frame that makes this a gate rather than a flag.
   */
  opts: { marker?: boolean } = {},
): DialogRead {
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

  // Nothing numbered at the bottom at all. It may still be a menu — claude's trust prompt prints
  // none — so the marker shape gets its turn. This is the ONLY place it runs: a frame whose numbers
  // were found and then refused keeps that refusal, or a `gap` would be re-read as two loose rows.
  if (found.length === 0) return opts.marker ? readMarkerSelect(frame) : { kind: 'none', options: [], select: null, top: -1 }
  // Rows were found and `1.` never was. The block is real and its top is out of reach.
  if (!anchored) return { kind: 'unreadable', reason: 'no-anchor', options: [], select: null, top }
  // A menu is at least a choice. One option is a statement, and the caller confirms it instead.
  if (found.length < 2) return { kind: 'none', options: [], select: null, top }
  // Exactly `1..n`, in order. A gap, a repeat or a wrong start means this was not read correctly —
  // and half-read options are worse than none, because they would be offered as if they were whole.
  if (found.some((o, i) => o.number !== i + 1)) return { kind: 'unreadable', reason: 'gap', options: [], select: null, top }
  // At most one highlighted row. Two cursors is a frame this parser does not understand.
  if (found.filter(o => o.selected).length > 1) {
    return { kind: 'unreadable', reason: 'two-cursors', options: [], select: null, top }
  }

  return { kind: 'options', options: found, select: 'numbered', top }
}

/**
 * The select cursor, and ONLY the cursor.
 *
 * `readDialog`'s numbered rule also accepts a plain `>`, because there the digit carries the proof
 * that it is a menu. Here nothing else does, and a `>`-quoted block — two lines of somebody's mail,
 * a diff, a markdown quote — has exactly the shape this scan looks for. `❯` is the glyph claude's
 * select component draws and prose does not.
 */
const MARKER = /^(\s*)❯ (\S.*?)\s*$/

/**
 * A sibling row: its text STARTS at the cursor's label column, exactly.
 *
 * Both halves are load-bearing. Nothing before the column (or the row belongs to some other block),
 * and a non-space AT it — testing only that the prefix is blank accepts a row indented further,
 * which is how an unrelated paragraph two columns to the right joined the menu.
 */
const siblingAt = (line: string, col: number): string | null => {
  if (line.length <= col) return null
  if (line.slice(0, col).trim() !== '') return null
  if (line[col] === ' ') return null
  return line.slice(col).trimEnd()
}

/**
 * A menu with NO numbers, read off the frame — PURE.
 *
 * Claude's trust prompt is the case, and it is the one dialog where being wrong costs the most: the
 * highlighted row is `No, exit`, so the bare confirm the caller used to fall back to answered every
 * one of them by quitting. Reported by a user who could only reach that row from the web and had to
 * open the terminal to say yes.
 *
 * The shape is a cursor row plus the rows CONTIGUOUS with it at the same indentation. That is a
 * weaker signal than `1..n`, so it is fenced accordingly: the `❯` glyph only, at most one of them,
 * a label on the cursor row (the composer's own `❯ ` is empty and must never read as a menu), at
 * least one sibling (one row is a statement — the codex `Press enter to continue` — and a caller
 * confirms those), and a blank line or a change of indentation ends the block.
 *
 * Provenance: the trust frame was captured from a live session on 2026-09-08; the numbered frames
 * and the idle composer in `dialog-marker.test.ts` were captured the same day from claude 2.1.x
 * driven under tmux, which is what pins that this scan leaves them alone.
 */
function readMarkerSelect(frame: readonly string[]): DialogRead {
  const cursors: number[] = []
  for (let i = frame.length - 1; i >= 0; i--) {
    if (frame.length - 1 - i > LAST_OPTION_LINES) break
    if (MARKER.test(frame[i] ?? '')) cursors.push(i)
  }
  if (cursors.length === 0) return { kind: 'none', options: [], select: null, top: -1 }
  // Two highlighted rows is the same fact the numbered path refuses under this name: a frame this
  // parser does not understand, and guessing which cursor is the real one is how a menu gets
  // half-read and offered anyway.
  if (cursors.length > 1) return { kind: 'unreadable', reason: 'two-cursors', options: [], select: null, top: cursors[cursors.length - 1]! }

  const at = cursors[0]!
  const m = MARKER.exec(frame[at] ?? '')!
  // The label's own column — the cursor glyph plus its space. A sibling is a row that starts its
  // text exactly there; anything else belongs to some other block.
  const col = m[1]!.length + 2
  const rows: { i: number; label: string }[] = [{ i: at, label: m[2]! }]

  for (let i = at - 1; i >= 0; i--) {
    const label = siblingAt(frame[i] ?? '', col)
    if (label === null || MARKER.test(frame[i] ?? '')) break
    rows.unshift({ i, label })
  }
  for (let i = at + 1; i < frame.length; i++) {
    const label = siblingAt(frame[i] ?? '', col)
    if (label === null || MARKER.test(frame[i] ?? '')) break
    rows.push({ i, label })
  }

  // One row is a statement, not a choice — and the caller may confirm it, which is exactly what
  // `none` grants and `unreadable` withholds.
  if (rows.length < 2) return { kind: 'none', options: [], select: null, top: at }

  return {
    kind: 'options',
    select: 'marker',
    top: rows[0]!.i,
    // `number` is the POSITION, 1-based, so every caller can address an option the same way it
    // addresses a numbered one. `select: 'marker'` is what stops it being typed as a digit.
    options: rows.map((r, n) => ({ number: n + 1, label: r.label, selected: r.i === at })),
  }
}

/**
 * The options on screen, in order — EMPTY when they cannot be read with confidence.
 *
 * A thin reading of `readDialog`, kept because most callers only want the list. **A caller deciding
 * whether to send a confirm key must NOT use this** — `[]` conflates "no menu" with "unreadable
 * menu", and that conflation is what put a blind confirm button on a six-option dialog. Ask
 * `readDialog(...).kind === 'none'`.
 */
export function parseDialogOptions(
  frame: readonly string[],
  opts: { marker?: boolean } = {},
): DialogOption[] {
  return readDialog(frame, opts).options
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
