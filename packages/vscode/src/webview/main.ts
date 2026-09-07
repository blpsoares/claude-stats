/**
 * main.ts — the panel: the fleet, and one session at a time.
 *
 * Two views, one document. `list` is the fleet; `session` is one session's live screen, its
 * composer and its verbs. The sidebar walks between them; an editor TAB is created pinned to a
 * session and never shows the list, which is what lets several be open at once.
 *
 * Built with DOM calls, not `innerHTML`. Every string here is somebody's session title, note, path
 * or a line captured off a terminal, and a template literal is one unescaped `<` away from
 * executing it. There is exactly ONE exception — the terminal screen, whose HTML `ansi.ts` builds
 * and escapes itself — and it is marked at the assignment.
 *
 * It renders and reports intents. It decides nothing about sessions: which verbs a row may take,
 * what each is called, why one is off, whether a session can be typed into and what the screen is
 * showing are all decided upstream — by the server, or by the very modules the dashboard uses.
 */

import { ansiToHtml } from '../ansi'
import { fill } from '../i18n'
import {
  DEFAULT_ARRANGEMENT,
  type Arrangement, type FleetActionId, type FleetRow, type FleetView, type HostMessage,
  type LinkStatus, type NewOptions, type Route, type SpawnRequest, type ViewMessage,
} from '../protocol'
import { shortenPath } from '../paths'
// The browser half of the terminal contract, imported from the dashboard rather than restated: the
// phase machine, the parsers and the SENTENCE that says whether you are looking at a live screen, a
// finished session or one that is gone. A second copy in an editor client would be a second set of
// honesty rules, and the two would disagree about a frozen screen — which is the one thing this
// feature may never be wrong about.
import {
  INITIAL_TERMINAL_STATE, parseEnd, parseFrame, parseOpen, terminalReducer, terminalStatus,
  type TerminalState,
} from '../../../web/src/lib/terminalStream'
import { interactionBlock } from '../../../web/src/lib/terminalInput'

declare function acquireVsCodeApi(): {
  postMessage(msg: ViewMessage): void
  getState(): unknown
  setState(state: unknown): void
}

const vscode = acquireVsCodeApi()

/** What this SURFACE remembers. The arrangement itself is the HOST's — every panel shares one. */
interface Persisted {
  arrangeOpen: boolean
}

const restored = (vscode.getState() as Persisted | undefined) ?? { arrangeOpen: false }

const state = {
  route: { view: 'list' } as Route,
  pinned: false,
  theme: 'dark' as 'dark' | 'light',
  /** How the fleet is arranged. Echoed back by the host, never decided here. */
  arrangement: DEFAULT_ARRANGEMENT as Arrangement,
  /** The arranged fleet the server computed. `null` until the first answer. */
  view: null as FleetView | null,
  arrangeOpen: restored.arrangeOpen ?? false,
  expanded: null as string | null,
  wizard: false,
  busy: new Set<string>(),
  strings: {} as Record<string, string>,
  lang: 'en' as 'en' | 'pt',
  link: { state: 'down', url: '' } as LinkStatus,
  rows: [] as FleetRow[],
  attention: 0,
  unavailable: undefined as string | undefined,
  tasks: [] as string[],
  /** The sessions that fell together, when some did — the "reopen what fell" offer. */
  fell: undefined as { count: number; atMs: number } | undefined,
  options: null as NewOptions | null,
  result: undefined as { ok: boolean; message: string } | undefined,
  /** Per session, so walking away and back does not lose a screen. */
  terminals: new Map<string, TerminalState>(),
  /** True once the screen has the keyboard — see `renderScreen`. */
  typing: false,
  /** Session ids the user pinned. Kept by the HOST, so a reload and every tab agree. */
  pins: new Set<string>(),
  /** The session whose stream this surface has asked for. */
  watching: null as string | null,
}

function s(key: string): string {
  return state.strings[key] ?? key
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function post(msg: ViewMessage): void {
  vscode.postMessage(msg)
}

function persist(): void {
  vscode.setState({ arrangeOpen: state.arrangeOpen } satisfies Persisted)
}

/**
 * Change the arrangement.
 *
 * The host owns it and re-polls; nothing is applied optimistically here. A local guess would show a
 * grouping for one frame that the next poll then contradicts, and on a slow machine that flicker is
 * the whole interaction.
 */
function arrange(change: Partial<Arrangement>): void {
  post({ type: 'arrange', change })
}

function rowOf(id: string): FleetRow | undefined {
  return state.rows.find(r => r.id === id)
}

function terminalOf(id: string): TerminalState {
  return state.terminals.get(id) ?? INITIAL_TERMINAL_STATE
}


// ---------------------------------------------------------------------------
// routing
//
// Watching is tied to the route: entering a session asks for its stream, leaving gives it back. The
// server captures a pane only while somebody is watching, so a surface that forgot to unwatch would
// keep a capture loop running on the host for a screen nobody can see.

function go(route: Route): void {
  const leaving = state.route.view === 'session' ? state.route.id : null
  state.route = route
  const entering = route.view === 'session' ? route.id : null
  if (leaving && leaving !== entering) {
    post({ type: 'unwatch', id: leaving })
    state.watching = null
  }
  if (entering && state.watching !== entering) {
    state.terminals.set(entering, terminalReducer(terminalOf(entering), { type: 'connecting' }))
    post({ type: 'watch', id: entering })
    state.watching = entering
  }
  render()
}

// ---------------------------------------------------------------------------
// the skeleton — built once

const root = document.getElementById('root')!
const header = el('header', 'ag-header')
const banner = el('div', 'banner')
const resultLine = el('div', 'result')
const body = el('main', 'body')

const searchInput = el('input', 'search')
searchInput.type = 'search'
// Its value comes from the arrangement, which the host owns — filled in on the first `state`.

function mount(): void {
  root.append(header, banner, resultLine, body)
  // Debounced: every keystroke is a poll of the whole fleet, and the search runs server-side where
  // the transcript scope can actually read a transcript.
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer)
    const value = searchInput.value
    searchTimer = setTimeout(() => arrange({ query: value }), 250)
  })
}

// ---------------------------------------------------------------------------
// chrome

function brand(): HTMLElement {
  const box = el('div', 'brand')
  const mark = el('span', 'brand-mark')
  // The wordmark is TEXT, not an image: a webview reloads on every theme change and a logo that
  // has to be fetched leaves a hole in the header each time.
  mark.textContent = '◧'
  box.append(mark, el('span', 'brand-word', 'agentistics'))
  return box
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, label)
  b.addEventListener('click', onClick)
  return b
}

