import { describe, expect, it } from 'bun:test'
import {
  PROBE_KEEP, appendSample, diagnose, formatLog, formatSample, type ProbeSample,
} from './keyboardProbe'

const s = (o: Partial<ProbeSample> = {}): ProbeSample => ({
  t: 0, label: 'vv', scrollY: 0, vvTop: 0, vvH: 800, innerH: 800,
  rootTop: 0, composerTop: 700, focused: false, ...o,
})

describe('appendSample — a burst must not push the interesting reading off the top', () => {
  it('drops a consecutive duplicate', () => {
    // `resize` and `scroll` fire in bursts on iOS; fourteen identical rows are fourteen wasted rows.
    const one = appendSample([], s())
    expect(appendSample(one, s({ t: 40 }))).toHaveLength(1)
  })

  it('keeps the same numbers under a DIFFERENT trigger — that is news', () => {
    const one = appendSample([], s({ label: 'vv' }))
    expect(appendSample(one, s({ label: 'focusout' }))).toHaveLength(2)
  })

  it('keeps a reading whose numbers moved', () => {
    const one = appendSample([], s())
    expect(appendSample(one, s({ vvTop: 120 }))).toHaveLength(2)
  })

  it('keeps the NEWEST when it runs out of room', () => {
    let log: ProbeSample[] = []
    for (let i = 0; i < PROBE_KEEP + 5; i++) log = appendSample(log, s({ t: i, scrollY: i }))
    expect(log).toHaveLength(PROBE_KEEP)
    expect(log[log.length - 1]!.scrollY).toBe(PROBE_KEEP + 4)
  })
})

describe('formatSample — the two candidates lead, and focus is the ✓ path\'s signature', () => {
  it('leads with the scroll and the visual viewport offset', () => {
    const line = formatSample(s({ t: 1500, scrollY: 12, vvTop: 34 }))
    expect(line.indexOf('sy=12')).toBeLessThan(line.indexOf('vvTop=34'))
    expect(line).toContain('1.5s')
  })

  it('says whether a field still holds the focus', () => {
    expect(formatSample(s({ focused: true }))).toContain('FOCUSED')
    expect(formatSample(s({ focused: false }))).toContain('blurred')
  })

  it('writes an absent composer as a dash, never as a zero', () => {
    expect(formatSample(s({ composerTop: null }))).toContain('comp=—')
  })

  it('formatLog is one line per reading, newest last', () => {
    expect(formatLog([s({ scrollY: 1 }), s({ scrollY: 2 })]).split('\n')).toHaveLength(2)
  })
})

describe('diagnose — it names the quantity, and withholds where it cannot', () => {
  it('says nothing at all with no reading', () => {
    expect(diagnose([], false)).toBe(null)
  })

  it('withholds a verdict WHILE the keyboard is up', () => {
    // Everything is displaced then, and correctly so — that displacement is what carries the
    // composer above the keyboard.
    expect(diagnose([s({ vvH: 400, innerH: 800, rootTop: -300 })], false)).toBe(null)
  })

  it('names the VISUAL VIEWPORT when the scroll is zero and the offset is not', () => {
    const v = diagnose([s({ vvTop: 180, scrollY: 0, rootTop: 0, focused: true })], false)
    expect(v).toContain('VISUAL VIEWPORT')
    expect(v).toContain('still focused')
  })

  it('names the DOCUMENT SCROLL when that is what is holding it', () => {
    expect(diagnose([s({ scrollY: 180, rootTop: -180 })], false)).toContain('document scroll')
  })

  it('names neither when #root moved with both at zero', () => {
    expect(diagnose([s({ rootTop: -90 })], false)).toContain('inner scroller')
  })

  it('says it came back when everything is at zero', () => {
    expect(diagnose([s()], false)).toContain('came back')
    expect(diagnose([s()], true)).toContain('voltou ao lugar')
  })
})
