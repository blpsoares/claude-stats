import { test, expect, describe, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildConfirmMessage, ReadView } from './SharedReposPanel'
import { MaximizedRestrictions } from './RestrictionMiniTable'
import { COPY, interpolate } from './copy'
import type { ShareTarget, ProjectTarget } from '../../lib/shareRepos'
import { NO_REPO_KEY, type SiblingRuleFact } from '@agentistics/core'

/**
 * SharedReposPanel.test.ts — covers the one piece of `SharedReposPanel.tsx` worth testing outside
 * a DOM runner: `buildConfirmMessage`, the plain-string builder fed to `ConfirmModal.message`.
 *
 * Review fix (Important 1): the confirm modal must state the impact — the edit view's own
 * `applyImpact` line sits behind the modal's blur the moment it opens, so the number the user is
 * actually confirming has to be IN the modal, not merely visible somewhere behind it.
 */

test('the confirm message states the impact (session count and cost) when something is newly blocked', () => {
  const msg = buildConfirmMessage('generic', null, { sessions: 4, costUSD: 1.2345 }, 'none', 'en')
  expect(msg).toContain('4 sessions')
  expect(msg).toContain('1.23') // fmtCost's formatted amount — exact currency prefix not asserted
  expect(msg).toContain('Removes')
})

test('the confirm message omits the impact sentence entirely when nothing is newly blocked (sessions === 0)', () => {
  const msg = buildConfirmMessage('generic', null, { sessions: 0, costUSD: 0 }, 'none', 'en')
  expect(msg).not.toContain('Removes')
})

test('the confirm message includes the stats clause when boundary/prehistorySessions are known, and the proven clause only in the proven variant', () => {
  const stats = { boundary: '2026-06-01', n: 12 }
  const generic = buildConfirmMessage('generic', stats, { sessions: 0, costUSD: 0 }, 'none', 'en')
  expect(generic).toContain('2026-06-01')
  expect(generic).toContain('12')

  const proven = buildConfirmMessage('proven', stats, { sessions: 0, costUSD: 0 }, 'none', 'en')
  expect(proven).toContain('2026-06-01')
  // The proven sentence is strictly additional — the generic clause's own boundary mention plus
  // the proven clause's own boundary mention.
  expect(proven.length).toBeGreaterThan(generic.length)
})

test('the confirm message omits the stats clause entirely when boundary is unknowable (null)', () => {
  const msg = buildConfirmMessage('generic', null, { sessions: 0, costUSD: 0 }, 'none', 'en')
  // No stray, invented numbers from a stats clause that was never built.
  expect(msg).not.toContain('undefined')
  expect(msg).not.toContain('null')
})

test('works in Portuguese too — the body text is language-specific, the numbers are not', () => {
  const msg = buildConfirmMessage('generic', null, { sessions: 7, costUSD: 0.5 }, 'none', 'pt')
  expect(msg).toContain('7')
  expect(msg.toLowerCase()).toContain('apaga')
})

// --- Plan 4 Task 7: the mode-switch sentence, appended only when the mode actually changed -------

test('modeVariant "none" appends no mode sentence at all', () => {
  const msg = buildConfirmMessage('generic', null, { sessions: 0, costUSD: 0 }, 'none', 'en')
  expect(msg).not.toContain(COPY.modeConfirmToAllowlist.en)
  expect(msg).not.toContain(COPY.modeConfirmToDenylist.en)
})

test('modeVariant "toAllowlist" appends the allowlist-switch consequence, never the denylist one', () => {
  const msg = buildConfirmMessage('generic', null, { sessions: 0, costUSD: 0 }, 'toAllowlist', 'en')
  expect(msg).toContain(COPY.modeConfirmToAllowlist.en)
  expect(msg).not.toContain(COPY.modeConfirmToDenylist.en)
})

