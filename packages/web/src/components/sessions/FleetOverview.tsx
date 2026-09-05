/**
 * FleetOverview — the sessions workspace with nothing selected.
 *
 * A landing screen, not filler: what the fleet is doing right now, so the workspace answers a
 * question before you have picked anything.
 *
 * Every figure comes from the pure `summarizeFleet`, and the one figure that can be absent — how
 * long the running sessions have been up — is rendered as a SENTENCE when it is, never as a zero.
 * Same for the whole screen: a central hosts no sessions, an exposed profile refuses the route, and
 * a failed poll is not an empty fleet. Those are four different facts and this file keeps them four
 * different sentences.
 */

import { useMemo } from 'react'
import { Activity, Bell, FolderGit2, Power } from 'lucide-react'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { HARNESS_COLORS, HARNESS_LABELS } from '../../lib/harness'
import { formatUptime, summarizeFleet } from '../../lib/fleetSummary'
import { ActivityHeatmap } from '../ActivityHeatmap'
import { linePoints, trendChart, type TrendSeries } from '../../lib/trendLines'

export interface HeatmapDay { date: string; value: number; sessions: number; tools: number }

/**
 * The container geometry the sessions workspace shares with the header's filter row.
 *
 * BOTH numbers, because matching only one is what produced the second version of this bug: with
 * equal padding but no shared max width, the two lined up at 1440px and drifted 53px apart at
 * 1773px — the header's row lives in a centred 1400px box, so its left edge MOVES with the window
 * and a left-aligned body cannot follow it.
 *
 * Named once and used by both, because the alignment IS the requirement: whatever these become,
 * the row above and the body below have to move together.
 */
export const PAGE_INSET = 32
export const PAGE_MAX_WIDTH = 1400

export interface FleetOverviewProps {
  lang: 'pt' | 'en'
  rows: readonly ControlSession[]
  loading: boolean
  unsupported: boolean
  unavailable?: string
  /**
   * The combined activity calendar, already narrowed by every active filter — `derived.heatmapData`
   * from `useDerivedStats`, never a second aggregation. `stats-cache.json` stays Claude-only here as
   * everywhere: this is per-session sums, the same source the dashboard's own heatmap reads.
   */
  heatmap?: readonly HeatmapDay[]
  /**
   * The same days split by harness — `derived.heatmapByHarness`, never a second aggregation.
   *
   * Separate from `heatmap` rather than derived from it because a heat cell is one colour: the
   * calendar cannot say that a day was forty Claude sessions and two Antigravity ones, and that
   * is exactly what the line beside it is for.
   */
  heatmapByHarness?: Readonly<Record<string, readonly { date: string; sessions: number }[]>>
}

