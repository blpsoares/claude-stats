/**
 * chat-web.ts — the CONVERSATION behind the web sessions workspace's chat view.
 *
 * `chat-tail.ts` answers a different question: the last handful of turns, for a detail pane six
 * rows tall. A chat view needs the whole conversation, and needs to fetch only what it has not
 * already seen — so this reads the transcript with an explicit turn budget and reports how many
 * turns exist, letting the browser hold what it already has.
 *
 * THE HARNESS LIMIT IS THE POINT. A live session can only be tied to its transcript where the link
 * is EXACT — Claude Code's own `~/.claude/sessions/<pid>.json` naming our tmux session. Everywhere
 * else the honest answer is that this view cannot exist, and the caller says so in words. Guessing
 * by harness-and-directory would put SOME OTHER conversation from the same folder on screen under
 * this session's name, which is worse than showing nothing: it is a confident wrong answer, and the
 * reader has no way to tell.
 */

import type { StartHost } from '../cli-start'
import type { CliLang } from '../cli-lang'
import { controlStrings } from '@agentistics/tui/control/i18n'
import { readChatTurns, resolveChatTranscriptPath, type ChatTurn } from './chat-tail'

export interface ChatPayload {
  /** The turns, oldest first. Empty with no `unavailable` means a conversation with nothing in it. */
  turns: ChatTurn[]
  /**
   * Already-localized reason there is no conversation to show.
   *
   * Distinct from an empty `turns` on purpose: "this harness can never be read this way" and "this
   * conversation has not said anything yet" are different facts, and the second is temporary.
   */
  unavailable?: string
  /** True while the session is running, so the view knows whether to expect more. */
  live: boolean
}

/** The most turns one read returns. A conversation of thousands must not arrive as one response. */
const MAX_TURNS = 400

export async function readSessionChat(
  host: StartHost,
  lang: CliLang,
  id: string,
): Promise<ChatPayload> {
  const s = controlStrings(lang)
  if (!host.sessions) return { turns: [], unavailable: s.sessionsNoHost, live: false }

  const fleet = await host.sessions()
  const row = fleet.sessions.find(r => r.id === id)
  if (!row) {
    return {
      turns: [],
      unavailable: lang === 'pt'
        ? 'Esta sessão não está mais na lista desta máquina.'
        : 'This session is no longer in this machine’s list.',
      live: false,
    }
  }

  const live = row.state === 'working' || row.state === 'waiting' || row.state === 'waiting-approval'

  // The EXACT link, or nothing. `conversationBlind` is the row's own sentence for a harness that
  // can never report which conversation it is writing — reused rather than reworded, so the chat
  // view and the row give one answer.
  if (!row.conversationId) {
    return {
      turns: [],
      unavailable: row.conversationBlind ?? (lang === 'pt'
        ? 'Esta sessão ainda não tem uma conversa vinculada, então não há transcrição para ler.'
        : 'This session has no linked conversation yet, so there is no transcript to read.'),
      live,
    }
  }

  const path = await resolveChatTranscriptPath(row.cwd, row.conversationId).catch(() => null)
  if (!path) {
    // A LIVE session whose transcript is not on disk YET is an EMPTY conversation, not a missing
    // one — and the difference is the whole usability of a new session. A harness writes its
    // transcript when the conversation first says something, so every session agentop has just
    // started has no file for as long as nobody has spoken to it. Reporting that as `unavailable`
    // made the chat view render its refusal INSTEAD of the composer, so the one thing that would
    // create the transcript — sending the first message — was the one thing the view withheld. A
    // session created from the workspace was therefore un-chattable for its whole life, and the
    // only way in was the terminal tab.
    //
    // So the empty answer is reserved for the case the shape already documents: `turns: []` with no
    // `unavailable` means "a conversation with nothing in it". A session that is NOT running keeps
    // the refusal, because there its missing transcript really is a transcript that is gone — the
    // same N/A-versus-a-confident-0 rule, applied to "not yet" against "no longer".
    if (live) return { turns: [], live }
    return {
      turns: [],
      unavailable: lang === 'pt'
        ? 'A transcrição desta conversa não foi encontrada nesta máquina.'
        : 'This conversation’s transcript was not found on this machine.',
      live,
    }
  }

  const turns = await readChatTurns(path, MAX_TURNS).catch(() => [] as ChatTurn[])
  return { turns, live }
}
