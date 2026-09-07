/**
 * github-restore.test.ts — wave G3, against a fully injected `fetch`. No network call ever reaches
 * github.com.
 *
 * The scenario this whole file exists to prove: a reformatted machine has the repository URL and
 * nothing else — no stored token, no local `backups.jsonl`, no expected hash. Every check below
 * works from what the far side (the release listing + its body) can supply.
 */
import { describe, test, expect } from 'bun:test'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildReleaseBody } from './backup-github'
import type { FetchLike } from './github-api'
import {
  downloadBackupAsset, downloadBackupRelease, groupReleasesByMachine, listBackupReleases,
  newestForMachine, pickBackupAsset,
  pickBackupRelease, type GithubReleaseInfo,
} from './github-restore'

const OWNER = 'someone'
const REPO = 'agentistics-backups'
const TOKEN = 'ghp_restoreTestToken1234567890'
const ARCHIVE_BYTES = Buffer.from('a fake tiny agentop archive, just some bytes for the test')
const ASSET_ID = 777
const ASSET_NAME = 'agentistics-backup-host-2026.tar.gz'

function summaryBody(overrides: Partial<Parameters<typeof buildReleaseBody>[0]> = {}): string {
  return buildReleaseBody({
    layers: ['metrics'],
    harnesses: ['claude'],
    sessionCount: 3,
    archiveBytes: ARCHIVE_BYTES.length,
    sha256: createHash('sha256').update(ARCHIVE_BYTES).digest('hex'),
    createdAt: '2026-09-05T04:07:03Z',
    hostname: 'old-laptop',
    ...overrides,
  })
}

function releasesResponse(releases: unknown[]): Response {
  return new Response(JSON.stringify(releases), { status: 200 })
}

/** One fake covering the two requests a restore makes: list releases, download an asset. */
function fakeGithub(opts: {
  releases: { tag_name: string; created_at: string; body: string; assets?: { id: number; name: string; size: number }[] }[]
  downloadBytes?: Buffer
  onRequest?: (url: string, method: string) => void
}): FetchLike {
  const downloadBytes = opts.downloadBytes ?? ARCHIVE_BYTES
  return async (url, init) => {
    const method = init?.method ?? 'GET'
    opts.onRequest?.(url, method)
    if (url.endsWith(`/repos/${OWNER}/${REPO}/releases?per_page=100`)) {
      return releasesResponse(opts.releases.map(r => ({
        id: 1, tag_name: r.tag_name, created_at: r.created_at, body: r.body,
        assets: r.assets ?? [{ id: ASSET_ID, name: ASSET_NAME, size: ARCHIVE_BYTES.length }],
      })))
    }
    if (url.endsWith(`/releases/assets/${ASSET_ID}`)) {
      return new Response(new Uint8Array(downloadBytes), { status: 200 })
    }
    if (url.endsWith('/repos/someone/private-repo/releases?per_page=100')) {
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
    }
    throw new Error(`unexpected request in test fake: ${method} ${url}`)
  }
}

