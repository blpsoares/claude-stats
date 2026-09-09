/**
 * pickerKeys.ts — PURE: which keypress takes the highlighted entry out of a composer picker.
 *
 * BOTH pickers answer it, so it is one rule rather than two. The `/` list and the `@` list are
 * different menus over different things, and a key that worked in one and not the other would be
 * discovered by trying — which is how the verbs in the cockpit ended up needing a reference card.
 *
 * ENTER AND TAB BOTH SELECT. Enter was the only one, and Tab is what a completion list has trained
 * everybody's fingers to press — asked for directly. They are the same gesture here.
 *
 * SHIFT IS THE WAY OUT, and it is why `shiftKey` is checked rather than ignored. Once Tab picks an
 * entry, a keyboard user has no Tab left to leave the field with; `shift+tab` still moves focus
 * backwards, and Escape still closes the picker and gives every key back. A picker that could only
 * be left with a mouse is one a keyboard cannot leave.
 *
 * ENTER ALONE IS GATED ON MOBILE, and Tab is not. On a touch keyboard the return key breaks the
 * line — that is the convention every messaging app follows and this composer already keeps — so
 * Enter must not be stolen there. A soft keyboard rarely has a Tab at all, and where it does it is
 * not the line-break key, so nothing is taken from anybody by letting it select.
 */

export interface PickerKey {
  key: string
  shiftKey: boolean
  /** Whether the composer is on a touch layout, where the return key breaks the line. */
  isMobile: boolean
}

export function isPickerSelectKey(e: PickerKey): boolean {
  if (e.shiftKey) return false
  if (e.key === 'Tab') return true
  return e.key === 'Enter' && !e.isMobile
}
