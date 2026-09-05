import { describe, expect, it } from 'bun:test'
import { artifactsFromTurns, hasUnlistedWrites } from './sessionArtifacts'

const turn = (tools: { name: string; detail?: string }[], pending = false) =>
  ({ role: 'assistant' as const, text: '', tools, ...(pending ? { pending: true } : {}) })

describe('artifactsFromTurns', () => {
  it('lists a written file, newest first', () => {
    const out = artifactsFromTurns([
      turn([{ name: 'Write', detail: '/home/u/p/a.ts' }]),
      turn([{ name: 'Write', detail: '/home/u/p/docs/b.md' }]),
    ])
    expect(out.map(a => a.path)).toEqual(['/home/u/p/docs/b.md', '/home/u/p/a.ts'])
  })

  it('splits a path into the name and the directory that carries it', () => {
    const [a] = artifactsFromTurns([turn([{ name: 'Write', detail: '/home/u/p/docs/specs/b.md' }])])
    expect(a!.name).toBe('b.md')
    expect(a!.dir).toBe('/home/u/p/docs/specs')
  })

  it('NEVER takes a Bash command for a path', () => {
    // `toolDetail` reads `command` FIRST, so a shell call's detail is a shell line. Selecting by
    // the shape of `detail` would put `rm -rf build/` in a list of files.
    expect(artifactsFromTurns([turn([{ name: 'Bash', detail: 'rm -rf build/' }])])).toEqual([])
  })

  it('excludes Read — the list is what the session PRODUCED', () => {
    expect(artifactsFromTurns([turn([{ name: 'Read', detail: '/home/u/p/a.ts' }])])).toEqual([])
  })

  it('folds repeated touches of one path into one row and counts them', () => {
    const out = artifactsFromTurns([
      turn([{ name: 'Write', detail: '/home/u/p/a.ts' }]),
      turn([{ name: 'Edit', detail: '/home/u/p/a.ts' }]),
      turn([{ name: 'Edit', detail: '/home/u/p/a.ts' }]),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.touches).toBe(3)
  })

  it('calls it new when the session first WROTE it, edited when it first edited it', () => {
    const written = artifactsFromTurns([
      turn([{ name: 'Write', detail: '/home/u/p/a.ts' }]),
      turn([{ name: 'Edit', detail: '/home/u/p/a.ts' }]),
    ])
    expect(written[0]!.kind).toBe('new')
    const edited = artifactsFromTurns([turn([{ name: 'Edit', detail: '/home/u/p/b.ts' }])])
    expect(edited[0]!.kind).toBe('edited')
  })

  it('marks the file of a PENDING turn as the one being written now', () => {
    const out = artifactsFromTurns([
      turn([{ name: 'Write', detail: '/home/u/p/a.ts' }]),
      turn([{ name: 'Write', detail: '/home/u/p/b.ts' }], true),
    ])
    expect(out.find(a => a.name === 'b.ts')!.live).toBe(true)
    expect(out.find(a => a.name === 'a.ts')!.live).toBe(false)
  })

  it('marks nothing live once the pending turn has finished', () => {
    const out = artifactsFromTurns([turn([{ name: 'Write', detail: '/home/u/p/a.ts' }])])
    expect(out.every(a => !a.live)).toBe(true)
  })

  it('takes MultiEdit and NotebookEdit too', () => {
    const out = artifactsFromTurns([
      turn([{ name: 'MultiEdit', detail: '/home/u/p/a.ts' }]),
      turn([{ name: 'NotebookEdit', detail: '/home/u/p/n.ipynb' }]),
    ])
    expect(out).toHaveLength(2)
  })

  it('ignores a tool call with no detail — there is no path to show', () => {
    expect(artifactsFromTurns([turn([{ name: 'Write' }])])).toEqual([])
  })

  it('is empty for a conversation with no tools at all, and never throws', () => {
    expect(artifactsFromTurns([])).toEqual([])
    expect(artifactsFromTurns([{ role: 'user', text: 'hi' } as never])).toEqual([])
  })

  it('ignores a truncated detail — `toolDetail` appends an ellipsis past 200 chars', () => {
    // A truncated path names no file, and asking the server for one would be a refusal every time.
    const long = `/home/u/${'x'.repeat(210)}.ts`
    const detail = `${long.slice(0, 200)}…`
    expect(artifactsFromTurns([turn([{ name: 'Write', detail }])])).toEqual([])
  })
})

describe('files the SHELL wrote', () => {
  it('counts a redirection as a file this session wrote', () => {
    // Measured on a real conversation: 400 turns, 263 Bash calls, ZERO file-tool calls. Reading
    // only the file tools reported "nothing written" over eighty files.
    const a = artifactsFromTurns([
      { tools: [{ name: 'Bash', detail: 'cd /repo', writes: ['packages/web/src/x.ts'] }] },
    ])
    expect(a.map(x => x.path)).toEqual(['packages/web/src/x.ts'])
  })

  it('a shell write and a file-tool write of the same path are ONE row', () => {
    const a = artifactsFromTurns([
      { tools: [{ name: 'Bash', detail: 'cd /r', writes: ['a.ts'] }] },
      { tools: [{ name: 'Edit', detail: 'a.ts' }] },
    ])
    expect(a).toHaveLength(1)
    expect(a[0]!.touches).toBe(2)
  })

  it('says when writes exist that it CANNOT list, so "nothing" is never claimed falsely', () => {
    expect(hasUnlistedWrites([{ tools: [{ name: 'Bash', detail: 'cd /r', opaqueWrite: true }] }]))
      .toBe(true)
    expect(hasUnlistedWrites([{ tools: [{ name: 'Bash', detail: 'git status' }] }])).toBe(false)
    expect(hasUnlistedWrites([])).toBe(false)
  })
})
