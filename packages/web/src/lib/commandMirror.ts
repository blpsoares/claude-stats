/**
 * commandMirror.ts — PURE: what the composer's mirror layer draws.
 *
 * A textarea cannot hold a coloured span, so painting the `found` command as a button needs a
 * second copy of the text sitting behind the field, with the field's OWN text made transparent so
 * only the mirror is seen. That is a bigger trade than the old background-only underlay made (it
 * kept the textarea's real, opaque text on top and only painted a highlight behind it, so the
 * caret and the text selection stayed native) — but a background block cannot turn white-on-orange,
 * because the textarea's characters are still drawn in the ordinary foreground colour over it. A
 * BUTTON needs the glyphs themselves recoloured, and a plain textarea has no such per-run colour.
 *
 * So the mirror is drawn ONLY while there is something to recolour — a `found` token — and the
 * textarea keeps its own opaque text everywhere else. `needsMirror` is the one predicate that
 * decides which world a given render is in, and `draftSegments` is the one function that turns the
 * draft into the runs the mirror paints. Nothing here is state: both are read straight off the
 * draft and the token on every render, which is what makes "delete a character, it goes back to
 * plain text" fall out for free rather than needing a flag someone has to remember to clear.
 */

import type { CommandToken } from './commandToken'

export interface DraftSegment {
  text: string
  /** Paint this run as the command button — orange background, white text. */
  button: boolean
}

/**
 * The runs the mirror layer draws, in order.
 *
 * Only a `found` token is ever painted — `missing` and `unknown` claim nothing about the text (see
 * `commandToken.ts`), so there is nothing to recolour and the textarea's own text already reads
 * correctly. The whole draft comes back as one plain run in every other case, which is also the
 * signal `needsMirror` uses to decide whether the mirror should be drawn at all.
 *
 * `token.start` is always 0 (`commandToken` only ever matches the head of the draft), but the slice
 * is taken from it rather than hardcoded so this keeps working if that ever stops being true.
 */
export function draftSegments(draft: string, token: CommandToken | null): DraftSegment[] {
  if (token === null || token.state !== 'found') return [{ text: draft, button: false }]
  const before = draft.slice(0, token.start)
  const head = draft.slice(token.start, token.end)
  const rest = draft.slice(token.end)
  const segments: DraftSegment[] = []
  if (before !== '') segments.push({ text: before, button: false })
  segments.push({ text: head, button: true })
  if (rest !== '') segments.push({ text: rest, button: false })
  return segments
}

/**
 * Whether the mirror needs to be drawn at all, and the textarea's own text hidden.
 *
 * The same condition `draftSegments` uses to decide there is a coloured run — kept as its own
 * function because the caller needs it TWICE (whether to render the mirror div, and whether to make
 * the textarea's text transparent) and those two decisions must never drift apart: a mirror drawn
 * without the text hidden doubles the command, and hidden text with no mirror is a blank field.
 */
export function needsMirror(token: CommandToken | null): boolean {
  return token !== null && token.state === 'found'
}
