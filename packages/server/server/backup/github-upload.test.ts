/**
 * github-upload.test.ts — the confirmation ladder, end to end, against a real (tiny) archive and a
 * fully injected `fetch`. No network call ever reaches github.com.
 *
 * The one assertion that matters most in this file: on EVERY failure path, the local archive is
 * still on disk afterwards. The local file is what the user's only copy depends on.
 */
import { describe, test, expect } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runBackup } from './backup'
import type { BackupRecord } from './backup-store'
import { readPrunedPaths } from './backup-store'
import type { GithubBackupConfig } from './github-store'
import type { FetchLike } from './github-api'
import { syncBackupToGithub, uploadBackupToGithub } from './github-upload'

const CONFIG: GithubBackupConfig = {
  url: 'https://github.com/someone/agentistics-backups',
  owner: 'someone',
  repo: 'agentistics-backups',
  token: 'ghp_uploadLadderTestToken1234567890',
  keepRemote: 0,
  deleteLocalAfterUpload: false,
}

const UPLOAD_URL = 'https://uploads.github.com/repos/someone/agentistics-backups/releases/1/assets{?name,label}'
const ASSET_ID = 555

/** Builds one small, real archive per call — never shared across tests, so a test that deletes the
 *  local file can never affect another. */
async function withFreshBackup(fn: (record: BackupRecord, recordsFile: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'agentistics-gh-home-'))
  const dest = mkdtempSync(join(tmpdir(), 'agentistics-gh-dest-'))
  const recDir = mkdtempSync(join(tmpdir(), 'agentistics-gh-rec-'))
  const recordsFile = join(recDir, 'backups.jsonl')
  try {
    mkdirSync(join(home, '.agentistics/sessions/claude'), { recursive: true })
    writeFileSync(join(home, '.agentistics/sessions/claude/a.json'), JSON.stringify({ session_id: 'a' }))
    const r = await runBackup({
      homeDir: home, destDir: dest, layers: ['metrics'], harnesses: ['claude'],
      repos: [], agentopVersion: 'test', hostname: 'test-host', recordFile: recordsFile,
    })
    if (!r.ok) throw new Error(r.reason)
    await fn(r.record, recordsFile)
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
    rmSync(recDir, { recursive: true, force: true })
  }
}

interface FakeOptions {
  archiveBytes: Buffer
  assetState?: string
  assetSize?: number
  downloadBytes?: Buffer
  onRequest?: (url: string, method: string) => void
}

/** One fake covering every request the ladder makes, keyed by URL shape. Deviations for each
 *  failure scenario are passed in rather than re-implemented per test. */
function fakeGithub(opts: FakeOptions): FetchLike {
  const assetSize = opts.assetSize ?? opts.archiveBytes.length
  const assetState = opts.assetState ?? 'uploaded'
  const downloadBytes = opts.downloadBytes ?? opts.archiveBytes

  return async (url, init) => {
    const method = init?.method ?? 'GET'
    opts.onRequest?.(url, method)

    if (url.endsWith('/repos/someone/agentistics-backups/releases') && method === 'POST') {
      return new Response(JSON.stringify({
        id: 1,
        html_url: 'https://github.com/someone/agentistics-backups/releases/tag/backup-x',
        upload_url: UPLOAD_URL,
      }), { status: 201 })
    }
    if (url.startsWith('https://uploads.github.com') && method === 'POST') {
      return new Response(JSON.stringify({ id: ASSET_ID, state: 'uploaded', size: assetSize }), { status: 201 })
    }
    if (url.endsWith('/releases/1') && method === 'GET') {
      return new Response(JSON.stringify({
        assets: [{ id: ASSET_ID, state: assetState, size: assetSize, name: 'x' }],
      }), { status: 200 })
    }
    if (url.endsWith(`/releases/assets/${ASSET_ID}`) && method === 'GET') {
      return new Response(new Uint8Array(downloadBytes), { status: 200 })
    }
    throw new Error(`unexpected request in test fake: ${method} ${url}`)
  }
}

