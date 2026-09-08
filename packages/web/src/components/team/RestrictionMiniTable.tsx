import React from 'react'
import { Maximize2, X } from 'lucide-react'
import { COPY, interpolate } from './copy'
import type { RestrictionRow, RestrictionMachine } from './restrictionTable'
import { resolvePaging, machineCell, type PagingMode } from './tablePaging'

/**
 * RestrictionMiniTable.tsx — "Hidden from this central" as a real table.
 *
 * It replaced stacked rows, which could not answer the question the block is titled with: WHAT is
 * withheld and WHERE. Three columns, and no more:
 *
 *  - **What** — the name plus its dimension in words. A repository and a project are different
 *    things and correlate across machines by different keys; flattening them into one blob is the
 *    bug the previous round already fixed, and it stays fixed.
 *  - **Hidden on** — the machines applying this restriction, this one included.
 *  - **Still shared on** — the machines that (as far as this one was told) still send it.
 *
 * Session counts and last-active were deliberately left out: they describe the project's activity,
 * not the restriction, the picker one click away already shows them, and a column added to make a
 * table look substantial is a column nobody reads.
 *
 * A row with NO sibling information says so in words. An empty cell reads as "nowhere else", and
 * that is a claim this machine cannot make — it knows only what siblings announced, and only since
 * the encrypted channel existed. The block's `siblingWithholdBestEffort` caveat qualifies both
 * machine columns.
 *
 * DELIBERATELY A PLAIN FUNCTION, not a component. It is called (`{restrictionMiniTable({…})}`),
 * so the returned tree is inline in its caller's — which keeps it hook-free, keeps every piece of
 * state owned by the one component that can also drive the maximized view, and keeps the block's
 * content reachable by the tests that walk `ReadView`'s output.
 */

/** How many machine names a cell shows before it starts counting. Narrow inline, wider maximized. */
const MACHINE_CELL_MAX: Record<PagingMode, number> = { inline: 2, maximized: 4 }

export interface RestrictionMiniTableProps {
  rows: RestrictionRow[]
  /** Already-localized display name per row key — the caller owns label resolution. */
  labelOf: (row: RestrictionRow) => string
  lang: 'pt' | 'en'
  mode: PagingMode
  isMobile: boolean
  page: number
  size: number
  onPage: (page: number) => void
  onSize: (size: number) => void
  /** Absent in the maximized view, which is already expanded. */
  onMaximize?: () => void
}

