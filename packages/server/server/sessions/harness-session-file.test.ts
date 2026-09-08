import { describe, expect, it } from 'bun:test'
import { HARNESS_ORDER } from '@agentistics/core'
import {
  HARNESS_PROCESS_LOGS, HARNESS_SESSION_SOURCES, chosenName, parseHarnessSessionFile, pickTitle,
  tmuxSessionName,
} from './harness-session-file'

/**
 * VERBATIM from `~/.claude/sessions/` on 2026-08-14, claude 2.1.232 — the two shapes that matter.
 * The `.key` sibling files in that directory are not records and are excluded by `matches`.
 */
const NAMED_BY_USER = {
  pid: 10259,
  sessionId: 'b9665719-4a7a-4253-ac9e-d90f9ae86599',
  cwd: '/home/mithrandir/aipe',
  startedAt: 1786675466447,
  version: '2.1.232',
  kind: 'interactive',
  tmux: 'agentop-ebd7dedf2e:@2.%2',
  name: 'principal do cockpit',
  nameSince: 1786675466447,
  status: 'waiting',
  waitingFor: 'input needed',
}

const NAMED_BY_CLAUDE = {
  pid: 1032969,
  sessionId: '4ebcabfe-8016-4ef5-bed0-f58fff00dc40',
  cwd: '/home/mithrandir/agentistics',
  name: 'agentistics-77',
  nameSource: 'derived',
}

describe('parseHarnessSessionFile', () => {
  it('reads the fields anything downstream relies on', () => {
    const f = parseHarnessSessionFile(NAMED_BY_USER)!
    expect(f.pid).toBe(10259)
    expect(f.sessionId).toBe('b9665719-4a7a-4253-ac9e-d90f9ae86599')
    expect(f.name).toBe('principal do cockpit')
    expect(f.nameSince).toBe(1786675466447)
    expect(f.tmux).toBe('agentop-ebd7dedf2e:@2.%2')
  })

  it('drops a field of the wrong type rather than the record', () => {
    // Undocumented, internal format: a release that changes one field's shape must cost that field
    // and nothing else. Same discipline as `antigravity-protobuf.ts`, which never throws.
    const f = parseHarnessSessionFile({ ...NAMED_BY_USER, pid: 'ten', nameSince: 'today' })!
    expect(f.pid).toBeUndefined()
    expect(f.nameSince).toBeUndefined()
    expect(f.sessionId).toBe('b9665719-4a7a-4253-ac9e-d90f9ae86599')
  })

  it('is null for anything that is not an object, and never throws', () => {
    expect(parseHarnessSessionFile(null)).toBeNull()
    expect(parseHarnessSessionFile('{}')).toBeNull()
    expect(parseHarnessSessionFile([1, 2])).toBeNull()
    expect(parseHarnessSessionFile(undefined)).toBeNull()
  })

  it('treats an empty string as absent, never as a name of ""', () => {
    expect(parseHarnessSessionFile({ name: '', cwd: '' })).toEqual({})
  })
})

describe('chosenName', () => {
  it('is the name a PERSON typed', () => {
    expect(chosenName(parseHarnessSessionFile(NAMED_BY_USER)!)).toBe('principal do cockpit')
  })

  it('is nothing when the harness made the name up', () => {
    // Measured on this machine: 24 of 40 named session files are `derived`. Letting `agentistics-77`
    // replace a label somebody typed in agentop is the "reopen renamed the row back to the
    // transcript's title" bug wearing a new hat.
    expect(chosenName(parseHarnessSessionFile(NAMED_BY_CLAUDE)!)).toBeUndefined()
  })

  it('is nothing when there is no file or no name', () => {
    expect(chosenName(undefined)).toBeUndefined()
    expect(chosenName({})).toBeUndefined()
  })
})

