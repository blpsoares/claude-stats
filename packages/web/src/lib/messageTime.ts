/**
 * messageTime.ts — PURE: the time stamped under one chat message.
 *
 * Asked for directly: "queria que tivessemos igual no whatsapp em baixo das mensagens tivesse o
 * horário que a mensagem foi enviada". The transcript already carries it — every one of 400 turns
 * measured on a live session had an `at` — so nothing here computes a time, it only decides how
 * much of one to SHOW.
 *
 * THE HOUR ALONE IS AMBIGUOUS ACROSS DAYS, and a session workspace is exactly where that bites: a
 * conversation reopened over three weeks renders as one scroll, so a bare `14:32` says nothing
 * about which 14:32. WhatsApp answers this with day separators between messages; the cheaper answer,
 * and the one that cannot be scrolled past, is to let the stamp itself grow — the hour for today,
 * the weekday for the last week, the date beyond that. A reader never has to scroll up to learn
 * when something was said.
 *
 * A MISSING TIME IS ABSENT, NEVER INVENTED. `null` means the transcript carried none — the same
 * rule the rest of this product applies to a metric it cannot produce — and the bubble draws no
 * stamp rather than "now", which would be a confident wrong answer about the one thing the stamp
 * exists to state.
 */

export interface MessageTime {
  /** What goes under the message. Short by construction — it sits inside a bubble. */
  label: string
  /** The whole instant, for a `title` — the stamp is abbreviated, this never is. */
  full: string
}

const MS_DAY = 86_400_000

/** Midnight local, as a day index. Comparing DAYS, never elapsed hours: a message from 23:50 and
 *  one from 00:10 are twelve hours apart on the clock and one day apart to a reader. */
function dayIndex(d: Date): number {
  return Math.floor((d.getTime() - d.getTimezoneOffset() * 60_000) / MS_DAY)
}

/**
 * The stamp for one message.
 *
 * `null` for anything that is not a usable instant — an absent `at`, a string that will not parse,
 * an `Invalid Date`. Total by construction: a chat bubble may not throw over a timestamp.
 */
export function messageTime(
  at: string | undefined,
  lang: 'pt' | 'en',
  nowMs: number = Date.now(),
): MessageTime | null {
  if (!at) return null
  const d = new Date(at)
  const ms = d.getTime()
  if (!Number.isFinite(ms)) return null

  const locale = lang === 'pt' ? 'pt-BR' : 'en-US'
  // `hourCycle` rather than `hour12`: pt-BR is 24h and en-US is 12h, which is what each reader
  // expects, and the locale already knows. Stating it would be this module inventing a convention.
  const hhmm = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const full = d.toLocaleString(locale, {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })

  const days = dayIndex(new Date(nowMs)) - dayIndex(d)

  // A message from the FUTURE is a clock disagreement, not a message from tomorrow. It keeps the
  // plain hour rather than being labelled — the `title` carries the whole instant either way, and
  // inventing "tomorrow" for a machine whose clock is a minute ahead would be worse than saying
  // less.
  if (days <= 0) return { label: hhmm, full }
  if (days === 1) return { label: `${lang === 'pt' ? 'ontem' : 'yesterday'} ${hhmm}`, full }
  if (days < 7) {
    const wd = d.toLocaleDateString(locale, { weekday: 'short' }).replace(/\.$/, '')
    return { label: `${wd} ${hhmm}`, full }
  }
  // Beyond a week the weekday stops locating anything, so the date does it. The YEAR joins only
  // once it differs: on a conversation inside one year it is four characters that say nothing.
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear()
  const date = d.toLocaleDateString(locale, sameYear
    ? { day: '2-digit', month: '2-digit' }
    : { day: '2-digit', month: '2-digit', year: 'numeric' })
  return { label: `${date} ${hhmm}`, full }
}
