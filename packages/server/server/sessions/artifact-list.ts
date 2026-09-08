/**
 * artifact-list.ts — which of a session's paths are FILES THAT EXIST, with content.
 *
 * The panel lists what the conversation says the session touched. That list is honest about the
 * conversation and not about the disk: a temporary file that has since been deleted, a path written
 * by a command that failed, and a redirection into a directory that was never created all appear in
 * a transcript exactly like a file somebody would want to read. Asked for directly — "apenas
 * arquivos existentes e com conteúdos e manipulados nessa conversa" — and the disk is the only
 * thing that can answer the first two.
 *
 * IT ALSO RESOLVES. A shell write is recorded AS WRITTEN, which after a `cd` is a relative path;
 * `shell-writes.ts` returns it that way on purpose, because it does not know the working directory.
 * Here we do: the session's own `cwd`. Without this every shell-written file was listed and then
 * refused on open, because the read guard requires a path inside that directory — a list where
 * every row fails is worse than no list.
 *
 * EMPTY IS NOT MISSING, and both are excluded for the same reason: the panel exists to let somebody
 * READ what was written. A zero-byte file opens onto nothing, which reads as the panel being
 * broken rather than as the file being empty.
 */

import { resolve, isAbsolute } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { withinDirectory } from './artifact-file'

export interface ListedArtifact {
  /** The path as the transcript recorded it — the key the browser's own list is built on. */
  raw: string
  /** Resolved against the session's cwd, which is what the read route will be asked for. */
  path: string
  bytes: number
  /**
   * Where the file lives. Only `project` is reachable today — the read guard admits one root — and
   * the field is kept because the LIST is where a second root would first become visible, and a
   * caller that already reads it will not need changing on the day one is justified.
   */
  scope: 'project' | 'temp'
}

/**
 * PURE: resolve one recorded path against a session's directory.
 *
 * `~` is deliberately NOT expanded. A tilde is the shell's, not this process's, and a home
 * directory that differs between the server and the session would resolve to a file nobody meant —
 * the same class of confident wrong answer as inventing a path.
 */
export function resolveArtifactPath(raw: string, cwd: string): string | null {
  const p = raw.trim()
  if (p === '' || p.startsWith('~')) return null
  return isAbsolute(p) ? p : resolve(cwd, p)
}

/**
 * The subset of `paths` that are readable files with content, inside `cwd`.
 *
 * Order is preserved — it is the transcript's, which is what makes "the newest thing this session
 * wrote" answerable. A path that resolves outside the session's directory is dropped here rather
 * than shown and refused later: the read guard would reject it, and offering a row whose only
 * outcome is a refusal is the control-that-reads-as-broken this codebase argues against.
 */
export async function listExistingArtifacts(
  paths: readonly string[], cwd: string,
): Promise<ListedArtifact[]> {
  return (await listArtifactsWithOutside(paths, cwd)).files
}

/**
 * The same list, plus HOW MANY files the session wrote outside its own folder.
 *
 * The count exists because the drop was invisible, and an invisible drop reads as a bug in the
 * panel. Reported exactly that way: a file this session had just written with `cat > …` did not
 * appear, and nothing on screen said why — so the honest reading from outside is "the Files tab
 * missed it". It did not; it refused it, for the reason above.
 *
 * It is a COUNT and never the paths. Naming them would put text from outside the session's own
 * folder on a screen the read guard exists to keep it off — the drop would be undone by the
 * explanation of the drop. A number plus a sentence is the whole of what a reader needs: it says
 * the panel is complete for what it can serve, and that something else was written elsewhere.
 */
export async function listArtifactsWithOutside(
  paths: readonly string[], cwd: string,
): Promise<{ files: ListedArtifact[]; outside: number }> {
  const out: ListedArtifact[] = []
  const seen = new Set<string>()
  const outsideSeen = new Set<string>()
  for (const raw of paths) {
    const path = resolveArtifactPath(raw, cwd)
    if (!path || seen.has(path)) continue
    // ONE ROOT: the session's own folder. Adding the system temp directory as a second was tried
    // and reverted — it is shared, and widening the guard to all of it defeats the symlink-escape
    // check for any session whose folder is itself under it. The list must not offer what the read
    // route will refuse, so it applies the identical rule.
    /**
     * THE SAME RULE THE READ ROUTE APPLIES, and it has to stay identical: a list that offers what
     * the reader refuses is the control-that-reads-as-broken.
     *
     * It is no longer "inside the cwd". A session writes `~/.claude/projects/<project>/memory/
     * MEMORY.md` — which is what writing a memory IS in this product — and that was listed and then
     * refused, with the two halves of one screen disagreeing about the same file. What the gate is
     * FOR is the symlink escape, and the sharper test is whether resolution MOVED the file: where
     * the transcript NAMED it, or else inside the folder. See `planArtifactRead`.
     *
     * `realpath` is what makes the first half mean anything — without following the links there is
     * nothing to compare against and every path trivially equals itself. One extra syscall on a
     * list that already stats each file.
     */
    const real = await realpath(path).catch(() => null)
    if (real === null) continue
    if (real !== path && !withinDirectory(real, cwd)) { outsideSeen.add(path); continue }
    seen.add(path)
    try {
      const st = await stat(path)
      if (!st.isFile() || st.size === 0) continue
      out.push({ raw, path, bytes: st.size, scope: 'project' })
    } catch { /* gone, or unreadable — either way there is nothing to open */ }
  }
  return { files: out, outside: outsideSeen.size }
}