describe('uploadBackupToGithub — the happy path', () => {
  test('creates the release, uploads, confirms, and verifies byte-for-byte', async () => {
    await withFreshBackup(async record => {
      const archiveBytes = readFileSync(record.path)
      const seen: string[] = []
      const outcome = await uploadBackupToGithub(CONFIG, record, {
        fetchImpl: fakeGithub({ archiveBytes, onRequest: (u, m) => seen.push(`${m} ${u}`) }),
        onLine: () => {},
      })
      expect(outcome.ok).toBe(true)
      if (outcome.ok) {
        expect(outcome.htmlUrl).toContain('backup-x')
        expect(outcome.verifyMs).toBeGreaterThanOrEqual(0)
      }
      // Every rung of the ladder was actually walked, in order.
      expect(seen.some(s => s.startsWith('POST') && s.includes('/releases') && !s.includes('uploads'))).toBe(true)
      expect(seen.some(s => s.startsWith('POST') && s.includes('uploads.github.com'))).toBe(true)
      expect(seen.some(s => s.startsWith('GET') && s.endsWith('/releases/1'))).toBe(true)
      expect(seen.some(s => s.includes('/releases/assets/'))).toBe(true)
      // deleteLocalAfterUpload is false on CONFIG — the local copy is untouched even on success.
      expect(existsSync(record.path)).toBe(true)
    })
  })

  test('the release body carries the manifest summary — layers, harnesses, sessions, size, sha256', async () => {
    await withFreshBackup(async record => {
      const archiveBytes = readFileSync(record.path)
      let capturedBody = ''
      const fetchImpl = fakeGithub({ archiveBytes })
      const wrapped: FetchLike = async (url, init) => {
        if (typeof url === 'string' && url.endsWith('/releases') && init?.method === 'POST') {
          capturedBody = String(init.body)
        }
        return fetchImpl(url, init)
      }
      const outcome = await uploadBackupToGithub(CONFIG, record, { fetchImpl: wrapped })
      expect(outcome.ok).toBe(true)
      const parsed = JSON.parse(capturedBody) as { body: string; tag_name: string; draft: boolean; prerelease: boolean }
      expect(parsed.draft).toBe(false)
      expect(parsed.prerelease).toBe(false)
      expect(parsed.tag_name).toMatch(/^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d+)?Z$/)
      expect(parsed.body).toContain('metrics')
      expect(parsed.body).toContain('claude')
      expect(parsed.body).toContain('1') // one session file was staged
      expect(parsed.body).toContain(record.sha256)
      expect(parsed.body).toContain(String(record.archiveBytes))
    })
  })

  test('deleteLocalAfterUpload: true deletes the local file and records the deletion as a prune', async () => {
    await withFreshBackup(async (record, recordsFile) => {
      const archiveBytes = readFileSync(record.path)
      const config: GithubBackupConfig = { ...CONFIG, deleteLocalAfterUpload: true }
      const outcome = await uploadBackupToGithub(config, record, {
        fetchImpl: fakeGithub({ archiveBytes }), recordFile: recordsFile,
      })
      expect(outcome.ok).toBe(true)
      if (outcome.ok) expect(outcome.deletedLocal).toBe(true)
      expect(existsSync(record.path)).toBe(false)
      const pruned = await readPrunedPaths(recordsFile)
      expect(pruned.has(record.path)).toBe(true)
    })
  })
})

describe('uploadBackupToGithub — every failure keeps the local file, and names the reason', () => {
  test('an asset stuck in a non-"uploaded" state fails, and the local file survives', async () => {
    await withFreshBackup(async record => {
      const archiveBytes = readFileSync(record.path)
      const outcome = await uploadBackupToGithub(CONFIG, record, {
        fetchImpl: fakeGithub({ archiveBytes, assetState: 'starter' }),
      })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.localFileKept).toBe(true)
        expect(outcome.reason.toLowerCase()).toContain('starter')
      }
      expect(existsSync(record.path)).toBe(true)
    })
  })

  test('a size mismatch fails, and the local file survives', async () => {
    await withFreshBackup(async record => {
      const archiveBytes = readFileSync(record.path)
      const outcome = await uploadBackupToGithub(CONFIG, record, {
        fetchImpl: fakeGithub({ archiveBytes, assetSize: archiveBytes.length + 1 }),
      })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.reason.toLowerCase()).toContain('size mismatch')
      expect(existsSync(record.path)).toBe(true)
    })
  })

  test('downloaded bytes whose hash differs from the recorded sha256 fail, and the local file survives', async () => {
    await withFreshBackup(async record => {
      const archiveBytes = readFileSync(record.path)
      const outcome = await uploadBackupToGithub(CONFIG, record, {
        fetchImpl: fakeGithub({ archiveBytes, downloadBytes: Buffer.concat([archiveBytes, Buffer.from('x')]) }),
      })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.reason).toContain(record.sha256)
        expect(outcome.reason.toLowerCase()).toContain('not the bytes that left')
      }
      expect(existsSync(record.path)).toBe(true)
    })
  })

  test('a too-large archive is never uploaded at all, and the local file survives', async () => {
    await withFreshBackup(async record => {
      const bigRecord: BackupRecord = { ...record, archiveBytes: 2 * 1024 * 1024 * 1024 }
      let called = false
      const outcome = await uploadBackupToGithub(CONFIG, bigRecord, {
        fetchImpl: async () => { called = true; return new Response('{}', { status: 200 }) },
      })
      expect(called).toBe(false)
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) {
        expect(outcome.reason).toContain(record.path)
        expect(outcome.reason).toContain('agentop restore')
        expect(outcome.reason.toLowerCase()).toContain('pendrive')
        expect(outcome.reason).toContain('--harness')
      }
      expect(existsSync(record.path)).toBe(true)
    })
  })

  test('a failed release creation fails before any upload, and the local file survives', async () => {
    await withFreshBackup(async record => {
      let uploadCalled = false
      const fetchImpl: FetchLike = async (url, init) => {
        if (String(url).endsWith('/releases') && init?.method === 'POST') {
          return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })
        }
        uploadCalled = true
        return new Response('{}', { status: 200 })
      }
      const outcome = await uploadBackupToGithub(CONFIG, record, { fetchImpl })
      expect(outcome.ok).toBe(false)
      expect(uploadCalled).toBe(false)
      expect(existsSync(record.path)).toBe(true)
    })
  })
})

describe('syncBackupToGithub — the composed entry point', () => {
  test('not configured is a silent no-op — no request is ever made', async () => {
    await withFreshBackup(async record => {
      let called = false
      const fetchImpl: FetchLike = async () => { called = true; return new Response('{}') }
      // A path that certainly does not exist — mirrors "not configured" without touching the
      // operator's real ~/.agentistics/github-backup.json.
      const configFile = join(tmpdir(), `agentistics-gh-does-not-exist-${Date.now()}.json`)
      await syncBackupToGithub(record, { fetchImpl, configFile })
      expect(called).toBe(false)
      expect(existsSync(record.path)).toBe(true)
    })
  })
})
