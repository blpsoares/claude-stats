import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Users, Plus, Trash2, Copy, CheckCheck, RefreshCw, AlertCircle, Pencil, Check, X, RotateCw } from 'lucide-react'
import type { MemberPresence } from '@agentistics/core'
import { copyText } from '../lib/clipboard'
import { subscribeEvent } from '../lib/eventStream'
import { useIsMobile } from '../hooks/useIsMobile'

/** Shared 5-column grid for the desktop members table (status · user · label · last-seen · actions).
 *  minmax(0,…) lets the flexible columns actually shrink so long values ellipsize instead of
 *  forcing overflow — the root cause of the cramped desktop layout. */
const GRID_COLS = 'auto minmax(0, 1.5fr) minmax(0, 1fr) auto auto'

/** Small uppercase field label prefixed to each value on the mobile stacked-card layout,
 *  standing in for the (hidden) table header. */
const mobileFieldLabel: React.CSSProperties = {
  fontSize: 9.5, fontWeight: 700, color: 'var(--text-tertiary)',
  letterSpacing: '0.06em', textTransform: 'uppercase', flexShrink: 0,
}

// Types

export interface TeamMember {
  id: string
  user: string
  label: string
  createdAt: string
  lastSeenAt: string | null
  online?: boolean
  latencyMs?: number | null
}

// i18n

const COPY = {
  title:           { en: 'Members (central admin)',               pt: 'Membros (admin central)' },
  sub:             { en: 'Manage API tokens for team members.',   pt: 'Gerencie tokens de acesso para membros da equipe.' },
  user:            { en: 'User',                                  pt: 'Usuário' },
  label:           { en: 'Label',                                 pt: 'Rótulo' },
  status:          { en: 'Status',                                pt: 'Status' },
  online:          { en: 'Online',                                pt: 'Online' },
  offline:         { en: 'Offline',                               pt: 'Offline' },
  lastSeen:        { en: 'Last seen',                             pt: 'Último acesso' },
  never:           { en: 'Never',                                 pt: 'Nunca' },
  includeOfflineTitle: { en: 'Show offline members’ data',   pt: 'Mostrar dados de membros offline' },
  includeOfflineDesc:  { en: 'When off, offline members show only their name + status and are excluded from the totals by default.', pt: 'Quando desligado, membros offline mostram só o nome + status e ficam fora dos totais por padrão.' },
  revoke:          { en: 'Revoke',                                pt: 'Revogar' },
  revoking:        { en: 'Revoking…',                            pt: 'Revogando…' },
  noMembers:       { en: 'No tokens minted yet.',                 pt: 'Nenhum token criado ainda.' },
  mintTitle:       { en: 'Mint new token',                        pt: 'Criar novo token' },
  userLabel:       { en: 'User / email',                         pt: 'Usuário / e-mail' },
  userPlaceholder: { en: 'alice@example.com',                    pt: 'alice@exemplo.com' },
  labelLabel:      { en: 'Label',                                 pt: 'Rótulo' },
  labelPlaceholder:{ en: 'Alice\'s laptop',                      pt: 'Notebook da Alice' },
  mint:            { en: 'Mint token',                           pt: 'Criar token' },
  minting:         { en: 'Creating…',                            pt: 'Criando…' },
  tokenNote:       { en: 'Save this token — it will never be shown again.',  pt: 'Salve este token — ele não será exibido novamente.' },
  copyToken:       { en: 'Copy token',                           pt: 'Copiar token' },
  copied:          { en: 'Copied!',                              pt: 'Copiado!' },
  loadErr:         { en: 'Failed to load members.',              pt: 'Falha ao carregar membros.' },
  mintErr:         { en: 'Failed to create token.',              pt: 'Falha ao criar token.' },
  revokeErr:       { en: 'Failed to revoke token.',              pt: 'Falha ao revogar token.' },
  refresh:         { en: 'Refresh',                              pt: 'Atualizar' },
  rename:          { en: 'Rename',                               pt: 'Renomear' },
  renaming:        { en: 'Saving…',                             pt: 'Salvando…' },
  renameCancel:    { en: 'Cancel',                               pt: 'Cancelar' },
  renameSave:      { en: 'Save',                                 pt: 'Salvar' },
  renameErr:       { en: 'Failed to rename member.',            pt: 'Falha ao renomear membro.' },
  rotate:          { en: 'Rotate',                               pt: 'Rotacionar' },
  rotating:        { en: 'Rotating…',                           pt: 'Rotacionando…' },
  rotateErr:       { en: 'Failed to rotate token.',             pt: 'Falha ao rotacionar token.' },
  cancel:          { en: 'Cancel',                               pt: 'Cancelar' },
  confirm:         { en: 'Confirm',                              pt: 'Confirmar' },
  revokeConfirmTitle: { en: 'Remove this machine?',              pt: 'Remover esta máquina?' },
  revokeConfirmBody:  { en: 'This revokes the token and deletes ALL of this machine\'s data on the central. The machine will be disconnected.', pt: 'Isso revoga o token e apaga TODOS os dados dessa máquina na central. A máquina será desconectada.' },
  rotateConfirmTitle: { en: 'Rotate token?',                     pt: 'Rotacionar token?' },
  // Says what a rotation does AND what it costs. "History is preserved" alone was true of the
  // sessions and silently false of the machine's identity: memberId is derived from the token, so
  // to the account's other machines the rotated machine is a machine they have never seen — they
  // pin its key on first sight and announce it, by design. Any sealed message still waiting for
  // the old identity cannot be re-addressed (the recipient is inside the seal) and is dropped.
  rotateConfirmBody:  { en: 'This machine\'s current token stops working; it will need the new token. History is preserved — sessions, stats, workflows and tags move with it. Its identity here is derived from the token, so the account\'s other machines will see it as a new machine and announce it; any sealed message still waiting for it is lost.', pt: 'O token atual desta máquina para de funcionar; ela precisará do novo token. O histórico é preservado — sessões, estatísticas, workflows e tags acompanham a máquina. A identidade dela aqui vem do token, então as outras máquinas da conta a verão como uma máquina nova e a anunciarão; qualquer mensagem selada ainda à espera dela é perdida.' },
} satisfies Record<string, { en: string; pt: string }>

