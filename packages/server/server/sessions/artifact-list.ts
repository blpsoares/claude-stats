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
  const out: ListedArtifact[] = []
  const seen = new Set<string>()
  for (const raw of paths) {
    const path = resolveArtifactPath(raw, cwd)
    if (!path || seen.has(path)) continue
    // THE IDENTICAL RULE THE READ ROUTE APPLIES, and it has to stay identical: a list that offers
    // what the reader refuses is the control-that-reads-as-broken, which is exactly how this was
    // reported — the panel listed `~/.claude/.../memory/MEMORY.md` and the reader said it was
    // outside the session's folder.
    //
    // So: where the transcript NAMED it, or inside the session's folder. `realpath` is what makes
    // the first half meaningful — without following the links there is nothing to compare `named`
    // against, and every path would trivially equal itself. One extra syscall per path, on a list
    // that already stats each one.
    const real = await realpath(path).catch(() => null)
    if (real === null) continue
    if (real !== path && !withinDirectory(real, cwd)) continue
    seen.add(path)
    try {
      const st = await stat(path)
      if (!st.isFile() || st.size === 0) continue
      out.push({ raw, path, bytes: st.size, scope: 'project' })
    } catch { /* gone, or unreadable — either way there is nothing to open */ }
  }
  return out
}
