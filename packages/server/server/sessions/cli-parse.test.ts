import { describe, expect, it } from 'bun:test'
import { LS_DEFAULT, parseSessionArgs } from './cli-parse'

describe('parseSessionArgs', () => {
  it('starts a background session on the given harness', () => {
    expect(parseSessionArgs(['claude', '--bg', '-p', 'fix the tests'])).toEqual({
      kind: 'start', harness: 'claude', background: true, prompt: 'fix the tests',
    })
  })

  it('attaches by default when --bg is absent', () => {
    expect(parseSessionArgs(['claude', '-p', 'hi'])).toEqual({
      kind: 'start', harness: 'claude', background: false, prompt: 'hi',
    })
  })

  it('reads model, effort, cwd and name', () => {
    expect(parseSessionArgs([
      'codex', '-p', 'do X', '--model', 'o3', '--effort', 'high', '--cwd', '/srv/app', '--name', 'refactor auth',
    ])).toEqual({
      kind: 'start', harness: 'codex', background: false, prompt: 'do X',
      model: 'o3', effort: 'high', cwd: '/srv/app', label: 'refactor auth',
    })
  })

  it('accepts a start with no prompt at all', () => {
    expect(parseSessionArgs(['kimi'])).toEqual({ kind: 'start', harness: 'kimi', background: false })
  })

  it('reads the subcommands', () => {
    expect(parseSessionArgs(['list'])).toEqual({ kind: 'list' })
    expect(parseSessionArgs(['attach', 'a1'])).toEqual({ kind: 'attach', ref: 'a1' })
    expect(parseSessionArgs(['kill', 'a1'])).toEqual({ kind: 'kill', ref: 'a1' })
    expect(parseSessionArgs(['rename', 'a1', 'refactor auth'])).toEqual({ kind: 'rename', ref: 'a1', label: 'refactor auth' })
    expect(parseSessionArgs(['note', 'a1', 'split the god object'])).toEqual({ kind: 'note', ref: 'a1', text: 'split the god object' })
  })

  it('ls defaults to the running sessions, grouped by project', () => {
    expect(parseSessionArgs(['ls'])).toEqual({ kind: 'ls', all: false, group: 'project' })
    expect(LS_DEFAULT).toEqual({ all: false, group: 'project' })
  })

  it('ls takes --all, --group, --json, --width and the colour override', () => {
    expect(parseSessionArgs(['ls', '--all', '--group', 'repo', '--json'])).toEqual({
      kind: 'ls', all: true, group: 'repo', json: true,
    })
    expect(parseSessionArgs(['ls', '-a', '-g', 'task'])).toEqual({ kind: 'ls', all: true, group: 'task' })
    expect(parseSessionArgs(['ls', '--width', '80', '--no-color'])).toEqual({
      kind: 'ls', all: false, group: 'project', width: 80, color: false,
    })
    expect(parseSessionArgs(['ls', '--color'])).toEqual({
      kind: 'ls', all: false, group: 'project', color: true,
    })
  })

  it('ls refuses a grouping the table cannot draw', () => {
    expect(parseSessionArgs(['ls', '--group', 'nonsense'])).toEqual({
      kind: 'error', message: expect.stringContaining('nonsense'),
    })
  })

  it('ls never swallows the next flag as a value', () => {
    // `--group --json` used to be the shape that grouped by "--json" and then printed no JSON.
    expect(parseSessionArgs(['ls', '--group', '--json'])).toEqual({
      kind: 'error', message: expect.stringContaining('Missing value'),
    })
    expect(parseSessionArgs(['ls', '--width', '--all'])).toEqual({
      kind: 'error', message: expect.stringContaining('Missing value'),
    })
  })

  it('ls refuses a width that is not a positive number of columns', () => {
    expect(parseSessionArgs(['ls', '--width', 'wide'])).toEqual({
      kind: 'error', message: expect.stringContaining('--width'),
    })
    expect(parseSessionArgs(['ls', '--width', '0'])).toEqual({
      kind: 'error', message: expect.stringContaining('--width'),
    })
  })

  it('ls rejects an option it does not know rather than ignoring it', () => {
    expect(parseSessionArgs(['ls', '--sort'])).toEqual({
      kind: 'error', message: expect.stringContaining('--sort'),
    })
  })

  it('list is untouched by ls — a script reading it keeps its dump', () => {
    expect(parseSessionArgs(['list'])).toEqual({ kind: 'list' })
    expect(parseSessionArgs(['list', '--json'])).toEqual({ kind: 'list', json: true })
  })

  it('rejects a harness that is not a harness', () => {
    expect(parseSessionArgs(['nonsense'])).toEqual({ kind: 'error', message: expect.stringContaining('nonsense') })
  })

  it('rejects a flag with no value instead of swallowing the next token', () => {
    expect(parseSessionArgs(['claude', '--model'])).toEqual({ kind: 'error', message: expect.stringContaining('--model') })
    expect(parseSessionArgs(['claude', '--model', '--bg'])).toEqual({ kind: 'error', message: expect.stringContaining('--model') })
  })

  it('rejects an unknown option instead of silently ignoring it', () => {
    expect(parseSessionArgs(['claude', '--nope'])).toEqual({ kind: 'error', message: expect.stringContaining('--nope') })
  })

  it('rejects two adjacent value flags rather than one swallowing the other as its value', () => {
    // `--model` has no value of its own here — `--cwd` is the next TOKEN, not a model id — so this
    // must be the same "missing value" error as `--model` followed by nothing at all.
    expect(parseSessionArgs(['claude', '--model', '--cwd', '/srv/app']))
      .toEqual({ kind: 'error', message: expect.stringContaining('--model') })
  })

  it('rejects a subcommand missing its reference', () => {
    expect(parseSessionArgs(['attach'])).toEqual({ kind: 'error', message: expect.stringContaining('attach') })
    expect(parseSessionArgs(['rename', 'a1'])).toEqual({ kind: 'error', message: expect.stringContaining('rename') })
  })

  it('asks for help with no arguments', () => {
    expect(parseSessionArgs([])).toEqual({ kind: 'help' })
  })
})

