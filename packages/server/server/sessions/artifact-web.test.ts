/**
 * The IO half of the artifacts route, against a real directory.
 *
 * `artifact-file.test.ts` pins the RULE with no filesystem in it. This pins the two things only a
 * disk can answer — whether a path escapes once resolved, and whether the bytes are text — and in
 * particular the case a request cannot construct by hand: a path that IS in the allowlist and
 * whose `realpath` lands outside the session's folder. That is what the containment gate is FOR,
 * and without a symlink there is no way to reach it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_ARTIFACT_BYTES, readArtifact } from './artifact-web'

let root = ''
let cwd = ''
let outside = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentistics-artifact-'))
  cwd = join(root, 'proj')
  outside = join(root, 'elsewhere')
  await mkdir(join(cwd, 'docs'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await mkdir(join(cwd, 'adir'), { recursive: true })

  await writeFile(join(cwd, 'docs', 'spec.md'), '# Spec\n\nA line.\n')
  await writeFile(join(outside, 'secret.txt'), 'SECRET-CONTENT-MUST-NEVER-BE-RETURNED\n')
  await writeFile(join(cwd, 'bin.dat'), Buffer.from([0x41, 0x42, 0x00, 0x43]))
  await writeFile(join(cwd, 'big.md'), 'x'.repeat(MAX_ARTIFACT_BYTES + 4096))
  // A file INSIDE the project that is really a door out of it.
  await symlink(join(outside, 'secret.txt'), join(cwd, 'escape.md'))
})

afterAll(async () => { await rm(root, { recursive: true, force: true }) })

describe('readArtifact', () => {
  it('returns the text of a file the session wrote, with its size and relative path', async () => {
    const p = join(cwd, 'docs', 'spec.md')
    const out = await readArtifact('en', cwd, [p], p)
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('expected ok')
    expect(out.text).toContain('# Spec')
    expect(out.relPath).toBe('docs/spec.md')
    expect(out.truncated).toBe(false)
    expect(out.bytes).toBeGreaterThan(0)
  })

  it('REFUSES an allowlisted path whose symlink resolves outside the cwd, and leaks no byte of it', async () => {
    // The membership gate cannot catch this: the escaping path is one the session really touched.
    // Only resolving BOTH sides and comparing by segment does.
    const p = join(cwd, 'escape.md')
    const out = await readArtifact('en', cwd, [p], p)
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('a symlink out of the project was READ')
    expect(out.message).toContain('outside')
    expect(JSON.stringify(out)).not.toContain('SECRET-CONTENT')
  })

  it('refuses a path the session never touched', async () => {
    const out = await readArtifact('en', cwd, [join(cwd, 'docs', 'spec.md')], join(cwd, 'bin.dat'))
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected refusal')
    expect(out.message).toContain('did not write')
  })

  it('refuses a directory in words rather than rendering it', async () => {
    const p = join(cwd, 'adir')
    const out = await readArtifact('en', cwd, [p], p)
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected refusal')
    expect(out.message).toContain('folder')
  })

  it('refuses a binary file rather than showing garbage', async () => {
    const p = join(cwd, 'bin.dat')
    const out = await readArtifact('en', cwd, [p], p)
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected refusal')
    expect(out.message).toContain('not text')
  })

  it('truncates a file over the cap and SAYS so, reporting the real size', async () => {
    // A spec silently cut short is a document lying about being complete.
    const p = join(cwd, 'big.md')
    const out = await readArtifact('en', cwd, [p], p)
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('expected ok')
    expect(out.truncated).toBe(true)
    expect(out.text.length).toBe(MAX_ARTIFACT_BYTES)
    expect(out.bytes).toBe(MAX_ARTIFACT_BYTES + 4096)
  })

  it('refuses a path that no longer exists', async () => {
    const p = join(cwd, 'gone.md')
    const out = await readArtifact('en', cwd, [p], p)
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected refusal')
    expect(out.message).toContain('could not be read')
  })

  it('renders its refusals in the caller’s language', async () => {
    const out = await readArtifact('pt', cwd, [], join(cwd, 'docs', 'spec.md'))
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('expected refusal')
    expect(out.message).toContain('não escreveu')
  })
})
