/**
 * machineFleet.ts — PURE: what one machine's fleet looks like once it has crossed to a central.
 *
 * This is the narrowest part of the whole feature and the place its guarantee actually lives.
 *
 * A machine's own `/api/fleet` carries the SCREEN of every live session (`lastLines`), the
 * CONVERSATION (`chatTurns`) and the permission dialog it is blocked on (`approvalLines`,
 * `dialogOptions`). `fleet-web.ts` justifies carrying them with one sentence: that route is
 * `localShell` in `capability-guard.ts`, refused on a central and on every exposed profile, so
 * "it is the same machine reading its own terminals". Relaying the fleet is exactly what would
 * make that sentence false, and on-demand chat retrieval was REMOVED from the reverse channel on
 * purpose (`team-agent.ts`; `GET /api/team/session-chat` is a 410).
 *
 * So the row that travels is built by an explicit ALLOWLIST (`MACHINE_FLEET_ROW_KEYS`) rather than
 * by deleting the fields we currently know to be dangerous. The difference matters in the future,
 * not today: a spread-and-delete leaks the next field somebody adds to `ControlSession`, silently
 * and on every machine, while an allowlist simply does not carry it until someone adds it here on
 * purpose. `machineFleet.test.ts` feeds a row carrying every sensitive field and asserts none of
 * them survives.
 *
 * `cwd` DOES travel, and that is a deliberate, narrower decision than it looks: a directory is
 * usually a repository's name, which is why the member applies its own sharing rules BEFORE
 * reducing (a session in a withheld repository never becomes a row at all). What travels here is
 * a path the account already sees in its own metrics for the same machine.
 */

/** The keys a relayed row may carry. Adding one is a product decision, not a refactor. */
export const MACHINE_FLEET_ROW_KEYS = [
  'id', 'title', 'harness', 'state', 'stateLabel', 'project', 'cwd',
  'task', 'note', 'model', 'conversationId', 'named', 'verbs',
] as const

/**
 * The keys the SCREEN consent adds, and nothing more.
 *
 * A second list rather than a flag on the first, because these are the fields the whole boundary
 * was drawn around: the session's terminal and the dialog it is blocked on. They travel only when
 * the machine has said yes to `allowRemoteScreens` — a separate question from "let me rename a
 * session from my phone", which is exactly why `remoteSessions.ts` made it a separate switch.
 *
 * `chatTurns` IS NOT HERE AND HAS NO SWITCH. On-demand chat retrieval was removed from the reverse
 * channel on purpose and `GET /api/team/session-chat` answers 410; the transcript stays where that
 * decision put it. A screen is the last frame of a terminal, which a person is watching anyway to
 * answer the dialog on it; a transcript is the whole conversation, which is a different thing to
 * hand over and was refused as such.
 */
export const MACHINE_FLEET_SCREEN_KEYS = ['lastLines', 'approvalLines', 'dialogOptions'] as const

export type MachineFleetRowKey =
  | typeof MACHINE_FLEET_ROW_KEYS[number]
  | typeof MACHINE_FLEET_SCREEN_KEYS[number]

/** One session of another machine, as its owning account may see it. */
export interface MachineFleetRow {
  id: string
  title: string
  harness: string
  /** The raw state id (`working` | `waiting` | `waiting-approval` | …), for ordering and colour. */
  state: string
  /** The state ALREADY IN WORDS, resolved by the machine in its own language. A central must not
   *  re-derive it: the machine owns that vocabulary and its refusal sentences. */
  stateLabel: string
  project: string
  cwd: string
  task?: string
  note?: string
  model?: string
  conversationId?: string
  named?: boolean
  /**
   * The last lines of this session's terminal, present ONLY under the screen consent.
   *
   * Its ABSENCE is not "the session has drawn nothing": it is "this machine did not send it", and
   * the two must not be read as one. The central shows a screen when it has one and says the
   * machine withholds it when it does not — never an empty black pane, which reads as a session
   * that has stopped.
   */
  lastLines?: string[]
  /** The dialog this session is blocked on, verbatim. Screen consent only. */
  approvalLines?: string[]
  /**
   * The options read OFF that dialog, and the reason the screen consent exists at all.
   *
   * Most dialogs are not yes/no — a claude permission prompt is `1. Yes / 2. Yes, always / 3. No`
   * and an `AskUserQuestion` can offer five answers that do different work. A key that "approves"
   * takes whichever row is HIGHLIGHTED, which on such a dialog is choosing for the person. So the
   * options are listed and the PICKED one is sent, exactly as the machine's own UI does it.
   */
  dialogOptions?: { number: number; label: string; selected: boolean }[]
  /**
   * What this row may take FROM A CENTRAL, already decided and worded by the machine.
   *
   * The same `sessionActions` decision the cockpit resolves every keypress against, narrowed to
   * the screenless set (`machineActions.ts`). A refused verb travels DISABLED with its reason
   * rather than being dropped: a row that silently loses half its buttons reads as a broken
   * feature, and absence communicates nothing about why — `fleet-row.ts` records that call.
   */
  verbs?: MachineFleetVerb[]
}

export interface MachineFleetVerb {
  action: string
  /** Already localized by the machine. A central composes no wording of its own. */
  label: string
  enabled: boolean
  reason?: string
}

/**
 * Why a fleet could not be shown. THREE SILENCES, and they are not interchangeable.
 *
 * An empty list is never allowed to stand in for any of them — the same rule
 * `HARNESS_CAPABILITIES` applies to a metric and `liveEmptyNotice` applies to live sessions.
 * `offline` sends someone to check whether the machine is running, `refused` sends them to the
 * switch on that machine, and `silent` says the machine is connected and did not answer — an older
 * build, or one that is wedged. Reporting any of the three as "no sessions" would be a confident
 * statement nobody established.
 */