test('modeVariant "toDenylist" appends the denylist-switch consequence, never the allowlist one', () => {
  const msg = buildConfirmMessage('generic', null, { sessions: 0, costUSD: 0 }, 'toDenylist', 'en')
  expect(msg).toContain(COPY.modeConfirmToDenylist.en)
  expect(msg).not.toContain(COPY.modeConfirmToAllowlist.en)
})

// --- the hidden block is a TABLE of what is not shared, and where else it is restricted --------

/** `ReadView` holds no hooks — a plain function of its props — so it can be called directly and
 *  its returned element tree walked like a shallow render, the same technique
 *  `SharingRulesPicker.test.tsx` uses. */
function collectSpans(el: unknown, out: { props: Record<string, unknown> }[] = []): { props: Record<string, unknown> }[] {
  if (!el || typeof el !== 'object') return out
  const node = el as { type?: unknown; props?: { children?: unknown } }
  if (node.type === 'span') out.push(node as { props: Record<string, unknown> })
  const kids = node.props?.children
  const list = Array.isArray(kids) ? kids : kids !== undefined ? [kids] : []
  for (const k of list) collectSpans(k, out)
  return out
}

/** Every string the tree would print, flattened — what the user can actually read. */
function texts(el: unknown, out: string[] = []): string[] {
  if (typeof el === 'string') { out.push(el); return out }
  if (typeof el === 'number') { out.push(String(el)); return out }
  if (!el || typeof el !== 'object') return out
  const kids = (el as { props?: { children?: unknown } }).props?.children
  const list = Array.isArray(kids) ? kids : kids !== undefined ? [kids] : []
  for (const k of list) texts(k, out)
  return out
}

const repoTarget: ShareTarget = {
  key: 'github.com/acme/api', kind: 'repo', name: 'acme/api', host: 'github.com',
  sessions: 3, lastActive: '', orphan: false, conflictPaths: [],
}
const projectTarget: ProjectTarget = {
  key: '/home/acme/api', kind: 'project', name: 'api', path: '/home/acme/api',
  repoKey: 'github.com/acme/api', sessions: 3, lastActive: '', locked: false,
}

const sibling = (over: Partial<SiblingRuleFact> & { machineId: string }): SiblingRuleFact => ({
  machineName: over.machineId,
  shareMode: 'denylist',
  sources: [],
  at: '2026-07-31T10:00:00.000Z',
  receivedAt: '2026-07-31T10:00:05.000Z',
  ...over,
})

function denylistView(over: Partial<Parameters<typeof ReadView>[0]> = {}) {
  return ReadView({
    targets: [repoTarget], projectTargets: [projectTarget],
    sources: [{ type: 'repo', value: repoTarget.key }],
    storedDenied: new Set([repoTarget.key]), storedProjectPaths: new Set(),
    mode: 'denylist', sessions: [], status: undefined, lang: 'en', otelEnabled: false,
    siblingRules: [],
    ...over,
  })
}

test('a hidden entry states WHAT it is: the name and its dimension, never one undifferentiated blob', () => {
  const printed = texts(denylistView({
    sources: [{ type: 'repo', value: repoTarget.key }, { type: 'project', value: projectTarget.path }],
    storedDenied: new Set([repoTarget.key]), storedProjectPaths: new Set([projectTarget.path]),
  }))
  expect(printed).toContain('acme/api')
  expect(printed).toContain(COPY.rowTagRepo.en)
  expect(printed).toContain(COPY.rowTagProject.en)
})

