/**
 * The key arithmetic for the JSONL parse cache. PURE — no IO, no SQLite.
 *
 * Two identities, deliberately separate:
 *
 *   SLOT — WHICH derivation of WHICH file this row holds: (kind, path, variant).
 *          It is the table's primary key, so the store holds exactly ONE row per
 *          slot and cannot grow with every append to a live transcript.
 *
 *   KEY  — WHICH VERSION of that file the row was derived from: (mtime, size).
 *          A hit requires the stored key to equal the current file's key.
 *
 * `variant` exists because a derivation may depend on something beyond the file's
 * bytes — `extractAgentMetrics` prices against a model id supplied by the CALLER.
 * Anything outside the file that changes the result MUST go in the variant, or two
 * callers silently poison each other's row.
 */

/** What kind of derived value a row holds. Part of the slot, so two derivations
 *  of one file never collide. */
/**
 * `subagent` is keyed on ONE AGENT'S OWN transcript, never the conversation's.
 *
 * Those files change independently of the parent — a running agent writes while the conversation
 * sits still — so a summary cached under the parent's stamp would be a cache key that does not name
 * its source. Keyed on its own file, a finished agent is summarised once ever.
 */
export type ParseCacheKind = 'session' | 'enrich' | 'subagent'

/** The identity of a file VERSION, as `stat()` reports it. */
export interface FileStamp {
  /** Absolute path of the source file. */
  path: string
  /** Modification time in milliseconds (may carry a fraction — see cacheKey). */
  mtimeMs: number
  /** Size in bytes. */
  size: number
}

/**
 * The row's identity, independent of the file's version.
 *
 * Encoded as a JSON ARRAY, not joined with a separator character. Any separator can be
 * forged: with a space, cacheSlot('session', '/a.jsonl', 'b c') and
 * cacheSlot('session', '/a.jsonl b', 'c') collapse to one string and two different
 * files share a row. A NUL cannot appear in a POSIX path and would also work, but it
 * then has to survive `sqlite3_bind_text` intact — a binding that measured the string
 * with strlen() would truncate the slot at its first field and silently merge every
 * row. (It does survive in bun:sqlite 1.3.14, verified; this encoding makes the
 * question moot rather than betting on it staying true.)
 *
 * JSON also keeps the column READABLE in any SQLite browser, which is most of what a
 * plain JSON file gives up when a cache like this replaces one. Windows paths
 * ("C:\\Users\\...") are escaped by JSON.stringify like any other string.
 */
export function cacheSlot(kind: ParseCacheKind, path: string, variant = ''): string {
  return JSON.stringify([kind, path, variant])
}

/**
 * The file VERSION a row was derived from.
 *
 * `mtimeMs` is TRUNCATED to whole milliseconds: `stat()` reports it as a float and
 * two stats of one untouched file can disagree in the fraction, which would miss on
 * every build and defeat the cache entirely.
 *
 * Size is carried alongside mtime because mtime granularity is a filesystem
 * property, not a guarantee — on a coarse clock two different contents can share a
 * timestamp. The residual risk is a file rewritten to the SAME byte length inside
 * the same millisecond; for append-only transcripts that cannot happen, and the
 * cost of being wrong is a stale metric until the next write, never lost data.
 *
 * The path is NOT part of the key — it is already the slot, and repeating it here
 * would double the stored bytes for no added discrimination.
 */
export function cacheKey(stamp: FileStamp): string {
  return `${Math.trunc(stamp.mtimeMs)}:${stamp.size}`
}
