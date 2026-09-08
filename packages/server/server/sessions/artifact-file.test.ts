import { describe, expect, it } from 'bun:test'
import { artifactPathsFromTurns, planArtifactRead } from './artifact-file'

const cwd = '/home/u/proj'
/** A path nothing redirected: the transcript's name and the real file are the same place. */
const same = (p: string) => ({ named: p, real: p })
const allowed = [same('/home/u/proj/docs/spec.md'), same('/home/u/proj/src/a.ts')]

describe('planArtifactRead', () => {
  it('allows a path the session touched, inside the cwd', () => {
    expect(planArtifactRead({ path: '/home/u/proj/docs/spec.md', cwd, allowed }))
      .toEqual({ ok: true, path: '/home/u/proj/docs/spec.md' })
  })

  it('refuses a path the session never touched, even inside the cwd', () => {
    // The reachable set is a consequence of what the session DID, not a rule about directories.
    // `/home/u/proj/.env` is in the project and has nothing to do with this conversation.
    expect(planArtifactRead({ path: '/home/u/proj/.env', cwd, allowed }))
      .toEqual({ ok: false, reason: 'not-touched' })
  })

  /**
   * THE ESCAPE — the whole reason gate 2 exists. The session wrote `./notes.md`; that is a link to
   * a key. The transcript NAMED `/home/u/proj/notes.md` and it REALLY IS `/home/u/.ssh/id_ed25519`,
   * so resolution moved it and it is not in the folder either. Refused.
   */
  it('refuses a path that resolution MOVED out of the session\'s reach', () => {
    expect(planArtifactRead({
      path: '/home/u/.ssh/id_ed25519', cwd,
      allowed: [{ named: '/home/u/proj/notes.md', real: '/home/u/.ssh/id_ed25519' }],
    })).toEqual({ ok: false, reason: 'escaped' })
  })

  /**
   * THE CASE THE OLD RULE GOT WRONG. Writing a memory in this product IS writing to
   * `~/.claude/projects/<project>/memory/MEMORY.md` — outside the cwd, named exactly where it is,
   * nothing redirected. The panel listed it and the reader refused it: two halves of one screen
   * disagreeing about the same file.
   */
  it('allows a path OUTSIDE the cwd when nothing redirected it', () => {
    const memory = '/home/u/.claude/projects/-home-u-proj/memory/MEMORY.md'
    expect(planArtifactRead({ path: memory, cwd, allowed: [same(memory)] }))
      .toEqual({ ok: true, path: memory })
  })

  it('still refuses a sibling directory whose name merely starts with the cwd, when it MOVED', () => {
    // `/home/u/proj-secrets` starts with `/home/u/proj` as a STRING and is a different directory.
    // Containment is by path SEGMENT, never by prefix — and the escape is what denies it here.
    expect(planArtifactRead({
      path: '/home/u/proj-secrets/x.md', cwd,
      allowed: [{ named: '/home/u/proj/x.md', real: '/home/u/proj-secrets/x.md' }],
    })).toEqual({ ok: false, reason: 'escaped' })
  })

  /**
   * A machine whose project sits behind a symlink — `~/code` → `/mnt/data/code`. Both sides are
   * resolved, so every file in it is inside the cwd and passes on the SECOND half of the union.
   * Without that half this rule would refuse an entire ordinary machine.
   */
  it('allows a redirected path that still lands inside the session\'s own folder', () => {
    expect(planArtifactRead({
      path: '/home/u/proj/src/a.ts', cwd,
      allowed: [{ named: '/home/u/link/src/a.ts', real: '/home/u/proj/src/a.ts' }],
    })).toEqual({ ok: true, path: '/home/u/proj/src/a.ts' })
  })

  it('refuses the cwd itself — a directory is not a file', () => {
    expect(planArtifactRead({ path: cwd, cwd, allowed: [same(cwd)] }))
      .toEqual({ ok: false, reason: 'not-a-file' })
  })

  it('refuses an empty path without pretending it is anything else', () => {
    expect(planArtifactRead({ path: '', cwd, allowed }))
      .toEqual({ ok: false, reason: 'not-touched' })
  })

  it('checks membership BEFORE containment, so an unrelated path never reveals the cwd', () => {
    // Answering `escaped` for a path nobody asked about would confirm where the cwd is not.
    expect(planArtifactRead({ path: '/etc/passwd', cwd, allowed }).ok).toBe(false)
    expect(planArtifactRead({ path: '/etc/passwd', cwd, allowed }))
      .toEqual({ ok: false, reason: 'not-touched' })
  })
})

describe('artifactPathsFromTurns', () => {
  const turn = (tools: { name: string; detail?: string }[]) => ({ tools })

  it('collects the paths of the file tools, deduped', () => {
    expect(artifactPathsFromTurns([
      turn([{ name: 'Write', detail: '/p/a.ts' }]),
      turn([{ name: 'Edit', detail: '/p/a.ts' }, { name: 'MultiEdit', detail: '/p/b.ts' }]),
      turn([{ name: 'NotebookEdit', detail: '/p/n.ipynb' }]),
    ])).toEqual(['/p/a.ts', '/p/b.ts', '/p/n.ipynb'])
  })

  it('NEVER takes a Bash command for a path — this is the copy that guards the disk', () => {
    expect(artifactPathsFromTurns([turn([{ name: 'Bash', detail: 'rm -rf build/' }])])).toEqual([])
  })

  it('excludes Read, exactly as the browser does', () => {
    expect(artifactPathsFromTurns([turn([{ name: 'Read', detail: '/p/secret.env' }])])).toEqual([])
  })

  it('ignores a truncated detail — an ellipsised path names no file', () => {
    const detail = `${`/home/u/${'x'.repeat(210)}.ts`.slice(0, 200)}…`
    expect(artifactPathsFromTurns([turn([{ name: 'Write', detail }])])).toEqual([])
  })

  it('ignores a call with no detail, and never throws on an empty conversation', () => {
    expect(artifactPathsFromTurns([turn([{ name: 'Write' }])])).toEqual([])
    expect(artifactPathsFromTurns([])).toEqual([])
    expect(artifactPathsFromTurns([{} as never])).toEqual([])
  })
})