function renderHeader(): void {
  header.replaceChildren()
  const top = el('div', 'header-top')

  // Back goes on the LEFT, before everything, where every application in the world puts it —
  // including the editor this panel lives in. On the right it sits among the actions, reading as
  // one more of them rather than as the way out.
  if (state.route.view === 'session' && !state.pinned) {
    // Orange, not a ghost. It is the only way out of this view and it was a grey arrow among grey
    // chrome — the one control that must be findable without looking for it.
    const back = button('←', 'btn primary back', () => go({ view: 'list' }))
    back.title = s('backToList')
    back.setAttribute('aria-label', s('backToList'))
    top.append(back)
  }
  top.append(brand())

  const actions = el('div', 'header-actions')
  if (state.route.view === 'list') {
    actions.append(
      button(s('newSession'), 'btn primary', () => {
        state.wizard = !state.wizard
        if (state.wizard) post({ type: 'newOptions', query: '' })
        renderBody()
      }),
      button(s('refresh'), 'btn ghost icon', () => post({ type: 'refresh' })),
    )
  }
  top.append(actions)
  header.append(top)

  if (state.attention > 0) {
    const pill = el('div', 'attention')
    pill.append(el('span', 'attention-dot', '●'))
    pill.append(el('span', undefined, state.attention === 1
      ? s('attentionOne')
      : fill(s('attentionMany'), state.attention)))
    header.append(pill)
  }

  if (state.route.view === 'list') {
    const filters = el('div', 'filters')
    searchInput.placeholder = s('searchPlaceholder')
    if (searchInput.value !== state.arrangement.query && document.activeElement !== searchInput) {
      // Only when the field is NOT being typed in: overwriting it from a poll eats a keystroke.
      searchInput.value = state.arrangement.query
    }
    const open = button('⚙', state.arrangeOpen ? 'chip on' : 'chip', () => {
      state.arrangeOpen = !state.arrangeOpen
      persist()
      render()
    })
    open.title = s('arrange')
    open.setAttribute('aria-label', s('arrange'))
    // A count of what is narrowing the list, so a filter left on from yesterday is visible without
    // opening the panel — the thing that otherwise reads as "the fleet is empty".
    const narrowing = activeFilterCount()
    if (narrowing > 0) open.append(el('span', 'count-badge', String(narrowing)))
    filters.append(searchInput, open)
    header.append(filters)
    if (state.arrangeOpen) header.append(renderArrange())
  }
}

function renderBanner(): void {
  banner.replaceChildren()
  // Four link states, four sentences. "Nobody answered", "answered, and said no" and "answered, just
  // not yet" are three different facts and send a person to three different places, so they are
  // never collapsed into one message.
  if (state.link.state === 'down') {
    banner.className = 'banner visible bad'
    banner.append(el('span', undefined, fill(s('linkDown'), state.link.url)))
    banner.append(button(s('linkDownAction'), 'btn small', () => post({ type: 'startServer' })))
  } else if (state.link.state === 'refused') {
    banner.className = 'banner visible'
    banner.append(el('span', undefined, state.link.detail ?? s('linkRefused')))
  } else if (state.link.state === 'slow') {
    banner.className = 'banner visible slow'
    banner.append(el('span', undefined, s('linkSlow')))
  } else {
    banner.className = 'banner'
  }

  resultLine.replaceChildren()
  resultLine.className = state.result
    ? `result visible ${state.result.ok ? 'ok' : 'bad'}`
    : 'result'
  if (state.result) resultLine.textContent = state.result.message
}

function render(): void {
  renderHeader()
  renderBanner()
  renderBody()
}

/**
 * The session DOM, kept ALIVE between renders.
 *
 * This is not an optimisation. The fleet polls every 5s and a frame arrives up to twice a second,
 * and each render used to rebuild the whole body — which REPLACES the screen element. Replacing a
 * focused element takes the keyboard with it, so typing died half a second after it started and the
 * panel felt broken rather than slow. The screen is therefore built once per session and only its
 * contents are patched; everything around it is re-rendered into boxes that are never the focus.
 */
interface SessionDom {
  id: string
  root: HTMLElement
  head: HTMLElement
  tools: HTMLElement
  approval: HTMLElement
  screenBox: HTMLElement
  pre: HTMLPreElement
  status: HTMLElement
  strip: HTMLElement
}

let sessionDom: SessionDom | null = null

function renderBody(): void {
  if (state.route.view === 'session') {
    const id = state.route.id
    // Only rebuild when the session CHANGED or the body is showing something else. Otherwise patch,
    // and never touch the element that holds the keyboard.
    if (!sessionDom || sessionDom.id !== id || sessionDom.root.parentElement !== body) {
      sessionDom = null
      body.replaceChildren()
      body.append(buildSession(id))
    } else {
      patchSession(id)
    }
    return
  }
  sessionDom = null
  body.replaceChildren()
  if (state.wizard) body.append(renderWizard())
  body.append(renderList())
}

// ---------------------------------------------------------------------------
// the fleet

function renderList(): HTMLElement {
  const box = el('div', 'list')
  const view = state.view

  if (state.unavailable) {
    // The list may not be the whole truth, and the server said why. Shown ABOVE the rows rather
    // than instead of them: a partial answer is still an answer.
    box.append(el('div', 'notice', state.unavailable))
  }

  // Sessions that FELL together — a reboot, a laptop closed. The offer is the whole group, because
  // that is the shape of what happened; the server resolves which sessions were in it.
  if (state.fell && state.fell.count > 0) {
    const fell = el('div', 'fell')
    fell.append(el('span', undefined, fill(s('fellCount'), state.fell.count)))
    fell.append(button(s('reopenFell'), 'btn small primary', () => post({ type: 'reopenFell' })))
    box.append(fell)
  }

  if (!view) {
    box.append(el('div', 'empty', '…'))
    return box
  }
  if (view.shown === 0) {
    box.append(emptyState(view))
    return box
  }

  // Pinned rows lead, in their own band. A pin is somebody saying "this one, whatever else is
  // going on" — leaving it in its band, ordered like everything else, honours the click and hides
  // the row it was meant to surface.
  const pinnedRows = view.groups.flatMap(g => g.rows).filter(r => state.pins.has(r.id))
  if (pinnedRows.length > 0) {
    box.append(groupHeading(`★ ${s('pinnedGroup')}`, pinnedRows.length))
    for (const row of pinnedRows) box.append(renderCard(row))
  }

  for (const group of view.groups) {
    const rows = group.rows.filter(r => !state.pins.has(r.id))
    if (rows.length === 0) continue
    box.append(groupHeading(group.label, rows.length, group))
    for (const row of rows) box.append(renderCard(row))
  }
  return box
}

