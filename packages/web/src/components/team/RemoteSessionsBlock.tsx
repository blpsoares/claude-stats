/**
 * RemoteSessionsBlock.tsx — the connection card's "let this central manage my sessions" block.
 *
 * TWO SWITCHES, and the split is the point (see `remoteSessions.ts` in `@agentistics/core`). The
 * first grants the fleet and the verbs that carry no screen; the second additionally lets the
 * session's TERMINAL travel, and it is what `approve` and `prompt` would need. They are separate
 * because "let me rename a session from my phone" is not informed consent to "stream my terminal to
 * the central" — the reverse channel had on-demand chat retrieval REMOVED for exactly that reason.
 *
 * Every decision is `remoteSessionsState.ts`; this file draws it.
 */

import { useState } from 'react'
import { Loader2, MonitorSmartphone, ShieldCheck, Terminal } from 'lucide-react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { ToggleSwitch } from '../ToggleSwitch'
import { remotePanelView, consentPatchFor } from './remoteSessionsState'
import type { ConnectionStatusEntry } from './statusTypes'
import { OVERLAY_TOP } from '../../lib/mobileOverlay'

type Lang = 'en' | 'pt'

const COPY = {
  title: { en: 'Sessions from this central', pt: 'Sessões a partir desta central' },
  intro: {
    en: 'Off by default. Only the account that owns this machine can use it — not the central’s owner just for being the owner.',
    pt: 'Desligado por padrão. Só a conta dona desta máquina pode usar — não o dono da central só por ser o dono.',
  },
  sessionsLabel: { en: 'Manage my sessions', pt: 'Gerenciar minhas sessões' },
  sessionsHelp: {
    en: 'The session list, and renaming, notes, tasks, interrupting, killing and reopening. No terminal is sent.',
    pt: 'A lista de sessões, e renomear, notas, tarefas, interromper, encerrar e reabrir. Nenhum terminal é enviado.',
  },
  screensLabel: { en: 'Also send the session screen', pt: 'Enviar também a tela da sessão' },
  screensHelp: {
    en: 'The terminal itself and the permission dialogs. This is what answering a prompt would need — and it is your conversation, so it is asked separately.',
    pt: 'O terminal em si e os diálogos de permissão. É o que responder a um prompt exigiria — e é a sua conversa, então é perguntado à parte.',
  },
  screensLocked: {
    en: 'Available once the switch above is on.',
    pt: 'Disponível quando a chave acima estiver ligada.',
  },
  pending: {
    en: 'This machine is not reaching the central right now, so it has not been told yet. It is announced on the next connection.',
    pt: 'Esta máquina não está alcançando a central agora, então ela ainda não foi avisada. O aviso vai na próxima conexão.',
  },
  // Stated rather than implied. The instance owner can already re-assign this machine's account, so
  // promising more than this would be a promise the product cannot keep.
  limit: {
    en: 'Whoever runs the central administers machines and could re-assign this one. This switch is what stops session access being on without you choosing it.',
    pt: 'Quem opera a central administra máquinas e poderia reatribuir esta. Esta chave é o que impede o acesso às sessões estar ligado sem você ter escolhido.',
  },
  notYet: {
    en: 'The central shows this to you and to nobody else.',
    pt: 'A central mostra isto pra você e pra mais ninguém.',
  },
  // The confirmation. Turning this ON is the moment the guarantee has to be stated, because it is
  // the moment somebody is deciding whether to believe it — and the honest version includes the
  // limit, not only the promise.
  confirmTitle: { en: 'Turn this on?', pt: 'Ligar isto?' },
  confirmScreensTitle: { en: 'Send the session screen too?', pt: 'Enviar também a tela da sessão?' },
  whatShared: { en: 'What travels', pt: 'O que vai' },
  whoSees: { en: 'Who can see it', pt: 'Quem pode ver' },
  sharedSessions: {
    en: 'The session list — titles, folders, notes, tasks and state — and the verbs that need no screen. The terminal and the conversation stay on this machine.',
    pt: 'A lista de sessões — títulos, pastas, notas, tarefas e estado — e os verbos que não precisam da tela. O terminal e a conversa ficam nesta máquina.',
  },
  sharedScreens: {
    en: 'The session’s terminal and the permission dialogs it is blocked on. This is the assistant’s and your own words, so it is asked separately.',
    pt: 'O terminal da sessão e os diálogos de permissão em que ela está travada. São as palavras do assistente e as suas, por isso é perguntado à parte.',
  },
  whoBody: {
    en: 'Only accounts that own this machine. Signing in to the central is not enough — someone who merely administers it is refused, and sees nothing about your sessions.',
    pt: 'Só contas donas desta máquina. Estar logado na central não basta — quem apenas a administra é recusado e não vê nada das suas sessões.',
  },
  // Stated in the same breath as the promise. A guarantee that hides its own limit is the kind
  // people stop believing the first time they find the gap themselves.
  limitBody: {
    en: 'Whoever runs the central administers machines and could re-assign this one to another account. This switch is what stops the access being on without you choosing it — it is not a lock against the operator.',
    pt: 'Quem opera a central administra máquinas e poderia reatribuir esta a outra conta. Esta chave impede o acesso estar ligado sem você escolher — ela não é uma tranca contra o operador.',
  },
  offAnyTime: {
    en: 'You can turn it off at any time, and it takes effect at once.',
    pt: 'Você pode desligar a qualquer momento, e vale na hora.',
  },
  cancel: { en: 'Cancel', pt: 'Cancelar' },
  confirm: { en: 'Turn on', pt: 'Ligar' },
} as const

