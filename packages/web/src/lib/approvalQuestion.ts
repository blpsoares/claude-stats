/**
 * approvalQuestion.ts — PURE: which part of a dialog's screen is the QUESTION.
 *
 * THE CARD SHOWED EVERYTHING AND THEREFORE SHOWED NOTHING. `ApprovalCard` rendered the captured
 * frame whole, in an 11px dimmed monospace block — the question, then every option with its full
 * description, then the `────` rule, then the harness's own footer (`Enter to select · ↑/↓ to
 * navigate · Esc to cancel`) — and then drew the same options AGAIN underneath as buttons. So the
 * one line that is NOT duplicated by the buttons, the question itself, was a line among twenty in
 * the smallest and faintest text on the card. Reported three times, in these words: "não consigo
 * ver o enunciado da pergunta dele".
 *
 * The comment defending the raw block was right about permission prompts — a person agreeing to a
 * command has to read the command, and a button label does not carry it. It inverts for a question
 * with named options: there the labels ARE the buttons, so the block becomes a duplicate that
 * buries the only thing it alone carried.
 *
 * THE SPLIT IS THE FIRST OPTION. Everything above `1.` is what was being asked — the question, and
 * on a permission prompt the command being asked about. Everything from `1.` down is the option
 * list and the terminal's own chrome, which the buttons already say. Nothing is discarded: the card
 * keeps the whole frame behind a disclosure, unchanged, so what a person agrees to is always
 * readable in full.
 *
 * TOTAL, and conservative in the direction that cannot lose text. A frame with no numbered option
 * (codex's `Press enter to continue`) has NO question part and keeps the whole frame as it was —
 * inventing a split there would promote an arbitrary first line into a heading.
 */

export interface ApprovalFrame {
  /** What is being asked, in reading order. Empty when the frame has no numbered options. */
  question: string[]
  /** The frame exactly as captured — never a subset. The disclosure shows this. */
  raw: string[]
}

/** `1.` at the start, with or without the cursor mark the harness draws on the current row. */
const FIRST_OPTION = /^(?:❯\s*)?1\.\s/

/** The box gutter Claude Code draws down the left of a question. Chrome, never content. */
const GUTTER = /^│\s?/

/**
 * How close to the longest line counts as "the terminal ran out of room here".
 *
 * A wrapped line is FULL; a line the author ended is short. Three characters of slack, because a
 * wrap lands on a word boundary and the last word rarely fills the column exactly.
 */
const FULL_SLACK = 3

/**
 * Undo the TERMINAL's wrapping — and only the terminal's.
 *
 * A boxed question is wrapped at the box width, so its breaks are an artefact of the column and a
 * sentence arrives cut in half ("…antes ou depois" / "do fechamento contabil?"). Joining every line
 * would be wrong in the other direction: a permission prompt puts the COMMAND on its own line
 * inside the same box, and a command joined onto the sentence above it is unreadable and, worse,
 * misquoted.
 *
 * So a line is joined to the one before it only when that one was FULL — within `FULL_SLACK` of the
 * BOX WIDTH. And the box width is measured over the WHOLE frame, never over the question alone: the
 * box is one column that the options and the `────` rule are drawn at too, so the frame is where it
 * is visible. Measuring the question slice instead makes its own longest line the ceiling, which is
 * how a two-line prompt "proves" its first line was wrapped no matter how short the box really was.
 *
 * A command that genuinely fills the column WAS wrapped by the terminal, and joining it back is
 * restoring it, not corrupting it. It errs toward NOT joining: an unjoined line is the status quo,
 * a wrongly joined one changes what a person reads before they agree to it.
 */
function unwrap(lines: readonly string[], boxWidth: number): string[] {
  const out: { text: string; full: boolean }[] = []
  for (const line of lines) {
    const bare = line.replace(GUTTER, '')
    const prev = out[out.length - 1]
    const joinable = prev !== undefined && prev.full && prev.text.trim() !== '' && bare.trim() !== ''
    if (joinable) {
      prev.text = `${prev.text} ${bare.trim()}`
      prev.full = line.length >= boxWidth - FULL_SLACK
    } else {
      out.push({ text: bare, full: line.length >= boxWidth - FULL_SLACK })
    }
  }
  return out.map(o => o.text)
}

export function splitApprovalFrame(lines: readonly string[]): ApprovalFrame {
  const raw = [...lines]
  const at = raw.findIndex(l => FIRST_OPTION.test(l.trim()))
  if (at <= 0) return { question: [], raw }

  let question = raw.slice(0, at)
  // Trailing blanks belong to the layout, not to the question.
  while (question.length > 0 && question[question.length - 1]!.trim() === '') question.pop()

  // THE GUTTER IS THE EVIDENCE. Its presence says the block was drawn inside a box, which is what
  // makes "the terminal wrapped this" a measurement rather than a guess. Without it, the lines are
  // left exactly as captured.
  const boxed = question.length > 0 && question.every(l => l.trim() === '' || GUTTER.test(l))
  if (boxed) question = unwrap(question, Math.max(...raw.map(l => l.length), 0))

  return { question, raw }
}
