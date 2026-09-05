/**
 * sessionScratch.ts — what survives leaving a conversation and coming back.
 *
 * Two things did not, and both were reported:
 *
 *   1. "as conversas que eu ja abri, se eu saio e volto elas sao recarregadas novamente" — the chat
 *      view holds its payload in component state, so navigating away destroys it and returning
 *      paints an empty column until a fetch completes. The data is on this machine; the wait is
 *      pure ceremony.
 *   2. "se eu comeco a digitar aqui e vou pra outra pagina, eu perco todo o prompt que eu escrevi" —
 *      the composer's draft is component state too. Losing typed words to a click is the worst
 *      thing a text field can do, and it is the one thing here that CANNOT be recovered from the
 *      server: a conversation re-fetches, a paragraph the person wrote does not exist anywhere
 *      else.
 *
 * They get DIFFERENT storage, because they are different kinds of thing:
 *
 * - A DRAFT is the person's own words and nothing else has a copy, so it goes to `sessionStorage`
 *   and survives a reload as well as a navigation. Per tab, deliberately: two tabs open on one
 *   session are two people composing, and merging their keystrokes is not a feature.
 * - A CONVERSATION is a CACHE of something the server will hand back on request, so it stays in
 *   memory. Writing hundreds of turns per session into `sessionStorage` would spend a real quota
 *   on bytes that are one fetch away, and quota errors are silent in exactly the browsers where
 *   they happen.
 *
 * THE CACHED CONVERSATION IS NEVER THE ANSWER, only the first paint. The poll fires on mount as it
 * always did and replaces it; the cache removes the blank column in front of it, and nothing more.
 * That is why there is no staleness rule here — a cache whose maximum age is one request does not
 * need one.
 *
 * Every read and write is wrapped: `sessionStorage` THROWS on access in a browser set to block
 * site data, not merely returns null, and a composer that cannot be typed into because storage is
 * off would be a far worse bug than the one this fixes.
 */

import { parseReply, type ReplyTarget } from './replyQuote'

/** The shape this module keeps for a conversation. Structural, so it never imports the chat view. */
export interface CachedChat {
  turns: unknown[]
  live?: boolean
  unavailable?: string
}

/** A `Storage`-shaped dependency, so the behaviour is testable without a browser. */
export interface ScratchStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * How many conversations stay in memory.
 *
 * A fleet here routinely holds forty rows and a long conversation is hundreds of turns, so an
 * unbounded map is a leak that grows with how much of the product you use. Ten is what a person
 * moves between in one sitting; the eleventh costs exactly what it cost before this file existed.
 */
export const MAX_CACHED_CHATS = 10

/** `sessionStorage` key for one session's draft. Namespaced so nothing else can collide with it. */
export function draftKey(id: string): string {
  return `agentistics:draft:${id}`
}

/** …and for the files attached to that unsent message. */
export function attachKey(id: string): string {
  return `agentistics:attached:${id}`
}

/** …and for the message that unsent one is a REPLY to. */
export function replyKey(id: string): string {
  return `agentistics:reply:${id}`
}

/** …and for messages SENT but not yet visible in the transcript. */
export function echoKey(id: string): string {
  return `agentistics:echo:${id}`
}

/**
 * One attached file, as the composer holds it: a NAME to show and a PATH the assistant can read.
 *
 * The bytes are already on this machine — the upload happened when the file was dropped — so what
 * is kept here is a reference, not a payload. That is what makes attachments cheap to persist
 * beside the draft they belong to: two short strings, not an image.
 */
export interface ScratchAttachment { name: string; path: string }

/** Parse a stored echo list, keeping only non-empty strings. Same reasoning as `parseAttachments`. */
export function parseEchoes(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.filter((x): x is string => typeof x === 'string' && x !== '')
  } catch { return [] }
}

