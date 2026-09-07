/**
 * shell-writes.ts — PURE: which files a shell command WRITES.
 *
 * The artifacts panel reads the file tools (`Write`, `Edit`, `MultiEdit`) and found nothing on a
 * session that had written eighty files, because that session writes through the shell. Measured on
 * one real conversation: 400 turns, 263 `Bash` calls, 9 `Read`, and ZERO file-tool calls. A file
 * written by `cat > x` is still a file the session wrote, and a panel that says "nothing written
 * yet" over eighty of them is a confident wrong answer.
 *
 * A COMMAND LINE IS A CHAIN, and is judged segment by segment — the same rule `harness-activity.ts`
 * records for counting git commands, and for the same reason: `cd x && cat > y` writes `y`, and a
 * whole-line test either misses it or attributes it to `cd`.
 *
 * IT RECOGNISES ONLY WHAT IT CAN READ OFF THE COMMAND, and that boundary is the point:
 *
 *   - `> path` and `>> path`, the redirections, wherever they appear in a segment
 *   - `tee path` (and `tee -a path`)
 *   - the DESTINATION of `cp`/`mv`/`install`, which is their last argument
 *
 * It deliberately does NOT try to read a heredoc body. A `python3 - <<PY` that opens a path inside
 * its own script is writing a file this module cannot name, and guessing at the interpreter's
 * source would be inventing paths — the failure mode this whole panel exists to avoid. What it
 * CANNOT see it reports, through `hasUnreadableWrite`, so the caller can say so instead of
 * claiming nothing was written.
 */

/** Redirections to a device or a descriptor are not files anybody wants listed. */
const NOT_A_FILE = /^(\/dev\/|&)/

/**
 * Does this token read as a PATH?
 *
 * The segment splitter also runs over heredoc BODIES — it cannot tell one from a command list — so
 * a script containing `if x > 0` or `s.replace(a, b)` offers up `0` and `b)` as redirection
 * targets. Measured on one real conversation: 70 paths found, three of them junk of exactly that
 * shape.
 *
 * The guard is deliberately about SHAPE and not about the filesystem: this module cannot stat
 * anything, and a path that does not exist yet is precisely what a write produces. A token
 * qualifies when it has a directory separator or a file extension, carries no shell syntax, and is
 * not a bare number.
 */