test('a hidden entry separates the machines that HIDE it from the ones that still share it', () => {
  const printed = texts(denylistView({
    siblingRules: [
      sibling({ machineId: 'm1', machineName: 'Alienware', sources: [{ type: 'repo', value: repoTarget.key }] }),
      sibling({ machineId: 'm2', machineName: 'Laptop B', sources: [] }),
    ],
  }))
  // The table's two machine columns, by name — not a single "elsewhere" sentence.
  expect(printed).toContain(COPY.colHiddenWhat.en)
  expect(printed).toContain(COPY.colHiddenOn.en)
  expect(printed).toContain(COPY.colStillSharedOn.en)

  // Cell-scoped, not line-scoped: the whole point is that the two machines land in DIFFERENT
  // cells. Asserting against the concatenated row would pass even if they were swapped.
  const hiddenCell = printed.find(t => t.includes('Alienware'))
  expect(hiddenCell).toBeDefined()
  // The machine that restricts it is in the "hidden on" cell, together with this machine…
  expect(hiddenCell).toContain(COPY.peersSelf.en)
  // …and the machine that does NOT restrict it is never in that cell — the opposite claim.
  expect(hiddenCell).not.toContain('Laptop B')
  // It is not dropped either: it belongs to the other column, which is new information the
  // stacked rows could not carry at all.
  const sharedCell = printed.find(t => t.includes('Laptop B'))
  expect(sharedCell).toBeDefined()
  expect(sharedCell).not.toContain('Alienware')
})

test('a row with no sibling information SAYS so — an empty cell would read as "nowhere else"', () => {
  // In this scope THIS machine is always in the "hidden on" cell, so a cell reading only "This
  // machine" would silently imply no other machine of yours restricts it. It cannot: it knows only
  // what siblings announced. The words have to be there.
  const printed = texts(denylistView({ siblingRules: [] }))
  expect(printed).toContain(COPY.rowNoOtherMachine.en)
  expect(texts(denylistView({ siblingRules: [], lang: 'pt' }))).toContain(COPY.rowNoOtherMachine.pt)
})

test('nothing in the block is alarm-coloured: every entry is there because the user chose it', () => {
  const spans = collectSpans(denylistView({
    siblingRules: [sibling({ machineId: 'm1', machineName: 'Alienware', sources: [{ type: 'repo', value: repoTarget.key }] })],
  }))
  expect(spans.length).toBeGreaterThan(0)
  let checked = 0
  for (const span of spans) {
    const style = JSON.stringify(span.props.style ?? {})
    expect(style).not.toContain('accent-red')
    expect(style).not.toContain('anthropic-orange')
    checked++
  }
  expect(checked).toBe(spans.length)
})

test('the unattributed bucket reads as its label, never a raw sentinel key', () => {
  const printed = texts(denylistView({
    sources: [{ type: 'none', value: '' }],
    storedDenied: new Set([NO_REPO_KEY]), storedProjectPaths: new Set(),
  })).join(' | ')
  expect(printed).toContain(COPY.noRepoTitle.en)
  expect(printed).not.toContain(NO_REPO_KEY)
})

test('the allowlist read view keeps its own positive polarity — no "hidden" framing is forced on it', () => {
  const el = ReadView({
    targets: [repoTarget], projectTargets: [],
    sources: [{ type: 'repo', value: repoTarget.key }],
    storedDenied: new Set([repoTarget.key]), storedProjectPaths: new Set(),
    mode: 'allowlist', sessions: [], status: undefined, lang: 'en', otelEnabled: false, siblingRules: [],
  })
  const printed = texts(el)
  expect(printed.join(' ')).toContain('Shared with this central')
  expect(printed.join(' ')).not.toContain('Hidden from this central')
  const spans = collectSpans(el)
  expect(spans.length).toBeGreaterThan(0)
  for (const span of spans) {
    expect(String((span.props.style as Record<string, unknown>)?.color ?? '')).not.toContain('accent-red')
  }
})

