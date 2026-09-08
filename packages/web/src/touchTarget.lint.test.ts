import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * The fix that is not enforced is the fix that comes back.
 *
 * A finger needs 44px. That rule was being paid in PAINT: `minHeight: isMobile ? 44` was written at
 * ~100 call sites, and at `border-radius: 999` an 11px label in a 44px box is not a pill, it is an
 * ellipse — the "Rank by" row rendered as three eggs, and a card's pin button as an empty 44x44
 * square the height of three rows. The answer is `.ag-tap` / `.ag-tap-icon` (index.css), which
 * project an invisible 44px box around a control that keeps its natural size.
 *
 * Nothing in the type system objects to the old shape, and the pattern SPREADS: the `tasks/*` area
 * was written with it while this very fix was in flight. So the guard is a grep over the web
 * source, the same shape `tokens.lint.test.ts` uses.
 *
 * Three shapes are refused:
 *
 *  1. **a pill that pays in paint** — `borderRadius: 999` in the same style block as
 *     `minHeight: isMobile ? 44`. This is the ellipse, and it has no legitimate form.
 *  2. **a 44x44 icon square** — `width`/`minWidth` AND `height` both `isMobile ? 44`. The painted
 *     box is then three times the icon inside it.
 *  3. **44px baked into a MODULE-LEVEL style object** — one that cannot read `useIsMobile()`, so
 *     the mobile number lands on the DESKTOP too. That is how `/tags` shipped 44px buttons,
 *     44x44 colour swatches and 44x44 trash icons on a 1440px screen.
 *
 * The escape hatch is `@touch-intentional` with a REASON on the same or the preceding line. It
 * exists because the rule has real exceptions, and they are worth writing down rather than
 * discovering: a dialog's "Save", a full-width form action, a menu row and a native form control
 * SHOULD be 44px of paint. `.ag-tap` is for controls whose smallness is their meaning.
 */

const ROOT = join(import.meta.dir, '..', '..', '..')
const SCAN = 'packages/web/src'
const MARKER = '@touch-intentional'

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    let entries: string[]
    try { entries = readdirSync(d) } catch { return }
    for (const name of entries) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) {
        if (name === 'node_modules' || name === 'dist') continue
        walk(p)
        continue
      }
      if (!/\.tsx?$/.test(name)) continue
      // A test naming the wrong shape is how the right one is pinned — this file does it above.
      if (/\.test\.tsx?$/.test(name)) continue
      if (name.endsWith('.generated.ts')) continue
      out.push(p)
    }
  }
  walk(join(ROOT, dir))
  return out
}

/**
 * Comments blanked, LENGTH PRESERVED so every offset below still names the right line. A doc
 * comment explaining the rule necessarily quotes the shape the rule forbids — this file does it
 * three times, and `bulkBtnStyle` says in prose which of its consumers ask for `minHeight: 44`.
 * Reading those as findings is the guard failing on its own documentation.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length))
}

/** The 1-based line a character offset falls on, so a failure names a place to go. */
function lineAt(src: string, index: number): number {
  return src.slice(0, index).split('\n').length
}

/** Is the finding waived, on its own line or the one above it? */
function waived(src: string, line: number): boolean {
  const lines = src.split('\n')
  const here = lines[line - 1] ?? ''
  const above = lines[line - 2] ?? ''
  // A bare marker is not a waiver: it has to say why, so `@touch-intentional` must be followed by
  // something other than the end of the line.
  const said = (s: string) => {
    const at = s.indexOf(MARKER)
    return at !== -1 && s.slice(at + MARKER.length).trim().length > 0
  }
  return said(here) || said(above)
}

/** The style block a property sits in — the braces around it, bounded so a miss stays local. */
function blockAround(src: string, index: number): string {
  return src.slice(Math.max(0, index - 700), Math.min(src.length, index + 700))
}

const MOBILE_44 = /minHeight:\s*isMobile\s*\?\s*44\b/g
const ICON_W_44 = /(?:minWidth|width):\s*isMobile\s*\?\s*44\b/g

describe('touch targets are projected, not painted', () => {
  const files = sourceFiles(SCAN)

  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('no pill pays its 44px touch target in paint', () => {
    const bad: string[] = []
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      const code = stripComments(src)
      for (const m of code.matchAll(MOBILE_44)) {
        const block = blockAround(code, m.index)
        if (!/borderRadius:\s*999\b/.test(block)) continue
        const line = lineAt(src, m.index)
        if (waived(src, line)) continue
        bad.push(`${relative(ROOT, file)}:${line}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('no icon button is painted as a 44x44 square', () => {
    const bad: string[] = []
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      const code = stripComments(src)
      for (const m of code.matchAll(ICON_W_44)) {
        const block = blockAround(code, m.index)
        // `(?:min)?[Hh]eight`: written as `height:` this never matched `minHeight:`, which is how
        // two live 44x44 squares passed the guard.
        if (!/(?:min)?[Hh]eight:\s*isMobile\s*\?\s*44\b/.test(block)) continue
        const line = lineAt(src, m.index)
        if (waived(src, line)) continue
        bad.push(`${relative(ROOT, file)}:${line}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('no module-level style object hardcodes the MOBILE 44 (it would apply on the desktop too)', () => {
    const bad: string[] = []
    // A module-level declaration starts at column 0. Anything indented is inside a component and
    // can read `useIsMobile()`, which is the whole difference this rule is about.
    const DECL = /^(?:export\s+)?(?:const\s+\w+\s*:\s*(?:React\.)?CSSProperties\s*=\s*\{|function\s+\w*(?:[Ss]tyle|Btn)\w*\s*\()/gm
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      const code = stripComments(src)
      for (const d of code.matchAll(DECL)) {
        // The declaration's body ends at whichever comes FIRST: its own closing brace at column 0,
        // or the next module-level declaration. Taking only the brace ran a single-line const
        // (`const x: CSSProperties = { … }`) on into the component below it, and reported that
        // component's own intentional 44 as module-level.
        const rest = code.slice(d.index)
        const brace = rest.search(/\n\}/)
        const nextDecl = rest.slice(1).search(/\n(?:export\s+)?(?:const|function|class)\s/)
        const ends = [brace, nextDecl === -1 ? -1 : nextDecl + 1].filter(n => n >= 0)
        const body = ends.length === 0 ? rest.slice(0, 900) : rest.slice(0, Math.min(...ends))
        // Only the UNCONDITIONAL form is refused here. A module object cannot see `isMobile`, so a
        // literal 44 in one is a desktop 44 whether or not that was the intent.
        const hit = /\b(?:minHeight|height):\s*44\b/.exec(body)
        if (!hit) continue
        const line = lineAt(src, d.index + hit.index)
        if (waived(src, line)) continue
        // Two module declarations can overlap in the crude body window above; one place is one
        // finding.
        const at = `${relative(ROOT, file)}:${line}`
        if (!bad.includes(at)) bad.push(at)
      }
    }
    expect(bad).toEqual([])
  })
})
