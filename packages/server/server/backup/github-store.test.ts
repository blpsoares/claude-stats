import { describe, test, expect } from 'bun:test'
import { statSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readGithubConfig, writeGithubConfig, toStatus, type GithubBackupConfig,
} from './github-store'

const CONFIG: GithubBackupConfig = {
  url: 'https://github.com/someone/agentistics-backups',
  owner: 'someone',
  repo: 'agentistics-backups',
  token: 'ghp_thisIsALiveLookingToken1234567890',
  keepRemote: 0,
  deleteLocalAfterUpload: false,
}

async function withTempFile(fn: (file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'agentistics-github-store-'))
  const file = join(dir, 'github-backup.json')
  try {
    await fn(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('readGithubConfig — absent, unreadable or malformed all read as null', () => {
  test('a file that does not exist reads as null, never a throw', async () => {
    await withTempFile(async (file) => {
      expect(await readGithubConfig(file)).toBeNull()
    })
  })

  test('malformed JSON reads as null', async () => {
    await withTempFile(async (file) => {
      const { writeFile } = await import('fs/promises')
      await writeFile(file, '{ not json')
      expect(await readGithubConfig(file)).toBeNull()
    })
  })

  test('a well-formed but incomplete document reads as null', async () => {
    await withTempFile(async (file) => {
      const { writeFile } = await import('fs/promises')
      await writeFile(file, JSON.stringify({ owner: 'x' }))
      expect(await readGithubConfig(file)).toBeNull()
    })
  })
})

describe('writeGithubConfig / readGithubConfig round-trip', () => {
  test('writes at mode 0600 and reads back identically', async () => {
    await withTempFile(async (file) => {
      await writeGithubConfig(CONFIG, file)
      const mode = statSync(file).mode & 0o777
      expect(mode).toBe(0o600)
      expect(await readGithubConfig(file)).toEqual(CONFIG)
    })
  })

  test('overwriting an existing file keeps it at 0600', async () => {
    await withTempFile(async (file) => {
      await writeGithubConfig(CONFIG, file)
      await writeGithubConfig({ ...CONFIG, token: 'a-rotated-token' }, file)
      const mode = statSync(file).mode & 0o777
      expect(mode).toBe(0o600)
      expect((await readGithubConfig(file))?.token).toBe('a-rotated-token')
    })
  })

  test('defaults are applied for an older document missing the newer fields', async () => {
    await withTempFile(async (file) => {
      const { writeFile } = await import('fs/promises')
      await writeFile(file, JSON.stringify({
        url: CONFIG.url, owner: CONFIG.owner, repo: CONFIG.repo, token: CONFIG.token,
      }))
      const read = await readGithubConfig(file)
      expect(read?.keepRemote).toBe(0)
      expect(read?.deleteLocalAfterUpload).toBe(false)
    })
  })
})

describe('toStatus — the ONLY shape a route may return, and it never carries the token', () => {
  test('absent config', () => {
    expect(toStatus(null)).toEqual({ configured: false })
  })

  test('configured — url/owner/repo only', () => {
    const status = toStatus(CONFIG)
    expect(status).toEqual({
      configured: true, url: CONFIG.url, owner: CONFIG.owner, repo: CONFIG.repo,
    })
    expect(JSON.stringify(status)).not.toContain(CONFIG.token)
  })
})
