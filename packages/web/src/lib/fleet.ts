/**
 * fleet.ts — the browser's half of `/api/fleet`.
 *
 * It holds NO rule about what a session may take. Every `enabled` flag, every refusal sentence and
 * every verb label arrives already decided from the server, which resolves them through the same
 * `sessionActions` the terminal cockpit resolves every keypress against. A second implementation
 * here would be a second set of rules — the bug `task-reopen.ts` exists to have fixed once — and it
 * would go wrong in the expensive direction: offering "answer its question" on a numbered dialog
 * belonging to a harness with no verified way to pick, where the keystroke takes whichever option
 * happens to be highlighted.
 *
 * What this module owns is the transport, the poll, and the mapping from a stored `SessionMeta` row
 * to the live fleet row that is driving it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ControlSession } from '@agentistics/tui/control/session-fleet'
import { fleetSeedNotice, fleetStaleNotice } from './fleetStale'
import { cacheIsUsable, stripVolatile } from './fleetCache'
import { getCentralMachine } from './centralMachinePick'
import { relayedToSessions, type RelayedRow } from './relayedSessions'
import { notifyFleetTransitions, type SessionActivity } from './sessionNotifications'

/** Mirrors `SessionAction` in `@agentistics/tui/control/sessions`, minus the verbs a page cannot do. */
export type FleetActionId =
  | 'resume' | 'approve' | 'prompt' | 'rename' | 'note' | 'task' | 'kill'
  | 'openTask' | 'finishTask'
  /** Stop the current turn without ending the session. See the server's own union. */
  | 'interrupt'

/** The verbs this page can PERFORM. The rest are shown, dimmed, with their reason. */
export const PERFORMABLE: ReadonlySet<FleetActionId> = new Set<FleetActionId>([
  'resume', 'approve', 'prompt', 'rename', 'note', 'task', 'kill', 'openTask', 'finishTask',
])

/** The verbs that take a line of text before they can run. */
export const TEXT_VERBS: ReadonlySet<FleetActionId> = new Set<FleetActionId>([
  'prompt', 'rename', 'note', 'task',
])

export interface FleetVerb {
  action: FleetActionId
  /** Already localized by the server, from the very map the terminal cockpit prints. */
  label: string
  enabled: boolean
  /** Why it is off, when the row can say. Already localized. */
  reason?: string
}

export interface FleetRow {
  id: string
  title: string
  harness: string
  cwd: string
  project: string
  state: 'working' | 'waiting' | 'waiting-approval' | 'exited' | 'lost' | 'unknown' | 'closed'
  stateLabel: string
  actionable: boolean
  task?: string
  note?: string
  model?: string
  conversationId?: string
  approvalLines?: string[]
  dialogOptions?: { number: number; label: string; selected?: boolean }[]
  approvalBlind?: string
  approveBlind?: string
  chooseBlind?: string
  conversationBlind?: string
  attachCommand: string
  verbs: FleetVerb[]
}

export interface FleetPayload {
  sessions: FleetRow[]
  /**
   * The same rows unshaped, for `session-fleet.ts` to arrange.
   *
   * Grouping, ordering, the cascade and the filters are decided by the very module the terminal
   * cockpit decides them with, and that module operates on `ControlSession`. Arranging `FleetRow`
   * here instead would be a second set of rules — the defect this bridge exists to prevent.
   */
  rows: ControlSession[]
  attention: number
  unavailable?: string
  tasks: string[]
  /** Tasks the user marked finished. A statement about the work, not about any session's state. */
  finishedTasks: string[]
}

const EMPTY: FleetPayload = { sessions: [], rows: [], attention: 0, tasks: [], finishedTasks: [] }

/** How often the page re-reads the fleet. The cockpit polls at 5s; matching it keeps the two in step. */
const FLEET_POLL_MS = 5000

