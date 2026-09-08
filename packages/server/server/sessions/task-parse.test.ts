import { describe, expect, it } from 'bun:test'
import { parseTaskArgs } from './task-parse'

describe('parseTaskArgs', () => {
  it('lists on the bare command and on ls', () => {
    // The commonest question must not need a subcommand to ask.
    expect(parseTaskArgs([])).toEqual({ kind: 'ls' })
    expect(parseTaskArgs(['ls'])).toEqual({ kind: 'ls' })
    expect(parseTaskArgs(['list'])).toEqual({ kind: 'ls' })
  })

  it('carries --json without letting it become the reference', () => {
    expect(parseTaskArgs(['ls', '--json'])).toEqual({ kind: 'ls', json: true })
    expect(parseTaskArgs(['show', '--json', 'pizzeria']))
      .toEqual({ kind: 'show', ref: 'pizzeria', json: true })
  })

  it('joins a multi-word name rather than demanding quotes', () => {
    // A task is named by a person and those names have spaces. Requiring quotes would make the
    // commonest invocation the one that fails.
    expect(parseTaskArgs(['show', 'landing', 'page', 'pizzaria']))
      .toEqual({ kind: 'show', ref: 'landing page pizzaria' })
  })

  it('parses deliver and abandon', () => {
    expect(parseTaskArgs(['deliver', 'x'])).toEqual({ kind: 'deliver', ref: 'x' })
    expect(parseTaskArgs(['abandon', 'x'])).toEqual({ kind: 'abandon', ref: 'x' })
  })

  it('refuses a verb with no reference', () => {
    for (const verb of ['show', 'deliver', 'abandon']) {
      expect(parseTaskArgs([verb]).kind).toBe('error')
    }
  })

  it('refuses an unknown subcommand and names the usage', () => {
    const cmd = parseTaskArgs(['frobnicate'])
    expect(cmd.kind).toBe('error')
    if (cmd.kind !== 'error') return
    expect(cmd.message).toContain('agentop task')
  })

  it('answers help', () => {
    expect(parseTaskArgs(['--help'])).toEqual({ kind: 'help' })
    expect(parseTaskArgs(['help'])).toEqual({ kind: 'help' })
  })
})

describe('share', () => {
  it('reads both directions as one command carrying the state', () => {
    expect(parseTaskArgs(['share', 'the ALM board']))
      .toEqual({ kind: 'share', ref: 'the ALM board', on: true })
    expect(parseTaskArgs(['unshare', 'the ALM board']))
      .toEqual({ kind: 'share', ref: 'the ALM board', on: false })
  })

  it('joins a name with spaces, like every other ref', () => {
    expect(parseTaskArgs(['share', 'two', 'words'])).toMatchObject({ ref: 'two words' })
  })

  it('refuses without a task, rather than acting on some default', () => {
    expect(parseTaskArgs(['share'])).toMatchObject({ kind: 'error' })
  })

  it('carries --json', () => {
    expect(parseTaskArgs(['share', 'x', '--json'])).toEqual({ kind: 'share', ref: 'x', on: true, json: true })
  })
})
