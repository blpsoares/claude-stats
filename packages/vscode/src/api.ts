/**
 * api.ts — the extension host's half of the local `agentop server`.
 *
 * The ONE process that talks HTTP. It runs beside the fleet (or, under Remote-SSH, on the machine
 * the fleet is on), which is the whole reason the webview does not fetch for itself: a webview's
 * `localhost` is the BROWSER's, and in a remote window that is not the machine the sessions run on.
 *
 * Every method is TOTAL. A server that is not running, a central that refuses, a profile with no
 * host power and a socket that died mid-request are four different answers and are kept apart —
 * `LinkStatus` is what carries the difference to the screen. Nothing here throws at the caller, and
 * nothing here invents a value: a failed read of the fleet keeps the PREVIOUS one, exactly as the
 * cockpit's poller does, because the last known truth beats a confident empty list.
 */

import type { SessionMeta } from '@agentistics/core'
import type {
  Arrangement, FleetActionId, FleetPayload, LinkStatus, NewOptions, SpawnRequest,
} from './protocol'
import { todayTotals, type TodayTotals } from './today'

export interface AttachTicket {
  argv: string[]
  detachHint: string
  label: string
}

export interface ActionResult {
  ok: boolean
  message: string
}

/** How long any one call may take. */
const TIMEOUT_MS = 8_000
/** The metrics payload is megabytes on a well-used machine — it gets its own, longer, ceiling. */
const DATA_TIMEOUT_MS = 30_000
/**
 * `/api/fleet`'s own ceiling.
 *
 * Measured on a real machine: the FIRST call after the server starts takes ~29s (module load, the
 * conversation store, git-per-directory), independent of anything this poll asks for. `TIMEOUT_MS`
 * is right for a request that answers in milliseconds when the server is up; against a cold start
 * it aborts the request every single time, which is indistinguishable on screen from the server not
 * running at all — the exact false "unreachable" report this constant exists to stop.
 */
const FLEET_TIMEOUT_MS = 40_000

/** DOMException's own name for an `AbortSignal.timeout()` firing, in both Node and Bun's fetch. */
export function isTimeout(err: unknown): boolean {
  return err instanceof Error && err.name === 'TimeoutError'
}

export class AgentopClient {
  constructor(
    private readonly api: string,
    private readonly lang: 'en' | 'pt',
  ) {}

  private url(path: string, params: Record<string, string> = {}): string {
    const u = new URL(this.api + path)
    u.searchParams.set('lang', this.lang)
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    return u.toString()
  }

  /**
   * The fleet, plus how this window is doing at asking for it.
   *
   * 403 and 404 are ANSWERS, not failures: the first is an exposure profile with no host power, the
   * second a central, which aggregates many machines and hosts none of their sessions. Rendering
   * either as an empty fleet would be a confident "nothing is running" from a machine that was
   * never allowed to look. And a request that TIMED OUT is neither of those, nor a dead server —
   * see `slow` on `LinkState`.
   */
  async fleet(view?: Arrangement): Promise<{ link: LinkStatus; payload?: FleetPayload }> {
    try {
      const res = await fetch(this.url('/api/fleet', viewParams(view)), {
        signal: AbortSignal.timeout(FLEET_TIMEOUT_MS),
      })
      if (res.status === 403 || res.status === 404) {
        return { link: { state: 'refused', url: this.api } }
      }
      if (!res.ok) return { link: { state: 'down', url: this.api } }
      return { link: { state: 'ok', url: this.api }, payload: await res.json() as FleetPayload }
    } catch (err) {
      return { link: { state: isTimeout(err) ? 'slow' : 'down', url: this.api } }
    }
  }

  /**
   * One verb, on one row.
   *
   * The refusal sentence comes from the server — it is the cockpit's own wording, decided where the
   * decision was made. The only message this module composes is the one for a request that never
   * arrived, which the server by definition could not have worded.
   */
  async act(req: { id: string; action: FleetActionId; text?: string; choice?: number }): Promise<ActionResult> {
    return await this.post('/api/fleet/act', req)
  }

  /** Start a session. Same shape, same rule about whose words the answer is in. */
  async spawn(req: SpawnRequest): Promise<ActionResult & { id?: string }> {
    return await this.post('/api/fleet/new', req)
  }

