/**
 * closed-cap.ts — PURE: which closed conversations survive the cap.
 *
 * The workspace offers a bounded number of reopenable conversations, newest first, because several
 * hundred rows is a list a person scrolls and a few thousand is one a browser renders slowly for
 * nobody. Bounding is right. Bounding by RECENCY ALONE is what was wrong.
 *
 * Measured on the machine this was reported from:
 *
 *     conversations with a directory   claude 562 · antigravity 15 · codex 14 · kimi 12
 *                                      copilot 11 · gemini 9
 *     the newest 300                   claude 296 · codex 2 · copilot 2
 *     first antigravity at rank 311 · first kimi at 379 · first gemini at 575
 *
 * So three whole harnesses fell off the end, and with them the harness FILTER — which is built from
 * the rows — offered three options while the dashboard offered six. Reported twice, the second time
 * with both screens side by side.
 *
 * A cap that removes a harness ENTIRELY is not a truncation, it is a claim that the harness has no
 * sessions. Truncating a long list is what the cap is for; erasing a dimension of the data is a
 * different thing that happens to look the same from inside one harness's rows.
 *
 * So a harness the cut left with NOTHING keeps its newest few, however far down they sit. It is a
 * RESCUE, not a quota, and the distinction is what keeps the cap meaningful: a harness the cut
 * merely truncated (codex, two rows of fourteen) is already represented and reachable through the
 * filter, and a quota would also inflate the cap on a machine that runs ONE harness — 300 becomes
 * 320 for no one's benefit. This is about the harness EXISTING on the screen, not about showing its
 * history; the search field answers "find the old one" and reads the whole store.
 *
 * The result stays in one global newest-first order. A block of old conversations pinned to the
 * bottom would read as the list having a second, older list stapled to it.
 */

export interface CappedConversation {
  sessionId: string
  harness: string
  lastActivityMs: number
}

/** How many of its own newest a harness the cut erased gets back. */
export const HARNESS_FLOOR = 20

/**
 * The conversations that become rows.
 *
 * `list` must already be newest-first — this preserves that order and never re-sorts, because the
 * caller's ordering carries tie-breaking this module cannot see.
 */
export function capClosedConversations<T extends CappedConversation>(
  list: readonly T[],
  limit: number,
  floor: number = HARNESS_FLOOR,
): T[] {
  if (limit <= 0) return []
  if (list.length <= limit) return [...list]

  const keep = new Set<string>()
  for (const c of list.slice(0, limit)) keep.add(c.sessionId)

  // Which harnesses the cut kept ANYTHING of. Those are represented and are left exactly as the
  // recency ordering decided them.
  const held = new Map<string, number>()
  for (const c of list) {
    if (!keep.has(c.sessionId)) continue
    held.set(c.harness, (held.get(c.harness) ?? 0) + 1)
  }
  // The rescue. A harness is eligible only because the cut left it with NOTHING (`held` has no
  // entry for it); once it is being rescued it fills up to `floor` and stops.
  const rescued = new Set<string>()
  for (const [h, n] of held) if (n === 0) rescued.add(h)
  for (const c of list) {
    if (keep.has(c.sessionId)) continue
    if (held.has(c.harness) && !rescued.has(c.harness)) continue
    const n = held.get(c.harness) ?? 0
    if (n >= floor) continue
    rescued.add(c.harness)
    keep.add(c.sessionId)
    held.set(c.harness, n + 1)
  }

  return list.filter(c => keep.has(c.sessionId))
}
