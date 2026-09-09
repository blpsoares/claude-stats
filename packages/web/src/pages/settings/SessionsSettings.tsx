import React, { useState, useEffect } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Check, HardDrive, FolderClock, ExternalLink, DatabaseZap } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import type { ArchiveMode } from '../../components/ArchiveConsentModal'
import { Divider, PrefRow, SectionHeader, Toggle } from './primitives'

const ARCHIVE_DOCS_URL = 'https://code.claude.com/docs/en/settings'

export default function SessionsSettings() {
  const ctx = useOutletContext<AppContext>()
  const pt = ctx.lang === 'pt'
  const [mode, setMode] = useState<ArchiveMode | null>(null)
  const [saving, setSaving] = useState<ArchiveMode | null>(null)
  const [savedAt, setSavedAt] = useState<number>(0)

  // The utility shell's own switch. `shellEnabled` is null until the preferences answer — a toggle
  // rendered from a guess would flick to its real position a moment later.
  const [shellEnabled, setShellEnabled] = useState<boolean | null>(null)
  const [shellSaving, setShellSaving] = useState(false)
  // The PROFILE's answer, which the switch may only ever narrow. Undefined on an older server that
  // had no capability model — read as permitted, the same reading the rest of the app uses.
  const shellCapable = ctx.capabilities?.localShell !== false

  useEffect(() => {
    fetch('/api/preferences')
      .then(r => (r.ok ? r.json() : null))
      .then((p: { archiveMode?: ArchiveMode; archiveSessions?: boolean; shellEnabled?: boolean } | null) => {
        const m: ArchiveMode =
          p?.archiveMode ?? (p?.archiveSessions === true ? 'full' : p?.archiveSessions === false ? 'off' : 'off')
        setMode(m)
        // ABSENT READS AS OFF. Nobody acquires a browser shell by having upgraded.
        setShellEnabled(p?.shellEnabled === true)
      })
      .catch(() => { setMode('off'); setShellEnabled(false) })
  }, [])

  const toggleShell = () => {
    if (shellEnabled === null || !shellCapable || shellSaving) return
    const next = !shellEnabled
    setShellSaving(true)
    setShellEnabled(next)
    fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shellEnabled: next }),
    })
      .then(r => { if (!r.ok) throw new Error('save failed') })
      .catch(() => setShellEnabled(!next))  // put the switch back; nothing was saved
      .finally(() => setShellSaving(false))
  }

  const choose = (m: ArchiveMode) => {
    if (m === mode || saving) return
    const prev = mode
    setMode(m)
    setSaving(m)
    fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archiveMode: m }),
    })
      .then(r => { if (!r.ok) throw new Error('save failed'); setSavedAt(Date.now()) })
      .catch(() => setMode(prev))
      .finally(() => setSaving(null))
  }

  const OPTIONS: { id: ArchiveMode; icon: React.ReactNode; title: string; desc: string; tag?: string }[] = [
    {
      id: 'consolidate',
      icon: <DatabaseZap size={18} />,
      title: pt ? 'Consolidar métricas' : 'Consolidate metrics',
      desc: pt
        ? 'Guarda as métricas calculadas de cada sessão (~KB). Preserva todos os números + agent metrics para sempre, sem duplicar arquivos.'
        : 'Stores each session’s computed metrics (~KB). Preserves all numbers + agent metrics forever, without duplicating files.',
      tag: pt ? 'Recomendado' : 'Recommended',
    },
    {
      id: 'full',
      icon: <HardDrive size={18} />,
      title: pt ? 'Cópia fiel completa' : 'Full faithful copy',
      desc: pt
        ? 'Espelha os transcripts crus também, para reler conversas antigas. Usa muito mais disco e cresce com o tempo.'
        : 'Also mirrors the raw transcripts so you can re-read old conversations. Uses much more disk and grows over time.',
    },
    {
      id: 'off',
      icon: <FolderClock size={18} />,
      title: pt ? 'Pasta padrão do Claude' : 'Claude’s default folder',
      desc: pt
        ? 'Não preserva nada. Sessões com mais de 30 dias continuam sumindo.'
        : 'Preserves nothing. Sessions older than 30 days keep disappearing.',
    },
  ]

  return (
    <div>
      {/* THE SHELL SWITCH. It is off until somebody turns it on, and that is the whole security
          model this feature ships with: a raw PTY on the host is strictly more powerful than the
          chat — which `chat-gate.ts` already calls the most powerful thing this server does, and
          the chat at least runs a NAMED assistant CLI. So absent reads as OFF, it may only ever
          NARROW what the exposure profile already permits, and the server enforces both before the
          routes rather than only here. Hiding a button would not close a door. */}
      <SectionHeader label={pt ? 'Terminal nesta máquina' : 'Terminal on this machine'} />

      <PrefRow
        label={pt ? 'Habilitar o shell por sessão' : 'Enable the per-session shell'}
        sub={shellCapable
          ? (pt
            ? 'Desligado por padrão. Ligar permite abrir um shell de verdade na pasta de uma sessão, direto no painel.'
            : 'Off by default. Turning it on lets you open a real shell in a session’s own folder, from the dashboard.')
          : (pt
            ? 'Indisponível: o perfil de exposição desta instância não permite executar nada no host — o interruptor só pode restringir, nunca reabrir.'
            : 'Unavailable: this instance’s exposure profile does not allow running anything on the host — the switch can only narrow, never re-open.')}
      >
        <Toggle
          on={shellEnabled === true}
          onToggle={toggleShell}
          disabled={!shellCapable || shellEnabled === null || shellSaving}
        />
      </PrefRow>

      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
        {/* The sentence that distinguishes "your profile allows this, you have it off" from "your
            profile denies it" — the two are one disabled toggle apart and mean different things. */}
        {!shellCapable
          ? (pt
            ? 'O perfil desta instância já nega o shell; nada aqui pode reabri-lo.'
            : 'This instance’s profile already denies the shell; nothing here can re-open it.')
          : shellEnabled
            ? (pt
              ? 'Seu perfil permite e você está com isso LIGADO. Cada sessão ganha uma faixa "Shell" abaixo do compositor; no máximo 8 terminais abertos ao mesmo tempo.'
              : 'Your profile allows this and you have it ON. Each session gets a "Shell" band below the composer; at most 8 terminals open at once.')
            : (pt
              ? 'Seu perfil permite isso, e você está com isso DESLIGADO. Com o shell desligado, /api/shell/* responde 403 — o servidor é quem decide.'
              : 'Your profile allows this, and you have it OFF. With the shell off, /api/shell/* answers 403 — the server is what decides.')}
      </div>

      <Divider />

      <SectionHeader label={pt ? 'Preservação de histórico' : 'History preservation'} />
      <p style={{ fontSize: 12.5, color: 'var(--text-tertiary)', lineHeight: 1.55, margin: '0 0 14px' }}>
        {pt
          ? 'O Claude Code apaga transcripts com mais de 30 dias a cada inicialização. Escolha como o Agentistics preserva seu histórico (tudo fica local em ~/.agentistics).'
          : 'Claude Code deletes transcripts older than 30 days on every startup. Choose how Agentistics preserves your history (everything stays local in ~/.agentistics).'}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {OPTIONS.map(opt => {
          const active = mode === opt.id
          return (
            <button
              key={opt.id}
              onClick={() => choose(opt.id)}
              disabled={saving !== null}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 11, textAlign: 'left',
                padding: '13px 15px', borderRadius: 'var(--radius-lg)',
                border: active ? '1.5px solid var(--anthropic-orange)' : '1px solid var(--border)',
                background: active ? 'var(--anthropic-orange-dim)' : 'var(--bg-card)',
                cursor: saving !== null ? 'default' : 'pointer',
                fontFamily: 'inherit',
                transition: 'border-color 0.15s, background 0.15s',
              }}
            >
              <span style={{ color: active ? 'var(--anthropic-orange)' : 'var(--text-tertiary)', flexShrink: 0, marginTop: 1 }}>
                {opt.icon}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-primary)' }}>{opt.title}</span>
                  {opt.tag && (
                    <span style={{
                      fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase',
                      color: 'var(--accent-green)', border: '1px solid var(--accent-green)',
                      padding: '1px 6px', borderRadius: 10,
                    }}>{opt.tag}</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.5 }}>{opt.desc}</div>
              </div>
              {active && <Check size={16} style={{ color: 'var(--anthropic-orange)', flexShrink: 0, marginTop: 2 }} />}
            </button>
          )
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
        <a
          href={ARCHIVE_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--anthropic-orange)', textDecoration: 'none' }}
        >
          <ExternalLink size={13} />
          {pt ? 'Documentação oficial' : 'Official documentation'}
        </a>
        {savedAt > 0 && saving === null && (
          <span style={{ fontSize: 11.5, color: 'var(--accent-green)' }}>{pt ? 'Salvo' : 'Saved'}</span>
        )}
      </div>
    </div>
  )
}
