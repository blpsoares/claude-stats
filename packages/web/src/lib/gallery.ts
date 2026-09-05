/**
 * gallery.ts — PURE: the files the PERSON SENT, grouped by the message that carried them.
 *
 * THE GALLERY IS NOT THE ARTIFACTS. `sessionArtifacts.ts` answers "what did this session WRITE";
 * this answers "what did I SEND it". They are opposite directions and share nothing but the panel
 * they are drawn in — a screenshot pasted into the composer is not a file the assistant produced,
 * and filing it under Files would be a claim about the session's work that nobody made.
 *
 * THE GROUPING IS THE FEATURE. Several images routinely go up in one message — three screenshots of
 * one broken layout — and a flat wall of thumbnails loses the one thing that makes them readable:
 * that they were sent TOGETHER, about the same thing, with the same sentence under them. So the
 * unit here is the MESSAGE, not the file, and every list in the panel is a list of messages whose
 * rows happen to be files.
 *
 * WHAT AN ATTACHMENT IS is decided by `messageAttachments.ts` and nothing here re-derives it: the
 * composer types a line into a tmux pane, so a sent message is attachment paths on their own
 * leading lines followed by the typed text, and `splitMessage` is the one rule that takes them
 * apart. WHO SENT IT is decided by `lastSent.ts`'s `isPersonMessage`, for the same reason it exists
 * there: the transcript files background tasks, injected reminders and `!` command output under the
 * user's own role, and a gallery of "what I sent" that included those would be showing somebody
 * their own avatar over something they never wrote.
 *
 * IT ONLY READS THE COMMITTED TRANSCRIPT. A message still in flight (the chat's `echo` list) is
 * deliberately absent: it lands in the transcript within a poll or two and arrives here then, and
 * an entry that cannot be anchored to a rendered turn is one whose "go to the message" has nowhere
 * to go.
 */

import { isPersonMessage, type SentTurn } from './lastSent'
import { attachmentName, isImageAttachment, splitMessage } from './messageAttachments'

/** The one field beyond `SentTurn` this module reads. Structural — it imports no view. */
export type GalleryTurn = SentTurn & { at?: string }

/** One file, as it was sent. */
export interface GalleryFile {
  /** The absolute path the message carried. The identity — the URL is built from its name. */
  path: string
  /** The file's own name, which is what a row shows. */
  name: string
  /**
   * Can a preview exist AT ALL — decided by extension, which is what can be known without the
   * bytes. False is not a failure: it means the row shows a name and says so, rather than a broken
   * image where a thumbnail was promised.
   */
  image: boolean
  /** The extension, uppercased, for the FORMAT column. `''` when the name carries none. */
  format: string
  /** Where the bytes come from — see `GalleryOrigin`. Absent reads as `sent` (every older group). */
  origin?: GalleryOrigin
}

/** One message, and the files it carried. */
/**
 * WHERE a gallery row's bytes come from.
 *
 * `sent` files are attachments in `~/.agentistics/attachments`, addressed by NAME through the
 * attachment route. `produced` files are ones the SESSION wrote — a screenshot, a diagram, a PDF —
 * which live wherever the session put them and are addressed by PATH through `/api/fleet/media`,
 * behind the same allowlist the file tab reads through.
 *
 * The distinction is on the FILE and not on the group because a reader is asking "what images are
 * in this conversation", not "which route serves them" — but a `<img src>` needs the answer, and
 * guessing it from the path would break the moment somebody attaches a file from outside the
 * attachments folder.
 */
export type GalleryOrigin = 'sent' | 'produced'

export interface GalleryGroup {
  /**
   * The message's position in the turns list.
   *
   * This is what `turnAnchorId('turn', index)` is built from, which is the whole reason it is
   * carried: "go to the message" resolves an element id, and an index from any other list would
   * resolve to a different bubble.
   */
  index: number
  /** When the transcript recorded the turn, ISO. Absent on a transcript that carries none. */
  at?: string
  /** What the person typed, with the attachment lines removed. `''` when they typed nothing. */
  text: string
  /** In the order they were attached. Never empty — a message with none is not a group. */
  files: GalleryFile[]
}

/** The extension, uppercased. `''` when there is none — never invented from the bytes. */
export function fileFormat(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toUpperCase()
}

/**
 * Every message that carried a file, in the transcript's own order.
 *
 * A message with words and no files is absent entirely — it is a message, not a gallery entry. A
 * message with files and no words is present with `text: ''`: the files ARE the message, and
 * dropping it because nobody typed anything would hide the sends most likely to be a screenshot
 * dropped in without comment.
 *
 * The same file sent in two messages yields two entries. They were sent twice, at two moments,
 * about two things; collapsing them would answer a question about the DISK when the question here
 * is about the conversation.
 */
