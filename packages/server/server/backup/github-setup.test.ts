import { describe, test, expect } from 'bun:test'
import { statSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { setupGithubBackup } from './github-setup'
import { readGithubConfig } from './github-store'
import type { FetchLike } from './github-api'

const TOKEN = 'ghp_setupFlowTestToken1234567890abcdef'
const URL = 'https://github.com/someone/agentistics-backups'

/** A fake `fetch` returning one canned response for `GET /repos/o/r` — no network in tests. */
function repoResponder(body: unknown, status = 200): FetchLike {
  return async () => new Response(JSON.stringify(body), { status })
}

async function withTempFile(fn: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-github-setup-'))
  const file = join(dir, 'github-backup.json')
  try {
    await fn(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('setupGithubBackup — the host check runs before any request', () => {
  test('an unrecognized host is refused and names the host — no fetch is ever called', async () => {
    let called = false
    const fetchImpl: FetchLike = async () => { called = true; return new Response('{}', { status: 200 }) }
    const result = await setupGithubBackup({
      url: 'https://gitlab.com/someone/repo', token: TOKEN, fetchImpl,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('gitlab.com')
      expect(result.message).not.toBe('') // a sentence, never a bare code
    }
    expect(called).toBe(false)
  })

  test('unparseable input is refused with a sentence, not a raw parse failure', async () => {
    const result = await setupGithubBackup({ url: 'not a url at all', token: TOKEN })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0)
  })
})

describe('setupGithubBackup — a missing token is refused before any request', () => {
  test('an empty token is refused', async () => {
    let called = false
    const fetchImpl: FetchLike = async () => { called = true; return new Response('{}', { status: 200 }) }
    const result = await setupGithubBackup({ url: URL, token: '', fetchImpl })
    expect(result.ok).toBe(false)
    expect(called).toBe(false)
  })

  test('a whitespace-only token is refused', async () => {
    const result = await setupGithubBackup({ url: URL, token: '   ' })
    expect(result.ok).toBe(false)
  })
})

describe('setupGithubBackup — 404 gets the two-case sentence', () => {
  test('does not exist, or the token cannot see it — both are named', async () => {
    const fetchImpl = repoResponder({ message: 'Not Found' }, 404)
    const result = await setupGithubBackup({ url: URL, token: TOKEN, fetchImpl })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain('someone/agentistics-backups')
      // Both readings must be present — the API cannot distinguish them for a private repo.
      expect(result.message.toLowerCase()).toMatch(/not found|does not exist/)
      expect(result.message.toLowerCase()).toContain('token')
    }
  })
})

describe('setupGithubBackup — a PUBLIC repository is refused, and the API decides', () => {
  test('private: false is refused, whatever the caller believes', async () => {
    const fetchImpl = repoResponder({ private: false, permissions: { push: true } })
    const result = await setupGithubBackup({ url: URL, token: TOKEN, fetchImpl })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message.toLowerCase()).toContain('private')
  })

  test('a missing `private` field is treated the same as false — never assumed private', async () => {
    const fetchImpl = repoResponder({ permissions: { push: true } })
    const result = await setupGithubBackup({ url: URL, token: TOKEN, fetchImpl })
    expect(result.ok).toBe(false)
  })

  test('nothing is written to disk when the repository is public', async () => {
    await withTempFile(async (file) => {
      const fetchImpl = repoResponder({ private: false, permissions: { push: true } })
      await setupGithubBackup({ url: URL, token: TOKEN, fetchImpl, file })
      expect(await readGithubConfig(file)).toBeNull()
    })
  })
})

describe('setupGithubBackup — a token with no push access is refused', () => {
  test('permissions.push !== true is refused before the archive would ever be built', async () => {
    const fetchImpl = repoResponder({ private: true, permissions: { push: false } })
    const result = await setupGithubBackup({ url: URL, token: TOKEN, fetchImpl })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message.toLowerCase()).toContain('push')
  })

  test('an absent permissions object is treated as no push access', async () => {
    const fetchImpl = repoResponder({ private: true })
    const result = await setupGithubBackup({ url: URL, token: TOKEN, fetchImpl })
    expect(result.ok).toBe(false)
  })
})

describe('setupGithubBackup — the happy path', () => {
  test('a private repo with push access is written at mode 0600', async () => {
    await withTempFile(async (file) => {
      const fetchImpl = repoResponder({ private: true, permissions: { push: true } })
      const result = await setupGithubBackup({ url: URL, token: TOKEN, fetchImpl, file })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.config.owner).toBe('someone')
        expect(result.config.repo).toBe('agentistics-backups')
        expect(result.config.token).toBe(TOKEN)
      }
      const mode = statSync(file).mode & 0o777
      expect(mode).toBe(0o600)
      const stored = await readGithubConfig(file)
      expect(stored?.owner).toBe('someone')
      expect(stored?.token).toBe(TOKEN)
    })
  })

  test('keepRemote and deleteLocalAfterUpload default sensibly', async () => {
    await withTempFile(async (file) => {
      const fetchImpl = repoResponder({ private: true, permissions: { push: true } })
      const result = await setupGithubBackup({ url: URL, token: TOKEN, fetchImpl, file })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.config.keepRemote).toBe(0)
        expect(result.config.deleteLocalAfterUpload).toBe(false)
      }
    })
  })
})

// The enforcement the plan asks for, over the whole setup flow rather than gh() alone: drive every
// refusal path with a token that could plausibly leak and assert it never appears in the message
// the user is shown. Same shape as billing-detect.test.ts — an assertion over actual behaviour
// rather than a convention a reviewer might miss.
describe('setupGithubBackup — the token never appears in any message it produces', () => {
  test('across every refusal path', async () => {
    const messages: string[] = []

    const unknownHost = await setupGithubBackup({ url: 'https://gitlab.com/o/r', token: TOKEN })
    if (!unknownHost.ok) messages.push(unknownHost.message)

    const badUrl = await setupGithubBackup({ url: 'garbage', token: TOKEN })
    if (!badUrl.ok) messages.push(badUrl.message)

    const notFound = await setupGithubBackup({
      url: URL, token: TOKEN, fetchImpl: repoResponder({ message: `no repo for ${TOKEN}` }, 404),
    })
    if (!notFound.ok) messages.push(notFound.message)

    const isPublic = await setupGithubBackup({
      url: URL, token: TOKEN,
      fetchImpl: repoResponder({ private: false, permissions: { push: true } }),
    })
    if (!isPublic.ok) messages.push(isPublic.message)

    const noPush = await setupGithubBackup({
      url: URL, token: TOKEN, fetchImpl: repoResponder({ private: true, permissions: { push: false } }),
    })
    if (!noPush.ok) messages.push(noPush.message)

    // A network error whose text is adversarially built to include the token.
    const networkError = await setupGithubBackup({
      url: URL, token: TOKEN,
      fetchImpl: async () => { throw new Error(`refused connection to host carrying Bearer ${TOKEN}`) },
    })
    if (!networkError.ok) messages.push(networkError.message)

    expect(messages.length).toBeGreaterThanOrEqual(6)
    for (const m of messages) expect(m).not.toContain(TOKEN)
  })
})
