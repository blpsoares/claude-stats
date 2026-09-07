/**
 * security-headers.ts — the OWASP Secure Headers baseline, built per response.
 *
 * The SPA ships zero inline scripts (Vite emits module files and the PWA registration is an
 * external /registerSW.js), so script-src stays 'self' with no nonce machinery. Inline STYLE is
 * still required: React style props render as style attributes.
 *
 * Fonts are self-hosted (packages/web/public/fonts) precisely so no external origin needs to
 * appear here — a third-party font host both loosens the policy and leaks visitor IPs.
 */

/**
 * The one place that may frame this dashboard, and only where `embed` is true.
 *
 * A VS Code webview document lives at `vscode-webview://<uuid>`, so this scheme-source admits the
 * extension's Dashboard tab and NOTHING a web page can ever present: a page's origin is `http:` or
 * `https:` and cannot be forged into another scheme. That is what makes the allowance narrow enough
 * to add at all. It is deliberately not `'self'` — which would let any same-origin page frame the
 * dashboard — and deliberately not a wildcard.
 */
const EDITOR_FRAME_SOURCE = 'vscode-webview:'

export function buildCsp(opts: { dev: boolean; embed?: boolean }): string {
  // Dev runs the SPA on Vite's port talking to this server, with an HMR websocket.
  const connect = opts.dev ? "'self' ws: http://localhost:* http://127.0.0.1:*" : "'self'"
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    `frame-ancestors ${opts.embed ? EDITOR_FRAME_SOURCE : "'none'"}`,
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ')
}

export function securityHeaders(opts: {
  tls: boolean
  dev: boolean
  isApi: boolean
  /**
   * Let an EDITOR frame this dashboard — true only on a `local` profile, the machine's own
   * dashboard on 127.0.0.1, where the VS Code extension shows it in a tab.
   *
   * `X-Frame-Options` DISAPPEARS when it is on, and that is the point rather than an oversight: the
   * header has two values, `DENY` and `SAMEORIGIN`, and neither can express "one scheme". Left at
   * `DENY` beside a permissive `frame-ancestors` it simply wins wherever it is honoured and the tab
   * stays blank — which is exactly how this was found. `frame-ancestors` is the modern and more
   * expressive control, supported by every browser this dashboard runs in, so on this one profile
   * the legacy blanket is traded for a rule that says what is actually meant.
   */
  embed?: boolean
}): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Security-Policy': buildCsp({ dev: opts.dev, embed: opts.embed }),
    'X-Content-Type-Options': 'nosniff',
    // frame-ancestors above is the modern control; X-Frame-Options covers older browsers.
    ...(opts.embed ? {} : { 'X-Frame-Options': 'DENY' }),
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    // CORP is the SECOND thing that has to give for an editor to frame this, and missing it is why
    // relaxing `frame-ancestors` alone still produced a blank tab. A VS Code webview is served with
    // `Cross-Origin-Embedder-Policy: require-corp`, and under COEP every cross-origin subresource
    // AND nested document the embedder loads must answer `Cross-Origin-Resource-Policy:
    // cross-origin`. `same-origin` makes the browser drop the frame silently — no error the page
    // can see, nothing in the network panel of the outer document, just an empty rectangle.
    //
    // `cross-origin` here is narrower than it sounds: CORP governs who may EMBED the bytes, not who
    // may READ them. Reading is still same-origin by the browser's own rules and, on the profile
    // where this applies, the server is bound to 127.0.0.1 anyway. Every other profile keeps
    // `same-origin`.
    'Cross-Origin-Resource-Policy': opts.embed ? 'cross-origin' : 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  }
  if (opts.tls) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
  // API responses carry account-scoped data; a shared cache must never hold them.
  if (opts.isApi) h['Cache-Control'] = 'no-store'
  return h
}