export interface RemoteSessionsBlockProps {
  connId: string
  status: ConnectionStatusEntry | undefined
  lang: Lang
  /** Disabled for the same reasons the card's other writes are — a rules apply in flight, a
   *  disconnect running. A switch that writes during one of those races the server's own sequence. */
  disabled?: boolean
  onPatch: (connId: string, body: { allowRemoteSessions: boolean; allowRemoteScreens: boolean }) => Promise<void>
}

export function RemoteSessionsBlock({ connId, status, lang, disabled = false, onPatch }: RemoteSessionsBlockProps) {
  const isMobile = useIsMobile()
  const [busy, setBusy] = useState<'sessions' | 'screens' | null>(null)
  /** Which switch is waiting on its confirmation, or null. */
  const [confirming, setConfirming] = useState<'sessions' | 'screens' | null>(null)
  const view = remotePanelView(status)

  async function apply(which: 'sessions' | 'screens') {
    if (busy || disabled) return
    setBusy(which)
    try {
      await onPatch(connId, consentPatchFor(view, which))
    } finally {
      setBusy(null)
    }
  }

  /**
   * Turning ON asks first; turning OFF does not.
   *
   * The asymmetry is the point. Granting access to a machine is the decision worth stating in full
   * — and a confirmation is the only moment the reader is actually deciding whether to believe the
   * guarantee, so that is where it belongs rather than in small print nobody reads while the switch
   * is already flipped. Withdrawing is the safe direction, and a dialog in front of it would put a
   * speed bump on the one action somebody might be in a hurry to take.
   */
  function toggle(which: 'sessions' | 'screens') {
    if (busy || disabled) return
    const turningOn = which === 'sessions' ? view.level === 'off' : view.level !== 'screens'
    if (turningOn) { setConfirming(which); return }
    void apply(which)
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 10,
      padding: '12px 14px', borderRadius: 8,
      border: '1px solid var(--border)', background: 'var(--bg-secondary)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <MonitorSmartphone size={14} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
        <strong style={{ fontSize: 12.5 }}>{COPY.title[lang]}</strong>
      </div>
      <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
        {COPY.intro[lang]}
      </p>

      <SwitchRow
        icon={<MonitorSmartphone size={13} />}
        label={COPY.sessionsLabel[lang]}
        help={COPY.sessionsHelp[lang]}
        on={view.level !== 'off'}
        busy={busy === 'sessions'}
        disabled={disabled || busy !== null}
        isMobile={isMobile}
        onToggle={() => { void toggle('sessions') }}
      />

      <SwitchRow
        icon={<Terminal size={13} />}
        label={COPY.screensLabel[lang]}
        help={view.screensAvailable ? COPY.screensHelp[lang] : COPY.screensLocked[lang]}
        on={view.level === 'screens'}
        busy={busy === 'screens'}
        // Not hidden: a control that vanishes says nothing about why. Disabled with its own
        // sentence is the same call `fleet-row.ts` makes for a verb a row cannot take.
        disabled={disabled || busy !== null || !view.screensAvailable}
        isMobile={isMobile}
        onToggle={() => { void toggle('screens') }}
      />

      {view.announcementPending && (
        <div role="status" style={{
          padding: '8px 10px', borderRadius: 7, fontSize: 11, lineHeight: 1.5,
          color: 'var(--anthropic-orange)',
          background: 'color-mix(in srgb, var(--anthropic-orange) 10%, transparent)',
        }}>
          {COPY.pending[lang]}
        </div>
      )}

      <p style={{ margin: 0, fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
        {COPY.notYet[lang]}
      </p>
      <p style={{ margin: 0, fontSize: 10.5, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
        {COPY.limit[lang]}
      </p>

      {confirming && (
        <ConfirmShare
          which={confirming}
          lang={lang}
          isMobile={isMobile}
          machineName={status?.machineName}
          account={status?.user}
          onCancel={() => setConfirming(null)}
          onConfirm={() => { const w = confirming; setConfirming(null); void apply(w) }}
        />
      )}
    </div>
  )
}

/**
 * The confirmation shown when a switch is turned ON.
 *
 * It answers the two questions somebody actually has at that moment — WHAT leaves this machine and
 * WHO can see it — and then states the limit, in that order. The limit is not buried: a guarantee
 * that hides its own edge is the kind people stop believing the first time they find the edge
 * themselves, and this one has a real edge (whoever runs the central can re-assign the machine).
 *
 * It names the ACCOUNT and the MACHINE when the connection knows them, because "only accounts that
 * own this machine" is an abstraction and "Carol · carol-laptop" is a fact the reader can check.
 */
function ConfirmShare({ which, lang, isMobile, machineName, account, onCancel, onConfirm }: {
  which: 'sessions' | 'screens'
  lang: Lang
  isMobile: boolean
  machineName?: string
  account?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const pt = lang === 'pt'
  const who = [account, machineName].filter(Boolean).join(' · ')
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.55)', padding: isMobile ? OVERLAY_TOP : 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: isMobile ? '100%' : 470, maxWidth: '100%',
          height: isMobile ? '100%' : 'auto',
          display: 'flex', flexDirection: 'column', gap: 14,
          justifyContent: isMobile ? 'center' : undefined,
          padding: 20, borderRadius: isMobile ? 0 : 10,
          background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShieldCheck size={16} style={{ color: 'var(--anthropic-orange)', flexShrink: 0 }} />
          <strong style={{ fontSize: 14 }}>
            {which === 'screens' ? COPY.confirmScreensTitle[lang] : COPY.confirmTitle[lang]}
          </strong>
        </div>

        <Field label={COPY.whatShared[lang]}>
          {which === 'screens' ? COPY.sharedScreens[lang] : COPY.sharedSessions[lang]}
        </Field>

        <Field label={COPY.whoSees[lang]}>
          {who ? `${who} — ${COPY.whoBody[lang]}` : COPY.whoBody[lang]}
        </Field>

        <p style={{ margin: 0, fontSize: 11, lineHeight: 1.55, color: 'var(--text-tertiary)' }}>
          {COPY.limitBody[lang]}
        </p>
        <p style={{ margin: 0, fontSize: 11, lineHeight: 1.55, color: 'var(--text-tertiary)' }}>
          {COPY.offAnyTime[lang]}
        </p>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              minHeight: isMobile ? 44 : 32, padding: '0 14px', borderRadius: 7,
              border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--text-secondary)', fontFamily: 'inherit', fontSize: 12.5, cursor: 'pointer',
            }}
          >
            {COPY.cancel[lang]}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            style={{
              minHeight: isMobile ? 44 : 32, padding: '0 16px', borderRadius: 7,
              border: '1px solid var(--anthropic-orange)', background: 'var(--anthropic-orange)',
              color: '#fff', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
            }}
          >
            {COPY.confirm[lang]}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.06em', color: 'var(--text-tertiary)',
      }}>
        {label}
      </span>
      <span style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>
        {children}
      </span>
    </div>
  )
}