describe('the rules editor is the drawer, not a bespoke inline panel', () => {
  const src = readFileSync(join(import.meta.dir, 'SharedReposPanel.tsx'), 'utf8')

  it('renders the picker inside the same right-side Drawer the add-central wizard uses', () => {
    expect(src).toContain("import Drawer from '../../pages/settings/Drawer'")
    expect(src).toMatch(/<Drawer[\s\S]*<SharingRulesPicker/)
  })

  it('has no inline edit mode left — Section never renders an editor of its own here', () => {
    // The duplicate is deleted, not merely bypassed: `editing` may not reach Section, or the panel
    // would have two editors again the first time someone "restores" the prop.
    expect(src).toContain('editing={false}')
    expect(src).toContain('editChildren={null}')
  })

  it('the drawer guards unsaved rules on close, like every other drawer', () => {
    expect(src).toMatch(/dirty=\{dirty\}/)
  })

  it('the hidden block reuses the notices modal\'s builder — one implementation, two surfaces', () => {
    expect(src).toContain('buildRestrictionTable')
    expect(src).toContain("scope: 'selfRestricted'")
    // The chips, and the alarm colour that carried their whole meaning, are gone for good.
    expect(src).not.toContain('hiddenChipStyle')
    expect(src).not.toContain('EyeOff')
    // The honesty guard the sibling column needs, stated where it qualifies something.
    expect(src).toContain('COPY.siblingWithholdBestEffort[lang]')
  })
})

// --- the hidden block is a TABLE, with two sizes ------------------------------------------------

/** A denylist view holding `n` hidden repositories, so paging has something to page. */
function manyHidden(n: number, over: Partial<Parameters<typeof ReadView>[0]> = {}) {
  const targets = Array.from({ length: n }, (_, i) => ({
    // Zero-padded so lexicographic order (which the block sorts by) matches numeric order —
    // otherwise `r10` sorts between `r1` and `r2` and the page boundaries are meaningless.
    ...repoTarget, key: `github.com/acme/r${String(i).padStart(2, '0')}`, name: `acme/r${String(i).padStart(2, '0')}`,
  }))
  return ReadView({
    targets, projectTargets: [],
    sources: targets.map(t => ({ type: 'repo' as const, value: t.key })),
    storedDenied: new Set(targets.map(t => t.key)), storedProjectPaths: new Set(),
    mode: 'denylist', sessions: [], status: undefined, lang: 'en', otelEnabled: false,
    siblingRules: [],
    ...over,
  })
}

test('the inline preview shows five rows and pages the rest — it never dumps the whole list into a card', () => {
  const printed = texts(manyHidden(13)).join(' | ')
  expect(printed).toContain('acme/r00')
  expect(printed).toContain('acme/r04')
  // Row six onwards is on the next page, not in the card.
  expect(printed).not.toContain('acme/r05')
  expect(printed).toContain(interpolate(COPY.tablePageOf.en, { page: 1, total: 3 }))
})

test('a list that fits on one page renders no pager at all', () => {
  const printed = texts(manyHidden(3)).join(' | ')
  expect(printed).toContain('acme/r02')
  expect(printed).not.toContain('Page 1 of 1')
})

test('the caller may drive the page, and the window follows', () => {
  const page2 = texts(manyHidden(13, {
    table: { page: 1, size: 5, onPage: () => {}, onSize: () => {}, onMaximize: () => {} },
  })).join(' | ')
  expect(page2).toContain('acme/r05')
  expect(page2).toContain('acme/r09')
  expect(page2).not.toContain('acme/r00')
  expect(page2).not.toContain('acme/r10')
})

test('the maximize affordance appears only when the caller can act on it', () => {
  // Without table state (a bare render) there is nothing to open, so the button must not be a
  // dead control sitting on the card.
  expect(texts(manyHidden(13)).join(' | ')).not.toContain(COPY.tableMaximize.en)
  const withState = texts(manyHidden(13, {
    table: { page: 0, size: 5, onPage: () => {}, onSize: () => {}, onMaximize: () => {} },
  })).join(' | ')
  expect(withState).toContain(COPY.tableMaximize.en)
})

test('the maximized view is a dialog that says how to leave, and carries the caveat with it', () => {
  const el = MaximizedRestrictions({
    rows: [], labelOf: () => 'x', lang: 'en', isMobile: false,
    page: 0, size: 10, onPage: () => {}, onSize: () => {}, onClose: () => {},
  })
  const props = (el as { props: Record<string, unknown> }).props
  expect(props.role).toBe('dialog')
  expect(props['aria-modal']).toBe('true')
  const printed = texts(el).join(' | ')
  expect(printed).toContain(COPY.tableRestore.en)
  // The best-effort clause qualifies both machine columns and must travel with the table.
  expect(printed).toContain(COPY.siblingWithholdBestEffort.en)
})

