/**
 * composerStore.ts — a line the PANEL asks the composer to hold.
 *
 * The skills tab can invoke a skill, and invoking one is typing `/name` into the message box. The
 * panel and the composer are siblings — neither contains the other — so the ask travels through a
 * store, exactly as the artifacts panel's open state does.
 *
 * IT ASKS FOR A DRAFT, IT NEVER SENDS. What reaches a session is what the person pressed enter on:
 * a panel that could send would be a second way to write into a live assistant, and the whole
 * consent model here is that the composer is the one door.
 *
 * The `at` stamp is what makes it a REQUEST rather than a value — the same reason the artifacts
 * store carries one. Asking twice for the same skill is two requests, and the composer must obey
 * the second even though nothing about the text changed.
 */

import { useSyncExternalStore } from 'react'

export interface DraftRequest {
  /** Which session it is for. A request is never applied to a conversation it did not name. */
  sessionId: string
  /** Appended to whatever is already typed — never a replacement, see `applyDraftRequest`. */
  text: string
  /**
   * The request's IDENTITY, and it is a counter rather than a clock.
   *
   * `Date.now()` was the obvious choice and it is wrong here: two asks inside the same millisecond
   * carry the same number, and then `consumeDraftRequest` — which checks the stamp precisely so a
   * late consumer cannot clear a newer request — clears the newer one instead. A monotonic counter
   * cannot collide, and nothing about this field is a time anybody reads.
   */
  at: number
}

let request: DraftRequest | null = null
let seq = 0
const listeners = new Set<() => void>()

function emit(next: DraftRequest | null): void {
  request = next
  for (const l of listeners) l()
}

export function requestDraft(sessionId: string, text: string): void {
  seq += 1
  emit({ sessionId, text, at: seq })
}

export function getDraftRequest(): DraftRequest | null {
  return request
}

/**
 * The composer took it. CLEARS the request.
 *
 * Without this the store keeps the last ask forever, and the composer re-applies it on every
 * MOUNT — which is what navigating back to a session is. Reported as a skill appearing in the box
 * by itself, over and over: "toda hora ta spawnando aqui no input a skill de frontend SOZINHO".
 *
 * The stamp is checked so a late consumer cannot clear a NEWER request it never applied.
 */
export function consumeDraftRequest(at: number): void {
  if (request?.at === at) emit(null)
}

export function useDraftRequest(): DraftRequest | null {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => { listeners.delete(cb) } },
    () => request,
    () => null,
  )
}

/**
 * What the draft becomes.
 *
 * APPENDED, not replaced: a half-written message is somebody's work, and a panel that wipes it
 * would make the skills tab dangerous to touch. A separating space is added only when the draft
 * does not already end in whitespace, and never at the start of an empty draft.
 */
export function applyDraftRequest(draft: string, text: string): string {
  if (draft === '') return text
  return /\s$/.test(draft) ? draft + text : `${draft} ${text}`
}
