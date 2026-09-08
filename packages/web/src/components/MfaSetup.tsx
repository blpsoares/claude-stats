import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ShieldCheck, ShieldOff, Copy, Check, AlertCircle } from 'lucide-react'
import type { Lang } from '@agentistics/core'
import { qrMatrix } from '../lib/qr'
import { useIsMobile } from '../hooks/useIsMobile'

/**
 * Two-factor enrolment for the signed-in account.
 *
 * The QR is the primary path and the base32 key is the fallback, not the other way round: the
 * screen used to offer the key alone, and transcribing 32 characters by hand is the step people
 * get wrong — producing an "invalid code" indistinguishable from a broken server. `lib/qr.ts`
 * draws it with no dependency, so the compiled binary carries nothing extra.
 *
 * Recovery codes are shown exactly once — the server stores only their sha256 hashes and cannot
 * show them again.
 */
/**
 * Whether the "Disable" action should render at all: only once MFA is actually enabled, AND only
 * for a caller the server will let disable it (`canDisable` mirrors `mfaDisableAllowed` in
 * `iam-view.ts` — an owner is never allowed to turn it off, so the button must never appear for
 * one). Pulled out pure so the condition is testable without a live fetch/state render — the
 * button's absence is exactly as load-bearing as its presence.
 */
export function disableActionVisible(enabled: boolean, canDisable: boolean): boolean {
  return enabled && canDisable
}

