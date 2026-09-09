import { describe, expect, it } from 'bun:test'
import { commandToken, knownCommands } from './commandToken'

const known = new Set(['serena', 'superpowers:brainstorming', 'update-docs'])

describe('what the leading token is', () => {
  it('finds a command the session offers', () => {
    const t = commandToken('/serena', known)
    expect(t).toEqual({ text: '/serena', start: 0, end: 7, state: 'found' })
  })

  it('finds a plugin command by its full package:skill name', () => {
    expect(commandToken('/superpowers:brainstorming', known)?.state).toBe('found')
  })

  it('reports a command the list does not have as MISSING', () => {
    expect(commandToken('/serana', known)?.state).toBe('missing')
  })

  it('keeps the token while an argument is being typed after it', () => {
    const t = commandToken('/serena find the symbol', known)
    expect(t?.text).toBe('/serena')
    expect(t?.end).toBe(7)
    expect(t?.state).toBe('found')
  })
})

describe('what is NOT a command', () => {
  it('ignores a slash that is not at the head of the draft', () => {
    expect(commandToken('run /serena now', known)).toBeNull()
  })

  it('ignores a path, because the first segment is followed by another slash', () => {
    expect(commandToken('/home/mithrandir/agentistics', known)).toBeNull()
  })

  it('ignores a bare slash and an empty draft', () => {
    expect(commandToken('/', known)).toBeNull()
    expect(commandToken('', known)).toBeNull()
  })
})

describe('UNKNOWN is not MISSING', () => {
  it('claims nothing when no list has been read', () => {
    // The list is fetched when the picker first opens, so the first command of a session is typed
    // before any answer has arrived. Calling it missing there would be a warning about nothing.
    expect(commandToken('/serena', null)?.state).toBe('unknown')
    expect(commandToken('/nonsense', null)?.state).toBe('unknown')
  })

  it('treats an EMPTY list as a real answer, not an absent one', () => {
    // A session that offers nothing is a fact the server can report, and every command is missing.
    expect(commandToken('/serena', new Set())?.state).toBe('missing')
  })
})

describe('knownCommands', () => {
  it('carries null through rather than inventing an empty set', () => {
    expect(knownCommands(null)).toBeNull()
  })

  it('builds the set off the reported names', () => {
    const set = knownCommands([{ name: 'serena' }, { name: 'update-docs' }])
    expect(set?.has('serena')).toBe(true)
    expect(set?.has('nope')).toBe(false)
  })
})
