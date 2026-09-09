/**
 * shell-web.ts — the routes behind the per-session utility shell.
 *
 * `capability-guard.ts` has already refused these paths where the exposure profile forbids them,
 * and `index.ts` has already applied the user's own `shellEnabled` switch on top and refused a
 * central outright. What is left here is resolving the session and turning a `ShellRefusal` code
 * into a localized sentence — the modules below stay language-free, like `central-runtime.ts`'s
 * reason codes.
 */

import type { StartHost } from '../cli-start'
import type { CliLang } from '../cli-lang'
import { closeShells, listShells, openShell } from './shell-backend'
import { openShellStream, shellStreamAtCapacity, shellStreamExists } from './shell-stream-web'
import { SHELL_CAP, type ShellRefusal } from './shell-spec'

/** One sentence per refusal code. The module that decides never writes prose; this one never decides. */
const REFUSAL: Record<ShellRefusal, { en: string; pt: string }> = {
  'no-tmux': {
    en: 'This machine has no tmux, so there is no terminal to open. On Windows, run agentop under WSL.',
    pt: 'Esta máquina não tem tmux, então não há terminal para abrir. No Windows, rode o agentop pelo WSL.',
  },
  'no-cwd': {
    en: 'The registry records no directory for this session, so there is nowhere to open a shell.',
    pt: 'O registro não guarda um diretório para esta sessão, então não há onde abrir um shell.',
  },
  'cwd-missing': {
    en: 'This session’s directory no longer exists, so its shell cannot be opened there.',
    pt: 'O diretório desta sessão não existe mais, então o shell dele não pode ser aberto ali.',
  },
  'at-cap': {
    en: `${SHELL_CAP} terminals are already open. Close one to open another.`,
    pt: `Já há ${SHELL_CAP} terminais abertos. Feche um para abrir outro.`,
  },
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** `null` when the path is not ours, so `index.ts` falls through to its next route. */
export async function handleShellRoute(
  req: Request,
  url: URL,
  host: StartHost,
  lang: CliLang,
): Promise<Response | null> {
  // The live READ channel — the same SSE frames `/api/fleet/stream` sends, so the browser's reader
  // is the same reader. The three checks are the ones a stream needs and no more: an id, SCOPE (the
  // id must be an OPEN SHELL — resolved against `shells.json`, never the registry) and the ceiling.
  if (url.pathname === '/api/shell/stream' && req.method === 'GET') {
    const id = url.searchParams.get('id')
    if (!id) return json({ error: 'bad_request' }, 400)
    if (!(await shellStreamExists(id))) return json({ error: 'not_found' }, 404)
    if (shellStreamAtCapacity()) return json({ error: 'too_many_streams' }, 503)
    return new Response(await openShellStream(id, req.signal), {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  }

  if (url.pathname === '/api/shell/list' && req.method === 'GET') {
    return json({ shells: await listShells(), cap: SHELL_CAP })
  }

  if (url.pathname === '/api/shell/open' && req.method === 'POST') {
    const body = await req.json().catch(() => ({})) as { sessionId?: string }
    if (!body.sessionId) return json({ error: 'sessionId required' }, 400)
    if (!host.sessions) return json({ error: 'no_host' }, 503)

    // SCOPE IS CHECKED HERE, like `readAttachTicket` and `readFleetSkills`: the directory comes
    // from the ROW, never from the caller, so an unknown id is refused rather than answered with a
    // shell somewhere. `/api/fleet/new` is the one route that takes a directory from a body, and it
    // says why.
    const fleet = await host.sessions()
    const row = fleet.sessions.find(r => r.id === body.sessionId || r.conversationId === body.sessionId)
    if (!row) return json({ error: 'unknown_session' }, 404)

    const out = await openShell({ sessionId: row.id, cwd: row.cwd })
    if (!out.ok) {
      // A REFUSAL IS A 200 CARRYING A SENTENCE, not an error status. The request was well formed
      // and the answer is "no, and here is why" — a 4xx would make the browser draw its generic
      // failure instead of the one sentence that says what to do about it.
      return json({ ok: false, reason: out.reason, message: REFUSAL[out.reason][lang] })
    }
    return json({ ok: true, shell: out.shell })
  }

  if (url.pathname === '/api/shell/close' && req.method === 'POST') {
    const body = await req.json().catch(() => ({})) as { ids?: unknown }
    if (!Array.isArray(body.ids)) return json({ error: 'ids required' }, 400)
    return json(await closeShells(body.ids.filter((i): i is string => typeof i === 'string')))
  }

  return null
}
