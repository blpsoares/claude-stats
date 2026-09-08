import { describe, expect, it } from 'bun:test'
import { cannotWriteText, offerableScopes, runText, runningMcpCount, scopeText, type McpEntry } from './mcpPanel'

const entry = (run: McpEntry['run']): McpEntry => ({ name: 'x', scope: 'user', transport: 'stdio', config: '{}', run })

describe('runText — the word "offline" is never used', () => {
  it('never says offline for a server nothing is running', () => {
    // A stdio MCP server exists only while a session that uses it runs, so this is the NORMAL state.
    const r = runText({ state: 'idle' }, false)
    expect(r.text).toBe('configured')
    expect(`${r.text} ${r.detail}`.toLowerCase()).not.toContain('offline')
    expect(r.detail).toContain('only runs while a session using it is open')
  })

  it('says how many processes are running it', () => {
    expect(runText({ state: 'running', pids: [1, 2] }, false).detail).toBe('2 processes on this machine')
    expect(runText({ state: 'running', pids: [1] }, false).detail).toBe('1 process on this machine')
  })

  it('says a remote server cannot be seen from here rather than guessing', () => {
    expect(runText({ state: 'remote' }, false).detail).toContain('cannot see whether it is up')
  })

  it('blames the CONFIG for a server with no command', () => {
    expect(runText({ state: 'unrunnable' }, false).detail).toContain('does not say what to run')
  })

  it('turns every unavailability code into a sentence, and passes an unknown one through', () => {
    for (const reason of ['not-linux', 'no-proc', 'container-isolated', 'permission-denied', 'capability-off']) {
      const d = runText({ state: 'unknown', reason }, false).detail!
      expect(d).not.toBe(reason)
      expect(d.length).toBeGreaterThan(10)
    }
    expect(runText({ state: 'unknown', reason: 'something-new' }, false).detail).toBe('something-new')
  })

  it('gives every state a WORD, so nothing is said in colour alone', () => {
    for (const run of [
      { state: 'running', pids: [1] }, { state: 'idle' }, { state: 'remote' },
      { state: 'unrunnable' }, { state: 'unknown', reason: 'no-proc' },
    ] as McpEntry['run'][]) {
      expect(runText(run, true).text.length).toBeGreaterThan(0)
      expect(runText(run, false).text.length).toBeGreaterThan(0)
    }
  })
})

describe('scopeText — a scope is a decision about REACH', () => {
  it('says what each one actually does', () => {
    expect(scopeText('user', false).reach).toContain('every project')
    expect(scopeText('local', false).reach).toContain('this directory')
    // The consequence worth stating: it is a file other people pull.
    expect(scopeText('project', false).reach).toContain('everyone who clones')
  })
})

describe('offerableScopes — a control that cannot work is ABSENT', () => {
  it('offers the per-directory scopes only when there is a directory', () => {
    expect(offerableScopes('/repo')).toEqual(['user', 'local', 'project'])
    // Silently widening either to `user` would configure every project from a button that said
    // "this repository".
    expect(offerableScopes(undefined)).toEqual(['user'])
  })
})

describe('the rest', () => {
  it('counts what is running', () => {
    expect(runningMcpCount([entry({ state: 'running', pids: [1] }), entry({ state: 'idle' })])).toBe(1)
    expect(runningMcpCount(null)).toBe(0)
  })

  it('names what does work when the CLI is missing', () => {
    expect(cannotWriteText(false)).toContain('show it, not change it')
  })
})
