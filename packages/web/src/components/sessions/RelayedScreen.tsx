/**
 * RelayedScreen — another machine's session screen, as far as a central can honestly show it.
 *
 * A LIVE terminal is `GET /api/fleet/stream`: SSE, the machine's own route, `localShell` in
 * `capability-guard.ts` and refused on a central. Relaying an SSE stream through the reverse
 * WebSocket is a channel that does not exist, so on a central `TerminalRegion` connects to nothing
 * and its honesty line says so — correct, and useless to somebody trying to watch a session.
 *
 * What the machine DOES send, once it has granted the screen consent, is `lastLines`: the last
 * frame it captured, riding along with the fleet poll. That is what this draws.
 *
 * IT SAYS WHAT IT IS. A snapshot refreshed every few seconds looks exactly like a live terminal
 * that has gone quiet, and the difference matters at precisely the moment somebody is deciding
 * whether a session is stuck. So the header says it is a snapshot, and the ABSENCE of a screen gets
 * its own sentence rather than an empty black pane — "the machine did not send it" and "the session
 * has drawn nothing" are different facts, and an empty pane asserts the second.
 */

export function RelayedScreen({ lines, lang }: { lines?: readonly string[]; lang: 'pt' | 'en' }) {
  const pt = lang === 'pt'

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: 16 }}>
      <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: 'var(--text-tertiary)', flexShrink: 0 }}>
        {lines && lines.length > 0
          ? (pt
            ? 'Última tela que esta máquina enviou — uma foto, atualizada a cada leitura da frota, não um terminal ao vivo. Digitar aqui não é possível a partir de uma central; responder à sessão é pelo campo de mensagem.'
            : 'The last screen this machine sent — a snapshot refreshed on each fleet poll, not a live terminal. Typing into it is not possible from a central; answering the session is what the message field is for.')
          : (pt
            // Never an empty black pane: that reads as a session that has stopped.
            ? 'Esta máquina não está enviando a tela desta sessão. A chave "permitir ver a tela" fica nas configurações da própria máquina.'
            : 'This machine is not sending this session’s screen. The "allow screens" switch lives in that machine’s own settings.')}
      </p>

      {lines && lines.length > 0 && (
        <pre style={{
          flex: 1, minHeight: 0, margin: 0, padding: 12, borderRadius: 10,
          background: 'var(--bg-base)', border: '1px solid var(--border-subtle)',
          fontFamily: 'var(--font-mono, ui-monospace, monospace)', fontSize: 11.5, lineHeight: 1.45,
          color: 'var(--text-primary)',
          // The frame is already wrapped by the terminal that drew it, so it must NOT be re-wrapped
          // here — a re-wrapped frame misaligns every box-drawing character in it. It scrolls
          // inside its own container instead, which is also what keeps the page from scrolling
          // sideways at 390px.
          whiteSpace: 'pre', overflow: 'auto',
        }}>{lines.join('\n')}</pre>
      )}
    </div>
  )
}
