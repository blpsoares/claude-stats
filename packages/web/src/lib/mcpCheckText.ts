/**
 * mcpCheckText.ts — PURE: one verdict, one sentence, and never a colour alone.
 *
 * Six outcomes rather than a tick and a cross, because each of them is fixed somewhere different —
 * a command that is not installed, a command that runs and quits, an endpoint nobody is listening
 * on, and a route the profile forbids are four separate errands.
 *
 * NONE OF THESE SAY "CONNECTED". agentistics does not run MCP servers: Claude Code starts them,
 * once, when a session starts. The most this can honestly report is that the configured command
 * answered the protocol's opening handshake when it was asked here — which is what `answers` says,
 * and why the sentence adds that a session has to be restarted for it to be usable.
 */

export interface McpCheckView { text: string; color: string }

export function mcpCheckText(
  check: { outcome: string; serverName?: string; exitCode?: number },
  pt: boolean,
): McpCheckView {
  const ok = '#22c55e'
  const bad = 'var(--accent-red)'
  const warn = '#f59e0b'
  const dim = 'var(--text-tertiary)'
  switch (check.outcome) {
    case 'answers':
      return {
        color: ok,
        text: check.serverName
          ? (pt
            ? `Respondeu — ${check.serverName}. Vale a partir da próxima sessão.`
            : `Answered — ${check.serverName}. It reaches a session from its next start.`)
          : (pt
            ? 'Respondeu. Vale a partir da próxima sessão.'
            : 'Answered. It reaches a session from its next start.'),
      }
    case 'exited':
      return {
        color: bad,
        text: pt
          ? `Iniciou e encerrou sem responder${check.exitCode !== undefined ? ` (código ${check.exitCode})` : ''} — normalmente um argumento ou um caminho que não existe.`
          : `Started and quit without answering${check.exitCode !== undefined ? ` (code ${check.exitCode})` : ''} — usually a bad argument or a path that does not exist.`,
      }
    case 'not-found':
      return {
        color: bad,
        text: pt
          ? 'O comando não existe nesta máquina.'
          : 'The command is not on this machine.',
      }
    case 'timeout':
      return {
        color: warn,
        text: pt
          ? 'Ficou de pé e não respondeu a tempo. Pode ser lento para subir, ou estar esperando algo.'
          : 'It stayed up and did not answer in time. It may be slow to start, or waiting on something.',
      }
    case 'unreachable':
      return {
        color: bad,
        text: pt ? 'O endereço não respondeu.' : 'The address did not respond.',
      }
    case 'uncheckable':
      return {
        color: dim,
        text: pt
          ? 'Sem comando e sem endereço — não há o que testar daqui.'
          : 'No command and no address — there is nothing to check from here.',
      }
    default:
      // The ROUTE failed, which is not a verdict about the server and must not be shown as one:
      // this capability is refused outright on a `lan` or `public` profile.
      return {
        color: dim,
        text: pt
          ? 'Não deu para testar daqui — esta máquina não permite iniciar processos por este painel.'
          : 'It could not be checked from here — this machine does not allow this panel to start processes.',
      }
  }
}
