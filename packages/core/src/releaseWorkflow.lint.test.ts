import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The reading defect that shipped v1.23.1 as a patch, kept from coming back.
 *
 * `git log --pretty=format:` omits the terminal newline on the LAST record, and a
 * `while IFS= read -r` loop silently drops a final line without one — so the OLDEST commit in
 * every range went unclassified. A range whose only `feat` was that commit fell through to the
 * bash `patch` default and a feature was published as a correction. Reproduced on this repo's
 * own history: `fd283a1d..548aa5c8` holds exactly one commit, `feat(vscode): …`, and the old
 * reader classified ZERO of it.
 *
 * `versionBump.test.ts` pins the arithmetic. It cannot see the SHELL, and the shell is where the
 * defect lived: the calculation was never wrong, the commits simply never reached it. Nothing in
 * YAML objects to `format:` — it is one character from the correct form, it is what every
 * StackOverflow answer prints, and it fails only on the oldest record of a range, which is the
 * one case a hand test rarely covers. So the guard is a grep over the workflows themselves, the
 * same shape `tokens.lint.test.ts` uses over the product source.
 *
 * Two things are asserted:
 *
 *  1. **no workflow or shell script reads with `--pretty=format:` / `--format=format:`.**
 *     `tformat:` terminates every record and is correct everywhere `format:` is — including
 *     inside `$(…)`, which strips trailing newlines and so hides the difference until somebody
 *     copies the line into a loop. Banning the form outright is what makes the rule teachable;
 *     a rule that says "only in a loop" has to be re-argued at every call site.
 *  2. **the release workflow DELEGATES the bump to `@agentistics/core`** and carries no bash
 *     default of its own. The silent `patch` floor is the other half of the defect: a read that
 *     returned nothing became a patch release instead of a failed job. `bumpFromCommits` throws
 *     on an empty list precisely so that cannot happen, and that guarantee is worth nothing if
 *     the workflow ever goes back to deciding the bump itself.
 *
 * Escape hatch for (1): `@git-format-intentional` with a reason on the same or the preceding
 * line — which turns a silent mistake into a decision somebody wrote down.
 */

const ROOT = join(import.meta.dir, '..', '..', '..')
const WORKFLOW_DIR = join(ROOT, '.github', 'workflows')
const SHELL_SCRIPTS = ['install.sh', 'central.sh', 'start.sh']
const MARKER = '@git-format-intentional'

/** The non-terminating pretty format, in every spelling git accepts (quoted or bare). */
const NON_TERMINATING = /--(?:pretty|format)=["']?format:/g

/** The line a character offset falls on, 1-based — so a failure names a place to go. */
function lineAt(src: string, index: number): number {
  return src.slice(0, index).split('\n').length
}

/** True when the offending line, or the one above it, carries the marker with something after it. */
function excused(src: string, index: number): boolean {
  const lines = src.split('\n')
  const n = lineAt(src, index) - 1
  for (const line of [lines[n], lines[n - 1]]) {
    if (!line) continue
    const at = line.indexOf(MARKER)
    if (at >= 0 && line.slice(at + MARKER.length).trim().length > 0) return true
  }
  return false
}

function scanned(): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = []
  if (existsSync(WORKFLOW_DIR)) {
    for (const name of readdirSync(WORKFLOW_DIR)) {
      if (!/\.ya?ml$/.test(name)) continue
      out.push({ rel: `.github/workflows/${name}`, src: readFileSync(join(WORKFLOW_DIR, name), 'utf8') })
    }
  }
  for (const name of SHELL_SCRIPTS) {
    const p = join(ROOT, name)
    if (existsSync(p)) out.push({ rel: name, src: readFileSync(p, 'utf8') })
  }
  return out
}

describe('git log is read with a TERMINATING format', () => {
  it('finds the files it is meant to police', () => {
    const files = scanned().map((f) => f.rel)
    expect(files).toContain('.github/workflows/release.yml')
    expect(files.length).toBeGreaterThan(1)
  })

  it('no workflow or shell script uses --pretty=format: (the form that drops the last record)', () => {
    const offenders: string[] = []
    for (const { rel, src } of scanned()) {
      // Prose ABOUT the defect is the whole reason these files are readable; only real
      // invocations count, so a `#`-commented line is skipped.
      for (const m of src.matchAll(NON_TERMINATING)) {
        const line = src.split('\n')[lineAt(src, m.index) - 1] ?? ''
        if (/^\s*#/.test(line)) continue
        if (excused(src, m.index)) continue
        offenders.push(`${rel}:${lineAt(src, m.index)}  ${line.trim()}`)
      }
    }
    expect(
      offenders,
      `--pretty=format: omits the terminal newline on the last record, so \`while read\` drops the\n` +
        `OLDEST commit of the range (issue #248: a feat shipped as a patch). Use --pretty=tformat:.\n` +
        `If this call site genuinely cannot drop a record, say so with ${MARKER} and a reason.\n\n` +
        offenders.join('\n'),
    ).toEqual([])
  })
})

describe('the release workflow delegates the bump instead of deciding it in bash', () => {
  const src = readFileSync(join(WORKFLOW_DIR, 'release.yml'), 'utf8')

  it('calls the tested implementation in @agentistics/core', () => {
    expect(src).toContain('bumpFromCommits')
    expect(src).toContain('nextVersion')
    expect(src).toContain('@agentistics/core')
  })

  it('carries no bash bump default of its own — the silent patch floor is what shipped the wrong number', () => {
    const floors = src
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => !/^\s*#/.test(line))
      .filter(([, line]) => /^\s*(?:local\s+)?BUMP=["']?(?:patch|minor|major)\b/.test(line))
      .map(([n, line]) => `.github/workflows/release.yml:${n}  ${line.trim()}`)
    expect(
      floors,
      'the bump must come from bumpFromCommits (which THROWS on an unreadable range), never from a\n' +
        'bash default that turns a failed read into a quiet patch release.\n\n' + floors.join('\n'),
    ).toEqual([])
  })
})
