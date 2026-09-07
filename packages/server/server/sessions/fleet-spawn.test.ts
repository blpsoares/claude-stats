/**
 * fleet-spawn.test.ts — the checks the cockpit's wizard performs by construction, performed
 * explicitly on a request that arrived over HTTP.
 */
import { describe, expect, it } from 'bun:test'
import { planFleetSpawn, type SpawnHarness } from './fleet-spawn'

const HARNESSES: SpawnHarness[] = [
  { id: 'claude', supportsModel: true, efforts: [] },
  { id: 'codex', supportsModel: true, efforts: [] },
  { id: 'agy', supportsModel: true, efforts: ['low', 'medium', 'high'] },
  { id: 'kimi', supportsModel: false, efforts: [] },
]

describe('planFleetSpawn', () => {
  it('accepts the ordinary request and never asks to attach', () => {
    const out = planFleetSpawn({ harness: 'claude', cwd: '/home/me/repo' }, HARNESSES)
    expect(out).toEqual({
      ok: true,
      plan: { harness: 'claude', cwd: '/home/me/repo', attach: false },
    })
  })

  it('carries every optional field through, trimmed', () => {
    const out = planFleetSpawn({
      harness: 'agy',
      cwd: '/srv/work',
      task: '  ship it  ',
      prompt: ' read the docs ',
      model: ' gemini-3.6-flash ',
      effort: 'high',
      label: ' docs pass ',
    }, HARNESSES)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.plan).toEqual({
      harness: 'agy',
      cwd: '/srv/work',
      task: 'ship it',
      prompt: 'read the docs',
      model: 'gemini-3.6-flash',
      effort: 'high',
      label: 'docs pass',
      attach: false,
    })
  })

  it('treats a blank optional field as absent, never as an empty value', () => {
    // A label of '' would name a row with nothing, and the row would then have no name at all
    // rather than the derived one.
    const out = planFleetSpawn({ harness: 'claude', cwd: '/x', label: '   ', task: '' }, HARNESSES)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.plan).not.toHaveProperty('label')
    expect(out.plan).not.toHaveProperty('task')
  })

  it('refuses a harness this machine cannot start, and names it', () => {
    const out = planFleetSpawn({ harness: 'gemini', cwd: '/x' }, HARNESSES)
    expect(out).toEqual({ ok: false, reason: 'unknown_harness', detail: 'gemini' })
  })

  it('refuses a missing harness without inventing a detail', () => {
    expect(planFleetSpawn({ cwd: '/x' }, HARNESSES)).toEqual({ ok: false, reason: 'unknown_harness' })
  })

  it('refuses a relative directory rather than resolving it', () => {
    // It would resolve against the SERVER's working directory — wherever `agentop server` was
    // started — and the session would open somewhere nobody named.
    expect(planFleetSpawn({ harness: 'claude', cwd: 'repo' }, HARNESSES))
      .toEqual({ ok: false, reason: 'cwd_relative', detail: 'repo' })
    expect(planFleetSpawn({ harness: 'claude', cwd: './repo' }, HARNESSES))
      .toEqual({ ok: false, reason: 'cwd_relative', detail: './repo' })
    expect(planFleetSpawn({ harness: 'claude', cwd: '~/repo' }, HARNESSES))
      .toEqual({ ok: false, reason: 'cwd_relative', detail: '~/repo' })
  })

  it('refuses a Windows path — there is no Windows session backend to honour it', () => {
    expect(planFleetSpawn({ harness: 'claude', cwd: 'C:\\src\\repo' }, HARNESSES).ok).toBe(false)
  })

  it('refuses a path carrying a NUL byte', () => {
    // It truncates the path in every syscall that eventually receives it.
    expect(planFleetSpawn({ harness: 'claude', cwd: '/home/me\0/etc' }, HARNESSES).ok).toBe(false)
  })

  it('refuses a missing directory outright', () => {
    expect(planFleetSpawn({ harness: 'claude' }, HARNESSES)).toEqual({ ok: false, reason: 'cwd_missing' })
    expect(planFleetSpawn({ harness: 'claude', cwd: '   ' }, HARNESSES)).toEqual({ ok: false, reason: 'cwd_missing' })
  })

  it('validates effort against the CLI\'s own closed enum', () => {
    expect(planFleetSpawn({ harness: 'agy', cwd: '/x', effort: 'ultra' }, HARNESSES))
      .toEqual({ ok: false, reason: 'unknown_effort', detail: 'ultra' })
    // A harness with no effort flag has an EMPTY enum, so any effort is refused rather than sent.
    expect(planFleetSpawn({ harness: 'claude', cwd: '/x', effort: 'high' }, HARNESSES).ok).toBe(false)
  })

  it('never validates a model, only whether the harness has the flag', () => {
    // `claude --help` documents --model as an alias "or a model's full name": a fixed list would
    // reject valid input the day a model ships.
    const out = planFleetSpawn({ harness: 'claude', cwd: '/x', model: 'some-model-shipped-today' }, HARNESSES)
    expect(out.ok).toBe(true)
    expect(planFleetSpawn({ harness: 'kimi', cwd: '/x', model: 'anything' }, HARNESSES))
      .toEqual({ ok: false, reason: 'model_unsupported', detail: 'kimi' })
    // …and a harness with no model flag is perfectly startable without one.
    expect(planFleetSpawn({ harness: 'kimi', cwd: '/x' }, HARNESSES).ok).toBe(true)
  })

  it('is total — a body of junk is refused, never thrown on', () => {
    expect(planFleetSpawn({ harness: 42, cwd: [] } as never, HARNESSES).ok).toBe(false)
    expect(planFleetSpawn({} as never, HARNESSES).ok).toBe(false)
    expect(planFleetSpawn({ harness: 'claude', cwd: '/x', effort: 7 } as never, HARNESSES).ok).toBe(true)
  })

  it('refuses everything when this machine can start nothing', () => {
    expect(planFleetSpawn({ harness: 'claude', cwd: '/x' }, []).ok).toBe(false)
  })
})
