/**
 * html.ts — PURE. The document this extension serves into a webview.
 *
 * A webview is a browser, so it carries a real Content-Security-Policy: `default-src 'none'` and
 * then exactly what the page needs. The script is admitted by NONCE rather than by origin — a
 * webview's asset origin is shared with every other extension's webview, so an origin allowance is
 * not the guarantee it looks like.
 *
 * Everything interpolated is escaped, including values that "come from settings and are therefore
 * ours": a `"` in the wrong place turns an attribute into markup, which is the whole of that class
 * of bug.
 */

export interface Shell {
  /** `webview.cspSource` — the origin the extension's own assets are served from. */
  cspSource: string
  /** A fresh value per document. Never reused across renders. */
  nonce: string
  scriptUri: string
  styleUri: string
}

/** Attribute-safe. The five characters that can leave an attribute or open a tag. */
export function escapeAttr(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Text-safe, for a sentence written into the body. */
export function escapeText(raw: string): string {
  return raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The Sessions panel — the same document whether it is docked in the sidebar or an editor tab. */
export function sessionsHtml(shell: Shell): string {
  const csp = [
    "default-src 'none'",
    `img-src ${shell.cspSource} data:`,
    // `'unsafe-inline'` for STYLE, and it is load-bearing rather than lazy. A terminal frame is
    // coloured per character run — 256 indexed colours plus truecolour — so every run carries a
    // `style` attribute, and without this the browser drops every one of them: the screen renders
    // as undifferentiated white text and the cursor, whose whole appearance is an inverted
    // background, disappears. That is precisely how it was reported ("nenhuma cor tá aparecendo").
    // Class names cannot express an arbitrary colour, so the alternative is a generated stylesheet
    // kept in sync with the markup — a second moving part for no gain here.
    //
    // What it does NOT relax is the part that matters: `script-src` stays nonce-only, so injected
    // markup still cannot execute. And with `default-src 'none'` there is no `img-src` or
    // `connect-src` for CSS to reach — the classic style-injection exfiltration
    // (`background: url(//attacker)`) has nowhere to send anything.
    `style-src ${shell.cspSource} 'unsafe-inline'`,
    `font-src ${shell.cspSource}`,
    `script-src 'nonce-${shell.nonce}'`,
  ].join('; ')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${escapeAttr(shell.styleUri)}">
<title>Agentistics Sessions</title>
</head>
<body>
<div id="root"></div>
<script nonce="${escapeAttr(shell.nonce)}" src="${escapeAttr(shell.scriptUri)}"></script>
</body>
</html>`
}
