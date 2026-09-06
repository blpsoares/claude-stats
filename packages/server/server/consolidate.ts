import { join } from 'path'
import { mkdir, writeFile, readFile } from 'fs/promises'
import type { SessionMeta, HarnessId } from '@agentistics/core'
import { CONSOLIDATED_DIR } from './config'
import { createLimiter, safeReadDir, safeReadJson } from './utils'
import { HARNESS_ORDER, migrateAgentMetrics, normalizeSessionTimes } from '@agentistics/core'

const writeLimit = createLimiter(20)
const readyDirs = new Set<string>()

export function consolidatedPath(harness: HarnessId, sessionId: string): string {
  // Some harnesses (e.g. Gemini) embed a path segment in the session id
  // ("project/session-..."), so the raw id cannot be a flat filename — the
  // intermediate dir would not exist (ENOENT). Flatten path separators; the real
  // session id is read back from the file CONTENT, not the filename, so this is safe.
  const safeId = sessionId.replace(/[/\\]/g, '_')
  return join(CONSOLIDATED_DIR, harness, `${safeId}.json`)
}

async function ensureDir(harness: HarnessId): Promise<void> {
  if (readyDirs.has(harness)) return
  await mkdir(join(CONSOLIDATED_DIR, harness), { recursive: true })
  readyDirs.add(harness)
}

/** Persist computed per-session metrics to ~/.agentistics/sessions/<harness>/<id>.json.
 *  Skips writes when the stored copy is byte-identical to avoid churn. Entries
 *  are never deleted, so sessions removed by Claude's cleanup survive here. */
export async function writeConsolidated(sessions: SessionMeta[]): Promise<number> {
  if (sessions.length === 0) return 0
  const counts = await Promise.all(sessions.map(s => writeLimit(async () => {
    if (!s.session_id) return 0
    const harness = s.harness ?? 'claude'
    await ensureDir(harness)
    const dest = consolidatedPath(harness, s.session_id)
    const next = JSON.stringify(s)
    const prev = await readFile(dest, 'utf-8').catch(() => null)
    if (prev === next) return 0
    await writeFile(dest, next)
    return 1
  })))
  return counts.reduce<number>((a, b) => a + b, 0)
}

/** Load all consolidated sessions keyed by session_id.
 *  Reads per-harness subdirs plus legacy flat files at the root (treated as claude).
 *  De-duplicates by (harness, session_id), then collapses to an id-keyed Map. */
export async function loadConsolidated(): Promise<Map<string, SessionMeta>> {
  const map = new Map<string, SessionMeta>()
  const limit = createLimiter(40)
  // Per-harness subdirs + legacy flat files (treated as claude)
  const harnesses: HarnessId[] = HARNESS_ORDER
  const roots = [
    ...harnesses.map(h => ({ dir: join(CONSOLIDATED_DIR, h), legacy: false })),
    { dir: CONSOLIDATED_DIR, legacy: true },
  ]
  for (const { dir, legacy } of roots) {
    const files = await safeReadDir(dir)
    await Promise.all(files.filter(f => f.endsWith('.json')).map(f => limit(async () => {
      const s = await safeReadJson<SessionMeta>(join(dir, f))
      if (!s?.session_id) return
      if (!s.harness) s.harness = 'claude'
      // The store holds whatever an adapter wrote, including shapes it should not have written —
      // Kimi persisted `start_time` as an epoch number, and every consumer that calls a string
      // method on it threw. Repaired HERE, on the way in, because the file on disk is already
      // wrong and fixing the adapter cannot reach it. See normalizeSessionTimes.
      normalizeSessionTimes(s)
      // …and for the same reason, a record written before `AgentInvocation.unmeasured` existed is
      // read honestly rather than at face value. #373 stopped the READER publishing an async
      // agent priced at nothing; it does not reach what is already in this store, where such a row
      // has zeros and no mark and the new rule reads it as "measured, and it cost nothing".
      // `migrateAgentMetrics` is idempotent and recovers the shape from the content.
      if (s.agentMetrics) s.agentMetrics = migrateAgentMetrics(s.agentMetrics)
      // (harness, id) key; first writer wins per key
      const key = `${s.harness}:${s.session_id}`
      if (!map.has(key)) map.set(key, s)
    })))
    if (legacy) break
  }
  // Caller expects id-keyed map; collapse to id (live merge re-dedups by id anyway)
  const byId = new Map<string, SessionMeta>()
  for (const s of map.values()) if (!byId.has(s.session_id)) byId.set(s.session_id, s)
  return byId
}