export function restrictionMiniTable(p: RestrictionMiniTableProps): React.ReactElement {
  const { rows, labelOf, lang, mode, isMobile } = p
  const paging = resolvePaging({ mode, total: rows.length, page: p.page, size: p.size })
  const shown = rows.slice(paging.start, paging.end)
  const cellMax = MACHINE_CELL_MAX[mode]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      {p.onMaximize && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="ag-tap"
            type="button"
            onClick={p.onMaximize}
            aria-label={COPY.tableMaximize[lang]}
            title={COPY.tableMaximize[lang]}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              border: '1px solid var(--border)', background: 'transparent', borderRadius: 6,
              color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 11, padding: isMobile ? '10px 12px' : '3px 8px',
            }}
          >
            <Maximize2 size={12} />
            {COPY.tableMaximize[lang]}
          </button>
        </div>
      )}

      {/* A real <table> cannot hold three columns of paths at 390px, so the phone gets the stacked
          cards this codebase already uses for collapsed tables. Same data, same order, same
          headings — as labels rather than as a header row. */}
      {isMobile
        ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
            {shown.map(row => (
              <div key={row.key} style={{
                display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0,
                border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '8px 10px',
              }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 6, minWidth: 0 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
                    {labelOf(row)}
                  </span>
                  <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>{dimensionWord(row, lang)}</span>
                </div>
                {stackedField({ label: COPY.colHiddenOn[lang], lang, machines: row.restrictedBy, cellMax, empty: COPY.rowNoOtherMachine[lang], noteWhenOnlySelf: COPY.rowNoOtherMachine[lang] })}
                {stackedField({ label: COPY.colStillSharedOn[lang], lang, machines: row.sharedBy, cellMax, empty: COPY.rowSharedNowhere[lang] })}
              </div>
            ))}
          </div>
        )
        : (
          // The FRAME is what turns three aligned columns into one object on the card. Without it
          // the table was a set of styled rows floating on the card's own background, which is the
          // "it does not look like a table" complaint, twice.
          <div style={TABLE_FRAME}>
            {/* The horizontal escape hatch lives HERE, on the table's own box — never on the page
                body, which may not scroll sideways at any width. */}
            <div style={{ overflowX: 'auto', minWidth: 0 }}>
              <table style={{
                width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed',
                fontSize: 12, lineHeight: 1.45,
                // Below this the three columns crush into unreadable slivers; the box above
                // scrolls instead, which is what an escape hatch is for.
                minWidth: 440,
              }}>
                <thead>
                  <tr>
                    {th(COPY.colHiddenWhat[lang], '44%')}
                    {th(COPY.colHiddenOn[lang], '28%')}
                    {th(COPY.colStillSharedOn[lang], '28%')}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row, i) => (
                    // Hairlines, and ONLY hairlines — a zebra on top of them is two separators
                    // doing one job and reads as noise. The first row is already separated by the
                    // header's own rule, so it takes none.
                    <tr key={row.key} style={i === 0 ? undefined : { borderTop: '1px solid var(--border-subtle)' }}>
                      {td(<>
                        <span style={{
                          display: 'block', fontWeight: 600, color: 'var(--text-primary)',
                          overflowWrap: 'anywhere',
                        }}>
                          {labelOf(row)}
                        </span>
                        {/* The dimension in words, kept from the previous round: a repository and
                            a project correlate across machines by different keys and are not
                            interchangeable. As a chip it also gives the column a second rank the
                            eye can follow down the page. */}
                        <span style={DIMENSION_CHIP}>{dimensionWord(row, lang)}</span>
                      </>, 'what')}
                      {td(machinesCell({ machines: row.restrictedBy, lang, cellMax, empty: COPY.rowNoOtherMachine[lang], noteWhenOnlySelf: COPY.rowNoOtherMachine[lang] }), 'on')}
                      {td(machinesCell({ machines: row.sharedBy, lang, cellMax, empty: COPY.rowSharedNowhere[lang] }), 'shared')}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

      {paging.paged && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          fontSize: 11, color: 'var(--text-tertiary)',
        }}>
          <button
            type="button"
            onClick={() => p.onPage(paging.page - 1)}
            disabled={paging.page <= 0}
            aria-label={COPY.tablePrev[lang]}
            style={pagerBtn(isMobile, paging.page <= 0)}
          >‹</button>
          <span>{interpolate(COPY.tablePageOf[lang], { page: paging.page + 1, total: paging.pageCount })}</span>
          <button
            type="button"
            onClick={() => p.onPage(paging.page + 1)}
            disabled={paging.page >= paging.pageCount - 1}
            aria-label={COPY.tableNext[lang]}
            style={pagerBtn(isMobile, paging.page >= paging.pageCount - 1)}
          >›</button>
          <label style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <select
              value={paging.size}
              onChange={e => p.onSize(Number(e.target.value))}
              aria-label={COPY.tablePerPage[lang]}
              style={{
                background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
                border: '1px solid var(--border)', borderRadius: 6, padding: '2px 6px',
                // 16px on mobile or iOS Safari zooms the viewport; the global guard in index.css
                // covers inputs, and a <select> needs the same treatment.
                fontSize: isMobile ? 16 : 11, fontFamily: 'inherit',
                minHeight: isMobile ? 44 : undefined,
              }}
            >
              {paging.sizes.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            {COPY.tablePerPage[lang]}
          </label>
        </div>
      )}
    </div>
  )
}