describe('tmuxSessionName', () => {
  it('takes the session, dropping the window and the pane', () => {
    // A session of ours is one window with one pane; the id is the only part naming anything we hold.
    expect(tmuxSessionName({ tmux: 'agentop-ebd7dedf2e:@2.%2' })).toBe('agentop-ebd7dedf2e')
  })

  it('is nothing when the harness is not under tmux at all', () => {
    expect(tmuxSessionName({})).toBeUndefined()
    expect(tmuxSessionName(undefined)).toBeUndefined()
    expect(tmuxSessionName({ tmux: ':@2.%2' })).toBeUndefined()
  })
})

describe('pickTitle', () => {
  const fallback = 'claude in tmp'

  it('falls back when nobody has named anything, and SAYS it is derived', () => {
    expect(pickTitle({ fallback })).toEqual({ title: fallback, source: 'derived' })
  })

  it('takes the only name there is, from either side', () => {
    expect(pickTitle({ label: 'Principal', fallback }))
      .toEqual({ title: 'Principal', source: 'label' })
    expect(pickTitle({ file: { name: 'principal do cockpit' }, fallback }))
      .toEqual({ title: 'principal do cockpit', source: 'harness' })
  })

  it('prefers the typed name over a COLLISION of that same name', () => {
    // Measured on a real machine on 2026-08-15: the row labelled `Principal` was listed as
    // `principal do cockpit-zippy-conway`. A collision name is the user's own with a suffix the
    // harness appended, so handing the row to the harness shows a mangled copy in preference to the
    // original — which is the whole of the complaint "the real name still isn't prevailing".
    expect(pickTitle({
      label: 'Principal',
      file: { name: 'principal do cockpit-zippy-conway', nameSource: 'collision' },
      fallback,
    })).toEqual({ title: 'Principal', source: 'label', other: 'principal do cockpit-zippy-conway' })
  })

  it('still lets a real /rename inside the session win when neither side is dated', () => {
    // The mirror complaint, and the reason the collision rule above is narrow rather than a flipped
    // default: a name typed with `/rename` carries NO `nameSource`, so it is untouched.
    expect(pickTitle({
      label: 'Principal',
      file: { name: 'renamed inside the session' },
      fallback,
    })).toEqual({ title: 'renamed inside the session', source: 'harness', other: 'Principal' })
  })

  it('ignores a name the harness invented, whatever else is true', () => {
    expect(pickTitle({ file: { name: 'aipe-c9', nameSource: 'derived' }, fallback }))
      .toEqual({ title: fallback, source: 'derived' })
    expect(pickTitle({
      label: 'Principal', file: { name: 'aipe-c9', nameSource: 'derived' }, fallback,
    })).toEqual({ title: 'Principal', source: 'label' })
  })

  it('takes the NEWER name when both sides said when', () => {
    const file = { name: 'principal do cockpit', nameSince: 200 }
    expect(pickTitle({ label: 'Principal', labelSince: 100, file, fallback }))
      .toEqual({ title: 'principal do cockpit', source: 'harness', other: 'Principal' })
    expect(pickTitle({ label: 'Principal', labelSince: 300, file, fallback }))
      .toEqual({ title: 'Principal', source: 'label', other: 'principal do cockpit' })
  })

  it('takes the HARNESS name when the timestamps cannot be compared', () => {
    // The judgement call, and the reason it goes this way: `nameSince` exists only from claude
    // 2.1.232, so on today's machines the recency branch above almost never fires — and the
    // complaint that produced this feature is exactly someone renaming inside the session and
    // agentop going on showing its own older label.
    expect(pickTitle({ label: 'Principal', file: { name: 'principal do cockpit' }, fallback }))
      .toEqual({ title: 'principal do cockpit', source: 'harness', other: 'Principal' })
  })

  it('NEVER throws either name away when they disagree', () => {
    // A rename that vanishes without a word is indistinguishable from a rename that failed.
    for (const labelSince of [undefined, 1, 999]) {
      const picked = pickTitle({
        label: 'A', ...(labelSince ? { labelSince } : {}),
        file: { name: 'B', nameSince: 500 }, fallback,
      })
      expect([picked.title, picked.other].sort()).toEqual(['A', 'B'])
    }
  })

  it('says nothing about a second name when the two agree', () => {
    const picked = pickTitle({ label: 'same', file: { name: 'same' }, fallback })
    expect(picked.other).toBeUndefined()
  })

  it('treats a blank label as no label', () => {
    expect(pickTitle({ label: '   ', fallback })).toEqual({ title: fallback, source: 'derived' })
  })
})

