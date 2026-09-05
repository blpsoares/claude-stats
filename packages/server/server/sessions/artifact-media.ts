/**
 * artifact-media.ts — PURE: which files a session produced may be SHOWN, and as what.
 *
 * The gallery listed only what a PERSON attached. Asked for the other half: "na galeria tbm devem
 * ter as suas imagens, quando vc gerar imagens, tirar prints, gerar pdfs e etc" — the screenshots,
 * diagrams and PDFs the assistant itself produced, which today can only be found by opening a file
 * manager.
 *
 * Showing them means serving BYTES, which `/api/fleet/file` deliberately refuses: it answers with
 * text and calls a binary file "nothing to show here". So there is a second route, and this module
 * is the whole of its judgement about content.
 *
 * THE ALLOWLIST IS NOT THIS MODULE'S JOB. Which paths a session may serve at all is
 * `planArtifactRead`'s — files this session wrote, inside its own directory, symlinks resolved.
 * This decides only what a served file is DECLARED to be, and it is a fixed table:
 *
 * - An extension NOT in the table is refused. A default of `application/octet-stream` would make
 *   this route a general file-download for anything a session ever wrote, which is a different
 *   feature with a different threat model.
 * - **SVG IS REFUSED**, and it is the reason the table is a table. An SVG is a document that can
 *   carry script, and served inline from the dashboard's own origin it runs there — a session that
 *   writes one would be writing code into the page that is watching it. It is named in the refusal
 *   rather than silently missing, because "my diagram does not show up" deserves an answer.
 * - The caller must send `nosniff` and a `default-src 'none'` policy with whatever this returns:
 *   the declared type is only honest if the browser is forbidden from guessing another.
 */

export type MediaKind = 'image' | 'pdf'

export interface MediaType {
  mime: string
  kind: MediaKind
}

const TABLE: Record<string, MediaType> = {
  png: { mime: 'image/png', kind: 'image' },
  jpg: { mime: 'image/jpeg', kind: 'image' },
  jpeg: { mime: 'image/jpeg', kind: 'image' },
  gif: { mime: 'image/gif', kind: 'image' },
  webp: { mime: 'image/webp', kind: 'image' },
  avif: { mime: 'image/avif', kind: 'image' },
  bmp: { mime: 'image/bmp', kind: 'image' },
  pdf: { mime: 'application/pdf', kind: 'pdf' },
}

/** Extensions that LOOK like media and are deliberately refused, with the reason in the UI's words. */
export const REFUSED_EXT = new Set(['svg', 'svgz', 'html', 'htm', 'xml'])

export function extensionOf(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** The type to serve this path as, or `null` when it is not something this route shows. */
export function mediaTypeFor(path: string): MediaType | null {
  return TABLE[extensionOf(path)] ?? null
}

/** Is this a path the gallery should offer at all? Refused-but-media-shaped counts, so it can say so. */
export function isMediaPath(path: string): boolean {
  const ext = extensionOf(path)
  return ext in TABLE || REFUSED_EXT.has(ext)
}

/** How big a file this route will send. Beyond it the gallery links rather than renders. */
export const MAX_MEDIA_BYTES = 12 * 1024 * 1024