function dimensionWord(row: RestrictionRow, lang: 'pt' | 'en'): string {
  return row.kind === 'project' ? COPY.rowTagProject[lang] : COPY.rowTagRepo[lang]
}

/**
 * The machine names of a cell, truncated with a truthful "+N" rather than silently cut.
 *
 * A PLAIN FUNCTION, like the table itself: a component boundary here would hide the cell's text
 * from the tests that walk `ReadView`'s tree — and this cell's text is the load-bearing part.
 *
 * `noteWhenOnlySelf` is the honesty clause. In `selfRestricted` scope this machine is ALWAYS in
 * the "hidden on" list, so a cell reading just "This machine" would silently imply that no other
 * machine of yours restricts it — a claim this machine cannot make, since it knows only what
 * siblings announced. When nothing else is in the list, the cell says so in words.
 */
function machinesCell(o: {
  machines: RestrictionMachine[]
  lang: 'pt' | 'en'
  cellMax: number
  empty: string
  noteWhenOnlySelf?: string
}): React.ReactElement {
  const { machines, lang, cellMax, empty } = o
  const names = machines.map(m => m.self ? COPY.peersSelf[lang] : (m.machineName || COPY.peerUnnamed[lang]))
  if (names.length === 0) {
    return <span style={{ color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>{empty}</span>
  }
  const { shown, extra } = machineCell(names, cellMax)
  const onlySelf = machines.every(m => m.self)
  return (
    <span style={{ color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
      {shown.join(', ')}
      {extra > 0 && (
        // The full list stays reachable — a cell that drops names without saying so is the one
        // failure mode this column is not allowed to have.
        <span title={names.join(', ')} style={{
          color: 'var(--text-tertiary)', whiteSpace: 'nowrap',
          // The one place digits stack down a column, so the "+9" and the "+12" of two rows line
          // up instead of jittering.
          fontVariantNumeric: 'tabular-nums',
        }}>
          {' '}{interpolate(COPY.moreMachines[lang], { n: extra })}
        </span>
      )}
      {onlySelf && o.noteWhenOnlySelf && (
        <span style={{ display: 'block', color: 'var(--text-tertiary)', overflowWrap: 'anywhere' }}>
          {o.noteWhenOnlySelf}
        </span>
      )}
    </span>
  )
}

function stackedField(o: {
  label: string
  machines: RestrictionMachine[]
  lang: 'pt' | 'en'
  cellMax: number
  empty: string
  noteWhenOnlySelf?: string
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 5, fontSize: 10.5, minWidth: 0 }}>
      <span style={{ color: 'var(--text-tertiary)', fontWeight: 600 }}>{o.label}:</span>
      {machinesCell(o)}
    </div>
  )
}

/**
 * The frame. `overflow: hidden` is what makes the header band's corners follow the radius — a
 * square-cornered band inside a rounded box reads as a mistake rather than as a table.
 */
const TABLE_FRAME: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 8,
  overflow: 'hidden',
  background: 'var(--bg-card)',
  minWidth: 0,
}

/** The dimension word, as a quiet chip on its own line under the name. */
const DIMENSION_CHIP: React.CSSProperties = {
  display: 'inline-block', marginTop: 3,
  padding: '0 5px', borderRadius: 4,
  border: '1px solid var(--border-subtle)',
  fontSize: 9.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
  color: 'var(--text-tertiary)', whiteSpace: 'nowrap',
}

/**
 * A header cell — the single strongest signal that something is a table, which is exactly what it
 * was not doing: 10px tertiary text on the card's own background, separated from the first row by
 * nothing. It now has its OWN ground and a rule under it, so it reads as a band rather than as a
 * slightly paler first row.
 */
function th(label: string, width: string): React.ReactElement {
  return (
    <th scope="col" style={{
      width, textAlign: 'left', padding: '7px 12px',
      fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase',
      color: 'var(--text-tertiary)',
      background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)',
      borderBottom: '1px solid var(--border)',
      whiteSpace: 'nowrap',
    }}>{label}</th>
  )
}

