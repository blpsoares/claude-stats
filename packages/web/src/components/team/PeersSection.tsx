import React, { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { COPY, interpolate } from './copy'
import { peerLabel, type PeerFingerprint } from './proposalNotices'

/**
 * PeersSection — the machines of this account that receive this machine's sharing rules.
 *
 * COLLAPSED BY DEFAULT, deliberately. A fingerprint is a verification tool used once, not standing
 * information: the card states the FACT (how many machines receive your rules) in one row, and the
 * explanation travels WITH the fingerprints, behind the disclosure, where it is actionable.
 *
 * A TABLE, because the task is COMPARISON. This used to be one run-on `Name — 32 hex digits` line
 * per machine with nothing aligned; the only way anyone checks a fingerprint is by scanning two of
 * them column-wise, so the hex sits in its own monospace, `tabular-nums` column. At 390px two such
 * columns cannot sit side by side, so on mobile each machine becomes a stacked block — name, then
 * the fingerprint on its own line, still monospace and still on the same left edge as every other
 * one. It degrades to a scannable list, never to a sideways-scrolling page.
 *
 * NO MACHINE ID IS EVER RENDERED. It is `sha256(token)` — derived from a credential and meaningless
 * to a person — and it appears here only as a React key.
 */
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

function fingerprintStyle(): React.CSSProperties {
  return {
    fontFamily: MONO, fontVariantNumeric: 'tabular-nums', fontSize: 10.5,
    color: 'var(--text-secondary)', letterSpacing: '0.02em', overflowWrap: 'anywhere',
  }
}

export function PeersSection({ peers, selfFingerprint, lang }: {
  peers: PeerFingerprint[]
  selfFingerprint: string
  lang: 'pt' | 'en'
}) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  if (peers.length === 0) return null

  // This machine first and marked as such — a comparison needs the thing being compared against.
  const rows: { key: string; name: string; fingerprint: string; self: boolean }[] = [
    ...(selfFingerprint ? [{ key: '__self__', name: COPY.peersSelf[lang], fingerprint: selfFingerprint, self: true }] : []),
    ...peers.map(p => ({ key: p.machineId, name: peerLabel(p, lang), fingerprint: p.fingerprint, self: false })),
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <button className="ag-tap"
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
          padding: 0,
          border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
          fontSize: 11.5, color: 'var(--text-secondary)', textAlign: 'left',
        }}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {interpolate(COPY.peersCount[lang], { n: peers.length })}
        <span style={{ color: 'var(--text-tertiary)' }}>· {COPY.peersShow[lang]}</span>
      </button>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: isMobile ? 0 : 19, minWidth: 0 }}>
          <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>{COPY.peersBody[lang]}</span>

          {isMobile ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rows.map(r => (
                <div key={r.key} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span style={{
                    fontSize: 11, fontWeight: r.self ? 700 : 600,
                    color: r.self ? 'var(--text-secondary)' : 'var(--text-primary)', overflowWrap: 'anywhere',
                  }}>
                    {r.name}
                  </span>
                  <span style={fingerprintStyle()}>{r.fingerprint}</span>
                </div>
              ))}
            </div>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'auto' }}>
              <thead>
                <tr>
                  <th style={{
                    textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
                    textTransform: 'uppercase', color: 'var(--text-tertiary)', padding: '0 12px 4px 0',
                  }}>
                    {COPY.peersColMachine[lang]}
                  </th>
                  <th style={{
                    textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
                    textTransform: 'uppercase', color: 'var(--text-tertiary)', padding: '0 0 4px 0',
                  }}>
                    {COPY.peersColFingerprint[lang]}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.key} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{
                      padding: '4px 12px 4px 0', fontSize: 11, verticalAlign: 'top',
                      fontWeight: r.self ? 700 : 600,
                      color: r.self ? 'var(--text-secondary)' : 'var(--text-primary)',
                      overflowWrap: 'anywhere',
                    }}>
                      {r.name}
                    </td>
                    <td style={{ padding: '4px 0', verticalAlign: 'top', ...fingerprintStyle() }}>
                      {r.fingerprint}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
