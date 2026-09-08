import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, AlertCircle, AlertTriangle, Info, CheckCircle2, Trash2, X } from 'lucide-react'
import { useNotifications, markAllRead, clearNotifications, dismissNotification, resolveNotification, notificationLink, type NotificationType } from '../lib/notifications'
import { useIsMobile } from '../hooks/useIsMobile'

const ICON: Record<NotificationType, { color: string; Icon: typeof AlertCircle }> = {
  error:   { color: '#ef4444', Icon: AlertCircle },
  warning: { color: '#f59e0b', Icon: AlertTriangle },
  info:    { color: '#3b82f6', Icon: Info },
  success: { color: '#22c55e', Icon: CheckCircle2 },
}

function relTime(ts: number, pt: boolean): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return pt ? 'agora' : 'now'
  const m = Math.floor(s / 60)
  if (m < 60) return pt ? `${m}min` : `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return pt ? `${h}h` : `${h}h`
  return pt ? `${Math.floor(h / 24)}d` : `${Math.floor(h / 24)}d`
}

interface Props {
  lang: 'pt' | 'en'
  /** Optional style overrides for the trigger button (to match the header's action row). */
  buttonStyle?: React.CSSProperties
}

/** Bell icon with an unread badge and a dropdown of the notification history. */
export function NotificationBell({ lang, buttonStyle }: Props) {
  const pt = lang === 'pt'
  const notes = useNotifications()
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const unread = notes.filter(n => !n.read).length

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', h)
    return () => window.removeEventListener('mousedown', h)
  }, [])

  function toggle() {
    const next = !open
    setOpen(next)
    if (next) markAllRead() // opening the panel clears the unread badge
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={toggle}
        title={pt ? 'Notificações' : 'Notifications'}
        style={buttonStyle ?? {
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 34, height: 34, borderRadius: 8,
          border: '1px solid var(--border)', background: 'var(--bg-elevated)',
          color: 'var(--text-secondary)', cursor: 'pointer', position: 'relative',
        }}
      >
        <Bell size={16} />
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: -5, right: -5, minWidth: 16, height: 16, padding: '0 4px',
            borderRadius: 8, background: '#ef4444', color: '#fff',
            fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxSizing: 'border-box',
          }}>{unread > 9 ? '9+' : unread}</span>
        )}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 3000,
          width: 320, maxHeight: 380, overflowY: 'auto',
          background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 10, boxShadow: '0 16px 40px rgba(0,0,0,0.45)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 12px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0,
            background: 'var(--bg-card)',
          }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>
              {pt ? 'Notificações' : 'Notifications'}
            </span>
            {notes.length > 0 && (
              <button className="ag-tap"
                onClick={() => clearNotifications()}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                  padding: isMobile ? '6px 12px' : '3px 7px',
                  borderRadius: 6,
                  border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text-tertiary)', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                {/* "tudo" matters now that each row has its own remove button. */}
                <Trash2 size={11} />{pt ? 'Limpar tudo' : 'Clear all'}
              </button>
            )}
          </div>

          {notes.length === 0 ? (
            <div style={{ padding: '24px 12px', textAlign: 'center', fontSize: 12, color: 'var(--text-tertiary)' }}>
              {pt ? 'Nenhuma notificação.' : 'No notifications.'}
            </div>
          ) : (
            notes.map(n => {
              const { color, Icon } = ICON[n.type]
              const { title, message } = resolveNotification(n, lang)
              // A notification about a decision opens that decision — see `notificationLink`.
              const link = notificationLink(n)
              // The update notification isn't a route — it opens the (opt-in only, see App.tsx)
              // UpdateModal via the same custom-event handoff TtyChat uses for its own open trigger.
              const isUpdate = n.code === 'app.update_available'
              const clickable = link !== null || isUpdate
              const go = () => {
                setOpen(false)
                if (isUpdate) { window.dispatchEvent(new CustomEvent('agentistics:open-update-modal')); return }
                if (link) navigate(link)
              }
              return (
                // THE WHOLE ROW is the link, not a box inside it. The handler used to sit on the
                // inner text block, so a click on the row's padding, its icon or the timestamp
                // column did nothing at all — a link whose hit area is a subset of what looks like
                // the link reads as "clicking the notification does nothing".
                <div
                  key={n.id}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? go : undefined}
                  onKeyDown={clickable ? (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go() } }) : undefined}
                  onMouseEnter={clickable ? (e => { (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-elevated)' }) : undefined}
                  onMouseLeave={clickable ? (e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }) : undefined}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 9,
                    padding: '10px 12px', borderBottom: '1px solid var(--border)',
                    background: 'transparent', cursor: clickable ? 'pointer' : undefined,
                  }}
                >
                  <Icon size={15} color={color} style={{ flexShrink: 0, marginTop: 1 }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>{title}</div>
                    {message && (
                      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.45, wordBreak: 'break-word' }}>
                        {message}
                      </div>
                    )}
                  </div>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0,
                    alignSelf: 'flex-start',
                  }}>
                    <span style={{ fontSize: 10.5, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                      {relTime(n.ts, pt)}
                    </span>
                    {/* Per-item delete. Always visible, never hover-only: the bell is rendered on
                        mobile too, where hover does not exist, and the hit area is a full 44px
                        there (the icon stays small — only the touch target grows). */}
                    <button className="ag-tap-icon"
                      // The row navigates, so its own controls must not: without this, removing a
                      // notification would also open whatever it linked to.
                      onClick={e => { e.stopPropagation(); dismissNotification(n.id) }}
                      title={pt ? 'Remover notificação' : 'Remove notification'}
                      aria-label={pt ? 'Remover notificação' : 'Remove notification'}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        width: 22, height: 22,
                        marginRight: isMobile ? -10 : 0,
                        padding: 0, borderRadius: 6, border: 'none', background: 'transparent',
                        color: 'var(--text-tertiary)', cursor: 'pointer',
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-primary)' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-tertiary)' }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
