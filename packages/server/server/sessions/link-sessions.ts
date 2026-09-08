/**
 * link-sessions.ts — PURE. Which recorded session is the one agentop started?
 *
 * The session manager knows a session by ITS id; the harness records the conversation under its own.
 * Nothing ties the two together on disk, so the link has to be inferred — and this is a metrics
 * store, which is the last place to be lucky.
 *
 * So the rule is: infer only when there is exactly ONE candidate, and stamp nothing otherwise. An
 * unlabelled session is a small, self-correcting disappointment. A label on the WRONG session is a
 * user reading someone else's work under a name they chose themselves, and they have no way to tell.
 */

import type { HarnessId, SessionMeta } from '@agentistics/core'
import { sessionAtCwd } from '../live-sessions'
import { pickTitle } from './harness-session-file'
import type { ManagedSession } from './types'

/**
 * How long after `agentop session start` a conversation may appear and still be attributed to it.
 *
 * Generous, because a harness writes its first record only once a turn completes — an assistant that
 * sat on its folder-trust dialog for ten minutes before anyone answered is still that session. It is
 * bounded at all only so that a session started days ago cannot claim a fresh conversation in the
 * same directory.
 */
export const LINK_WINDOW_MS = 6 * 60 * 60 * 1000

/**
 * Pair managed sessions with the conversations they produced.
 *
 * Returns `Map<session_id, ManagedSession>` — keyed by the HARNESS's id, because that is what the
 * caller is holding when it stamps.
 *
 * Ambiguity is refused in BOTH directions: a managed session matching two conversations links to
 * neither, and a conversation two managed sessions could claim is left alone. Both are the same
 * mistake — attributing on a coin flip — and both happen for real, because opening two assistants of
 * one harness in one repository is an ordinary thing to do.
 */
export function linkManagedSessions(
  managed: readonly ManagedSession[],
  sessions: readonly SessionMeta[],
  windowMs: number = LINK_WINDOW_MS,
): Map<string, ManagedSession> {
  // A managed session with no usable creation time cannot be bounded, so it is not linked at all.
  const withStart = managed
    .map(m => ({ m, startedMs: Date.parse(m.createdAt) }))
    .filter((x): x is { m: ManagedSession; startedMs: number } => Number.isFinite(x.startedMs))

  const claims = new Map<string, ManagedSession[]>()

  for (const { m, startedMs } of withStart) {
    const candidates = sessions.filter(s => {
      if (s.harness !== (m.harness as HarnessId)) return false
      // Both of the session's directories count, the same predicate the live panel uses: a session
      // that moved into a worktree records it as `current_cwd` while `project_path` stays at the
      // root, and the managed session holds only the one directory it was started in.
      if (!sessionAtCwd(s, m.cwd)) return false
      const at = Date.parse(s.start_time ?? '')
      if (!Number.isFinite(at)) return false
      // Strictly after, and inside the window. A conversation that predates the start is not it.
      return at >= startedMs && at - startedMs <= windowMs
    })

    // Two conversations this session could be — refuse rather than take the closest. "Closest" is a
    // coin flip dressed as a rule when two assistants were opened in one directory minutes apart.
    if (candidates.length !== 1) continue

    const id = candidates[0]!.session_id
    const list = claims.get(id)
    if (list) list.push(m)
    else claims.set(id, [m])
  }

  const out = new Map<string, ManagedSession>()
  for (const [id, list] of claims) {
    // The other direction of the same refusal.
    if (list.length === 1) out.set(id, list[0]!)
  }
  return out
}

/**
 * Stamp the user's own label and note onto the sessions they belong to. Mutates in place, like the
 * rest of the enrichment pipeline, and touches nothing it cannot attribute.
 *
 * The label is resolved through `pickTitle` — the SAME contest the terminal cockpit settles between
 * the name typed into agentop (`m.label`) and the one typed with `/rename` inside the harness
 * (`m.harnessName`, the poller's persisted mirror of the live session file). Before this it was
 * `m.label` unconditionally, so a `/rename` made inside Claude was invisible on the web dashboard
 * even though `agentop session ls` already showed it — two implementations of "what is this session
 * called" answering differently, which is the defect `pickTitle` exists to remove. `sessionLabel`
 * (`core/format.ts`) is untouched: it still just reads `user_label` first, and `user_label` now
 * already holds whichever name won.
 */
export function applySessionLabels(
  sessions: SessionMeta[],
  links: ReadonlyMap<string, ManagedSession>,
): void {
  for (const s of sessions) {
    const m = links.get(s.session_id)
    if (!m) continue
    if (m.note) s.user_note = m.note
    const picked = pickTitle({
      ...(m.label ? { label: m.label } : {}),
      ...(m.labelSince !== undefined ? { labelSince: m.labelSince } : {}),
      ...(m.harnessName
        ? {
            file: {
              name: m.harnessName,
              ...(m.harnessNameSince !== undefined ? { nameSince: m.harnessNameSince } : {}),
            },
          }
        : {}),
      // Empty fallback rather than the historic `title`/`first_prompt` chain: those are read by
      // `sessionLabel` itself once `user_label` is absent, and re-deriving them here would be a
      // second copy of that fallback. `pickTitle` returning `derived` (title === '') means neither
      // side named this session, which is exactly when `user_label` must stay unset.
      fallback: '',
    })
    if (picked.source !== 'derived') s.user_label = picked.title
  }
}