async function withDestDir(fn: (destDir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agentistics-gh-restore-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// pickBackupRelease / pickBackupAsset — pure
// ---------------------------------------------------------------------------------------------

describe('pickBackupRelease', () => {
  const releases = (): GithubReleaseInfo[] => [
    { id: 1, tagName: 'backup-2026-09-01T00-00-00Z', createdAt: '2026-09-01T00:00:00Z', body: '', assets: [] },
    { id: 2, tagName: 'backup-2026-09-03T00-00-00Z', createdAt: '2026-09-03T00:00:00Z', body: '', assets: [] },
    { id: 3, tagName: 'v1.0.0', createdAt: '2026-09-04T00:00:00Z', body: '', assets: [] }, // hand-made, newer!
  ]

  test('without --release, picks the newest release whose tag isBackupTag recognises', () => {
    const picked = pickBackupRelease(releases())
    expect(picked.ok).toBe(true)
    if (picked.ok) expect(picked.release.tagName).toBe('backup-2026-09-03T00-00-00Z')
  })

  test('a hand-made release, however new, is never picked automatically', () => {
    const picked = pickBackupRelease(releases())
    expect(picked.ok).toBe(true)
    if (picked.ok) expect(picked.release.tagName).not.toBe('v1.0.0')
  })

  test('no backup- releases at all is a named refusal, not a fallback to an arbitrary release', () => {
    const picked = pickBackupRelease([releases()[2]!])
    expect(picked.ok).toBe(false)
    if (!picked.ok) expect(picked.reason.toLowerCase()).toContain('no release')
  })

  test('--release names an exact tag, hand-made ones included, and refuses one that does not exist', () => {
    const found = pickBackupRelease(releases(), 'v1.0.0')
    expect(found.ok).toBe(true)
    if (found.ok) expect(found.release.tagName).toBe('v1.0.0')

    const missing = pickBackupRelease(releases(), 'backup-does-not-exist')
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toContain('backup-does-not-exist')
  })
})

describe('pickBackupAsset', () => {
  const release = (assets: { id: number; name: string; size: number }[]): GithubReleaseInfo => (
    { id: 1, tagName: 'backup-x', createdAt: '2026-01-01T00:00:00Z', body: '', assets }
  )

  test('matches the single asset whose size equals the summary archiveBytes', () => {
    const r = pickBackupAsset(release([{ id: 1, name: 'x', size: 100 }]), { archiveBytes: 100 } as never)
    expect(r.ok).toBe(true)
  })

  test('no assets at all is refused by name', () => {
    const r = pickBackupAsset(release([]), { archiveBytes: 100 } as never)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('no assets')
  })

  test('no matching size is refused rather than guessing', () => {
    const r = pickBackupAsset(release([{ id: 1, name: 'x', size: 50 }]), { archiveBytes: 100 } as never)
    expect(r.ok).toBe(false)
  })

  test('more than one matching size is refused as ambiguous', () => {
    const r = pickBackupAsset(
      release([{ id: 1, name: 'x', size: 100 }, { id: 2, name: 'y', size: 100 }]), { archiveBytes: 100 } as never,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.toLowerCase()).toContain('ambiguous')
  })
})

// ---------------------------------------------------------------------------------------------
// downloadBackupAsset — the hash check the whole feature is judged on
// ---------------------------------------------------------------------------------------------

describe('downloadBackupAsset', () => {
  test('a matching hash succeeds and writes the file', async () => {
    await withDestDir(async destDir => {
      const expected = createHash('sha256').update(ARCHIVE_BYTES).digest('hex')
      const asset = { id: ASSET_ID, name: ASSET_NAME, size: ARCHIVE_BYTES.length }
      const res = await downloadBackupAsset(
        OWNER, REPO, TOKEN, asset, expected, destDir,
        fakeGithub({ releases: [] }),
      )
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(existsSync(res.path)).toBe(true)
        expect(readFileSync(res.path)).toEqual(ARCHIVE_BYTES)
        expect(res.sha256).toBe(expected)
      }
    })
  })

  test('a mismatched hash refuses, and KEEPS the file for inspection', async () => {
    await withDestDir(async destDir => {
      const expected = 'f'.repeat(64) // deliberately wrong
      const asset = { id: ASSET_ID, name: ASSET_NAME, size: ARCHIVE_BYTES.length }
      const res = await downloadBackupAsset(
        OWNER, REPO, TOKEN, asset, expected, destDir,
        fakeGithub({ releases: [] }),
      )
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.path).toBeDefined()
        expect(existsSync(res.path!)).toBe(true)
        expect(res.reason).toContain(expected)
        expect(res.reason.toLowerCase()).toContain('not the bytes that were uploaded')
      }
    })
  })
})

// ---------------------------------------------------------------------------------------------
// downloadBackupRelease — the whole G3 orchestration
// ---------------------------------------------------------------------------------------------

