/**
 * session-purity.test.ts — the proof that the web bundle can import the fleet semantics.
 *
 * `session-fleet.ts` and `session-verbs.ts` exist so the browser can resolve the SAME answers the
 * terminal cockpit resolves against. What makes that fragile is that the wrong import is invisible:
 * `sessions.ts` takes `PANE_FRAME_Y` from `chrome.ts`, `chrome.ts` takes `truncate` from
 * `../components/Primitives`, and that imports Ink. Adding one such line to the pure half compiles,
 * passes every other test, and only fails later — in Vite, on a machine that is not this one.
 *
 * So the assertion is over the SOURCE and over the whole transitive VALUE graph, the same shape as
 * `tokens.lint.test.ts` and `capability-guard.test.ts`. A type-only import is followed by nobody at
 * runtime and is allowed; `verbatimModuleSyntax` erases it.
 */

import { expect, test, describe } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const HERE = import.meta.dir
const ROOTS = ['session-fleet.ts', 'session-verbs.ts']

/** Modules a browser bundle cannot resolve — Ink, and everything that reaches it. */
const FORBIDDEN = ['ink', 'react-devtools-core', 'node:', 'bun:']

/** Sibling modules that exist to measure a terminal. Reaching one is the defect this test names. */
const GEOMETRY = ['./chrome', './surface', '../components/']

function readModule(file: string): string {
  return readFileSync(file, 'utf8')
}

/** Every VALUE import specifier in a module — `import type` and inline `type` members are skipped. */
function valueImports(src: string): string[] {
  const out: string[] = []
  const re = /^\s*(?:import|export)\s+([\s\S]*?)from\s+['"]([^'"]+)['"]/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const clause = m[1] ?? ''
    const spec = m[2]!
    // `import type { X } from` / `export type { X } from` are erased entirely.
    if (/^\s*type\s/.test(clause)) continue
    // A clause whose every member is `type X` is erased too.
    const braced = clause.match(/\{([\s\S]*)\}/)
    if (braced) {
      const members = braced[1]!.split(',').map(s => s.trim()).filter(Boolean)
      const before = clause.slice(0, clause.indexOf('{')).replace(/[,\s]/g, '')
      if (members.length > 0 && members.every(x => x.startsWith('type ')) && before === '') continue
    }
    out.push(spec)
  }
  return out
}

function resolveRelative(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(from), spec)
  for (const cand of [base, base + '.ts', base + '.tsx', base.replace(/\.ts$/, '') + '.ts']) {
    if (existsSync(cand) && !cand.endsWith('/')) return cand
  }
  return null
}

/** The transitive value graph, as file paths, plus every bare specifier reached along the way. */
function graph(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>()
  const bare = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (files.has(file)) continue
    files.add(file)
    for (const spec of valueImports(readModule(file))) {
      const resolved = resolveRelative(file, spec)
      if (resolved) queue.push(resolved)
      else bare.add(spec)
    }
  }
  return { files, bare }
}

describe('the pure fleet modules stay importable from the browser', () => {
  for (const root of ROOTS) {
    const entry = resolve(HERE, root)

    test(`${root} reaches no terminal geometry, directly`, () => {
      const specs = valueImports(readModule(entry))
      for (const bad of GEOMETRY) {
        expect(specs.filter(s => s.startsWith(bad))).toEqual([])
      }
    })

    test(`${root} reaches no Ink and no runtime-only module, transitively`, () => {
      const { files, bare } = graph(entry)
      for (const bad of FORBIDDEN) {
        expect([...bare].filter(s => s === bad || s.startsWith(bad))).toEqual([])
      }
      // Named explicitly as well as by the bare check: these are the two modules whose whole job is
      // to measure a terminal, and they are how Ink got reached before the split.
      for (const f of files) {
        expect(f.endsWith('/chrome.ts')).toBe(false)
        expect(f.endsWith('/surface.ts')).toBe(false)
        expect(f.includes('/components/')).toBe(false)
      }
    })

    test(`${root} takes no width and no row count`, () => {
      const src = readModule(entry)
      // A measurement belongs in `sessions.ts`. The signature is where it would show up first.
      expect(/^\s*(width|height|rows|columns)\s*[?]?\s*:\s*number/m.test(src)).toBe(false)
    })
  }

  test('sessions.ts still re-exports the moved names, so no existing importer changed', () => {
    const src = readModule(resolve(HERE, 'sessions.ts'))
    expect(src).toContain("export * from './session-fleet'")
    expect(src).toContain("export * from './session-verbs'")
  })
})
