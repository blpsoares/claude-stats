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
import type { MentionToken } from './mentionTokens'

/** How a run is painted. `plain` is the ordinary text the field would have drawn anyway. */
export type SegmentKind = 'plain' | 'command' | 'mention'

export interface DraftSegment {
  text: string
  kind: SegmentKind
}

/**
 * The runs the mirror layer draws, in order.
 *
 * TWO KINDS, and they are not the same thing. A `found` command is an ACTION the message performs,
 * and it is painted as the button it effectively is. A mention is a REFERENCE to something on this
 * machine, and it is marked as a chip — enough to say "this was picked from a real list", which is
 * what it was missing when it read as loose text.
 *
 * Only what can be vouched for is painted: a `missing` or `unknown` command claims nothing (see
 * `commandToken.ts`), and a mention whose server this machine does not have is left plain (see
 * `mentionTokens.ts`). Everything else comes back as plain runs, which is also the signal
 * `needsMirror` uses to decide whether to draw the mirror at all.
 *
 * The command is only ever at the head and a mention can be anywhere, so the ranges are collected,
 * sorted and walked once. They cannot overlap — a command's range ends before any whitespace, and
 * a mention must start after whitespace — but the walk skips anything that would, rather than
 * trusting that.
 */
export function draftSegments(
  draft: string,
  token: CommandToken | null,
  mentions: readonly MentionToken[] = [],
): DraftSegment[] {
  const marks: { start: number; end: number; kind: SegmentKind }[] = []
  if (token !== null && token.state === 'found') {
    marks.push({ start: token.start, end: token.end, kind: 'command' })
  }
  for (const m of mentions) marks.push({ start: m.start, end: m.end, kind: 'mention' })
  marks.sort((a, b) => a.start - b.start)

  const out: DraftSegment[] = []
  let at = 0
  for (const mark of marks) {
    if (mark.start < at) continue
    if (mark.start > at) out.push({ text: draft.slice(at, mark.start), kind: 'plain' })
    out.push({ text: draft.slice(mark.start, mark.end), kind: mark.kind })
    at = mark.end
  }
  if (at < draft.length) out.push({ text: draft.slice(at), kind: 'plain' })
  return out.length > 0 ? out : [{ text: draft, kind: 'plain' }]
}

/**
 * Whether the mirror needs to be drawn at all, and the textarea's own text hidden.
 *
 * The same condition `draftSegments` uses to decide there is a coloured run — kept as its own
 * function because the caller needs it TWICE (whether to render the mirror div, and whether to make
 * the textarea's text transparent) and those two decisions must never drift apart: a mirror drawn
 * without the text hidden doubles the command, and hidden text with no mirror is a blank field.
 */
export function needsMirror(
  token: CommandToken | null,
  mentions: readonly MentionToken[] = [],
): boolean {
  return (token !== null && token.state === 'found') || mentions.length > 0
}
