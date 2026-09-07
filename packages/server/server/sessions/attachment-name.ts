/**
 * attachment-name.ts — PURE. What a browser-supplied filename is allowed to become on this disk.
 *
 * The whole point is that the name arrives from OUTSIDE. A file called `../../.ssh/authorized_keys`
 * is a perfectly ordinary string for a browser to send, and joining it to a directory is how an
 * upload endpoint becomes an arbitrary write. So the name is not sanitised — it is REBUILT: one
 * segment, from a known character set, with a length bound and an extension chosen from the part
 * after the last dot only if that part is itself plain.
 *
 * Pure and tested precisely because the failure is silent. A path-traversal that works produces no
 * error, and a test is the only thing that will ever notice.
 */

/** The characters a stored name may contain, after rebuilding. */
const SAFE = /[^A-Za-z0-9._-]+/g

/** Long enough to stay recognisable, short enough to stay inside every filesystem's limit. */
const MAX_STEM = 60
const MAX_EXT = 12

export interface SafeName {
  /** The name to write. Never empty, never a path, never `.` or `..`. */
  name: string
  /** True when the result is not what was asked for, so the caller can say so. */
  changed: boolean
}

/**
 * One filesystem-safe segment derived from an arbitrary client string.
 *
 * `id` is mixed in by the caller rather than here: two uploads of `notes.txt` must not collide, and
 * deciding that inside this function would make it non-deterministic and untestable.
 */
export function safeAttachmentName(raw: string): SafeName {
  // Every path separator, on every platform. A Windows client really does send backslashes.
  const lastSegment = raw.split(/[/\\]/).pop() ?? ''

  const dot = lastSegment.lastIndexOf('.')
  const rawStem = dot > 0 ? lastSegment.slice(0, dot) : lastSegment
  const rawExt = dot > 0 ? lastSegment.slice(dot + 1) : ''

  const stem = rawStem.replace(SAFE, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, MAX_STEM)
  const ext = rawExt.replace(SAFE, '').slice(0, MAX_EXT)

  // A name that reduced to nothing — `..`, `///`, a string of emoji — gets a neutral one rather
  // than being refused: the file is still what the user meant to send.
  const base = stem === '' ? 'file' : stem
  const name = ext === '' ? base : `${base}.${ext}`

  return { name, changed: name !== lastSegment || lastSegment !== raw }
}

/** The stored name, prefixed with an id so two uploads of one filename cannot collide. */
export function storedAttachmentName(raw: string, id: string): string {
  return `${id}-${safeAttachmentName(raw).name}`
}
