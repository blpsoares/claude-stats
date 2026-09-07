/**
 * machine-fleet.ts — the MEMBER side of relaying its fleet to a central.
 *
 * The machine is asked, over the reverse channel, for its own fleet; it answers with rows that
 * have been through two narrowings, in this order and never the other way round:
 *
 *  1. **The sharing rules.** A session in a repository or project this machine withholds from this
 *     central never becomes a row. The rule is `cwdShared` in `share-rules.ts` — the same one the
 *     live-session snapshot uses, so the two surfaces cannot disagree about one directory — and it
 *     is applied HERE, on the machine, because the machine is the only party that holds the rules
 *     and the only one whose application of them can be trusted.
 *  2. **The reduction.** `reduceMachineFleetRow` copies an allowlist of keys, so the screen, the
 *     conversation and the permission dialog cannot cross even by accident.
 *
 * Rules first, then reduce: reducing first would produce a row with no `cwd` to judge, and the
 * withheld count is a statement about SESSIONS, not about rows that happened to survive.
 *
 * The consent is re-read on every request rather than trusted from the caller. The central asking
 * is never the authority; the machine answering is, and a switch turned off half a second ago must
 * take effect on this frame rather than at the next handshake.
 */

import type { MachineActionReply, MachineFleetReply, MachineFleetRow, TeamConnection } from '@agentistics/core'
import { reduceMachineFleetRow, remoteActionAllowed, resolveRemoteConsent } from '@agentistics/core'
import type { CliLang } from '../cli-lang'

/** What `buildMachineFleetReply` needs from the world, so the decision itself stays testable. */
export interface MachineFleetDeps {
  readFleet: (lang: CliLang) => Promise<{
    rows: readonly Record<string, unknown>[]
    attention: number
    unavailable?: string
  }>
  /** The stored sessions + projects the repo index is built from — `buildApiResponse`'s output. */
  readIndexSources: () => Promise<{
    sessions: readonly { session_id: string; git_remote?: string; project_path: string }[]
    projects: readonly { path: string; gitRemote?: string }[]
  }>
}

/**
 * The two verbs whose subject is the piece of WORK rather than the row: they expand to every
 * session filed under the row's task, across the whole registry, and a task is a unit of work that
 * routinely spans repositories. See `performMachineAction` for why a restricted connection cannot
 * be offered them at all.
 */
const TASK_WIDE_ACTIONS: readonly string[] = ['openTask', 'finishTask']

/**
 * This connection's directory test, or `null` when the connection restricts NOTHING.
 *
 * `null` rather than a predicate that always returns true, so the callers can tell "everything is
 * shared" from "this directory is shared" and skip building an index nobody will consult — the
 * unrestricted case is the common one and pays nothing, exactly as `filterLiveShared`'s own
 * shortcut does.
 *
 * It is ONE function because the read half and the act half must agree about a directory. They did
 * not: the read half filtered rows through `cwdShared` while the act half had no rules check at
 * all, so a central could drive verbs against sessions it was never shown.
 */
async function sharedCwd(
  conn: Pick<TeamConnection, 'shareMode' | 'sources'>,
  readIndexSources: MachineFleetDeps['readIndexSources'],
): Promise<((cwd: string) => boolean) | null> {
  const shareRules = await import('../share-rules')
  const rules = shareRules.shareRulesOf(conn.shareMode, conn.sources)
  // An allowlist ALWAYS restricts (an empty one shares nothing), so this cannot be gated on a
  // non-empty source set the way an unrestricted denylist's could — same clause as the live
  // snapshot's, and for the same reason.
  if (rules.mode !== 'allowlist' && rules.sources.size === 0) return null
  const src = await readIndexSources()
  const index = shareRules.buildPathRepoIndex(src.sessions as never, src.projects)
  // A row with NO directory cannot be judged against a rule that names directories, so it is
  // withheld whenever any rule is in force. Sharing what cannot be checked is the fail-open
  // direction, and this channel is the sharpest one the product has.
  return cwd => !!cwd && shareRules.cwdShared(cwd, rules, index)
}

