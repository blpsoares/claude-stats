/**
 * config.ts — PURE. The address this extension talks to, resolved from the user's settings.
 *
 * ONE address: the local `agentop server`'s api port. There used to be a second — the dashboard's
 * web port, for a tab that framed it — and that tab is gone: a VS Code webview could not load it,
 * and a feature that does not work is worse than one that is absent. The metrics that mattered are
 * in the status bar, which reads the api like everything else here.
 *
 * A setting that cannot be parsed falls back to the default AND says so. Silently correcting it
 * would leave the user looking at a working panel that is reading a machine they did not name.
 */

export const DEFAULT_API = 'http://127.0.0.1:47291'

export interface Endpoints {
  /** No trailing slash, so callers can concatenate `/api/...` without thinking about it. */
  api: string
  /** The setting that could not be read, when one could not be. Reported, never swallowed. */
  invalid?: string
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function parse(raw: string): URL | null {
  try {
    const u = new URL(raw)
    // Only http(s): a `file:` or `vscode-webview:` setting would fail much later, in a fetch whose
    // error says nothing about where it came from.
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

export function resolveEndpoints(settings: { apiUrl?: string }): Endpoints {
  const raw = (settings.apiUrl ?? '').trim()
  const parsed = raw ? parse(raw) : parse(DEFAULT_API)
  const api = parsed ?? parse(DEFAULT_API)!
  return {
    api: trimSlash(api.toString()),
    ...(raw && !parsed ? { invalid: raw } : {}),
  }
}