function t(key: keyof typeof COPY, lang: 'en' | 'pt'): string {
  return COPY[key][lang]
}

// Helpers

function relativeTime(isoStr: string, lang: 'en' | 'pt'): string {
  const diff = Date.now() - new Date(isoStr).getTime()
  const secs = Math.floor(diff / 1000)
  const mins  = Math.floor(secs / 60)
  const hours = Math.floor(mins / 60)
  const days  = Math.floor(hours / 24)

  if (lang === 'pt') {
    if (days > 0)  return `${days}d atrás`
    if (hours > 0) return `${hours}h atrás`
    if (mins > 0)  return `${mins}min atrás`
    return 'agora'
  }
  if (days > 0)  return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (mins > 0)  return `${mins}m ago`
  return 'just now'
}

// Main component

interface Props {
  lang: 'en' | 'pt'
  /** Shared presence from the dashboard's /api/data (SSE-refreshed), keyed by member user.
   *  When present it overrides this component's own /api/team/members online/latency so the
   *  members panel and the FiltersBar presence pill can never diverge. */
  presence?: Record<string, MemberPresence>
}

export function TeamMembers({ lang, presence }: Props) {
  const isMobile = useIsMobile()
  const [members, setMembers] = useState<TeamMember[]>([])
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState<string | null>(null)

  // Central policy: include offline members' data (loaded from /api/team/config)
  const [includeOffline, setIncludeOffline] = useState<boolean | null>(null)
  const [savingOffline, setSavingOffline] = useState(false)

  // Mint form state
  const [mintUser, setMintUser] = useState('')
  const [mintLabel, setMintLabel] = useState('')
  const [minting, setMinting] = useState(false)
  const [mintErr, setMintErr] = useState<string | null>(null)
  const [newToken, setNewToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Per-row revoke state (id → true when revoking)
  const [revoking, setRevoking] = useState<Record<string, boolean>>({})
  const [revokeErr, setRevokeErr] = useState<string | null>(null)
  // Id pending revoke confirmation (modal open when non-null).
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)

  // Per-row rotate state
  const [rotating, setRotating] = useState<Record<string, boolean>>({})
  const [rotateErr, setRotateErr] = useState<string | null>(null)
  // Id pending rotate confirmation (modal open when non-null).
  const [confirmRotateId, setConfirmRotateId] = useState<string | null>(null)

  // Per-row rename state
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)
  const [renameErr, setRenameErr] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  const loadMembers = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    setLoadErr(null)
    try {
      const res = await fetch('/api/team/members')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { members: TeamMember[] }
      setMembers(data.members)
    } catch (err) {
      if (!silent) setLoadErr(err instanceof Error ? err.message : String(err))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => { void loadMembers() }, [loadMembers])

  // Instant refresh on server events (a member connecting/disconnecting fires an
  // immediate SSE 'change'), with a 10s poll as a fallback for latency drift.
  useEffect(() => {
    // Share the one `/api/events` socket (see lib/eventStream.ts) instead of opening a second one;
    // the shared source keeps EventSource's own auto-reconnect, so no onerror handling is needed here.
    const off = subscribeEvent('change', () => { void loadMembers(true) })
    const id = setInterval(() => { void loadMembers(true) }, 10_000)
    return () => { off(); clearInterval(id) }
  }, [loadMembers])

  // Load the central's include-offline-data policy.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/team/config')
        if (!res.ok) return
        const cfg = (await res.json()) as { includeOfflineData?: boolean }
        if (!cancelled) setIncludeOffline(cfg.includeOfflineData ?? true)
      } catch { /* leave null → toggle hidden until known */ }
    })()
    return () => { cancelled = true }
  }, [])

  async function toggleIncludeOffline(next: boolean) {
    setSavingOffline(true)
    setIncludeOffline(next) // optimistic
    try {
      const res = await fetch('/api/team/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeOfflineData: next }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const cfg = (await res.json()) as { includeOfflineData?: boolean }
      setIncludeOffline(cfg.includeOfflineData ?? next)
    } catch {
      setIncludeOffline(!next) // revert on failure
    } finally {
      setSavingOffline(false)
    }
  }

  async function handleMint(e: React.FormEvent) {
    e.preventDefault()
    if (!mintUser.trim() || !mintLabel.trim() || minting) return
    setMinting(true)
    setMintErr(null)
    setNewToken(null)
    try {
      const res = await fetch('/api/team/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: mintUser.trim(), label: mintLabel.trim() }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { token: string }
      setNewToken(data.token)
      setMintUser('')
      setMintLabel('')
      // Reload the table to show the new entry
      void loadMembers()
    } catch (err) {
      setMintErr(err instanceof Error ? err.message : String(err))
    } finally {
      setMinting(false)
    }
  }

  async function handleRevoke(id: string) {
    if (revoking[id]) return
    setRevoking(prev => ({ ...prev, [id]: true }))
    setRevokeErr(null)
    try {
      const res = await fetch('/api/team/tokens', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setMembers(prev => prev.filter(m => m.id !== id))
    } catch (err) {
      setRevokeErr(err instanceof Error ? err.message : String(err))
    } finally {
      setRevoking(prev => ({ ...prev, [id]: false }))
    }
  }

  async function handleRotate(id: string) {
    if (rotating[id]) return
    setRotating(prev => ({ ...prev, [id]: true }))
    setRotateErr(null)
    setNewToken(null)
    try {
      const res = await fetch('/api/team/tokens/rotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { token: string }
      setNewToken(data.token)
      // The member's identity key changed — reload the list to pick up the new id.
      void loadMembers()
    } catch (err) {
      setRotateErr(err instanceof Error ? err.message : String(err))
    } finally {
      setRotating(prev => ({ ...prev, [id]: false }))
    }
  }

  useEffect(() => {
    if (renamingId) renameInputRef.current?.focus()
  }, [renamingId])

  function startRename(m: TeamMember) {
    setRenamingId(m.id)
    setRenameValue(m.user)
    setRenameErr(null)
  }

  function cancelRename() {
    setRenamingId(null)
    setRenameValue('')
    setRenameErr(null)
  }

  async function handleRename(id: string) {
    const trimmed = renameValue.trim()
    if (!trimmed || renameSaving) return
    setRenameSaving(true)
    setRenameErr(null)
    try {
      const res = await fetch('/api/team/members', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, user: trimmed }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // Optimistically update the local list, then refresh from server
      setMembers(prev => prev.map(m => m.id === id ? { ...m, user: trimmed } : m))
      setRenamingId(null)
      setRenameValue('')
      void loadMembers()
    } catch (err) {
      setRenameErr(err instanceof Error ? err.message : String(err))
    } finally {
      setRenameSaving(false)
    }
  }

  const [copyFailed, setCopyFailed] = useState(false)
  async function handleCopy() {
    if (!newToken) return
    const ok = await copyText(newToken)
    if (ok) {
      setCopyFailed(false)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } else {
      // Nothing worked (rare) — tell the user to select + copy the visible field manually.
      setCopyFailed(true)
      setTimeout(() => setCopyFailed(false), 4000)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '7px 10px',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 7,
    fontSize: 13,
    color: 'var(--text-primary)',
    outline: 'none',
    fontFamily: 'inherit',
    transition: 'border-color 0.15s',
  }

  return (
    <div style={{ marginTop: 20 }}>
      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Users size={14} color="var(--text-secondary)" />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
            {t('title', lang)}
          </span>
        </div>
        <button
          onClick={() => { void loadMembers() }}
          disabled={loading}
          title={t('refresh', lang)}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '4px 8px', borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--text-tertiary)',
            fontSize: 11, fontWeight: 500,
            cursor: loading ? 'default' : 'pointer',
            fontFamily: 'inherit',
            opacity: loading ? 0.5 : 1,
          }}
        >
          <RefreshCw size={10} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          {t('refresh', lang)}
        </button>
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 16, lineHeight: 1.5 }}>
        {t('sub', lang)}
      </p>

      {/* Include-offline-data policy toggle */}
      {includeOffline !== null && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          padding: '10px 12px', borderRadius: 8, marginBottom: 16,
          border: '1px solid var(--border)', background: 'var(--bg-elevated)',
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
              {t('includeOfflineTitle', lang)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 3, lineHeight: 1.45 }}>
              {t('includeOfflineDesc', lang)}
            </div>
          </div>
          <button
            role="switch"
            aria-checked={includeOffline}
            disabled={savingOffline}
            onClick={() => { void toggleIncludeOffline(!includeOffline) }}
            style={{
              position: 'relative', flexShrink: 0,
              width: 40, height: 22, borderRadius: 11, border: 'none',
              background: includeOffline ? 'var(--anthropic-orange, #cd5d38)' : 'var(--border)',
              cursor: savingOffline ? 'default' : 'pointer',
              transition: 'background 0.15s', opacity: savingOffline ? 0.6 : 1,
            }}
          >
            <span style={{
              position: 'absolute', top: 2, left: includeOffline ? 20 : 2,
              width: 18, height: 18, borderRadius: '50%', background: '#fff',
              transition: 'left 0.15s',
            }} />
          </button>
        </div>
      )}


      {/* Load error */}
      {loadErr && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 10px', borderRadius: 7, marginBottom: 12,
          background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
          fontSize: 12, color: '#ef4444',
        }}>
          <AlertCircle size={13} />
          {t('loadErr', lang)}{loadErr ? ` — ${loadErr}` : ''}
        </div>
      )}

      {/* Members table */}
      {!loadErr && (
        <div style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflow: 'hidden',
          marginBottom: 20,
        }}>
          {/* Table header — desktop only; on mobile each row becomes a self-labelled card. */}
          {!isMobile && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: GRID_COLS,
              columnGap: 14,
              background: 'var(--bg-elevated)',
              borderBottom: '1px solid var(--border)',
              padding: '7px 12px',
            }}>
              {[t('status', lang), t('user', lang), t('label', lang), t('lastSeen', lang), ''].map((h, i) => (
                <div key={i} style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                  {h}
                </div>
              ))}
            </div>
          )}

          {/* Rows */}
          {loading ? (
            <div style={{ padding: '20px 12px', fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'center' }}>
              …
            </div>
          ) : members.length === 0 ? (
            <div style={{ padding: '16px 12px', fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'center' }}>
              {t('noMembers', lang)}
            </div>
          ) : (
            members.map((m, i) => {
              // Prefer the shared dashboard presence (SSE-refreshed) so this panel and the
              // FiltersBar pill can never disagree; fall back to this component's own fetch.
              const p = presence?.[m.user]
              const online = p ? p.online : m.online
              const latencyMs = p ? p.latencyMs : m.latencyMs
              return (
              <div
                key={m.id}
                style={{
                  ...(isMobile
                    ? { display: 'flex', flexDirection: 'column', gap: 8 }
                    : { display: 'grid', gridTemplateColumns: GRID_COLS, columnGap: 14, alignItems: 'center' }),
                  padding: isMobile ? '12px 12px' : '9px 12px',
                  borderBottom: i < members.length - 1 ? '1px solid var(--border)' : 'none',
                  background: 'var(--bg-card)',
                  transition: 'background 0.1s',
                  // Offline rows are dimmed so the eye jumps to who's actually connected.
                  opacity: online ? 1 : 0.5,
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-elevated)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-card)' }}
              >
                {/* Status cell — colored dot + latency (online) */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, paddingRight: 12, whiteSpace: 'nowrap' }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                    background: online ? '#22c55e' : '#ef4444',
                    boxShadow: online ? '0 0 6px rgba(34,197,94,0.6)' : 'none',
                  }} />
                  <span style={{ fontSize: 11, color: online ? 'var(--accent-green, #22c55e)' : 'var(--text-tertiary)', fontWeight: 500 }}>
                    {online ? (latencyMs != null ? `${latencyMs}ms` : t('online', lang)) : t('offline', lang)}
                  </span>
                </div>

                {/* User cell — static or editable */}
                {renamingId === m.id ? (
                  <div style={{ paddingRight: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <input
                        ref={renameInputRef}
                        type="text"
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { void handleRename(m.id) }
                          if (e.key === 'Escape') { cancelRename() }
                        }}
                        disabled={renameSaving}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          padding: '3px 6px',
                          background: 'var(--bg-elevated)',
                          border: renameErr ? '1px solid #ef4444' : '1px solid var(--anthropic-orange)',
                          borderRadius: 5,
                          fontSize: 12,
                          color: 'var(--text-primary)',
                          fontFamily: 'inherit',
                          outline: 'none',
                          opacity: renameSaving ? 0.6 : 1,
                        }}
                      />
                      <button
                        onClick={() => { void handleRename(m.id) }}
                        disabled={!renameValue.trim() || renameSaving}
                        title={t('renameSave', lang)}
                        style={{
                          display: 'flex', alignItems: 'center',
                          padding: '3px 5px', borderRadius: 5,
                          border: '1px solid rgba(34,197,94,0.4)',
                          background: 'rgba(34,197,94,0.08)',
                          color: !renameValue.trim() || renameSaving ? 'var(--text-tertiary)' : 'var(--accent-green)',
                          cursor: !renameValue.trim() || renameSaving ? 'default' : 'pointer',
                          fontFamily: 'inherit',
                          opacity: !renameValue.trim() || renameSaving ? 0.5 : 1,
                          flexShrink: 0,
                        }}
                      >
                        <Check size={11} />
                      </button>
                      <button
                        onClick={cancelRename}
                        disabled={renameSaving}
                        title={t('renameCancel', lang)}
                        style={{
                          display: 'flex', alignItems: 'center',
                          padding: '3px 5px', borderRadius: 5,
                          border: '1px solid var(--border)',
                          background: 'transparent',
                          color: 'var(--text-tertiary)',
                          cursor: renameSaving ? 'default' : 'pointer',
                          fontFamily: 'inherit',
                          flexShrink: 0,
                        }}
                      >
                        <X size={11} />
                      </button>
                    </div>
                    {renameErr && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4, fontSize: 10, color: '#ef4444' }}>
                        <AlertCircle size={10} />
                        {t('renameErr', lang)} — {renameErr}
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingRight: 8, minWidth: 0 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                      {m.user}
                    </span>
                    <button
                      onClick={() => startRename(m)}
                      title={t('rename', lang)}
                      style={{
                        display: 'flex', alignItems: 'center',
                        padding: '2px 4px', borderRadius: 4,
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--text-tertiary)',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        flexShrink: 0,
                        transition: 'color 0.15s',
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-tertiary)' }}
                    >
                      <Pencil size={10} />
                    </button>
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 12, color: 'var(--text-secondary)', paddingRight: isMobile ? 0 : 8 }}>
                  {isMobile && <span style={mobileFieldLabel}>{t('label', lang)}</span>}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{m.label}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-tertiary)', paddingRight: isMobile ? 0 : 8, whiteSpace: 'nowrap' }}>
                  {isMobile && <span style={mobileFieldLabel}>{t('lastSeen', lang)}</span>}
                  <span>{m.lastSeenAt ? relativeTime(m.lastSeenAt, lang) : t('never', lang)}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: isMobile ? 'stretch' : 'flex-end', marginTop: isMobile ? 4 : 0 }}>
                  <button
                    onClick={() => { setRotateErr(null); setConfirmRotateId(m.id) }}
                    disabled={rotating[m.id] || renamingId === m.id}
                    title={t('rotate', lang)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                      flex: isMobile ? 1 : undefined,
                      padding: isMobile ? '8px 8px' : '4px 8px', borderRadius: 6,
                      border: '1px solid var(--border)',
                      background: 'transparent',
                      color: rotating[m.id] || renamingId === m.id ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                      fontSize: 11, fontWeight: 600,
                      cursor: rotating[m.id] || renamingId === m.id ? 'default' : 'pointer',
                      fontFamily: 'inherit',
                      transition: 'all 0.15s',
                      opacity: rotating[m.id] || renamingId === m.id ? 0.5 : 1,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <RotateCw size={10} style={{ animation: rotating[m.id] ? 'spin 1s linear infinite' : 'none' }} />
                    {rotating[m.id] ? t('rotating', lang) : t('rotate', lang)}
                  </button>
                  <button
                    onClick={() => { setRevokeErr(null); setConfirmRevokeId(m.id) }}
                    disabled={revoking[m.id] || renamingId === m.id}
                    title={t('revoke', lang)}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                      flex: isMobile ? 1 : undefined,
                      padding: isMobile ? '8px 8px' : '4px 8px', borderRadius: 6,
                      border: '1px solid rgba(239,68,68,0.3)',
                      background: 'rgba(239,68,68,0.06)',
                      color: revoking[m.id] || renamingId === m.id ? 'var(--text-tertiary)' : '#ef4444',
                      fontSize: 11, fontWeight: 600,
                      cursor: revoking[m.id] || renamingId === m.id ? 'default' : 'pointer',
                      fontFamily: 'inherit',
                      transition: 'all 0.15s',
                      opacity: revoking[m.id] || renamingId === m.id ? 0.5 : 1,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <Trash2 size={10} />
                    {revoking[m.id] ? t('revoking', lang) : t('revoke', lang)}
                  </button>
                </div>
              </div>
              )
            })
          )}
        </div>
      )}

      {/* Revoke error */}
      {revokeErr && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 10px', borderRadius: 7, marginBottom: 12,
          background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
          fontSize: 11, color: '#ef4444',
        }}>
          <AlertCircle size={12} />
          {t('revokeErr', lang)}{revokeErr ? ` — ${revokeErr}` : ''}
        </div>
      )}

      {/* Rotate error */}
      {rotateErr && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 10px', borderRadius: 7, marginBottom: 12,
          background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
          fontSize: 11, color: '#ef4444',
        }}>
          <AlertCircle size={12} />
          {t('rotateErr', lang)}{rotateErr ? ` — ${rotateErr}` : ''}
        </div>
      )}

      {/* Rename error (shown below table when no row is in edit mode) */}
      {renameErr && !renamingId && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 10px', borderRadius: 7, marginBottom: 12,
          background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
          fontSize: 11, color: '#ef4444',
        }}>
          <AlertCircle size={12} />
          {t('renameErr', lang)} — {renameErr}
        </div>
      )}

      {/* Divider */}
      <div style={{ height: 1, background: 'var(--border)', marginBottom: 16 }} />

      {/* Mint new token */}
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-tertiary)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 12 }}>
        {t('mintTitle', lang)}
      </div>

      <form onSubmit={e => { void handleMint(e) }}>
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
              {t('userLabel', lang)}
            </div>
            <input
              type="text"
              value={mintUser}
              onChange={e => setMintUser(e.target.value)}
              placeholder={t('userPlaceholder', lang)}
              disabled={minting}
              style={{ ...inputStyle, opacity: minting ? 0.6 : 1 }}
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--anthropic-orange)' }}
              onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
            />
          </div>
          <div>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
              {t('labelLabel', lang)}
            </div>
            <input
              type="text"
              value={mintLabel}
              onChange={e => setMintLabel(e.target.value)}
              placeholder={t('labelPlaceholder', lang)}
              disabled={minting}
              style={{ ...inputStyle, opacity: minting ? 0.6 : 1 }}
              onFocus={e => { e.currentTarget.style.borderColor = 'var(--anthropic-orange)' }}
              onBlur={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={!mintUser.trim() || !mintLabel.trim() || minting}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '7px 14px', borderRadius: 7,
            border: '1px solid var(--anthropic-orange)',
            background: !mintUser.trim() || !mintLabel.trim() || minting
              ? 'var(--bg-elevated)'
              : 'var(--anthropic-orange-dim)',
            color: !mintUser.trim() || !mintLabel.trim() || minting
              ? 'var(--text-tertiary)'
              : 'var(--anthropic-orange)',
            fontSize: 12, fontWeight: 600,
            cursor: !mintUser.trim() || !mintLabel.trim() || minting ? 'default' : 'pointer',
            fontFamily: 'inherit',
            transition: 'all 0.15s',
            opacity: !mintUser.trim() || !mintLabel.trim() || minting ? 0.6 : 1,
          }}
        >
          <Plus size={13} />
          {minting ? t('minting', lang) : t('mint', lang)}
        </button>
      </form>

      {/* Mint error */}
      {mintErr && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '6px 10px', borderRadius: 7, marginTop: 10,
          background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
          fontSize: 11, color: '#ef4444',
        }}>
          <AlertCircle size={12} />
          {t('mintErr', lang)}{mintErr ? ` — ${mintErr}` : ''}
        </div>
      )}

      {/* New token — shown once */}
      {newToken && (
        <div style={{
          marginTop: 14,
          padding: '14px',
          borderRadius: 8,
          background: 'rgba(217,119,6,0.06)',
          border: '1px solid rgba(217,119,6,0.35)',
        }}>
          {/* Warning banner */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            marginBottom: 10,
            fontSize: 11, fontWeight: 600, color: 'var(--anthropic-orange)',
          }}>
            <AlertCircle size={13} />
            {t('tokenNote', lang)}
          </div>

          {/* Token + copy button */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
            <input
              type="text"
              readOnly
              value={newToken}
              onClick={e => (e.target as HTMLInputElement).select()}
              style={{
                flex: 1,
                padding: '7px 10px',
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 7,
                fontSize: 12,
                fontFamily: 'monospace',
                color: 'var(--text-primary)',
                outline: 'none',
                wordBreak: 'break-all',
              }}
            />
            <button
              onClick={() => { void handleCopy() }}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '7px 12px', borderRadius: 7,
                border: copied
                  ? '1px solid rgba(34,197,94,0.4)'
                  : '1px solid var(--anthropic-orange)',
                background: copied
                  ? 'rgba(34,197,94,0.1)'
                  : 'var(--anthropic-orange-dim)',
                color: copied
                  ? 'var(--accent-green)'
                  : 'var(--anthropic-orange)',
                fontSize: 12, fontWeight: 600,
                cursor: 'pointer', fontFamily: 'inherit',
                transition: 'all 0.2s',
                flexShrink: 0,
              }}
            >
              {copied ? <CheckCheck size={13} /> : <Copy size={13} />}
              {copied ? t('copied', lang) : t('copyToken', lang)}
            </button>
          </div>
          {copyFailed && (
            <div style={{ fontSize: 11, color: 'var(--anthropic-orange)', marginTop: 8 }}>
              {lang === 'pt'
                ? 'Não consegui copiar automaticamente — selecione o texto acima e copie (Ctrl/Cmd+C).'
                : 'Couldn’t copy automatically — select the text above and copy it (Ctrl/Cmd+C).'}
            </div>
          )}
        </div>
      )}

      {/* Revoke confirmation modal */}
      {confirmRevokeId && (
        <ConfirmModal
          title={t('revokeConfirmTitle', lang)}
          body={t('revokeConfirmBody', lang)}
          cancelLabel={t('cancel', lang)}
          confirmLabel={t('confirm', lang)}
          danger
          onCancel={() => setConfirmRevokeId(null)}
          onConfirm={() => {
            const id = confirmRevokeId
            setConfirmRevokeId(null)
            void handleRevoke(id)
          }}
        />
      )}

      {/* Rotate confirmation modal */}
      {confirmRotateId && (
        <ConfirmModal
          title={t('rotateConfirmTitle', lang)}
          body={t('rotateConfirmBody', lang)}
          cancelLabel={t('cancel', lang)}
          confirmLabel={t('confirm', lang)}
          onCancel={() => setConfirmRotateId(null)}
          onConfirm={() => {
            const id = confirmRotateId
            setConfirmRotateId(null)
            void handleRotate(id)
          }}
        />
      )}

      {/* Spinner keyframe */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}

// Confirmation modal

interface ConfirmModalProps {
  title: string
  body: string
  cancelLabel: string
  confirmLabel: string
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}

function ConfirmModal({ title, body, cancelLabel, confirmLabel, danger, onCancel, onConfirm }: ConfirmModalProps) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.5)', padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 400,
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 20,
          boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 10 }}>
          {title}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 18 }}>
          {body}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              padding: '7px 14px', borderRadius: 7,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text-secondary)',
              fontSize: 12, fontWeight: 600,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: '7px 14px', borderRadius: 7,
              border: danger ? '1px solid rgba(239,68,68,0.5)' : '1px solid var(--anthropic-orange)',
              background: danger ? '#ef4444' : 'var(--anthropic-orange-dim)',
              color: danger ? '#fff' : 'var(--anthropic-orange)',
              fontSize: 12, fontWeight: 600,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