describe('downloadBackupRelease — the happy round trip', () => {
  test('list -> pick newest -> confirm -> download -> hash matches', async () => {
    await withDestDir(async destDir => {
      const body = summaryBody()
      let confirmedWith: unknown = null
      const outcome = await downloadBackupRelease(OWNER, REPO, TOKEN, undefined, {
        destDir,
        fetchImpl: fakeGithub({
          releases: [{ tag_name: 'backup-2026-09-05T04-07-03Z', created_at: '2026-09-05T04:07:03Z', body }],
        }),
        confirmDownload: (summary) => { confirmedWith = summary; return true },
      })
      expect(outcome.status).toBe('downloaded')
      if (outcome.status === 'downloaded') {
        expect(existsSync(outcome.archivePath)).toBe(true)
        expect(readFileSync(outcome.archivePath)).toEqual(ARCHIVE_BYTES)
        expect(outcome.summary.hostname).toBe('old-laptop')
      }
      expect(confirmedWith).not.toBeNull()
    })
  })

  test('--release names an exact tag', async () => {
    await withDestDir(async destDir => {
      const body = summaryBody()
      const outcome = await downloadBackupRelease(OWNER, REPO, TOKEN, 'backup-2026-09-05T04-07-03Z', {
        destDir,
        fetchImpl: fakeGithub({
          releases: [
            { tag_name: 'backup-2026-01-01T00-00-00Z', created_at: '2026-01-01T00:00:00Z', body: summaryBody({ createdAt: '2026-01-01T00:00:00Z' }) },
            { tag_name: 'backup-2026-09-05T04-07-03Z', created_at: '2026-09-05T04:07:03Z', body },
          ],
        }),
      })
      expect(outcome.status).toBe('downloaded')
    })
  })
})