/**
 * A band's heading, and — while grouping by task — the two things you can do to a TASK.
 *
 * They live on the band rather than on a row because a task is not a session: finishing one is a
 * statement about the work, and deleting one removes a name, not a conversation.
 */
function groupHeading(
  name: string,
  count: number,
  group?: { key: string; done?: boolean },
): HTMLElement {
  const heading = el('div', group?.done ? 'group done' : 'group')
  heading.append(el('span', 'group-name', name))
  heading.append(el('span', 'group-count', String(count)))

  if (group && state.arrangement.grouping === 'task' && group.key && group.key !== UNFILED_KEY) {
    const task = group.key
    heading.append(iconButton('⚑', s('openTaskWhole'), 'icon-btn tiny', () => {
      // The row's own verb, asked of any session in the band: the server reads the task off the row
      // and never from the request, so a caller cannot reopen a task it does not own a session in.
      const anchor = group ? rowsOfGroup(group.key)[0] : undefined
      if (anchor) act(anchor.id, 'openTask')
    }))
    heading.append(iconButton(group.done ? '↺' : '✓', group.done ? s('unfinishTask') : s('finishTask'), 'icon-btn tiny', () => {
      const anchor = rowsOfGroup(group.key)[0]
      if (anchor) act(anchor.id, 'finishTask')
    }))
    heading.append(iconButton('␡', s('deleteTask'), 'icon-btn tiny danger', () => {
      post({ type: 'act', id: '', action: 'deleteTask', text: task })
    }))
  }
  return heading
}

/** The `UNFILED` bucket the dimension table folds an absent value into. */
const UNFILED_KEY = '\u0000unfiled'

function rowsOfGroup(key: string): FleetRow[] {
  return state.view?.groups.find(g => g.key === key)?.rows ?? []
}

/**
 * How the fleet is arranged — group, sort, filter, and where the search looks.
 *
 * Every option in here is READ FROM THE SERVER (`view.groupings`, `view.sorts`, `view.facets`,
 * `view.scopes`), already labelled in the user's language. A list written in the client would be a
 * copy of the dimension table, and the day a dimension is added this panel is the surface that
 * silently does not offer it.
 */
function renderArrange(): HTMLElement {
  const box = el('div', 'arrange')
  const view = state.view
  if (!view) {
    box.append(el('p', 'dim', s('loading')))
    return box
  }

  box.append(pickerRow(s('arrangeGroup'), view.groupings, state.arrangement.grouping,
    id => arrange({ grouping: id })))

  const sortRow = pickerRow(s('arrangeSort'), view.sorts, state.arrangement.sort,
    id => arrange({ sort: id }))
  // The direction belongs beside the key it flips, not in a menu of its own.
  const dir = button(state.arrangement.dir === 'desc' ? '↓' : '↑', 'chip', () => {
    arrange({ dir: state.arrangement.dir === 'desc' ? 'asc' : 'desc' })
  })
  dir.title = s(state.arrangement.dir === 'desc' ? 'sortDesc' : 'sortAsc')
  sortRow.querySelector('.chips')?.append(dir)
  box.append(sortRow)

  const active = button(s('onlyActive'), state.arrangement.onlyActive ? 'chip on' : 'chip',
    () => arrange({ onlyActive: !state.arrangement.onlyActive }))
  active.setAttribute('aria-pressed', String(state.arrangement.onlyActive))
  const activeRow = el('div', 'field')
  const activeChips = el('div', 'chips')
  activeChips.append(active)
  activeRow.append(activeChips)
  box.append(activeRow)

  // The search scopes. An empty selection means EVERY field — the same reading the cockpit gives
  // it, so "none selected" is never a search that finds nothing.
  box.append(multiRow(s('arrangeScopes'), view.scopes.map(x => ({ ...x, count: 0 })),
    state.arrangement.scopes,
    next => arrange({ scopes: next })))

  for (const facet of view.facets) {
    box.append(multiRow(
      facet.label,
      facet.values,
      state.arrangement.filters[facet.id] ?? [],
      next => arrange({ filters: { ...state.arrangement.filters, [facet.id]: next } }),
    ))
  }

  if (activeFilterCount() > 0) {
    box.append(button(s('clearFilters'), 'btn small', () => arrange({
      filters: {}, scopes: [], query: '',
    })))
  }
  return box
}

/** One-of-many. */
function pickerRow(
  label: string,
  options: readonly { id: string; label: string }[],
  current: string,
  pick: (id: string) => void,
): HTMLElement {
  const row = el('div', 'field')
  row.append(el('label', undefined, label))
  const chips = el('div', 'chips')
  for (const option of options) {
    chips.append(button(option.label, option.id === current ? 'chip on' : 'chip', () => pick(option.id)))
  }
  row.append(chips)
  return row
}

/** Many-of-many, with counts where there are any. */
function multiRow(
  label: string,
  options: readonly { id?: string; key?: string; label: string; count: number }[],
  selected: readonly string[],
  set: (next: string[]) => void,
): HTMLElement {
  const row = el('div', 'field')
  row.append(el('label', undefined, label))
  const chips = el('div', 'chips')
  for (const option of options) {
    const key = option.id ?? option.key ?? ''
    const on = selected.includes(key)
    const chip = button(option.label, on ? 'chip on' : 'chip', () => {
      set(on ? selected.filter(v => v !== key) : [...selected, key])
    })
    if (option.count > 0) chip.append(el('span', 'count-badge', String(option.count)))
    chips.append(chip)
  }
  row.append(chips)
  return row
}

/** How many controls are narrowing the list right now. */
function activeFilterCount(): number {
  const a = state.arrangement
  const filters = Object.values(a.filters).filter(v => v.length > 0).length
  return filters + (a.scopes.length > 0 ? 1 : 0) + (a.query.trim() ? 1 : 0)
}