describe('batch — the form an assistant drives', () => {
  it('parses a task and one session per --session', () => {
    const cmd = parseSessionArgs([
      'batch', '--task', 'auth', '--session', 'claude: fix the store', '--session', 'codex: port tests',
    ])
    expect(cmd).toMatchObject({
      kind: 'batch',
      task: 'auth',
      specs: [
        { harness: 'claude', prompt: 'fix the store' },
        { harness: 'codex', prompt: 'port tests' },
      ],
    })
  })

  it('applies a shared --cwd to every session, and lets @ override it', () => {
    // A batch is usually many assistants on ONE repository, and repeating the path per session is
    // how a generated command line gets long enough to be got wrong.
    const cmd = parseSessionArgs([
      'batch', '--task', 't', '--cwd', '/repo',
      '--session', 'claude: a', '--session', 'codex@/other: b',
    ])
    expect(cmd).toMatchObject({
      specs: [{ cwd: '/repo' }, { cwd: '/other' }],
    })
  })

  it('refuses a batch with no task, because the sessions must belong together', () => {
    expect(parseSessionArgs(['batch', '--session', 'claude: a'])).toMatchObject({ kind: 'error' })
  })

  it('refuses a batch with no sessions', () => {
    expect(parseSessionArgs(['batch', '--task', 't'])).toMatchObject({ kind: 'error' })
  })

  it('refuses an unknown harness by name rather than starting nothing silently', () => {
    const cmd = parseSessionArgs(['batch', '--task', 't', '--session', 'gpt5: hi'])
    expect(cmd).toMatchObject({ kind: 'error' })
    expect((cmd as { message: string }).message).toContain('gpt5')
  })

  it('takes a session with no prompt at all', () => {
    expect(parseSessionArgs(['batch', '--task', 't', '--session', 'claude'])).toMatchObject({
      specs: [{ harness: 'claude' }],
    })
  })

  it('carries --json through', () => {
    expect(parseSessionArgs(['batch', '--task', 't', '--session', 'claude: a', '--json']))
      .toMatchObject({ json: true })
    expect(parseSessionArgs(['list', '--json'])).toMatchObject({ kind: 'list', json: true })
  })

  it('parses open with a multi-word task name', () => {
    expect(parseSessionArgs(['open', 'auth', 'refactor'])).toMatchObject({
      kind: 'open', task: 'auth refactor',
    })
  })
})

describe('batch --attempt', () => {
  it('applies to the sessions that follow it, until the next one', () => {
    const cmd = parseSessionArgs([
      'batch', '--task', 'pizzeria',
      '--attempt', 'opus, prompt only',
      '--session', 'claude: build it',
      '--session', 'claude: keep going',
      '--attempt', 'agy + flash, sdd',
      '--session', 'antigravity: build it',
    ])
    expect(cmd.kind).toBe('batch')
    if (cmd.kind !== 'batch') return
    expect(cmd.specs.map(s => s.attempt)).toEqual([
      'opus, prompt only', 'opus, prompt only', 'agy + flash, sdd',
    ])
  })

  it('leaves attempt unset when none was named, so a plain batch still works', () => {
    const cmd = parseSessionArgs(['batch', '--task', 'x', '--session', 'claude: go'])
    expect(cmd.kind).toBe('batch')
    if (cmd.kind !== 'batch') return
    expect(cmd.specs[0]!.attempt).toBeUndefined()
  })

  it('refuses an --attempt with no value rather than swallowing the next flag', () => {
    const cmd = parseSessionArgs(['batch', '--task', 'x', '--attempt', '--session', 'claude: go'])
    expect(cmd.kind).toBe('error')
  })
})
