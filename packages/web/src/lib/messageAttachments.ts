/**
 * messageAttachments.ts — PURE: the files a message carried, split from the words.
 *
 * The composer sends attachments as PATHS on their own lines above the typed text — the transport
 * types a line into a tmux pane, so there is no channel a byte array could travel down, and every
 * one of these CLIs reads a file it is pointed at. That means a sent message is two things joined
 * by newlines, and anything showing it back has to take them apart again: the "view message" modal
 * rendered the paths as the first lines of the prose, which is how a message with an image in it
 * looked like a message that began with a filename.
 *
 * NOT A DUPLICATE OF `attachmentPreview.ts`, though it was briefly deleted as one. They answer
 * different questions over the same string, and the difference is load-bearing:
 *
 *   - `splitImageAttachments` asks "which lines here are image paths I can PREVIEW" — a rendering
 *     question, answered anywhere in the text, for any image path.
 *   - this asks "which leading lines were files the composer SENT" — a provenance question,
 *     answered only at the top and only inside agentop's own attachments directory.
 *
 * The gallery needs the second: it lists what a person attached, images and everything else, and
 * an image path somebody typed into the middle of a sentence is not something they attached.
 *
 * IT ONLY CLAIMS WHAT IT CAN PROVE. A leading line is an attachment when it is a path into
 * agentop's own attachments directory — the one place the composer puts uploads. Any other path is
 * left in the text: a person can legitimately start a message with a filename, and turning that
 * into a chip would be inventing an attachment that was never sent.
 */

/** Where the composer stores an upload. A path outside this is not an attachment we made. */
export const ATTACHMENT_DIR_MARK = '/.agentistics/attachments/'

export interface MessageParts {
  /** The paths, in the order they were attached. */
  attachments: string[]
  /** What the person actually typed. */
  text: string
}

/** The file's own name, for a chip. */
export function attachmentName(path: string): string {
  return path.split('/').pop() ?? path
}

/** Is this an image, by extension? Decides whether a preview is possible at all. */
export function isImageAttachment(path: string): boolean {
  const ext = attachmentName(path).split('.').pop()?.toLowerCase() ?? ''
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'].includes(ext)
}

/**
 * Split a sent message into its attachments and its words.
 *
 * LEADING lines only. The composer puts the paths first, and a path further down is part of what
 * somebody wrote — a message quoting a file it wants read is not the same as a message carrying
 * one, and treating them alike would silently move a line out of the prose.
 */
export function splitMessage(raw: string): MessageParts {
  const lines = raw.split('\n')
  const attachments: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!.trim()
    if (line === '' && attachments.length > 0) { i++; continue }
    if (!line.includes(ATTACHMENT_DIR_MARK)) break
    attachments.push(line)
    i++
  }
  return { attachments, text: lines.slice(i).join('\n').trim() }
}
