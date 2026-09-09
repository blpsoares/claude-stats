/**
 * usage-dedupe.ts — PURE. One billed API response is counted ONCE.
 *
 * Claude Code writes an assistant turn as SEVERAL transcript lines when its content has several
 * blocks (text, then a `tool_use`, then another), and every one of those lines repeats the SAME
 * `message.usage` object. Summing per LINE therefore counts one API response two or three times.
 *
 * Measured on real transcripts on 2026-09-08, by recounting the raw files independently and
 * comparing against what the store had written:
 *
 *   session 4c3a96ac   148 usage lines / 79 distinct message ids   stored 17.845.286   true 10.381.785
 *   session b9665719                                               stored 609.681.868  true 352.623.940
 *   session aabe988b                                               stored 317.397.822  true 199.430.863
 *
 * The stored figure matched the per-line sum EXACTLY in all three, so this is not an estimate of a
 * defect, it is the defect. Every Claude session in the product over-reported tokens by 60-90 %,
 * and the cost with it — `calcCost` prices whatever these counters say.
 *
 * The key is `message.id`, which is Anthropic's own id for one API response, and one response is
 * one billing event. **The LAST record for an id wins**: where the repeats are byte-identical
 * (which is what every sample showed) it makes no difference, and if a future format ever writes a
 * partial usage first and the final one after, the last is the complete one. Taking the first
 * would silently under-report in exactly that case.
 *
 * A record with NO id is counted, always: it is a line this rule cannot pair with anything, and
 * dropping it would trade an over-count for an under-count. `HARNESS_CAPABILITIES`'s rule applied
 * to a line instead of a metric — what cannot be shown to be a duplicate is not one.
 *
 * The same trap is already documented for Kimi (`usage.record` beside a nested `step.end` carrying
 * the identical numbers) and for Antigravity (a tool REQUEST beside its EXECUTION). Three harnesses,
 * one shape: **when a transcript states one fact in two places, decide which one you count.**
 */

export interface UsageRecord {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/**
 * Should this line's usage be ADDED to the running totals?
 *
 * `seen` is the caller's own set of message ids, mutated here — the walk is a single pass over a
 * file that can be hundreds of megabytes, so the alternative (collect, then reduce) would hold
 * every record in memory to answer a question one boolean can.
 */
export function countUsage(messageId: unknown, seen: Set<string>): boolean {
  if (typeof messageId !== 'string' || !messageId) return true
  if (seen.has(messageId)) return false
  seen.add(messageId)
  return true
}

/**
 * The four counters of the records that should be counted, for a whole list — the same rule as
 * `countUsage`, in the shape a test (or a one-off audit) wants.
 *
 * LAST wins per id, which is why this cannot be expressed as a filter over the input order alone.
 */
export function dedupeUsage(
  entries: readonly { id?: unknown; usage?: UsageRecord }[],
): UsageRecord {
  const byId = new Map<string, UsageRecord>()
  const anonymous: UsageRecord[] = []
  for (const e of entries) {
    if (!e.usage) continue
    if (typeof e.id === 'string' && e.id) byId.set(e.id, e.usage)
    else anonymous.push(e.usage)
  }
  const out: Required<UsageRecord> = {
    input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
  }
  for (const u of [...byId.values(), ...anonymous]) {
    out.input_tokens += u.input_tokens ?? 0
    out.output_tokens += u.output_tokens ?? 0
    out.cache_read_input_tokens += u.cache_read_input_tokens ?? 0
    out.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0
  }
  return out
}