export function MfaSetup({ lang, onClose, required = false, canDisable = true }: {
  lang: Lang
  onClose: () => void
  /** Enrolment is owed, not optional: the overlay does not dismiss and there is no way out but
   *  finishing. Used by the App gate for an owner the server is already refusing. */
  required?: boolean
  /** False for an owner: the server refuses DELETE /api/iam/mfa outright for that role
   *  (`mfaDisableAllowed`), so showing the button would just be a promise the route breaks. */
  canDisable?: boolean
}) {
  const pt = lang === 'pt'
  const isMobile = useIsMobile()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [uri, setUri] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const refresh = useCallback(() => {
    fetch('/api/iam/mfa')
      .then(r => (r.ok ? r.json() : { enabled: false }))
      .then((d: { enabled: boolean }) => setEnabled(!!d.enabled))
      .catch(() => setEnabled(false))
  }, [])
  useEffect(refresh, [refresh])

  async function start() {
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/iam/mfa/start', { method: 'POST' })
      const d = (await r.json()) as { secret?: string; otpauthUri?: string }
      if (d.secret) { setSecret(d.secret); setUri(d.otpauthUri ?? null) }
      else setError(pt ? 'Não foi possível iniciar.' : 'Could not start enrolment.')
    } catch { setError(pt ? 'Erro de rede.' : 'Network error.') } finally { setBusy(false) }
  }

  async function enable(e: React.FormEvent) {
    e.preventDefault()
    if (!secret || !code.trim() || busy) return
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/iam/mfa/enable', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, code: code.trim() }),
      })
      const d = (await r.json()) as { ok?: boolean; recoveryCodes?: string[]; error?: string; skewSeconds?: number }
      if (r.ok && d.ok && d.recoveryCodes) {
        setRecovery(d.recoveryCodes)
        setSecret(null); setCode(''); setEnabled(true)
      } else {
        setError(describeCodeError(d, pt))
      }
    } catch { setError(pt ? 'Erro de rede.' : 'Network error.') } finally { setBusy(false) }
  }

  async function regenerate() {
    if (!code.trim() || busy) return
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/iam/mfa/recovery-codes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      })
      const d = (await r.json()) as { ok?: boolean; recoveryCodes?: string[]; error?: string; skewSeconds?: number }
      if (r.ok && d.ok && d.recoveryCodes) { setRecovery(d.recoveryCodes); setCode('') }
      else setError(describeCodeError(d, pt))
    } catch { setError(pt ? 'Erro de rede.' : 'Network error.') } finally { setBusy(false) }
  }

  async function disable() {
    if (!code.trim() || busy) return
    setBusy(true); setError(null)
    try {
      const r = await fetch('/api/iam/mfa', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      })
      if (r.ok) { setEnabled(false); setCode('') }
      else setError(describeCodeError(await r.json().catch(() => ({})), pt))
    } catch { setError(pt ? 'Erro de rede.' : 'Network error.') } finally { setBusy(false) }
  }

  return (
    <div onClick={required ? undefined : onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <span style={{ display: 'inline-flex', padding: 8, borderRadius: 9, background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)' }}>
            {enabled ? <ShieldCheck size={16} /> : <ShieldOff size={16} />}
          </span>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
            {pt ? 'Verificação em duas etapas' : 'Two-factor authentication'}
          </span>
        </div>

        {/* Why this screen is here, on EVERY step of a required enrolment.
            It used to be one sentence on the first step only, so anyone who clicked through to
            the QR was left staring at a mandatory screen with no statement of why it is
            mandatory — and this is the screen that appears immediately after signing up. */}
        {required && (
          <div style={{
            fontSize: 11.5, lineHeight: 1.55, color: 'var(--text-secondary)',
            background: 'var(--anthropic-orange-dim)', border: '1px solid var(--anthropic-orange)44',
            borderRadius: 8, padding: '9px 11px', margin: '8px 0 12px',
          }}>
            {pt
              ? <>Obrigatório para contas <b>owner</b>. Um owner alcança os dados de todos os times e todas as rotas de administração — uma senha sozinha seria o único obstáculo. É também o que permite <b>você mesmo recuperar sua conta</b> se esquecer a senha, sem precisar de acesso à máquina.</>
              : <>Required for <b>owner</b> accounts. An owner reaches every team's data and every admin route, so a password alone would be the only thing in the way. It is also what lets <b>you recover your own account</b> if you forget the password, without needing access to the machine.</>}
          </div>
        )}

        {recovery && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
              {pt
                ? 'Guarde estes códigos de recuperação agora. Cada um serve uma única vez e eles não serão mostrados de novo.'
                : 'Save these recovery codes now. Each works once and they will not be shown again.'}
            </div>
            <pre style={codeBlock}>{recovery.join('\n')}</pre>
            <button onClick={onClose} style={primaryBtn}>{pt ? 'Guardei' : 'I saved them'}</button>
          </div>
        )}

        {!recovery && enabled === true && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
              {canDisable
                ? (pt ? 'Ativa nesta conta. Para desativar, confirme com um código atual.' : 'Active on this account. To turn it off, confirm with a current code.')
                : (pt
                  ? 'Ativa nesta conta e obrigatória — contas owner não podem desativar a verificação em duas etapas. Você ainda pode gerar novos códigos de recuperação com um código atual.'
                  : 'Active on this account and mandatory — owner accounts cannot turn off two-factor authentication. You can still generate new recovery codes with a current code.')}
            </div>
            <input value={code} onChange={e => setCode(e.target.value)} placeholder="123456" style={input}
              inputMode="numeric" autoComplete="one-time-code" />
            {error && <Err text={error} />}
            {/* Codes used to be issued once, at enrolment, and never again — so a mislaid sheet
                quietly removed the only net under a lost phone. Same current code proves both. */}
            <button onClick={regenerate} disabled={!code.trim() || busy} style={primaryBtn}>
              {pt ? 'Gerar novos códigos de recuperação' : 'Generate new recovery codes'}
            </button>
            {/* The route (`mfaDisableAllowed`) is the actual control; this is the button staying
                consistent with it so an owner is never offered an action the server will refuse. */}
            {disableActionVisible(enabled, canDisable) && (
              <>
                <div style={{ height: 8 }} />
                <button onClick={disable} disabled={!code.trim() || busy} style={dangerBtn}>
                  {pt ? 'Desativar' : 'Disable'}
                </button>
              </>
            )}
          </div>
        )}

        {!recovery && enabled === false && !secret && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
              {required
                ? (pt
                  ? 'Contas de owner exigem um segundo fator: elas alcançam os dados de todos os times e todas as rotas de administração. É também o que permite você recuperar a própria conta sozinho, sem acesso à máquina.'
                  : 'Owner accounts require a second factor: they reach every team’s data and every admin route. It is also what lets you recover this account yourself, without access to the machine.')
                : (pt
                  ? 'Uma senha sozinha é um único ponto de falha numa instância exposta na internet. Ative um segundo fator.'
                  : 'A password alone is a single point of failure on an internet-exposed instance. Add a second factor.')}
            </div>
            {error && <Err text={error} />}
            <button onClick={start} disabled={busy} style={primaryBtn}>{pt ? 'Começar' : 'Start'}</button>
          </div>
        )}

        {!recovery && secret && (
          <form onSubmit={enable} style={{ marginTop: 10 }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
              {pt ? 'Escaneie o código com seu app autenticador e confirme o código de 6 dígitos que ele mostrar.' : 'Scan this with your authenticator app, then confirm the 6-digit code it shows.'}
            </div>

            <Qr uri={uri ?? secret} />

            <details style={{ marginBottom: 10 }}>
              <summary style={{ ...summary, ...(isMobile ? { minHeight: 44, display: 'flex', alignItems: 'center' } : null) }}>{pt ? 'Não consigo escanear' : "Can't scan it"}</summary>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', margin: '8px 0 6px' }}>
                {pt ? 'Digite esta chave no app (opção "inserir chave manualmente"):' : 'Type this key into the app ("enter key manually"):'}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <code style={{ ...codeBlock, flex: 1, margin: 0 }}>{secret.match(/.{1,4}/g)?.join(' ')}</code>
                <button type="button" onClick={() => { void navigator.clipboard?.writeText(secret); setCopied(true); setTimeout(() => setCopied(false), 1500) }}
                  title={pt ? 'Copiar a chave' : 'Copy the key'} className="ag-tap-icon" style={iconBtn}>
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </details>

            <input value={code} onChange={e => setCode(e.target.value)} placeholder="123456" style={input} autoFocus
              inputMode="numeric" autoComplete="one-time-code" />
            {error && <Err text={error} />}
            <button type="submit" disabled={!code.trim() || busy} style={primaryBtn}>{pt ? 'Ativar' : 'Enable'}</button>
          </form>
        )}
      </div>
    </div>
  )
}