export function galleryGroups(turns: readonly GalleryTurn[]): GalleryGroup[] {
  const out: GalleryGroup[] = []
  turns.forEach((turn, index) => {
    if (!isPersonMessage(turn)) return
    const { attachments, text } = splitMessage(turn.text)
    if (attachments.length === 0) return
    const files = attachments.map(path => {
      const name = attachmentName(path)
      return {
        path, name, image: isImageAttachment(path), format: fileFormat(name),
        origin: 'sent' as const,
      }
    })
    out.push(turn.at ? { index, at: turn.at, text, files } : { index, text, files })
  })
  return out
}

/** One image in the flat run the lightbox steps through, and the message it came in. */
export interface GalleryImage {
  path: string
  group: GalleryGroup
  /**
   * WHICH file this is, not which path — `<message>:<position in that message>`.
   *
   * The identity has to survive the same file being sent twice: matching on the path alone made
   * clicking the second copy open the first, because two entries legitimately share it. Built by
   * `galleryImageKey` so the caller and this list can never disagree about the spelling.
   */
  key: string
}

/** The identity of one file within one message. See `GalleryImage.key`. */
export function galleryImageKey(groupIndex: number, fileIndex: number): string {
  return `${groupIndex}:${fileIndex}`
}

/**
 * Every previewable image, flattened, in reading order.
 *
 * The lightbox's scope is the WHOLE gallery rather than one message — unlike the chat's, which is
 * scoped to the turn that opened it. In the chat you are reading a conversation and a jump to some
 * other message's picture answers a question nobody asked; here you are looking at the pictures,
 * and "the next one" plainly means the next one on the screen.
 *
 * Non-image files are absent: there is nothing to show large, and a lightbox that stepped onto one
 * would be a black rectangle with a filename.
 */
export function galleryImages(groups: readonly GalleryGroup[]): GalleryImage[] {
  const out: GalleryImage[] = []
  for (const group of groups) {
    group.files.forEach((file, i) => {
      if (file.image) out.push({ path: file.path, group, key: galleryImageKey(group.index, i) })
    })
  }
  return out
}

/** How many files the gallery holds, for the tab's count. */
export function galleryFileCount(groups: readonly GalleryGroup[]): number {
  return groups.reduce((n, g) => n + g.files.length, 0)
}

/**
 * A byte count, in the shortest form that is still true — and `''` when there is no count.
 *
 * The empty string is the point: a size this panel could not obtain is shown as NOTHING, never as
 * `0 B` or `—`. A zero is a measurement and would be a confident wrong one; the same rule the
 * context gauge follows when it cannot know a window.
 */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/** LIST reads, GRID looks. Both show the same rows under the same message headings. */
export type GalleryView = 'list' | 'grid'

/**
 * The remembered view, from whatever was in storage.
 *
 * GRID is the default because that is what a gallery is: the pictures are the content, and a panel
 * that opens on a column of filenames makes the reader press something before they can see
 * anything. Anything unrecognised — a value from a future version, a corrupted key, `null` from a
 * private window — reads as the default rather than throwing, which is the same call every other
 * remembered preference in this workspace makes.
 */
export function parseGalleryView(raw: string | null): GalleryView {
  return raw === 'list' ? 'list' : 'grid'
}

/** What the right-click on an image offers. The shape `SessionRowMenu` already renders. */
export interface GalleryMenuEntry {
  action: 'goto' | 'view' | 'cancel'
  label: string
  enabled: boolean
}

/**
 * The three options, in the composer recall modal's own order and words.
 *
 * EXACTLY three, and the same three, because there are exactly three things somebody pointing at a
 * picture wants: to be taken to the message it came in, to read that message here, or to have asked
 * nothing. A fourth would be a different feature; a different wording would be a second vocabulary
 * for one gesture.
 */
export function galleryMenuEntries(pt: boolean, group?: { index: number }): GalleryMenuEntry[] {
  // A PRODUCED file has no message behind it — the session wrote it, nobody sent it — so the two
  // entries that name one are ABSENT rather than present and refusing. `index: -1` is how
  // `producedGroups` says so, and a `goto` on it would scroll to whatever turn -1 resolves to.
  const hasMessage = group === undefined || group.index >= 0
  return [
    ...(hasMessage
      ? [
        { action: 'goto' as const, label: pt ? 'Ir para a mensagem' : 'Go to message', enabled: true },
        { action: 'view' as const, label: pt ? 'Ver mensagem' : 'View message', enabled: true },
      ]
      : []),
    { action: 'cancel' as const, label: pt ? 'Cancelar' : 'Cancel', enabled: true },
  ]
}


