/**
 * artifact-file.ts — PURE: may this file be read for this session?
 *
 * The most powerful thing in the artifacts panel is that it reads the disk, so the rule is written
 * once, here, with no IO in it. The caller resolves both paths with `realpath` FIRST and hands the
 * results in — which is what makes `..` and an escaping symlink ordinary inputs to this function
 * rather than string patterns it would have to recognise.
 *
 * TWO GATES, IN THIS ORDER:
 *
 *  1. **The session must have touched it.** The reachable set is a consequence of what the session
 *     did, not a rule about directories — `/home/u/proj/.env` is in the project and has nothing to
 *     do with this conversation. Checked FIRST, so a path nobody asked about is refused without
 *     the answer confirming anything about where the cwd is.
 *  2. **It must resolve inside the session's cwd.** By path SEGMENT, never by string prefix:
 *     `/home/u/proj-secrets` starts with `/home/u/proj` and is a different directory.
 *
 * REFUSE, NEVER REPAIR. A path that needed fixing is a path nobody meant to send, and a sanitiser
 * is a place for the next bug to hide. The codes are language-free; the caller renders the words.
 */

export type ArtifactRefusal =
  /** Not in this session's artifact list. */
  | 'not-touched'
  /** Resolved outside the session's working directory. */
  | 'outside-cwd'
  /** A directory, or something that is not a regular file. */
  | 'not-a-file'
  /** Not text — a NUL byte in the first chunk. */
  | 'binary'
  /** Present in the list and gone, or unreadable, at the moment it was asked for. */
  | 'unreadable'

export interface ArtifactReadRequest {
  /** The already-resolved absolute path being asked for. */
  path: string
  /** The already-resolved absolute working directory of the session. */
  cwd: string
  /** The already-resolved absolute paths this session touched. */
  allowed: readonly string[]
}

export type ArtifactReadPlan =
  | { ok: true; path: string }
  | { ok: false; reason: ArtifactRefusal }

/** Is `path` inside `dir`, by SEGMENT? `dir` itself is not "inside" itself. */
export function withinDirectory(path: string, dir: string): boolean {
  if (path === dir) return false
  const base = dir.endsWith('/') ? dir : `${dir}/`
  return path.startsWith(base)
}

export function planArtifactRead({ path, cwd, allowed }: ArtifactReadRequest): ArtifactReadPlan {
  if (path === '' || !allowed.includes(path)) return { ok: false, reason: 'not-touched' }
  if (path === cwd) return { ok: false, reason: 'not-a-file' }
  // THE SESSION'S FOLDER, AND NOTHING ELSE. Admitting the system temp directory as a second root
  // was tried and reverted: it is a shared directory, and widening the guard to all of it defeats
  // the symlink-escape check for any session whose own folder sits under it — which the probe
  // sessions this product creates all do. `artifact-web.test.ts` catches exactly that, and the
  // test is right. The allowlist proves the session WROTE a path; this second gate is what stops a
  // path it wrote from resolving somewhere it should not be read from.
  if (!withinDirectory(path, cwd)) return { ok: false, reason: 'outside-cwd' }
  return { ok: true, path }
}

/**
 * The tools whose `detail` is a file path — the same set the browser selects by.
 *
 * Stated twice on purpose, and the two must agree: the browser's `sessionArtifacts.ts` also needs
 * names, kinds and counts, while the ALLOWLIST needs only the paths. This is the copy that guards
 * the disk, so it selects by the same tool NAMES and never by the shape of `detail` — `toolDetail`
 * reads `command` first, and a `Bash` line is not a path.
 */
export const ARTIFACT_TOOL_NAMES = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const

/** PURE: just the paths, for the server's allowlist. */
export function artifactPathsFromTurns(
  turns: readonly { tools?: { name: string; detail?: string; writes?: string[] }[] }[],
): string[] {
  const out = new Set<string>()
  for (const t of turns) {
    for (const call of t?.tools ?? []) {
      // A file the SHELL wrote is a file this session wrote, and the panel now LISTS those — so the
      // allowlist has to admit them or every one of those rows refuses to open, which is a worse
      // state than not listing them at all. `writes` is the pure `shell-writes.ts` reading of the
      // command, computed where the whole command is still available.
      for (const w of call.writes ?? []) {
        const t = w.trim()
        if (t !== '' && !t.endsWith('…')) out.add(t)
      }
      if (!(ARTIFACT_TOOL_NAMES as readonly string[]).includes(call.name)) continue
      const p = call.detail?.trim()
      // A truncated detail (`toolDetail` ellipsises past 200 chars) names no file. Admitting one
      // would put a path into the allowlist that resolves to nothing — or, worse, to something else.
      if (p && !p.endsWith('…')) out.add(p)
    }
  }
  return [...out]
}
