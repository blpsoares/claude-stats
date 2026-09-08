/**
 * secure-origin.ts — PURE: is this dashboard already reachable over https, and where?
 *
 * ## Why the browser cannot answer this
 *
 * Notifications, service workers and installability all require a SECURE ORIGIN. A machine's
 * dashboard is reached at `http://100.109.247.39:47292` — a plain-http address — so on a phone the
 * settings screen can only say "this is not a secure origin" and name `tailscale serve` as the
 * remedy in the abstract. It cannot say WHERE, because the page has no way to learn the machine's
 * name on the tailnet: from inside the browser one IP looks like any other.
 *
 * The SERVER can. `tailscale serve status --json` says exactly which https origins proxy to which
 * local ports, so if one of them already points at this dashboard's web port, that is the address
 * the person should be using — and the row stops being a rule and becomes a link.
 *
 * ## What this refuses to do
 *
 * It NEVER configures anything. Publishing a dashboard to a tailnet is an exposure decision and
 * belongs to the user, exactly as `autostart.ts` only ever SUGGESTS the line it would add to a
 * shell profile. This reads a configuration that already exists and reports it.
 *
 * And it only claims an origin that provably serves THIS dashboard: the handler's proxy target has
 * to be our own web port on a loopback address. An https origin pointing somewhere else is another
 * service on the same machine, and sending someone there would be a confident wrong answer of the
 * kind this codebase spends most of its comments avoiding.
 */

/** The shape `tailscale serve status --json` prints. Someone else's format: every field checked. */
export interface ServeStatusish {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> } | undefined> | undefined
}

/** Loopback, in the forms a proxy target is actually written in. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

/**
 * The https origin that proxies to `webPort` on this machine, or `null`.
 *
 * `null` is the honest answer for every case that is not a proven match — no config, a config for
 * some other service, a shape this cannot read. The caller renders nothing rather than a guess.
 *
 * Only the ROOT handler counts. A sub-path proxy (`/agentistics` → us) would serve the app from a
 * base path the bundle was not built for: the service worker's scope, the manifest's `start_url`
 * and every absolute asset path are all root-relative, so the link would open a broken page. That
 * is a worse answer than no link.
 */
export function secureOriginFor(status: ServeStatusish | null, webPort: number): string | null {
  const web = status?.Web
  if (!web || typeof web !== 'object') return null
  for (const [hostPort, entry] of Object.entries(web)) {
    const proxy = entry?.Handlers?.['/']?.Proxy
    if (typeof proxy !== 'string') continue
    if (!proxiesToPort(proxy, webPort)) continue
    // `Web` is keyed by `host:port`, and 443 is written explicitly. An origin says nothing about
    // its default port, so `:443` is dropped and anything else is kept.
    const origin = hostPort.endsWith(':443') ? hostPort.slice(0, -4) : hostPort
    return `https://${origin}`
  }
  return null
}

/** Does this proxy target name OUR web port, on this machine? */
function proxiesToPort(proxy: string, webPort: number): boolean {
  let url: URL
  try { url = new URL(proxy) } catch { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (!LOOPBACK.has(url.hostname)) return false
  return url.port === String(webPort)
}

/**
 * Ask Tailscale what it is serving, if it is installed at all.
 *
 * `null` for every failure — not installed, not running, a version whose `--json` differs, a
 * timeout. This is a HINT on a settings row; it must never be a reason a screen fails to load.
 *
 * Memoized for a minute: it spawns a process, and the row that reads it is repainted on every
 * render of a settings screen.
 */
let memo: { at: number; origin: string | null } | null = null
const TTL_MS = 60_000

export async function readSecureOrigin(webPort: number, now = Date.now()): Promise<string | null> {
  if (memo && now - memo.at < TTL_MS) return memo.origin
  let origin: string | null = null
  try {
    const proc = Bun.spawn(['tailscale', 'serve', 'status', '--json'], {
      stdout: 'pipe', stderr: 'ignore',
    })
    const out = await Promise.race([
      new Response(proc.stdout).text(),
      new Promise<string>(r => setTimeout(() => r(''), 2_000)),
    ])
    origin = out ? secureOriginFor(JSON.parse(out) as ServeStatusish, webPort) : null
  } catch {
    origin = null
  }
  memo = { at: now, origin }
  return origin
}

/** Tests only. */
export function forgetSecureOrigin(): void { memo = null }