function emptyState(view: FleetView): HTMLElement {
  const box = el('div', 'empty')
  // WHICH of the three facts emptied the list. Blaming the filter while a search removed the rows
  // sends somebody to the wrong switch, and blaming a search while nothing is running at all hides
  // that the switch is on — the same distinction `emptyReason` draws for `agentop session ls`.
  if (view.total === 0) {
    box.append(el('p', undefined, s('emptyNone')), el('p', 'dim', s('emptyNoneHint')))
    return box
  }
  if (state.arrangement.query.trim()) {
    box.append(el('p', undefined, fill(s('emptyFiltered'), state.arrangement.query.trim())))
  } else if (state.arrangement.onlyActive) {
    box.append(el('p', undefined, s('emptyOnlyActive')), el('p', 'dim', s('emptyOnlyActiveHint')))
    box.append(button(s('emptyOnlyActiveAction'), 'btn small', () => arrange({ onlyActive: false })))
    return box
  } else {
    box.append(el('p', undefined, fill(s('emptyFilters'), view.total)))
  }
  box.append(button(s('clearFilters'), 'btn small', () => arrange({ filters: {}, scopes: [], query: '' })))
  return box
}

/**
 * One row, as a card.
 *
 * The whole card opens the session — the list is a way IN, not a control panel; the two things that
 * are not "open this" (pin it, open it in a tab) are icons in the corner, and they stop the click
 * from reaching the card underneath.
 *
 * The state is said THREE ways, because this is the screen people scan rather than read: a coloured
 * stripe down the left edge, the dot, and the word. The stripe is what makes a blocked session
 * findable in a list of forty at a glance.
 */
function renderCard(row: FleetRow): HTMLElement {
  const card = el('div', `card state-${row.state}`)
  if (state.busy.has(row.id)) card.classList.add('busy')
  if (state.pins.has(row.id)) card.classList.add('pinned')

  const open = el('button', 'card-open')
  open.addEventListener('click', () => go({ view: 'session', id: row.id }))

  const head = el('div', 'card-head')
  head.append(stateDot(row))
  head.append(el('span', 'card-title', row.title))
  open.append(head)

  const meta = el('div', 'card-meta')
  meta.append(harnessChip(row.harness))
  meta.append(statePill(row))
  if (row.model) meta.append(el('span', 'chip', row.model))
  if (row.task) meta.append(el('span', 'chip task', row.task))
  open.append(meta)
  open.append(el('div', 'card-cwd', shortenPath(row.cwd)))
  if (row.note) open.append(el('div', 'card-note', row.note))
  card.append(open)

  const corner = el('div', 'card-corner')
  const pinned = state.pins.has(row.id)
  corner.append(iconButton(
    pinned ? '★' : '☆',
    pinned ? s('unpin') : s('pin'),
    pinned ? 'icon-btn tiny on' : 'icon-btn tiny',
    () => post({ type: 'pin', id: row.id, pinned: !pinned }),
  ))
  corner.append(iconButton('⧉', s('openTab'), 'icon-btn tiny', () => post({ type: 'openTab', id: row.id })))
  card.append(corner)
  return card
}

function stateDot(row: FleetRow): HTMLElement {
  // The dot costs nothing on a fleet where nothing is waiting, and never carries the message alone:
  // the state word is beside it.
  const dot = el('span', 'dot')
  dot.textContent = row.state === 'waiting' || row.state === 'waiting-approval' ? '●' : '○'
  return dot
}

function statePill(row: FleetRow): HTMLElement {
  return el('span', `state-pill ${row.state}`, row.stateLabel)
}

function harnessChip(harness: string): HTMLElement {
  const chip = el('span', `chip harness h-${harness}`, harness)
  return chip
}

// ---------------------------------------------------------------------------
// one session

/** Build the session view once. Everything that changes later is patched in place. */
function buildSession(id: string): HTMLElement {
  const root = el('div', 'session')
  const row = rowOf(id)
  if (!row) {
    // The fleet no longer carries this id. Said in words, with the way back — a blank pane would
    // read as a broken panel rather than as a session that ended.
    root.append(el('div', 'notice', s('sessionGone')))
    if (!state.pinned) root.append(button(s('backToList'), 'btn', () => go({ view: 'list' })))
    return root
  }

  const head = el('div', 'session-head')
  const tools = el('div', 'session-tools')
  const approval = el('div', 'approval-slot')
  const { screenBox, pre, status, strip } = buildScreen(row)
  // The action row goes UNDER the screen: the terminal is why anybody opened this, and controls
  // above it push it down the panel.
  root.append(head, approval, screenBox, tools)

  sessionDom = { id, root, head, tools, approval, screenBox, pre, status, strip }
  patchSession(id)
  return root
}

