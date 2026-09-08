/**
 * commentBody — a comment is TEXT plus the files pasted into it, and this is the one place that
 * decides how the two are written down together.
 *
 * A pasted screenshot becomes a real task FILE (one store, one Files tab, one delete) and the
 * comment carries a REFERENCE to it: `![name](file:<id>)`. Storing the picture in the comment body
 * would give the task two file stores that no surface reconciles; storing only the text would put
 * the screenshot in the Files tab with nothing saying which comment it belonged to.
 *
 * The reference is by **id**, never by name: two screenshots pasted in the same second carry the
 * same minted name, and a name-keyed reference then paints whichever one the list happened to
 * return first.
 *
 * Rendering is deliberately total. A reference whose file is GONE (deleted from the Files tab)
 * renders as its name in plain text — never a broken image, which is indistinguishable from a
 * failed load, and never silence, which would erase the fact that something was attached.
 */

export interface CommentAttachment {
  id: string
  name: string
}

export type CommentPart =
  | { kind: 'text'; text: string }
  | { kind: 'file'; id: string; name: string }

/** `![name](file:id)`. Names may not carry `]`, ids are the minted hex — neither can break the form. */
const REF = /!\[([^\]]*)\]\(file:([A-Za-z0-9_-]+)\)/g

export function attachmentToken(a: CommentAttachment): string {
  // The name is for the reader and for the fallback; the id is what resolves.
  return `![${a.name.replace(/[[\]]/g, '')}](file:${a.id})`
}

/**
 * Appends the tokens to a body, keeping them on their own line so the prose stays readable when a
 * surface that does not know this format prints the raw text (the MCP tools do exactly that).
 */
export function bodyWithAttachments(text: string, files: readonly CommentAttachment[]): string {
  if (files.length === 0) return text
  const refs = files.map(attachmentToken).join(' ')
  const body = text.trim()
  return body ? `${body}\n\n${refs}` : refs
}

export function parseCommentBody(body: string): CommentPart[] {
  const parts: CommentPart[] = []
  let last = 0
  // A fresh RegExp per call: a module-level /g keeps `lastIndex` between calls and would skip the
  // first reference of every second comment rendered.
  const re = new RegExp(REF.source, 'g')
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m.index > last) parts.push({ kind: 'text', text: body.slice(last, m.index) })
    parts.push({ kind: 'file', id: m[2] ?? '', name: m[1] ?? '' })
    last = m.index + m[0].length
  }
  if (last < body.length) parts.push({ kind: 'text', text: body.slice(last) })
  return parts
}

/** Extensions a browser paints inline — the same list `TaskFiles` uses, for the same reason. */
const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i

export const looksLikeImage = (name: string) => IMAGE.test(name)