describe('downloadBackupRelease — refusals', () => {
  test('a hash MISMATCH refuses, keeps the file, and never proceeds to a restore', async () => {
    await withDestDir(async destDir => {
      const body = summaryBody()
      // Simulates the CLI's hand-off: only a 'downloaded' outcome may call the restore.
      let restoreCalled = false
      const outcome = await downloadBackupRelease(OWNER, REPO, TOKEN, undefined, {
        destDir,
        fetchImpl: fakeGithub({
          releases: [{ tag_name: 'backup-2026-09-05T04-07-03Z', created_at: '2026-09-05T04:07:03Z', body }],
          downloadBytes: Buffer.concat([ARCHIVE_BYTES, Buffer.from('corruption')]),
        }),
      })
      if (outcome.status === 'downloaded') restoreCalled = true // would be the CLI's next call

      expect(outcome.status).toBe('error')
      expect(restoreCalled).toBe(false)
      if (outcome.status === 'error') {
        expect(outcome.archivePath).toBeDefined()
        expect(existsSync(outcome.archivePath!)).toBe(true)
        expect(outcome.reason.toLowerCase()).toContain('not the bytes that were uploaded')
      }
    })
  })

  test('no backup- releases: named refusal, never falls back to a hand-made release', async () => {
    await withDestDir(async destDir => {
      const outcome = await downloadBackupRelease(OWNER, REPO, TOKEN, undefined, {
        destDir,
        fetchImpl: fakeGithub({
          releases: [{ tag_name: 'v1.0.0', created_at: '2026-01-01T00:00:00Z', body: 'hand-written notes' }],
        }),
      })
      expect(outcome.status).toBe('error')
      if (outcome.status === 'error') expect(outcome.reason.toLowerCase()).toContain('no release')
    })
  })

  test('--release naming a tag that does not exist is refused by name', async () => {
    await withDestDir(async destDir => {
      const outcome = await downloadBackupRelease(OWNER, REPO, TOKEN, 'backup-nope', {
        destDir,
        fetchImpl: fakeGithub({
          releases: [{ tag_name: 'backup-2026-01-01T00-00-00Z', created_at: '2026-01-01T00:00:00Z', body: summaryBody() }],
        }),
      })
      expect(outcome.status).toBe('error')
      if (outcome.status === 'error') expect(outcome.reason).toContain('backup-nope')
    })
  })

  test('a repository the token cannot see fails at the listing step, never reaching a download', async () => {
    await withDestDir(async destDir => {
      let downloadAttempted = false
      const fetchImpl: FetchLike = async (url, init) => {
        if (String(url).includes('/releases/assets/')) downloadAttempted = true
        return fakeGithub({ releases: [] })(url, init)
      }
      const outcome = await downloadBackupRelease('someone', 'private-repo', TOKEN, undefined, { destDir, fetchImpl })
      expect(outcome.status).toBe('error')
      expect(downloadAttempted).toBe(false)
      if (outcome.status === 'error') expect(outcome.reason.toLowerCase()).toContain('could not list releases')
    })
  })

  test('declining the confirmation cancels before any download', async () => {
    await withDestDir(async destDir => {
      let downloadAttempted = false
      const body = summaryBody()
      const fetchImpl: FetchLike = async (url, init) => {
        if (String(url).includes('/releases/assets/')) downloadAttempted = true
        return fakeGithub({
          releases: [{ tag_name: 'backup-2026-09-05T04-07-03Z', created_at: '2026-09-05T04:07:03Z', body }],
        })(url, init)
      }
      const outcome = await downloadBackupRelease(OWNER, REPO, TOKEN, undefined, {
        destDir, fetchImpl, confirmDownload: () => false,
      })
      expect(outcome.status).toBe('cancelled')
      expect(downloadAttempted).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------------------------
// downloadBackupRelease — wave G4's fix: phase two must not re-download what phase one already
// fetched. Each test injects a `fetchImpl` that throws if the asset-download endpoint is ever
// called, so the assertion is not just "the right archive comes back" but "the network was never
// asked" — the whole point of this fix is the bytes NOT moving twice.
// ---------------------------------------------------------------------------------------------

describe('downloadBackupRelease — phase-two reuse of an already-downloaded file', () => {
  test('a local file already matching the release sha256 is reused, never re-downloaded', async () => {
    await withDestDir(async destDir => {
      const body = summaryBody()
      // Simulates what phase one already left on disk under the exact name the asset carries.
      mkdirSync(destDir, { recursive: true })
      writeFileSync(join(destDir, ASSET_NAME), ARCHIVE_BYTES)

      let downloadAttempted = false
      let confirmAsked = false
      const fetchImpl: FetchLike = async (url, init) => {
        if (String(url).includes('/releases/assets/')) {
          downloadAttempted = true
          throw new Error('should never be called: a matching local file must be reused')
        }
        return fakeGithub({
          releases: [{ tag_name: 'backup-2026-09-05T04-07-03Z', created_at: '2026-09-05T04:07:03Z', body }],
        })(url, init)
      }

      const outcome = await downloadBackupRelease(OWNER, REPO, TOKEN, undefined, {
        destDir, fetchImpl,
        confirmDownload: () => { confirmAsked = true; return true },
      })

      expect(outcome.status).toBe('downloaded')
      if (outcome.status === 'downloaded') {
        expect(outcome.archivePath).toBe(join(destDir, ASSET_NAME))
        expect(readFileSync(outcome.archivePath)).toEqual(ARCHIVE_BYTES)
      }
      expect(downloadAttempted).toBe(false)
      // Nothing is being downloaded, so there is nothing to confirm.
      expect(confirmAsked).toBe(false)
    })
  })

  test('a local file that does NOT match the release sha256 is ignored and re-downloaded', async () => {
    await withDestDir(async destDir => {
      const body = summaryBody()
      mkdirSync(destDir, { recursive: true })
      writeFileSync(join(destDir, ASSET_NAME), Buffer.from('stale bytes from an old, unrelated download'))

      let downloadAttempted = false
      const fetchImpl: FetchLike = async (url, init) => {
        if (String(url).includes('/releases/assets/')) downloadAttempted = true
        return fakeGithub({
          releases: [{ tag_name: 'backup-2026-09-05T04-07-03Z', created_at: '2026-09-05T04:07:03Z', body }],
        })(url, init)
      }

      const outcome = await downloadBackupRelease(OWNER, REPO, TOKEN, undefined, { destDir, fetchImpl })

      expect(downloadAttempted).toBe(true)
      expect(outcome.status).toBe('downloaded')
      if (outcome.status === 'downloaded') {
        // The mismatched bytes were never trusted — the real download overwrote them.
        expect(readFileSync(outcome.archivePath)).toEqual(ARCHIVE_BYTES)
      }
    })
  })
})

// ---------------------------------------------------------------------------------------------
// listBackupReleases — `agentop restore github --list <url>`
// ---------------------------------------------------------------------------------------------

describe('listBackupReleases', () => {
  test('lists backup- releases newest first, decoded, without downloading anything', async () => {
    let downloadAttempted = false
    const body = summaryBody()
    const fetchImpl: FetchLike = async (url, init) => {
      if (String(url).includes('/releases/assets/')) downloadAttempted = true
      return fakeGithub({
        releases: [
          { tag_name: 'backup-2026-01-01T00-00-00Z', created_at: '2026-01-01T00:00:00Z', body: summaryBody({ createdAt: '2026-01-01T00:00:00Z' }) },
          { tag_name: 'backup-2026-09-05T04-07-03Z', created_at: '2026-09-05T04:07:03Z', body },
          { tag_name: 'v1.0.0', created_at: '2026-09-06T00:00:00Z', body: 'hand-made' },
        ],
      })(url, init)
    }
    const result = await listBackupReleases(OWNER, REPO, TOKEN, fetchImpl)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.releases.map(r => r.tagName)).toEqual([
        'backup-2026-09-05T04-07-03Z', 'backup-2026-01-01T00-00-00Z',
      ])
      expect(result.releases[0]!.summary?.hostname).toBe('old-laptop')
    }
    expect(downloadAttempted).toBe(false)
  })
})

test('releases are grouped by MACHINE, and a machineless one is its own group', () => {
  // With two machines backing up to one repository the flat chronological list interleaves them,
  // and telling them apart means opening each release. The machine comes from the TAG where there
  // is one and from the body's `- host:` otherwise, so a release predating labels still lands
  // under its own machine instead of a bucket named "unknown".
  const r = (tagName: string, createdAt: string, host: string | null) =>
    ({ tagName, createdAt, summary: host === null ? null : ({ hostname: host } as never) })
  const groups = groupReleasesByMachine([
    r('backup-laptop-2026-09-05T10-00-00Z', '2026-09-05T10:00:00Z', 'laptop'),
    r('backup-desktop-2026-09-04T10-00-00Z', '2026-09-04T10:00:00Z', 'desktop'),
    r('backup-laptop-2026-09-03T10-00-00Z', '2026-09-03T10:00:00Z', 'laptop'),
    r('backup-2026-01-01T10-00-00Z', '2026-01-01T10:00:00Z', 'desktop'),
    r('backup-2025-01-01T10-00-00Z', '2025-01-01T10:00:00Z', null),
  ])
  // Machines ordered by their most recent backup: the one you are most likely to want is first.
  expect(groups.map(g => g.machine)).toEqual(['laptop', 'desktop', null])
  expect(groups[0]!.releases.map(x => x.tagName))
    .toEqual(['backup-laptop-2026-09-05T10-00-00Z', 'backup-laptop-2026-09-03T10-00-00Z'])
  // The legacy tag joins its machine by body, not a separate bucket.
  expect(groups[1]!.releases.length).toBe(2)
  expect(groups[2]!.machine).toBe(null)
})

test('the newest release OF A GIVEN MACHINE is selectable', () => {
  const r = (tagName: string, createdAt: string, host: string) =>
    ({ tagName, createdAt, summary: { hostname: host } as never })
  const list = [
    r('backup-laptop-2026-09-05T10-00-00Z', '2026-09-05T10:00:00Z', 'laptop'),
    r('backup-desktop-2026-09-04T10-00-00Z', '2026-09-04T10:00:00Z', 'desktop'),
  ]
  expect(newestForMachine(list, 'desktop')?.tagName).toBe('backup-desktop-2026-09-04T10-00-00Z')
  // Asking for a machine that has nothing here answers NOTHING — never the newest of some other
  // machine, which would restore the wrong computer onto this one without saying so.
  expect(newestForMachine(list, 'tablet')).toBe(null)
})