  private async post(path: string, body: unknown): Promise<ActionResult & { id?: string }> {
    try {
      const res = await fetch(this.url(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      const json = await res.json().catch(() => null) as (ActionResult & { id?: string }) | null
      if (json && typeof json.message === 'string') return { ...json, ok: Boolean(json.ok) }
      return { ok: false, message: this.networkError() }
    } catch (err) {
      return { ok: false, message: this.networkError(isTimeout(err)) }
    }
  }

  /**
   * What it takes to attach, or `null` when this machine cannot attach to that row.
   *
   * Null rather than an empty ticket: a caller handed an empty argv would open a terminal that sits
   * there doing nothing, which is the least debuggable outcome available.
   */
  async attach(id: string): Promise<AttachTicket | null> {
    try {
      const res = await fetch(this.url('/api/fleet/attach', { id }), {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) return null
      const ticket = await res.json() as AttachTicket
      return Array.isArray(ticket.argv) && ticket.argv.length > 0 ? ticket : null
    } catch {
      return null
    }
  }

  /** The wizard's data. A machine that cannot answer says so in `unavailable`, never with silence. */
  async newOptions(query: string): Promise<NewOptions> {
    try {
      const res = await fetch(this.url('/api/fleet/new', { q: query }), {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) return { harnesses: [], projects: [], tasks: [], unavailable: this.networkError() }
      return await res.json() as NewOptions
    } catch (err) {
      return { harnesses: [], projects: [], tasks: [], unavailable: this.networkError(isTimeout(err)) }
    }
  }

  /**
   * Today's totals, or `null` when the machine did not answer.
   *
   * `null` and `{cost: 0}` are kept apart all the way to the status bar: a day with no work is a
   * real zero, and a server that is not running is not a day with no work.
   */
  async today(now: Date): Promise<TodayTotals | null> {
    try {
      const res = await fetch(this.url('/api/data'), { signal: AbortSignal.timeout(DATA_TIMEOUT_MS) })
      if (!res.ok) return null
      const data = await res.json() as { sessions?: SessionMeta[] }
      return todayTotals(data.sessions ?? [], now)
    } catch {
      return null
    }
  }

  /**
   * The live USD→BRL rate the server already fetches and caches (`/api/rates`).
   *
   * Read from the server rather than converted here: it is the SAME rate the dashboard prices with,
   * so the two surfaces can never show a different number for the same day. `null` when it cannot
   * be read, and a null rate means the status bar shows dollars rather than a converted figure it
   * invented.
   */
  async brlRate(): Promise<number | null> {
    try {
      const res = await fetch(this.url('/api/rates'), { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) return null
      const json = await res.json() as { brlRate?: unknown }
      return typeof json.brlRate === 'number' && json.brlRate > 0 ? json.brlRate : null
    } catch {
      return null
    }
  }

  /**
   * The failure this call hit, worded for its actual cause. "Unreachable" is a claim about a dead
   * server — reusing it for a request that simply took too long tells someone to go start a server
   * that is already running and, on a cold `/api/fleet`, already answering.
   */
  private networkError(timedOut = false): string {
    if (timedOut) {
      return this.lang === 'pt'
        ? 'O agentop server desta máquina está demorando demais para responder.'
        : 'The agentop server on this machine is taking too long to answer.'
    }
    return this.lang === 'pt'
      ? 'Não foi possível falar com o agentop server desta máquina.'
      : 'Could not reach the agentop server on this machine.'
  }
}

/**
 * The arrangement, as query parameters.
 *
 * `filters` travels as JSON because it maps a dimension to arbitrary VALUES — a project path, a
 * model id — and flattening that into query parameters needs an escaping convention nobody would
 * remember. Everything else is a plain scalar, so a request stays readable in a log.
 *
 * An absent arrangement asks for no `view` at all, and the server then does not compute one.
 */
function viewParams(view?: Arrangement): Record<string, string> {
  if (!view) return {}
  const params: Record<string, string> = {
    view: '1',
    group: view.grouping,
    sort: view.sort,
    dir: view.dir,
  }
  if (view.query.trim()) params.q = view.query
  if (view.onlyActive) params.active = '1'
  if (view.scopes.length > 0) params.scopes = view.scopes.join(',')
  const filters = Object.entries(view.filters).filter(([, v]) => v.length > 0)
  if (filters.length > 0) params.filters = JSON.stringify(Object.fromEntries(filters))
  return params
}