export function FleetOverview({
  lang, rows, loading, unsupported, unavailable, heatmap, heatmapByHarness,
}: FleetOverviewProps) {
  /** One line per harness, on one axis and one scale. See `trendLines.ts`. */
  const chart = useMemo(() => trendChart(heatmapByHarness ?? {}), [heatmapByHarness])
  const pt = lang === 'pt'
  const s = useMemo(() => summarizeFleet(rows, Date.now()), [rows])

  if (loading || unsupported || unavailable || rows.length === 0) {
    return (
      <Notice text={loading
        ? (pt ? 'Lendo as sessões desta máquina…' : 'Reading this machine’s sessions…')
        : unsupported
          ? (pt
              ? 'Esta instalação não pode ler sessões. Um central agrega várias máquinas e não hospeda as sessões de nenhuma delas, e um perfil de exposição sem poder sobre o host também recusa essa leitura — então não há frota para resumir aqui, o que é diferente de uma frota vazia.'
              : 'This install cannot read sessions. A central aggregates many machines and hosts none of their sessions, and an exposure profile with no host power refuses the read too — so there is no fleet to summarize here, which is not the same as an empty one.')
          : unavailable
            ? unavailable
            : (pt
                ? 'Nenhuma sessão nesta máquina ainda. Inicie uma pelo agentop e ela aparece aqui.'
                : 'No sessions on this machine yet. Start one with agentop and it shows up here.')}
      />
    )
  }

  // ALIGNED WITH THE HEADER'S FILTER BAR — the thing directly above it, and the only edge a
  // reader can compare it against.
  //
  // It took two wrong attempts to get here, and both are worth stating. It began centred in a
  // 980px box while the header was centred in a 1400px one, so at 1262px the body sat 200px to the
  // right of the filters. Left-aligning it fixed that width and broke every wider one: the header
  // is CENTRED, so its left edge moves, and a left-aligned body only agrees with it by accident.
  // Matching the geometry — same max width, same inset, same centring — is the only thing that
  // holds at every size.
  return (
    <div style={{
      padding: `28px ${PAGE_INSET}px`,
      maxWidth: PAGE_MAX_WIDTH,
      margin: '0 auto',
      width: '100%',
      boxSizing: 'border-box',
    }}>
      <h1 style={{ margin: '0 0 4px', fontSize: 20, fontWeight: 700, color: 'var(--text-primary)' }}>
        {pt ? 'Suas sessões' : 'Your sessions'}
      </h1>
      {/* TWO UNIVERSES ON ONE SCREEN, and the page has to say which is which.
          The cards count the FLEET — the sessions the aside is listing, narrowed by the same
          `filterFleet` it uses. The heatmap and the per-assistant bars below count STORED METRICS,
          narrowed by every filter including the date range.
          The one dimension that separates them is TIME, and it is named rather than left to be
          discovered: `filterFleet` deliberately ignores the date range, because a live session is
          happening now and "last 7 days" would hide one that started eight days ago and is still
          working. Its header records that reasoning per dimension.
          Both notes exist because a user set a filter, watched the heatmap empty out, and saw the
          cards hold still — a reasonable reading of that is that the cards are stale. They were
          not stale; they were counting a different set, and nothing on the screen said so. Same
          rule as every N/A in this product: a number must say what it counts. */}
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-tertiary)', lineHeight: 1.55 }}>
        {pt
          ? 'O que está rodando nesta máquina agora. Escolha uma sessão na lateral para abri-la.'
          : 'What is running on this machine right now. Pick a session on the left to open it.'}
      </p>

      <SectionNote text={pt
        ? 'A frota agora — as mesmas sessões listadas ao lado. Segue os filtros do topo, menos o período: uma sessão viva está acontecendo agora.'
        : 'The fleet now — the same sessions listed beside it. Follows the filters above, except the date range: a live session is happening now.'} />

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 22,
      }}>
        <Stat
          icon={<Activity size={15} />} tone="var(--accent-green)"
          label={pt ? 'Rodando' : 'Running'} value={String(s.running)}
          // Names the UNIVERSE: "of 23 total" sat a few centimetres from a header reading "961
          // sessions" and invited the reader to compare two counts of different things. This one
          // is the fleet on this machine; that one is the whole metrics history.
          // "on this machine" was a claim this number cannot make: the list holds the live fleet
          // plus a BOUNDED window of recent conversations (`DEFAULT_CLOSED_LIMIT`), not the
          // machine's whole history — a machine with a thousand stored conversations reads 306
          // here. It names the LIST, which is what it actually counts.
          note={pt ? `de ${s.total} nesta lista` : `of ${s.total} in this list`}
        />
        <Stat
          icon={<Bell size={15} />} tone="var(--anthropic-orange)"
          label={pt ? 'Precisam de você' : 'Need you'} value={String(s.waiting)}
          note={s.waiting > 0
            ? (pt ? 'aguardando resposta' : 'waiting on an answer')
            : (pt ? 'nada bloqueado' : 'nothing blocked')}
        />
        <Stat
          icon={<Power size={15} />} tone="var(--text-tertiary)"
          label={pt ? 'Tempo ativo' : 'Active time'}
          // The one figure that can be missing. A dash and a sentence, never a zero — "nothing has
          // been up for any time" and "nothing records when they started" are different claims.
          value={s.activeMs === undefined ? '—' : formatUptime(s.activeMs)}
          note={s.activeMs === undefined
            ? (pt ? 'nenhuma sessão registra quando começou' : 'no session records when it started')
            : s.activeUnknown > 0
              ? (pt ? `${s.activeUnknown} sem hora de início` : `${s.activeUnknown} with no start time`)
              : (pt ? 'somado nas sessões vivas' : 'summed across live sessions')}
        />
        <Stat
          icon={<FolderGit2 size={15} />} tone="var(--accent-purple)"
          label={pt ? 'Projetos' : 'Projects'} value={String(s.projects)}
          // WHERE THE SESSIONS IN THIS LIST ARE, and how many of those places are repositories.
          //
          // It used to read "with a session on record" over a count of every project in the whole
          // history — 173 beside three cards counting the fleet, four numbers side by side
          // measuring different things. Reported as simply wrong, and it was: the card answered a
          // question nobody had asked on a screen about what is running.
          //
          // The repo count is a FRACTION of the same figure, never a second total, so the two can
          // be read together at a glance. Absent when none of them resolves to a repository —
          // "0 are repositories" and "we could not resolve a remote for any of them" read the same
          // and only the second is established.
          note={s.projectRepos > 0
            ? (pt
                ? `${s.projectRepos} ${s.projectRepos === 1 ? 'é repositório' : 'são repositórios'}`
                : `${s.projectRepos} ${s.projectRepos === 1 ? 'is a repository' : 'are repositories'}`)
            : (pt ? 'nenhum com repositório resolvido' : 'none with a resolved repository')}
        />
      </div>

      <section>
        <h2 style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>
          {pt ? 'Por assistente' : 'By assistant'}
        </h2>
        {/* Said once, under the heading, because a list with a single row invites the question
            "where are my other assistants". They are not missing: this section counts the fleet on
            this machine, and an assistant with nothing running and nothing recorded here has no
            row — which is a real zero, not an unmeasured one. Their history is on the dashboard. */}
        {s.harnesses.length === 1 && (
          <p style={{ margin: '0 0 10px', fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
            {pt
              ? 'Só assistentes presentes nesta lista aparecem aqui — ela cobre o que está rodando mais as conversas recentes, não todo o histórico. O total de cada assistente está no painel e na comparação.'
              : 'Only assistants present in this list appear here — it covers what is running plus recent conversations, not the whole history. Each assistant’s total is on the dashboard and on Compare.'}
          </p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {s.harnesses.map(h => {
            const color = (HARNESS_COLORS as Record<string, string>)[h.harness] ?? 'var(--text-tertiary)'
            // A session whose harness could not be NAMED still exists and is still counted — an
            // assistant found running that no adapter recognises reports an empty harness. It used
            // to render as a bar with a BLANK label beside it, which reads as a fault in the panel
            // rather than a fact about the fleet. The row says what it is instead; dropping it
            // would make the percentages beside it stop adding up.
            const label = (HARNESS_LABELS as Record<string, string>)[h.harness]
              ?? (h.harness.trim() === ''
                ? (pt ? 'assistente não identificado' : 'unidentified assistant')
                : h.harness)
            const pct = s.total === 0 ? 0 : Math.round((h.count / s.total) * 100)
            return (
              <div key={h.harness} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ width: 110, fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)', flexShrink: 0 }}>
                  {label}
                </span>
                {/* The bar is a share of the fleet, 0–100, and the SHARE IS SAID IN A NUMBER
                    beside it. A full bar with no figure is unreadable in the ordinary case where
                    one assistant holds everything: it looks like a progress bar that finished
                    rather than "this is all of them", which is what a reader asked about it. */}
                <span
                  role="img"
                  aria-label={`${pct}%`}
                  style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--bg-elevated)', overflow: 'hidden', minWidth: 60 }}
                >
                  <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: color, borderRadius: 4 }} />
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)', width: 44, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                  {pct}%
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)', width: 120, textAlign: 'right', flexShrink: 0 }}>
                  {h.running > 0
                    ? (pt ? `${h.count} · ${h.running} viva${h.running > 1 ? 's' : ''}` : `${h.count} · ${h.running} live`)
                    : (pt ? `${h.count} · nenhuma viva` : `${h.count} · none live`)}
                </span>
              </div>
            )
          })}
        </div>
      </section>

      {/* ONE calendar for every harness in view, not one strip each — the per-harness split lives
          in the day tooltip, which is where a comparison is actually made.

          It reads `derived.heatmapData`, which `useDerivedStats` has ALREADY narrowed by every
          active filter. That is the requirement, not a convenience: a heatmap beside filtered
          stats that is itself unfiltered puts two numbers on one screen under two different
          rules, which is the same defect as a cache-backed total beside a session-summed one. */}
      {heatmap && heatmap.length > 0 && (
        <section style={{ marginBottom: 22 }}>
          <h2 style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>
            {pt ? 'Atividade' : 'Activity'}
          </h2>
          {/* Said HERE and not only in the heading above, because the two regions are read
              separately: somebody comparing the cards with this grid is looking at this half. */}
          <SectionNote text={pt
            ? 'Histórico gravado — este calendário segue os filtros do topo, como as barras acima.'
            : 'Recorded history — this calendar follows the filters above, as the bars do.'} />
          {/* CAPPED. The heatmap fills its container and keeps its own aspect ratio, so on this
              full-width page it grew to roughly 500px tall — reported as "ta gigante". It is a
              glance, not a chart you read a value off: the cells only need to be big enough to
              tell four shades apart. The cap lives HERE rather than in the component, which is
              also used inside a dashboard card that constrains it already, and inside an expanded
              modal that is supposed to be large. */}
          {/* TWO VIEWS OF ONE SET, side by side, because they are read differently: the calendar is
              TEXTURE — which days, over half a year — and the trend is a SHAPE — how the window the
              filters selected actually moved. Capping the calendar left this room empty, and empty
              room beside a chart reads as something that failed to load. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 420px', maxWidth: 620, minWidth: 0 }}>
              <ActivityHeatmap data={[...heatmap]} weeks={26} />
            </div>
            <div style={{ flex: '1 1 320px', minWidth: 280 }}>
              <ActivityTrend chart={chart} lang={lang} />
            </div>
          </div>
        </section>
      )}
      {heatmap && heatmap.length === 0 && (
        // Never an all-zero grid: an empty measurement and "nothing in this window" are different
        // facts, and a grid of empty cells reads as the first while meaning the second.
        <p style={{ margin: '0 0 22px', fontSize: 12, color: 'var(--text-tertiary)' }}>
          {pt
            ? 'Nenhuma atividade no período e nos filtros escolhidos.'
            : 'No activity in the chosen window and filters.'}
        </p>
      )}

    </div>
  )
}

/**
 * The one line that says WHICH question a block of this page answers.
 *
 * Deliberately not a tooltip and not an icon: the confusion it exists for is somebody comparing
 * two regions at a glance, and a fact you have to hover for is a fact you do not have while
 * comparing. Dim, small, and above the block it describes.
 */
function SectionNote({ text }: { text: string }) {
  return (
    <p style={{
      margin: '0 0 10px', fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-tertiary)',
      opacity: 0.85,
    }}>
      {text}
    </p>
  )
}

function Stat({ icon, tone, label, value, note }: {
  icon: React.ReactNode; tone: string; label: string; value: string; note: string
}) {
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 12,
      padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0,
    }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 7, color: tone }}>
        {icon}
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-tertiary)' }}>
          {label}
        </span>
      </span>
      <span style={{ fontSize: 26, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1 }}>{value}</span>
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)', lineHeight: 1.4 }}>{note}</span>
    </div>
  )
}

