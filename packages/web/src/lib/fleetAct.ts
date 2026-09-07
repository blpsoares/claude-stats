/**
 * fleetAct.ts — PURE: what a verb's answer means to the browser.
 *
 * `POST /api/fleet/act` answers `{ ok, message }` and, for a verb that CREATED something, the new
 * session's `id`. That id is not decoration: a reopen mints a new row and retires the one it was
 * asked about, so a caller that does not follow it leaves the reader on a dead session with a
 * success message over it.
 *
 * That is what happened. `FleetState['act']` DECLARED `id?: string` in its return and the
 * implementation built `{ ok, message }` — the id was dropped on the floor. TypeScript cannot catch
 * it: the property is optional, and an object that simply lacks an optional property is assignable.
 * The reopen worked every time, spawned the session, and the UI stood still — reported as "nao ta
 * sendo possivel reabrir pela ui sessoes que estao off". Measured: the server answered
 * `{"ok":true,"message":"started ACESSIBILIDADE VINI in the background.","id":"aeb12129c4"}` and the
 * URL never moved.
 *
 * So the parse is a FUNCTION with a test rather than an object literal inside a callback. The rule
 * it exists to hold: **every field the answer carries is carried on**, and a field is dropped only
 * where dropping it is written down.
 */

export interface FleetActResult {
  ok: boolean
  /** Already localized by the machine that ran the verb. Never composed here. */
  message: string
  /** The session a verb CREATED, when it created one. */
  id?: string
}

/** The sentence for an answer that carried none — a network error, or a body that is not ours. */
export function actFallbackMessage(lang: 'pt' | 'en'): string {
  return lang === 'pt' ? 'A ação não pôde ser executada.' : 'The action could not be run.'
}

/**
 * Read one `/api/fleet/act` answer.
 *
 * `json` is whatever came back, including `null` for a body that could not be parsed. The id is
 * kept only when it is a non-empty string: an `id` of `null` or `0` from some future version must
 * not become a route this app navigates to.
 */
export function parseActResult(json: unknown, lang: 'pt' | 'en'): FleetActResult {
  const o = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>
  const message = typeof o.message === 'string' && o.message !== ''
    ? o.message
    : actFallbackMessage(lang)
  const id = typeof o.id === 'string' && o.id.trim() !== '' ? o.id : undefined
  return { ok: o.ok === true, message, ...(id ? { id } : {}) }
}
