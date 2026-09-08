import { describe, test, it, expect } from 'bun:test'
import { countGitCommands, canonicalTool } from './harness-activity'

test('counts a plain commit and a plain push', () => {
  expect(countGitCommands('git commit -m "x"')).toEqual({ commits: 1, pushes: 0 })
  expect(countGitCommands('git push origin main')).toEqual({ commits: 0, pushes: 1 })
})

test('splits a compound command — a chain is several commands, not one', () => {
  expect(countGitCommands('git add -A && git commit -m x && git push')).toEqual({ commits: 1, pushes: 1 })
  expect(countGitCommands('cd /repo && git commit -m x')).toEqual({ commits: 1, pushes: 0 })
  expect(countGitCommands('git commit -m a\ngit commit -m b')).toEqual({ commits: 2, pushes: 0 })
})

test('a word that merely starts with the command name is not that command', () => {
  expect(countGitCommands('git commit-tree abc')).toEqual({ commits: 0, pushes: 0 })
  expect(countGitCommands('git-commit')).toEqual({ commits: 0, pushes: 0 })
  expect(countGitCommands('echo git commit')).toEqual({ commits: 0, pushes: 0 })
})

test('a commit named inside a message is not a commit', () => {
  expect(countGitCommands('git commit -m "run git push later"')).toEqual({ commits: 1, pushes: 0 })
})

test('empty and junk input count nothing', () => {
  expect(countGitCommands('')).toEqual({ commits: 0, pushes: 0 })
  expect(countGitCommands('   ')).toEqual({ commits: 0, pushes: 0 })
})

test('every harness shell tool lands in the same bucket', () => {
  expect(canonicalTool('claude', 'Bash')).toBe('Bash')
  expect(canonicalTool('codex', 'exec_command')).toBe('Bash')
  expect(canonicalTool('codex', 'local_shell_call')).toBe('Bash')
  expect(canonicalTool('copilot', 'bash')).toBe('Bash')
  expect(canonicalTool('gemini', 'run_shell_command')).toBe('Bash')
  expect(canonicalTool('antigravity', 'RUN_COMMAND')).toBe('Bash')
})

test('read and edit tools map onto the shared names too', () => {
  expect(canonicalTool('copilot', 'view')).toBe('Read')
  expect(canonicalTool('gemini', 'read_file')).toBe('Read')
  expect(canonicalTool('antigravity', 'write_to_file')).toBe('Write')
  expect(canonicalTool('antigravity', 'replace_file_content')).toBe('Edit')
})

test('an unmapped name passes through unchanged — a mapping, never a filter', () => {
  expect(canonicalTool('codex', 'something_new')).toBe('something_new')
  expect(canonicalTool('claude', 'mcp__foo__bar')).toBe('mcp__foo__bar')
})

describe('git reached through a wrapper', () => {
  it('counts a commit made through a proxy, a sudo or a container', () => {
    // Measured on a real session: 62 commits counted as 2, because the whole machine routes git
    // through `rtk proxy`. Every wrapper below is a normal way to run git.
    expect(countGitCommands('rtk proxy git commit -F /tmp/m.txt').commits).toBe(1)
    expect(countGitCommands('sudo -u ci git push').pushes).toBe(1)
    expect(countGitCommands('docker exec app git commit -m z').commits).toBe(1)
    expect(countGitCommands('/usr/bin/git commit -m q').commits).toBe(1)
  })

  it('still refuses a sentence that merely contains the words', () => {
    // The wrapper is a few bare tokens, never `.*` — the segment must be a COMMAND running git.
    expect(countGitCommands('echo "remember to git commit later"').commits).toBe(0)
    expect(countGitCommands('# git commit is the next step').commits).toBe(0)
    // A permissive "any few words" wrapper was tried first and counted both of these. A counter
    // that inflates on prose is worse than one that misses a wrapper.
    expect(countGitCommands('npm run git commit').commits).toBe(0)
  })

  it('still refuses a DIFFERENT git subcommand', () => {
    expect(countGitCommands('git commit-tree abc').commits).toBe(0)
    expect(countGitCommands('rtk proxy git commit-tree abc').commits).toBe(0)
  })
})
