import { describe, expect, it } from 'bun:test'
import {
  ACTIVE_STATES,
  ARRANGEMENTS,
  OFF_STATE,
  DIMENSION_ORDER,
  FILTERS_VERSION,
  GONE_PROJECT_KEY,
  GROUPINGS,
  SESSION_DIMENSIONS,
  SESSION_STATES,
  UNFILED,
  applyShortcut,
  bucketKey,
  dimensionValueLabel,
  dimensionWordBook,
  migrateSessionFilters,
  sessionKept,
  sessionNamed,
  shortcutOn,
  storedFilters,
  toggleValue,
  type SessionDimensionId,
} from './session-dimensions'
import { groupSessions, sessionRows } from './sessions'
import type { ControlSession, SessionState } from './types'

const session = (id: string, over: Partial<ControlSession> = {}): ControlSession => ({
  id,
  title: id,
  harness: 'claude',
  cwd: `/repo/${id}`,
  project: id,
  state: 'waiting' as SessionState,
  stateLabel: 'waiting',
  actionable: true,
  attached: false,
  searchFields: { name: id, folder: '', harness: '', note: '', task: '', prompt: '' },
  ...over,
})

const WORDS = dimensionWordBook({
  labels: {
    day: 'day',
    status: 'state', harness: 'harness', model: 'model', project: 'project', repo: 'repository',
    task: 'task', marked: 'marked',
  },
  unfiled: {
    day: 'no date',
    status: 'state unrecorded', harness: 'harness unknown', model: 'no model', project: 'no dir',
    repo: 'no repository', task: 'no task', marked: 'not marked',
  },
  states: {
    working: 'working', waiting: 'waiting', 'waiting-approval': 'needs approval',
    exited: 'ended', lost: 'lost', closed: 'closed', unknown: 'unknown',
  },
  goneProject: 'directory no longer exists',
  marked: 'marked',
})

/**
 * A fleet with something in EVERY bucket of every dimension, absences included.
 *
 * The cross-check below is only worth as much as this list: a dimension whose UNFILED bucket never
 * occurs here would pass without the case that actually breaks — the one where `keyOf` returns
 * `undefined` and grouping and filtering have to agree about what that means.
 */
const FLEET: ControlSession[] = [
  session('a', { state: 'working', harness: 'claude', model: 'opus', repo: 'org/one', task: 'auth', project: 'app', projectGroup: 'app' }),
  session('b', { state: 'waiting-approval', harness: 'codex', model: 'gpt', repo: 'org/one', task: 'auth', project: 'app', projectGroup: 'app' }),
  session('c', { state: 'closed', harness: 'gemini', repo: 'org/two', project: 'web' }),
  session('d', { state: 'exited', harness: '', project: 'web' }),
  session('e', { state: 'lost', harness: 'claude', model: 'opus', task: 'billing', project: 'gone-wt', dirGone: 'gone' }),
  session('f', { state: 'unknown', harness: 'kimi', project: 'solo' }),
  session('g', { state: 'waiting', harness: 'claude', repo: 'org/two', project: 'web' }),
]

const MARKED = new Set(['a', 'e'])
const CTX = { marked: MARKED }

const ids = (list: readonly ControlSession[]) => list.map(s => s.id).sort()

