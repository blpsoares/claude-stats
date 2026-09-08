/**
 * attachmentPreview.ts — PURE. Which lines of a turn's text are image ATTACHMENTS, not prose.
 *
 * An attachment here is a PATH — see `attachment-web.ts`'s header: the composer types a line into a
 * tmux pane, so `send()` joins the quote, then one line per attachment's own path, then whatever was
 * typed. The transcript records exactly that, verbatim, so this rule reads the same turn text
 * whether it is the client's own echo or the harness's own record — one rule, not two.
 *
 * The heuristic is deliberately narrow: a line that is JUST a path (no spaces) ending in a known
 * image extension. Prose that happens to mention "see diagram.png in the repo" has spaces around
 * the name and is left alone; a bare attachment line never does, because that is how it was built.
 */

import type { AttachmentSend } from '@agentistics/core'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'])

export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return false
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase())
}

/** A path-shaped line: no whitespace, and not empty. Prose never qualifies. */
function looksLikeBarePath(line: string): boolean {
  return line !== '' && !/\s/.test(line)
}

export interface SplitAttachments {
  /** The image paths found, in the order they appeared. */
  images: string[]
  /** The remaining text, with those lines removed and no blank line left in their place. */
  text: string
}

export function splitImageAttachments(text: string): SplitAttachments {
  const images: string[] = []
  const kept: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (looksLikeBarePath(trimmed) && isImagePath(trimmed)) images.push(trimmed)
    else kept.push(line)
  }
  return { images, text: kept.join('\n').trim() }
}

/**
 * `[Image #4]` — what the HARNESS writes where an image was, and it is not prose.
 *
 * A separate rule from `splitImageAttachments` because it answers about a different kind of thing.
 * That one finds a PATH the composer typed, which names a file this product can open. This one
 * finds a MARKER Claude Code substituted into the turn it recorded: an ordinal and nothing else, so
 * there is no file behind it and never will be — the honest render is a chip saying which image it
 * was, not a thumbnail we cannot produce.
 *
 * It exists because of what a QUEUED prompt looks like on arrival. A harness that is mid-turn holds
 * what arrives and commits the queue as ONE turn (see `echoMatch.ts`), so two prompts sent a minute
 * apart come back merged, with every image of both collected at the front:
 *
 *     [Image #4] [Image #5] [Image #6]1. a visao geral...
 *
 * — markers running straight into the first word, which is how a message with three screenshots on
 * it read as a message beginning with square brackets. The merging itself is the harness's, not
 * ours, and cannot be undone from here; the markers are ours to draw properly.
 *
 * LEADING ONLY, like `splitMessage`, and for a stronger reason than symmetry: this repo's own
 * conversations quote these markers while discussing them, so a rule matching anywhere would eat a
 * line somebody actually wrote. Every marker measured on real transcripts sits at the very start.
 */
export interface SplitMarkers {
  /** The ordinals, in the order the harness numbered them. */
  markers: number[]
  /** What is left once the leading run is removed. */
  text: string
}

const LEADING_MARKER = /^\s*\[Image #(\d+)\]/

export function splitImageMarkers(text: string): SplitMarkers {
  const markers: number[] = []
  let rest = text
  for (;;) {
    const m = LEADING_MARKER.exec(rest)
    if (!m) break
    markers.push(Number(m[1]))
    rest = rest.slice(m[0].length)
  }
  return { markers, text: markers.length > 0 ? rest.trim() : text }
}


// --- a marker that CAN find its file ----------------------------------------

/**
 * How far back a turn may look for its own sends.
 *
 * Generous, because the whole point is the QUEUED case: the harness holds a message until its
 * current turn ends, which is minutes on a working session and occasionally much longer. Being
 * generous costs nothing — a window that catches a neighbouring message makes the count disagree,
 * and a disagreeing count resolves to nothing.
 */
export const SEND_WINDOW_MS = 60 * 60_000

/**
 * The files behind a turn's markers, in order — or `null` when it cannot be said.
 *
 * The comment above says a marker has no file behind it. That was WRONG, and this is the
 * correction: agentop wrote those files itself (185 of them on the machine this was measured on)
 * and knew the session it was typing them into. What was missing was never the file — it was the
 * record that we sent it, which `attachment-log`/`attachment-web.ts` now keeps.
 *
 * ALL-OR-NOTHING, deliberately. Drawing the WRONG image under a message is worse than drawing a
 * chip: a chip says "an image was here", which is true and useless, while a wrong thumbnail is
 * false and convincing. So markers resolve only when the sends in the window account for them
 * EXACTLY — same count, one file per marker. A second message in the window, a file since deleted,
 * a marker the harness numbered from elsewhere: each makes the count disagree, and the chip stays.
 *
 * The ordinals are the harness's numbering across its WHOLE conversation, so they are a count here
 * and never an index into anything of ours.
 */
export function resolveMarkerPaths(input: {
  markers: readonly number[]
  turnAtMs: number
  sends: readonly AttachmentSend[]
}): string[] | null {
  if (input.markers.length === 0) return null
  const inWindow = input.sends
    .filter(s => s.atMs <= input.turnAtMs && input.turnAtMs - s.atMs <= SEND_WINDOW_MS)
    .sort((a, b) => a.atMs - b.atMs)
  if (inWindow.length !== input.markers.length) return null
  return inWindow.map(s => s.path)
}
