/**
 * centralMachines.ts — PURE: which machines a central can offer session management for, and what
 * it says about the ones it cannot.
 *
 * A central hosts no sessions of its own, so its Sessions page had nothing to show and said so.
 * That was true and useless: the person came to manage the sessions of the machines they can
 * reach, and the only surface that could was a drawer behind Settings → Machines. This module is
 * the list that page needs.
 *
 * REACHABLE means the machine ANNOUNCED that it allows it. Nothing here infers consent from
 * ownership or from the machine being online — the central cannot read a machine's preferences and
 * never asks (`machine-consent.ts`), so a machine that has not spoken is not reachable, and says
 * which of the reasons it is.
 *
 * The blocked ones are LISTED rather than dropped. An empty picker is one symptom with five causes,
 * and the person looking at it is exactly the person who needs to know which — the same rule
 * `machineConsentView` already applies to a single row.
 */

import { machineConsentView, type MachineConsentFacts } from '../pages/settings/machineConsentView'

export interface CentralMachine {
  id: string
  machineName: string
  online?: boolean
  accountIds?: string[]
  accountId?: string
  remoteConsent?: MachineConsentFacts | null
}

export interface ReachableMachine {
  id: string
  name: string
  online: boolean
  /** True when the machine also allows its session SCREEN to travel. */
  screens: boolean
}

export interface BlockedMachine {
  id: string
  name: string
  /** The already-worded reason, from `machineConsentView`. */
  text: string
  short: string
}

export interface CentralMachineList {
  reachable: ReachableMachine[]
  blocked: BlockedMachine[]
}

/**
 * Split the machine list.
 *
 * `viewerAccountId` is the same test the server runs (`machineOwnedBy`): a machine the viewer does
 * not own carries no consent field at all, and the reason it is unreachable is that — not silence.
 */
export function centralMachineList(
  machines: readonly CentralMachine[],
  viewerAccountId: string,
  lang: 'en' | 'pt',
): CentralMachineList {
  const reachable: ReachableMachine[] = []
  const blocked: BlockedMachine[] = []
  for (const m of machines) {
    const owners = m.accountIds && m.accountIds.length ? m.accountIds : (m.accountId ? [m.accountId] : [])
    const owned = owners.includes(viewerAccountId)
    const view = machineConsentView(m.remoteConsent, m.online ?? false, lang, owned)
    const name = m.machineName || m.id
    if (view?.tone === 'granted') {
      reachable.push({ id: m.id, name, online: m.online ?? false, screens: view.screens })
      continue
    }
    // No view at all means the caller could not tell — nothing to say, so nothing is said.
    if (view) blocked.push({ id: m.id, name, text: view.text, short: view.short })
  }
  // Online first, then by name: a machine that can answer right now is the one worth offering.
  reachable.sort((a, b) => (Number(b.online) - Number(a.online)) || a.name.localeCompare(b.name))
  blocked.sort((a, b) => a.name.localeCompare(b.name))
  return { reachable, blocked }
}

/**
 * Which machine the page should open on.
 *
 * The stored choice when it is still reachable, otherwise the first reachable one, otherwise none.
 * A remembered machine that has since gone quiet must not leave the page pointed at a picker entry
 * that is no longer there.
 */
export function pickCentralMachine(
  list: CentralMachineList,
  remembered: string | null,
): string | null {
  if (remembered && list.reachable.some(m => m.id === remembered)) return remembered
  return list.reachable[0]?.id ?? null
}