/** Everything that can change while the screen keeps the keyboard. */
function patchSession(id: string): void {
  const dom = sessionDom
  const row = rowOf(id)
  if (!dom || !row) return

  // The TITLE is the heading of the screen below it, with the pencil that renames it right there.
  // It was a line of text among four other lines and a row of wide buttons — in a 320px sidebar
  // that is a wall, and the one thing a person needs to read (which session is this?) had no more
  // weight than the path under it.
  dom.head.replaceChildren()
  const title = el('div', 'session-title')
  // The pencil goes BEFORE the title. It edits the thing to its right, and a control that acts on
  // something reads as belonging to it when it leads — on the far side it was one more thing in the
  // row, next to the state pill it has nothing to do with.
  title.append(iconButton('✎', s('rename'), 'icon-btn tiny', () => {
    openTextVerb(dom.head, row, 'rename', s('rename'), row.title)
  }))
  title.append(stateDot(row))
  title.append(el('h2', 'session-name', row.title))
  title.append(statePill(row))
  dom.head.append(title)

  // One line of facts, not four. The harness, the model and the folder are context; the folder is
  // the long one, so it goes last and is allowed to wrap.
  const meta = el('div', 'session-meta')
  meta.append(harnessChip(row.harness))
  if (row.model) meta.append(el('span', 'chip', row.model))
  meta.append(el('span', 'session-cwd', row.cwd))
  dom.head.append(meta)

  // NOTE and TASK are shown as what they are — a value, or an invitation to add one. The `＋`
  // is the whole affordance: an icon on its own says "there is a note here" and says nothing about
  // being able to write one.
  const marks = el('div', 'session-marks')
  marks.append(markButton('✎', 'note', row.note, s('note'), () => {
    openTextVerb(dom.head, row, 'note', s('note'), row.note ?? '')
  }))
  marks.append(markButton('⚑', 'task', row.task, s('task'), () => {
    openTextVerb(dom.head, row, 'task', s('task'), row.task ?? '')
  }))
  dom.head.append(marks)

  dom.approval.replaceChildren()
  if (row.approvalLines?.length || row.dialogOptions?.length) dom.approval.append(renderApproval(row))

  paintScreen(row)

  // The action row lives UNDER the screen, as icons: in a sidebar four wide buttons wrapped into
  // three rows and pushed the terminal off the bottom. Every one carries a tooltip and an
  // aria-label, because an icon alone is a control you have to learn by clicking.
  // ONE action row, under the screen. There used to be a second, wider one below it listing every
  // verb by name — and after the title got its pencil and the marks got their `＋`, half of that
  // row was the same thing said twice: Rename, Note, Task and Stop session all had a control
  // already. Two ways to do one thing is two places to look and one of them is always the wrong
  // guess. What is left here is every verb that has no other home.
  dom.tools.replaceChildren()
  if (row.actionable) {
    // `>_` is a terminal. A keyboard glyph was a guess at what "attach" means to somebody who has
    // not read the docs; this is the thing itself.
    dom.tools.append(labelButton('>_', s('attachShort'), s('attach'), 'action', () => post({ type: 'attach', id })))
  }
  if (!state.pinned) {
    dom.tools.append(labelButton('⧉', s('tabShort'), s('openTab'), 'action', () => post({ type: 'openTab', id })))
  }
  dom.tools.append(labelButton('⧉+', s('copyShort'), s('copyCommand'), 'action', () => post({ type: 'copy', text: row.attachCommand })))
  dom.tools.append(labelButton('↗', s('folderShort'), s('openFolder'), 'action', () => post({ type: 'openFolder', path: row.cwd })))

  // The task verbs, and reopen. `approve` is the option list above, `prompt` is typing into the
  // screen, and the other four are the title's pencil and the two marks — so none of them appear
  // here. A verb the server sent that this panel has no home for would be silently missing, so the
  // set is explicit rather than "whatever is left".
  for (const [action, glyph] of TOOL_VERBS) {
    const verb = row.verbs.find(v => v.action === action)
    if (!verb) continue
    // The server's own WORD is the label — it is the cockpit's wording, and inventing a shorter one
    // here would be this panel disagreeing with the CLI about what a verb is called.
    const b = labelButton(glyph, verb.label, verb.label, 'action', () => act(id, action))
    b.disabled = !verb.enabled
    // Present and disabled with its reason, never removed: a control that vanishes says nothing
    // about why.
    if (verb.reason) b.title = `${verb.label} — ${verb.reason}`
    dom.tools.append(b)
  }

  const kill = row.verbs.find(v => v.action === 'kill')
  if (kill) {
    // Red, and it ASKS. Stopping a session ends work in progress, and the one control on this
    // screen that cannot be undone should not sit among the others looking like them.
    const stop = labelButton('■', kill.label, kill.label, 'action danger', () => {
      post({ type: 'kill', id, title: row.title })
    })
    stop.disabled = !kill.enabled
    if (kill.reason) stop.title = `${kill.label} — ${kill.reason}`
    dom.tools.append(stop)
  }
}

/**
 * A glyph AND a word.
 *
 * An icon on its own is a control you learn by clicking — a keyboard for "attach", a folder for
 * "open the folder" and a square for "stop" are all guesses at somebody else's mental model. The
 * word removes the guess; the glyph is what makes the row scannable once the word has been read
 * once. Under width pressure the CSS drops the word and the tooltip carries it.
 */
function labelButton(
  glyph: string,
  word: string,
  title: string,
  className: string,
  onClick: () => void,
): HTMLButtonElement {
  const b = el('button', className)
  b.append(el('span', 'action-glyph', glyph))
  b.append(el('span', 'action-word', word))
  b.title = title
  b.setAttribute('aria-label', title)
  b.addEventListener('click', onClick)
  return b
}

/**
 * The verbs that live in the action row, and the glyph each one gets.
 *
 * Everything else the server offers has a home of its own on this screen: `approve` is the option
 * list, `prompt` is typing into the terminal, `rename` is the title's pencil, `note` and `task` are
 * the marks, `kill` is the red one below.
 */
const TOOL_VERBS: readonly (readonly [FleetActionId, string])[] = [
  ['resume', '↻'],
  ['openTask', '⚑'],
  ['finishTask', '✓'],
]

/** An icon control. The label is never only in the glyph: it is the tooltip and the accessible name. */
function iconButton(glyph: string, label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, glyph)
  b.title = label
  b.setAttribute('aria-label', label)
  b.addEventListener('click', onClick)
  return b
}

/**
 * A note or a task: the value when there is one, and `＋ <what>` when there is not.
 *
 * The empty state is the important one. An icon by itself announces that something exists; it does
 * not tell anybody they can create one, which is what "bota um + pra tentar intuir que isso cria
 * uma nota" is asking for.
 */
function markButton(
  glyph: string,
  kind: 'note' | 'task',
  value: string | undefined,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const b = el('button', value ? `mark ${kind} set` : `mark ${kind}`)
  b.append(el('span', 'mark-glyph', value ? glyph : `${glyph}＋`))
  b.append(el('span', 'mark-text', value ?? label))
  b.title = value ? `${label}: ${value}` : label
  b.setAttribute('aria-label', b.title)
  b.addEventListener('click', onClick)
  return b
}

/**
 * The dialog a session is blocked on, verbatim, with the options READ OFF THE SCREEN by the server.
 *
 * They are listed and the picked one is sent. A single "approve" button would take whichever row is
 * highlighted, which on "only my fix / promote everything / stop here" is choosing for the user.
 */
function renderApproval(row: FleetRow): HTMLElement {
  const box = el('div', 'approval')
  box.append(el('div', 'approval-title', s('approvalTitle')))
  if (row.approvalLines?.length) {
    const pre = el('pre', 'dialog')
    pre.textContent = row.approvalLines.join('\n')
    box.append(pre)
  }
  if (row.dialogOptions?.length) {
    const options = el('div', 'options')
    for (const option of row.dialogOptions) {
      options.append(button(
        `${option.number}. ${option.label}`,
        option.selected ? 'option selected' : 'option',
        () => act(row.id, 'approve', undefined, option.number),
      ))
    }
    box.append(options)
  } else if (row.approveBlind ?? row.chooseBlind ?? row.approvalBlind) {
    box.append(el('div', 'dim', row.chooseBlind ?? row.approveBlind ?? row.approvalBlind!))
  }
  return box
}

/** How far from the bottom still counts as "following the tail". */
const TAIL_SLACK = 40
let screenEl: HTMLPreElement | null = null
let tailButton: HTMLElement | null = null

