/**
 * machineFleetView.ts — PURE: what the relayed-fleet panel says.
 *
 * The panel's whole job is to never show an empty list standing in for a fact nobody established.
 * `GET /api/team/machine-fleet` answers either a reply or ONE of four reasons, and each sends the
 * reader somewhere different:
 *
 *  - `not-owner`  — you may not ask. Also the answer for a machine id that does not exist, so the
 *                   route is not an oracle for which machines a central holds.
 *  - `refused`    — the machine says no. Go to the switch ON THAT MACHINE; nothing here can lift it.
 *  - `offline`    — no socket. Go and check whether it is running.
 *  - `silent`     — connected, did not answer. An older build, or a wedged one.
 *
 * And a REPLY can still be incomplete in two different ways, which are also kept apart: the
 * machine's own `unavailable` sentence (it could not read its whole fleet — tmux missing, say), and
 * `withheld` (its sharing rules kept sessions from this central, which is the user's own choice and
 * not a fault).
 */

import type { MachineFleetReply, MachineFleetUnavailable } from '@agentistics/core'

export type FleetPanelTone = 'rows' | 'empty' | 'blocked'

export interface FleetPanelView {
  tone: FleetPanelTone
  /** The headline sentence. Never empty. */
  text: string
  /** Extra lines that qualify a REAL reply — the machine's own caveat, and what it withheld. */
  notes: string[]
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many.replace('{n}', String(n))
}

export function machineFleetPanelView(
  answer: { reply: MachineFleetReply | null; reason?: MachineFleetUnavailable } | null,
  lang: 'en' | 'pt',
): FleetPanelView {
  const pt = lang === 'pt'
  if (!answer) {
    return {
      tone: 'blocked',
      text: pt ? 'Não foi possível perguntar a esta máquina agora.' : 'Could not ask this machine right now.',
      notes: [],
    }
  }
  if (!answer.reply) {
    const reason = answer.reason
    if (reason === 'refused') {
      return {
        tone: 'blocked',
        // Names WHERE the switch is, because it is not here and no button on this page can move it.
        text: pt
          ? 'Esta máquina não permite gerenciar sessões daqui. A chave fica nas configurações da própria máquina.'
          : 'This machine does not allow session management from here. The switch lives in that machine’s own settings.',
        notes: [],
      }
    }
    if (reason === 'offline') {
      return {
        tone: 'blocked',
        text: pt
          ? 'Máquina offline. Ela responde quando estiver conectada.'
          : 'Machine offline. It answers once it is connected.',
        notes: [],
      }
    }
    if (reason === 'silent') {
      return {
        tone: 'blocked',
        // Deliberately does NOT say "no sessions": the machine is connected and simply did not
        // answer, which an older build without this feature also does.
        text: pt
          ? 'A máquina está conectada mas não respondeu. Pode estar numa versão antiga do agentop.'
          : 'The machine is connected but did not answer. It may be running an older agentop.',
        notes: [],
      }
    }
    return {
      tone: 'blocked',
      text: pt
        ? 'Só a conta dona desta máquina pode ver as sessões dela.'
        : 'Only the account that owns this machine can see its sessions.',
      notes: [],
    }
  }

  const { rows, withheld, unavailable } = answer.reply
  const notes: string[] = []
  // The machine's OWN sentence first — it is the one that explains a list that is short for a
  // reason the user did not choose.
  if (unavailable) notes.push(unavailable)
  if (withheld > 0) {
    notes.push(pt
      ? plural(withheld, '1 sessão não é compartilhada com esta central.', '{n} sessões não são compartilhadas com esta central.')
      : plural(withheld, '1 session is not shared with this central.', '{n} sessions are not shared with this central.'))
  }

  if (rows.length === 0) {
    return {
      tone: 'empty',
      // A REAL empty fleet, and it says so plainly — this is the only branch allowed to.
      text: pt ? 'Nenhuma sessão aberta nesta máquina.' : 'No sessions open on this machine.',
      notes,
    }
  }
  return {
    tone: 'rows',
    text: pt
      ? plural(rows.length, '1 sessão', '{n} sessões')
      : plural(rows.length, '1 session', '{n} sessions'),
    notes,
  }
}
