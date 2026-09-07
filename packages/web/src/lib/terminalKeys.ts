/**
 * terminalKeys.ts — the pure control-key ALLOWLIST for the direct-typing terminal (Phase 2b).
 *
 * The #269 composer (`terminalInput.ts`) delivers a whole cooked LINE through the one write verb the
 * server exposed then (`sendText`, which always appends Enter). Phase 2b adds RAW, per-keystroke
 * typing: xterm's `onData` fires a chunk per key, and each chunk must be turned into an intent the
 * new server keystroke channel understands. Two things are decided here, and only here:
 *
 *   1. WHICH keys reach the process (assignment decision #2). A key that interrupts or alters the
 *      process on the other side is a SECURITY decision, not a convenience — so this is an
 *      ALLOWLIST, never a blocklist: only what we recognize is forwarded, and everything else is
 *      `blocked` and MUST NOT be echoed as delivered (the honesty rule the #269 line composer and
 *      A6 both turn on, now at keystroke scale).
 *   2. HOW each allowed key routes. The server exposes two distinct paths (fixed as obligations by
 *      the coordinator, shape by Victor's server dispatch): printable content goes as LITERAL text
 *      (`tmux send-keys -l`, no Enter); a named control/navigation key goes through the named-key
 *      path (`sendKeysNamedArgs`, e.g. `C-c`). They can never be the same call — literal `-l` types
 *      the bytes, `C-c` interrupts. `classifyInput` is what tells the two apart, so it is
 *      transport-shape-independent: whatever wire format the WS settles on, the client asks this
 *      module "text or named key?" first.
 *
 * The allowlist's dividing line: "edits the line" passes; "controls the process" is refused unless
 * explicitly requested. So it admits printable text, Enter, BSpace, Tab, the four arrows, the
 * line-editing controls (Ctrl+A/E cursor, Ctrl+U/W/K kill line/word/to-end — none touch the
 * process), and the two process-control keys the assignment does request (Ctrl+C for A7's interrupt,
 * Ctrl+D for EOF). Everything else is refused: other process-control C0 keys (Ctrl+Z suspend, Ctrl+\
 * SIGQUIT) and every unmapped escape sequence (function keys, mouse, bracketed-paste). Widening it
 * again is a deliberate security choice with a reason, which is exactly why the default is "no".
 *
 * Everything here is pure so the allowlist is pinned by `terminalKeys.test.ts`, not by the JSX.
 */

/** The named keys the server keystroke channel accepts (tmux `send-keys` key names). */
export type NamedKey =
  | 'Enter' | 'BSpace' | 'Tab' | 'Up' | 'Down' | 'Left' | 'Right'
  | 'C-c' | 'C-d' // process control — explicitly requested (A7 / EOF)
  | 'C-a' | 'C-e' | 'C-u' | 'C-w' | 'C-k' // line editing — "edits the line" passes

/** Why an input chunk was refused. `empty` is a no-op; `unsupported-sequence` is "not in the allowlist". */
export type BlockReason = 'empty' | 'unsupported-sequence'

/**
 * The classification of one `onData` chunk.
 * - `text`  — printable content, sent LITERALLY (no Enter appended).
 * - `key`   — a single named control/navigation key.
 * - `blocked` — refused; nothing is sent and nothing may be shown as delivered.
 */
export type KeyIntent =
  | { kind: 'text'; text: string }
  | { kind: 'key'; key: NamedKey }
  | { kind: 'blocked'; reason: BlockReason }

/** Exact single-chunk → named-key matches (control bytes and short escape sequences). */
const NAMED: Readonly<Record<string, NamedKey>> = {
  '\r': 'Enter',
  '\n': 'Enter',
  '\x7f': 'BSpace', // DEL — what most terminals send for Backspace
  '\x08': 'BSpace', // BS
  '\t': 'Tab',
  '\x03': 'C-c', // interrupt (A7)
  '\x04': 'C-d', // EOF
  // Line editing — none of these touch the process; they are what "typing in a terminal" means.
  '\x01': 'C-a', // cursor to line start
  '\x05': 'C-e', // cursor to line end
  '\x15': 'C-u', // kill whole line
  '\x17': 'C-w', // kill previous word
  '\x0b': 'C-k', // kill to end of line
  // CSI cursor keys (normal mode)
  '\x1b[A': 'Up',
  '\x1b[B': 'Down',
  '\x1b[C': 'Right',
  '\x1b[D': 'Left',
  // SS3 cursor keys (application cursor mode)
  '\x1bOA': 'Up',
  '\x1bOB': 'Down',
  '\x1bOC': 'Right',
  '\x1bOD': 'Left',
}

/** True when every code point in the chunk is printable (>= 0x20 and not DEL). Handles non-ASCII. */
function isAllPrintable(data: string): boolean {
  for (const ch of data) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp < 0x20 || cp === 0x7f) return false
  }
  return true
}

/**
 * Classify one raw `onData` chunk into a send intent.
 *
 * A chunk is EITHER one recognized named key, OR wholly printable text, OR blocked. A chunk mixing
 * printable text with a control byte (a paste that carries a newline, say) is refused rather than
 * split — a raw keystroke is one thing, and pasting long text is the line composer's job, which the
 * assignment keeps deliberately.
 */
export function classifyInput(data: string): KeyIntent {
  if (data.length === 0) return { kind: 'blocked', reason: 'empty' }

  const named = NAMED[data]
  if (named) return { kind: 'key', key: named }

  if (isAllPrintable(data)) return { kind: 'text', text: data }

  return { kind: 'blocked', reason: 'unsupported-sequence' }
}

/**
 * The server's ack `reason` is a STABLE CODE (`docs/terminal-write-channel.md`), not prose — so the
 * client owns the wording and the language. An unknown code is shown verbatim rather than swallowed:
 * a reason the user cannot read still beats a silent failure.
 */
const REASON_TEXT: Record<string, { en: string; pt: string }> = {
  bad_json: { en: 'the terminal sent a malformed message', pt: 'o terminal enviou uma mensagem malformada' },
  bad_message: { en: 'the terminal sent an invalid message', pt: 'o terminal enviou uma mensagem inválida' },
  empty_text: { en: 'nothing to send', pt: 'nada para enviar' },
  text_too_long: { en: 'that input was too long to send at once', pt: 'essa entrada é longa demais para enviar de uma vez' },
  bad_key: { en: 'that key is not allowed', pt: 'essa tecla não é permitida' },
  send_failed: { en: 'not delivered — the key did not reach the session', pt: 'não entregue — a tecla não chegou à sessão' },
  error: { en: 'the write channel hit an error', pt: 'o canal de escrita encontrou um erro' },
  // Client-side close reasons (a socket close carries no server code): before-open vs after-open.
  channel_unavailable: { en: 'the write channel could not be opened', pt: 'não foi possível abrir o canal de escrita' },
  connection_lost: { en: 'the connection dropped; recent keys may not have been delivered', pt: 'a conexão caiu; as últimas teclas podem não ter sido entregues' },
}

export function inputReasonText(code: string, lang: 'pt' | 'en'): string {
  const entry = REASON_TEXT[code]
  return entry ? entry[lang] : code
}
