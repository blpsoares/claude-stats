/**
 * relayAct.ts — PURE: what a verb performed on ANOTHER machine's session answered.
 *
 * A local verb answers `{ ok, message }` and `fleetAct.ts` reads it. A relayed one answers a
 * `MachineFleetAnswer` — `{ reply }` when the machine spoke, `{ reason }` when it did not — and the
 * two are not interchangeable: the second is a statement about the CHANNEL, and rendering it as a
 * failed verb would tell someone their rename was refused when nobody ever heard it.
 *
 * THE FOUR SILENCES KEEP THEIR OWN SENTENCES, and they live here so the panel and the workspace
 * cannot drift into two vocabularies for one fact. Each sends the reader somewhere different:
 * `refused` to the switch on that machine, `offline` to check whether it is running, `silent` to
 * its agentop version, `not-owner` nowhere at all — it is also the answer for a machine that does
 * not exist, so the route is not an existence oracle.
 *
 * WHEN THE MACHINE DID SPEAK, ITS OWN SENTENCE IS PASSED THROUGH UNTOUCHED. Every refusal in this
 * product is worded by the thing that made it, and a central composing its own would describe
 * refusals it does not make. That rule is why this module has exactly four sentences of its own and
 * not five.
 */

/** The shape the relay route answers with. Structural — the server type stays the source. */
export interface RelayAnswer {
  reply?: { ok?: unknown; message?: unknown } | null
  reason?: string
}

export type MachineSilence = 'offline' | 'refused' | 'silent' | 'not-owner'

/**
 * The sentence for a machine that did not answer.
 *
 * An unknown code falls through to the generic one rather than being dropped: a silence nobody
 * anticipated is still a silence, and saying nothing about it would leave a control that appears
 * to do nothing — which is the failure this whole family of sentences exists to prevent.
 */
export function machineSilenceSentence(reason: string | undefined, lang: 'pt' | 'en'): string {
  const pt = lang === 'pt'
  switch (reason) {
    case 'refused':
      // Names WHERE the switch is, because it is not here and nothing on this page can move it.
      return pt
        ? 'Esta máquina não permite gerenciar sessões daqui. A chave fica nas configurações da própria máquina.'
        : 'This machine does not allow session management from here. The switch lives in that machine’s own settings.'
    case 'offline':
      return pt
        ? 'Máquina offline. Ela responde quando estiver conectada.'
        : 'Machine offline. It answers once it is connected.'
    case 'silent':
      // Deliberately does NOT say the verb failed: the machine is connected and simply did not
      // answer, which an older build without this feature also does.
      return pt
        ? 'A máquina está conectada mas não respondeu. Pode estar numa versão antiga do agentop.'
        : 'The machine is connected but did not answer. It may be running an older agentop.'
    case 'not-owner':
      return pt
        ? 'Só a conta dona desta máquina pode agir nas sessões dela.'
        : 'Only the account that owns this machine can act on its sessions.'
    default:
      return pt
        ? 'Não foi possível perguntar a esta máquina agora.'
        : 'Could not ask this machine right now.'
  }
}

/**
 * One relayed verb's answer, in the shape every caller of `act` already reads.
 *
 * `ok` is only ever true when the MACHINE said so. A malformed reply, a missing `ok`, or a body
 * that is not an object all resolve to a refusal with a sentence — never to a silent success, which
 * on a `kill` would tell someone their session is gone while it is still running.
 */
export function parseRelayActResult(
  body: unknown,
  lang: 'pt' | 'en',
): { ok: boolean; message: string; id?: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, message: machineSilenceSentence(undefined, lang) }
  }
  const answer = body as RelayAnswer
  const reply = answer.reply
  if (!reply || typeof reply !== 'object') {
    return { ok: false, message: machineSilenceSentence(answer.reason, lang) }
  }
  const message = typeof reply.message === 'string' && reply.message !== ''
    ? reply.message
    : machineSilenceSentence(undefined, lang)
  return { ok: reply.ok === true, message }
}
