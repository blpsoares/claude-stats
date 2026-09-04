import React from 'react'
import { NavLink, Outlet, useOutletContext } from 'react-router-dom'
import type { AppContext } from '../../lib/app-context'
import {
  visibleSettingsSections,
  type SettingsGroup,
  type SettingsSection,
  type SettingsViewer,
} from '../../lib/settingsSections'
import { useIsMobile } from '../../hooks/useIsMobile'

const GROUP_LABELS: Record<SettingsGroup, { en: string; pt: string }> = {
  personal: { en: 'Personal', pt: 'Pessoal' },
  governance: { en: 'Governance', pt: 'Governança' },
}

const GROUP_ORDER: SettingsGroup[] = ['personal', 'governance']

/**
 * Settings hub — a two-column page: a grouped internal section menu (left) and the active
 * section's content (right, via <Outlet>). MUST forward the AppLayout outlet context:
 * React Router's useOutletContext reads the nearest <Outlet context>, so a bare <Outlet/>
 * here would hand child pages `undefined` (and crash them). Re-provide the layout's context.
 */
export default function SettingsPage() {
  const ctx = useOutletContext<AppContext>()
  const isMobile = useIsMobile()
  const pt = ctx.lang === 'pt'

  const viewer: SettingsViewer = {
    central: ctx.isCentral,
    role: ctx.me?.role,
    isManager: ctx.me?.memberships.some(m => m.role === 'manager'),
    localChat: ctx.capabilities?.localChat,
  }

  const sections = visibleSettingsSections(viewer)
  const grouped = GROUP_ORDER
    .map(group => ({ group, items: sections.filter(s => s.group === group) }))
    .filter(g => g.items.length > 0)

  const label = (s: SettingsSection) => (pt ? s.labelPt : s.labelEn)

  const linkStyle = (active: boolean): React.CSSProperties => ({
    display: 'block',
    padding: isMobile ? '7px 12px' : '7px 10px',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: active ? 600 : 500,
    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
    background: active ? 'var(--bg-elevated)' : 'transparent',
    border: '1px solid ' + (active ? 'var(--border)' : 'transparent'),
    textDecoration: 'none',
    whiteSpace: 'nowrap',
  })

  const menu = (
    <nav
      style={
        isMobile
          ? { display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4 }
          : { display: 'flex', flexDirection: 'column', gap: 14 }
      }
    >
      {grouped.map(({ group, items }) => (
        <div
          key={group}
          style={
            isMobile
              ? { display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }
              : { display: 'flex', flexDirection: 'column', gap: 2 }
          }
        >
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--text-tertiary)',
              padding: isMobile ? '0 4px' : '2px 10px 4px',
              flexShrink: 0,
            }}
          >
            {pt ? GROUP_LABELS[group].pt : GROUP_LABELS[group].en}
          </div>
          {items.map(s => (
            <NavLink key={s.id} to={`/settings/${s.id}`} style={({ isActive }) => linkStyle(isActive)}>
              {label(s)}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  )

  return (
    // `ag-settings` drives the mobile touch-target rule in index.css — the governance pages style
    // their buttons with module-level inline objects that a hook cannot reach.
    <div className="ag-settings" style={{ maxWidth: 1100 }}>
      <h1
        style={{
          fontSize: 22,
          fontWeight: 700,
          color: 'var(--text-primary)',
          margin: '0 0 18px',
        }}
      >
        {pt ? 'Configurações' : 'Settings'}
      </h1>

      <div
        style={
          isMobile
            ? { display: 'flex', flexDirection: 'column', gap: 16 }
            : { display: 'flex', gap: 28, alignItems: 'flex-start' }
        }
      >
        <aside
          style={
            isMobile
              ? { width: '100%' }
              : { width: 210, flexShrink: 0, position: 'sticky', top: 16 }
          }
        >
          {menu}
        </aside>

        <div style={{ flex: 1, minWidth: 0 }}>
          <Outlet context={ctx} />
        </div>
      </div>
    </div>
  )
}