describe('the table\'s two sizes and its keyboard/mobile behaviour', () => {
  const src = readFileSync(join(import.meta.dir, 'SharedReposPanel.tsx'), 'utf8')
  const table = readFileSync(join(import.meta.dir, 'RestrictionMiniTable.tsx'), 'utf8')

  it('esc dismisses the maximized view and focus returns where it came from', () => {
    expect(src).toContain("e.key === 'Escape'")
    // Not merely closed: a keyboard user dropped at the top of the document has lost their place.
    expect(src).toContain('maximizeOrigin.current?.focus?.()')
    expect(src).toContain('document.activeElement')
  })

  it('entering and leaving the maximized view re-seeds a size that mode actually offers', () => {
    // Inline stops at 15 and maximized starts at 10; carrying a size across would leave the select
    // showing a value it does not list (and, worse, 50 rows inside a card).
    expect(src).toContain('PAGE_SIZE_OPTIONS.maximized[0]')
    expect(src).toContain('PAGE_SIZE_OPTIONS.inline[0]')
  })

  it('a phone gets stacked cards, and the sideways scroll belongs to the table, never the page', () => {
    expect(table).toContain('isMobile')
    // The <table> element is desktop-only…
    expect(/isMobile\s*\n?\s*\?/.test(table)).toBe(true)
    // …and its overflow box is on the table's own container.
    expect(table).toContain("overflowX: 'auto'")
    // Touch targets on every control the phone can reach — counted across BOTH ways of giving one.
    // A control can pay its 44px in PAINT (`minHeight: isMobile ? 44`) or take it from the
    // projected box (`.ag-tap` / `.ag-tap-icon`, index.css), and the pager moved to the second so
    // it would stop being taller than the rows it pages through. Counting only the first spelling
    // made this fail on a control that had not lost its target at all.
    const painted = table.match(/minHeight: isMobile \? 44/g)?.length ?? 0
    const projected = table.match(/ag-tap(-icon)?/g)?.length ?? 0
    expect(painted + projected).toBeGreaterThanOrEqual(2)
    // A <select> under 16px zooms iOS Safari and breaks the sticky header.
    expect(table).toContain('fontSize: isMobile ? 16')
  })

  it('still one builder — the maximized view does not re-derive what is hidden', () => {
    expect(src.match(/buildRestrictionTable/g)?.length).toBeGreaterThanOrEqual(2)
    expect(src.match(/scope: 'selfRestricted'/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

// --- it has to READ as a table ------------------------------------------------------------------
//
// It was already a `<table>` element and still did not look like one: a faint 10px heading with no
// ground of its own, no frame, and cell padding tight enough that the rows ran together. Semantics
// are what a screen reader gets; a header band, an outer frame and consistent cells are what an eye
// gets, and the second one is what was missing. These assertions are about the SECOND.

/** Depth-first: every element in the tree whose `type` is this intrinsic tag. */
function tags(el: unknown, tag: string): { props: Record<string, unknown> }[] {
  const out: { props: Record<string, unknown> }[] = []
  const walk = (n: unknown): void => {
    if (n === null || n === undefined || typeof n !== 'object') return
    if (Array.isArray(n)) { n.forEach(walk); return }
    const node = n as { type?: unknown; props?: Record<string, unknown> }
    if (node.type === tag && node.props) out.push(node as { props: Record<string, unknown> })
    if (node.props) walk(node.props.children)
  }
  walk(el)
  return out
}

describe('the hidden-restrictions summary reads as a table, not as styled divs', () => {
  const table = readFileSync(join(import.meta.dir, 'RestrictionMiniTable.tsx'), 'utf8')
  const desktop = () => manyHidden(3, {
    table: { page: 0, size: 5, onPage: () => {}, onSize: () => {}, onMaximize: () => {} },
  })

  it('has real column headers, and they are visually a BAND — distinct from the body', () => {
    const head = tags(desktop(), 'thead')
    expect(head.length).toBe(1)
    const ths = tags(desktop(), 'th')
    expect(ths.length).toBe(3)
    for (const th of ths) {
      // Semantics: the strongest signal for a screen reader, and free with a real <table>.
      expect(th.props.scope).toBe('col')
      const s = (th.props.style ?? {}) as Record<string, unknown>
      // …and for an eye: its own ground plus a rule under it. A heading that shares the body's
      // background is a first row, not a header.
      expect(s.background).toBeTruthy()
      expect(String(s.borderBottom ?? '')).toContain('solid')
      expect(s.textTransform).toBe('uppercase')
      // Generous enough not to feel cramped — the complaint that started this.
      expect(String(s.padding ?? '')).toMatch(/\d/)
    }
  })

  it('the three headers are the three columns, in both languages', () => {
    for (const lang of ['en', 'pt'] as const) {
      const ths = tags(manyHidden(3, {
        lang,
        table: { page: 0, size: 5, onPage: () => {}, onSize: () => {}, onMaximize: () => {} },
      }), 'th')
      expect(ths.map(t => t.props.children)).toEqual([
        COPY.colHiddenWhat[lang], COPY.colHiddenOn[lang], COPY.colStillSharedOn[lang],
      ])
    }
  })

  it('columns align down the page — fixed layout with a declared width per column', () => {
    // Every row its own little block is what made nothing line up. `table-layout: fixed` plus a
    // width per column is what makes the second row's cells sit under the first's.
    expect(table).toContain("tableLayout: 'fixed'")
    for (const th of tags(desktop(), 'th')) {
      expect(String((th.props.style as Record<string, unknown>).width ?? '')).toMatch(/%$/)
    }
    // The frame is what turns three aligned columns into one OBJECT on the card.
    expect(/borderRadius:\s*\d+/.test(table)).toBe(true)
    expect(table).toContain('TABLE_FRAME')
  })

  it('row separation is quiet, and it is hairlines OR zebra — never both', () => {
    const bodyRows = tags(desktop(), 'tbody').flatMap(b => tags(b.props.children, 'tr'))
    expect(bodyRows.length).toBe(3)
    const styleOf = (r: { props: Record<string, unknown> }) => (r.props.style ?? {}) as Record<string, unknown>
    const striped = bodyRows.filter(r => Boolean(styleOf(r).background))
    const ruled = bodyRows.filter(r => Boolean(styleOf(r).borderTop))
    expect(striped.length > 0 && ruled.length > 0).toBe(false)
    expect(striped.length + ruled.length).toBeGreaterThan(0)
  })

  it('digits that stack are tabular — the "+N" column must not jitter row to row', () => {
    expect(table).toContain("fontVariantNumeric: 'tabular-nums'")
  })

  it('a phone gets stacked cards and NO <table> at all', () => {
    const phone = manyHidden(3, {
      isMobile: true,
      table: { page: 0, size: 5, onPage: () => {}, onSize: () => {}, onMaximize: () => {} },
    })
    expect(tags(phone, 'table').length).toBe(0)
    expect(tags(phone, 'th').length).toBe(0)
    // Same data, same order — the cards are a layout, never a different answer.
    expect(texts(phone).join(' | ')).toContain('acme/r02')
  })

  it('keeps everything the previous round got right', () => {
    // The dimension in words, the honest sentence when no sibling announced anything, and the
    // truthful "+N" — none of them is decoration that a nicer table may drop.
    const printed = texts(desktop()).join(' | ')
    expect(printed).toContain(COPY.rowTagRepo.en)
    expect(printed).toContain(COPY.rowNoOtherMachine.en)
    expect(table).toContain('moreMachines')
  })
})