/**
 * The screen, and — when it has the keyboard — the thing you type into.
 *
 * **Focus is the gate.** Every terminal emulator ever written works this way: click it and you are
 * typing into it, click away and you are not. It is the same explicit, per-session, revocable
 * decision the dashboard's composer asks for with a button, expressed the way a terminal expresses
 * it, and the strip under the screen SAYS which of the two states you are in — a screen that
 * silently swallows keys, or silently ignores them, is the failure either design has to avoid.
 *
 * It is an INTENT gate and nothing more. The real authority is the server: `localShell` on any
 * exposed profile, scope (only sessions this machine manages), and a session that is actually
 * running.
 */
function buildScreen(row: FleetRow): {
  screenBox: HTMLElement
  pre: HTMLPreElement
  status: HTMLElement
  strip: HTMLElement
} {
  const screenBox = el('div', 'screen-box')
  const pre = el('pre', 'screen')
  const status = el('div', 'screen-status')
  const strip = el('div', 'typing-strip')

  // The way back to the live edge. It appears only when the reader has left it — a control that is
  // always there is one more thing on a 300px panel, and one that is there when it would do nothing
  // teaches people to ignore it.
  const tail = el('button', 'to-tail')
  tail.append(el('span', undefined, '↓'))
  tail.addEventListener('click', () => {
    pre.scrollTop = pre.scrollHeight
    updateTailButton()
  })
  pre.addEventListener('scroll', updateTailButton)

  // Bound ONCE, to the element that lives for as long as this session is open. Re-binding on every
  // frame would mean re-creating this node, and re-creating a focused node takes the keyboard.
  pre.tabIndex = 0
  pre.addEventListener('keydown', e => onScreenKey(row.id, e))
  pre.addEventListener('paste', e => onScreenPaste(row.id, e))
  pre.addEventListener('focus', () => { state.typing = true; paintTypingStrip(row.id) })
  pre.addEventListener('blur', () => { state.typing = false; paintTypingStrip(row.id) })

  const frame = el('div', 'screen-frame')
  frame.append(pre, tail)
  screenBox.append(frame, status, strip)
  screenEl = pre
  tailButton = tail
  return { screenBox, pre, status, strip }
}

/** Shown only away from the live edge. */
function updateTailButton(): void {
  if (!screenEl || !tailButton) return
  tailButton.classList.toggle('visible', !atTail(screenEl))
}

/** Is the reader at the live edge? The slack is what keeps a one-pixel rounding error from lying. */
function atTail(pre: HTMLElement): boolean {
  return pre.scrollTop + pre.clientHeight >= pre.scrollHeight - TAIL_SLACK
}

/**
 * Repaint the screen's CONTENTS — never its elements.
 *
 * The cursor is drawn only while the channel says there is one (`showCursor` is false on a dead or
 * gone pane), so a finished session never blinks as though somebody could still type into it.
 */
function paintScreen(row: FleetRow): void {
  const dom = sessionDom
  if (!dom) return
  const terminal = terminalOf(row.id)
  const status = terminalStatus(terminal, state.lang)

  // Read the scroll BEFORE replacing the content, and put it back after.
  //
  // Assigning `innerHTML` resets `scrollTop` to 0, and this function runs on every fleet poll as
  // well as on every frame — so without this the screen jumped back to its oldest line every five
  // seconds, which is exactly "the chat opens on the first prompt instead of the last message".
  // Following the tail is not enough on its own either: a reader who has scrolled UP to read
  // something must not be yanked anywhere, so the previous position is restored verbatim.
  const wasAtTail = atTail(dom.pre)
  const previousTop = dom.pre.scrollTop

  // THE ONE PLACE THIS FILE ASSIGNS HTML. `ansiToHtml` escapes the frame before it colours it, and
  // returns spans and text nodes only — see its header. Nothing else here goes near innerHTML.
  dom.pre.innerHTML = terminal.frame
    ? ansiToHtml(
        terminal.frame.content,
        state.theme,
        status.showCursor ? terminal.frame.cursor : null,
      )
    : ''

  dom.pre.scrollTop = wasAtTail ? dom.pre.scrollHeight : previousTop
  updateTailButton()

  dom.status.replaceChildren()
  dom.status.append(el('span', `pill ${status.tone}`, status.label))
  dom.status.append(el('span', 'dim', status.detail))
  if (status.truncated) dom.status.append(el('span', 'dim', s('screenTruncated')))

  paintTypingStrip(row.id)
}

/**
 * The one line under the screen that says whether your keys are going anywhere.
 *
 * Re-rendered on focus and blur ALONE — not through the whole view — because a full re-render on
 * focus would replace the very element that just took it, and the keyboard would land back on the
 * document a frame later.
 */
function paintTypingStrip(id: string): void {
  const dom = sessionDom
  const row = rowOf(id)
  if (!dom || !row) return
  // The line composer refuses a session on a dialog, because a LINE typed past a question lands in
  // the dialog's own filter. Raw keys are the opposite case: answering that dialog by keypress is
  // one of the reasons this exists, and the person can see it on the screen in front of them.
  const block = interactionBlock(row.state)
  const typable = block !== 'external' && block !== 'not-running'
  const focused = state.typing && typable && document.activeElement === dom.pre
  const strip = dom.strip
  strip.replaceChildren()
  strip.className = `typing-strip${focused ? ' live' : ''}`

  if (!typable) {
    strip.append(el('span', 'dim', s(
      block === 'external' ? 'typeBlockedExternal' : 'typeBlockedNotRunning',
    )))
    return
  }
  if (focused) {
    strip.append(el('span', 'typing-dot', '●'))
    strip.append(el('span', undefined, s('typingLive')))
    strip.append(el('span', 'dim', s('typingLiveHint')))
    return
  }
  const focus = button(s('typingStart'), 'btn tiny primary', () => screenEl?.focus())
  strip.append(focus, el('span', 'dim', s('typingIdle')))
}

// ---------------------------------------------------------------------------
// typing
//
// Printable characters are BUFFERED for a few milliseconds and sent as one `text`, because one HTTP
// round trip per keystroke is ~5 requests a second per typist, each spawning a `tmux send-keys` on
// the host. A non-printable key FLUSHES the buffer first and then goes on its own, so `abc<Enter>`
// can never arrive as `<Enter>abc`. Ordering across calls is the client's serialised queue
// (`api.ts`), so nothing here has to think about it beyond flushing in order.

const TYPE_FLUSH_MS = 25
let typeBuffer = ''
let typeTimer: ReturnType<typeof setTimeout> | undefined