function looksLikePath(p: string): boolean {
  if (p.length > 400) return false
  // Anything still carrying quoting, substitution or grouping is a fragment of source, not a path.
  if (/["'`()\[\]{}$*?<>|;]/.test(p)) return false
  if (/^\d+$/.test(p)) return false
  if (/^[=+\-.,:]+$/.test(p)) return false
  return p.includes('/') || /\.[A-Za-z0-9_]{1,8}$/.test(p)
}

/** Commands whose LAST argument is the thing they write. */
const DEST_LAST = new Set(['cp', 'mv', 'install'])

/**
 * Interpreters that take their program on stdin or inline, where the paths live in a body this
 * module does not parse. Their presence is what `hasUnreadableWrite` reports.
 */
const OPAQUE = /(^|[|&;]\s*)(python3?|node|bun|perl|ruby|sh|bash)\b[^|&;]*<<|(^|[|&;]\s*)(python3?|node|bun|perl|ruby)\s+-[ce]\b/

/** Split a command line into the segments a shell would run separately. */
export function commandSegments(command: string): string[] {
  // Newlines separate commands exactly as `;` does, and a heredoc body is not a command — but this
  // splits it anyway, which is safe: a body line that happens to look like a redirection names a
  // path the script really is about to write in nearly every case, and a wrong extra path is
  // visible and dismissible while a missing one is not.
  return command
    .split(/[\n;]|&&|\|\||\|/)
    .map(s => s.trim())
    .filter(s => s !== '')
}

/** Strip one layer of quotes from a token, so `> "a b"` yields `a b`. */
function unquote(token: string): string {
  const m = /^(['"])(.*)\1$/.exec(token)
  return m ? m[2]! : token
}

/**
 * Every path one command line writes, in the order it writes them, deduped.
 *
 * Relative paths are returned AS WRITTEN. This module does not know the shell's working directory,
 * and resolving one against a guess would produce a path that names a different file — the caller
 * decides whether an unrooted path is worth showing.
 */
export function shellWrites(command: string): string[] {
  const out: string[] = []
  /**
   * The directory the command ITSELF establishes.
   *
   * `cd /repo/worktree && cat > packages/x.ts` writes `/repo/worktree/packages/x.ts`, and nothing
   * outside the command needs to be guessed to know it — the line says so. Without this the path
   * is recorded relative and later resolved against the SESSION's directory, which for a session
   * that works in worktrees is the wrong checkout: measured here, every one of 17 real files
   * resolved to a path that does not exist.
   *
   * Only an ABSOLUTE `cd` counts. A relative one moves from a base this module does not know, and
   * a resolution built on a guess would name a different file — which is the whole failure this
   * reader is careful about.
   */
  let base: string | null = null
  const add = (raw: string | undefined): void => {
    if (!raw) return
    const p = unquote(raw.trim())
    if (p === '' || NOT_A_FILE.test(p) || p.startsWith('-')) return
    if (!looksLikePath(p)) return
    const full = base !== null && !p.startsWith('/') && !p.startsWith('~')
      ? `${base.replace(/\/+$/, '')}/${p}`
      : p
    if (!out.includes(full)) out.push(full)
  }

  for (const seg of commandSegments(command)) {
    // A `cd` in the chain moves everything after it. Absolute only — see `base`.
    const cdm = /^cd\s+(["']?)(\/[^\s;|&"']*)\1\s*$/.exec(seg)
    if (cdm) { base = cdm[2]!; continue }

    // Redirections: `>file`, `> file`, `>>file`, `2>file` — the descriptor prefix is not part of it.
    // A QUOTED target is one path even with a space in it, so the quoted forms are matched
    // first — an unquoted alternative that stops at whitespace would otherwise take only "my.
    for (const m of seg.matchAll(/(?:^|\s)\d?>>?\s*("[^"]*"|'[^']*'|[^\s;|&<>]+)/g)) add(m[1])

    const words = seg.split(/\s+/).filter(w => w !== '')
    const head = words[0]
    if (head === 'tee') {
      for (const w of words.slice(1)) { if (!w.startsWith('-')) add(w) }
    } else if (head && DEST_LAST.has(head)) {
      // The last argument is the destination; everything before it is a source or a flag.
      const args = words.slice(1).filter(w => !w.startsWith('-'))
      if (args.length >= 2) add(args[args.length - 1])
    }
  }
  return out
}

/**
 * Did this command write through something this module cannot read?
 *
 * True for an interpreter fed a program on stdin or with `-c`, where the paths are inside a body
 * rather than on the command line. The caller uses it to say "files were written by shell commands
 * that cannot be listed" instead of "nothing was written" — the difference between an honest gap
 * and a confident wrong answer.
 */
export function hasUnreadableWrite(command: string): boolean {
  return OPAQUE.test(command)
}

/**
 * The ONE line of a shell command worth showing.
 *
 * `toolDetail` used to take the command's first LINE, and a session that starts nearly every
 * command with `cd <worktree>` then produced a feed of identical `cd` rows — reported as "um monte
 * de CD seguido wtf". A `cd` is preparation, not the act: it says where the work happened, never
 * what it was.
 *
 * So the summary is the first segment that is NOT a bare `cd`, `set` or an empty one. When a
 * command is ONLY a `cd`, that is what it did and it is shown — a summary that dropped it would
 * leave a tool call with nothing beside it, which reads as a missing detail rather than a change of
 * directory.
 */
export function commandSummary(command: string): string {
  const segs = commandSegments(command)
  const meaningful = segs.find(s => !/^(cd|set|export)\s/.test(s) && !/^(cd|set)$/.test(s))
  const pick = (meaningful ?? segs[0] ?? command.trim()).trim()
  const line = pick.split('\n')[0]!.trim()
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}