function Notice({ text }: { text: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', minHeight: 320, padding: 32,
    }}>
      <p style={{
        margin: 0, maxWidth: 460, textAlign: 'center',
        fontSize: 13, lineHeight: 1.6, color: 'var(--text-tertiary)',
      }}>
        {text}
      </p>
    </div>
  )
}


/**
 * The window's activity as SHAPES: one line per harness, overlaid on one axis.
 *
 * Drawn by hand rather than with the charting library the dashboard uses, for the same reason the
 * heatmap is: this is a strip a few hundred pixels wide with no axes and no tooltip chrome to
 * configure away, and the library's smallest useful chart is bigger than the space.
 *
 * IT SAYS WHAT IT IS MEASURING. A line with no scale is a decoration, so the peak and the span are
 * printed, and the legend carries each harness's own total — which is the number that says whether
 * a line hugging the floor is "a little" or "almost nothing".
 *
 * Every decision about the DATA — the shared axis, zeros for quiet days, a harness with nothing
 * being absent rather than flat — is in `trendLines.ts`. This function only draws.
 */
function ActivityTrend({ chart, lang }: {
  chart: ReturnType<typeof trendChart>
  lang: 'pt' | 'en'
}) {
  const pt = lang === 'pt'
  if (chart.series.length === 0 || chart.peak === 0) return null

  const W = 300
  const H = 92
  const first = chart.days[0]!
  const last = chart.days[chart.days.length - 1]!
  return (
    <div>
      <h3 style={{
        margin: '0 0 4px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.06em', color: 'var(--text-tertiary)',
      }}>
        {pt ? 'No período' : 'Over the window'}
      </h3>
      <p style={{ margin: '0 0 10px', fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
        {pt
          ? `Sessões por dia · pico de ${chart.peak} · ${first} a ${last}`
          : `Sessions per day · peak ${chart.peak} · ${first} to ${last}`}
      </p>
      {/* `preserveAspectRatio="none"` so the strip stretches to whatever column it lands in: the
          shape is what is read here, and the day spacing carries no meaning a reader measures. */}
      <svg
        viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={pt ? 'Sessões por dia, uma linha por assistente' : 'Sessions per day, one line per assistant'}
        style={{ width: '100%', height: H, display: 'block', overflow: 'visible' }}
      >
        <line x1={0} y1={H} x2={W} y2={H} stroke="var(--border)" strokeWidth={1} />
        {chart.series.map(s => (
          <polyline
            key={s.harness}
            points={linePoints(s, chart.peak, W, H)}
            fill="none"
            stroke={harnessColor(s.harness)}
            strokeWidth={1.6}
            strokeLinejoin="round"
            strokeLinecap="round"
            // Vector strokes scale with the box under `preserveAspectRatio="none"`, which would
            // make a stretched line thicker horizontally than vertically.
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 8 }}>
        {chart.series.map(s => <TrendKey key={s.harness} series={s} pt={pt} />)}
      </div>
    </div>
  )
}

/** One legend entry: the colour, the harness's name, and the total that gives its line a size. */
function TrendKey({ series, pt }: { series: TrendSeries; pt: boolean }) {
  const label = (HARNESS_LABELS as Record<string, string>)[series.harness] ?? series.harness
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
      <span aria-hidden style={{
        width: 10, height: 2, borderRadius: 1, flexShrink: 0,
        background: harnessColor(series.harness),
      }} />
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ color: 'var(--text-tertiary)' }}>
        {series.total}{pt ? '' : ''}
      </span>
    </span>
  )
}

/** A harness with no colour of its own gets the neutral one, never a colour borrowed from another. */
function harnessColor(harness: string): string {
  return (HARNESS_COLORS as Record<string, string>)[harness] ?? 'var(--text-tertiary)'
}
