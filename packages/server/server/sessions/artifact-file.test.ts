import { describe, expect, it } from 'bun:test'
import { artifactPathsFromTurns, planArtifactRead } from './artifact-file'

const cwd = '/home/u/proj'
const allowed = ['/home/u/proj/docs/spec.md', '/home/u/proj/src/a.ts']

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

  it('refuses a resolved path outside the cwd', () => {
    // The caller resolves first, so this is what an escaping symlink or a `..` LOOKS like here.
    expect(planArtifactRead({ path: '/home/u/.ssh/id_ed25519', cwd, allowed: ['/home/u/.ssh/id_ed25519'] }))
      .toEqual({ ok: false, reason: 'outside-cwd' })
  })

  it('refuses a sibling directory whose name merely starts with the cwd', () => {
    // `/home/u/proj-secrets` starts with `/home/u/proj` as a STRING and is a different directory.
    // Containment is by path SEGMENT, never by prefix.
    expect(planArtifactRead({
      path: '/home/u/proj-secrets/x.md', cwd, allowed: ['/home/u/proj-secrets/x.md'],
    })).toEqual({ ok: false, reason: 'outside-cwd' })
  })

  it('refuses the cwd itself — a directory is not a file', () => {
    expect(planArtifactRead({ path: cwd, cwd, allowed: [cwd] }))
      .toEqual({ ok: false, reason: 'not-a-file' })
  })

  it('refuses an empty path without pretending it is anything else', () => {
    expect(planArtifactRead({ path: '', cwd, allowed }))
      .toEqual({ ok: false, reason: 'not-touched' })
  })

  it('checks membership BEFORE containment, so an unrelated path never reveals the cwd', () => {
    // Answering `outside-cwd` for a path nobody asked about would confirm where the cwd is not.
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
