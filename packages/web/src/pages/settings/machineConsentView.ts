/**
 * machineConsentView.ts — PURE: what a machine row says about session management.
 *
 * The central cannot read a machine's preferences and never asks. A machine ANNOUNCES its consent
 * over the reverse channel, the central holds it in memory for as long as the socket lives, and the
 * `/api/iam/machines` row carries it ONLY for the machine's own accounts (`machineOwnedBy`) — an
 * instance owner who is not this machine's user sees the field absent, not `null`.
 *
 * Four states, and the two that look alike are the reason this is its own module:
 *
 * - **absent** — you may not ask. It USED to say nothing at all, and that was the defect: an
 *   instance OWNER manages every machine (`canManageMachine` short-circuits on the role) but owns
 *   only the machines linked to their own account (`machineOwnedBy` deliberately does not), so an
 *   owner opened the machine they administer, found no cell and no button, and had a feature that
 *   was working correctly and looked broken. The boundary is right — reaching into a machine's
 *   sessions is narrower than administering it — but a boundary nobody can see is one people
 *   report as a bug, which is exactly what happened. It is now a SENTENCE (`tone: 'not-owner'`),
 *   and the row still offers no button: stating a limit is not lifting it.
 * - **`null`** — this machine has not said. Not a refusal: a machine that is off, or one running a
 *   build that predates the announcement, is silent in exactly the same way. Reporting silence as
 *   "this machine refuses" would send someone to a switch to change something already set.
 * - **`{sessions:false}`** — this machine says no. THAT is a refusal, and it names the switch.
 * - **`{sessions:true, …}`** — agreed, with or without the screen.
 *
 * `online` is threaded in because it is what separates the two readings of silence for a person:
 * an offline machine has an obvious reason not to have spoken, and a machine that is online and
 * still silent is the interesting case (an older build, or one that has not finished connecting).
 */

export interface MachineConsentFacts {
  sessions: boolean
  screens: boolean
  atMs: number
}

export type MachineConsentTone = 'granted' | 'refused' | 'silent' | 'not-owner'

export interface MachineConsentView {
  tone: MachineConsentTone
  /** Already-resolved sentence, EN/PT. Never an empty string — a state with no words is a state
   *  the reader has to guess at, and this one is about access to their machine. */
  text: string
  /** Whether the SCREEN half is in force. Only ever true under `granted`. */
  screens: boolean
  /** A few words for the dense desktop row, where the sentence does not fit. It is a LABEL, never
   *  the whole message — the full `text` rides along as the cell's title, and the mobile card
   *  prints it in full, because a table that can only be understood by hovering is a table a
   *  touch device cannot read at all. */
  short: string
}

/**
 * `consent === undefined` means the caller may not ask, and yields `null` — the row draws nothing.
 * That is deliberately distinct from `consent === null`, which is a machine that has not spoken and
 * DOES get a sentence.
 */
export function machineConsentView(
  consent: MachineConsentFacts | null | undefined,
  online: boolean,
  lang: 'en' | 'pt',
  /**
   * Does the VIEWER appear in this machine's own account list?
   *
   * Omitted by a caller that cannot tell, which keeps the old behaviour (draw nothing) rather than
   * asserting a reason it does not know. Passed as `false` it produces the `not-owner` sentence —
   * the machine is on screen because the viewer may administer it, and the reason its sessions are
   * not is worth one line.
   */
  viewerOwnsMachine?: boolean,
): MachineConsentView | null {
  const pt = lang === 'pt'
  if (consent === undefined) {
    if (viewerOwnsMachine !== false) return null
    return {
      tone: 'not-owner',
      screens: false,
      short: pt ? 'outra conta' : 'another account',
      text: pt
        ? 'As sessões desta máquina só podem ser vistas pelas contas às quais ela está vinculada. Vincule sua conta a ela para chegar às sessões.'
        : 'This machine’s sessions are reachable only by the accounts it is linked to. Link your account to it to reach them.',
    }
  }
  if (consent === null) {
    return {
      tone: 'silent',
      screens: false,
      short: online ? (pt ? 'não informou' : 'not said') : (pt ? 'offline' : 'offline'),
      text: online
        ? (pt
          ? 'Esta máquina ainda não informou se permite gerenciar sessões daqui.'
          : 'This machine has not said whether it allows session management from here.')
        : (pt
          ? 'Máquina offline — ela informa isso ao conectar.'
          : 'Machine offline — it says so when it connects.'),
    }
  }
  if (!consent.sessions) {
    return {
      tone: 'refused',
      screens: false,
      short: pt ? 'sessões: não' : 'sessions: no',
      text: pt
        ? 'Esta máquina não permite gerenciar sessões daqui.'
        : 'This machine does not allow session management from here.',
    }
  }
  return {
    tone: 'granted',
    screens: consent.screens,
    short: consent.screens
      ? (pt ? 'sessões + tela' : 'sessions + screen')
      : (pt ? 'sessões' : 'sessions'),
    text: consent.screens
      ? (pt
        ? 'Permite gerenciar sessões daqui, incluindo a tela da sessão.'
        : 'Allows session management from here, including the session screen.')
      : (pt
        ? 'Permite gerenciar sessões daqui. A tela da sessão não é enviada.'
        : 'Allows session management from here. The session screen is not sent.'),
  }
}
