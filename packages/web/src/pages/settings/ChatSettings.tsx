/**
 * Chat settings — the switch that decides whether this machine serves the chat at all, plus (once
 * it is on) the notification sound and the model it drives.
 *
 * It is off until someone turns it on. Chat spawns an assistant CLI on this host, which is the most
 * powerful thing the server does; before it was opt-in, a machine installed for its metrics also
 * shipped a shell nobody had chosen.
 *
 * The switch can only NARROW what the exposure profile already permits (`chat-gate.ts`). When the
 * profile has revoked `localChat` the row says so and stays disabled — offering a toggle that the
 * server would refuse is the affordance this whole capability model exists to remove.
 *
 * The sound and model rows live in THIS section (not Preferences) because they are chat's own
 * settings — but they render only while `enabled === true`. The section itself stays visible
 * whenever the profile allows chat at all, on or off: it holds the enable switch, and hiding the
 * whole section the moment chat is off would make that switch unreachable — a one-way door with no
 * way back. `chatEnabled` gates these ROWS; `capabilities.localChat` (in `settingsSections.ts`)
 * gates the SECTION.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { Bot, Volume2, VolumeX, Zap } from 'lucide-react'
import type { AppContext } from '../../lib/app-context'
import { CHAT_MODELS, DEFAULT_CHAT_MODEL, type ChatModelId } from '../../lib/chatModels'
import { CHAT_SOUNDS, DEFAULT_CHAT_SOUND_ID, findChatSound } from '../../lib/chatSounds'
import { SectionHeader, Divider, PrefRow, Toggle } from './primitives'

const BADGE_COLORS: Record<string, string> = {
  Fast:     'var(--accent-green)',
  Balanced: 'var(--anthropic-orange)',
  Powerful: 'var(--accent-purple)',
}

export default function ChatSettings() {
  const ctx = useOutletContext<AppContext>()
  const pt = ctx.lang === 'pt'

  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [capable, setCapable] = useState(true)
  const [saving, setSaving] = useState(false)

  const [chatModel, setChatModel] = useState<ChatModelId | null>(null)
  const [chatSoundEnabled, setChatSoundEnabled] = useState(true)
  const [chatSoundId, setChatSoundId] = useState(DEFAULT_CHAT_SOUND_ID)

  const previewCtxRef = useRef<AudioContext | null>(null)
  const previewSound = useCallback((id: string) => {
    if (!previewCtxRef.current) {
      try { previewCtxRef.current = new AudioContext() } catch { return }
    }
    findChatSound(id).play(previewCtxRef.current)
  }, [])

  useEffect(() => {
    void (async () => {
      const [prefs, session] = await Promise.all([
        fetch('/api/preferences')
          .then(r => (r.ok ? r.json() : {}) as Promise<{
            chatEnabled?: boolean
            chatModel?: ChatModelId
            chatSoundEnabled?: boolean
            chatSoundId?: string
          }>)
          .catch(() => ({}) as { chatEnabled?: boolean; chatModel?: ChatModelId; chatSoundEnabled?: boolean; chatSoundId?: string }),
        fetch('/api/team/session')
          .then(r => (r.ok ? r.json() : {}) as Promise<{ capabilities?: { localChat?: boolean } }>)
          .catch(() => ({}) as { capabilities?: { localChat?: boolean } }),
      ])
      setEnabled(prefs.chatEnabled === true)
      setChatModel(prefs.chatModel ?? null)
      setChatSoundEnabled(prefs.chatSoundEnabled ?? true)
      setChatSoundId(prefs.chatSoundId ?? DEFAULT_CHAT_SOUND_ID)
      // Undefined on an older server, which had no capability model — treat as permitted, the same
      // reading the rest of the app uses.
      setCapable(session.capabilities?.localChat !== false)
    })()
  }, [])

  const toggle = useCallback(async () => {
    if (enabled === null || !capable) return
    const next = !enabled
    setSaving(true)
    setEnabled(next)
    try {
      await fetch('/api/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatEnabled: next }),
      })
    } catch {
      setEnabled(!next)  // put the switch back where it was; nothing was saved
    } finally {
      setSaving(false)
    }
  }, [enabled, capable])

  const toggleSound = useCallback(() => {
    const next = !chatSoundEnabled
    setChatSoundEnabled(next)
    ctx.setChatSoundEnabled(next)  // keeps the live chat widget (TtyChat) in sync, no reload needed
    if (next) previewSound(chatSoundId)
    void fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSoundEnabled: next }),
    }).catch(() => {})
  }, [chatSoundEnabled, chatSoundId, previewSound, ctx])

  const selectSound = useCallback((id: string) => {
    setChatSoundId(id)
    ctx.setChatSoundId(id)
    previewSound(id)
    void fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatSoundId: id }),
    }).catch(() => {})
  }, [previewSound, ctx])

  const selectModel = useCallback((id: ChatModelId) => {
    setChatModel(id)
    ctx.setChatModel(id)
    void fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatModel: id }),
    }).catch(() => {})
  }, [ctx])

  return (
    <>
      <SectionHeader label={pt ? 'Chat nesta máquina' : 'Chat on this machine'} />

      <PrefRow
        label={pt ? 'Habilitar o chat' : 'Enable chat'}
        sub={capable
          ? (pt
            ? 'Desligado por padrão. Ligar permite que o painel execute a CLI de um assistente nesta máquina.'
            : 'Off by default. Turning it on lets the dashboard run an assistant CLI on this machine.')
          : (pt
            ? 'Indisponível: o perfil de exposição desta instância não permite executar nada no host.'
            : 'Unavailable: this instance’s exposure profile does not allow running anything on the host.')}
      >
        <Toggle
          on={enabled === true}
          onToggle={() => { void toggle() }}
          disabled={!capable || enabled === null || saving}
        />
      </PrefRow>

      <Divider />

      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6 }}>
        {pt
          ? 'O servidor é quem decide: com o chat desligado, /api/chat-tty e /api/chat-harnesses respondem 403. Esconder o botão não fecharia a porta.'
          : 'The server is what decides: with chat off, /api/chat-tty and /api/chat-harnesses answer 403. Hiding the button would not close the door.'}
      </div>

      {/* Two gates, not one: the switch above is reachable whenever the PROFILE allows chat, on or
          off — this row is what turns it back on. The sound and model only matter once chat is
          actually serving, so they are gated on the user's own switch, not just the profile. */}
      {enabled === true && (
        <>
          <Divider />
          <SectionHeader label={pt ? 'Som e modelo' : 'Sound and model'} />

          <PrefRow
            label={pt ? 'Som de notificação' : 'Notification sound'}
            sub={pt ? 'Toca quando uma resposta chega com o chat minimizado' : 'Plays when a reply arrives while chat is minimized'}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {chatSoundEnabled ? <Volume2 size={14} color="var(--anthropic-orange)" /> : <VolumeX size={14} color="var(--text-tertiary)" />}
              <Toggle on={chatSoundEnabled} onToggle={toggleSound} />
            </div>
          </PrefRow>

          {/* Sound picker — only visible when sound is enabled */}
          {chatSoundEnabled && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {CHAT_SOUNDS.map(s => {
                const active = chatSoundId === s.id
                return (
                  <button
                    key={s.id}
                    onClick={() => selectSound(s.id)}
                    style={{
                      padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: active ? 700 : 500,
                      border: active ? '1.5px solid var(--anthropic-orange)' : '1px solid var(--border)',
                      background: active ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
                      color: active ? 'var(--anthropic-orange)' : 'var(--text-secondary)',
                      cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s',
                    }}
                  >
                    {s.label[pt ? 'pt' : 'en']}
                  </button>
                )
              })}
            </div>
          )}
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 500, marginBottom: 8 }}>
            {pt ? 'Modelo do chat' : 'Chat model'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {CHAT_MODELS.map(m => {
              const active = (chatModel ?? DEFAULT_CHAT_MODEL) === m.id
              const badgeColor = BADGE_COLORS[m.badge] ?? 'var(--text-tertiary)'
              return (
                <button key={m.id} onClick={() => selectModel(m.id)} style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 7,
                  border: active ? '1.5px solid var(--anthropic-orange)' : '1px solid var(--border)',
                  background: active ? 'var(--anthropic-orange-dim)' : 'var(--bg-elevated)',
                  cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s', fontFamily: 'inherit',
                }}>
                  <Bot size={14} color={active ? 'var(--anthropic-orange)' : 'var(--text-tertiary)'} style={{ flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: active ? 'var(--anthropic-orange)' : 'var(--text-primary)' }}>{m.label}</span>
                      <span style={{
                        fontSize: 10, fontWeight: 700, color: badgeColor,
                        background: `color-mix(in srgb, ${badgeColor} 12%, transparent)`,
                        border: `1px solid color-mix(in srgb, ${badgeColor} 30%, transparent)`,
                        padding: '1px 5px', borderRadius: 4,
                      }}>{m.badge}</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 1 }}>{m.desc}</div>
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-tertiary)', textAlign: 'right', flexShrink: 0, lineHeight: 1.6 }}>
                    <div>${m.inputPer1M}</div><div>${m.outputPer1M}</div>
                  </div>
                  {active && <Zap size={12} color="var(--anthropic-orange)" style={{ flexShrink: 0 }} />}
                </button>
              )
            })}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 6 }}>
            {pt ? 'USD por 1M tokens (entrada / saída)' : 'USD per 1M tokens (input / output)'}
          </div>
        </>
      )}
    </>
  )
}
