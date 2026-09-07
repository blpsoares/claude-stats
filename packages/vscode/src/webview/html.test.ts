import { describe, expect, it } from 'bun:test'
import { escapeAttr, escapeText, sessionsHtml } from './html'

const SHELL = {
  cspSource: 'vscode-webview://abc',
  nonce: 'n0nc3',
  scriptUri: 'vscode-webview://abc/dist/webview.js',
  styleUri: 'vscode-webview://abc/media/style.css',
}

describe('sessionsHtml', () => {
  it('locks the document down and admits the script by nonce', () => {
    // A webview's asset origin is shared with every other extension's webview, so an origin
    // allowance is not the guarantee it looks like.
    const html = sessionsHtml(SHELL)
    expect(html).toContain("default-src &#39;none&#39;")
    expect(html).toContain("script-src &#39;nonce-n0nc3&#39;")
    expect(html).toContain('nonce="n0nc3"')
    expect(html).not.toContain("script-src 'unsafe-inline'")
  })

  it('admits inline STYLE, because a terminal frame is coloured per character run', () => {
    // Without it the browser drops every `style` attribute the ANSI renderer emits: the screen is
    // undifferentiated white text and the cursor — whose appearance is an inverted background —
    // vanishes. Script stays nonce-only, which is the half that matters.
    const html = sessionsHtml(SHELL)
    expect(html).toContain("style-src vscode-webview://abc &#39;unsafe-inline&#39;")
    expect(html).toContain("script-src &#39;nonce-n0nc3&#39;")
  })
})

describe('escaping', () => {
  it('closes every way out of an attribute', () => {
    expect(escapeAttr(`a"b'c<d>e&f`)).toBe('a&quot;b&#39;c&lt;d&gt;e&amp;f')
  })

  it('closes every way into a tag from text', () => {
    expect(escapeText('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;')
  })
})
