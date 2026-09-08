/**
 * Which fleet row the reader currently has OPEN.
 *
 * One function because the rule is asked in two places (the pinned block and every group below it)
 * and a second copy is a second chance to get it wrong — which is exactly what happened. The
 * comparison used to be written inline as `s.id === sessionId || s.conversationId === sessionId`,
 * and with NOTHING open both sides are `undefined`, so `undefined === undefined` marked every row
 * that carries no conversation link as selected. On a real machine that is most of the history:
 * codex, kimi, gemini and agy can never have one (`conversationLinkable` is false), and a claude
 * row started before the link was recorded has none either — so the list opened wearing the
 * "you are here" edge on a scattering of rows the reader had never opened.
 *
 * An ABSENT id therefore matches nothing, on either side. Selection is a fact about where the
 * reader is, and "nowhere" is not a row.
 */
export function rowSelected(
  row: { id: string; conversationId?: string | undefined },
  sessionId: string | undefined,
): boolean {
  if (sessionId === undefined || sessionId === '') return false
  return row.id === sessionId || row.conversationId === sessionId
}