/**
 * Parse a stored attachment list, keeping only entries that are actually usable.
 *
 * Storage is a string somebody else's code can also write, and a half-read entry here becomes a
 * chip pointing at a path that resolves to nothing — the assistant is then told to read a file
 * that is not there. Anything that is not a `{name, path}` pair of non-empty strings is dropped.
 */
export function parseAttachments(raw: string | null): ScratchAttachment[] {
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return []
    return v.flatMap(x => {
      if (typeof x !== 'object' || x === null) return []
      const { name, path } = x as Record<string, unknown>
      return typeof name === 'string' && name !== '' && typeof path === 'string' && path !== ''
        ? [{ name, path }]
        : []
    })
  } catch { return [] }
}

/**
 * Insert into a bounded, least-recently-USED-first map.
 *
 * Pure, and it re-inserts on every write so touching a conversation keeps it: a plain size check
 * would evict by insertion order and drop the very conversation somebody is switching back and
 * forth with. Returns a NEW map — the caller holds the only reference and mutation would make the
 * eviction order depend on read paths.
 */
export function capChats(
  map: ReadonlyMap<string, CachedChat>,
  id: string,
  chat: CachedChat,
  max: number = MAX_CACHED_CHATS,
): Map<string, CachedChat> {
  const next = new Map(map)
  next.delete(id)
  next.set(id, chat)
  while (next.size > max) {
    const oldest = next.keys().next()
    if (oldest.done) break
    next.delete(oldest.value)
  }
  return next
}

export interface SessionScratch {
  /**
   * Messages that were DELIVERED and have not appeared in the transcript yet.
   *
   * The chat draws them faded, and retires each one the moment the transcript carries the same
   * text. They were component state, so leaving the page threw them away — and a long message sent
   * to a busy session can sit unretired for minutes, which made it look like the message had
   * vanished. It had not; the only record of it had.
   *
   * This is the one piece of scratch that is neither a draft nor a cache: the text is no longer
   * the person's to edit, and it is not something the server will hand back on request — until the
   * harness writes it down, this is the ONLY copy. So it is kept like a draft, in storage, and
   * dropped only by the transcript catching up.
   */
  readEchoes(id: string): string[]
  writeEchoes(id: string, texts: readonly string[]): void
  readDraft(id: string): string
  writeDraft(id: string, text: string): void
  clearDraft(id: string): void
  readAttachments(id: string): ScratchAttachment[]
  writeAttachments(id: string, files: readonly ScratchAttachment[]): void
  /**
   * The turn the unsent message is a REPLY to.
   *
   * Kept beside the draft, and for the draft's own reason: the reply target CHANGES WHAT IS SENT —
   * `quoteLines` prepends it — so restoring the words without it sends a different message from
   * the one that was composed. That is the same half-restore the attachments above exist to
   * prevent, reported as exactly that.
   *
   * It is safe to keep because it is TEXT, not a pointer: the quote is a copy of what the turn
   * said, so it does not have to resolve against a transcript that has since been re-fetched. And
   * it is per session id, so it can never surface over another conversation.
   */
  readReply(id: string): ReplyTarget | null
  writeReply(id: string, target: ReplyTarget | null): void
  readChat(id: string): CachedChat | null
  writeChat(id: string, chat: CachedChat): void
}

