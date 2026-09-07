import { test, expect } from 'bun:test'
import { visibleSettingsSections, SETTINGS_SECTIONS } from './settingsSections'

const ids = (v: Parameters<typeof visibleSettingsSections>[0]) => visibleSettingsSections(v).map(s => s.id)

test('solo/member: personal sections + live, no governance', () => {
  expect(ids({ central: false })).toEqual(['preferences', 'accessibility', 'notifications', 'sessions', 'data-sources', 'backup', 'harnesses', 'pricing', 'billing', 'install', 'connection', 'live', 'chat'])
})

test('central owner: personal (no live) + all governance sections', () => {
  expect(ids({ central: true, role: 'owner' })).toEqual(['preferences', 'accessibility', 'notifications', 'sessions', 'data-sources', 'harnesses', 'pricing', 'install', 'users', 'teams', 'machines', 'repositories'])
})

test('central manager: personal + governance (users/teams/machines)', () => {
  expect(ids({ central: true, role: 'member', isManager: true })).toEqual(['preferences', 'accessibility', 'notifications', 'sessions', 'data-sources', 'harnesses', 'pricing', 'install', 'users', 'teams', 'machines'])
})

test('central plain user: personal + machines (to view/manage their own), no users/teams', () => {
  expect(ids({ central: true, role: 'member', isManager: false })).toEqual(['preferences', 'accessibility', 'notifications', 'sessions', 'data-sources', 'harnesses', 'pricing', 'install', 'machines'])
})

test('every section has a group', () => {
  for (const section of SETTINGS_SECTIONS) {
    expect(section.group).toBeDefined()
    expect(['personal', 'governance']).toContain(section.group)
  }
})

test('billing is a machine section — a central cannot price a fleet from one timeline', () => {
  expect(ids({ central: false })).toContain('billing')
  expect(ids({ central: true, role: 'owner' })).not.toContain('billing')
  expect(ids({ central: true, role: 'member', isManager: true })).not.toContain('billing')
})

test('backup is a machine section — a central has no local harness directories to back up', () => {
  expect(ids({ central: false })).toContain('backup')
  expect(ids({ central: true, role: 'owner' })).not.toContain('backup')
  expect(ids({ central: true, role: 'member', isManager: true })).not.toContain('backup')
})

test('chat is a machine section — a central serves no local chat to configure', () => {
  expect(ids({ central: false })).toContain('chat')
  expect(ids({ central: true, role: 'owner' })).not.toContain('chat')
})

// Two gates, not one — `localChat` (the exposure profile) gates the SECTION; `chatEnabled` (the
// user's own switch, not modeled here) gates the sound/model rows drawn inside it.
test('chat is offered on a machine whose profile allows it', () => {
  expect(ids({ central: false, localChat: true })).toContain('chat')
})

// The section holds the enable switch. Hiding it when chat is merely OFF would make the switch
// unreachable — the user could never turn it back on.
test('chat stays visible when the profile allows it and the user has it off', () => {
  expect(ids({ central: false, localChat: undefined })).toContain('chat')
})

test('chat is absent when the exposure profile denies localChat — there is nothing to switch', () => {
  expect(ids({ central: false, localChat: false })).not.toContain('chat')
})

test('chat is absent on a central, as before', () => {
  expect(ids({ central: true, localChat: true })).not.toContain('chat')
})

test('the other sections are unaffected by the new field', () => {
  expect(ids({ central: false, localChat: false })).toContain('preferences')
  expect(ids({ central: false, localChat: false })).toContain('notifications')
})
