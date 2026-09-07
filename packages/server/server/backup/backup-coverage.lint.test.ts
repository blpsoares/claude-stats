/**
 * backup-coverage.lint.test.ts — nothing agentop writes under `~/.agentistics` may be UNDECIDED.
 *
 * A path is decided when it is either carried by a backup source or named in the exclusion table
 * with a reason. Neither is a silent omission: the file is not in the archive, nothing says so,
 * and the loss is discovered on the machine that no longer has the original.
 *
 * This greps the server's own source for the literals that name those paths, the same shape
 * `tokens.lint.test.ts` and `releaseWorkflow.lint.test.ts` use — so a directory a future feature
 * starts writing fails this test until somebody decides about it, rather than being remembered.
 * `event-subscriptions.json` (the event channel's subscriptions — tasks, notify targets, notes: a
 * person's configuration) was missing from the backup for exactly the reason this test exists.
 */
import { test, expect } from 'bun:test'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { HARNESS_ORDER } from '@agentistics/core'
import { BACKUP_LAYERS, excludeFor, planSources } from './backup-plan'

const SERVER_SRC = join(import.meta.dir, '..')

/** Every name the server source builds a `~/.agentistics/<name>` path from. */
function namesFromSource(): string[] {
  const patterns = [
    String.raw`join\(AGENTISTICS_DATA_DIR, '[^']+'`,
    String.raw`'\.agentistics', '[^']+'`,
  ]
  const found = new Set<string>()
  for (const p of patterns) {
    let out = ''
    try {
      out = execFileSync('grep', ['-rhoE', p, SERVER_SRC, '--include=*.ts'], { encoding: 'utf-8' })
    } catch {
      // grep exits non-zero when nothing matched; an empty result is a legitimate answer here.
      continue
    }
    for (const line of out.split('\n')) {
      const m = /'([^']+)'$/.exec(line.trim())
      if (m?.[1]) found.add(m[1])
    }
  }
  return [...found].sort()
}

/** Carried by some source, under some layer, for some harness. */
function carried(rel: string): boolean {
  const sources = planSources({ layers: [...BACKUP_LAYERS], harnesses: [...HARNESS_ORDER] })
  return sources.some(s => s.rel === rel || s.rel.startsWith(`${rel}/`) || rel.startsWith(`${s.rel}/`))
}

test('every path agentop writes under ~/.agentistics is either backed up or excluded WITH A REASON', () => {
  const undecided = namesFromSource()
    .map(name => `.agentistics/${name}`)
    // `preferences.json` is neither: it travels REDACTED, staged by `runBackup` itself
    // (`stageRedactedFiles`), so it is in the archive without being a walked source.
    .filter(rel => rel !== '.agentistics/preferences.json')
    .filter(rel => !carried(rel) && excludeFor(rel) === null)

  expect(undecided).toEqual([])
})

test('the grep actually finds something — an empty sweep would pass vacuously', () => {
  // Without this, a rename of AGENTISTICS_DATA_DIR or a change of import style would silently turn
  // the test above into one that checks nothing while staying green.
  const names = namesFromSource()
  expect(names.length).toBeGreaterThan(15)
  expect(names).toContain('sessions')
  expect(names).toContain('preferences.json')
})