/**
 * The QR itself. Always dark-on-WHITE regardless of the dashboard theme — a scanner needs the
 * contrast, and an inverted symbol is not reliably readable.
 */
function Qr({ uri }: { uri: string }) {
  const path = useMemo(() => {
    let d = ''
    try {
      const m = qrMatrix(uri)
      for (let r = 0; r < m.length; r++) {
        for (let c = 0; c < m.length; c++) if (m[r]![c]) d += `M${c + 4} ${r + 4}h1v1h-1z`
      }
      return { d, size: m.length + 8 }
    } catch { return null }
  }, [uri])

  if (!path) return null
  return (
    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
      <svg viewBox={`0 0 ${path.size} ${path.size}`} shapeRendering="crispEdges" role="img" aria-label="QR"
        style={{ width: '100%', maxWidth: 208, height: 'auto', background: '#fff', borderRadius: 10 }}>
        <path d={path.d} fill="#000" />
      </svg>
    </div>
  )
}

/** Turn the server's refusal into the sentence that names the actual problem. */
function describeCodeError(d: { error?: string; skewSeconds?: number }, pt: boolean): string {
  if (d.error === 'clock_skew' && typeof d.skewSeconds === 'number') {
    const behind = d.skewSeconds > 0 // the code belongs to a LATER step → the server trails
    const mins = Math.max(1, Math.round(Math.abs(d.skewSeconds) / 60))
    return pt
      ? `O código está certo, mas os relógios não batem: o servidor está ~${mins} min ${behind ? 'atrasado' : 'adiantado'} em relação ao seu aparelho. Sincronize o relógio do servidor e tente de novo.`
      : `The code is right, but the clocks disagree: the server is ~${mins} min ${behind ? 'behind' : 'ahead of'} your device. Fix the server clock and try again.`
  }
  return pt ? 'Código inválido.' : 'Invalid code.'
}

function Err({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#ef4444', margin: '8px 0' }}>
      <AlertCircle size={13} /> {text}
    </div>
  )
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex',
  alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16,
}
const card: React.CSSProperties = {
  width: '100%', maxWidth: 380, background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg)', padding: 22,
}
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 11px', background: 'var(--bg-elevated)',
  border: '1px solid var(--border)', borderRadius: 8, fontSize: 16, color: 'var(--text-primary)',
  outline: 'none', fontFamily: 'inherit', marginBottom: 10, letterSpacing: '0.15em',
}
const codeBlock: React.CSSProperties = {
  background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 8,
  padding: '10px 12px', fontSize: 13, color: 'var(--text-primary)', overflowX: 'auto',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', marginBottom: 12,
}
const primaryBtn: React.CSSProperties = {
  width: '100%', padding: '9px 14px', borderRadius: 8, border: '1px solid var(--anthropic-orange)',
  background: 'var(--anthropic-orange-dim)', color: 'var(--anthropic-orange)', fontSize: 13,
  fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
}
const summary: React.CSSProperties = {
  fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer', padding: '6px 0',
}
const dangerBtn: React.CSSProperties ={ ...primaryBtn, borderColor: '#ef4444', background: 'transparent', color: '#ef4444' }
// A module object cannot read `useIsMobile()`, so the 44 it used to carry was a DESKTOP 44 as
// well — a copy button three times the height of the field beside it. The finger target is
// `.ag-tap-icon`'s invisible box on the consumer.
const iconBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 12px',
  minWidth: 32, minHeight: 32, borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--bg-elevated)', color: 'var(--text-secondary)', cursor: 'pointer',
}
