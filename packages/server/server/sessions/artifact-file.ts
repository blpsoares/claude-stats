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
 *  2. **IT MUST NOT HAVE ESCAPED.** The file has to be where the session NAMED it, or else inside
 *     the session's own folder.
 *
 * ## Why gate 2 is not simply "inside the cwd"
 *
 * It was, and it refused things nobody meant to refuse. A session that writes
 * `~/.claude/projects/<project>/memory/MEMORY.md` — which is what writing a memory IS in this
 * product — had that row listed by the panel and refused by the reader, with the two halves of one
 * screen disagreeing about the same file. Reported exactly that way.
 *
 * What gate 2 is actually FOR is the symlink escape: the session writes `./notes.md`, that is a
 * link to `/etc/shadow`, and the panel would then serve `/etc/shadow`. "Inside the cwd" catches
 * that, and catches an honest absolute path with it. The sharper test is whether resolution MOVED
 * the file: `named` is where the transcript put it, resolved lexically against the cwd with no
 * links followed; `real` is where it actually is. They agree exactly when nothing was redirected.
 *
 * So the gate is a UNION, and each half covers what the other cannot:
 *  - `named === real` — nothing was redirected. An absolute path the session wrote to outside its
 *    folder is exactly what it says it is.
 *  - inside the cwd — the ordinary case, and the one that keeps a machine whose `$HOME` is itself a
 *    symlink working: both sides are resolved, so every file in the project still passes.
 * `./notes.md` → `/etc/shadow` satisfies NEITHER and is refused, which is the whole point.
 *
 * IT IS THE CALLER'S JOB TO RESOLVE, and the type makes that unavoidable: `allowed` carries both
 * forms per entry, so a caller that never called `realpath` cannot silently hand in one path twice
 * and turn the gate off. That is not hypothetical — the MEDIA route did exactly that.
 *
 * REFUSE, NEVER REPAIR. A path that needed fixing is a path nobody meant to send, and a sanitiser
 * is a place for the next bug to hide. The codes are language-free; the caller renders the words.
 */

export type ArtifactRefusal =
  /** Not in this session's artifact list. */
  | 'not-touched'
  /** Resolution MOVED it: not where the session named it, and not inside the session's folder. */
  | 'escaped'
  /** A directory, or something that is not a regular file. */
  | 'not-a-file'
  /** Not text — a NUL byte in the first chunk. */
  | 'binary'
  /** Present in the list and gone, or unreadable, at the moment it was asked for. */
  | 'unreadable'

/**
 * One path this session touched, in BOTH of its forms.
 *
 * Two fields rather than one because the gate is the comparison between them — see the header.
 */
export interface AllowedArtifact {
  /** Where the transcript NAMED it: resolved against the cwd lexically, following no links. */
  named: string
  /** Where it actually is: every symlink followed. */
  real: string
}

export interface ArtifactReadRequest {
  /** The already-resolved (`realpath`) absolute path being asked for. */
  path: string
  /** The already-resolved absolute working directory of the session. */
  cwd: string
  /** The paths this session touched, each in both forms. */
  allowed: readonly AllowedArtifact[]
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
  // Matched on the REAL path: that is the file, whatever route was used to name it.
  const hit = path === '' ? undefined : allowed.find(a => a.real === path)
  if (!hit) return { ok: false, reason: 'not-touched' }
  if (path === cwd) return { ok: false, reason: 'not-a-file' }
  // NOTHING REDIRECTED IT, or it is in the session's own folder. Adding the system temp directory
  // as a THIRD root was tried and reverted: it is shared, and widening to all of it defeats this
  // check for any session whose own folder sits under it — which the probe sessions this product
  // creates all do. `artifact-web.test.ts` catches exactly that, and the test is right.
  if (hit.named !== path && !withinDirectory(path, cwd)) return { ok: false, reason: 'escaped' }
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
