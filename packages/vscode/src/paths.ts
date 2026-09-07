/**
 * paths.ts — PURE. A directory a 300px column can read.
 *
 * Its own module rather than a helper inside the panel: `webview/main.ts` builds a DOM at import
 * time, so nothing in it can be loaded by a test.
 */

/**
 * A path a 300px column can read: the home directory as `~`, and the middle elided.
 *
 * The FIRST segment and the last two are what identify a directory — `/home/me/…/agentistics/web`
 * — and the run in between is what a sidebar has no room for and a reader does not use.
 */
export function shortenPath(path: string): string {
  const home = path.match(/^\/(?:home|Users)\/[^/]+/)
  const short = home ? `~${path.slice(home[0].length)}` : path
  const parts = short.split('/')
  if (parts.length <= 4) return short
  return [parts[0], '…', ...parts.slice(-2)].join('/')
}
