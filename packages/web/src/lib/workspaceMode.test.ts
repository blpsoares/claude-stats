import { expect, test, describe } from 'bun:test'
import { modeOfPath, pathForMode, modeLabel, SESSIONS_ROOT } from './workspaceMode'

describe('modeOfPath — the mode is read off the URL, so there is one answer', () => {
  test('the sessions root and everything under it', () => {
    expect(modeOfPath('/sessions')).toBe('sessions')
    expect(modeOfPath('/sessions/3b84a922')).toBe('sessions')
  })

  test('everything else is the dashboard', () => {
    for (const p of ['/', '/costs', '/projects', '/repositories', '/settings/notifications']) {
      expect(modeOfPath(p)).toBe('dashboard')
    }
  })

  test('a path that merely STARTS with the same characters is not the sessions workspace', () => {
    // The bug a bare `startsWith` would ship: a future dashboard page silently swallowed into the
    // other workspace, with the sidebar showing the wrong body and no way to tell why.
    expect(modeOfPath('/sessions-report')).toBe('dashboard')
    expect(modeOfPath('/sessionsomething')).toBe('dashboard')
  })
})

describe('pathForMode — leaving sessions returns you to what you were doing', () => {
  test('entering sessions goes to its root', () => {
    expect(pathForMode('sessions')).toBe(SESSIONS_ROOT)
    expect(pathForMode('sessions', '/costs')).toBe(SESSIONS_ROOT)
  })

  test('leaving sessions restores the remembered dashboard path', () => {
    expect(pathForMode('dashboard', '/costs')).toBe('/costs')
  })

  test('a missing, foreign or sessions-shaped memory falls back to Home rather than no-opping', () => {
    expect(pathForMode('dashboard')).toBe('/')
    expect(pathForMode('dashboard', null)).toBe('/')
    expect(pathForMode('dashboard', '')).toBe('/')
    expect(pathForMode('dashboard', 'costs')).toBe('/')
    // The one that would look broken: switching away lands back in the workspace you just left.
    expect(pathForMode('dashboard', '/sessions/abc')).toBe('/')
  })
})

describe('modeLabel', () => {
  test('both modes, both languages', () => {
    expect(modeLabel('dashboard', 'en')).toBe('Dashboard')
    expect(modeLabel('dashboard', 'pt')).toBe('Painel')
    expect(modeLabel('sessions', 'en')).toBe('Sessions')
    expect(modeLabel('sessions', 'pt')).toBe('Sessões')
  })
})