describe('the table', () => {
  it('declares every dimension in DIMENSION_ORDER, and nothing else', () => {
    // Two lists of one fact is the defect this module exists to remove, so it may not reintroduce
    // one of its own: the ORDER array and the Record must name exactly the same dimensions.
    expect([...DIMENSION_ORDER].sort()).toEqual(Object.keys(SESSION_DIMENSIONS).sort() as SessionDimensionId[])
  })

  it('offers every dimension as a grouping, plus the arrangements that are not dimensions', () => {
    expect(GROUPINGS).toEqual([...ARRANGEMENTS, ...DIMENSION_ORDER])
  })

  it('refuses to make the CASCADE a dimension, or a grouping at all', () => {
    // A tree node is not a bucket on a dimension: a session belongs to EVERY node on its path, so
    // "filter to `packages`" and "the band `packages`" could never be made to agree. The cross-check
    // below asserts exactly that agreement for every id in `DIMENSION_ORDER`, so promoting `tree`
    // would either break it or force a false answer into it.
    //
    // It is not offered as a GROUPING either any more: the cascade is a view drawn inside whatever
    // the bands are, so choosing it must not cost the bands. The id survives in the type because a
    // preferences file written by an older build still carries it, and is migrated on read.
    expect(GROUPINGS).not.toContain('tree')
    expect(DIMENSION_ORDER).not.toContain('tree' as SessionDimensionId)
    expect(Object.keys(SESSION_DIMENSIONS)).not.toContain('tree')
  })

  it('folds every absence into ONE named bucket per dimension', () => {
    expect(bucketKey(session('x'), 'task')).toBe(UNFILED)
    expect(bucketKey(session('x', { harness: '' }), 'harness')).toBe(UNFILED)
    expect(bucketKey(session('x'), 'repo')).toBe(UNFILED)
    expect(bucketKey(session('x'), 'marked', CTX)).toBe(UNFILED)
    expect(dimensionValueLabel(WORDS.task, UNFILED)).toBe('no task')
    expect(dimensionValueLabel(WORDS.repo, UNFILED)).toBe('no repository')
  })

  it('keeps a GONE directory out of the project names', () => {
    // A path that resolves to nothing has no last segment worth trusting, and a group made out of
    // a guess reads exactly like a real project.
    expect(bucketKey(session('e', { project: 'gone-wt', dirGone: 'gone' }), 'project'))
      .toBe(GONE_PROJECT_KEY)
    expect(dimensionValueLabel(WORDS.project, GONE_PROJECT_KEY)).toBe('directory no longer exists')
  })
})

describe('grouping and filtering are the SAME reading', () => {
  it('filtering to one bucket returns exactly the rows that bucket band contains', () => {
    // THE invariant. With grouping and filtering deriving the bucket independently, the chip
    // "status: waiting" and the band "waiting" drift into showing different sets and nothing in the
    // build complains. Asserted for every dimension and every bucket that actually occurs.
    let checked = 0
    for (const id of DIMENSION_ORDER) {
      const bands = groupSessions(FLEET, id, WORDS, [], undefined, CTX)
      expect(bands.length).toBeGreaterThan(0)
      for (const band of bands) {
        const filtered = FLEET.filter(s => sessionKept(s, { filters: { [id]: [band.key] }, ctx: CTX }))
        expect(ids(filtered)).toEqual(ids(band.sessions))
        checked++
      }
    }
    // A guard on the guard: a fleet that produced one band per dimension would pass the loop above
    // while testing almost nothing.
    expect(checked).toBeGreaterThan(DIMENSION_ORDER.length * 2)
  })

  it('selecting every bucket of a dimension keeps the whole fleet', () => {
    for (const id of DIMENSION_ORDER) {
      const keys = groupSessions(FLEET, id, WORDS, [], undefined, CTX).map(b => b.key)
      expect(ids(FLEET.filter(s => sessionKept(s, { filters: { [id]: keys }, ctx: CTX }))))
        .toEqual(ids(FLEET))
    }
  })
})

describe('sessionKept', () => {
  it('treats an absent or empty selection as no opinion, never as "keep nothing"', () => {
    expect(ids(FLEET.filter(s => sessionKept(s, { filters: {} })))).toEqual(ids(FLEET))
    expect(ids(FLEET.filter(s => sessionKept(s, { filters: { task: [] } })))).toEqual(ids(FLEET))
  })

  it('combines dimensions with AND and values with OR', () => {
    const kept = FLEET.filter(s => sessionKept(s, {
      filters: { harness: ['claude', 'codex'], project: ['app'] },
      ctx: CTX,
    }))
    expect(ids(kept)).toEqual(['a', 'b'])
  })

  it('lets showNamed widen the STATUS dimension', () => {
    const named = session('n', { state: 'closed', named: true })
    const anon = session('o', { state: 'closed' })
    const filters = { status: [...ACTIVE_STATES] }
    expect(sessionKept(named, { filters })).toBe(false)
    expect(sessionKept(named, { filters, showNamed: true })).toBe(true)
    expect(sessionKept(anon, { filters, showNamed: true })).toBe(false)
    expect(sessionNamed(named)).toBe(true)
  })

  it('never lets showNamed widen anything ELSE', () => {
    // A named row escaping a project or repo filter is not an exception anyone asked for, and it
    // would make those filters lie in exactly the way the status one used to.
    const named = session('n', { project: 'other', named: true })
    expect(sessionKept(named, { filters: { project: ['app'] }, showNamed: true })).toBe(false)
  })
})

