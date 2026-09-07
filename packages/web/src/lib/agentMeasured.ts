/**
 * agentMeasured.ts — the sentence an absent agent metric needs.
 *
 * A subagent's numbers live in its own transcript (`subagents/agent-<id>.jsonl`), and Claude Code
 * deletes transcripts after `cleanupPeriodDays`. When one is gone the invocation is still real and
 * still listed — the parent recorded that it happened — but nothing on this machine can say what it
 * spent. The row renders no figure, and this is the line that stops the reader taking that dash for
 * a broken panel: same rule as `HARNESS_CAPABILITIES`, applied to one row instead of a whole
 * harness. A zero would be the confident claim; a dash with no explanation is a bug report waiting
 * to be filed.
 */

import type { Lang } from '@agentistics/core'

/** `null` when every invocation on screen carries its numbers — there is then nothing to say. */
export function unmeasuredNote(unmeasured: number, shown: number, lang: Lang): string | null {
  if (unmeasured <= 0) return null
  return lang === 'pt'
    ? `${unmeasured} de ${shown} sem números: o transcript do subagente já não está no disco, então os totais acima não as incluem.`
    : `${unmeasured} of ${shown} carry no numbers: the subagent's transcript is no longer on disk, so the totals above do not include them.`
}
