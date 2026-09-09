import { describe, expect, it, test } from 'bun:test'
import {
  BAND_MAX_FRACTION, BAND_MIN_PX, DEFAULT_BAND_PREFS, clampBandHeight, readBandPrefs, shellErrorText,
  shellApiUrl, shellWatching, shellWhere, writeBandPrefs, type BandPrefs,
} from './shellBand'

describe('the unwatch discipline', () => {
  const open = { bandOpen: true, sessionSelected: true, documentVisible: true }

  it('captures only when the band is open, the session selected AND the tab visible', () => {
    expect(shellWatching(open)).toBe(true)
  })

  it('a collapsed band captures nothing', () => {
    expect(shellWatching({ ...open, bandOpen: false })).toBe(false)
  })

  it('a session that is not selected captures nothing', () => {
    expect(shellWatching({ ...open, sessionSelected: false })).toBe(false)
  })

  it('a backgrounded tab captures nothing', () => {
    // This is the only per-second cost the feature has: two tmux reads a second, per watched pane.
    // A surface that forgets to unwatch leaves a capture-pane loop running for a screen nobody sees.
    expect(shellWatching({ ...open, documentVisible: false })).toBe(false)
  })
})

describe('the band geometry', () => {
  it('a dragged height is kept as asked when it fits', () => {
    expect(clampBandHeight(300, 900)).toBe(300)
  })

  it('it never shrinks below a readable floor', () => {
    expect(clampBandHeight(10, 900)).toBe(BAND_MIN_PX)
    expect(clampBandHeight(-40, 900)).toBe(BAND_MIN_PX)
  })

  it('it never takes more than its share of the viewport', () => {
    expect(clampBandHeight(10_000, 900)).toBe(Math.round(900 * BAND_MAX_FRACTION))
  })

  it('a viewport too short for the floor still yields the floor, never a negative box', () => {
    // The ceiling would be below the floor here; a max/min written the other way round returns a
    // height the flex column cannot lay out.
    expect(clampBandHeight(200, 100)).toBe(BAND_MIN_PX)
  })

  it('a height that is not a number falls back to the floor', () => {
    expect(clampBandHeight(Number.NaN, 900)).toBe(BAND_MIN_PX)
  })
})

describe('where the shell was opened, said in the room a band has', () => {
  it('the home directory becomes ~', () => {
    expect(shellWhere('/home/mithrandir/agentistics')).toBe('~/agentistics')
  })

  it('a long path keeps its TAIL, with a leading ellipsis', () => {
    // The tail is what answers "where am I". `direction: rtl` was the first attempt and it moves
    // the LEADING `~` to the end — `eu/freelas/Pelvis-Institucional/~`, which reads as a directory
    // called `~` inside the project. So the trim is computed rather than left to the text engine.
    expect(shellWhere('/home/mithrandir/eu/freelas/Pelvis-Institucional')).toBe('…/freelas/Pelvis-Institucional')
  })

  it('a path already short enough is untouched', () => {
    expect(shellWhere('/srv/app')).toBe('/srv/app')
    expect(shellWhere('/home/m/x')).toBe('~/x')
  })

  it('nothing to say is an empty string, never a guess', () => {
    expect(shellWhere(undefined)).toBe('')
    expect(shellWhere('')).toBe('')
  })
})

describe('the refusal comes back in the reader’s own language', () => {
  test('every call carries the language, because the SERVER composes the sentence', () => {
    // `handleShellRoute` renders each `ShellRefusal` code into prose and reads the language off the
    // query string; with no `lang` it answers in English. Seen on screen: a Portuguese dashboard
    // showing "8 terminals are already open. Close one to open another." beside a Portuguese retry
    // button. The one thing a refusal has to be is readable.
    expect(shellApiUrl('/api/shell/open', 'pt')).toBe('/api/shell/open?lang=pt')
    expect(shellApiUrl('/api/shell/list', 'en')).toBe('/api/shell/list?lang=en')
  })
})

describe('a refusal is a sentence, never a blank pane', () => {
  it('the switch being off says so, and says where to turn it on', () => {
    expect(shellErrorText('shell_disabled', 'en')).toContain('Settings')
    expect(shellErrorText('shell_disabled', 'pt')).toContain('Configurações')
  })

  it('a central says it has no host to open one on', () => {
    expect(shellErrorText('shell_central', 'en')).not.toBe('shell_central')
    expect(shellErrorText('shell_central', 'pt')).not.toBe('shell_central')
  })

  it('an unknown code is shown verbatim rather than swallowed', () => {
    // A reason the reader cannot parse still beats a silent failure — `inputReasonText`'s own rule.
    expect(shellErrorText('something_new', 'en')).toBe('something_new')
  })
})

describe('the band prefs are a per-viewer convenience and never a hard dependency', () => {
  function memory(): Storage {
    const map = new Map<string, string>()
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v) },
      removeItem: (k: string) => { map.delete(k) },
      clear: () => map.clear(),
      key: () => null,
      get length() { return map.size },
    } as unknown as Storage
  }

  it('round-trips', () => {
    const s = memory()
    const prefs: BandPrefs = { open: true, height: 260 }
    writeBandPrefs(prefs, s)
    expect(readBandPrefs(s)).toEqual(prefs)
  })

  it('no stored value reads as CLOSED — the band is never opened by a machine nobody asked', () => {
    expect(readBandPrefs(memory()).open).toBe(false)
  })

  it('a storage that throws on read costs nothing', () => {
    const hostile = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } } as unknown as Storage
    expect(() => readBandPrefs(hostile)).not.toThrow()
    expect(readBandPrefs(hostile).open).toBe(false)
    expect(() => writeBandPrefs({ open: true, height: 200 }, hostile)).not.toThrow()
  })

  it('junk in storage reads as the default rather than as a broken band', () => {
    const s = memory()
    s.setItem('agentistics-shell-band', 'not json')
    expect(readBandPrefs(s).open).toBe(false)
    s.setItem('agentistics-shell-band', '{"open":"yes","height":"tall"}')
    expect(readBandPrefs(s)).toEqual({ open: false, height: DEFAULT_BAND_PREFS.height })
  })
})
