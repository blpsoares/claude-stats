/**
 * attachment-web.ts — attaching a file to a message sent from the dashboard.
 *
 * WHAT AN ATTACHMENT ACTUALLY IS HERE. The composer types a line into a tmux pane; there is no
 * channel through which a byte array could reach an assistant. What every one of these CLIs does
 * understand is a PATH — reading a file it is pointed at is the most ordinary thing they do. So an
 * attachment is written to this machine's disk and its path is what travels in the message.
 *
 * That is worth stating plainly in the UI too, because it is not what "attach" means in a chat
 * application: the file lands on the machine running the session, not inside the conversation.
 *
 * The write goes to ONE directory under `~/.agentistics`, which is agentop's own — the rule that
 * anything written outside its own directories is an explicit act of the user is not bent here. The
 * filename is REBUILT by the pure `attachment-name.ts` rather than sanitised, because a name from a
 * browser is attacker-controlled and joining it to a directory is how an upload becomes an
 * arbitrary write.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AGENTISTICS_DATA_DIR } from '../config'
import { storedAttachmentName } from './attachment-name'

/** Where uploads land. Inside agentop's own directory, never beside the user's project. */
export const ATTACHMENT_DIR = join(AGENTISTICS_DATA_DIR, 'attachments')

/**
 * Is `requested` actually inside `ATTACHMENT_DIR` — PURE, and the only thing standing between
 * "show this attachment back" and an arbitrary local file read.
 *
 * A message's text carries the attachment's own path VERBATIM (that is what an attachment IS
 * here — see the module header), so the read endpoint has to accept a path, not just a bare name.
 * `resolve()` collapses every `..`/`.`/doubled separator BEFORE the prefix check, so a request for
 * `ATTACHMENT_DIR/../../.ssh/id_rsa` resolves to a path that no longer starts with `ATTACHMENT_DIR`
 * and is refused — checking the prefix on the RAW string first would miss exactly that case.
 */
export function resolveAttachmentRead(requested: string): string | null {
  if (requested === '') return null
  const base = resolve(ATTACHMENT_DIR) + sep
  const resolved = resolve(requested)
  return resolved.startsWith(base) ? resolved : null
}

/**
 * ONE stored attachment, named the way it is stored — PURE, and the whole security model of
 * `GET /api/fleet/attachment/by-name`.
 *
 * This is the NARROWER twin of `resolveAttachmentRead`. That one has to accept a whole path,
 * because a message carries the attachment's path verbatim and the chat shows it back from the
 * message. The GALLERY does not need that: it is a grid of this directory's own files, so it can
 * ask by NAME, and a name that is a single segment cannot express a traversal at all — there is no
 * `resolve()` race to reason about, and no way for the answer to land outside `ATTACHMENT_DIR`.
 *
 * The accepted set is exactly what `storedAttachmentName` produces: one segment of
 * `[A-Za-z0-9._-]`. Anything this machine could not itself have written is refused, which is a
 * stronger statement than "contains no separator" and costs nothing — the names are minted here.
 * The separator, NUL and dot-segment cases are still checked and named, because they are the ones a
 * reader comes here to check for.
 */
export function attachmentPathByName(name: string): string | null {
  if (name === '' || name.length > 200) return null
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null
  if (name === '.' || name === '..') return null
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null
  return join(ATTACHMENT_DIR, name)
}

/**
 * The content type to serve a stored attachment as, or `null` when it is not an image — PURE.
 *
 * The route serves IMAGES and refuses everything else, which is what stops a gallery preview route
 * becoming a general reader of agentop's own directory. The type is read off the EXTENSION and
 * never sniffed: the answer must be decidable before anything is opened, and it is paired with
 * `nosniff` on the response so the browser cannot decide differently.
 *
 * The set matches the browser side's `isImageAttachment` deliberately, SVG included — a preview the
 * client believes exists and the server refuses is a broken image, which is the one thing the panel
 * may not show. SVG is a document that can carry script, so its response additionally carries a
 * `sandbox` CSP for the case where somebody opens the URL directly; inside an `<img>` an SVG's
 * script never runs.
 */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
}

export function attachmentImageType(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return IMAGE_TYPES[name.slice(dot + 1).toLowerCase()] ?? null
}

/**
 * The ceiling on one upload.
 *
 * Generous enough for a screenshot or a log, far below anything that would make writing it a
 * problem. The transport enforces its own limit as well; this is the one that decides what this
 * feature is for.
 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

export interface AttachmentResult {
  ok: boolean
  /** The absolute path to reference in a message. Present only on success. */
  path?: string
  /** The stored name, for the chip in the composer. */
  name?: string
  /** Already-localized. Always present on failure, and on a name that had to be rewritten. */
  message?: string
}

export async function storeAttachment(
  lang: 'pt' | 'en',
  file: { name: string; bytes: Uint8Array },
): Promise<AttachmentResult> {
  const pt = lang === 'pt'

  if (file.bytes.byteLength === 0) {
    return { ok: false, message: pt ? 'O arquivo está vazio.' : 'The file is empty.' }
  }
  if (file.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    const mb = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))
    return {
      ok: false,
      message: pt
        ? `O arquivo passa do limite de ${mb} MB para anexos.`
        : `The file is over the ${mb} MB attachment limit.`,
    }
  }

  const name = storedAttachmentName(file.name, randomBytes(4).toString('hex'))
  const path = join(ATTACHMENT_DIR, name)

  try {
    await mkdir(ATTACHMENT_DIR, { recursive: true })
    // 0600: an attachment can be anything the user had open, and the directory is shared by every
    // session on this machine.
    await writeFile(path, file.bytes, { mode: 0o600 })
  } catch {
    return {
      ok: false,
      message: pt
        ? 'Não foi possível gravar o anexo nesta máquina.'
        : 'The attachment could not be written on this machine.',
    }
  }

  return { ok: true, path, name }
}
