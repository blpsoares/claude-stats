/** The URL that reads an attachment back — see `GET /api/fleet/attachment` and its
 *  `resolveAttachmentRead` guard on the server. One place, so a caller never hand-builds it. */
export function attachmentUrl(path: string): string {
  return `/api/fleet/attachment?path=${encodeURIComponent(path)}`
}

/**
 * The URL that reads one stored attachment back BY ITS NAME — see `GET /api/fleet/attachment/
 * by-name` and its pure `attachmentPathByName` / `attachmentImageType` guards on the server.
 *
 * The narrower of the two, and the one the GALLERY uses. The chat shows an attachment back from
 * the message that carried it, so it necessarily has a path; the gallery is a view OF the
 * attachments directory and needs nothing more than a name — which is a shape that cannot express
 * a traversal at all. That route also serves images ONLY, so it can never become a general reader
 * of agentop's own directory.
 *
 * A `HEAD` on this same URL answers the SIZE without the bytes, which is what the list column
 * under each name is for.
 */
export function attachmentNameUrl(name: string): string {
  return `/api/fleet/attachment/by-name?name=${encodeURIComponent(name)}`
}


/**
 * The URL that reads back a file the SESSION produced — see `GET /api/fleet/media` and its
 * `planArtifactRead` + `artifact-media.ts` guards on the server.
 *
 * The third of these, and the widest, which is why it is the one bound to a SESSION: an attachment
 * is addressed inside agentop's own directory, while this addresses a file wherever the session put
 * it — so the id is not decoration, it is what the allowlist is resolved against. A caller without
 * one has nothing to ask.
 */
export function sessionMediaUrl(sessionId: string, path: string): string {
  return `/api/fleet/media?id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`
}

/** The URL for one gallery row, whichever side it came from. ONE place, so no caller guesses. */
export function galleryFileUrl(
  file: { path: string; name: string; origin?: 'sent' | 'produced' },
  sessionId: string,
): string {
  return file.origin === 'produced'
    ? sessionMediaUrl(sessionId, file.path)
    : attachmentNameUrl(file.name)
}
