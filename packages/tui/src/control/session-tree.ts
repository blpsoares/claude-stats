/**
 * session-tree.ts — PURE. The CASCADE arrangement: the project as the root, and the directories
 * under it as branches.
 *
 * ## Why it returns the same shape the flat arrangements return
 *
 * Every arrangement in this screen produces a `SessionGroup[]`, and everything downstream —
 * `sessionRows`, `cardPages`, `selectableIndexes`, the cursor, the row budget, the marked band, the
 * live/fell/closed split, the search — walks that one shape. So the cascade produces it too, already
 * in reading order, with `depth` and `path` as the only additions. Nothing downstream learns that a
 * tree exists; the one consumer that reads the new fields is the heading renderer, which indents by
 * `depth` and builds the card band's breadcrumb from `path`.
 *
 * The alternative — a nested structure with its own flattener — is a second implementation of every
 * one of those rules, and the two would disagree the first time either changed. That is the defect
 * `session-dimensions.ts` exists to remove, applied to arrangements instead of dimensions.
 *
 * ## What a branch is measured against, and when there is none
 *
 * The root KEY is `bucketKey(s, 'project', ctx)` — literally the call the project dimension makes —
 * so the cascade and "group by project" cannot disagree about which project a worktree belongs to.
 * The branches are the segments of `cwd` below `ControlSession.projectRoot`, which is the main
 * checkout's PATH, recorded at spawn and resolved live by `repo-facts.ts`.
 *
 * Two honesty rules, both producing a REAL row rather than an invented path:
 *
 *  - **No `projectRoot`** — the directory is not in a repository, or it is gone and nothing was
 *    recorded — and the session hangs directly off the root with no branch. A gone directory keeps
 *    its `GONE_PROJECT_KEY` bucket exactly as the flat arrangement gives it; nothing here may
 *    resurrect a name for a path that resolves to nothing.
 *  - **`cwd` is not a descendant of `projectRoot`** — `git worktree add ../elsewhere` resolves to
 *    the same project through the common git dir while sitting outside it — and the session gets ONE
 *    branch named after its own folder. A relative path that does not exist is never synthesised.
 *
 * `sessions.ts` imports `buildSessionTree`; this module imports the ordering from `session-order.ts`
 * and the `SessionGroup` shape from `sessions.ts` TYPE-ONLY, which is erased. The runtime graph runs
 * one way.
 */

import {
  bucketKey, dimensionValueLabel,
  type DimensionContext, type DimensionWordBook,
} from './session-dimensions'
import { DEFAULT_ORDER, sessionRank, sortSessions, type SessionOrder } from './session-order'
import type { SessionGroup } from './session-fleet'
import type { ControlSession } from './types'

/** What a card band puts between two segments of a breadcrumb. */
export const CRUMB_SEP = ' › '

/** What a path segment is joined by inside ONE compressed node — the separator it already had. */
const PATH_SEP = '/'

