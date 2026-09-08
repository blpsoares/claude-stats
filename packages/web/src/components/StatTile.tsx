/**
 * StatTile.tsx — the KPI tile: one big figure over an uppercase caption.
 *
 * It existed TWICE, in RepoDetailPage and TagDetailPage, and the two copies had already drifted
 * into different failure modes for the same input: the repo one had no `overflow`, so a long value
 * was painted straight through the card's right edge; the tag one clipped it to an ellipsis. One
 * tile, one behaviour.
 *
 * ── Why the figure is sized in `cqi` ──────────────────────────────────────────────────────────
 * The value is a headline and must not wrap: a two-line tile is as tall as two lines, and a grid
 * row is as tall as its tallest cell, so ONE wrapped tile leaves every tile beside it two thirds
 * empty. (That is exactly what the first fix here did — it stopped the overflow by allowing the
 * wrap, and traded a value outside its box for a row of half-empty boxes.)
 *
 * Not wrapping means the figure has to FIT, and what it has to fit inside is a grid track whose
 * width nothing in JavaScript knows at render time. So the tile is a size container
 * (`container-type: inline-size`) and the font size is stated as the smaller of the design size and
 * the size at which this many characters still fit:
 *
 *     font-size: min(18px, (100 / (len * CHAR_EM))cqi)
 *
 * `1cqi` is 1 % of the tile's own content box, so the second term is self-correcting at every
 * width — a 3-character count keeps the full 18px on a narrow phone tile, while `USD 15,884.06`
 * steps down only as far as its column actually requires. `CHAR_EM` is the average advance of a
 * digit in the UI font at weight 700, with margin.
 *
 * `containerType` is what makes `cqi` mean anything here; a browser that does not understand the
 * unit drops the whole declaration and falls back to `.ag-stat-value`'s plain 18px in index.css.
 * `nowrap` + `ellipsis` is the backstop under both: if the estimate is ever wrong the figure is
 * clipped inside the card rather than painted outside it, and `title` still carries it whole.
 */
import React from 'react'

/** The design size of the figure, and the ceiling `min()` never goes above. */
const BASE_PX = 18
/** Average advance per character, in em, for a bold digit in the UI font — with margin. */
const CHAR_EM = 0.62

export function statValueFontSize(value: string): string {
  const len = Math.max(value.length, 1)
  return `min(${BASE_PX}px, ${(100 / (len * CHAR_EM)).toFixed(2)}cqi)`
}

/**
 * The one column rule for a KPI strip. `150px` and not `120px`: at 120 a 430px phone fits three
 * tiles ~100px wide, which no money figure fits in at any legible size — the strip was three
 * columns of shrunken, wrapped numbers. Two wider tiles read better and, because nothing wraps
 * any more, cost no more height.
 */
export const STAT_TILE_GRID = 'repeat(auto-fit, minmax(150px, 1fr))'

export function StatTile({ label, value, accent, title }: {
  label: string
  value: string
  accent?: boolean
  title?: string
}) {
  return (
    <div
      title={title ?? value}
      style={{
        display: 'flex', flexDirection: 'column', gap: 3, padding: '11px 13px', minWidth: 0,
        background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)',
        containerType: 'inline-size',
      }}
    >
      <span
        className="ag-stat-value"
        style={{
          fontSize: statValueFontSize(value),
          fontWeight: 700, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums',
          color: accent ? 'var(--anthropic-orange)' : 'var(--text-primary)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}
      >{value}</span>
      <span style={{
        fontSize: 10.5, color: 'var(--text-tertiary)', textTransform: 'uppercase',
        letterSpacing: '0.05em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{label}</span>
    </div>
  )
}