describe('toggleValue', () => {
  it('adds and removes', () => {
    expect(toggleValue(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleValue(['a', 'b'], 'a')).toEqual(['b'])
  })

  it('refuses to empty a selection, and refuses by doing nothing', () => {
    // Unticking the last box never means "show nothing at all", it means the person has run out of
    // boxes. The rule lived as a comment in the component; it lives here now, where the keyboard
    // and the mouse both reach it.
    expect(toggleValue(['a'], 'a')).toEqual(['a'])
  })
})

describe('the status shortcuts', () => {
  it('reads `active` as ON only when the selection is EXACTLY the active states', () => {
    expect(shortcutOn([...ACTIVE_STATES], 'active')).toBe(true)
    expect(shortcutOn([...ACTIVE_STATES, 'closed'], 'active')).toBe(false)
    expect(shortcutOn(['waiting'], 'active')).toBe(false)
  })

  it('reads the widening switch as membership, and it takes ALL of history', () => {
    // There were two switches here and they asked one question. `closed` named a conversation that
    // is not running and `exited` named a finished session plus `lost`; to the person reading the
    // list all three are "it is not running", so ticking either while the other was on appeared to
    // do nothing. One switch, all three states, on together or not at all.
    expect(shortcutOn([...ACTIVE_STATES, 'closed', 'exited', 'lost'], 'history')).toBe(true)
    expect(shortcutOn([...ACTIVE_STATES], 'history')).toBe(false)
    // A PARTIAL selection is not the switch being on: it would draw itself lit over a list missing
    // two of the three states it claims to include.
    expect(shortcutOn([...ACTIVE_STATES, 'closed'], 'history')).toBe(false)
    expect(shortcutOn([...ACTIVE_STATES, 'exited', 'lost'], 'history')).toBe(false)
  })

  it('turns `active` OFF by itself when another switch widens past it', () => {
    // The visible consequence, and the whole point: a switch is never lit over a list it does not
    // describe. This is what the old model could not express — the state set silently overrode the
    // switches while they went on drawing themselves as if they decided anything.
    const widened = applyShortcut([...ACTIVE_STATES], 'history')
    expect(shortcutOn(widened, 'history')).toBe(true)
    expect(shortcutOn(widened, 'active')).toBe(false)
  })

  it('narrows to exactly the active states, and widens to everything', () => {
    expect(applyShortcut([...SESSION_STATES], 'active').sort()).toEqual([...ACTIVE_STATES].sort())
    expect(applyShortcut([...ACTIVE_STATES], 'active').sort()).toEqual([...SESSION_STATES].sort())
  })

  it('never empties the selection', () => {
    expect(applyShortcut(['closed', 'exited', 'lost'], 'history').sort()).toEqual(['closed', 'exited', 'lost'])
  })
})

describe('migrateSessionFilters', () => {
  it('reads a file written by this model', () => {
    const state = migrateSessionFilters({
      filtersVersion: FILTERS_VERSION,
      filters: { status: ['closed'], repo: ['org/one'] },
      showNamed: true,
    })
    expect(state.filters).toEqual({ status: ['closed'], repo: ['org/one'] })
    expect(state.showNamed).toBe(true)
  })

  it('lets the SWITCHES win on an older file, and discards the stored states', () => {
    // The one place this design deliberately drops user input. A stored `states` could only ever
    // have been written while it silently overrode the switches beside it, so the user never saw the
    // two evaluated together and it is not a statement they could have judged.
    const state = migrateSessionFilters({
      onlyActive: true,
      showClosed: false,
      showExited: false,
      states: ['unknown', 'waiting', 'waiting-approval', 'exited', 'lost', 'closed'],
    })
    expect([...state.filters.status!].sort()).toEqual([...ACTIVE_STATES].sort())
  })

  it('reproduces the reporting machine, which is the case it was written for', () => {
    // Measured: `onlyActive: true` on screen, 62 of 65 sessions listed, nearly all of them closed
    // or ended, because the stored `states` was the whole answer. The migration yields the list
    // that machine was asking for.
    const state = migrateSessionFilters({
      onlyActive: true, showClosed: false, showExited: false,
      states: [...SESSION_STATES],
    })
    const kept = FLEET.filter(s => sessionKept(s, state))
    expect(ids(kept)).toEqual(['a', 'b', 'f', 'g'])
  })

  it('migrates EITHER legacy widening switch into the one history bucket', () => {
    // They were independent — `showClosed` for conversations, `showExited` for finished and lost
    // sessions. The bucket is now one, because to the person reading the list all three states
    // answer "it is not running" and a menu offering that three times had two rows doing nothing
    // visible. So either switch on means history is shown.
    //
    // Mapping only one of the two would be worse than not migrating: a stored `showExited: true`
    // would filter for states that no longer key to themselves, and the rows it was meant to reveal
    // would vanish.
    for (const legacy of [
      { onlyActive: false, showClosed: true, showExited: false },
      { onlyActive: false, showClosed: false, showExited: true },
      { onlyActive: false, showClosed: true, showExited: true },
    ]) {
      expect(migrateSessionFilters(legacy).filters.status).toEqual([...ACTIVE_STATES, OFF_STATE])
    }
    // Neither on stays exactly the active set.
    expect(migrateSessionFilters({ onlyActive: false, showClosed: false, showExited: false })
      .filters.status).toEqual([...ACTIVE_STATES])
  })

  it('is idempotent, and never yields an empty status', () => {
    const once = migrateSessionFilters({ onlyActive: false, showClosed: true, showExited: true })
    const twice = migrateSessionFilters(storedFilters(once))
    expect(twice).toEqual(once)
    expect(migrateSessionFilters(undefined).filters.status).toEqual([...ACTIVE_STATES])
    // A stored selection of nothing recognisable is a list that shows nothing, and the never-empty
    // rule applies to a FILE just as it applies to a keypress.
    expect(migrateSessionFilters({ filtersVersion: FILTERS_VERSION, filters: { status: ['junk'] } })
      .filters.status).toEqual([...ACTIVE_STATES])
  })

  it('matches the OLD predicate everywhere except the exception that is now a switch', () => {
    // What proves nothing was changed by accident: only the collision was removed. The old chain,
    // verbatim, minus the named-row clause — which is `showNamed`, and is asserted separately.
    // The old chain, verbatim — except that its two history switches are now ONE, so it is compared
    // only where they agreed. A mixed setting ("show closed but not exited") is no longer
    // expressible, and that is the change, not a regression: the two rows it drew both said "not
    // running" and the user could not tell them apart. The mixed case migrates to the union, which
    // the test above pins.
    const old = (v: ControlSession, o: { onlyActive: boolean; history: boolean }) =>
      (o.onlyActive
        ? (ACTIVE_STATES as readonly string[]).includes(v.state)
        : (o.history || (v.state !== 'closed' && v.state !== 'exited' && v.state !== 'lost')))
    for (const onlyActive of [false, true]) {
      for (const history of [false, true]) {
        const state = migrateSessionFilters({ onlyActive, showClosed: history, showExited: history })
        for (const s of FLEET) {
          expect(sessionKept(s, { filters: state.filters })).toBe(old(s, { onlyActive, history }))
        }
      }
    }
  })
})

describe('storedFilters', () => {
  it('round-trips every dimension, empty selections included', () => {
    const state = { filters: { status: ['closed'], task: [UNFILED] }, showNamed: true, marked: ['a'] }
    expect(migrateSessionFilters(storedFilters(state))).toEqual(state)
  })

  it('round-trips the MARKS, and the empty set is a value', () => {
    // The reported bug: the component wrote `...(marked.size > 0 ? { marked: [...marked] } : {})`,
    // so unmarking everything removed the key rather than writing an empty list — and the next
    // restore read absence, fell back, and resurrected the marks that had just been cleared. A
    // conditional spread cannot express "the answer is nothing", which is why this seam always
    // writes the field.
    const withMarks = { filters: { status: ['closed'] }, showNamed: false, marked: ['a', 'b'] }
    expect(migrateSessionFilters(storedFilters(withMarks)).marked).toEqual(['a', 'b'])

    const cleared = { ...withMarks, marked: [] }
    const stored = storedFilters(cleared)
    expect(stored.marked).toEqual([])
    expect(migrateSessionFilters(stored).marked).toEqual([])

    // And the clearing SURVIVES a second trip, which is where the old bug actually bit: the first
    // write looked fine and the read after it brought the old marks back.
    expect(migrateSessionFilters(storedFilters(migrateSessionFilters(stored))).marked).toEqual([])
  })

  it('reads absence as no marks, never as not-loaded', () => {
    expect(migrateSessionFilters({}).marked).toEqual([])
    expect(migrateSessionFilters(undefined).marked).toEqual([])
  })

  it('writes the legacy switches so an older binary still comes up filtered', () => {
    // Derived on write and never read back except by the migration — same pattern, and the same
    // reason, as `deniedRepos` in the sharing rules. A downgrade must not lift every filter.
    const stored = storedFilters({ filters: { status: [...ACTIVE_STATES] }, showNamed: false, marked: [] })
    expect(stored.onlyActive).toBe(true)
    expect(stored.showClosed).toBe(false)
    expect(stored.showExited).toBe(false)
    expect(stored.states).toEqual([...ACTIVE_STATES])

    const wide = storedFilters({ filters: { status: [...SESSION_STATES] }, showNamed: false, marked: [] })
    expect(wide.onlyActive).toBe(false)
    expect(wide.showClosed).toBe(true)
    expect(wide.showExited).toBe(true)
  })
})

describe('the marked band', () => {
  const band = (grouping: 'none' | SessionDimensionId, ids: string[]) => sessionRows(
    groupSessions(FLEET, grouping, WORDS, [], undefined, CTX),
    'closed', 'finished', undefined,
    ids.length > 0 ? { ids: new Set(ids), label: 'marked' } : undefined,
  )
  const sessionsUnder = (rows: ReturnType<typeof band>, heading: string) => {
    const at = rows.findIndex(r => r.kind === 'heading' && r.label === heading)
    if (at < 0) return null
    const out: string[] = []
    for (let i = at + 1; i < rows.length; i++) {
      const r = rows[i]!
      if (r.kind !== 'session') break
      out.push(r.session.id)
    }
    return out.sort()
  }

  it('leads the list, whatever the arrangement', () => {
    // Marking is the user's and outranks the grouping — `none` included, which is the case a band
    // built inside a group could not have covered.
    for (const grouping of ['none', ...DIMENSION_ORDER] as const) {
      const rows = band(grouping, ['a', 'g'])
      const first = rows.find(r => r.kind === 'heading')
      expect(first).toMatchObject({ label: 'marked', count: 2 })
      expect(sessionsUnder(rows, 'marked')).toEqual(['a', 'g'])
    }
  })

  it('puts a marked row in the band and NOWHERE ELSE', () => {
    // The whole point. The same session in two places is the reason someone was hunting for it in
    // the first place, and a band that merely COPIES the rows makes the list longer and no easier.
    for (const grouping of ['none', ...DIMENSION_ORDER] as const) {
      const rows = band(grouping, ['a', 'g'])
      const appearances = rows.filter(r => r.kind === 'session' && (r.session.id === 'a' || r.session.id === 'g'))
      expect(appearances).toHaveLength(2)
      // And nothing else was dropped on the way.
      expect(rows.filter(r => r.kind === 'session')).toHaveLength(FLEET.length)
    }
  })

  it('takes a marked row out of HISTORY too, not just out of the live block', () => {
    // `c` is closed and `e` is lost. Both would otherwise sit under the history heading, which is
    // exactly where a marked row is hardest to find.
    const rows = band('project', ['c', 'e'])
    expect(sessionsUnder(rows, 'marked')).toEqual(['c', 'e'])
    // The marked band is the ONLY place either of them appears. Closed rows now continue under
    // their own group's heading rather than under a suffixed one, so the assertion is about the
    // whole list below the band rather than about a block with `closed` in its name.
    const bandAt = rows.findIndex(r => r.kind === 'heading' && r.label === 'marked')
    expect(bandAt).toBeGreaterThanOrEqual(0)
    const after = rows.slice(bandAt + 1)
    const nextHeading = after.findIndex(r => r.kind === 'heading')
    for (const r of after.slice(nextHeading)) {
      if (r.kind === 'session') expect(['c', 'e']).not.toContain(r.session.id)
    }
  })

  it('does not exist at all when nothing is marked', () => {
    // Not an empty band — no band. A heading with no rows under it is a box with a name in it.
    const rows = band('project', [])
    expect(rows.some(r => r.kind === 'heading' && r.label === 'marked')).toBe(false)
    expect(rows.filter(r => r.kind === 'session')).toHaveLength(FLEET.length)
  })

  it('leaves a group EMPTIED by the band drawing nothing, rather than a bare heading', () => {
    // `f` is the only session in project `solo`; marking it must not leave `solo` standing with a
    // count of zero.
    const rows = band('project', ['f'])
    expect(rows.some(r => r.kind === 'heading' && r.label === 'solo')).toBe(false)
    expect(sessionsUnder(rows, 'marked')).toEqual(['f'])
  })
})
