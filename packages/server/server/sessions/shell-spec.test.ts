import { describe, expect, test } from 'bun:test'
import { planShellOpen, SHELL_CAP, type ShellOpenFacts } from './shell-spec'

const ok: ShellOpenFacts = {
  cwd: '/home/u/proj',
  cwdExists: true,
  tmuxAvailable: true,
  openCount: 0,
  shell: '/usr/bin/zsh',
}

describe('planShellOpen', () => {
  test('opens the user’s own shell in the session’s directory', () => {
    expect(planShellOpen(ok)).toEqual({ ok: true, argv: ['/usr/bin/zsh'], cwd: '/home/u/proj' })
  })

  test('falls back to bash when the environment names no shell', () => {
    expect(planShellOpen({ ...ok, shell: undefined }))
      .toEqual({ ok: true, argv: ['/bin/bash'], cwd: '/home/u/proj' })
  })

  test('an EMPTY $SHELL is not a shell', () => {
    // `process.env.SHELL` can be present and empty, and spawning '' fails with nothing useful to
    // show the person.
    expect(planShellOpen({ ...ok, shell: '' }))
      .toEqual({ ok: true, argv: ['/bin/bash'], cwd: '/home/u/proj' })
  })

  test('no tmux refuses FIRST — nothing else can work without it', () => {
    expect(planShellOpen({ ...ok, tmuxAvailable: false, cwd: undefined, openCount: 99 }))
      .toEqual({ ok: false, reason: 'no-tmux' })
  })

  test('a session with no recorded directory is refused, never opened in $HOME', () => {
    // Opening somewhere other than where it was asked for is the same class of error as a confident
    // 0 for a metric nobody can produce.
    expect(planShellOpen({ ...ok, cwd: undefined })).toEqual({ ok: false, reason: 'no-cwd' })
  })

  test('a directory that is GONE is its own reason, not folded into "no directory"', () => {
    // The removed-worktree case `repo-facts.ts` documents. The two read differently and send the
    // person to different places.
    expect(planShellOpen({ ...ok, cwdExists: false })).toEqual({ ok: false, reason: 'cwd-missing' })
  })

  test('THE CEILING: the ninth shell is refused', () => {
    expect(planShellOpen({ ...ok, openCount: SHELL_CAP - 1 }).ok).toBe(true)
    expect(planShellOpen({ ...ok, openCount: SHELL_CAP })).toEqual({ ok: false, reason: 'at-cap' })
    expect(planShellOpen({ ...ok, openCount: SHELL_CAP + 5 }))
      .toEqual({ ok: false, reason: 'at-cap' })
  })

  test('an IMPOSSIBLE open is refused before a merely FULL one', () => {
    // At the ceiling the caller asks the person to close a shell to make room. Asking somebody to
    // destroy work to make room for an open that could never have succeeded is worse than saying no.
    expect(planShellOpen({ ...ok, cwdExists: false, openCount: SHELL_CAP }))
      .toEqual({ ok: false, reason: 'cwd-missing' })
  })

  test('the ceiling is 8, and it is stated HERE and nowhere else', () => {
    expect(SHELL_CAP).toBe(8)
  })
})
