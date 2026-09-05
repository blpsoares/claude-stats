/**
 * backup-routes.test.ts — the GitHub versioning section behind Settings -> Backup.
 *
 * Every test here passes an explicit config path, so the suite never reads or writes the
 * operator's own `~/.agentistics/github-backup.json`.
 */
import { describe, test, expect } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readGithubConfig, writeGithubConfig } from './backup/github-store'
import { connectGithub, readGithubSection, updateGithubSection } from './backup-routes'


describe('the GitHub versioning section — the token never leaves the machine', () => {
  test('the status a route may return carries the repository and the label, never the token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentistics-ghroute-'))
    const file = join(dir, 'github.json')
    await writeGithubConfig({
      url: 'https://github.com/me/backups', owner: 'me', repo: 'backups',
      token: 'ghp_a_real_looking_secret_value', keepRemote: 5,
      deleteLocalAfterUpload: true, label: 'notebook',
    }, file)

    const status = await readGithubSection(file)
    expect(status.configured).toBe(true)
    if (!status.configured) return
    expect(status.repo).toBe('me/backups')
    expect(status.label).toBe('notebook')
    expect(status.keepRemote).toBe(5)
    expect(status.deleteLocalAfterUpload).toBe(true)
    // The one assertion this test exists for. Asserted over the WHOLE serialized value, not over a
    // field list: a field added later that happens to carry the token would pass a key-by-key check.
    expect(JSON.stringify(status)).not.toContain('ghp_')
    rmSync(dir, { recursive: true, force: true })
  })

  test('an unconfigured machine says so, and says nothing else', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentistics-ghroute-'))
    const status = await readGithubSection(join(dir, 'nothing.json'))
    expect(status).toEqual({ configured: false })
    rmSync(dir, { recursive: true, force: true })
  })

  test('the label can be changed without re-entering the token', async () => {
    // Renaming a machine must not require pasting a PAT again — a flow that asks for a credential
    // to perform something unrelated is a flow that teaches people to paste credentials.
    const dir = mkdtempSync(join(tmpdir(), 'agentistics-ghroute-'))
    const file = join(dir, 'github.json')
    await writeGithubConfig({
      url: 'https://github.com/me/backups', owner: 'me', repo: 'backups',
      token: 'ghp_secret', keepRemote: 0, deleteLocalAfterUpload: false, label: 'old-name',
    }, file)

    const res = await updateGithubSection({ label: 'desktop de casa' }, file)
    expect(res.ok).toBe(true)
    const after = await readGithubConfig(file)
    expect(after?.label).toBe('desktop de casa')
    expect(after?.token).toBe('ghp_secret')
  })

  test('an update on an unconfigured machine is refused, never a half-written config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentistics-ghroute-'))
    const file = join(dir, 'nothing.json')
    const res = await updateGithubSection({ label: 'x' }, file)
    expect(res.ok).toBe(false)
    expect(existsSync(file)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})

test('the cockpit contract carries the GitHub section, and it is the SAME shape the route returns', async () => {
  // The cockpit's `backup` tab renders `githubRows` from `ControlBackupStatus.github`. Without the
  // field the tab drew "not configured" on a machine that WAS configured — a screen stating the
  // opposite of the truth, which is worse than one saying nothing. `GithubSection` is declared once
  // here and mirrored (never imported — tui may not import from server) in `tui/control/backup.ts`.
  const dir = mkdtempSync(join(tmpdir(), 'agentistics-ghcontract-'))
  const file = join(dir, 'github.json')
  await writeGithubConfig({
    url: 'https://github.com/me/backups', owner: 'me', repo: 'backups',
    token: 'ghp_never_leaves', keepRemote: 3, deleteLocalAfterUpload: true, label: 'notebook',
  }, file)

  const section = await readGithubSection(file)
  // The tui mirror declares exactly these keys. A field added on one side and not the other is
  // what this assertion exists to catch, before a cockpit renders `undefined`.
  expect(Object.keys(section).sort())
    .toEqual(['configured', 'deleteLocalAfterUpload', 'keepRemote', 'label', 'repo', 'url'])
  expect(JSON.stringify(section)).not.toContain('ghp_')
  rmSync(dir, { recursive: true, force: true })
})

describe('connecting a repository FROM the interface', () => {
  const ok = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  test('a private repository the token can push to is connected, and the token is stored not returned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentistics-ghconnect-'))
    const file = join(dir, 'github.json')
    const res = await connectGithub({
      url: 'https://github.com/me/backups', token: 'ghp_written_only_to_disk',
      file, fetchImpl: async () => ok({ private: true, permissions: { push: true } }),
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // The reply is the same shape the GET returns, so the page has nothing extra to trust.
    expect(res.section.configured).toBe(true)
    expect(JSON.stringify(res)).not.toContain('ghp_')
    // ...and the token IS on disk, or the next upload would have nothing to authenticate with.
    expect((await readGithubConfig(file))?.token).toBe('ghp_written_only_to_disk')
    rmSync(dir, { recursive: true, force: true })
  })

  test('a PUBLIC repository is refused, and nothing is written', async () => {
    // The refusal that matters most: a backup carries this machine's metrics, its first prompts and
    // a map of its directories. Saying it is private in a form does not count — only the API
    // answering `private: true` does.
    const dir = mkdtempSync(join(tmpdir(), 'agentistics-ghconnect-'))
    const file = join(dir, 'github.json')
    const res = await connectGithub({
      url: 'https://github.com/me/public-repo', token: 'ghp_x',
      file, fetchImpl: async () => ok({ private: false, permissions: { push: true } }),
    })
    expect(res.ok).toBe(false)
    expect(existsSync(file)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('a host that is not github.com is refused BEFORE any request is made', async () => {
    // Sending a token to a host the user mistyped is the one mistake that cannot be undone, so no
    // request may leave until the URL has been read.
    let called = false
    const res = await connectGithub({
      url: 'https://gitlab.com/me/backups', token: 'ghp_x',
      file: join(mkdtempSync(join(tmpdir(), 'agentistics-ghconnect-')), 'g.json'),
      fetchImpl: async () => { called = true; return ok({}) },
    })
    expect(res.ok).toBe(false)
    expect(called).toBe(false)
  })

  test('an empty url or token is refused without a request', async () => {
    let called = false
    const f = async (): Promise<Response> => { called = true; return ok({}) }
    const dir = mkdtempSync(join(tmpdir(), 'agentistics-ghconnect-'))
    expect((await connectGithub({ url: '', token: 'ghp_x', file: join(dir, 'a.json'), fetchImpl: f })).ok).toBe(false)
    expect((await connectGithub({ url: 'https://github.com/a/b', token: '  ', file: join(dir, 'b.json'), fetchImpl: f })).ok).toBe(false)
    expect(called).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})
