/**
 * CentralSessions.tsx — on a CENTRAL, which machine the Sessions workspace is looking at.
 *
 * It is a PICKER and nothing else. The list is `SessionsAside` and the overview is the centre, both
 * exactly as they are on a machine: `useFleet` fetches the chosen machine's relayed fleet and hands
 * back the same shape a local one does, so neither surface knows which kind of install it is.
 *
 * That is the second attempt. The first drew its own list in the CENTRE of the page while the real
 * aside said "no sessions on this machine yet" — the same sessions in two shapes, in the wrong
 * place, which is what "qual parte vc n entendeu de visualizacao identica" meant.
 *
 * ONE MACHINE AT A TIME, deliberately: each poll makes that machine build a real fleet (a tmux
 * round trip per session), so fetching the whole estate would tax every machine to fill a list
 * nobody is reading. The chip carries online/offline, because whether a machine can answer NOW is
 * worth knowing before choosing it rather than after waiting.
 *
 * A machine that cannot be reached is NAMED with its reason, never left out: an empty picker is one
 * symptom with several causes, and the person looking at it is the one who needs to know which.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { MonitorSmartphone } from 'lucide-react'
import { centralMachineList, pickCentralMachine, type CentralMachine } from '../../lib/centralMachines'
import {
  centralMachineServerSnapshot, getCentralMachine, setCentralMachine, subscribeCentralMachine,
} from '../../lib/centralMachinePick'


export function CentralSessions({ lang }: { lang: 'pt' | 'en' }) {
  const pt = lang === 'pt'
  const [machines, setMachines] = useState<CentralMachine[] | null>(null)
  const [me, setMe] = useState<string>('')
  const [failed, setFailed] = useState(false)
  const picked = useSyncExternalStore(subscribeCentralMachine, getCentralMachine, centralMachineServerSnapshot)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const [mRes, aRes] = await Promise.all([
          fetch('/api/iam/me'),
          fetch('/api/iam/machines'),
        ])
        const meBody = mRes.ok ? await mRes.json() as { account?: { id?: string } } : null
        const list = aRes.ok ? await aRes.json() as CentralMachine[] | { machines?: CentralMachine[] } : null
        if (!live) return
        setMe(meBody?.account?.id ?? '')
        setMachines(Array.isArray(list) ? list : (list?.machines ?? []))
      } catch {
        // A failed read is NOT an empty estate — the difference is the whole point of the sentence
        // this page draws below.
        if (live) setFailed(true)
      }
    })()
    return () => { live = false }
  }, [])

  const list = useMemo(
    () => centralMachineList(machines ?? [], me, pt ? 'pt' : 'en'),
    [machines, me, pt],
  )

  // Settled once, when the list first arrives, and then owned by the picker. A remembered machine
  // that has since gone quiet must not leave the workspace pointed at an entry no longer offered.
  useEffect(() => {
    if (machines === null) return
    const next = pickCentralMachine(list, getCentralMachine())
    if (next !== getCentralMachine()) setCentralMachine(next)
  }, [machines, list])

  const choose = (id: string) => setCentralMachine(id)

  if (failed) {
    return (
      <Note text={pt
        ? 'Não deu para ler a lista de máquinas desta central. Isso não quer dizer que não há nenhuma — recarregue a página.'
        : 'This central’s machine list could not be read. That is not the same as there being none — reload the page.'} />
    )
  }
  if (machines === null) {
    return <Note text={pt ? 'Lendo as máquinas desta central…' : 'Reading this central’s machines…'} />
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
      {list.reachable.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {list.reachable.map(m => {
            const on = m.id === picked
            return (
              <button
                key={m.id}
                onClick={() => choose(m.id)}
                aria-pressed={on}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7, minHeight: 40,
                  padding: '7px 12px', borderRadius: 9, cursor: 'pointer', fontFamily: 'inherit',
                  fontSize: 12.5, fontWeight: on ? 700 : 600,
                  border: `1px solid ${on ? 'var(--anthropic-orange)' : 'var(--border)'}`,
                  background: on ? 'color-mix(in srgb, var(--anthropic-orange) 12%, transparent)' : 'transparent',
                  color: on ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
                }}
              >
                <MonitorSmartphone size={13} style={{ flexShrink: 0 }} />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</span>
                {/* Online is a fact about whether it can answer NOW, so it is on the chip rather
                    than discovered by pressing it and waiting. */}
                <span
                  aria-hidden
                  style={{
                    width: 6, height: 6, borderRadius: 3, flexShrink: 0,
                    background: m.online ? 'var(--accent-green)' : 'var(--text-tertiary)',
                    opacity: m.online ? 1 : 0.55,
                  }}
                />
              </button>
            )
          })}
        </div>
      )}

      {/* The ones that cannot be reached, each with the reason — never silently absent. */}
      {list.blocked.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <p style={{
            margin: 0, fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.06em', color: 'var(--text-tertiary)',
          }}>
            {pt ? 'Fora de alcance' : 'Out of reach'}
          </p>
          {list.blocked.map(m => (
            <div key={m.id} style={{
              display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8,
              padding: '8px 10px', borderRadius: 9,
              border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
            }}>
              <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--text-secondary)' }}>{m.name}</span>
              <span style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--text-tertiary)', minWidth: 0 }}>
                {m.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Note({ text }: { text: string }) {
  return (
    <p role="status" style={{
      margin: 0, padding: '14px 4px', fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-tertiary)',
    }}>
      {text}
    </p>
  )
}