export interface FleetState {
  fleet: FleetPayload
  /** True until the first answer arrives — an empty list before then is "not asked yet". */
  loading: boolean
  /**
   * The route is absent or refused (a central, or an exposure profile with no host power).
   *
   * Distinct from an empty fleet on purpose: "there are no managed sessions" and "this page cannot
   * ask" are different facts, and rendering the second as the first is a confident zero from a
   * machine that was never allowed to look.
   */
  unsupported: boolean
  /**
   * Already-worded reason the list on screen may not be current, or null.
   *
   * A failed poll keeps the previous list — reporting an empty fleet because one request 502'd
   * would say "nothing is running" about a machine with nine live sessions — but the cockpit keeps
   * the previous list PLUS a reason, and this is that reason. See `fleetStale.ts`.
   */
  stale: string | null
  refresh: () => void
  act: (req: {
    id: string
    action: FleetActionId
    text?: string
    choice?: number
  }) => Promise<{ ok: boolean; message: string; id?: string }>
}

/**
 * The poll, SHARED.
 *
 * Two surfaces read the fleet now — the aside's session list and the panel showing one session —
 * and a hook that owned its own interval would poll the machine once per mounted consumer, each
 * landing at a different moment. So the interval and the last answer live at module scope, and the
 * hook is a subscription: N consumers, one request every `FLEET_POLL_MS`, and every one of them
 * looking at the same snapshot. A list and a detail pane disagreeing about a session's state by one
 * poll interval is a bug people report as flicker.
 *
 * Refcounted: the timer starts with the first subscriber and stops with the last, so a machine with
 * the dashboard open and nothing watching sessions makes no fleet requests at all.
 */
const listeners = new Set<() => void>()
const FLEET_CACHE_KEY = 'agentistics-fleet-cache-v1'