/** A body cell. The padding is the "not cramped" half of the complaint; `top` keeps a wrapped
 *  machine list aligned with the name it belongs to instead of floating in the middle of the row. */
function td(children: React.ReactNode, key: string): React.ReactElement {
  return <td key={key} style={{ padding: '9px 12px', verticalAlign: 'top', minWidth: 0 }}>{children}</td>
}

function pagerBtn(isMobile: boolean, disabled: boolean): React.CSSProperties {
  return {
    border: '1px solid var(--border)', background: 'transparent', borderRadius: 6,
    color: disabled ? 'var(--text-tertiary)' : 'var(--text-secondary)',
    cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 13,
    padding: isMobile ? '0 14px' : '0 8px',
    minWidth: isMobile ? 44 : 24, minHeight: isMobile ? 44 : 22,
    opacity: disabled ? 0.5 : 1,
  }
}

/**
 * The full-screen view of the same table.
 *
 * It exists because the inline preview lives in a connection card and can only ever be a preview:
 * five rows, fifteen at most. A machine with real rules has more than that, and paging through a
 * card five at a time is not reading a table.
 *
 * Dismissal is `esc` (the owner's handler, in the panel that owns the state), the backdrop, and
 * the close button — and focus returns to whatever opened it. On a phone this IS the answer rather
 * than a nicety: three columns of paths cannot be read inside a card, so the maximized view is
 * where a mobile user actually reads this, which is why it goes edge-to-edge there.
 */
export function MaximizedRestrictions(p: {
  rows: RestrictionRow[]
  labelOf: (row: RestrictionRow) => string
  lang: 'pt' | 'en'
  isMobile: boolean
  page: number
  size: number
  onPage: (n: number) => void
  onSize: (n: number) => void
  onClose: () => void
}): React.ReactElement {
  return (
    <div
      onClick={p.onClose}
      role="dialog"
      aria-modal="true"
      aria-label={COPY.hiddenBlockTitle[p.lang]}
      style={{
        position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: p.isMobile ? 'stretch' : 'center', justifyContent: 'center',
        padding: p.isMobile ? 0 : 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-card)', border: p.isMobile ? 'none' : '1px solid var(--border)',
          borderRadius: p.isMobile ? 0 : 12,
          width: p.isMobile ? '100%' : 'min(980px, 96vw)',
          height: p.isMobile ? '100%' : 'min(80vh, 760px)',
          display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
          padding: '14px 16px', borderBottom: '1px solid var(--border)', flexShrink: 0,
        }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
            {interpolate(COPY.hiddenBlockTitle[p.lang], { n: p.rows.length })}
          </span>
          <button
            type="button"
            onClick={p.onClose}
            // The first focusable control in the overlay, so a keyboard user lands on the way out.
            autoFocus
            aria-label={COPY.tableRestore[p.lang]}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              border: '1px solid var(--border)', background: 'transparent', borderRadius: 6,
              color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 12, padding: p.isMobile ? '10px 14px' : '4px 10px',
              minHeight: p.isMobile ? 44 : undefined,
            }}
          >
            <X size={14} /> {COPY.tableRestore[p.lang]}
          </button>
        </div>
        {/* `minHeight: 0` so this scrolls instead of pushing the header off the top. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
          {restrictionMiniTable({
            rows: p.rows,
            labelOf: p.labelOf,
            lang: p.lang,
            mode: 'maximized',
            isMobile: p.isMobile,
            page: p.page,
            size: p.size,
            onPage: p.onPage,
            onSize: p.onSize,
          })}
        </div>
        <div style={{
          padding: '10px 16px', borderTop: '1px solid var(--border)', flexShrink: 0,
          fontSize: 11, color: 'var(--text-tertiary)',
        }}>
          {COPY.siblingWithholdBestEffort[p.lang]}
        </div>
      </div>
    </div>
  )
}