function flushTyping(id: string): void {
  clearTimeout(typeTimer)
  typeTimer = undefined
  if (!typeBuffer) return
  const text = typeBuffer
  typeBuffer = ''
  post({ type: 'input', id, text })
}

/**
 * Keys that are not input, whatever a keyboard reports.
 *
 * A modifier press fires its own `keydown` — holding Shift to type a capital sends `Shift` first —
 * and a laptop's media row sends things like `MediaTrackNext`. Sent to the server those are refused
 * by name, correctly, and the user gets a red banner for a key they never meant to press. The
 * server's table stays the authority on what CAN be sent; this is the client not asking about keys
 * that are not keystrokes at all.
 */
const NOT_INPUT: ReadonlySet<string> = new Set([
  'Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'CapsLock', 'NumLock', 'ScrollLock',
  'ContextMenu', 'Dead', 'Unidentified', 'Process', 'Compose', 'Fn', 'FnLock', 'Hyper', 'Super',
  'Insert',
])
/** The media / launcher / browser rows, which report a whole family of names. */
const NOT_INPUT_PREFIX = ['Media', 'Launch', 'Browser', 'Audio', 'Video', 'Zoom', 'Power', 'Print']

function isInputKey(key: string): boolean {
  if (NOT_INPUT.has(key)) return false
  return !NOT_INPUT_PREFIX.some(prefix => key.startsWith(prefix))
}

function onScreenKey(id: string, e: KeyboardEvent): void {
  // The editor's own chords are left alone: `ctrl+shift+*` and anything with Cmd/Win is a VS Code
  // command, and swallowing those would make the panel a place where the editor stops working.
  if (e.metaKey || (e.ctrlKey && e.shiftKey)) return
  if (!isInputKey(e.key)) return

  const printable = e.key.length === 1 && !e.ctrlKey && !e.altKey
  e.preventDefault()
  e.stopPropagation()

  if (printable) {
    typeBuffer += e.key
    if (!typeTimer) typeTimer = setTimeout(() => flushTyping(id), TYPE_FLUSH_MS)
    return
  }
  flushTyping(id)
  post({
    type: 'input',
    id,
    key: {
      key: e.key,
      ...(e.ctrlKey ? { ctrl: true } : {}),
      ...(e.altKey ? { alt: true } : {}),
      ...(e.shiftKey ? { shift: true } : {}),
    },
  })
}

/** A paste is one `text` — the whole reason the channel takes text and not only keys. */
function onScreenPaste(id: string, e: ClipboardEvent): void {
  const text = e.clipboardData?.getData('text')
  if (!text) return
  e.preventDefault()
  flushTyping(id)
  // Newlines inside a paste are Enter presses, and Enter is a KEY. Splitting here keeps a pasted
  // block from being refused whole for carrying control characters.
  const lines = text.split(/\r\n|\r|\n/)
  lines.forEach((line, index) => {
    if (line) post({ type: 'input', id, text: line })
    if (index < lines.length - 1) post({ type: 'input', id, key: { key: 'Enter' } })
  })
}

/** The four verbs that need a line of text. Inline, because a modal over a 300px panel is a wall. */
function openTextVerb(
  host: HTMLElement,
  row: FleetRow,
  action: FleetActionId,
  label: string,
  initial?: string,
): void {
  host.querySelector('.text-verb')?.remove()
  const box = el('div', 'text-verb')
  const input = el('input')
  input.type = 'text'
  input.placeholder = label
  input.value = initial ?? (action === 'rename' ? row.title
    : action === 'note' ? row.note ?? ''
    : action === 'task' ? row.task ?? ''
    : '')
  const submit = () => {
    act(row.id, action, input.value)
    box.remove()
  }
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') submit()
    if (e.key === 'Escape') box.remove()
  })
  box.append(input, button(s('send'), 'btn small primary', submit),
    button(s('cancel'), 'btn small ghost', () => box.remove()))
  host.append(box)
  input.focus()
  input.select()
}

function act(id: string, action: FleetActionId, text?: string, choice?: number): void {
  state.busy.add(id)
  renderBody()
  post({
    type: 'act', id, action,
    ...(text !== undefined ? { text } : {}),
    ...(choice !== undefined ? { choice } : {}),
  })
}

// ---------------------------------------------------------------------------
// the wizard

const draft: SpawnRequest = { harness: '', cwd: '' }

function renderWizard(): HTMLElement {
  const box = el('div', 'wizard')
  box.append(el('div', 'wizard-title', s('wizardTitle')))

  const options = state.options
  if (!options) {
    box.append(el('p', 'dim', s('loading')))
    return box
  }
  if (options.unavailable || options.harnesses.length === 0) {
    box.append(el('p', 'notice', options.unavailable ?? s('wizardNoHarness')))
    return box
  }

  // A harness with no spawn spec is ABSENT from this list, never offered and failing — the server
  // derives it from the specs for exactly that reason.
  const harnessRow = el('div', 'field')
  harnessRow.append(el('label', undefined, s('wizardHarness')))
  const chips = el('div', 'chips')
  for (const harness of options.harnesses) {
    chips.append(button(harness.label, draft.harness === harness.id ? 'chip harness on' : 'chip harness', () => {
      draft.harness = harness.id
      draft.effort = undefined
      renderBody()
    }))
  }
  harnessRow.append(chips)
  box.append(harnessRow)

  const picked = options.harnesses.find(h => h.id === draft.harness)

  const whereRow = el('div', 'field')
  whereRow.append(el('label', undefined, s('wizardWhere')))
  const where = el('input')
  where.type = 'text'
  where.placeholder = s('wizardWherePlaceholder')
  where.value = draft.cwd
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  where.addEventListener('input', () => {
    draft.cwd = where.value
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => post({ type: 'newOptions', query: where.value }), 200)
  })
  whereRow.append(where)
  const places = el('div', 'places')
  for (const project of options.projects.slice(0, 8)) {
    const item = el('button', 'place')
    item.append(el('span', 'place-name', project.label))
    if (project.repo) item.append(el('span', 'place-repo', project.repo))
    item.append(el('span', 'place-detail', project.detail))
    item.addEventListener('click', () => {
      draft.cwd = project.path
      renderBody()
    })
    places.append(item)
  }
  whereRow.append(places)
  box.append(whereRow)

  box.append(textField(s('wizardLabel'), draft.label ?? '', v => { draft.label = v }))
  box.append(textField(s('wizardTask'), draft.task ?? '', v => { draft.task = v }, s('wizardTaskPlaceholder'), state.tasks))
  box.append(textField(s('wizardPrompt'), draft.prompt ?? '', v => { draft.prompt = v }))

  if (picked) {
    // Suggestions to OFFER and never a validation list: `claude --help` documents --model as an
    // alias "or a model's full name", so the field is typed as well as picked.
    if (picked.supportsModel) {
      box.append(textField(s('wizardModel'), draft.model ?? '', v => { draft.model = v }, '', picked.modelSuggestions))
    } else {
      box.append(el('p', 'dim', s('wizardModelNone')))
    }
    // …whereas effort IS a closed enum the CLI itself prints, so it is a picker.
    if (picked.efforts.length > 0) {
      const effortRow = el('div', 'field')
      effortRow.append(el('label', undefined, s('wizardEffort')))
      const effortChips = el('div', 'chips')
      effortChips.append(button(s('wizardEffortDefault'), draft.effort ? 'chip' : 'chip on', () => {
        draft.effort = undefined
        renderBody()
      }))
      for (const effort of picked.efforts) {
        effortChips.append(button(effort, draft.effort === effort ? 'chip on' : 'chip', () => {
          draft.effort = effort
          renderBody()
        }))
      }
      effortRow.append(effortChips)
      box.append(effortRow)
    }
  }

  const buttons = el('div', 'wizard-buttons')
  const ready = Boolean(draft.harness && draft.cwd.trim())
  const start = button(s('start'), 'btn primary', () => spawn(false))
  const startAttach = button(s('startAndAttach'), 'btn', () => spawn(true))
  start.disabled = !ready
  startAttach.disabled = !ready
  if (!ready) {
    start.title = s('wizardPickWhere')
    startAttach.title = s('wizardPickWhere')
  }
  buttons.append(start, startAttach, button(s('cancel'), 'btn ghost', () => {
    state.wizard = false
    renderBody()
  }))
  box.append(buttons)
  return box
}