/** Extensions the media route serves. Mirrors `artifact-media.ts`'s table — see the note below. */
const PRODUCED_IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'])
const PRODUCED_OTHER = new Set(['pdf'])

/**
 * What the SESSION produced, as gallery groups.
 *
 * Asked for directly: "na galeria tbm devem ter as suas imagens, quando vc gerar imagens, tirar
 * prints, gerar pdfs e etc". Until now the gallery was only what a person ATTACHED, so a screenshot
 * the assistant took could be found in the files tab and nowhere a person would look for a picture.
 *
 * ONE GROUP, not one per message, and that is a difference from the sent side rather than an
 * oversight: a sent group is a MESSAGE — the text that came with the files is what names it — while
 * a produced file has no message of its own, only the turn that wrote it. Grouping by turn would
 * make a row per file with no heading worth reading. They are ordered as the transcript wrote them,
 * newest LAST, matching the live feed.
 *
 * The extension table is duplicated from the server's `artifact-media.ts` on purpose: the web
 * bundle cannot import from `packages/server`, and the failure mode of a drift is visible and
 * harmless — a file listed here that the route refuses shows its refusal in the lightbox, which is
 * the same sentence it would have shown anyway.
 */
export function producedGroups(
  artifacts: readonly { path: string; name: string }[],
): GalleryGroup[] {
  const files = artifacts
    .map(a => {
      const dot = a.name.lastIndexOf('.')
      const ext = dot > 0 ? a.name.slice(dot + 1).toLowerCase() : ''
      return { a, ext }
    })
    .filter(({ ext }) => PRODUCED_IMAGE.has(ext) || PRODUCED_OTHER.has(ext))
    .map(({ a, ext }) => ({
      path: a.path,
      name: a.name,
      image: PRODUCED_IMAGE.has(ext),
      format: ext.toUpperCase(),
      origin: 'produced' as const,
    }))
  // `index: -1` is deliberate and is READ: there is no message to go to, so the "recall the
  // message" verb must be absent rather than scrolling to whatever turn -1 resolves to.
  return files.length === 0 ? [] : [{ index: -1, text: '', files }]
}


/** Which half of the gallery is being shown. */
export type GalleryScope = 'all' | 'user' | 'llm'

/** A stored scope, or `all` for anything this code did not write. */
export function parseGalleryScope(raw: string | null): GalleryScope {
  return raw === 'user' || raw === 'llm' ? raw : 'all'
}

/**
 * How many files each side holds — what decides whether the switch is even drawn.
 *
 * A three-way control where two of the options are empty is a control that mostly refuses. It is
 * shown only when BOTH sides have something, which is the same rule the Chat/Terminal toggle keeps:
 * a segmented control with one real option is a label pretending to be a control.
 */
export function gallerySides(groups: readonly GalleryGroup[]): { user: number; llm: number } {
  let user = 0
  let llm = 0
  for (const g of groups) {
    for (const f of g.files) {
      if (f.origin === 'produced') llm += 1
      else user += 1
    }
  }
  return { user, llm }
}

/**
 * The scope that is actually APPLIED, given what each side holds.
 *
 * A stored scope outlives the files it was chosen for. `llm` was picked while the session had
 * produced something; the files were later removed, the switch stopped being drawn — it is only
 * drawn when BOTH sides have something — and the gallery showed `11` on its tab and `0 messages`
 * in its body, with no control on screen to get back. Reported as exactly that.
 *
 * So a scope whose side is EMPTY falls back to `all`. The rule to hold onto: a filter whose control
 * is not on screen must never be able to hide everything. The stored value is left alone — the side
 * may come back, and the choice was real.
 */
export function effectiveScope(
  scope: GalleryScope, sides: { user: number; llm: number },
): GalleryScope {
  if (scope === 'llm' && sides.llm === 0) return 'all'
  if (scope === 'user' && sides.user === 0) return 'all'
  return scope
}

/**
 * The groups a scope shows.
 *
 * Filtered per FILE and not per group, because nothing stops a future group from holding both —
 * and a group left with no files is dropped rather than rendered as a heading over nothing.
 */
export function filterGallery(
  groups: readonly GalleryGroup[], scope: GalleryScope,
): GalleryGroup[] {
  if (scope === 'all') return [...groups]
  const want = scope === 'llm' ? 'produced' : 'sent'
  return groups
    .map(g => ({ ...g, files: g.files.filter(f => (f.origin ?? 'sent') === want) }))
    .filter(g => g.files.length > 0)
}
