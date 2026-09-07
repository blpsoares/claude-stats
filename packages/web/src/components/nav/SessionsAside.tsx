/**
 * SessionsAside — the fleet, in the sidebar's body.
 *
 * It arranges NOTHING itself. Grouping, ordering and search all come from
 * `@agentistics/tui/control/session-fleet` — the very module the terminal cockpit resolves them
 * with — because two implementations of "which band does this row belong to" is exactly the defect
 * this whole branch exists to remove. What this file owns is the drawing.
 *
 * The list is the FLEET, not the stored history: it shows a session that is running with no stored
 * conversation behind it (an `external` assistant, a `lost` row after a reboot, one started a moment
 * ago), which the old page could not, because it listed metrics and hung the fleet off them as
 * decoration.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useNavigate, useParams } from 'react-router-dom'
import { Clock, Pin, PinOff, Plus, Search, X } from 'lucide-react'
import type { Filters } from '@agentistics/core'
import {
  ACTIVE_STATES, DEFAULT_ORDER, filterSessions, sessionNotify, sortSessions,
  type ControlSession,
} from '@agentistics/tui/control/session-fleet'
import { rowSelected } from '../../lib/fleetSelection'
import { filterFleet, ignoredDimensions } from '../../lib/fleetFilter'
import { NewSessionModal } from '../sessions/NewSessionModal'
import { rowMenuEntries, type RowVerb } from '../../lib/rowMenu'
import { SessionRowMenu } from '../sessions/SessionRowMenu'
import { SessionFacts } from '../sessions/SessionFacts'
import { sessionPath } from '../../lib/sessionRoute'
import {
  MAX_PINNED, getPinnedIds, movePinnedSession, pinnedServerSnapshot, resolvePinnedRows,
  subscribePinnedSessions, togglePinnedSession,
} from '../../lib/pinnedSessions'

export interface SessionsAsideProps {
  lang: 'pt' | 'en'
  rows: readonly ControlSession[]
  finishedTasks: readonly string[]
  /** True until the first poll answers — an empty list before then is "not asked yet". */
  loading: boolean
  /** This machine may not be asked at all: a central, or a profile with no host power. */
  unsupported: boolean
  /** Already-localized reason the list may not be the whole truth. */
  unavailable?: string
  /**
   * The SAME filters the dashboard's header uses — harness/project/repo/model narrow the fleet
   * too now (see `filterFleet.ts`); every other dimension there (date range, tags, members…) is
   * read only where a live row can actually answer it, which today is none of them. Owned by
   * `App.tsx`, not here: the control that edits it (`FiltersBar`, in the shared sticky header) is
   * a sibling of this aside, not a child of it.
   */
  filters: Filters
  /**
   * The fleet's OWN "only what is running" switch — not part of `Filters` (see `fleetFilter.ts`'s
   * header), and also owned by `App.tsx` now so the SAME control in the header can default it ON
   * for this workspace and OFF for the dashboard. This aside only reads it.
   */
  activeOnly: boolean
  /**
   * Already-worded reason the list may not be current (`fleetStale.ts`), or null when it is.
   *
   * Rendered whether or not the list is empty, which is what separates it from `EmptyReason`: the
   * case it exists for is rows on screen that are no longer true.
   */
  stale?: string | null
  /**
   * What clicking a row does, when it is not "open it on THIS machine".
   *
   * The central's Sessions page draws the very same list for a machine's RELAYED rows, where
   * `/sessions/:id` would open a local session that does not exist here. Absent on a machine,
   * where the route is exactly right.
   */
  onOpenRow?: (row: ControlSession) => void
  /**
   * Withholds "New session".
   *
   * Starting one is a LOCAL act (`POST /api/fleet/new` spawns a process on the host), so a central
   * drawing this list for someone else's machine must not offer it — a button whose only outcome
   * is a refusal is a button that teaches the wrong thing.
   */
  hideNew?: boolean
  /**
   * The fleet's own verb-carrying rows, keyed by id — for the row's context menu (Task 6).
   *
   * Absent on a surface that cannot act (a central relaying a machine that has not granted the
   * screen/action switches yet): the menu is then not opened at all, rather than opened inert.
   */
  rowsById?: Map<string, { verbs: RowVerb[] }>
  /** Performs a verb. Absent exactly where `rowsById` is absent. */
  act?: (req: { id: string; action: string; text?: string }) => Promise<{ ok: boolean; message: string; id?: string }>
}

