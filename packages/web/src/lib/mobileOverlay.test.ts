import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { overlayPadding } from './mobileOverlay'

describe('overlayPadding', () => {
  it('reserves the status bar on a full-screen mobile dialog', () => {
    expect(overlayPadding(true, 24)).toBe('var(--safe-top) 0 0')
  })

  it('leaves the desktop padding alone', () => {
    expect(overlayPadding(false, 24)).toBe('24px')
    expect(overlayPadding(false, '16px')).toBe('16px')
  })
})

/**
 * The lint. A full-screen mobile overlay that pads with a bare `0` puts its own close button under
 * the status bar, where the taps do not reach it — a control that is visible and inert, which is
 * indistinguishable from a broken app.
 */
describe('no full-screen mobile overlay hardcodes a zero top padding', () => {
  const ROOT = join(import.meta.dir, '..')

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (p.endsWith('.tsx')) out.push(p)
    }
    return out
  }

  it('greps the web source', () => {
    const offenders: string[] = []
    for (const file of walk(ROOT)) {
      const src = readFileSync(file, 'utf8')
      src.split('\n').forEach((line, i) => {
        // `padding: isMobile ? 0 : …` on an overlay. The escape hatch is the helper.
        if (/padding:\s*(?:is)?[Mm]obile\s*\?\s*0\b/.test(line) && !line.includes('@overlay-intentional')) {
          offenders.push(`${file.slice(ROOT.length + 1)}:${i + 1}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
