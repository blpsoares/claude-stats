/**
 * shellKeys.ts — PURE. The mobile key strip, and what `ctrl` does on a phone.
 *
 * A soft keyboard has no `esc`, no `tab` and no arrow keys at all — the cockpit already records the
 * last of those — so without this strip there is no way to leave `vim`, complete a path, or reach
 * the shell's history from a phone, and NO Ctrl+C at all. That is the whole reason the strip exists:
 * `esc tab ctrl ↑ ↓ ← →`, sitting above the system keyboard.
 *
 * `ctrl` is the only entry that sends nothing of its own. It is a STICKY MODIFIER: tap it, then type
 * a letter, and the letter becomes the control key instead. That is the only shape a soft keyboard
 * admits — there is no chord to hold — and it is why `ctrlKeyFor` exists rather than a row of
 * pre-composed `C-c` / `C-d` buttons: the letters worth reaching are the shell's, not a list this
 * module could guess.
 *
 * It answers `null` for a letter the channel does not accept rather than composing one it will
 * refuse. `C-z` (suspend) and `C-\` (SIGQUIT) are outside `KEY_ALLOWLIST` on purpose, and sending
 * one would earn a `bad_key` ack for a keystroke the person had every reason to expect to work —
 * the strip says so instead, which is the honest half of the same refusal.
 */

import type { NamedKey } from './terminalKeys'

export type StripEntry =
  /** Sends one named key, directly. */
  | { id: string; kind: 'key'; key: NamedKey }
  /** Arms the control modifier for the NEXT character typed. Sends nothing itself. */
  | { id: string; kind: 'modifier' }

/** The strip, in the order the design names it. */
export const SHELL_STRIP: readonly StripEntry[] = [
  { id: 'esc', kind: 'key', key: 'Escape' },
  { id: 'tab', kind: 'key', key: 'Tab' },
  { id: 'ctrl', kind: 'modifier' },
  { id: 'up', kind: 'key', key: 'Up' },
  { id: 'down', kind: 'key', key: 'Down' },
  { id: 'left', kind: 'key', key: 'Left' },
  { id: 'right', kind: 'key', key: 'Right' },
]

const LABELS: Record<string, string> = {
  esc: 'esc', tab: 'tab', ctrl: 'ctrl',
  up: '↑', down: '↓', left: '←', right: '→',
}

/** What the button reads. A glyph where one exists, the word where it does not — never an id. */
export function stripKeyLabel(id: string): string {
  return LABELS[id] ?? id
}

/**
 * The control keys `KEY_ALLOWLIST` accepts, by the letter that composes them. Mirrored from the
 * server's own closed set for the reason `MAX_TEXT_PER_MESSAGE` is mirrored: so the client does not
 * ASK for what will be refused.
 */
const CTRL: Record<string, NamedKey> = {
  a: 'C-a', c: 'C-c', d: 'C-d', e: 'C-e', k: 'C-k', u: 'C-u', w: 'C-w',
}

/** The named key `ctrl` + this character makes, or `null` when the channel would refuse it. */
export function ctrlKeyFor(char: string): NamedKey | null {
  if (char.length !== 1) return null
  return CTRL[char.toLowerCase()] ?? null
}

/**
 * The raw bytes a real keypress would have produced for one named key.
 *
 * The strip deliberately gets NO private send path. It produces these bytes and hands them to the
 * same `send` an actual keystroke goes through, so `splitInput`'s allowlist judges a strip press
 * exactly as it judges a typed one — a key it would refuse cannot reach the wire by a side door,
 * and there is one classifier rather than two that must agree.
 */
const BYTES: Record<NamedKey, string> = {
  Enter: '\r',
  BSpace: '\x7f',
  Tab: '\t',
  Escape: '\x1b',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Left: '\x1b[D',
  Right: '\x1b[C',
  'C-c': '\x03',
  'C-d': '\x04',
  'C-a': '\x01',
  'C-e': '\x05',
  'C-u': '\x15',
  'C-w': '\x17',
  'C-k': '\x0b',
}

export function keyBytes(key: NamedKey): string {
  return BYTES[key]
}
