/**
 * chat-web.ts — the CONVERSATION behind the web sessions workspace's chat view.
 *
 * `chat-tail.ts` answers a different question: the last handful of turns, for a detail pane six
 * rows tall. A chat view needs the whole conversation, and needs to fetch only what it has not
 * already seen — so this reads the transcript with an explicit turn budget and reports how many
 * turns exist, letting the browser hold what it already has.
 *
 * THE HARNESS LIMIT IS THE POINT, and it is TWO limits that were one thing for as long as Claude
 * was the only readable harness.
 *
 * The first is the LINK: a session can only be tied to its transcript where the id is EXACT — the
 * one agentop handed the CLI, or Claude Code's own `~/.claude/sessions/<pid>.json` naming our tmux
 * session. Guessing by harness-and-directory would put SOME OTHER conversation from the same folder
 * on screen under this session's name, which is worse than showing nothing: a confident wrong
 * answer the reader has no way to tell. `SessionView.conversationId` already enforces this, and
 * nothing here relaxes it.
 *
 * The second is the FORMAT: whether anybody has written a reader for it (`harness-transcript.ts`).
 * Collapsing the two cost the feature its honesty. Measured 2026-09-05 on a live antigravity
 * session holding a perfectly exact link — `/proc/<pid>/cmdline` was `agy --conversation
 * 01d0814f-…`, the very id the registry held — the request ran into the CLAUDE path resolver, came
 * back with no file, and answered `{turns: [], live: true}`: a completely blank pane with nothing
 * on it saying why. The link was never the problem; there was no reader.
 */

import type { StartHost } from '../cli-start'
import type { CliLang } from '../cli-lang'
import { controlStrings } from '@agentistics/tui/control/i18n'
import type { ChatTurn } from './chat-turn'
import { transcriptReaderFor } from './harness-transcript'

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
  /**
   * Already-localized: these turns are the END of a longer conversation.
   *
   * Present ONLY when the read stopped on its cap with transcript still above it. Everything built
   * on these turns inherits the window — the gallery lists the files of the turns it was given —
   * so a panel that empties because of the cap must be able to say that is why, instead of showing
   * nothing and letting it read as "there was never anything here".
   */
  older?: string
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

  // No reader for this harness's transcript FORMAT — see `harness-transcript.ts`. It is said in
  // words and it NAMES the harness, because "nothing here parses this yet" and "this conversation
  // has said nothing yet" are different facts, and only the second one changes on its own.
  // A row whose harness the registry has forgotten (`ControlSession.harness` is `''`) cannot be
  // routed to any reader, and saying "we cannot read ''" would be worse than saying nothing.
  if (!row.harness) {
    return {
      turns: [],
      unavailable: lang === 'pt'
        ? 'O registro não guarda mais qual assistente escreveu esta sessão, então não há como saber que transcrição ler.'
        : 'The registry no longer records which assistant wrote this session, so there is no way to know which transcript to read.',
      live,
    }
  }

  const reader = transcriptReaderFor(row.harness)
  if (!reader) {
    const name = row.harness
    return {
      turns: [],
      unavailable: lang === 'pt'
        ? `Ainda não sabemos ler a transcrição do ${name}. A conversa desta sessão está gravada no disco desta máquina — o que falta é um leitor para o formato dela.`
        : `We cannot read ${name}'s transcript format yet. This session's conversation is recorded on this machine — what is missing is a reader for it.`,
      live,
    }
  }

  const path = await reader
    .resolve({ conversationId: row.conversationId, ...(row.cwd ? { cwd: row.cwd } : {}) })
    .catch(() => null)
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

  // The reader routes by harness; only some of them can say whether the cap cut a longer
  // conversation short, and one that cannot makes NO claim — see `HarnessTranscript.readWindow`.
  const read = reader.readWindow
    ? await reader.readWindow(path, MAX_TURNS).catch(() => ({ turns: [] as ChatTurn[], older: false }))
    : { turns: await reader.read(path, MAX_TURNS).catch(() => [] as ChatTurn[]), older: false }
  return {
    turns: read.turns,
    live,
    ...(read.older
      ? {
          older: lang === 'pt'
            ? `Esta é a parte final da conversa — as últimas ${MAX_TURNS} interações. O que veio antes está na transcrição, mas fora desta janela.`
            : `This is the end of a longer conversation — its last ${MAX_TURNS} turns. What came before is still in the transcript, outside this window.`,
        }
      : {}),
  }
}