/** The colour a state is said in. `running` is its own token, not `success`, which reads teal. */
const STATE_COLOR: Record<string, string> = {
  working: 'var(--accent-green)',
  waiting: 'var(--anthropic-orange)',
  'waiting-approval': 'var(--anthropic-orange)',
  exited: 'var(--text-tertiary)',
  lost: 'var(--text-tertiary)',
  closed: 'var(--text-tertiary)',
  unknown: 'var(--text-tertiary)',
}

/**
 * The wash behind a LIVE row, so its state is readable without reading the word.
 *
 * Only the two active states get one. A tint on every row is a list with no contrast left, and the
 * point of the wash is that the handful of rows doing something stand out from the history under
 * them. It is a WASH, never the row's whole background: the selected row's own highlight has to
 * stay distinguishable from it, or selection stops being visible on exactly the rows you select
 * most.
 */
const STATE_WASH: Record<string, string> = {
  working: 'color-mix(in srgb, #22c55e 10%, transparent)',
  waiting: 'color-mix(in srgb, var(--anthropic-orange) 12%, transparent)',
  'waiting-approval': 'color-mix(in srgb, var(--anthropic-orange) 12%, transparent)',
}

/**
 * What a pin is stored under.
 *
 * The CONVERSATION where the harness reports one, because a managed row's id is its tmux session
 * name and is minted fresh on every reopen — keying by that would unpin a conversation at exactly
 * the moment somebody who pinned it wants it back. Where no conversation link can ever exist
 * (codex, kimi, gemini, agy — see `conversationBlind`) the row id is the only key there is.
 */
function pinKeyOf(row: ControlSession): string {
  return row.conversationId ?? row.id
}