/** Read the persisted snapshot, or null. Validated and age-checked — see `fleetCache.ts`. */
function readFleetCache(): FleetPayload | null {
  try {
    const raw = localStorage.getItem(FLEET_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { at?: number; payload?: FleetPayload }
    if (!cacheIsUsable(parsed?.at, Date.now())) return null
    const p = parsed.payload
    if (!p || !Array.isArray(p.rows) || !Array.isArray(p.sessions)) return null
    cachedAt = parsed.at ?? 0
    return p
  } catch {
    return null
  }
}

function writeFleetCache(payload: FleetPayload): void {
  try {
    // The SCREEN is stripped before it is written, never after it is read — a payload that was
    // never stored cannot leak from a store somebody inspects.
    localStorage.setItem(FLEET_CACHE_KEY, JSON.stringify({ at: Date.now(), payload: stripVolatile(payload) }))
  } catch { /* quota or disabled — the cache is an optimisation, never a requirement */ }
}

/**
 * Seeded from the last poll of a previous visit, so leaving the page and coming back paints the
 * list instead of the loading state for a whole poll interval. On a phone, where "leaving" is
 * switching apps, that was most visits.
 *
 * `snapLoading` is still TRUE while a seed is showing: the rows are real but unconfirmed, and the
 * first live answer is what makes them current. Nothing here claims otherwise — `cachedAt` feeds
 * the same staleness sentence a failed poll produces, so a seeded list says how old it is until
 * the poll lands.
 */
let cachedAt = 0
let snapshot: FleetPayload = readFleetCache() ?? EMPTY
let snapLoading = true
let snapUnsupported = false
/** Consecutive failed polls, and when one last answered — the two facts `fleetStale.ts` reads. */
let snapFailures = 0
let snapLastOkMs: number | null = null
let timer: ReturnType<typeof setInterval> | null = null
let pollLang: 'pt' | 'en' = 'en'

function emit(): void {
  for (const l of listeners) l()
}

/**
 * On a CENTRAL there is no local fleet, and the workspace still has to work.
 *
 * The poller fetches the RELAYED fleet of whichever machine the aside's picker has chosen, and maps
 * it into the very same shape a machine returns. That is what lets the aside, the overview in the
 * centre and the header's counters stay one implementation: they read `fleet`, and none of them has
 * to know which kind of install it is. The alternative — a second list drawn in the centre while
 * the real aside said "no sessions on this machine yet" — is exactly what shipped and was wrong.
 */
let pollCentral = false

export function setFleetSourceCentral(on: boolean): void {
  if (pollCentral === on) return
  pollCentral = on
  snapshot = EMPTY; snapLoading = true; cachedAt = 0
  emit()
  if (timer !== null) void pollOnce()
}

async function pollCentralOnce(): Promise<void> {
  const machineId = getCentralMachine()
  if (!machineId) {
    // No machine chosen is not a failed poll and not an empty fleet — the picker above the list
    // is what answers it, so this reports "nothing to show" and stops.
    snapshot = EMPTY; snapUnsupported = false; snapLoading = false; snapFailures = 0
    emit(); return
  }
  try {
    const res = await fetch(`/api/team/machine-fleet?machineId=${encodeURIComponent(machineId)}&lang=${pollLang}`)
    if (!res.ok) { snapFailures++; return }
    const body = await res.json() as { reply?: { rows?: RelayedRow[]; withheld?: number }; reason?: string }
    if (!body.reply) {
      // A named refusal is a complete ANSWER, exactly as a machine's 403 is: it clears the failure
      // count rather than reading as silence. The picker states the reason in words.
      snapshot = EMPTY; snapUnsupported = true; snapFailures = 0; snapLastOkMs = Date.now()
      return
    }
    snapUnsupported = false
    const rows = relayedToSessions(body.reply.rows ?? [])
    snapshot = {
      rows,
      // `FleetRow` is the shaped view the panel reads; the relayed row already carries the same
      // fields the list needs, and the verbs it may take came decided from the machine.
      sessions: rows as unknown as FleetRow[],
      attention: rows.filter(r => r.state === 'waiting' || r.state === 'waiting-approval').length,
      // A relayed fleet carries no task list of its own: tasks are a local grouping, and a
      // FINISHED task is a statement the machine's own user made. Neither is invented here.
      tasks: [],
      finishedTasks: [],
    }
    snapFailures = 0
    snapLastOkMs = Date.now()
    cachedAt = 0
  } catch {
    snapFailures++
  } finally {
    snapLoading = false
    emit()
  }
}

/**
 * The previous snapshot's states, for the notifier. `null` until the first successful poll — see
 * `notifyFleetTransitions`, where the distinction between "not asked yet" and "asked, nothing
 * running" is what keeps a reopened page quiet.
 */
let lastActivity: Record<string, SessionActivity> | null = null

async function pollOnce(): Promise<void> {
  if (pollCentral) return pollCentralOnce()
  try {
    const res = await fetch(`/api/fleet?lang=${pollLang}`)
    if (res.status === 403 || res.status === 404) {
      // Not an empty fleet: this machine may not be asked. The two must stay distinguishable, and
      // a refusal is a complete ANSWER — it clears the failure count rather than reading as
      // silence, which would eventually put a "no answer" notice over a perfectly clear one.
      snapUnsupported = true; snapFailures = 0; snapLastOkMs = Date.now()
      snapLoading = false; emit(); return
    }
    // COUNTED, not swallowed. This used to `return` silently, so a server answering 502 on every
    // poll left a minutes-old list on screen looking live — a stale list is worse than an empty
    // one, because an empty one is obviously wrong.
    if (!res.ok) { snapFailures++; return }
    const json = await res.json() as FleetPayload
    snapUnsupported = false
    snapshot = json
    snapFailures = 0
    snapLastOkMs = Date.now()
    cachedAt = 0            // a live answer supersedes the seed; it is no longer "from before"
    writeFleetCache(json)
    // The desktop notification for a session that just changed state. HERE, in the poll, and not in
    // a component: it must fire while the reader is on the costs page or on another tab, which is
    // the only situation where a notification is worth anything. `null` on the first snapshot is
    // what stops a freshly opened page announcing everything that happened while it was closed.
    lastActivity = notifyFleetTransitions(lastActivity, json.rows ?? [], pollLang)
  } catch {
    // Transient — keep the last known answer rather than reporting an empty fleet, and record that
    // it did not arrive.
    snapFailures++
  } finally {
    snapLoading = false
    emit()
  }
}

function ensurePolling(lang: 'pt' | 'en'): void {
  if (lang !== pollLang) {
    // The payload is localized by the server, so a language change invalidates the snapshot's
    // words but not its facts. Re-request rather than translate here.
    pollLang = lang
    void pollOnce()
  }
  if (timer !== null) return
  void pollOnce()
  timer = setInterval(() => { void pollOnce() }, FLEET_POLL_MS)
}

function stopPolling(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}

export function useFleet(lang: 'pt' | 'en', enabled = true): FleetState {
  const [, force] = useState(0)

  useEffect(() => {
    if (!enabled) return
    const listener = () => force(n => n + 1)
    listeners.add(listener)
    ensurePolling(lang)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) stopPolling()
    }
  }, [lang, enabled])

  const refresh = useCallback(() => { void pollOnce() }, [])

  const act = useCallback<FleetState['act']>(async req => {
    try {
      const res = await fetch(`/api/fleet/act?lang=${lang}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      })
      const json = await res.json().catch(() => null) as { ok?: boolean; message?: string } | null
      const out = {
        ok: Boolean(json?.ok),
        message: json?.message
          ?? (lang === 'pt' ? 'A ação não pôde ser executada.' : 'The action could not be run.'),
      }
      // Re-read immediately: the verb changed the machine, and waiting up to five seconds to show
      // it is how a control that worked looks like one that did nothing.
      await pollOnce()
      return out
    } catch {
      return {
        ok: false,
        message: lang === 'pt' ? 'Erro de rede ao falar com esta máquina.' : 'Network error talking to this machine.',
      }
    }
  }, [lang])

  return {
    fleet: enabled ? snapshot : EMPTY,
    loading: enabled ? snapLoading : false,
    unsupported: enabled ? snapUnsupported : false,
    // Resolved on every render rather than stored: the sentence carries how long it has been, and
    // a stored one would freeze that age at the moment the poll failed.
    // A SEEDED list and a STALE one are both real rows not yet confirmed, and they get DIFFERENT
    // sentences. The seed borrowed the stale one, which opens with "no answer from this machine" —
    // false on a normal reopen, where the machine has not been asked yet. Announcing a failure that
    // did not happen, at the moment the page opens, is a warning that cries wolf on every visit.
    // The seed shows immediately (it IS unconfirmed from the first paint, unlike a poll that has
    // merely missed once) and is replaced the instant a live answer lands.
    stale: enabled
      ? (snapLastOkMs === null
        ? fleetSeedNotice(cachedAt, Date.now(), lang)
        : fleetStaleNotice({ failures: snapFailures, lastOkMs: snapLastOkMs }, Date.now(), lang))
      : null,
    refresh,
    act,
  }
}

/**
 * A stored session id → the live fleet row driving it.
 *
 * Keyed on BOTH `conversationId` and `id`: the first is the exact link a managed row records (the
 * uuid handed to `claude --session-id`), the second is what a `closed` row — one read straight out
 * of the conversation store — is already named by. A managed row's own id is a tmux session name
 * and can never collide with a conversation id, so one map answers both without ambiguity.
 */
export function fleetIndex(rows: readonly FleetRow[]): Map<string, FleetRow> {
  const map = new Map<string, FleetRow>()
  for (const r of rows) {
    map.set(r.id, r)
    if (r.conversationId) map.set(r.conversationId, r)
  }
  return map
}

export function useFleetIndex(rows: readonly FleetRow[]): Map<string, FleetRow> {
  return useMemo(() => fleetIndex(rows), [rows])
}
