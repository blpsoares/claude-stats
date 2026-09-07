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
