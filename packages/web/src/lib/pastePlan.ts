/**
 * pastePlan.ts — PURE. What a paste into the composer should become.
 *
 * Three outcomes, and getting them apart is the whole job:
 *
 * - a paste carrying FILES (a screenshot from the clipboard, a drag from a file manager) becomes
 *   attachments;
 * - a paste of ORDINARY text goes into the field, which is what pasting means;
 * - a paste of a LOT of text becomes an attachment too, because the composer types its content into
 *   a tmux pane character by character. A 4.000-line paste is not a message, it is a file somebody
 *   had in the clipboard, and typing it would take minutes and land in the pane in pieces.
 *
 * Pure so the threshold is one number in one place with a test on it, rather than a condition
 * buried in an event handler where the only way to check it is to paste something.
 */

/**
 * Above this many characters, pasted text is attached instead of typed.
 *
 * Chosen against what the transport is: `sendKeysLiteralArgs` types the string into a pane. A few
 * thousand characters is a long message; twelve thousand is a file. Erring high — an attachment the
 * user meant as a message is a worse surprise than a slow paste.
 */
export const PASTE_TEXT_LIMIT = 12_000

/** Or this many lines. A short-lined paste of 300 rows is a log, whatever its character count. */
export const PASTE_LINE_LIMIT = 200

/** The most attachments one message may carry. */
export const MAX_ATTACHMENTS = 10

export type PastePlan =
  /** Put it in the field. `text` is what to insert. */
  | { kind: 'text'; text: string }
  /** Upload these. `files` came off the clipboard. */
  | { kind: 'files'; files: File[] }
  /** Too big to type — attach it as a text file under `name`. */
  | { kind: 'textFile'; text: string; name: string }
  /** Nothing usable in the clipboard. */
  | { kind: 'none' }

export interface PasteInput {
  files: readonly File[]
  text: string
  /** How many attachments the composer already holds, so the cap is enforced before the upload. */
  existing: number
}

/**
 * Decide what one paste becomes.
 *
 * Files WIN over text: a copied screenshot arrives with both an image and a text/plain fallback
 * (often the file name), and inserting the name is never what was meant.
 */
export function planPaste(input: PasteInput): PastePlan {
  const room = Math.max(0, MAX_ATTACHMENTS - input.existing)

  if (input.files.length > 0) {
    if (room === 0) return { kind: 'none' }
    return { kind: 'files', files: input.files.slice(0, room) }
  }

  const text = input.text
  if (text === '') return { kind: 'none' }

  const lines = countLines(text)
  const big = text.length > PASTE_TEXT_LIMIT || lines > PASTE_LINE_LIMIT
  if (!big) return { kind: 'text', text }

  // No room to attach it, so it goes in the field after all — refusing the paste outright would
  // lose content the user chose to send, which is worse than a slow one.
  if (room === 0) return { kind: 'text', text }

  return { kind: 'textFile', text, name: pastedTextName(text) }
}

function countLines(text: string): number {
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/**
 * A name for a pasted block, so the chip says something.
 *
 * Derived from the first line when that line reads like a name, and otherwise a plain `pasted.txt`
 * — a chip labelled with the first eight words of a stack trace is noise, not a name.
 */
export function pastedTextName(text: string): string {
  const first = (text.split('\n')[0] ?? '').trim()
  // At most three word-ish tokens, and nothing that reads as a sentence. A merely SHORT first line
  // is not a name: `Traceback (most recent call last):` is 34 characters and passed a length test,
  // which is how a chip ended up labelled with the head of a stack trace.
  const looksLikeName = first.length > 0 && first.length <= 40
    && /^[\w.-]+(?:[ _-][\w.-]+){0,2}$/.test(first)
  if (!looksLikeName) return 'pasted.txt'
  const stem = first.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40)
  return stem === '' ? 'pasted.txt' : `${stem}.txt`
}

/** How many of a batch of files actually fit, given what the composer already holds. */
export function attachmentRoom(existing: number): number {
  return Math.max(0, MAX_ATTACHMENTS - existing)
}