describe('HARNESS_SESSION_SOURCES', () => {
  it('has decided about every harness — absence is a decision', () => {
    expect(Object.keys(HARNESS_SESSION_SOURCES).sort()).toEqual([...HARNESS_ORDER].sort())
  })

  it('is claude only, because this is a Claude Code specific file', () => {
    for (const id of HARNESS_ORDER) {
      if (id === 'claude') expect(HARNESS_SESSION_SOURCES[id]).not.toBeNull()
      else expect(HARNESS_SESSION_SOURCES[id], id).toBeNull()
    }
  })

  it('matches the session records and NOT the key files beside them', () => {
    const { matches } = HARNESS_SESSION_SOURCES.claude!
    expect(matches.test('10259.json')).toBe(true)
    expect(matches.test('10259.1d78a4b41b072a6ab45882018ce6922232c6d996cb91d247fa18d79bfad5ac6b.key'))
      .toBe(false)
    expect(matches.test('notes.json')).toBe(false)
  })
})

describe('chosenName — the nameSource values seen in real files', () => {
  it('keeps a COLLISION name: it is the user own, with a disambiguator', () => {
    // Observed on 2026-08-14: `principal do cockpit-mutable-spring`, written when two sessions
    // chose the same name. Rejecting it would delete something a person typed.
    expect(chosenName({
      name: 'principal do cockpit-mutable-spring', nameSource: 'collision',
    })).toBe('principal do cockpit-mutable-spring')
  })

  it('keeps a name whose source this module has never seen', () => {
    // A rejection list, not an allow list. An unknown fourth value in an undocumented, internal
    // format must not silently blank a name.
    expect(chosenName({ name: 'whatever', nameSource: 'something-new' })).toBe('whatever')
  })
})

/**
 * The second shape a harness can record its own live session in: not a file it writes ABOUT the
 * session, but the log it keeps open FOR the process. Kept as its own table rather than widened
 * into `HARNESS_SESSION_SOURCES`, whose every rule ("a directory of JSON records keyed by pid")
 * would have had to be qualified — two shapes under one name is two sets of rules.
 */
describe('HARNESS_PROCESS_LOGS', () => {
  it('has decided about every harness — absence is a decision', () => {
    expect(Object.keys(HARNESS_PROCESS_LOGS).sort()).toEqual([...HARNESS_ORDER].sort())
  })

  it('is antigravity only, because it is the one harness with no other way to be linked', () => {
    for (const id of HARNESS_ORDER) {
      if (id === 'antigravity') expect(HARNESS_PROCESS_LOGS[id]).not.toBeNull()
      else expect(HARNESS_PROCESS_LOGS[id], id).toBeNull()
    }
  })

  it('reads a real captured line through the table, not only through the module', () => {
    const src = HARNESS_PROCESS_LOGS.antigravity!
    expect(src.conversationFrom(
      'ERROR: logging before google.Init: I0908 10:03:58.569478     218 server.go:1153] '
      + 'Created conversation 39783297-b1b0-49bf-9f56-b809ee1933db',
    )).toBe('39783297-b1b0-49bf-9f56-b809ee1933db')
    expect(src.logFromFds([
      '/dev/pts/3', '/home/mithrandir/.gemini/antigravity-cli/log/cli-20260908_100356.log',
    ])).toBe('/home/mithrandir/.gemini/antigravity-cli/log/cli-20260908_100356.log')
  })
})
