/**
 * sessionRoute.ts — PURE: the URL of one session.
 *
 * A row's id is not always a token. `external:<harness>:<cwd>:<startedMs>` carries a DIRECTORY, and
 * a directory has slashes:
 *
 *     external:antigravity:/home/mithrandir/agentistics:1788625485620
 *
 * Interpolated raw into `/sessions/${id}`, those slashes become PATH SEPARATORS. The route is
 * `/sessions/:id`, which matches one segment, so nothing matched and the page rendered blank —
 * "tem uma external que se eu clicar nela ela crasha a aplicacao". Navigating to the same row with
 * the id encoded works, which is why it was invisible to anything that built the URL by hand.
 *
 * So the encoding happens HERE, in one function every caller goes through, rather than at five
 * `navigate()` sites where the sixth will forget. `useParams` decodes on the way back in, so
 * nothing downstream changes.
 *
 * The id is NOT reshaped to avoid the problem: `externalId()` composes it from the facts that
 * identify an external process, and a row's identity is not the place to make a routing concern
 * disappear.
 */

/** The path for one session row. `id` is used verbatim; only the URL encoding is added. */
export function sessionPath(id: string): string {
  return `/sessions/${encodeURIComponent(id)}`
}
