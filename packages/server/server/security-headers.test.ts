/**
 * security-headers.test.ts — the OWASP Secure Headers baseline and the CSP string.
 */
import { describe, expect, it } from 'bun:test'
import { buildCsp, securityHeaders } from './security-headers'

describe('buildCsp', () => {
  const csp = buildCsp({ dev: false })

  it('locks the default source to self', () => {
    expect(csp).toContain("default-src 'self'")
  })

  it('forbids inline and eval scripts', () => {
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(csp).not.toContain('unsafe-eval')
  })

  it('allows inline style, which React style props require', () => {
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
  })

  it('forbids framing entirely', () => {
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('admits ONE scheme when an editor may embed it, and never a page origin', () => {
    // A VS Code webview lives at `vscode-webview://<uuid>`. A web page's origin is http(s) and
    // cannot be forged into another scheme, which is what makes this allowance narrow enough to
    // exist — it is not `'self'`, which would let any same-origin page frame the dashboard.
    const embedded = buildCsp({ dev: false, embed: true })
    expect(embedded).toContain('frame-ancestors vscode-webview:')
    expect(embedded).not.toContain("frame-ancestors 'self'")
    expect(embedded).not.toContain('frame-ancestors *')
    // Nothing else moves.
    expect(embedded).toContain("script-src 'self'")
    expect(embedded).toContain("object-src 'none'")
  })

  it('pins base-uri, form-action and object-src', () => {
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'self'")
    expect(csp).toContain("object-src 'none'")
  })

  it('allows no external font or style origin (fonts are self-hosted)', () => {
    expect(csp).not.toContain('fonts.googleapis.com')
    expect(csp).not.toContain('fonts.gstatic.com')
  })

  it('relaxes connect-src for the Vite dev server only in dev', () => {
    expect(buildCsp({ dev: true })).toContain('ws:')
    expect(buildCsp({ dev: false })).not.toContain('ws:')
  })
})

describe('securityHeaders', () => {
  it('emits HSTS only when TLS is on', () => {
    expect(securityHeaders({ tls: true, dev: false, isApi: false })['Strict-Transport-Security'])
      .toBe('max-age=31536000; includeSubDomains')
    expect(securityHeaders({ tls: false, dev: false, isApi: false })['Strict-Transport-Security'])
      .toBeUndefined()
  })

  it('always emits the baseline set', () => {
    const h = securityHeaders({ tls: false, dev: false, isApi: false })
    expect(h['X-Content-Type-Options']).toBe('nosniff')
    expect(h['X-Frame-Options']).toBe('DENY')
    expect(h['Referrer-Policy']).toBe('same-origin')
    expect(h['Cross-Origin-Opener-Policy']).toBe('same-origin')
    expect(h['Cross-Origin-Resource-Policy']).toBe('same-origin')
    expect(h['Permissions-Policy']).toContain('camera=()')
    expect(h['Content-Security-Policy']).toContain("default-src 'self'")
  })

  it('drops X-Frame-Options exactly when an editor may embed it', () => {
    // The header has two values and neither says "one scheme". Left at DENY beside a permissive
    // frame-ancestors it simply wins, and the editor's tab stays blank — which is how this was
    // found. Everything else in the baseline stays.
    const embedded = securityHeaders({ tls: false, dev: false, isApi: false, embed: true })
    expect(embedded['X-Frame-Options']).toBeUndefined()
    expect(embedded['Content-Security-Policy']).toContain('frame-ancestors vscode-webview:')
    expect(embedded['X-Content-Type-Options']).toBe('nosniff')
    expect(embedded['Referrer-Policy']).toBe('same-origin')
    // The SECOND header that has to give. A VS Code webview is served with COEP `require-corp`, and
    // under COEP a nested document answering `same-origin` is dropped silently — an empty rectangle
    // with no error the page can see, which is exactly how it presented after `frame-ancestors`
    // alone was relaxed.
    expect(embedded['Cross-Origin-Resource-Policy']).toBe('cross-origin')
    expect(securityHeaders({ tls: false, dev: false, isApi: false })['Cross-Origin-Resource-Policy'])
      .toBe('same-origin')
    // …and the default is unchanged: no `embed`, no framing.
    expect(securityHeaders({ tls: false, dev: false, isApi: false })['X-Frame-Options']).toBe('DENY')
  })

  it('marks API responses no-store so credentials never land in a shared cache', () => {
    expect(securityHeaders({ tls: true, dev: false, isApi: true })['Cache-Control']).toBe('no-store')
    expect(securityHeaders({ tls: true, dev: false, isApi: false })['Cache-Control']).toBeUndefined()
  })
})