function spawn(attach: boolean): void {
  post({
    type: 'spawn',
    attach,
    request: {
      harness: draft.harness,
      cwd: draft.cwd.trim(),
      ...(draft.task ? { task: draft.task } : {}),
      ...(draft.prompt ? { prompt: draft.prompt } : {}),
      ...(draft.model ? { model: draft.model } : {}),
      ...(draft.effort ? { effort: draft.effort } : {}),
      ...(draft.label ? { label: draft.label } : {}),
    },
  })
  state.wizard = false
  renderBody()
}

function textField(
  label: string,
  value: string,
  onChange: (v: string) => void,
  placeholder = '',
  suggestions: string[] = [],
): HTMLElement {
  const row = el('div', 'field')
  row.append(el('label', undefined, label))
  const input = el('input')
  input.type = 'text'
  input.value = value
  input.placeholder = placeholder
  input.addEventListener('input', () => onChange(input.value))
  row.append(input)
  if (suggestions.length > 0) {
    const chips = el('div', 'chips')
    for (const suggestion of suggestions.slice(0, 6)) {
      chips.append(button(suggestion, 'chip', () => {
        input.value = suggestion
        onChange(suggestion)
      }))
    }
    row.append(chips)
  }
  return row
}

// ---------------------------------------------------------------------------
// the channel

window.addEventListener('message', event => {
  const msg = event.data as HostMessage
  if (msg.type === 'mount') {
    state.pinned = msg.pinned
    state.theme = msg.theme
    document.body.dataset.theme = msg.theme
    go(msg.route)
    return
  }
  if (msg.type === 'theme') {
    state.theme = msg.theme
    document.body.dataset.theme = msg.theme
    render()
    return
  }
  if (msg.type === 'state') {
    state.link = msg.link
    state.rows = msg.fleet.sessions
    state.attention = msg.fleet.attention
    state.unavailable = msg.fleet.unavailable
    state.tasks = msg.fleet.tasks
    state.fell = msg.fleet.fell
    state.view = msg.fleet.view ?? null
    state.arrangement = msg.arrangement
    state.strings = msg.strings
    state.lang = msg.lang
    state.pins = new Set(msg.pinned)
    state.busy.clear()
    render()
    return
  }
  if (msg.type === 'newOptions') {
    state.options = msg.options
    renderBody()
    return
  }
  if (msg.type === 'result') {
    state.result = { ok: msg.ok, message: msg.message }
    // A result only means something to a composer that is mid-send; the reducer enforces that, so
    // handing every result to the open session's composer is safe and is what keeps a failed line
    // on screen with the server's own reason.
    render()
    return
  }
  if (msg.type === 'busy') {
    if (msg.busy) state.busy.add(msg.id)
    else state.busy.delete(msg.id)
    renderBody()
    return
  }
  if (msg.type === 'openWizard') {
    state.wizard = true
    if (msg.cwd) draft.cwd = msg.cwd
    post({ type: 'newOptions', query: msg.cwd ?? '' })
    go({ view: 'list' })
    return
  }
  if (msg.type === 'terminal') {
    applyTerminal(msg.id, msg.event, msg.data)
    return
  }
})

function applyTerminal(id: string, event: string, data: string): void {
  const before = terminalOf(id)
  let next = before
  if (event === 'open') {
    const open = parseOpen(data)
    if (open) next = terminalReducer(before, { type: 'open', open })
  } else if (event === 'frame') {
    const frame = parseFrame(data)
    if (frame) next = terminalReducer(before, { type: 'frame', frame })
  } else if (event === 'end') {
    next = terminalReducer(before, { type: 'end', reason: parseEnd(data) ?? 'error' })
  } else {
    // A stall or a refusal before the stream opened. The reducer honours it only while frame-less,
    // so a live screen is never blanked by a blip.
    next = terminalReducer(before, { type: 'stall' })
  }
  state.terminals.set(id, next)
  if (state.route.view !== 'session' || state.route.id !== id) return
  const row = rowOf(id)
  if (!row || !sessionDom || sessionDom.id !== id) return

  // Only the screen's CONTENTS are repainted — never the element. A frame arrives up to twice a
  // second, and replacing a focused node takes the keyboard with it, which is what made typing die
  // half a second after it started. The scroll is `paintScreen`'s business, because it is the thing
  // that assigns the HTML that destroys it — a second copy of that rule here is how one of the two
  // repaint paths ended up without it.
  paintScreen(row)
}

mount()
// Nothing is LABELLED before the host answers: `strings` arrives with the first `state` message, and
// rendering the chrome now would print the key names on screen for as long as that round trip takes.
body.append(el('div', 'empty', '…'))
post({ type: 'ready' })