/** Separators normalised, trailing ones dropped. A WSL machine sees both. */
function norm(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * The segments of `cwd` BELOW the project root — PURE, and the whole of the honesty rule.
 *
 * `[]` means "hangs at the root": either there is no root to measure against, or the session IS in
 * the main checkout. A cwd outside the root yields its own folder name and nothing else.
 */
export function branchSegments(s: ControlSession): string[] {
  const root = norm(s.projectRoot ?? '')
  const cwd = norm(s.cwd ?? '')
  if (!root || !cwd) return []
  if (cwd === root) return []
  if (cwd.startsWith(`${root}/`)) return cwd.slice(root.length + 1).split('/').filter(Boolean)
  // Outside the checkout: the project is right (the common git dir said so) and the relative path
  // does not exist. Its own folder is the only real name available.
  const own = cwd.split('/').filter(Boolean).pop()
  return own ? [own] : []
}

/** A node under construction. `label` is the segment; a compressed chain joins several. */
interface Node {
  label: string
  children: Map<string, Node>
  sessions: ControlSession[]
}

const node = (label: string): Node => ({ label, children: new Map(), sessions: [] })

/**
 * Fold a single-child chain into one node — PURE, and applied only BELOW the root.
 *
 * `.claude/worktrees/session-monitor` is one row while nothing branches off it; the moment a second
 * worktree exists, `.claude/worktrees` becomes a node and both descend from it — which falls out of
 * this rule rather than being a case in it.
 *
 * The ROOT is never folded into its only child: it is the PROJECT and its children are directories,
 * two different kinds of thing, and joining them would draw a heading reading as a folder that does
 * not exist.
 */
function compress(n: Node): Node {
  const folded = compressBelow(n)
  if (folded.sessions.length === 0 && folded.children.size === 1) {
    const only = [...folded.children.values()][0]!
    return { ...only, label: `${n.label}${PATH_SEP}${only.label}` }
  }
  return folded
}

/** Compress every subtree, leaving THIS node's own label alone — what a root gets. */
function compressBelow(n: Node): Node {
  const children = [...n.children.values()].map(compress)
  return { ...n, children: new Map(children.map(c => [c.label, c])) }
}

/** The most urgent rank anywhere in this subtree — what a node is ordered by. */
function urgency(n: Node, order: SessionOrder): number {
  const own = n.sessions.length > 0 ? sessionRank(sortSessions(n.sessions, order)[0]!) : Infinity
  return [...n.children.values()].reduce((best, c) => Math.min(best, urgency(c, order)), own)
}

/**
 * The fleet as a cascade — PURE, already in reading order.
 *
 * Depth-first: a node, then everything under it. Siblings — and roots — are ordered by the most
 * urgent member of their SUBTREE, the same rule `groupSessions` applies to its bands, so grouping
 * never buries the one thing the screen exists to surface.
 */
export function buildSessionTree(
  list: readonly ControlSession[],
  /** Every dimension's words. Only `project` is read: the root IS the project bucket. */
  words: DimensionWordBook,
  /** Accepted for one signature with the flat arrangements. A tree node is not a task. */
  _doneTasks: readonly string[] = [],
  order: SessionOrder = DEFAULT_ORDER,
  ctx: DimensionContext = {},
): SessionGroup[] {
  /** One root per PROJECT bucket, keyed exactly as the project dimension keys it. */
  const roots = new Map<string, Node>()
  for (const s of list) {
    const key = bucketKey(s, 'project', ctx)
    let at: Node = roots.get(key) ?? node(dimensionValueLabel(words.project, key))
    roots.set(key, at)
    for (const segment of branchSegments(s)) {
      const child: Node = at.children.get(segment) ?? node(segment)
      at.children.set(segment, child)
      at = child
    }
    at.sessions.push(s)
  }

  const out: SessionGroup[] = []
  const walk = (n: Node, key: string, path: readonly string[], depth: number) => {
    out.push({
      key,
      label: n.label,
      sessions: sortSessions(n.sessions, order),
      depth,
      path,
    })
    const children = [...n.children.values()].sort((a, b) => {
      const byRank = urgency(a, order) - urgency(b, order)
      return byRank !== 0 ? byRank : a.label.localeCompare(b.label)
    })
    // The key is the path from the root, so two folders of the same name under different projects
    // are two nodes. The root's key is the project BUCKET key, which is a single path segment (or
    // `GONE_PROJECT_KEY`, unreachable as a real one), so the separator cannot collide with it.
    for (const c of children) walk(c, `${key}${PATH_SEP}${c.label}`, [...path, c.label], depth + 1)
  }

  const ordered = [...roots.entries()]
    .map(([key, n]) => ({ key, n: compressBelow(n) }))
    .sort((a, b) => {
      const byRank = urgency(a.n, order) - urgency(b.n, order)
      return byRank !== 0 ? byRank : a.n.label.localeCompare(b.n.label)
    })
  for (const { key, n } of ordered) walk(n, key, [n.label], 0)
  return out
}

/**
 * A node's path as the breadcrumb a card band is titled with — PURE.
 *
 * Truncated from the LEFT: the last segment is the one that identifies the node, so it is the last
 * thing given up. Whole segments go first; only when the last segment alone does not fit is it cut
 * into, and always from its left for the same reason.
 */
export function breadcrumb(path: readonly string[], width: number): string {
  if (path.length === 0 || width <= 0) return ''
  const full = path.join(CRUMB_SEP)
  if (full.length <= width) return full
  // Whole segments first, marking that something was dropped.
  for (let i = 1; i < path.length; i++) {
    const tail = `…${CRUMB_SEP}${path.slice(i).join(CRUMB_SEP)}`
    if (tail.length <= width) return tail
  }
  const last = path[path.length - 1]!
  if (last.length <= width) return last
  // Even the identifying segment is too wide — cut into it from the left, so what survives is its
  // end, which is what distinguishes `…-monitor` from `…-basis`.
  return width <= 1 ? last.slice(last.length - width) : `…${last.slice(last.length - (width - 1))}`
}
