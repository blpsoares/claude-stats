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
 *
 * WHAT IT DELIBERATELY DOES NOT REACH.
 *
 * A session whose own `<session-id>.jsonl` is gone can still leave a `<session-id>/subagents/`
 * directory behind — 5 of those live here and 63 in the archive. `data.ts` has a `_source:
 * 'subdir'` fallback that reads the first agent file as a stand-in for such a session, and it would
 * be easy to do the same here. IT WOULD BE WRONG: a subagent runs its own context and compacts on
 * its own, and 5 of this machine's 255 subagent transcripts carry their own `compact_boundary`.
 * Reading one in place of the session would file the SUBAGENT's compactions against the session —
 * a confident wrong number where the honest answer is that the evidence is gone. So those sessions
 * keep `compact_count: undefined`, which is what "we cannot know" looks like everywhere else here.
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
  /*
   * IDEMPOTENCE HANGS ON `skill_uses` ALONE, and that is deliberate.
   *
   * The guard used to require `compact_count` too, which a session that never compacted never
   * gets — `compact_count` is written only when the count is above zero, because a session whose
   * transcript we could not read and one that genuinely compacted zero times must not look alike.
   * So every non-compacting session (the overwhelming majority: 18 of 452 here ever compacted)
   * failed the guard forever and was re-stamped with identical bytes on every run.
   *
   * `skill_uses` is written unconditionally — `{}` is a real answer, "this session invoked none" —
   * so its presence is the exact record of "this script has already been here".
   */
  if (doc.skill_uses !== undefined) { skipped++; continue }

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