function SwitchRow({ icon, label, help, on, busy, disabled, isMobile, onToggle }: {
  icon: React.ReactNode
  label: string
  help: string
  on: boolean
  busy: boolean
  disabled: boolean
  isMobile: boolean
  onToggle: () => void
}) {
  return (
    // The BLOCK turns green when the switch is on; the switch itself stays orange. The accent says
    // "this control is engaged" and the green says "this is granted" — two different facts, and
    // one colour doing both jobs would say neither clearly.
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%',
      minHeight: isMobile ? 44 : 34,
      padding: isMobile ? '10px 12px' : '8px 10px',
      borderRadius: 7,
      border: `1px solid ${on ? 'var(--accent-green)' : 'var(--border)'}`,
      background: on ? 'color-mix(in srgb, var(--accent-green) 10%, transparent)' : 'transparent',
      color: 'var(--text-primary)',
      opacity: disabled ? 0.55 : 1,
    }}>
      <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0, marginTop: 1, color: on ? 'var(--accent-green)' : 'var(--text-secondary)' }}>
        {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : icon}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
        <span style={{ fontSize: 10.5, lineHeight: 1.45, color: 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
          {help}
        </span>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', alignSelf: 'center', gap: 8, flexShrink: 0 }}>
        <ToggleSwitch
          on={on}
          disabled={disabled}
          label={label}
          onToggle={onToggle}
          {...(isMobile ? { tap: 44 } : {})}
        />
      </span>
    </div>
  )
}

/** The state in a WORD as well as in colour — a row whose only signal is a green tint is a row
 *  nobody colour-blind can read, and this one grants access to a machine. */
function Pill({ on }: { on: boolean }) {
  return (
    <span style={{
      flexShrink: 0, alignSelf: 'center',
      padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700,
      border: `1px solid ${on ? 'var(--accent-green)' : 'var(--border)'}`,
      color: on ? 'var(--accent-green)' : 'var(--text-secondary)',
    }}>
      {on ? 'ON' : 'OFF'}
    </span>
  )
}