export function SessionsAside({
  lang, rows, loading, unsupported, unavailable, filters, activeOnly, finishedTasks, stale,
  onOpenRow, hideNew, rowsById, act,
}: SessionsAsideProps) {
  const pt = lang === 'pt'
  const navigate = useNavigate()
  // 44px is the MOBILE figure. Applying it on desktop turns a compact list into a row of buttons.
  const isMobile = useIsMobile()
  const tap = isMobile ? 44 : undefined
  const { sessionId } = useParams()
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  /**
   * The pinned set, from the module that already owns it.
   *
   * `useSyncExternalStore` rather than local state because the store is shared — `RecentSessions`
   * reads the same one — and two components holding their own copy is how a pin lands in one list
   * and not the other. Its rules (a hard limit of three, the fourth REFUSED rather than silently
   * swapped) live there and are not re-decided here.
   */
  const pins = useSyncExternalStore(subscribePinnedSessions, getPinnedIds, pinnedServerSnapshot)
  const pinned = useMemo(() => new Set(pins), [pins])
  const flip = (row: ControlSession) => {
    const out = togglePinnedSession(pinKeyOf(row))
    if (!out.ok && out.reason === 'limit') {
      setNotice(pt
        ? `No máximo ${MAX_PINNED} conversas fixadas. Solte uma antes de fixar outra.`
        : `At most ${MAX_PINNED} pinned conversations. Unpin one first.`)
      return
    }
    setNotice(null)
  }
  /** No longer only about pins — the row menu's action results land here too. */
  const [notice, setNotice] = useState<string | null>(null)
  /** Which pinned row is being dragged, and where it would land. Local: a drag is not shared state. */
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; state: string; verbs: RowVerb[] } | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  const openMenu = (session: ControlSession, x: number, y: number, verbs: RowVerb[]) => {
    setMenu({ x, y, id: session.id, state: session.state, verbs })
  }

  const pickMenuAction = (action: string) => {
    if (!menu) return
    const { id } = menu
    if (action === 'rename') {
      const target = rows.find(r => r.id === id)
      setRenaming({ id, title: target?.title ?? '' })
      setRenameDraft(target?.title ?? '')
      return
    }
    if (!act) return
    void act({ id, action }).then(out => setNotice(out.message))
  }

  // The top bar's magnifier focuses this field. An event rather than a prop because the button and
  // the field are in two different subtrees, and threading a ref through the whole shell to join
  // them would put layout plumbing in every component between.
  useEffect(() => {
    const focus = () => searchRef.current?.focus()
    window.addEventListener('agentistics:focus-session-search', focus)
    return () => window.removeEventListener('agentistics:focus-session-search', focus)
  }, [])

  // `now` is read once per arrangement rather than per row: two rows landing either side of midnight
  // during one render would be banded against two different "today"s.
  const active = useMemo(() => new Set<string>(ACTIVE_STATES), [])
  // `filterFleet` owns harness/project/repo/model AND `activeOnly`, but the switch needs its OWN
  // withheld count (see `hidden` below) independent of the value filters, so it is applied here as
  // an ordinary array filter rather than through `activeOnly: true`.
  const valueFiltered = useMemo(
    () => filterFleet({ rows, filters, activeOnly: false }).rows,
    [rows, filters],
  )
  const searched = useMemo(() => filterSessions(valueFiltered, query), [valueFiltered, query])
  const matched = useMemo(
    () => (activeOnly ? searched.filter(r => active.has(r.state)) : searched),
    [searched, activeOnly, active],
  )
  /** How many rows the switch is withholding, so the row can say what turning it off would show. */
  const hidden = useMemo(
    () => (activeOnly ? searched.filter(r => !active.has(r.state)).length : 0),
    [searched, activeOnly, active],
  )
  /** Which SET filter dimensions this fleet cannot answer at all, said in one line — never silent. */
  const ignoredNote = useMemo(() => ignoredDimensions(filters, lang), [filters, lang])

  /** The pinned rows, in the order they were pinned. Their own band, above everything. */
  // Resolved from the RAW `rows`, never from `matched` — a filter, a search or "active only" must
  // never remove a row from the pinned band (see the header comment, and `resolvePinnedRows`'s
  // own). Reading from `matched` was the bug: it is already cut by `activeOnly` (on by default
  // here), so a pinned session that finished while the person was away vanished from the band the
  // moment its state left `ACTIVE_STATES` — no reload needed, just the ordinary case of a pinned
  // session finishing.
  const pinnedRows = useMemo(() => resolvePinnedRows(pins, rows, pinKeyOf), [pins, rows])

  /**
   * TWO bands — Active and Inactive.
   *
   * A picker for the cockpit's other dimensions (day/repo/project/task/harness/model) was built,
   * shipped and then REMOVED at the user's request: it read as another filter sitting beside the
   * real ones, and nobody asked the list to be arranged seven ways. What the list is for is what
   * is running, ranked by what needs you most, and everything else beneath it.
   *
   * `DEFAULT_ORDER` (`state`, via `sessionRank`) is the SAME ranking the terminal cockpit breaks
   * ties on, so "sorted by status" means one thing in both places.
   */
  const bands = useMemo((): { label: string; rows: ControlSession[] }[] => {
    const rest = matched.filter(r => !pinned.has(pinKeyOf(r)))
    return [
      { label: pt ? 'Ativas' : 'Active', rows: sortSessions(rest.filter(r => active.has(r.state)), DEFAULT_ORDER) },
      // Never computed while activeOnly is on — those rows are the ones the switch is withholding,
      // not a second list to render beside it.
      { label: pt ? 'Inativas' : 'Inactive', rows: activeOnly ? [] : sortSessions(rest.filter(r => !active.has(r.state)), DEFAULT_ORDER) },
    ]
  }, [matched, pinned, active, activeOnly, pt])

  const total = bands.reduce((n, b) => n + b.rows.length, 0) + pinnedRows.length
  const filterCount = (filters.harnesses?.length ?? 0) + filters.projects.length
    + (filters.repos?.length ?? 0) + filters.models.length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, gap: 10, paddingTop: 4 }}>
      {!hideNew && (
      <button
        onClick={() => setCreating(true)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
          margin: '0 2px', padding: '9px 12px', borderRadius: 9, cursor: 'pointer', minHeight: tap,
          border: '1px dashed var(--border)', background: 'transparent',
          color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
        }}
        onMouseEnter={e => {
          e.currentTarget.style.borderColor = 'var(--anthropic-orange)'
          e.currentTarget.style.color = 'var(--anthropic-orange)'
        }}
        onMouseLeave={e => {
          e.currentTarget.style.borderColor = 'var(--border)'
          e.currentTarget.style.color = 'var(--text-secondary)'
        }}
      >
        <Plus size={14} />
        {pt ? 'Nova sessão' : 'New session'}
      </button>
      )}

      {creating && (
        <NewSessionModal
          lang={lang}
          onClose={() => setCreating(false)}
          onStarted={id => {
            setCreating(false)
            // Straight into it. The row will arrive on the next poll; navigating now means the
            // panel is already open on it when it does.
            if (id) navigate(sessionPath(id))
          }}
        />
      )}

      <div style={{ position: 'relative', padding: '0 2px' }}>
        <Search
          size={13}
          style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)', pointerEvents: 'none' }}
        />
        <input
          ref={searchRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={pt ? 'Buscar sessão…' : 'Search sessions…'}
          style={{
            width: '100%', boxSizing: 'border-box',
            padding: '9px 26px 9px 30px', borderRadius: 9,
            border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
            color: 'var(--text-primary)', fontFamily: 'inherit',
            // 16px on mobile or iOS Safari zooms the viewport; the global guard in index.css
            // handles it, so this stays the desktop figure and is not overridden inline.
            fontSize: 12.5, outline: 'none',
          }}
        />
        {query !== '' && (
          <button
            onClick={() => setQuery('')}
            aria-label={pt ? 'Limpar busca' : 'Clear search'}
            style={{
              position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
              display: 'flex', border: 'none', background: 'transparent',
              color: 'var(--text-tertiary)', cursor: 'pointer', padding: 2,
            }}
          >
            <X size={12} />
          </button>
        )}
      </div>

      {notice && (
        <p role="status" style={{
          margin: '0 4px', fontSize: 11, lineHeight: 1.45, color: 'var(--anthropic-orange)',
        }}>
          {notice}
        </p>
      )}

      {/* The list is real but not current — either the machine stopped answering, or these rows
          came out of the stored snapshot and no poll has confirmed them yet. `fleetStale.ts` owns
          which of the two it is and words each differently; here it is only drawn.

          ABOVE the scroller, not inside it: a caveat about every row below has to be readable
          wherever the reader has scrolled to, and one that scrolls away is one seen once. It is
          also drawn whether or not there are rows — this is the case of rows on screen that are no
          longer true, which is precisely what an empty-state message cannot cover.

          Deliberately NOT `--accent-red`: nothing has failed in the seeded case, and in the stale
          case the machine being unreachable is a fact about the connection, not a fault in the
          fleet. Same reasoning the cockpit's central pill applies to `stale`. */}
      {stale && (
        <p role="status" style={{
          display: 'flex', alignItems: 'flex-start', gap: 6,
          margin: '0 2px', padding: '7px 9px', borderRadius: 8,
          background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
          fontSize: 10.5, lineHeight: 1.45, color: 'var(--text-tertiary)',
        }}>
          <Clock size={12} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{stale}</span>
        </p>
      )}

      {/* A filter dimension that is SET but cannot narrow a live fleet (date range, tags, members,
          teams, machines) is said here, above the scroller — the same placement `stale` uses, and
          for the same reason: a caveat about every row below must be readable wherever the reader
          has scrolled. Silence here reads as a broken filter, not an honest one. */}
      {ignoredNote && (
        <p role="status" style={{
          margin: '0 2px', padding: '7px 9px', borderRadius: 8,
          background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)',
          fontSize: 10.5, lineHeight: 1.45, color: 'var(--text-tertiary)',
        }}>
          {ignoredNote}
        </p>
      )}

      <div className="ag-noscroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
        {/* The pinned band, above everything — that is what pinning is for: the two or three
            sessions that must not move when the arrangement changes. */}
        {pinnedRows.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 9px 7px', fontSize: 10.5, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--anthropic-orange)',
            }}>
              <Pin size={11} />
              <span>{pt ? 'Fixadas' : 'Pinned'}</span>
              <span style={{ marginLeft: 'auto', fontWeight: 600, opacity: 0.75 }}>{pinnedRows.length}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {pinnedRows.map((s, i) => (
                <div
                  key={`pin-${s.id}`}
                  draggable
                  onDragStart={e => { setDragFrom(i); e.dataTransfer.effectAllowed = 'move' }}
                  onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(i) }}
                  onDragEnd={() => { setDragFrom(null); setDragOver(null) }}
                  onDrop={e => {
                    e.preventDefault()
                    if (dragFrom !== null) movePinnedSession(dragFrom, i)
                    setDragFrom(null); setDragOver(null)
                  }}
                  style={{
                    // The drop target is shown as an EDGE, not by moving the rows: a list that
                    // reflows under the cursor moves the target you were aiming at.
                    boxShadow: dragOver === i && dragFrom !== null && dragFrom !== i
                      ? 'inset 0 2px 0 var(--anthropic-orange)'
                      : undefined,
                    opacity: dragFrom === i ? 0.45 : 1,
                    ...(tap ? { touchAction: 'none' as const } : {}),
                  }}
                >
                  <SessionRow
                    session={s}
                    selected={rowSelected(s, sessionId)}
                    pinned
                    {...(tap ? { tap } : {})}
                    onPin={() => flip(s)}
                    onOpen={() => (onOpenRow ? onOpenRow(s) : navigate(sessionPath(s.id)))}
                    onMoveBy={d => movePinnedSession(i, i + d)}
                    {...(rowsById?.get(s.id) ? { verbs: rowsById.get(s.id)!.verbs } : {})}
                    onOpenMenu={(x, y, verbs) => openMenu(s, x, y, verbs)}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
        {total === 0 ? (
          <EmptyReason
            pt={pt} loading={loading} unsupported={unsupported}
            unavailable={unavailable} searching={query !== ''}
            withheld={activeOnly ? hidden : 0}
            filterNarrowed={filterCount > 0 && valueFiltered.length < rows.length}
          />
        ) : (
          <>
            {bands.map((b, i) => (
              <SessionBand
                // The label is not unique — two dimensions can legitimately produce one word, and
                // an empty band still holds its place in the order.
                key={`${i}-${b.label}`}
                label={b.label} rows={b.rows} pinned={pinned}
                sessionId={sessionId} tap={tap} onPin={flip}
                onOpen={s => (onOpenRow ? onOpenRow(s) : navigate(sessionPath(s.id)))}
                {...(rowsById ? { rowsById } : {})}
                onOpenMenu={openMenu}
              />
            ))}
          </>
        )}
      </div>

      {/* The row's context menu (Task 6) — rename / stop / reopen, exactly the row's own verbs. */}
      {menu && (
        <SessionRowMenu
          x={menu.x} y={menu.y}
          entries={rowMenuEntries(menu.verbs, menu.state)}
          onPick={pickMenuAction}
          onClose={() => setMenu(null)}
        />
      )}

      {/* A tiny rename prompt, seeded with the row's current title — the same shape the panel's own
          rename flow uses (`SessionActions`'s `asking` form), reachable here for a row that may not
          be the one currently open. */}
      {renaming && (
        <div
          role="dialog"
          aria-label={pt ? 'Renomear sessão' : 'Rename session'}
          style={{ position: 'fixed', inset: 0, zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            onClick={() => setRenaming(null)}
            style={{ position: 'absolute', inset: 0, background: 'var(--ag-scrim, rgba(0,0,0,0.4))' }}
          />
          <form
            onSubmit={e => {
              e.preventDefault()
              if (!act) return
              const id = renaming.id
              void act({ id, action: 'rename', text: renameDraft.trim() }).then(out => {
                setNotice(out.message)
                setRenaming(null)
              })
            }}
            style={{
              position: 'relative', zIndex: 1, minWidth: 260, maxWidth: 340,
              background: 'var(--bg-surface)', border: '1px solid var(--border)',
              borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
              boxShadow: 'var(--ag-shadow-menu)',
            }}
          >
            <label style={{
              fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '0.05em', color: 'var(--text-tertiary)',
            }}>
              {pt ? 'Novo nome' : 'New name'}
            </label>
            <input
              autoFocus
              value={renameDraft}
              onChange={e => setRenameDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setRenaming(null) }}
              style={{
                width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
                border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
                color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13, outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button
                type="button" onClick={() => setRenaming(null)}
                style={{
                  padding: '6px 11px', borderRadius: 8, cursor: 'pointer',
                  border: '1px solid var(--border-subtle)', background: 'transparent',
                  color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12,
                }}
              >
                {pt ? 'Cancelar' : 'Cancel'}
              </button>
              <button
                type="submit"
                style={{
                  padding: '6px 12px', borderRadius: 8, cursor: 'pointer', border: 'none',
                  background: 'var(--anthropic-orange)', color: '#fff',
                  fontFamily: 'inherit', fontSize: 12, fontWeight: 650,
                }}
              >
                {pt ? 'Salvar' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

/** One band of the two-way (active/inactive) split. Absent when it would be empty — an empty
 *  band with a heading and no rows under it is a label pretending to be information. */
function SessionBand({ label, rows, pinned, sessionId, tap, onPin, onOpen, rowsById, onOpenMenu }: {
  label: string
  rows: readonly ControlSession[]
  pinned: ReadonlySet<string>
  sessionId?: string
  tap?: number
  onPin: (row: ControlSession) => void
  onOpen: (row: ControlSession) => void
  rowsById?: Map<string, { verbs: RowVerb[] }>
  onOpenMenu: (session: ControlSession, x: number, y: number, verbs: RowVerb[]) => void
}) {
  if (rows.length === 0) return null
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 6,
        padding: '6px 9px 7px', fontSize: 10.5, fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-tertiary)',
      }}>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        <span style={{ marginLeft: 'auto', fontWeight: 600, opacity: 0.75 }}>{rows.length}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {rows.map(s => (
          <SessionRow
            key={s.id}
            session={s}
            selected={rowSelected(s, sessionId)}
            pinned={pinned.has(pinKeyOf(s))}
            {...(tap ? { tap } : {})}
            onPin={() => onPin(s)}
            onOpen={() => onOpen(s)}
            {...(rowsById?.get(s.id) ? { verbs: rowsById.get(s.id)!.verbs } : {})}
            onOpenMenu={(x, y, verbs) => onOpenMenu(s, x, y, verbs)}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * Why the list is empty, in words.
 *
 * Five different facts, and rendering any of them as the others is the confident-zero defect: not
 * asked yet, this machine may not be asked, the poll failed, your search matched nothing, the
 * fleet's own filters (harness/project/repo/model or "active only", now both in the shared header
 * above) are withholding rows, and there are genuinely none. Each sends a reader somewhere
 * different — the switch that would fix it is named rather than repeated as a second control here,
 * since the real one already sits in the header this list scrolls under.
 */
function EmptyReason({
  pt, loading, unsupported, unavailable, searching, withheld, filterNarrowed,
}: {
  pt: boolean; loading: boolean; unsupported: boolean; unavailable?: string; searching: boolean
  /** How many rows the "active only" switch (now in the shared header) is holding back. */
  withheld: number
  /** The shared header's harness/project/repo/model filter hid every row — a SEPARATE fact from
      the "active only" switch, and checked first: with the filter narrowing to nothing, the switch
      and the search both read as empty too, and blaming either would point at a control that was
      never the cause. */
  filterNarrowed: boolean
}) {
  const text = loading
    ? (pt ? 'Lendo as sessões desta máquina…' : 'Reading this machine’s sessions…')
    : unsupported
      ? (pt
          ? 'Esta instalação não lista sessões próprias — um central agrega várias máquinas e não hospeda as sessões de nenhuma delas.'
          : 'This install lists no sessions of its own — a central aggregates many machines and hosts none of their sessions.')
      : unavailable
        ? unavailable
        : filterNarrowed
          ? (pt ? 'Nenhuma sessão corresponde aos filtros no topo.' : 'No session matches the filters above.')
          : withheld > 0
            ? (pt
                ? `Nada rodando agora. ${withheld} ${withheld === 1 ? 'conversa está' : 'conversas estão'} escondida${withheld === 1 ? '' : 's'} por "Só ativas".`
                : `Nothing is running right now. ${withheld} ${withheld === 1 ? 'conversation is' : 'conversations are'} hidden by "Active only".`)
            : searching
              ? (pt ? 'Nenhuma sessão corresponde à busca.' : 'No session matches that search.')
              : (pt ? 'Nenhuma sessão nesta máquina ainda.' : 'No sessions on this machine yet.')

  return (
    <div style={{
      padding: '14px 10px', fontSize: 11.5, lineHeight: 1.55,
      color: 'var(--text-tertiary)',
    }}>
      {text}
    </div>
  )
}


function SessionRow({ session, selected, pinned, tap, onPin, onOpen, onMoveBy, verbs, onOpenMenu }: {
  session: ControlSession; selected: boolean
  /** Minimum row height on mobile — 44px, and undefined on desktop. */
  tap?: number
  pinned?: boolean
  onPin?: () => void
  onOpen: () => void
  /** Reorder this pinned row by `delta` places. Only ever passed for a row in the Pinned band. */
  onMoveBy?: (delta: number) => void
  /** This row's own verbs, for the context menu (Task 6). Absent where the caller has none to offer. */
  verbs?: RowVerb[]
  /** Opens the context menu at a point, carrying the verbs it was opened with. */
  onOpenMenu?: (x: number, y: number, verbs: RowVerb[]) => void
}) {
  const wants = sessionNotify(session)
  const color = STATE_COLOR[session.state] ?? 'var(--text-tertiary)'
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearLongPress = () => {
    if (longPress.current !== null) { clearTimeout(longPress.current); longPress.current = null }
  }
  return (
    <button
      onClick={onOpen}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '9px 9px', borderRadius: 9, border: 'none', textAlign: 'left', minHeight: tap,
        // SELECTED is NOT orange. Orange is already the state colour for a row that needs a person
        // (`STATE_COLOR.waiting`), so the selected row wore the same tint as the alarm and the two
        // became one signal: selecting a working session made it look like it was asking for you.
        // Selection is a fact about where the READER is, so it uses the neutral surface tokens —
        // a lifted background and a full-height accent-free edge — and leaves every colour on this
        // list to mean exactly one thing about the SESSION.
        background: selected ? 'var(--bg-elevated)' : (STATE_WASH[session.state] ?? 'transparent'),
        // Two different edges, and they never collide: the STATE edge is the left rule a live row
        // carries, and SELECTION replaces it with a brighter, full one plus an outline. The wash
        // alone is faint by design, and an edge survives a light theme and a colour-blind reader
        // where a 10% tint does not.
        boxShadow: selected
          ? 'inset 3px 0 0 var(--text-primary), inset 0 0 0 1px var(--border)'
          : (STATE_WASH[session.state]
            ? `inset 2px 0 0 ${STATE_COLOR[session.state] ?? 'transparent'}`
            : undefined),
        color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
        cursor: 'pointer', fontFamily: 'inherit', minWidth: 0,
        transition: 'background 0.15s',
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--bg-elevated)' }}
      onMouseLeave={e => {
        if (!selected) e.currentTarget.style.background = STATE_WASH[session.state] ?? 'transparent'
      }}
      onKeyDown={e => {
        // alt+arrows, so the plain arrows keep whatever the browser and the list do with them. A
        // reorder that exists only for a mouse is a reorder half the readers do not have.
        if (onMoveBy && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault()
          onMoveBy(e.key === 'ArrowUp' ? -1 : 1)
        }
      }}
      onContextMenu={e => {
        // No verbs to show is not an error — it lets the browser's own menu through rather than
        // opening one with nothing in it.
        if (!verbs || verbs.length === 0 || !onOpenMenu) return
        e.preventDefault()
        onOpenMenu(e.clientX, e.clientY, verbs)
      }}
      onTouchStart={e => {
        if (!verbs || verbs.length === 0 || !onOpenMenu) return
        const touch = e.touches[0]
        if (!touch) return
        const x = touch.clientX
        const y = touch.clientY
        longPress.current = setTimeout(() => onOpenMenu(x, y, verbs), 500)
      }}
      onTouchMove={clearLongPress}
      onTouchEnd={clearLongPress}
      onTouchCancel={clearLongPress}
      aria-current={selected ? 'true' : undefined}
      title={session.model ? `${session.title}\n${session.model}` : session.title}
    >
      {/* The dot marks a row that WANTS somebody. It never carries the message alone — the state
          word is beside it — because a fact said only in colour is a fact some readers never get. */}
      <span
        aria-hidden
        style={{
          width: 6, height: 6, borderRadius: 3, flexShrink: 0,
          background: wants ? 'var(--anthropic-orange)' : color,
          opacity: wants ? 1 : 0.55,
        }}
      />
      <SessionFacts session={session} selected={selected} />
      {/* The assistant, NAMED. It was a 5px dot, which carries the fact in colour alone — and a
          colour is not a name. The model sits with it on the meta line below. */}
      {/* The pin lives on the row rather than in a menu: it is a one-click decision about the row
          you are looking at. `role="button"` on a span, because a <button> inside a <button> is
          invalid HTML and browsers resolve it by dropping one of them. */}
      {onPin && (
        <span
          role="button"
          tabIndex={0}
          aria-label={pinned ? 'Unpin' : 'Pin'}
          title={pinned ? 'Unpin' : 'Pin'}
          onClick={e => { e.stopPropagation(); onPin() }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onPin() }
          }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            width: 20, height: 20, borderRadius: 6, cursor: 'pointer',
            color: pinned ? 'var(--anthropic-orange)' : 'var(--text-tertiary)',
            // A pin nobody set is faint until the row is hovered: a column of pin glyphs down an
            // unpinned list is noise beside the titles they sit next to.
            // There is no hover on a touch screen, so the pin is always visible there. On desktop
            // it appears with the row — see `.ag-row-pin` in index.css.
            opacity: pinned || tap ? 1 : 0,
            transition: 'opacity 0.15s',
          }}
          className="ag-row-pin"
        >
          {pinned ? <Pin size={12} /> : <PinOff size={12} />}
        </span>
      )}
    </button>
  )
}
