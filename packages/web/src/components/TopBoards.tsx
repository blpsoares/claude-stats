import React, { useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import type { HarnessId, Lang, SessionMeta } from '@agentistics/core'
import { fmt, fmtCost, formatModel, formatProjectName, sessionLabel } from '@agentistics/core'
import {
  hourProfile, lastActiveDay, rankHarnesses, rankModels, rankProjects, rankSessions, rankTools,
  sessionsOnDay, shareOf,
  type Board, type Leader, type TopMetric,
} from '../lib/homeTop'
import { HARNESS_COLORS, HARNESS_LABELS } from '../lib/harness'
import { useIsMobile } from '../hooks/useIsMobile'

interface Props {
  sessions: SessionMeta[]
  lang: Lang
  currency: 'USD' | 'BRL'
  brlRate: number
  /** Clicking a session row opens its drawer, exactly as the recent-sessions list does. */
  onSelectSession?: (s: SessionMeta) => void
}

/** The metric switch, shared by every board that HAS a choice of metric. */
const METRICS: TopMetric[] = ['cost', 'tokens', 'sessions']

const METRIC_LABEL: Record<TopMetric, Record<'en' | 'pt', string>> = {
  cost: { en: 'cost', pt: 'custo' },
  tokens: { en: 'tokens', pt: 'tokens' },
  sessions: { en: 'sessions', pt: 'sessões' },
}

/**
 * One sentence per board saying what it ranks and — the part that matters — what the number is NOT.
 *
 * Every board on this page can be misread as something adjacent to what it is: a model board looks
 * like a per-model bill until you know a session can span models; a tool board looks like a cost
 * attribution. Saying so once, in the card, is cheaper than the support question.
 */
const BOARD_HELP: Record<string, Record<'en' | 'pt', string>> = {
  sessions: {
    en: 'Individual conversations, ranked whole. This is the board that answers "which single conversation cost me that".',
    pt: 'Conversas individuais, inteiras. É o quadro que responde "qual conversa sozinha me custou isso".',
  },
  models: {
    en: 'Ranked per model, not per session: one session can run several models, and filing all of it under one label would hand the cheap model the expensive one\'s spend.',
    pt: 'Por modelo, não por sessão: uma sessão pode rodar vários modelos, e jogar tudo num rótulo só daria ao modelo barato o gasto do caro.',
  },
  harnesses: {
    en: 'Which assistant did the work. A session counts once, for the assistant that ran it.',
    pt: 'Qual assistente fez o trabalho. Cada sessão conta uma vez, para o assistente que a rodou.',
  },
  projects: {
    en: 'Grouped by the project folder the session ran in. A repository used from several folders appears once per folder here — the Repositories page is the one that unifies them by git remote.',
    pt: 'Agrupado pela pasta do projeto onde a sessão rodou. Um repositório usado a partir de várias pastas aparece uma vez por pasta aqui — quem unifica por remote do git é a página de Repositórios.',
  },
  tools: {
    en: 'Tool CALLS — always a count, never money. A tool result is billed inside whatever turn read it, so splitting a session\'s spend across its tools would invent a number that looks measured.',
    pt: 'CHAMADAS de ferramenta — sempre contagem, nunca dinheiro. O resultado de uma ferramenta é cobrado dentro do turno que o leu, então dividir o gasto da sessão entre as ferramentas inventaria um número com cara de medido.',
  },
  hours: {
    en: 'Messages by hour of the local clock, so the peak is the hour you were actually at the keyboard.',
    pt: 'Mensagens por hora do relógio local, então o pico é a hora em que você estava de fato no teclado.',
  },
}

function Bar({ share, color }: { share: number; color: string }) {
  return (
    <div style={{ height: 4, background: 'var(--bg-elevated)', borderRadius: 2, overflow: 'hidden', marginTop: 4 }}>
      <div style={{ height: '100%', width: `${Math.round(share * 100)}%`, background: color, borderRadius: 2, opacity: 0.8 }} />
    </div>
  )
}

function Rows({
  board, metric, colorOf, format: formatValue, onPick, emptyText,
}: {
  board: Board
  metric: TopMetric | 'calls'
  colorOf: (e: Leader, i: number) => string
  format: (e: Leader) => string
  onPick?: (e: Leader) => void
  emptyText: string
}) {
  if (board.entries.length === 0) {
    return <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '6px 0' }}>{emptyText}</div>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {board.entries.map((e, i) => (
        <div
          key={e.key}
          onClick={onPick ? () => onPick(e) : undefined}
          style={{ minWidth: 0, cursor: onPick ? 'pointer' : undefined }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
            <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums', width: 12, flexShrink: 0 }}>
              {i + 1}
            </span>
            <span
              title={e.label}
              style={{
                fontSize: 12, fontWeight: 600, color: 'var(--text-primary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0,
              }}
            >
              {e.label}
            </span>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
              {formatValue(e)}
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums', width: 34, textAlign: 'right', flexShrink: 0 }}>
              {Math.round(shareOf(e, board, metric) * 100)}%
            </span>
          </div>
          <Bar share={shareOf(e, board, metric)} color={colorOf(e, i)} />
        </div>
      ))}
    </div>
  )
}

