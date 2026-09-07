/**
 * relayedSessions.ts — PURE: one machine's relayed rows, in the shape the SESSION LIST already
 * draws.
 *
 * The central's Sessions page first shipped with a list of its own, and that was the wrong call —
 * "vc mudou completamente a listagem das sessões, na central deveria aparecer a listagem igual na
 * machine". A second list is a second set of decisions about grouping, ordering, search, what a
 * row shows and how a state is worded, and the two drift. The list is `SessionsAside`, here as
 * everywhere.
 *
 * A `MachineFleetRow` is a `ControlSession` minus everything the allowlist deliberately withholds
 * (`MACHINE_FLEET_ROW_KEYS`), so almost all of this is a pass-through. Three fields have to be
 * SUPPLIED, and each is derived from what actually arrived rather than invented:
 *
 *  - `searchFields` — built from the row's own name, folder, harness, note and task. `prompt` is
 *    EMPTY, because the opening prompt does not cross the wire: searching by it would silently
 *    match nothing rather than say it cannot.
 *  - `actionable` — true when the machine offered at least one verb it will accept. It is the
 *    machine's own answer, narrowed by `machineActions.ts` before the row was built.
 *  - `attached` — always false. Attaching means a terminal on the host, and a central has none.
 *
 * Nothing here fabricates a state, a title or a count. A field the relay withheld stays absent, and
 * the list renders it the same way it renders a local row that lacks it.
 */

import type { ControlSession } from '@agentistics/tui/control/session-fleet'

/** The subset of a relayed row this module reads. Structural, so the core type stays the source. */
export interface RelayedRow {
  id: string
  title: string
  harness: string
  state: string
  stateLabel: string
  project: string
  cwd: string
  task?: string
  note?: string
  model?: string
  conversationId?: string
  named?: boolean
  /**
   * The session's terminal, present only when the machine granted the SCREEN consent.
   *
   * Passed straight through: the list and the panel already know how to draw a `ControlSession`
   * that has one, and a row without it renders exactly like a local row that has none. Its
   * ABSENCE is "the machine did not send it", never "the session drew nothing" — the panel says
   * which, because an empty black pane reads as a session that has stopped.
   */
  lastLines?: string[]
  approvalLines?: string[]
  dialogOptions?: Array<{ number: number; label: string; selected: boolean }>
  verbs?: Array<{ action: string; label: string; enabled: boolean; reason?: string }>
}

export function relayedToSession(row: RelayedRow): ControlSession {
  return {
    ...row,
    state: row.state as ControlSession['state'],
    searchFields: {
      name: row.title,
      folder: row.cwd,
      harness: row.harness,
      note: row.note ?? '',
      task: row.task ?? '',
      // Deliberately empty — see the header.
      prompt: '',
    },
    actionable: (row.verbs ?? []).some(v => v.enabled),
    attached: false,
  } as ControlSession
}

export function relayedToSessions(rows: readonly RelayedRow[]): ControlSession[] {
  return rows.map(relayedToSession)
}
