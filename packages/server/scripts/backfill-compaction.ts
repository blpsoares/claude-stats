#!/usr/bin/env bun
/**
 * One-shot: stamp `compact_count` / `compact_ms` / `compact_dropped_tokens` / `skill_uses` onto
 * consolidate-store entries whose raw transcript still exists.
 *
 * Why this exists: `parseSessionJsonl` only fills these fields for sessions it reads from now on.
 * With `archiveMode: consolidate` (the default), `data.ts` never re-reads the archive root, so a
 * session whose raw transcript survives only in `~/.agentistics/archive` keeps these fields
 * `undefined` forever even though the evidence is on disk — and Claude deletes live transcripts
 * after `cleanupPeriodDays`, so the recoverable set shrinks every day this is not run.
 *
 * Idempotent — re-running it changes nothing. It only ever ADDS the four fields; it never rewrites
 * a session's other metrics, because those were computed by a parser that had the whole file and
 * this script has only the lines.
 *
 *   bun run packages/server/scripts/backfill-compaction.ts [--dry-run]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compactsFromClaudeJsonl, skillUsesFromClaudeJsonl } from '../server/jsonl'
import { PROJECTS_DIR, ARCHIVE_PROJECTS_DIR, CONSOLIDATED_DIR } from '../server/config'

const dryRun = process.argv.includes('--dry-run')

/** Every transcript we can still read, keyed by session id. Live wins over archive. */
function transcripts(): Map<string, string> {
  const found = new Map<string, string>()
  for (const root of [ARCHIVE_PROJECTS_DIR, PROJECTS_DIR]) {
    let dirs: string[] = []
    try { dirs = readdirSync(root) } catch { continue }
    for (const d of dirs) {
      let files: string[] = []
      try { files = readdirSync(join(root, d)) } catch { continue }
      for (const f of files) {
        if (f.endsWith('.jsonl')) found.set(f.slice(0, -6), join(root, d, f))
      }
    }
  }
  return found
}

let stamped = 0
let skipped = 0
const files = transcripts()

for (const [sessionId, path] of files) {
  // The consolidate store is namespaced by harness; compaction is Claude-only.
  const storePath = join(CONSOLIDATED_DIR, 'claude', `${sessionId}.json`)
  let doc: Record<string, unknown>
  try { doc = JSON.parse(readFileSync(storePath, 'utf8')) } catch { skipped++; continue }
  if (doc.compact_count !== undefined && doc.skill_uses !== undefined) { skipped++; continue }

  const lines = readFileSync(path, 'utf8').split('\n')
  const c = compactsFromClaudeJsonl(lines)
  const skills = skillUsesFromClaudeJsonl(lines)

  if (c.count > 0) {
    doc.compact_count = c.count
    doc.compact_ms = c.ms
    if (c.droppedTokens !== undefined) doc.compact_dropped_tokens = c.droppedTokens
  }
  doc.skill_uses = skills

  if (!dryRun) writeFileSync(storePath, JSON.stringify(doc))
  stamped++
}

console.log(JSON.stringify({ transcripts: files.size, stamped, skipped, dryRun }))