/**
 * One board: the period ranking, then a rule, then the leader of the most recent active day.
 *
 * The day line is the whole reason this section is not just the /top page in a smaller box. It is
 * absent — not zeroed — when that day has nothing on this dimension, because an entry reading "—"
 * says "nothing led" while a `0` claims a measurement was taken and came back empty.
 */
function BoardCard({
  title, help, board, dayBoard, dayLabel, metric, colorOf, format: formatValue, onPick, lang, emptyText,
}: {
  title: string
  help: string
  board: Board
  dayBoard: Board | null
  dayLabel: string | null
  metric: TopMetric | 'calls'
  colorOf: (e: Leader, i: number) => string
  format: (e: Leader) => string
  onPick?: (e: Leader) => void
  lang: 'en' | 'pt'
  emptyText: string
}) {
  const dayLeader = dayBoard?.entries[0] ?? null
  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
        <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>
          {board.distinct > board.entries.length
            ? (lang === 'pt' ? `top ${board.entries.length} de ${board.distinct}` : `top ${board.entries.length} of ${board.distinct}`)
            : ''}
        </span>
      </div>
      {/* The explanation is ALWAYS rendered, never behind a hover: the whole point of this pass is
          that a number nobody can account for is a number nobody believes. */}
      <div style={{ fontSize: 10, lineHeight: 1.45, color: 'var(--text-tertiary)', marginBottom: 10 }}>
        {help}
      </div>
      <div style={{ flex: 1 }}>
        <Rows board={board} metric={metric} colorOf={colorOf} format={formatValue} onPick={onPick} emptyText={emptyText} />
      </div>
      {dayLabel && (
        <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 10, paddingTop: 8, display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 10, color: 'var(--text-tertiary)', flexShrink: 0 }}>{dayLabel}</span>
          {dayLeader ? (
            <>
              <span
                title={dayLeader.label}
                style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}
              >
                {dayLeader.label}
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                {formatValue(dayLeader)}
              </span>
            </>
          ) : (
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              {lang === 'pt' ? 'nada neste quadro' : 'nothing on this board'}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/** The busiest-hour board, which is a histogram rather than a ranking. */
function HoursCard({ sessions, dayLabel, daySessions, lang, help }: {
  sessions: SessionMeta[]
  dayLabel: string | null
  daySessions: SessionMeta[]
  lang: 'en' | 'pt'
  help: string
}) {
  const period = useMemo(() => hourProfile(sessions), [sessions])
  const day = useMemo(() => hourProfile(daySessions), [daySessions])
  const max = Math.max(...period.hours, 1)
  const hh = (h: number) => `${String(h).padStart(2, '0')}h`

  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-lg)',
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      minWidth: 0,
    }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>
        {lang === 'pt' ? 'Horários de pico' : 'Peak hours'}
      </div>
      <div style={{ fontSize: 10, lineHeight: 1.45, color: 'var(--text-tertiary)', marginBottom: 10 }}>{help}</div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', gap: 1, height: 56 }}>
        {period.hours.map((v, h) => (
          <div
            key={h}
            title={`${hh(h)} — ${v} ${lang === 'pt' ? 'mensagens' : 'messages'}`}
            style={{
              flex: 1,
              height: `${v > 0 ? Math.max((v / max) * 100, 4) : 0}%`,
              background: h === period.peak?.hour ? 'var(--anthropic-orange)' : 'var(--accent-blue)',
              opacity: h === period.peak?.hour ? 1 : 0.45,
              borderRadius: '2px 2px 0 0',
              minWidth: 2,
            }}
          />
        ))}
      </div>
      <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-secondary)', fontWeight: 600 }}>
        {period.peak
          ? (lang === 'pt'
              ? `Pico às ${hh(period.peak.hour)} — ${fmt(period.peak.messages)} msgs (${Math.round(period.peak.share * 100)}%)`
              : `Peak at ${hh(period.peak.hour)} — ${fmt(period.peak.messages)} msgs (${Math.round(period.peak.share * 100)}%)`)
          : (lang === 'pt' ? 'Sem horas registradas neste recorte.' : 'No hours recorded in this scope.')}
      </div>
      {dayLabel && (
        <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 10, paddingTop: 8, display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{dayLabel}</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>
            {day.peak
              ? `${hh(day.peak.hour)} · ${fmt(day.peak.messages)} msgs`
              : (lang === 'pt' ? 'nada registrado' : 'nothing recorded')}
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * The home's leaderboards.
 *
 * Everything here is computed from the ALREADY-FILTERED session list, so the boards describe the
 * same scope as the KPI cards above them — including the empty case, where they say the scope is
 * empty rather than rendering six cards of zeroes.
 */
export function TopBoards({ sessions, lang, currency, brlRate, onSelectSession }: Props) {
  const pt = lang === 'pt'
  const l: 'en' | 'pt' = pt ? 'pt' : 'en'
  const isMobile = useIsMobile()
  const [metric, setMetric] = useState<TopMetric>('cost')

  const day = useMemo(() => lastActiveDay(sessions), [sessions])
  const daySessions = useMemo(() => sessionsOnDay(sessions, day), [sessions, day])
  const byId = useMemo(() => new Map(sessions.map(s => [s.session_id, s])), [sessions])

  const label = (s: SessionMeta) => sessionLabel(s)
  const boards = useMemo(() => ({
    sessions: rankSessions(sessions, metric, label),
    models: rankModels(sessions, metric),
    harnesses: rankHarnesses(sessions, metric),
    projects: rankProjects(sessions, metric),
    tools: rankTools(sessions),
  }), [sessions, metric])
  const dayBoards = useMemo(() => ({
    sessions: rankSessions(daySessions, metric, label, 1),
    models: rankModels(daySessions, metric, 1),
    harnesses: rankHarnesses(daySessions, metric, 1),
    projects: rankProjects(daySessions, metric, 1),
    tools: rankTools(daySessions, 1),
  }), [daySessions, metric])

  const value = (e: Leader): string =>
    metric === 'cost' ? fmtCost(e.cost, currency, brlRate)
    : metric === 'tokens' ? fmt(e.tokens)
    : String(e.sessions)
  const calls = (e: Leader) => `${fmt(e.calls)}×`

  const dayLabel = day
    ? (pt ? `${format(parseISO(day), 'dd/MM')}:` : `${format(parseISO(day), 'MMM d')}:`)
    : null
  const empty = pt ? 'Nada neste recorte.' : 'Nothing in this scope.'

  const rank = (_e: Leader, i: number) =>
    ['var(--anthropic-orange)', 'var(--accent-blue)', 'var(--accent-purple)', 'var(--accent-green)', 'var(--accent-cyan)'][i] ?? 'var(--accent-blue)'

  if (sessions.length === 0) {
    return (
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '8px 2px' }}>
        {pt ? 'Nenhuma sessão no recorte atual.' : 'No sessions in the current scope.'}
      </div>
    )
  }

  return (
    <div>
      {/* The metric switch governs every board that HAS a metric. The tool board is deliberately
          outside it — see BOARD_HELP.tools. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {pt ? 'Ordenar por' : 'Rank by'}
        </span>
        {METRICS.map(m => (
          <button
            key={m}
            onClick={() => setMetric(m)}
            className="ag-tap"
            style={{
              padding: isMobile ? '5px 12px' : '4px 10px',
              borderRadius: 999,
              border: `1px solid ${metric === m ? 'var(--anthropic-orange)' : 'var(--border)'}`,
              background: metric === m ? 'var(--anthropic-orange)' : 'transparent',
              color: metric === m ? '#fff' : 'var(--text-secondary)',
              fontSize: 11,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {METRIC_LABEL[m][l]}
          </button>
        ))}
        {day && (
          <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginLeft: 'auto' }}>
            {pt
              ? `A linha inferior de cada quadro é o dia ativo mais recente do recorte (${format(parseISO(day), 'dd/MM/yyyy')}).`
              : `The bottom line of each card is the most recent active day in this scope (${format(parseISO(day), 'MMM d, yyyy')}).`}
          </span>
        )}
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: 12,
        alignItems: 'stretch',
      }}>
        <BoardCard
          title={pt ? 'Top sessões' : 'Top sessions'}
          help={BOARD_HELP.sessions![l]}
          board={boards.sessions} dayBoard={dayBoards.sessions} dayLabel={dayLabel}
          metric={metric} colorOf={rank} format={value} lang={l} emptyText={empty}
          onPick={onSelectSession ? e => { const s = byId.get(e.key); if (s) onSelectSession(s) } : undefined}
        />
        <BoardCard
          title={pt ? 'Top modelos' : 'Top models'}
          help={BOARD_HELP.models![l]}
          board={{ ...boards.models, entries: boards.models.entries.map(e => ({ ...e, label: formatModel(e.key) })) }}
          dayBoard={{ ...dayBoards.models, entries: dayBoards.models.entries.map(e => ({ ...e, label: formatModel(e.key) })) }}
          dayLabel={dayLabel}
          metric={metric} colorOf={rank} format={value} lang={l} emptyText={empty}
        />
        <BoardCard
          title={pt ? 'Top assistentes' : 'Top assistants'}
          help={BOARD_HELP.harnesses![l]}
          board={{ ...boards.harnesses, entries: boards.harnesses.entries.map(e => ({ ...e, label: HARNESS_LABELS[e.key as HarnessId] ?? e.key })) }}
          dayBoard={{ ...dayBoards.harnesses, entries: dayBoards.harnesses.entries.map(e => ({ ...e, label: HARNESS_LABELS[e.key as HarnessId] ?? e.key })) }}
          dayLabel={dayLabel}
          metric={metric}
          colorOf={e => HARNESS_COLORS[e.key as HarnessId] ?? 'var(--accent-blue)'}
          format={value} lang={l} emptyText={empty}
        />
        <BoardCard
          title={pt ? 'Top projetos' : 'Top projects'}
          help={BOARD_HELP.projects![l]}
          board={{ ...boards.projects, entries: boards.projects.entries.map(e => ({ ...e, label: formatProjectName(e.key) })) }}
          dayBoard={{ ...dayBoards.projects, entries: dayBoards.projects.entries.map(e => ({ ...e, label: formatProjectName(e.key) })) }}
          dayLabel={dayLabel}
          metric={metric} colorOf={rank} format={value} lang={l} emptyText={empty}
        />
        <BoardCard
          title={pt ? 'Top ferramentas' : 'Top tools'}
          help={BOARD_HELP.tools![l]}
          board={boards.tools} dayBoard={dayBoards.tools} dayLabel={dayLabel}
          metric="calls" colorOf={rank} format={calls} lang={l} emptyText={empty}
        />
        <HoursCard
          sessions={sessions}
          daySessions={daySessions}
          dayLabel={dayLabel}
          lang={l}
          help={BOARD_HELP.hours![l]}
        />
      </div>
    </div>
  )
}
