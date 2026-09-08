/**
 * MachineFleetDrawer.tsx — the machine row's way into `MachineFleetPanel`.
 *
 * The panel is the whole feature and lives on its own, because the SESSIONS page of a central hosts
 * it too. What is left here is the drawer: a title, a way out, and the rule that nothing is
 * requested while it is closed.
 */

import { Drawer } from './Drawer'
import { MachineFleetPanel } from './MachineFleetPanel'

export function MachineFleetDrawer({ open, machineId, machineName, lang, onClose }: {
  open: boolean
  machineId: string
  machineName: string
  lang: 'en' | 'pt'
  onClose: () => void
}) {
  return (
    <Drawer open={open} title={machineName} onClose={onClose} lang={lang}>
      <MachineFleetPanel open={open} machineId={machineId} lang={lang} />
    </Drawer>
  )
}