export type MachineFleetUnavailable = 'offline' | 'refused' | 'silent' | 'not-owner'

export interface MachineFleetReply {
  rows: MachineFleetRow[]
  /** How many rows are waiting on a person, counted by the MACHINE over its unfiltered fleet. */
  attention: number
  /**
   * How many sessions this machine's sharing rules withheld from this central.
   *
   * Reported rather than silently subtracted: an allowlist can legitimately make the relayed fleet
   * much shorter than what is running, and "some sessions are not shared with this central" is a
   * sentence, not an absence.
   */
  withheld: number
  /** The machine's OWN already-localized sentence about why its list may be incomplete. */
  unavailable?: string
}

/**
 * The answer to one verb performed on another machine's session.
 *
 * `message` is ALWAYS present and is the MACHINE's own already-localized sentence — the same one
 * `runFleetAction` gives the cockpit. A central must not compose its own: every refusal this
 * product makes is worded by the thing that made it (`fleet-row.ts`'s `verbReason`,
 * `renameMessage`, the approval blind sentences), and a second vocabulary on the central would
 * drift from the first and describe refusals it does not actually make.
 */
export interface MachineActionReply {
  ok: boolean
  message: string
}

/** What the central's route answers when there is no reply to give. */
export interface MachineFleetAnswer {
  reply: MachineFleetReply | null
  /** Present exactly when `reply` is null. */
  reason?: MachineFleetUnavailable
}

/**
 * Reduce anything row-shaped to what may cross to a central.
 *
 * Deliberately typed on a wide, structural input: the caller holds a `ControlSession`, which this
 * package cannot name, and narrowing the parameter would only push the spread somewhere less
 * guarded. Only listed keys are copied, and only when they are present — an absent optional stays
 * absent rather than becoming `undefined` on the wire.
 */
export function reduceMachineFleetRow(
  row: Record<string, unknown>,
  /**
   * What the machine agreed to. ABSENT READS AS NO SCREEN — the same direction
   * `resolveRemoteConsent` and `chat-gate.ts` take, and the only safe default for a parameter added
   * to a function that already had callers: one that forgot to pass it must lose the screen, never
   * gain it.
   */
  consent: { screens: boolean } = { screens: false },
): MachineFleetRow {
  const out: Record<string, unknown> = {}
  const keys = consent.screens
    ? [...MACHINE_FLEET_ROW_KEYS, ...MACHINE_FLEET_SCREEN_KEYS]
    : MACHINE_FLEET_ROW_KEYS
  for (const key of keys) {
    if (row[key] !== undefined) out[key] = row[key]
  }
  // The four required strings are stated rather than trusted: a row that arrived without them
  // would render as blank cells, and a blank identity on a list of live sessions is worse than a
  // row that says nothing at all.
  return {
    id: String(out.id ?? ''),
    title: String(out.title ?? ''),
    harness: String(out.harness ?? ''),
    state: String(out.state ?? ''),
    stateLabel: String(out.stateLabel ?? ''),
    project: String(out.project ?? ''),
    cwd: String(out.cwd ?? ''),
    ...(typeof out.task === 'string' ? { task: out.task } : {}),
    ...(typeof out.note === 'string' ? { note: out.note } : {}),
    ...(typeof out.model === 'string' ? { model: out.model } : {}),
    ...(typeof out.conversationId === 'string' ? { conversationId: out.conversationId } : {}),
    ...(typeof out.named === 'boolean' ? { named: out.named } : {}),
    // Rebuilt element by element like the verbs, and for the same reason: these are the only
    // fields on the wire that carry terminal text, so what lands must be strings this function
    // put there rather than whatever shape the row happened to hold.
    ...(Array.isArray(out.lastLines) ? { lastLines: (out.lastLines as unknown[]).filter((l): l is string => typeof l === 'string') } : {}),
    ...(Array.isArray(out.approvalLines) ? { approvalLines: (out.approvalLines as unknown[]).filter((l): l is string => typeof l === 'string') } : {}),
    ...(Array.isArray(out.dialogOptions) ? { dialogOptions: (out.dialogOptions as unknown[]).map(reduceOption).filter((o): o is { number: number; label: string; selected: boolean } => o !== null) } : {}),
    // Each verb is rebuilt field by field for the same reason the row is: a `FleetVerb` that grew
    // a field carrying screen text would otherwise ride along inside an object nobody re-checked.
    ...(Array.isArray(out.verbs) ? { verbs: (out.verbs as unknown[]).map(reduceVerb).filter((v): v is MachineFleetVerb => v !== null) } : {}),
  }
}

/** One dialog option, rebuilt. A half-read option is worse than none — it gets OFFERED. */
function reduceOption(raw: unknown): { number: number; label: string; selected: boolean } | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.number !== 'number' || !Number.isFinite(o.number)) return null
  if (typeof o.label !== 'string') return null
  return { number: o.number, label: o.label, selected: o.selected === true }
}

function reduceVerb(raw: unknown): MachineFleetVerb | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (typeof v.action !== 'string' || !v.action) return null
  return {
    action: v.action,
    label: typeof v.label === 'string' ? v.label : v.action,
    enabled: v.enabled === true,
    ...(typeof v.reason === 'string' && v.reason ? { reason: v.reason } : {}),
  }
}
