/**
 * promptChars.ts — PURE. How long a prompt is, and how long the answer is.
 *
 * ## What is STORED is the sum, never the average
 *
 * `SessionMeta` carries `user_chars` / `assistant_chars` beside the message counts it already had,
 * and nothing anywhere stores a per-session average. That is the whole design decision: **the mean
 * of per-session means is the wrong number**, and it is exactly the one that falls out if you store
 * the average and then average it. A session with one prompt and a session with eighty cannot weigh
 * the same. Carrying sums lets every scope — a day, a project, a repository, whatever the filter
 * happens to be — divide ONCE, at the end, and be right.
 *
 * ## The denominator is the messages THAT SAID SOMETHING, and that was found by measuring
 *
 * The first version divided by `assistant_message_count`, the count this file already had. For
 * Claude that counts every `assistant` event, and measured on real transcripts on 2026-09-08 only
 * **334 of 1.316 of them (25%) carry any text at all** — the rest are `tool_use` blocks. The
 * average came out **79 characters against a real 312**: a 4x understatement that looked entirely
 * plausible, which is the failure mode this repo keeps running into and keeps writing down.
 *
 * So each side carries its OWN denominator — `user_char_messages` / `assistant_char_messages` —
 * counting only the messages that contributed characters, and every adapter increments it in the
 * SAME statement that adds the characters. The two halves of the division cannot then describe
 * different sets, and the existing `user_message_count` / `assistant_message_count` are left alone
 * to go on meaning what they always meant. That is also what let copilot and kimi have an assistant
 * average at all: their turn counters carry no text, but the events that DO carry text can count
 * themselves.
 *
 * ## Absent is N/A, never 0
 *
 * The consolidate store is full of records written before these fields existed, and every one of
 * them would read as an average of zero — a confident figure for something nobody measured. Same
 * rule `HARNESS_CAPABILITIES` applies to a metric and `contextFraction` applies to a gauge.
 *
 * ## And the coverage is REPORTED
 *
 * `stats-cache.json` holds no character data and Claude deletes transcripts after 30 days, so an
 * "all time" average is really an average over the sessions still readable. `aggregatePromptChars`
 * therefore returns how many sessions it could measure alongside how many it was given, so a
 * surface can say so instead of implying it covered everything — the same reason
 * `SessionAgentMetrics` counts its unmeasured invocations rather than folding them into the totals.
 *
 * ## What a "prompt" is here
 *
 * WHAT THE PERSON TYPED. The composer prepends attachment paths and can carry a quoted reply at
 * send time; neither is something anybody wrote, and counting them would make this disagree with
 * the counter under the field (`promptCount.ts` in the web bundle), which is the one number a
 * reader can check by eye. Two numbers about the same text agreeing is worth more than one of them
 * being more complete.
 *
 * ## A note for whoever adds MEDIANS
 *
 * These sums support means at any scope and support NO median of prompts: a median needs the
 * distribution, and this keeps totals. A median taken over per-session averages is a legitimate
 * statistic and a DIFFERENT one — "the typical session's typical prompt", not "the typical prompt"
 * — and has to be labelled as such rather than presented as the latter.
 */

import type { SessionMeta } from './types'

/**
 * Characters as a person counts them — CODE POINTS, not UTF-16 units.
 *
 * The one primitive every adapter counts through, so `user_chars` means the same thing whichever
 * harness wrote it. `String.length` reads an emoji as 2 and a flag as 4; the counter under the
 * composer (`promptCount.ts` in the web bundle) counts code points, and two numbers about the same
 * text have to agree. WHICH text is counted stays each adapter's decision — the shapes differ —
 * but HOW MANY is decided here.
 */
export function charCount(text: unknown): number {
  if (typeof text !== 'string' || text === '') return 0
  let n = 0
  for (const _ of text) n++
  return n
}

export interface PromptAverages {
  /** Mean characters per message the PERSON sent, or `null` when nothing was measured. */
  user: number | null
  /** Mean characters per message the ASSISTANT sent, or `null`. */
  assistant: number | null
}

/** One side's mean, or `null` — no characters recorded, or no messages to divide by. */
function mean(chars: number | undefined, messages: number | undefined): number | null {
  if (typeof chars !== 'number' || !Number.isFinite(chars)) return null
  if (typeof messages !== 'number' || !Number.isFinite(messages) || messages <= 0) return null
  return chars / messages
}

/** One session's two averages. Each side answers on its own — one absent must not withhold the other. */
export function sessionPromptAverages(s: SessionMeta): PromptAverages {
  return {
    user: mean(s.user_chars, s.user_char_messages),
    assistant: mean(s.assistant_chars, s.assistant_char_messages),
  }
}

export interface PromptCharsAggregate extends PromptAverages {
  /** How many sessions were offered. */
  sessions: number
  /** …and how many of them actually carried a user measurement. */
  userSessions: number
  /** …and an assistant one. */
  assistantSessions: number
}

/**
 * The averages over a SET, weighted by messages rather than by sessions.
 *
 * A session is only counted on a side where BOTH its characters and its message count are usable:
 * characters with no messages would put a numerator over a denominator that never saw it, and
 * messages with no characters is a record from before this was measured.
 */
export function aggregatePromptChars(list: readonly SessionMeta[]): PromptCharsAggregate {
  let userChars = 0, userMessages = 0, userSessions = 0
  let asstChars = 0, asstMessages = 0, assistantSessions = 0

  for (const s of list) {
    if (typeof s.user_chars === 'number' && Number.isFinite(s.user_chars)
      && typeof s.user_char_messages === 'number' && s.user_char_messages > 0) {
      userChars += s.user_chars
      userMessages += s.user_char_messages
      userSessions++
    }
    if (typeof s.assistant_chars === 'number' && Number.isFinite(s.assistant_chars)
      && typeof s.assistant_char_messages === 'number' && s.assistant_char_messages > 0) {
      asstChars += s.assistant_chars
      asstMessages += s.assistant_char_messages
      assistantSessions++
    }
  }

  return {
    user: userMessages > 0 ? userChars / userMessages : null,
    assistant: asstMessages > 0 ? asstChars / asstMessages : null,
    sessions: list.length,
    userSessions,
    assistantSessions,
  }
}
