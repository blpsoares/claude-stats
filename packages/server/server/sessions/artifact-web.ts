/**
 * artifact-web.ts — reading one file a session wrote.
 *
 * The ONLY part of the artifacts panel that touches the disk. Everything it is allowed to do is
 * decided by the pure `planArtifactRead`; what lives here is the IO and the two facts that can
 * only be learned by looking: whether it is text, and how big it is.
 *
 * THE ALLOWLIST IS REBUILT HERE, from the same transcript the browser read. The browser's list is
 * not trusted and is not even sent: a client asking for a path is asking a question, and the
 * answer comes from what the session actually did on this machine.
 *
 * `realpath` on BOTH sides before deciding, so `..` and a symlink pointing out of the project are
 * ordinary inputs to the rule rather than patterns to recognise. Refused, never normalised.
 */

import { realpath, readFile, stat } from 'node:fs/promises'
import { relative } from 'node:path'
import type { CliLang } from '../cli-lang'
import { planArtifactRead, type ArtifactRefusal } from './artifact-file'

/**
 * The most a file may carry into the page. Far above any spec and far below anything that would
 * trouble a browser. Named ONCE — no caller restates it.
 */
export const MAX_ARTIFACT_BYTES = 1024 * 1024

export type ArtifactResponse =
  | { ok: true; text: string; path: string; relPath: string; bytes: number; truncated: boolean }
  | { ok: false; message: string }

/** One sentence per refusal, in the caller's language. The pure module names none of these. */
export function artifactRefusalText(reason: ArtifactRefusal, lang: CliLang): string {
  const pt = lang === 'pt'
  switch (reason) {
    case 'not-touched':
      return pt
        ? 'Esta sessão não escreveu esse arquivo, então ele não pode ser aberto por aqui.'
        : 'This session did not write that file, so it cannot be opened from here.'
    case 'outside-cwd':
      return pt
        ? 'Esse caminho fica fora da pasta da sessão.'
        : 'That path resolves outside the session’s folder.'
    case 'not-a-file':
      return pt ? 'Isso é uma pasta, não um arquivo.' : 'That is a folder, not a file.'
    case 'binary':
      return pt
        ? 'Esse arquivo não é texto, então não há o que mostrar aqui.'
        : 'That file is not text, so there is nothing to show here.'
    case 'unreadable':
      return pt
        ? 'Não consegui ler esse arquivo agora — ele pode ter sido movido ou apagado.'
        : 'That file could not be read just now — it may have been moved or deleted.'
  }
}

/** A NUL byte in the first chunk. The same test `file(1)` starts from, and enough for this. */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0)
}

export async function readArtifact(
  lang: CliLang,
  cwd: string,
  allowedRaw: readonly string[],
  requested: string,
): Promise<ArtifactResponse> {
  const refuse = (r: ArtifactRefusal) => ({ ok: false as const, message: artifactRefusalText(r, lang) })

  // Resolve everything first. A path that cannot be resolved is not a path this machine has.
  const resolve = async (p: string): Promise<string | null> => {
    try { return await realpath(p) } catch { return null }
  }
  const cwdReal = await resolve(cwd)
  if (cwdReal === null) return refuse('unreadable')
  const pathReal = await resolve(requested)
  if (pathReal === null) return refuse('unreadable')

  const allowed: string[] = []
  for (const a of allowedRaw) {
    const r = await resolve(a)
    if (r !== null) allowed.push(r)
  }

  const plan = planArtifactRead({ path: pathReal, cwd: cwdReal, allowed })
  if (!plan.ok) return refuse(plan.reason)

  let bytes: number
  try {
    const st = await stat(plan.path)
    if (!st.isFile()) return refuse('not-a-file')
    bytes = st.size
  } catch { return refuse('unreadable') }

  let buf: Buffer
  try { buf = await readFile(plan.path) } catch { return refuse('unreadable') }
  if (looksBinary(buf)) return refuse('binary')

  const truncated = bytes > MAX_ARTIFACT_BYTES
  return {
    ok: true,
    // Truncated and SAYING so. A spec silently cut short is a document lying about being complete.
    text: (truncated ? buf.subarray(0, MAX_ARTIFACT_BYTES) : buf).toString('utf8'),
    path: plan.path,
    relPath: relative(cwdReal, plan.path),
    bytes,
    truncated,
  }
}