/**
 * Build the reply for ONE connection's request.
 *
 * Returns `null` when this machine has not agreed — the caller sends nothing at all rather than an
 * empty list. An empty list is a statement about the fleet; silence is a statement about consent,
 * and the central already distinguishes them (`MachineFleetUnavailable`).
 */
export async function buildMachineFleetReply(
  conn: Pick<TeamConnection, 'allowRemoteSessions' | 'allowRemoteScreens' | 'shareMode' | 'sources'>,
  lang: CliLang,
  deps: MachineFleetDeps,
): Promise<MachineFleetReply | null> {
  const consent = resolveRemoteConsent(conn.allowRemoteSessions, conn.allowRemoteScreens)
  if (!consent.sessions) return null

  const isShared = await sharedCwd(conn, deps.readIndexSources)
  const fleet = await deps.readFleet(lang)

  const rows: MachineFleetRow[] = []
  let withheld = 0
  for (const row of fleet.rows) {
    const cwd = typeof row.cwd === 'string' ? row.cwd : ''
    if (isShared && !isShared(cwd)) { withheld++; continue }
    // Narrowed to what may be driven from a central BEFORE the reduction, so a verb this machine
    // will refuse never even appears on the row. Offering one and refusing it on the click is the
    // control-that-reads-as-broken this codebase keeps arguing against. The task verbs go with the
    // rest on a RESTRICTED connection for exactly that reason — `performMachineAction` refuses
    // them there, so offering them would be that same broken control.
    const verbs = Array.isArray(row.verbs)
      ? (row.verbs as { action?: unknown }[]).filter(v =>
        typeof v?.action === 'string'
        && remoteActionAllowed(v.action, consent)
        && !(isShared && TASK_WIDE_ACTIONS.includes(v.action)))
      : undefined
    // The consent decides which KEYS survive, not just which verbs. Without it the screen fields
    // are dropped here even for a connection that was granted them, so the central would offer
    // `approve` on a dialog it could not show — the blind choice this whole boundary refuses.
    rows.push(reduceMachineFleetRow({ ...row, ...(verbs ? { verbs } : {}) }, consent))
  }

  return {
    rows,
    // Counted by the MACHINE over its UNFILTERED fleet: it is the number the machine's own cockpit
    // shows, and recomputing it from the relayed rows would quietly answer a different question
    // ("how many of the ones you may see") under the same name.
    attention: fleet.attention,
    withheld,
    ...(fleet.unavailable ? { unavailable: fleet.unavailable } : {}),
  }
}

/**
 * Perform one verb asked for by a central.
 *
 * THE MACHINE IS THE AUTHORITY, and this function is where that stops being a slogan. The consent
 * is re-read from preferences on every request rather than trusted from the asker, and the verb is
 * checked against `remoteActionAllowed` HERE as well as on the central — a central is the party
 * whose behaviour this machine cannot verify, so a check that runs only there is not a check.
 *
 * `approve` and `prompt` are allowed exactly when the machine granted the SCREEN, and refused with
 * a sentence naming WHY when it did not. A refusal that says nothing is indistinguishable from a
 * broken control — the same rule `fleet-row.ts` states for a verb a row cannot take. The gate is
 * the screen rather than the fleet because the dialog being READABLE is the safety: the keystroke
 * that answers it cannot know which option it is taking, so an `approve` without the screen would
 * be choosing for the person.
 *
 * The CHOICE travels with the request and is re-resolved HERE by `runFleetAction`, which re-reads
 * the live screen immediately before sending and refuses when the options CHANGED. A poll is five
 * seconds old, and five seconds is long enough for a dialog to be replaced by a different one with
 * the same shape.
 *
 * The refusal wording is this machine's, in this machine's language, because every other refusal
 * the user meets already is.
 *
 * **THE SHARING RULES ARE PART OF THAT AUTHORITY, and they were missing here.** The read half
 * (`buildMachineFleetReply`) filtered rows through `cwdShared`; this half checked consent and the
 * verb and then resolved the id against the machine's RAW fleet, so a central could `kill`,
 * `rename`, `resume` or re-task a session in a repository the member had explicitly withheld from
 * it. A rule that is enforced when you LOOK and not when you ACT is not a rule. So the target is
 * resolved and judged by the same predicate the rows were, and an unresolvable row is refused
 * rather than passed through: an id this machine cannot find is an id whose directory cannot be
 * judged.
 */