/** Build a scratch over any storage. `null` storage yields drafts that work only in memory. */
export function createSessionScratch(store: ScratchStore | null): SessionScratch {
  let chats: ReadonlyMap<string, CachedChat> = new Map()
  // The in-memory fallback for a browser that refuses storage: a draft still survives NAVIGATION
  // (this module outlives the component), it simply does not survive a reload. Degrading to "less
  // durable" is right; degrading to "the field eats your words" is not.
  const memoryDrafts = new Map<string, string>()
  const memoryAttached = new Map<string, ScratchAttachment[]>()
  const memoryEchoes = new Map<string, string[]>()
  const memoryReply = new Map<string, ReplyTarget>()

  return {
    readDraft(id) {
      if (store) {
        try {
          const v = store.getItem(draftKey(id))
          if (v !== null) return v
        } catch { /* storage blocked — fall through to memory */ }
      }
      return memoryDrafts.get(id) ?? ''
    },
    writeDraft(id, text) {
      // An empty draft is a REMOVAL, not a stored empty string: leaving one behind means the next
      // read cannot tell "they cleared it" from "they never typed", and it spends quota forever.
      if (text === '') { this.clearDraft(id); return }
      memoryDrafts.set(id, text)
      if (store) {
        try { store.setItem(draftKey(id), text) } catch { /* quota or blocked — memory still has it */ }
      }
    },
    clearDraft(id) {
      memoryDrafts.delete(id)
      if (store) {
        try { store.removeItem(draftKey(id)) } catch { /* nothing to do about it */ }
      }
    },
    /**
     * The files attached to the unsent message. Kept with the draft and for the same reason: an
     * attachment IS part of what somebody composed, and restoring the words while dropping the
     * image is a half-restore that reads as a bug — reported exactly that way.
     */
    readAttachments(id) {
      if (store) {
        try {
          // Only a PRESENT value wins. Returning `parseAttachments(null)` here would answer "no
          // attachments" out of a store that simply never accepted the write — shadowing the memory
          // copy that does have them, which is the failure mode a throwing `setItem` produces.
          const raw = store.getItem(attachKey(id))
          if (raw !== null) return parseAttachments(raw)
        } catch { /* storage blocked — fall through to memory */ }
      }
      return memoryAttached.get(id) ?? []
    },
    writeAttachments(id, files) {
      if (files.length === 0) {
        memoryAttached.delete(id)
        if (store) { try { store.removeItem(attachKey(id)) } catch { /* nothing to do */ } }
        return
      }
      const list = files.map(f => ({ name: f.name, path: f.path }))
      memoryAttached.set(id, list)
      if (store) {
        try { store.setItem(attachKey(id), JSON.stringify(list)) } catch { /* memory still has it */ }
      }
    },
    readReply(id) {
      if (store) {
        try {
          const raw = store.getItem(replyKey(id))
          if (raw !== null) return parseReply(raw)
        } catch { /* storage blocked — fall through to memory */ }
      }
      return memoryReply.get(id) ?? null
    },
    writeReply(id, target) {
      if (target === null) {
        memoryReply.delete(id)
        if (store) { try { store.removeItem(replyKey(id)) } catch { /* nothing to do */ } }
        return
      }
      const value = { role: target.role, text: target.text }
      memoryReply.set(id, value)
      if (store) {
        try { store.setItem(replyKey(id), JSON.stringify(value)) } catch { /* memory still has it */ }
      }
    },
    readEchoes(id) {
      if (store) {
        try {
          const raw = store.getItem(echoKey(id))
          if (raw !== null) return parseEchoes(raw)
        } catch { /* storage blocked — fall through to memory */ }
      }
      return memoryEchoes.get(id) ?? []
    },
    writeEchoes(id, texts) {
      if (texts.length === 0) {
        memoryEchoes.delete(id)
        if (store) { try { store.removeItem(echoKey(id)) } catch { /* nothing to do */ } }
        return
      }
      const list = [...texts]
      memoryEchoes.set(id, list)
      if (store) {
        try { store.setItem(echoKey(id), JSON.stringify(list)) } catch { /* memory still has it */ }
      }
    },
    readChat(id) {
      return chats.get(id) ?? null
    },
    writeChat(id, chat) {
      chats = capChats(chats, id, chat)
    },
  }
}

/** The one instance the app uses. Built against `sessionStorage` where there is one. */
export const sessionScratch: SessionScratch = createSessionScratch(
  typeof globalThis !== 'undefined' && 'sessionStorage' in globalThis
    ? (globalThis as unknown as { sessionStorage: ScratchStore }).sessionStorage
    : null,
)
