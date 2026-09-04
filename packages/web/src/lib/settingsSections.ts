/** Which settings sections a viewer can see. UX-only gate — the server enforces real authz. */
export type SettingsSectionId =
  | 'preferences' | 'sessions' | 'data-sources' | 'harnesses' | 'pricing' | 'billing' | 'install' | 'connection' | 'live'
  | 'chat' | 'notifications'
  | 'users' | 'teams' | 'machines' | 'repositories'

export type SettingsGroup = 'personal' | 'governance'

export interface SettingsSection { id: SettingsSectionId; labelEn: string; labelPt: string; group: SettingsGroup }
export interface SettingsViewer {
  central: boolean
  role?: 'owner' | 'member'
  isManager?: boolean
  /** `CAPS.localChat` from /api/team/session. `false` means the exposure profile denies chat
   *  entirely, so the section has nothing to offer. `undefined` (not yet loaded) shows it —
   *  hiding a section on a slow fetch is worse than showing one that is briefly empty. */
  localChat?: boolean
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  { id: 'preferences', labelEn: 'Preferences', labelPt: 'Preferências', group: 'personal' },
  { id: 'notifications', labelEn: 'Notifications', labelPt: 'Notificações', group: 'personal' },
  { id: 'sessions', labelEn: 'Sessions', labelPt: 'Sessões', group: 'personal' },
  { id: 'data-sources', labelEn: 'Data & sources', labelPt: 'Dados & fontes', group: 'personal' },
  { id: 'harnesses', labelEn: 'Harnesses', labelPt: 'Harnesses', group: 'personal' },
  { id: 'pricing', labelEn: 'Pricing', labelPt: 'Preços', group: 'personal' },
  { id: 'billing', labelEn: 'Billing', labelPt: 'Cobrança', group: 'personal' },
  { id: 'install', labelEn: 'Install', labelPt: 'Instalação', group: 'personal' },
  { id: 'connection', labelEn: 'Central connection', labelPt: 'Conexão com a central', group: 'personal' },
  { id: 'live', labelEn: 'Live', labelPt: 'Ao vivo', group: 'personal' },
  { id: 'chat', labelEn: 'Chat', labelPt: 'Chat', group: 'personal' },
  { id: 'users', labelEn: 'Users', labelPt: 'Usuários', group: 'governance' },
  { id: 'teams', labelEn: 'Teams', labelPt: 'Times', group: 'governance' },
  { id: 'machines', labelEn: 'Machines', labelPt: 'Máquinas', group: 'governance' },
  { id: 'repositories', labelEn: 'GitHub Repositories', labelPt: 'Repositórios GitHub', group: 'governance' },
]

export function visibleSettingsSections(v: SettingsViewer): SettingsSection[] {
  return SETTINGS_SECTIONS.filter(s => {
    switch (s.id) {
      case 'connection': return !v.central
      case 'live': return !v.central
      // Chat spawns an assistant CLI on THIS host. A central has no local harness to spawn, so
      // there is nothing there to configure — the same reason `connection` and `live` are hidden.
      // Two gates, not one. `chatEnabled` (the user's switch) gates the ROWS inside the section;
      // this gates the SECTION. Collapsing them would hide the enable switch whenever chat is off,
      // which is a one-way door: there would be no way to turn it back on.
      case 'chat': return !v.central && v.localChat !== false
      // Billing describes how ONE machine is paid for. A central aggregates many, and pricing a
      // whole fleet from its operator's own timeline would be a fabricated number — so the plan
      // cost basis does not exist there and neither does the screen that configures it.
      case 'billing': return !v.central
      case 'users':
      case 'teams': return v.central && (v.role === 'owner' || !!v.isManager)
      // Machines is visible to ANY central account: owner/manager manage the fleet, a plain user
      // sees (and manages) the machines linked to their own account. The server scopes the list.
      case 'machines': return v.central
      case 'repositories': return v.central && v.role === 'owner'
      default: return true
    }
  })
}