export async function performMachineAction(
  conn: Pick<TeamConnection, 'allowRemoteSessions' | 'allowRemoteScreens' | 'shareMode' | 'sources'>,
  lang: CliLang,
  req: { action: string; id: string; text?: string; choice?: number },
  deps: MachineFleetDeps & { runAction: (lang: CliLang, req: { id: string; action: string; text?: string; choice?: number }) => Promise<MachineActionReply> },
): Promise<MachineActionReply> {
  const pt = lang === 'pt'
  const consent = resolveRemoteConsent(conn.allowRemoteSessions, conn.allowRemoteScreens)
  if (!consent.sessions) {
    return {
      ok: false,
      message: pt
        ? 'Esta máquina não permite gerenciar sessões a partir de uma central.'
        : 'This machine does not allow session management from a central.',
    }
  }
  if (!req.id) {
    return { ok: false, message: pt ? 'Nenhuma sessão indicada.' : 'No session named.' }
  }
  if (!remoteActionAllowed(req.action, consent)) {
    // Named rather than generic: "not allowed" would read the same for a verb that needs the
    // screen and for one that does not exist, and they are different problems.
    const needsScreen = req.action === 'approve' || req.action === 'prompt'
    return {
      ok: false,
      message: needsScreen
        ? (pt
          ? 'Responder a uma sessão exige ver a tela dela, e a tela não sai desta máquina.'
          : 'Answering a session needs to read its screen, and the screen does not leave this machine.')
        : (pt
          ? 'Esta ação não pode ser feita a partir de uma central.'
          : 'This action cannot be performed from a central.'),
    }
  }

  const isShared = await sharedCwd(conn, deps.readIndexSources)
  if (isShared) {
    // A TASK verb expands to every session filed under the row's task, over the whole registry
    // (`host.openTask` → `readRegistry().filter(m => m.task === task)`), and a task routinely spans
    // repositories. Pressing it on a VISIBLE row therefore reached withheld ones — spawning real
    // assistants in a directory the user hid, and answering with a count of them.
    //
    // It is refused for EVERY restricted connection rather than only when the task provably spans a
    // withheld row, and that is deliberate: the narrower check is an ORACLE. Repeated over the rows
    // a central can see, "does this one span something hidden?" maps which of them share work with
    // the hidden half — the same correlation as counting a hidden project's sessions, which is the
    // leak this whole boundary exists to prevent. The refusal discloses nothing the reply does not
    // already carry: `withheld` is a machine-level count the central is given anyway.
    if (TASK_WIDE_ACTIONS.includes(req.action)) {
      return {
        ok: false,
        message: pt
          ? 'Esta máquina não compartilha toda a sua frota com esta central, e uma tarefa pode abranger sessões que ela não vê. Abra ou encerre a tarefa na própria máquina.'
          : 'This machine does not share its whole fleet with this central, and a task can span sessions this central cannot see. Open or finish the task on the machine itself.',
      }
    }
    const fleet = await deps.readFleet(lang)
    const target = fleet.rows.find(r => r.id === req.id)
    const cwd = typeof target?.cwd === 'string' ? target.cwd : ''
    // Fail closed on BOTH halves. A row this machine cannot find is refused for the same reason a
    // row with no directory is: the rule names directories, and there is nothing here to judge.
    if (!target || !isShared(cwd)) {
      return {
        ok: false,
        message: pt
          ? 'Esta sessão não é compartilhada com esta central.'
          : 'This session is not shared with this central.',
      }
    }
  }

  return await deps.runAction(lang, {
    id: req.id,
    action: req.action,
    text: req.text,
    // Carried only when it is a number: `runFleetAction` treats an absent choice as "use the
    // dialog's confirm key", which is right for a dialog with nothing to choose between and wrong
    // for one with options. `undefined` and "option zero" must not become the same request.
    ...(typeof req.choice === 'number' ? { choice: req.choice } : {}),
  })
}
