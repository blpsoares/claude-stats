import { describe, expect, it } from 'bun:test'
import { dependencyCommandLine, knownManagers, planDependency } from './dependency-plan'

const facts = (over: Partial<Parameters<typeof planDependency>[1]> = {}) => ({
  platform: 'linux',
  present: false,
  managers: [] as const,
  isRoot: false,
  ...over,
})

describe('planDependency', () => {
  it('reports ok, with no command, when the dependency is already present', () => {
    const plan = planDependency('tmux', facts({ present: true, managers: ['apt'] }))
    expect(plan.reason).toBe('ok')
    expect(plan.command).toBeUndefined()
    expect(plan.runnable).toBe(false)
  })

  it('names Windows as an explanation, never an install target — there is no Windows session backend', () => {
    const plan = planDependency('tmux', facts({ platform: 'win32', managers: ['apt'] }))
    expect(plan.reason).toBe('windows')
    expect(plan.command).toBeUndefined()
    expect(plan.runnable).toBe(false)
  })

  it('offers no command when no recognised package manager is present — a guessed command is worse than none', () => {
    const plan = planDependency('tmux', facts({ managers: [] }))
    expect(plan.reason).toBe('no-manager')
    expect(plan.command).toBeUndefined()
    expect(plan.manager).toBeUndefined()
    expect(plan.runnable).toBe(false)
  })

  it('offers the exact command to COPY, prefixed with sudo, when root is needed and this process is not root', () => {
    const plan = planDependency('tmux', facts({ managers: ['apt'], isRoot: false }))
    expect(plan.reason).toBe('needs-root')
    expect(plan.command).toEqual(['sudo', 'apt', 'install', '-y', 'tmux'])
    expect(plan.runnable).toBe(false)
    expect(dependencyCommandLine(plan)).toBe('sudo apt install -y tmux')
  })

  it('is runnable with no sudo when this process is already root', () => {
    const plan = planDependency('tmux', facts({ managers: ['apt'], isRoot: true }))
    expect(plan.reason).toBe('installable')
    expect(plan.command).toEqual(['apt', 'install', '-y', 'tmux'])
    expect(plan.runnable).toBe(true)
  })

  it('is runnable with no sudo on a manager that refuses to run as root by design (brew)', () => {
    const plan = planDependency('tmux', facts({ managers: ['brew'], isRoot: false }))
    expect(plan.reason).toBe('installable')
    expect(plan.command).toEqual(['brew', 'install', 'tmux'])
    expect(plan.runnable).toBe(true)
  })

  it('prefers apt over apt-get when a machine has both — the modern one', () => {
    const plan = planDependency('tmux', facts({ managers: ['apt-get', 'apt'], isRoot: true }))
    expect(plan.manager).toBe('apt')
  })

  it('prefers a Linux system manager over Homebrew even when both are on PATH', () => {
    const plan = planDependency('tmux', facts({ managers: ['brew', 'dnf'], isRoot: true }))
    expect(plan.manager).toBe('dnf')
  })
})

describe('dependencyCommandLine', () => {
  it('is null when there is no command to show', () => {
    const plan = planDependency('tmux', facts({ present: true }))
    expect(dependencyCommandLine(plan)).toBeNull()
  })
})

describe('knownManagers', () => {
  it('lists every manager this module can write a command for', () => {
    expect(knownManagers()).toContain('apt')
    expect(knownManagers()).toContain('brew')
  })
})
