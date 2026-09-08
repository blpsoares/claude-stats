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
let stampedLegacy = 0
let alreadyStamped = 0
let notInStore = 0
let failed = 0
const files = transcripts()

/**
 * The store entry for a session, namespaced path first and the LEGACY flat file second.
 *
 * `loadConsolidated` reads both roots, so a session that only has a flat `<id>.json` at
 * `CONSOLIDATED_DIR` is a session the profile counts — and it used to land in the undifferentiated
 * `skipped` bucket here, indistinguishable from "already done". The namespaced path wins because
 * `loadConsolidated` takes the first writer per key and reads the harness dirs first, so stamping
 * a legacy file the namespaced one shadows would write bytes nothing reads.
 */
function storePaths(sessionId: string): { path: string; legacy: boolean }[] {
  return [
    { path: join(CONSOLIDATED_DIR, 'claude', `${sessionId}.json`), legacy: false },
    { path: join(CONSOLIDATED_DIR, `${sessionId}.json`), legacy: true },
  ]
}

for (const [sessionId, path] of files) {
  /*
   * ONE CORRUPT FILE MUST NOT LEAVE THE STORE HALF-BACKFILLED.
   *
   * Every read, parse and write below can throw on a truncated or non-object document, and an
   * uncaught throw here abandons the loop partway — leaving a store where some sessions carry the
   * fields and some do not, which is exactly the mongrel denominator this script exists to avoid.
   * A file we cannot handle is a COUNTED skip, and the count is reported.
   */
  try {
    // The consolidate store is namespaced by harness; compaction is Claude-only. A legacy flat file
    // is read by `loadConsolidated` too, so it is stamped as well and counted apart.
    let doc: Record<string, unknown> | null = null
    let storePath = ''
    let legacy = false
    for (const candidate of storePaths(sessionId)) {
      let parsed: unknown
      try { parsed = JSON.parse(readFileSync(candidate.path, 'utf8')) } catch { continue }
      // A store file that is not an object cannot carry these fields; treat it as unreadable rather
      // than assigning onto a string or an array.
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      doc = parsed as Record<string, unknown>
      storePath = candidate.path
      legacy = candidate.legacy
      break
    }
    if (!doc) { notInStore++; continue }

    /*
     * IDEMPOTENCE HANGS ON `skill_uses` ALONE, and that is deliberate.
     *
     * It is the one field written on EVERY stamped session — `{}` is a real answer, "this session
     * invoked none" — so its presence is the exact record of "this script has already been here".
     * `compact_count` now carries a real `0` too and would serve as well; `skill_uses` is kept
     * because a doc stamped by an older build of this script has it and may not have the zero.
     */
    if (doc.skill_uses !== undefined) { alreadyStamped++; continue }

    const lines = readFileSync(path, 'utf8').split('\n')
    const c = compactsFromClaudeJsonl(lines)
    const skills = skillUsesFromClaudeJsonl(lines)

    /*
     * THE SHAPE MUST BE THE PARSER'S, EXACTLY.
     *
     * `parseSessionJsonl` writes `compact_count` / `compact_ms` unconditionally (a `0` is a real
     * measurement) and `compact_dropped_tokens` only when a record carried one. Writing the
     * compaction fields only above zero here made the denominator depend on whether this script had
     * run: a session backfilled with no `compact_count` was excluded from `n` while the very same
     * session re-parsed live was included at `0`. This script reads the SESSION'S OWN transcript —
     * `transcripts()` only ever finds `<session-id>.jsonl` — so `source === 'jsonl'` is the branch
     * being reproduced.
     */
    doc.compact_count = c.count
    doc.compact_ms = c.ms
    if (c.droppedTokens !== undefined) doc.compact_dropped_tokens = c.droppedTokens
    doc.skill_uses = skills

    if (!dryRun) writeFileSync(storePath, JSON.stringify(doc))
    if (legacy) stampedLegacy++
    else stamped++
  } catch {
    failed++
  }
}

console.log(JSON.stringify({
  transcripts: files.size,
  stamped,
  stampedLegacy,
  alreadyStamped,
  notInStore,
  failed,
  dryRun,
}))
